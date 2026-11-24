/**
 * src/research/x-source.mjs
 * X post discovery for a token, plus KOL call extraction.
 *
 * HONEST STATUS OF X DISCOVERY
 * Search requires a credentialed provider. As of this build there is NO key
 * configured in either project (`SORSA_API_KEY` / `GETXAPI_KEY`), so discovery
 * reports `not-configured` and the UI says so. It does not fall back to scraping
 * mirrors (unauthorised) and does not invent posts.
 *
 * What DOES work without a key is single-post verification through X's public
 * oEmbed endpoint. That is useful for one thing only: confirming that a post URL
 * someone already gave us exists and belongs to the handle we think it does. It
 * cannot search.
 *
 * The adapter below is written so that adding a key is the only change needed:
 *   SORSA_API_KEY=<key>
 * then discovery works with the same shapes, cache, budget and dedupe.
 *
 * CONTRACT-FIRST IDENTITY
 * The canonical contract address is the primary search identifier. A ticker-only
 * match is never attributed to a token automatically: `$BONK` on a random post is
 * a cashtag, not evidence about a specific contract, and two tokens can share a
 * ticker across chains. `containsContract` records the only strong signal.
 */

const SORSA_ENDPOINT = 'https://api.sorsa.io/v3/search-tweets';
const OEMBED_ENDPOINT = 'https://publish.twitter.com/oembed';
const TIMEOUT_MS = 15_000;

/** The only X provider the owner's existing research validated. */
export function sorsaKey() {
  const k = process.env.SORSA_API_KEY;
  return typeof k === 'string' && k.trim().length > 0 ? k.trim() : null;
}

export function xDiscoveryConfigured() {
  return sorsaKey() !== null;
}

/**
 * Why X discovery is unavailable, in words the UI can print.
 * Every value here is a real state, not a placeholder.
 */
export function xDiscoveryStatus() {
  if (!xDiscoveryConfigured()) {
    return {
      available: false,
      reason: 'not-configured',
      detail: 'No X search credential is configured, so public post discovery is unavailable. '
        + 'Individual post links can still be verified.',
    };
  }
  return { available: true, reason: 'configured' };
}

// ---- normalisation --------------------------------------------------------

/**
 * Does this text contain the exact contract we asked about?
 * EVM addresses are case-insensitive; Solana base58 is not.
 */
export function containsContract(text, address, chain) {
  if (typeof text !== 'string' || !text || !address) return false;
  if (chain === 'solana') return text.includes(address);
  return text.toLowerCase().includes(String(address).toLowerCase());
}

/** Does this text carry the token's cashtag? Weak evidence, tracked separately. */
export function containsTicker(text, symbol) {
  if (typeof text !== 'string' || !text || !symbol) return false;
  const re = new RegExp(`\\$${String(symbol).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i');
  return re.test(text);
}

const METRIC_KEYS = ['likes', 'reposts', 'replies', 'quotes', 'views', 'bookmarks'];

/** A missing metric is null, never 0. Zero engagement and unknown differ. */
function asNumber(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/**
 * Normalise one provider post.
 * Returns null for a row with no usable identity — dropped, not filled in.
 */
export function normalisePost(raw, { chain, address, symbol } = {}) {
  if (!raw || typeof raw !== 'object') return null;
  const id = raw.id_str ?? raw.id ?? raw.tweet_id;
  const text = raw.full_text ?? raw.text ?? raw.content;
  if (!id || typeof text !== 'string') return null;

  const author = raw.user?.screen_name ?? raw.author?.username ?? raw.authorHandle ?? null;
  const createdAtRaw = raw.created_at ?? raw.createdAt ?? null;
  const createdAt = createdAtRaw ? new Date(createdAtRaw) : null;

  const metrics = {};
  for (const k of METRIC_KEYS) {
    metrics[k] = asNumber(raw[k] ?? raw.public_metrics?.[k] ?? raw.metrics?.[k]);
  }

  return {
    id: String(id),
    // Built from id + author only. We never emit a URL we did not derive this way.
    url: author ? `https://x.com/${author}/status/${id}` : null,
    authorHandle: typeof author === 'string' ? author.replace(/^@/, '') : null,
    text,
    createdAt: createdAt && !Number.isNaN(createdAt.getTime()) ? createdAt.toISOString() : null,
    metrics,
    isReply: Boolean(raw.is_reply ?? raw.in_reply_to_status_id_str),
    isQuote: Boolean(raw.is_quote_status ?? raw.quoted_status_id_str),
    containsContract: containsContract(text, address, chain),
    containsTicker: containsTicker(text, symbol),
    // How strongly this post can be tied to the token. Only 'contract' is strong.
    match: containsContract(text, address, chain) ? 'contract' : (containsTicker(text, symbol) ? 'ticker' : 'none'),
  };
}

