/**
 * test/live-scan.test.mjs
 * Live adapter regressions. No network: every provider response is stubbed.
 * The rules under test come from docs/scan-result-contract.md and
 * docs/backend-contract-checklist.md:
 *   - identity is (chain, address), never a ticker
 *   - a provider failure must never be reported as `not-found`
 *   - FDV never fills a missing market cap; measured 0 is preserved
 *   - no fabricated holders, narrative or freshness
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  addressKey, fetchTokenPairs, matchingPairs, primaryPair, pairAge,
  normalizePairs, liveScan, clearLiveCache,
} from '../src/live-scan.mjs';

const BONK = 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263';
const CAKE = '0x0E09FaBB73Bd3Ade0a17ECC321fD13a19e81cE82';

/** A realistic provider pair, trimmed to the fields the adapter reads. */
function pair(over = {}) {
  return {
    chainId: 'solana',
    dexId: 'orca',
    pairAddress: 'PAIR1',
    baseToken: { address: BONK, name: 'Bonk', symbol: 'Bonk' },
    quoteToken: { address: 'So11111111111111111111111111111111111111112', symbol: 'SOL' },
    priceUsd: '0.000002159',
    marketCap: 189998970,
    fdv: 191873839,
    liquidity: { usd: 214204.77 },
    volume: { h24: 350328.74 },
    priceChange: { h1: -0.03, h24: 4.29 },
    pairCreatedAt: 1671980424000,
    ...over,
  };
}

const jsonRes = (body, status = 200) => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => body,
});

/** Stub fetch that records the URL it was called with. */
function stubFetch(impl) {
  const calls = [];
  const fn = async (url, _init) => { calls.push(url); return impl(url); };
  fn.calls = calls;
  return fn;
}

// ---- identity --------------------------------------------------------------

test('addressKey rejects malformed input and canonicalizes EVM to lowercase', () => {
  assert.equal(addressKey('solana', BONK), BONK);
  assert.equal(addressKey('bsc', CAKE.toUpperCase().replace('0X', '0x')), CAKE.toLowerCase());
  assert.equal(addressKey('solana', CAKE), null, 'EVM address is not a Solana address');
  assert.equal(addressKey('bsc', BONK), null, 'Solana address is not an EVM address');
  assert.equal(addressKey('bsc', 'notanaddress'), null);
  // Solana base58 is case-sensitive: the canonical form is the input, preserved
  // exactly. A lowercased variant is a *different* (valid-looking) address, so
  // the adapter must never case-fold Solana input.
  assert.equal(addressKey('solana', BONK.toLowerCase()), BONK.toLowerCase());
  assert.notEqual(addressKey('solana', BONK.toLowerCase()), BONK);
  assert.equal(addressKey('notachain', CAKE), null, 'unknown chain rejected');
  // Any recognised EVM chain now accepts a 0x address and canonicalizes it.
  assert.equal(addressKey('ethereum', CAKE), CAKE.toLowerCase());
});

test('matchingPairs keeps only pairs whose baseToken is this exact contract', () => {
  const rows = [
    pair({ pairAddress: 'A' }),
    pair({ pairAddress: 'B', baseToken: { address: 'So11111111111111111111111111111111111111112', name: 'Wrapped SOL', symbol: 'SOL' } }),
    // Same ticker, different contract — must not be included.
    pair({ pairAddress: 'C', baseToken: { address: 'FakeBonk1111111111111111111111111111111111', name: 'Bonk', symbol: 'Bonk' } }),
  ];
  const matched = matchingPairs('solana', BONK, rows);
  assert.deepEqual(matched.map((p) => p.pairAddress), ['A']);
});

test('ticker collision does not hijack identity — impostor-only response is invalid, not ok', () => {
  const impostor = [pair({ baseToken: { address: 'FakeBonk1111111111111111111111111111111111', name: 'Bonk', symbol: 'Bonk' } })];
  assert.deepEqual(normalizePairs({ chain: 'solana', address: BONK }, impostor), { mode: 'live', status: 'invalid-response' });
});

test('primaryPair selects the deepest pool, not the first row', () => {
  const rows = [
    pair({ pairAddress: 'SHALLOW', liquidity: { usd: 1000 } }),
    pair({ pairAddress: 'DEEP', liquidity: { usd: 900000 } }),
    pair({ pairAddress: 'MID', liquidity: { usd: 50000 } }),
  ];
  assert.equal(primaryPair(rows).pairAddress, 'DEEP');
});

// ---- provider failures must never read as "not found" ----------------------

test('429 maps to rate-limited, not not-found', async () => {
  const r = await fetchTokenPairs({ chain: 'solana', address: BONK }, { fetchImpl: stubFetch(() => jsonRes(null, 429)) });
  assert.equal(r.status, 'rate-limited');
  assert.equal(r.httpStatus, 429);
});

test('500 maps to api-error, not not-found', async () => {
  const r = await fetchTokenPairs({ chain: 'solana', address: BONK }, { fetchImpl: stubFetch(() => jsonRes(null, 500)) });
  assert.equal(r.status, 'api-error');
});

