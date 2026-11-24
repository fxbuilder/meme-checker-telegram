/**
 * test/phase4-narrative-multichain.test.mjs
 *
 * GeckoTerminal adapter, on-chain metadata, and the multi-chain narrative pipeline.
 *
 * Every assertion here is about honesty: a field either is grounded in a payload or
 * is null. Nothing is filled in to make a card look complete.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  GT_NETWORK, gtSupportsChain, gtNetwork, normaliseTokenInfo,
  fetchTokenInfo, narrativeCoverageForChain, PacedGate,
} from '../src/research/geckoterminal.mjs';
import {
  readSolanaMint, readMetaplexJson, mintFacts,
} from '../src/research/onchain-metadata.mjs';
import { composeNarrative } from '../src/research/narrative-pipeline.mjs';

const BONK = 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263';

// ---- chain coverage ------------------------------------------------------

test('the chain map covers every registered chain except Robinhood', () => {
  const expected = [
    'solana', 'ethereum', 'bsc', 'base', 'arbitrum', 'optimism', 'polygon',
    'avalanche', 'hyperevm', 'monad', 'unichain', 'berachain', 'abstract',
    'megaeth', 'story',
  ];
  for (const c of expected) assert.equal(gtSupportsChain(c), true, `${c} must map`);
  assert.equal(gtSupportsChain('robinhood'), false, 'Robinhood is genuinely absent from GeckoTerminal');
  assert.equal(gtSupportsChain('nonexistent'), false);
});

test('network ids are the specific ones, not guesses', () => {
  // These differ from our chain ids and were verified against /api/v2/networks.
  assert.equal(gtNetwork('ethereum'), 'eth');
  assert.equal(gtNetwork('polygon'), 'polygon_pos');
  assert.equal(gtNetwork('avalanche'), 'avax');
  assert.equal(gtNetwork('solana'), 'solana');
  assert.equal(gtNetwork('unknown-chain'), null);
});

test('an unsupported chain reports a coverage gap, not an empty token', () => {
  const c = narrativeCoverageForChain('robinhood');
  assert.equal(c.available, false);
  assert.equal(c.reason, 'no-metadata-source');
});

// ---- payload normalisation ----------------------------------------------

test('a description is kept as a claim, and links are only what the provider gave', () => {
  const t = normaliseTokenInfo({
    address: BONK, name: 'Bonk', symbol: 'BONK',
    description: 'Bonk is a dog-themed memecoin launched on Christmas Day 2022.',
    websites: ['https://www.bonkcoin.com'],
    twitter_handle: 'bonk_inu',
    telegram_handle: '@bonk_tg',
    discord_url: 'https://discord.gg/x',
    coingecko_coin_id: 'bonk',
  }, { chain: 'solana', address: BONK });

  assert.equal(t.source, 'geckoterminal');
  assert.match(t.description, /dog-themed/);
  assert.equal(t.website, 'https://www.bonkcoin.com/', 'URL canonicalisation adds a trailing slash');
  assert.equal(t.twitter, 'https://x.com/bonk_inu');
  assert.equal(t.twitterHandle, 'bonk_inu');
  assert.equal(t.telegram, 'https://t.me/bonk_tg', 'a leading @ is stripped, not kept');
  assert.equal(t.coingeckoId, 'bonk');
});

test('absent fields are null, never empty strings or placeholders', () => {
  const t = normaliseTokenInfo({ address: BONK, name: 'X' }, { chain: 'solana', address: BONK });
  assert.equal(t.description, null);
  assert.equal(t.website, null);
  assert.equal(t.twitter, null);
  assert.equal(t.discord, null);
  assert.equal(t.coingeckoId, null);
  assert.deepEqual(t.websites, []);
});

test('malicious or malformed links are dropped rather than repaired', () => {
  const t = normaliseTokenInfo({
    websites: ['javascript:alert(1)', 'http://ok.example', 'not-a-url', 'https://good.example'],
    twitter_handle: 'has space!',
    discord_url: 'ftp://x',
    image_url: 'data:image/png;base64,AAA',
  }, { chain: 'solana', address: BONK });

  assert.deepEqual(t.websites, ['http://ok.example/', 'https://good.example/'].sort(),
    'only real http(s) URLs survive');
  assert.equal(t.twitter, null, 'an invalid handle yields no link');
  assert.equal(t.discord, null);
  assert.equal(t.imageUrl, null, 'a data: URI is not an image source');
});

// ---- fetch behaviour ----------------------------------------------------

test('an unmapped chain is refused without any request', async () => {
  let called = false;
  const r = await fetchTokenInfo('robinhood', BONK, {
    fetchImpl: async () => { called = true; return { ok: true, status: 200 }; },
    skipGate: true,
  });
  assert.equal(r.status, 'unsupported-chain');
  assert.equal(called, false);
});

test('404 is not-found and 429 is rate-limited after retries', async () => {
  const gate = new PacedGate({ minIntervalMs: 0, sleep: async () => {} });
  const nf = await fetchTokenInfo('solana', BONK, {
    fetchImpl: async () => ({ status: 404, ok: false }), gate, skipGate: true,
  });
  assert.equal(nf.status, 'not-found');

  const rl = await fetchTokenInfo('solana', BONK, {
    fetchImpl: async () => ({ status: 429, ok: false }), gate, skipGate: true,
  });
  assert.equal(rl.status, 'rate-limited');
});

test('a 429 is retried before giving up, so a throttle is not a verdict', async () => {
  const gate = new PacedGate({ minIntervalMs: 0, sleep: async () => {} });
  let calls = 0;
  const r = await fetchTokenInfo('solana', BONK, {
    gate,
    skipGate: true,
    fetchImpl: async () => {
      calls += 1;
      if (calls === 1) return { status: 429, ok: false };
      return {
        ok: true, status: 200,
        text: async () => JSON.stringify({ data: { attributes: { address: BONK, name: 'Bonk', description: 'A dog coin.' } } }),
      };
    },
  });
  assert.equal(calls, 2, 'the throttled attempt was retried');
  assert.equal(r.status, 'ok');
  assert.equal(r.token.description, 'A dog coin.');
});

// ---- on-chain metadata --------------------------------------------------

test('a Solana mint yields verified facts, and authority state is stated truthfully', async () => {
  const r = await readSolanaMint(BONK, {
    fetchImpl: async () => ({
      ok: true, status: 200,
      json: async () => ({
        result: {
          value: {
            owner: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
            data: { parsed: { type: 'mint', info: { decimals: 5, supply: '100000000000000', mintAuthority: null, freezeAuthority: null, isInitialized: true } } },
          },
        },
      }),
    }),
  });
  assert.equal(r.status, 'ok');
  assert.equal(r.mint.standard, 'spl-token');
  assert.equal(r.mint.decimals, 5);

  const facts = mintFacts(r.mint);
  assert.ok(facts.some((f) => /Mint authority renounced/.test(f.text)));
  assert.ok(facts.some((f) => /Freeze authority renounced/.test(f.text)));
  for (const f of facts) assert.equal(f.class, 'verified');
});

test('an active mint authority is stated as a risk, not a feature', async () => {
  const facts = mintFacts({
    standard: 'spl-token', mintAuthority: 'SomeAuthority111', freezeAuthority: 'SomeAuthority111',
  });
  assert.ok(facts.some((f) => /Mint authority still active/.test(f.text)));
  assert.ok(facts.some((f) => /Freeze authority active/.test(f.text)));
});

test('Token-2022 is identified from the program id, not assumed', async () => {
  const r = await readSolanaMint(BONK, {
    fetchImpl: async () => ({
      ok: true, status: 200,
      json: async () => ({
        result: { value: { owner: 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb', data: { parsed: { type: 'mint', info: { decimals: 9 } } } } },
      }),
    }),
  });
  assert.equal(r.mint.standard, 'token-2022');
});

test('a non-mint account is reported, not treated as a failed token', async () => {
  const r = await readSolanaMint(BONK, {
    fetchImpl: async () => ({
      ok: true, status: 200,
      json: async () => ({ result: { value: { owner: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA', data: { parsed: { type: 'account', info: {} } } } } }),
    }),
  });
  assert.equal(r.status, 'not-a-mint');
});

test('Metaplex JSON is refused for non-HTTPS, redirects and unsafe hosts', async () => {
  for (const uri of ['http://x.example/m.json', 'data:application/json,{}', 'ipfs://abc']) {
    const r = await readMetaplexJson(uri, { fetchImpl: async () => { throw new Error('must not fetch'); } });
    assert.equal(r.status, 'unsafe-uri', uri);
  }
  // A redirect is not followed: it would bypass the host check.
  const redir = await readMetaplexJson('https://ok.example/m.json', {
    fetchImpl: async () => ({ status: 302, headers: { get: () => 'http://169.254.169.254/' } }),
  });
  assert.equal(redir.status, 'unsafe-uri');
  // An SSRF guard supplied by the caller is honoured.
  const blocked = await readMetaplexJson('https://ok.example/m.json', {
    isSafeUrl: () => false,
    fetchImpl: async () => { throw new Error('must not fetch'); },
  });
  assert.equal(blocked.status, 'unsafe-uri');
});

// ---- composition ---------------------------------------------------------

test('GeckoTerminal outranks CoinGecko, which is now supplementary', () => {
  const c = composeNarrative({
    result: { token: { chain: 'base', address: '0xabc', symbol: 'BRETT' } },
    gtToken: { description: "Brett is a blue mascot memecoin on Base, inspired by the Boy's Club comic character and launched without a presale." },
    profile: { description: 'A CoinGecko description that should lose.' },
  });
  assert.equal(c.summarySource, 'Project description (GeckoTerminal)');
  assert.match(c.summary, /blue mascot/);
});

test('a fresh token with no prose still returns verified facts, not an empty result', () => {
  const c = composeNarrative({
    result: { token: { chain: 'solana', address: BONK, symbol: 'NEW' }, market: { dexId: 'pumpfun' } },
    gtToken: { name: 'New', symbol: 'NEW' }, // metadata exists, description does not
    mint: { standard: 'spl-token', decimals: 6, mintAuthority: null, freezeAuthority: null },
  });
  assert.equal(c.available, false, 'no prose means no summary');
  assert.equal(c.reason, 'no-published-description');
  assert.ok(c.hasVerifiedFacts, 'but the card can still say something true');
  assert.ok(c.claims.length >= 2);
  assert.ok(c.claims.every((x) => x.class === 'verified' || x.class === 'reported'));
});

test('links from GeckoTerminal are carried through for the card', () => {
  const c = composeNarrative({
    result: { token: { chain: 'solana', address: BONK, symbol: 'BONK' } },
    gtToken: { description: 'A dog coin.', website: 'https://www.bonkcoin.com', twitter: 'https://x.com/bonk_inu', telegram: null },
  });
  assert.equal(c.links.website, 'https://www.bonkcoin.com');
  assert.equal(c.links.twitter, 'https://x.com/bonk_inu');
  assert.equal(c.links.telegram, null);
  assert.equal(c.hasLinks, true);
});

test('no prose source is an honest unavailable state, with only contract facts', () => {
  const c = composeNarrative({ result: { token: { chain: 'base', address: '0x', symbol: 'X' } } });
  assert.equal(c.available, false, 'no summary without prose');
  assert.equal(c.reason, 'no-published-description');
  // The symbol is still a true statement about the token, so facts exist; what must
  // NOT happen is inventing a description or links.
  assert.equal(c.hasLinks, false);
  assert.ok(c.claims.every((x) => x.class === 'verified' || x.class === 'reported'),
    'only grounded claims');
  assert.ok(!c.summary, 'no summary text is fabricated');
});

// ---- pacing --------------------------------------------------------------

test('the paced gate serialises concurrent callers', async () => {
  let clock = 0;
  const gate = new PacedGate({ minIntervalMs: 1000, now: () => clock, sleep: async (ms) => { clock += ms; } });
  await Promise.all([gate.wait(), gate.wait(), gate.wait()]);
  assert.equal(clock, 2000, 'two gaps after the first free call, not zero');
});