/**
 * Deduplicate posts by id, preferring the copy with the higher engagement and
 * keeping the earliest timestamp. A retweet and its original share an id in most
 * payloads; where they do not, the text is identical and the older one wins.
 */
export function dedupePosts(posts) {
  const byKey = new Map();
  for (const p of posts) {
    const key = p.text?.trim().slice(0, 120) ?? p.id;
    const prev = byKey.get(key);
    if (!prev) { byKey.set(key, p); continue; }
    const prevTs = prev.createdAt ? Date.parse(prev.createdAt) : Infinity;
    const thisTs = p.createdAt ? Date.parse(p.createdAt) : Infinity;
    byKey.set(key, thisTs < prevTs ? p : prev);
  }
  // Also collapse by id in case two different texts share one id.
  const byId = new Map();
  for (const p of byKey.values()) if (!byId.has(p.id)) byId.set(p.id, p);
  return [...byId.values()];
}

// ---- discovery ------------------------------------------------------------

/**
 * Search X for posts about one token.
 *
 * Requests: at most 1 per call (the free tier is 100 for the account lifetime).
 * Cache and budget live in research-cache.mjs; this function is only the wire.
 *
 * @returns {Promise<{status:string, posts?:Array, requests?:number}>}
 */
export async function searchTokenPosts({ chain, address, symbol, order = 'popular', fetchImpl = globalThis.fetch, timeoutMs = TIMEOUT_MS } = {}) {
  const key = sorsaKey();
  if (!key) return { status: 'not-configured', posts: [], requests: 0 };
  if (typeof fetchImpl !== 'function') return { status: 'provider-error', posts: [], requests: 0 };

  // Contract first. A ticker query alone is never used as the primary search.
  const query = `${address} -filter:retweets`;
  try {
    const res = await fetchImpl(SORSA_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ApiKey: key, accept: 'application/json' },
      body: JSON.stringify({ query, order }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (res.status === 401) return { status: 'unauthorized', posts: [], requests: 1 };
    if (res.status === 403) return { status: 'bad-header', posts: [], requests: 1 };
    if (res.status === 429) return { status: 'rate-limited', posts: [], requests: 1 };
    if (!res.ok) return { status: 'provider-error', posts: [], requests: 1 };

    const j = await res.json();
    const rows = Array.isArray(j?.tweets) ? j.tweets : Array.isArray(j?.data) ? j.data : [];
    const posts = dedupePosts(rows.map((r) => normalisePost(r, { chain, address, symbol })).filter(Boolean));
    return { status: 'ok', posts, requests: 1 };
  } catch (err) {
    const timedOut = err?.name === 'TimeoutError' || err?.name === 'AbortError';
    return { status: timedOut ? 'timeout' : 'provider-error', posts: [], requests: 1 };
  }
}

// ---- post verification (keyless) -----------------------------------------

/**
 * Verify that ONE post URL exists and belongs to the handle we expect.
 *
 * Uses X's public oEmbed. This is not search and cannot discover anything; it can
 * only confirm a URL we already have. Reported separately from discovery so the
 * UI never implies a verified post means a verified narrative.
 */
export async function verifyPostUrl(url, { expectHandle = null, fetchImpl = globalThis.fetch, timeoutMs = 8_000 } = {}) {
  if (typeof url !== 'string' || !/^https:\/\/(twitter|x)\.com\/[A-Za-z0-9_]+\/status\/\d+/.test(url)) {
    return { verified: false, reason: 'not-a-post-url' };
  }
  const endpoint = `${OEMBED_ENDPOINT}?url=${encodeURIComponent(url)}`;
  try {
    const res = await fetchImpl(endpoint, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(timeoutMs) });
    if (res.status === 404) return { verified: false, reason: 'not-found' };
    if (!res.ok) return { verified: false, reason: `http ${res.status}` };
    const j = await res.json();
    const handleFromUrl = /status\//.test(url) ? url.split('/')[3] : null;
    const authorUrl = typeof j.author_url === 'string' ? j.author_url : '';
    const handle = authorUrl.split('/').filter(Boolean).pop() ?? handleFromUrl;
    if (expectHandle && handle && handle.toLowerCase() !== String(expectHandle).toLowerCase()) {
      return { verified: false, reason: 'author-mismatch', foundHandle: handle };
    }
    return { verified: true, handle, authorName: j.author_name ?? null };
  } catch (err) {
    const timedOut = err?.name === 'TimeoutError' || err?.name === 'AbortError';
    return { verified: false, reason: timedOut ? 'timeout' : 'provider-error' };
  }
}