test('transport failure and timeout both map to api-error', async () => {
  const boom = await fetchTokenPairs({ chain: 'bsc', address: CAKE }, {
    fetchImpl: stubFetch(() => { throw new Error('ECONNRESET'); }),
  });
  assert.equal(boom.status, 'api-error');
  assert.match(boom.detail, /ECONNRESET/);

  const slow = await fetchTokenPairs({ chain: 'bsc', address: CAKE }, {
    fetchImpl: stubFetch(() => { const e = new Error('timed out'); e.name = 'TimeoutError'; throw e; }),
  });
  assert.equal(slow.status, 'api-error');
  assert.match(slow.detail, /timeout/);
});

test('non-JSON body maps to invalid-response', async () => {
  const r = await fetchTokenPairs({ chain: 'bsc', address: CAKE }, {
    fetchImpl: stubFetch(() => ({ ok: true, status: 200, json: async () => { throw new Error('bad json'); } })),
  });
  assert.equal(r.status, 'invalid-response');
});

// ---- the happy path --------------------------------------------------------

test('Solana pair normalizes to the card contract with real market fields', async () => {
  const r = await normalizePairs({ chain: 'solana', address: BONK }, [pair()]);
  assert.equal(r.status, 'ok');
  assert.equal(r.mode, 'live');
  assert.equal(r.token.address, BONK);
  assert.equal(r.token.name, 'Bonk');
  assert.equal(r.market.priceUsd, 0.000002159, 'string price is coerced to a number');
  assert.equal(r.market.marketCapUsd, 189998970);
  assert.equal(r.market.fdvUsd, 191873839);
  assert.equal(r.market.liquidityUsd, 214204.77);
  assert.equal(r.market.volume24hUsd, 350328.74);
  assert.equal(r.market.priceChange24h, 4.29);
  assert.equal(r.market.priceChange1h, -0.03);
  assert.ok(r.market.pairAge, 'pair age is derived from pairCreatedAt');
});

test('holders and narrative are null — never fabricated', async () => {
  const r = await normalizePairs({ chain: 'solana', address: BONK }, [pair()]);
  assert.deepEqual(r.holders, { total: null, top10Percentage: null, largestHolderPercentage: null });
  assert.equal(r.narrative, null);
  assert.equal(r.updatedAt, null, 'freshness must never be synthesized');
});

test('project links come from provider socials, filtering untrusted schemes', async () => {
  const r = await normalizePairs({ chain: 'solana', address: BONK }, [pair({
    info: {
      websites: [{ url: 'https://www.bonkcoin.com', label: 'Website' }],
      socials: [
        { url: 'https://twitter.com/bonk_inu', type: 'twitter' },
        { url: 'https://t.me/Official_Bonk_Inu', type: 'telegram' },
        { url: 'javascript:alert(1)', type: 'x' },
        { url: 'http://insecure.example.org', type: 'discord' },
      ],
    },
  })]);
  assert.equal(r.project.website, 'https://www.bonkcoin.com');
  assert.equal(r.project.x, 'https://twitter.com/bonk_inu');
  assert.equal(r.project.telegram, 'https://t.me/Official_Bonk_Inu');
});

test('links may live on any matching pair, not only the deepest', async () => {
  const r = await normalizePairs({ chain: 'solana', address: BONK }, [
    pair({ pairAddress: 'DEEP', liquidity: { usd: 900000 } }),
    pair({ pairAddress: 'THIN', liquidity: { usd: 10 }, info: { websites: [{ url: 'https://bonkcoin.com' }] } }),
  ]);
  assert.equal(r.project.website, 'https://bonkcoin.com');
});

test('measured zero volume is preserved and not read as missing', async () => {
  const r = await normalizePairs({ chain: 'bsc', address: CAKE }, [
    pair({ chainId: 'bsc', baseToken: { address: CAKE, name: 'PancakeSwap', symbol: 'Cake' }, volume: { h24: 0 }, marketCap: null, fdv: 1500000 }),
  ]);
  assert.equal(r.market.volume24hUsd, 0);
});

test('missing market cap is not filled from FDV', async () => {
  const r = await normalizePairs({ chain: 'bsc', address: CAKE }, [
    pair({ chainId: 'bsc', baseToken: { address: CAKE, name: 'PancakeSwap', symbol: 'Cake' }, marketCap: null, fdv: 1500000 }),
  ]);
  assert.equal(r.market.marketCapUsd, null);
  assert.equal(r.market.fdvUsd, 1500000);
  assert.equal(r.market.priceUsd, 0.000002159);
});

// ---- negatives -------------------------------------------------------------

test('an empty provider array is a real not-found', async () => {
  assert.deepEqual(normalizePairs({ chain: 'bsc', address: CAKE }, []), { mode: 'live', status: 'not-found' });
});

test('a missing name or symbol is invalid-response, never a placeholder token', async () => {
  const r = await normalizePairs({ chain: 'solana', address: BONK }, [
    pair({ baseToken: { address: BONK, name: '', symbol: 'Bonk' } }),
  ]);
  assert.deepEqual(r, { mode: 'live', status: 'invalid-response' });
});

// ---- pairAge ---------------------------------------------------------------

