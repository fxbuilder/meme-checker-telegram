/**
 * test/phase8-chain-resolver.test.mjs
 *
 * Automatic EVM chain resolution.
 *
 * The dangerous failure here is not "the picker appeared too often" - it is silently
 * scanning the WRONG chain, which shows a real-looking card for a token the user never
 * asked about. Every test below is about refusing to guess.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  isEvmAddress,
  supportedChainFromProvider,
  resolveEvmChain,
  createChainResolver,
  chainsFromDexScreener,
  chainsFromGeckoTerminal,
} from '../src/chain-resolver.mjs';

const ANT = '0xb4f9d1b2cad3646d15797de462e5d773194d7777';
const PEPE = '0x6982508145454ce325ddbe47a25d4ec3d2311933';

/** Build a fetch stub keyed on URL fragment. */
function stubFetch(routes) {
  const calls = [];
  const impl = async (url) => {
    calls.push(String(url));
    for (const [frag, body] of Object.entries(routes)) {
      if (String(url).includes(frag)) {
        if (body instanceof Error) throw body;
        const { status = 200, json } = body;
        return { ok: status >= 200 && status < 300, status, json: async () => json };
      }
    }
    return { ok: false, status: 404, json: async () => null };
  };
  impl.calls = calls;
  return impl;
}

// ---- address shape -------------------------------------------------------

test('only a real EVM address is resolved', () => {
  assert.equal(isEvmAddress(PEPE), true);
  assert.equal(isEvmAddress('0x123'), false, 'too short');
  assert.equal(isEvmAddress('DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263'), false, 'base58 is not EVM');
  assert.equal(isEvmAddress(null), false);
  assert.equal(isEvmAddress(''), false);
});

test('an unsupported provider chain is not a valid answer', () => {
  assert.equal(supportedChainFromProvider('bsc'), 'bsc');
  assert.equal(supportedChainFromProvider('ethereum'), 'ethereum');
  assert.equal(supportedChainFromProvider('solana'), 'solana');
  // Chains we do not market-scan must never be returned as a resolution target.
  assert.equal(supportedChainFromProvider('fantom'), null);
  assert.equal(supportedChainFromProvider('cronos'), null);
  assert.equal(supportedChainFromProvider(null), null);
});

// ---- identity filtering --------------------------------------------------

test('DexScreener results are filtered on the exact contract, not the query', () => {
  // The search endpoint is FUZZY: it returns pairs whose tokens merely resemble the
  // query. Trusting it wholesale is how a token gets attributed to the wrong chain.
  const f = stubFetch({
    'dex/search': {
      json: {
        pairs: [
          { chainId: 'bsc', baseToken: { address: ANT }, quoteToken: { address: '0xwbnb' } },
          { chainId: 'ethereum', baseToken: { address: '0xdeadbeefdifferent' } },
          // The requested contract appears only as a QUOTE token here.
          { chainId: 'polygon', baseToken: { address: '0xsomethingelse' }, quoteToken: { address: ANT } },
        ],
      },
    },
  });
  return chainsFromDexScreener(ANT, { fetchImpl: f }).then((r) => {
    assert.deepEqual(r.chains, ['bsc'], 'only the exact base-token match counts');
    assert.equal(r.matchedPairs, 1);
  });
});

test('a quote-token appearance does not claim the chain', () => {
  const f = stubFetch({
    'dex/search': { json: { pairs: [{ chainId: 'polygon', baseToken: { address: '0xother' }, quoteToken: { address: ANT } }] } },
  });
  return chainsFromDexScreener(ANT, { fetchImpl: f }).then((r) => {
    assert.deepEqual(r.chains, [], 'the token was not the subject of that pair');
  });
});

test('GeckoTerminal network slugs containing underscores parse correctly', () => {
  // polygon_pos contains an underscore, so a split on the FIRST one yields "pos_0x...".
  const f = stubFetch({
    'search/pools': {
      json: {
        data: [
          { relationships: { base_token: { data: { id: `polygon_pos_${PEPE}` } }, quote_token: { data: { id: 'polygon_pos_0xquote' } } } },
        ],
      },
    },
  });
  return chainsFromGeckoTerminal(PEPE, { fetchImpl: f }).then((r) => {
    assert.deepEqual(r.chains, ['polygon']);
  });
});

// ---- resolution outcomes -------------------------------------------------

test('one evidenced chain resolves without a picker', async () => {
  const f = stubFetch({
    'dex/search': { json: { pairs: [{ chainId: 'bsc', baseToken: { address: ANT } }] } },
    'search/pools': { json: { data: [{ relationships: { base_token: { data: { id: `bsc_${ANT}` } } } }] } },
  });
  const r = await resolveEvmChain(ANT, { fetchImpl: f });
  assert.equal(r.status, 'resolved');
  assert.equal(r.chain, 'bsc');
});

test('a chain found by only ONE provider still resolves', async () => {
  // GeckoTerminal rate-limits often. One authoritative answer is enough to scan; it is
  // not enough to claim the token is single-chain, which is why evidence is returned.
  const f = stubFetch({
    'dex/search': { status: 429, json: null },
    'search/pools': { json: { data: [{ relationships: { base_token: { data: { id: `ethereum_${PEPE}` } } } }] } },
  });
  const r = await resolveEvmChain(PEPE, { fetchImpl: f });
  assert.equal(r.status, 'resolved');
  assert.equal(r.chain, 'ethereum');
});