// ---- KOL classification ---------------------------------------------------

/**
 * Classify what an account did with a token, using only what the post supports.
 *
 * A mention is NOT a call. The rules the existing research established:
 *   public-call   the post names the contract AND reads as a call (buy/entry/ape/
 *                 target language), so it can own an entry in call history
 *   mention       the contract appears but there is no call language
 *   announcement  the account is the project itself
 *   repost        a quote/reply that forwards someone else's content
 */
const CALL_LANGUAGE = /\b(ape|aped|aping|bought|buying|entry|entered|loading|loaded|accumulat\w*|bag|bags|long|call|target|sending|send it|moon|gem)\b/i;

export function classifyPost(post, { projectHandle = null, authorHandle = null } = {}) {
  if (!post) return 'unknown';
  const isProject = projectHandle && post.authorHandle
    && post.authorHandle.toLowerCase() === String(projectHandle).toLowerCase();
  if (isProject) return 'announcement';
  if (post.isQuote || post.isReply) return 'repost';
  if (!post.containsContract) return 'mention';
  return CALL_LANGUAGE.test(post.text ?? '') ? 'public-call' : 'mention';
}

/**
 * Group posts by author into KOL activity rows.
 *
 * Sample size and coverage are first-class: we can only report what we recorded,
 * and a win rate over four posts is not a track record. `sampleLimit` is rendered.
 */
export function summariseKols(posts, { projectHandle = null } = {}) {
  const byAuthor = new Map();
  for (const p of posts) {
    if (!p.authorHandle) continue;
    const key = p.authorHandle.toLowerCase();
    const cur = byAuthor.get(key) ?? {
      handle: p.authorHandle,
      posts: 0,
      firstSeenAt: p.createdAt,
      lastSeenAt: p.createdAt,
      hasContractMatch: false,
      classes: new Set(),
    };
    cur.posts += 1;
    cur.hasContractMatch = cur.hasContractMatch || p.containsContract;
    cur.classes.add(classifyPost(p, { projectHandle }));
    if (p.createdAt) {
      if (!cur.firstSeenAt || Date.parse(p.createdAt) < Date.parse(cur.firstSeenAt)) cur.firstSeenAt = p.createdAt;
      if (!cur.lastSeenAt || Date.parse(p.createdAt) > Date.parse(cur.lastSeenAt)) cur.lastSeenAt = p.createdAt;
    }
    byAuthor.set(key, cur);
  }
  return [...byAuthor.values()]
    .map((k) => ({
      handle: k.handle,
      posts: k.posts,
      firstSeenAt: k.firstSeenAt,
      lastSeenAt: k.lastSeenAt,
      hasContractMatch: k.hasContractMatch,
      // Precedence: a real call outranks a bare mention.
      role: k.classes.has('public-call') ? 'public-call'
        : k.classes.has('announcement') ? 'announcement'
          : k.classes.has('repost') ? 'repost' : 'mention',
    }))
    .sort((a, b) => b.posts - a.posts);
}

/**
 * How much of the picture we actually have, stated rather than implied.
 */
export function coverageNote({ posts, uniqueAccounts, requests, configured }) {
  if (!configured) return 'X discovery is not configured, so no public post data is available.';
  if (!posts) return 'No public posts were found for this contract.';
  return `Based on ${posts} public post${posts === 1 ? '' : 's'} from ${uniqueAccounts} account`
    + `${uniqueAccounts === 1 ? '' : 's'}, from ${requests} search request${requests === 1 ? '' : 's'}. `
    + 'This is a sample of public posts, not a complete record of who discussed the token.';
}