test('pairAge formats from a real timestamp and rejects nonsense', () => {
  const now = Date.UTC(2026, 10, 23);
  assert.equal(pairAge(now - 2 * 86_400_000, now), '2d');
  assert.equal(pairAge(now - 10 * 3_600_000, now), '10h');
  assert.equal(pairAge(now - 400 * 86_400_000, now), '1y 1mo');
  assert.equal(pairAge(null, now), null);
  assert.equal(pairAge(0, now), null);
  assert.equal(pairAge(now + 86_400_000, now), null, 'future timestamp is not a pair age');
});

// ---- caching ---------------------------------------------------------------

test('liveScan caches a success and reuses it without a second provider call', async () => {
  clearLiveCache();
  const f = stubFetch(() => jsonRes([pair()]));
  // Risk and Dex Paid are separate sources; stub them so this test isolates
  // the market-data cache rather than making network calls.
  const noRisk = async () => ({ status: 'unsupported', data: null, detail: 'test' });
  const noPaid = async () => ({ status: 'unknown', detail: 'test' });
  const a = await liveScan({ chain: 'solana', address: BONK }, { fetchImpl: f, riskFetch: noRisk, paidFetch: noPaid });
  const b = await liveScan({ chain: 'solana', address: BONK }, { fetchImpl: f, riskFetch: noRisk, paidFetch: noPaid });
  assert.equal(a.status, 'ok');
  assert.equal(b.status, 'ok');
  assert.equal(f.calls.length, 1, 'second scan must be served from cache');
});

test('liveScan caches a throttle briefly so a group is not re-hammered', async () => {
  clearLiveCache();
  const f = stubFetch(() => jsonRes(null, 429));
  const a = await liveScan({ chain: 'solana', address: BONK }, { fetchImpl: f });
  const b = await liveScan({ chain: 'solana', address: BONK }, { fetchImpl: f });
  assert.equal(a.status, 'rate-limited');
  assert.equal(b.status, 'rate-limited');
  assert.equal(f.calls.length, 1, 'failure must be cached too');
});

test('liveScan never falls back to mock data on a live failure', async () => {
  clearLiveCache();
  const r = await liveScan({ chain: 'solana', address: BONK }, { fetchImpl: stubFetch(() => jsonRes(null, 503)) });
  assert.equal(r.status, 'api-error');
  assert.equal(r.mode, 'live');
  assert.equal(r.token, undefined, 'no token payload may appear on a failure');
});

test('liveScan builds the provider URL from chain + canonicalized address', async () => {
  clearLiveCache();
  const f = stubFetch(() => jsonRes([]));
  await liveScan({ chain: 'bsc', address: CAKE }, { fetchImpl: f });
  // EVM addresses are canonicalized to lowercase for the provider call.
  assert.ok(f.calls[0].endsWith(`/bsc/${CAKE.toLowerCase()}`), `unexpected URL: ${f.calls[0]}`);
});

// ---- pair age arithmetics -------------------------------------------------

test('pair age never reports 12 months and handles the year boundary', () => {
  const now = Date.UTC(2026, 10, 23);
  const day = 86_400_000;
  // The previous implementation produced "3y 12mo" and "0y 11mo" here.
  for (let d = 360; d <= 1500; d += 5) {
    const label = pairAge(now - d * day, now);
    assert.ok(!/12mo/.test(label), `${d}d produced an impossible "${label}"`);
    assert.ok(!/^0y/.test(label), `${d}d produced "${label}"`);
  }
  assert.equal(pairAge(now - 365 * day, now), '1y');
  assert.equal(pairAge(now - 730 * day, now), '2y');
  assert.equal(pairAge(now - 45 * day, now), '1mo');
  assert.equal(pairAge(now - 29 * day, now), '29d');
});

// ---- primary pair selection ----------------------------------------------

test('primaryPair rejects a deep pool whose market cap is a wrong-pair outlier', () => {
  // Real BONK shape: a $26M Meteora pool reporting a $874B cap while ~28 other
  // pools agree on ~$200M. Depth alone would publish $874B.
  const rows = [
    pair({ pairAddress: 'BAD', liquidity: { usd: 26_016_782 }, marketCap: 874_319_493_249 }),
    pair({ pairAddress: 'GOOD1', liquidity: { usd: 226_138 }, marketCap: 200_517_585 }),
    pair({ pairAddress: 'GOOD2', liquidity: { usd: 202_411 }, marketCap: 200_122_078 }),
    pair({ pairAddress: 'GOOD3', liquidity: { usd: 99_839 }, marketCap: 202_540_656 }),
  ];
  const p = primaryPair(rows);
  assert.equal(p.pairAddress, 'GOOD1', 'must pick the deepest pool inside the consistent cluster');
  assert.notEqual(p.pairAddress, 'BAD');
});

test('primaryPair still falls back to depth when no caps are reported', () => {
  const rows = [
    pair({ pairAddress: 'S', liquidity: { usd: 10 }, marketCap: null }),
    pair({ pairAddress: 'D', liquidity: { usd: 999 }, marketCap: null }),
  ];
  assert.equal(primaryPair(rows).pairAddress, 'D');
});