test('genuine multi-chain deployment is ambiguous, and every candidate is returned', async () => {
  const f = stubFetch({
    'dex/search': {
      json: {
        pairs: [
          { chainId: 'ethereum', baseToken: { address: PEPE } },
          { chainId: 'base', baseToken: { address: PEPE } },
        ],
      },
    },
    'search/pools': {
      json: {
        data: [
          { relationships: { base_token: { data: { id: `eth_${PEPE}` } } } },
          { relationships: { base_token: { data: { id: `base_${PEPE}` } } } },
        ],
      },
    },
  });
  const r = await resolveEvmChain(PEPE, { fetchImpl: f });
  assert.equal(r.status, 'ambiguous');
  assert.deepEqual([...r.candidates].sort(), ['base', 'ethereum']);
  assert.equal(r.agreement, true, 'both providers agree on the same set');
});

test('provider disagreement about the candidate SET is not claimed as agreement', async () => {
  const f = stubFetch({
    'dex/search': { json: { pairs: [{ chainId: 'ethereum', baseToken: { address: PEPE } }, { chainId: 'bsc', baseToken: { address: PEPE } }] } },
    'search/pools': { json: { data: [{ relationships: { base_token: { data: { id: `eth_${PEPE}` } } } }] } },
  });
  const r = await resolveEvmChain(PEPE, { fetchImpl: f });
  assert.equal(r.status, 'ambiguous');
  assert.equal(r.agreement, false);
});

test('two providers answering nothing is not-found, never a default chain', async () => {
  const f = stubFetch({
    'dex/search': { json: { pairs: [] } },
    'search/pools': { json: { data: [] } },
  });
  const r = await resolveEvmChain(ANT, { fetchImpl: f });
  assert.equal(r.status, 'not-found');
  assert.equal(r.chain, undefined, 'a missing token must NOT silently become BSC or Ethereum');
});

test('an outage is unavailable, which is NOT the same as not-found', async () => {
  const f = stubFetch({
    'dex/search': { status: 503, json: null },
    'search/pools': { status: 500, json: null },
  });
  const r = await resolveEvmChain(ANT, { fetchImpl: f });
  assert.equal(r.status, 'unavailable');
  assert.notEqual(r.status, 'not-found', 'a transport failure is not evidence about the token');
});

test('one provider erroring while the other answers is a real result', async () => {
  const f = stubFetch({
    'dex/search': { json: { pairs: [{ chainId: 'bsc', baseToken: { address: ANT } }] } },
    'search/pools': { status: 429, json: null },
  });
  const r = await resolveEvmChain(ANT, { fetchImpl: f });
  assert.equal(r.status, 'resolved');
  assert.equal(r.chain, 'bsc');
});

// ---- caching -------------------------------------------------------------

test('a resolved result is cached and does not re-hit providers', async () => {
  let hits = 0;
  const f = async (url) => {
    hits += 1;
    const json = String(url).includes('dex/search')
      ? { pairs: [{ chainId: 'bsc', baseToken: { address: ANT } }] }
      : { data: [{ relationships: { base_token: { data: { id: `bsc_${ANT}` } } } }] };
    return { ok: true, status: 200, json: async () => json };
  };
  const r = createChainResolver({ fetchImpl: f });
  const first = await r.resolve(ANT);
  const second = await r.resolve(ANT);
  assert.equal(first.chain, 'bsc');
  assert.equal(second.chain, 'bsc');
  assert.equal(hits, 2, 'two providers, one round of requests total');
});

test('a not-found result expires quickly, so a brand-new token is found later', async () => {
  let now = 1_000_000;
  let mode = 'empty';
  const f = async (url) => {
    const json = mode === 'empty'
      ? (String(url).includes('dex/search') ? { pairs: [] } : { data: [] })
      : (String(url).includes('dex/search') ? { pairs: [{ chainId: 'bsc', baseToken: { address: ANT } }] } : { data: [] });
    return { ok: true, status: 200, json: async () => json };
  };
  const r = createChainResolver({ fetchImpl: f, now: () => now, ttlNotFoundMs: 5_000 });

  assert.equal((await r.resolve(ANT)).status, 'not-found');
  mode = 'found';
  // Still cached as a negative.
  assert.equal((await r.resolve(ANT)).status, 'not-found');
  now += 6_000;
  assert.equal((await r.resolve(ANT)).status, 'resolved', 'the negative expired and was re-checked');
});

test('an unavailable result sheds faster than a resolved one', async () => {
  let now = 0;
  let fail = true;
  const f = async (url) => {
    if (fail) return { ok: false, status: 500, json: async () => null };
    const json = String(url).includes('dex/search') ? { pairs: [{ chainId: 'bsc', baseToken: { address: ANT } }] } : { data: [] };
    return { ok: true, status: 200, json: async () => json };
  };
  const r = createChainResolver({ fetchImpl: f, now: () => now, ttlUnavailableMs: 1_000 });
  assert.equal((await r.resolve(ANT)).status, 'unavailable');
  fail = false;
  now += 1_500;
  assert.equal((await r.resolve(ANT)).status, 'resolved');
});

test('concurrent pastes of one address share a single resolution', async () => {
  let calls = 0;
  const f = async (url) => {
    calls += 1;
    await new Promise((r) => setTimeout(r, 10));
    const json = String(url).includes('dex/search') ? { pairs: [{ chainId: 'bsc', baseToken: { address: ANT } }] } : { data: [] };
    return { ok: true, status: 200, json: async () => json };
  };
  const r = createChainResolver({ fetchImpl: f });
  const results = await Promise.all([r.resolve(ANT), r.resolve(ANT), r.resolve(ANT)]);
  assert.ok(results.every((x) => x.chain === 'bsc'));
  assert.equal(calls, 2, 'three pastes, one pair of provider requests');
});
