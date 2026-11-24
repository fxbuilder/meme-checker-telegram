/**
 * test/phase4-getxapi.test.mjs
 *
 * GetXAPI adapter and the multi-source narrative pipeline.
 *
 * The GetXAPI wire contract and field names here are taken from the RECOVERED
 * implementation in E:\Projects\Onchain-Intelligence-Scanner (commit 9ca3db5), not
 * invented: GET /twitter/tweet/advanced_search?q=&product=, Bearer auth,
 * likeCount/retweetCount/author.userName/author.isBlueVerified.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  getxapiKey, getxapiConfigured, getxapiSearchEndpoint, getxapiKeyLength,
  classifyHttpFailure, searchWithGetXApi, GETXAPI_COST_PER_REQUEST_USD,
} from '../src/research/getxapi.mjs';
import {
  normalisePost, searchTokenPosts, preferredProvider, xDiscoveryStatus,
} from '../src/research/x-source.mjs';
import {
  htmlToText, isBoilerplate, detectLaunchpad, composeNarrative, chooseSummary,
} from '../src/research/narrative-pipeline.mjs';
import { fetchWebsiteText } from '../src/research/website-fetch.mjs';

const CA = '0x6982508145454ce325ddbe47a25d4ec3d2311933';
const SOL = 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263';

function withEnv(vars, fn) {
  const saved = {};
  for (const k of Object.keys(vars)) { saved[k] = process.env[k]; }
  for (const [k, v] of Object.entries(vars)) {
    if (v === null) delete process.env[k]; else process.env[k] = v;
  }
  try { return fn(); } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
  }
}

// ---- adapter configuration ------------------------------------------------

test('GETXAPI_KEY is the credential name and is read without disclosure', () => {
  withEnv({ GETXAPI_KEY: 'abc123' }, () => {
    assert.equal(getxapiConfigured(), true);
    assert.equal(getxapiKeyLength(), 6);
    assert.match(getxapiSearchEndpoint(), /\/twitter\/tweet\/advanced_search$/);
  });
  withEnv({ GETXAPI_KEY: null }, () => {
    assert.equal(getxapiConfigured(), false);
    assert.equal(getxapiKey(), null);
  });
});

test('the published per-request cost is the recovered constant', () => {
  assert.equal(GETXAPI_COST_PER_REQUEST_USD, 0.001);
});

test('HTTP failures are classified so key problems are diagnosable', () => {
  assert.equal(classifyHttpFailure(401, '').status, 'unauthorized');
  assert.equal(classifyHttpFailure(403, '').status, 'forbidden');
  assert.equal(classifyHttpFailure(429, '').status, 'rate-limited');
  assert.equal(classifyHttpFailure(402, '').status, 'payment-required');
  assert.equal(classifyHttpFailure(503, '').status, 'provider-error');
});

// ---- request shape -------------------------------------------------------

test('the search request uses the recovered endpoint, Bearer auth and query params', async () => {
  await withEnv({ GETXAPI_KEY: 'k-123', GETXAPI_BASE_URL: null }, async () => {
    let url = null; let headers = null; let method = null;
    const fakeFetch = async (u, o = {}) => {
      url = String(u); headers = o.headers; method = o.method ?? 'GET';
      return { ok: true, status: 200, text: async () => JSON.stringify({ tweets: [], has_more: false }) };
    };
    const r = await searchWithGetXApi({ query: `${CA} -filter:retweets`, fetchImpl: fakeFetch });

    assert.match(url, /^https:\/\/api\.getxapi\.com\/twitter\/tweet\/advanced_search/);
    assert.match(url, /[?&]q=/);
    assert.match(url, /[?&]product=Top|product=Latest/);
    assert.equal(method, 'GET');
    assert.equal(headers.Authorization, 'Bearer k-123');
    assert.equal(r.status, 'ok');
    assert.equal(r.requests, 1, 'one request per search call');
  });
});

test('no credential means not-configured and no request at all', async () => {
  await withEnv({ GETXAPI_KEY: null, SORSA_API_KEY: null }, async () => {
    let called = false;
    const r = await searchWithGetXApi({ query: CA, fetchImpl: async () => { called = true; } });
    assert.equal(r.status, 'not-configured');
    assert.equal(r.requests, 0);
    assert.equal(called, false, 'must not call the provider without a key');
  });
});

test('a failing provider reports its status instead of throwing', async () => {
  await withEnv({ GETXAPI_KEY: 'k' }, async () => {
    const r = await searchWithGetXApi({
      query: CA,
      fetchImpl: async () => ({ ok: false, status: 429, text: async () => 'slow down' }),
    });
    assert.equal(r.status, 'rate-limited');
    assert.equal(r.requests, 1, 'a billed attempt is still counted');
  });
});

// ---- field mapping -------------------------------------------------------

test('GetXAPI tweet fields map to the shared post contract', () => {
  const raw = {
    id: '111',
    text: `aped ${CA} at 2m`,
    createdAt: '2026-01-01T00:00:00Z',
    author: { userName: 'trader1', name: 'Trader One', followers: 12500, isBlueVerified: true },
    likeCount: 42, retweetCount: 7, replyCount: 3, quoteCount: 1, viewCount: 8800, bookmarkCount: 2,
    isReply: false, isQuote: false,
  };
  const p = normalisePost(raw, { chain: 'ethereum', address: CA, symbol: 'PEPE' });
  assert.equal(p.authorHandle, 'trader1', 'author.userName is the identity');
  assert.equal(p.authorName, 'Trader One');
  assert.equal(p.authorFollowers, 12500);
  assert.equal(p.authorVerified, true);
  assert.deepEqual(p.metrics, { likes: 42, reposts: 7, replies: 3, quotes: 1, views: 8800, bookmarks: 2 });
  assert.equal(p.url, 'https://x.com/trader1/status/111');
  assert.equal(p.match, 'contract');
});

test('a provider reporting no verification flag leaves it null, not false', () => {
  const p = normalisePost({ id: '2', text: 'x', author: { userName: 'n' } }, { chain: 'ethereum', address: CA, symbol: 'P' });
  assert.equal(p.authorVerified, null);
  assert.equal(p.authorFollowers, null);
});

test('Sorsa-style fields still map through the same normaliser', () => {
  const p = normalisePost({
    id_str: '9', full_text: 'hi', created_at: '2026-02-01T00:00:00Z',
    user: { screen_name: 'sorsa_user' }, favorite_count: 5, retweet_count: 2,
  }, { chain: 'ethereum', address: CA, symbol: 'P' });
  assert.equal(p.authorHandle, 'sorsa_user');
  assert.equal(p.metrics.likes, 5);
  assert.equal(p.metrics.reposts, 2);
});

test('raw X v2 includes.users fields map to the author and public metrics', () => {
  const p = normalisePost({
    id: 'v2-1', text: `buy ${CA}`, created_at: '2026-03-01T00:00:00Z', author_id: 'u-1',
    includes: { users: [{ id: 'u-1', username: 'v2_user', name: 'V2 User', public_metrics: { followers_count: 99 }, verified: true }] },
    public_metrics: { like_count: 4, retweet_count: 3, reply_count: 2, quote_count: 1, impression_count: 88, bookmark_count: 5 },
  }, { chain: 'ethereum', address: CA, symbol: 'P' });
  assert.equal(p.authorHandle, 'v2_user');
  assert.equal(p.authorFollowers, 99);
  assert.equal(p.authorVerified, true);
  assert.deepEqual(p.metrics, { likes: 4, reposts: 3, replies: 2, quotes: 1, views: 88, bookmarks: 5 });
});

test('malformed provider URLs are not emitted as post links', () => {
  const p = normalisePost({ id: '3', text: 'hi', author: { userName: 'alice' }, url: 'https://x.com/alice/status/3.evil' }, {});
  assert.equal(p.url, 'https://x.com/alice/status/3');
});

test('a post with no text is dropped rather than reported empty', () => {
  assert.equal(normalisePost({ id: '1', author: { userName: 'a' } }, {}), null);
  assert.equal(normalisePost({ id: '1', text: '   ', author: { userName: 'a' } }, {}), null);
});

// ---- provider selection --------------------------------------------------

test('GetXAPI is preferred when both credentials exist, and X_PROVIDER overrides', async () => {
  await withEnv({ GETXAPI_KEY: 'g', SORSA_API_KEY: 's', X_PROVIDER: null }, () => {
    assert.equal(preferredProvider(), 'getxapi');
  });
  await withEnv({ GETXAPI_KEY: 'g', SORSA_API_KEY: 's', X_PROVIDER: 'sorsa' }, () => {
    assert.equal(preferredProvider(), 'sorsa', 'an explicit choice wins over precedence');
  });
  await withEnv({ GETXAPI_KEY: null, SORSA_API_KEY: 's', X_PROVIDER: null }, () => {
    assert.equal(preferredProvider(), 'sorsa');
  });
  await withEnv({ GETXAPI_KEY: null, SORSA_API_KEY: null, X_PROVIDER: null }, () => {
    assert.equal(preferredProvider(), null);
    const st = xDiscoveryStatus();
    assert.equal(st.available, false);
    assert.equal(st.requiredEnv, 'GETXAPI_KEY', 'the UI must name the exact variable');
  });
});

test('searchTokenPosts routes to GetXAPI and classifies matches', async () => {
  await withEnv({ GETXAPI_KEY: 'k', SORSA_API_KEY: null, X_PROVIDER: null }, async () => {
    const fakeFetch = async () => ({
      ok: true, status: 200,
      text: async () => JSON.stringify({
        tweets: [
          { id: '1', text: `aped ${CA}`, author: { userName: 'a' }, createdAt: '2026-01-01T00:00:00Z', likeCount: 5 },
          { id: '2', text: 'just chatting', author: { userName: 'b' }, createdAt: '2026-01-02T00:00:00Z' },
        ],
      }),
    });
    const r = await searchTokenPosts({ chain: 'ethereum', address: CA, symbol: 'PEPE', fetchImpl: fakeFetch });
    assert.equal(r.status, 'ok');
    assert.equal(r.provider, 'getxapi');
    assert.equal(r.posts.length, 2);
    assert.equal(r.posts.find((p) => p.id === '1').containsContract, true);
    assert.equal(r.posts.find((p) => p.id === '2').containsContract, false);
  });
});

// ---- narrative pipeline --------------------------------------------------

test('HTML is reduced to prose without a parser dependency', () => {
  const html = '<html><head><style>.x{}</style><script>evil()</script></head>'
    + '<body><nav>menu</nav><h1>Token</h1><p>A real sentence about the project.</p>'
    + '<footer>copyright</footer></body></html>';
  const text = htmlToText(html);
  assert.match(text, /A real sentence/);
  assert.ok(!/evil\(\)/.test(text), 'script content is removed');
  assert.ok(!/copyright/.test(text), 'footer is removed');
});

test('a cookie wall or error page is not accepted as prose', () => {
  assert.equal(isBoilerplate('Please enable JavaScript to continue.'), true);
  assert.equal(isBoilerplate('This site uses cookies. Accept all cookies.'), true);
  assert.equal(isBoilerplate('Just a moment...'), true);
  assert.equal(isBoilerplate('Bonk is a dog-themed memecoin on Solana, launched in 2022 to rebuild community trust after the exchange collapse.'), false);
});

test('launchpad is detected from pair identity, and never guessed', () => {
  assert.equal(detectLaunchpad({ market: { dexId: 'pumpfun' } })?.label, 'pump.fun');
  assert.equal(detectLaunchpad({ market: { dexId: 'raydium' } })?.label, 'Raydium');
  assert.equal(detectLaunchpad({ market: { dexId: 'some-unknown-dex' } }), null);
  assert.equal(detectLaunchpad({}), null);
});

test('a token with no CoinGecko listing but a website still gets a narrative', () => {
  const composed = composeNarrative({
    result: { token: { chain: 'solana', address: 'X', symbol: 'NEWT' }, market: { dexId: 'pumpfun' } },
    profile: null,
    websiteText: 'Newt is a community memecoin built around a cartoon newt and a weekly art contest for holders.',
  });
  assert.equal(composed.available, true);
  assert.equal(composed.summaryClass, 'project-claim');
  assert.equal(composed.summarySource, 'Official website');
  assert.equal(composed.launchpad?.label, 'pump.fun');
  assert.ok(composed.claims.some((c) => c.class === 'verified' && /Launched on pump\.fun/.test(c.text)));
});

test('CoinGecko is preferred over a website when both exist', () => {
  const chosen = chooseSummary([
    { text: 'Website prose that is long enough to be considered usable here.', source: 'website' },
    { text: 'CoinGecko prose that is also long enough to be considered usable.', source: 'coingecko' },
  ]);
  assert.equal(chosen.source, 'coingecko');
});

test('nothing anywhere is an honest unavailable state', () => {
  const c = composeNarrative({ result: { token: { chain: 'base', address: '0x', symbol: 'X' } }, profile: null, websiteText: null });
  assert.equal(c.available, false);
  assert.equal(c.reason, 'no-published-description');
});

test('a cookie wall alone does not become a narrative', () => {
  const c = composeNarrative({
    result: { token: { chain: 'base', address: '0x', symbol: 'X' } },
    profile: null,
    websiteText: 'Please enable JavaScript to continue. This site uses cookies.',
  });
  assert.equal(c.available, false);
});

// ---- website fetch safety ------------------------------------------------

test('the website fetcher refuses non-HTTPS and private hosts', async () => {
  for (const url of ['http://example.com', 'https://127.0.0.1/x', 'https://localhost/x', 'https://10.0.0.1/']) {
    const r = await fetchWebsiteText(url, { fetchImpl: async () => { throw new Error('must not fetch'); } });
    assert.equal(r.status, 'unsafe-url', url);
  }
});

test('the website fetcher validates every redirect hop', async () => {
  let calls = 0;
  const r = await fetchWebsiteText('https://example.com/', {
    fetchImpl: async () => {
      calls += 1;
      return { status: 302, headers: { get: () => 'https://169.254.169.254/latest/meta-data' } };
    },
  });
  assert.equal(r.status, 'unsafe-url');
  assert.equal(calls, 1, 'must not follow a redirect into a metadata endpoint');
});

test('a non-text content type is refused', async () => {
  const r = await fetchWebsiteText('https://example.com/', {
    fetchImpl: async () => ({ ok: true, status: 200, headers: { get: () => 'application/zip' }, text: async () => 'binary' }),
  });
  assert.equal(r.status, 'not-text');
});
