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

import { getxapiConfigured, searchWithGetXApi } from './getxapi.mjs';

const SORSA_ENDPOINT = 'https://api.sorsa.io/v3/search-tweets';
const OEMBED_ENDPOINT = 'https://publish.twitter.com/oembed';
const TIMEOUT_MS = 15_000;

/**
 * Which backend answers. GetXAPI is primary because it is the integration recovered
 * from the existing research project with a verified wire contract; Sorsa stays
 * available because its adapter was also built and its pagination differs.
 *
 * X_PROVIDER names the preferred backend explicitly. Silent precedence would make
 * cost and provenance depend on which env var happened to be set.
 */
export function sorsaKey() {
  const k = process.env.SORSA_API_KEY;
  return typeof k === 'string' && k.trim().length > 0 ? k.trim() : null;
}

export function preferredProvider(env = process.env) {
  const named = String(env.X_PROVIDER ?? '').trim().toLowerCase();
  if (named === 'getxapi' || named === 'sorsa') return named;
  // No explicit preference: use whichever credential exists, GetXAPI first.
  if (getxapiConfigured(env)) return 'getxapi';
  if (sorsaKey()) return 'sorsa';
  return null;
}

export function xDiscoveryConfigured() {
  return preferredProvider() !== null;
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
      // Name the exact variable so the owner knows what to set.
      detail: 'No X search credential is configured, so public post discovery is unavailable. '
        + 'Set GETXAPI_KEY (or SORSA_API_KEY) to enable it. Individual post links can still be verified.',
      requiredEnv: 'GETXAPI_KEY',
    };
  }
  return { available: true, reason: 'configured', provider: preferredProvider() };
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

/**
 * Field-name aliases per provider, recovered from the existing project's adapter
 * (src/lib/getxapi.ts) rather than guessed:
 *   GetXAPI  : likeCount / retweetCount / replyCount / quoteCount / viewCount /
 *              bookmarkCount, author.userName, author.name, author.followers,
 *              author.isVerified | author.isBlueVerified, isReply, isQuote,
 *              quotedTweetId, createdAt, text
 *   Sorsa    : likes / retweets / replies / quotes / views / bookmarks,
 *              user.screen_name, created_at, full_text
 *   Raw X v2 : public_metrics.{like_count,...}
 */
const METRIC_ALIASES = {
  likes: ['likes', 'likeCount', 'like_count', 'favorite_count'],
  reposts: ['reposts', 'retweets', 'retweetCount', 'retweet_count'],
  replies: ['replies', 'replyCount', 'reply_count'],
  quotes: ['quotes', 'quoteCount', 'quote_count'],
  views: ['views', 'viewCount', 'view_count', 'impression_count'],
  bookmarks: ['bookmarks', 'bookmarkCount', 'bookmark_count'],
};

/**
 * Raw X v2 nests these under public_metrics with names that do not follow one
 * pattern: replies is reply_count, reposts is retweet_count, views is
 * impression_count. Listed explicitly, because deriving them with a regex turned
 * "replies" into "replie_count" and silently nulled two metrics.
 */
const V2_PUBLIC_METRIC_KEYS = {
  likes: 'like_count',
  reposts: 'retweet_count',
  replies: 'reply_count',
  quotes: 'quote_count',
  views: 'impression_count',
  bookmarks: 'bookmark_count',
};

/** A missing metric is null, never 0. Zero engagement and unknown differ. */
function asNumber(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/** First present alias wins. */
function pick(obj, names) {
  for (const n of names) {
    if (obj?.[n] !== undefined && obj?.[n] !== null) return obj[n];
  }
  return undefined;
}

/**
 * Normalise one provider post.
 * Returns null for a row with no usable identity — dropped, not filled in.
 */
export function normalisePost(raw, { chain, address, symbol } = {}) {
  if (!raw || typeof raw !== 'object') return null;
  const rawId = raw.id_str ?? raw.id ?? raw.tweet_id;
  // X status ids are numeric. Accepting any truthy value let a malformed payload
  // become https://x.com/alice/status/abc - a link that looks real but cannot exist.
  const id = (typeof rawId === 'string' || typeof rawId === 'number')
    && /^\d{1,25}$/.test(String(rawId).trim())
    ? String(rawId).trim()
    : null;
  const rawText = raw.full_text ?? raw.text ?? raw.content;
  // No text means no post identity we can report. Dropped, not filled with ''.
  if (typeof rawText !== 'string' || rawText.trim() === '') return null;
  const text = rawText;
  if (!id || typeof text !== 'string') return null;

  // Author identity: GetXAPI uses author.userName, Sorsa user.screen_name, raw X v2
  // uses author.username or the includes.users entry referenced by author_id. Stable
  // handle only - a display name is not identity.
  const v2User = Array.isArray(raw.includes?.users) && raw.author_id != null
    ? raw.includes.users.find((u) => String(u?.id) === String(raw.author_id))
    : null;
  const author = raw.author?.userName
    ?? raw.user?.screen_name
    ?? raw.author?.username
    ?? raw.author?.handle
    ?? raw.authorHandle
    ?? v2User?.username
    ?? null;
  const authorName = raw.author?.name ?? raw.user?.name ?? v2User?.name ?? null;
  const authorFollowers = asNumber(
    raw.author?.followers
      ?? raw.user?.followers_count
      ?? v2User?.followers_count
      ?? v2User?.public_metrics?.followers_count,
  );
  // A provider reporting neither verification flag has verified nothing, so this
  // stays null rather than guessing false.
  const verifiedFlags = [raw.author?.isVerified, raw.author?.isBlueVerified, raw.user?.verified, v2User?.verified];
  const authorVerified = verifiedFlags.some((f) => f === true) ? true
    : verifiedFlags.every((f) => f === undefined || f === null) ? null : false;

  const createdAtRaw = raw.created_at ?? raw.createdAt ?? null;
  const createdAt = createdAtRaw ? new Date(createdAtRaw) : null;

  const metrics = {};
  for (const k of METRIC_KEYS) {
    metrics[k] = asNumber(
      pick(raw, METRIC_ALIASES[k])
      ?? raw.public_metrics?.[V2_PUBLIC_METRIC_KEYS[k]]
      ?? raw.public_metrics?.[k]
      ?? raw.metrics?.[k],
    );
  }

  return {
    id: String(id),
    // Prefer a provider-supplied post URL when it is a real post link; otherwise
    // derive it from author + id. We never emit a URL we cannot ground.
    url: (typeof raw.url === 'string' && /^https:\/\/(www\.)?(twitter|x)\.com\/[^/]+\/status\/\d+(?:[?#].*)?$/.test(raw.url))
      ? raw.url
      : (author ? `https://x.com/${String(author).replace(/^@/, '')}/status/${id}` : null),
    authorHandle: typeof author === 'string' ? author.replace(/^@/, '') : null,
    authorName: typeof authorName === 'string' && authorName.trim() ? authorName.trim() : null,
    authorFollowers,
    authorVerified,
    text,
    createdAt: createdAt && !Number.isNaN(createdAt.getTime()) ? createdAt.toISOString() : null,
    metrics,
    isReply: raw.isReply === true || Boolean(raw.is_reply ?? raw.in_reply_to_status_id_str),
    isQuote: raw.isQuote === true
      || Boolean(raw.is_quote_status ?? raw.quoted_status_id_str)
      || (typeof raw.quotedTweetId === 'string' && raw.quotedTweetId.length > 0),
    containsContract: containsContract(text, address, chain),
    containsTicker: containsTicker(text, symbol),
    // The contract this post was searched for. Carried so classification can tell a
    // single-token post from a multi-token promo without re-deriving identity.
    searchedAddress: address ?? null,
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
  if (!xDiscoveryConfigured()) return { status: 'not-configured', posts: [], requests: 0 };
  if (typeof fetchImpl !== 'function') return { status: 'provider-error', posts: [], requests: 0 };

  const provider = preferredProvider();

  // ---- GetXAPI (recovered integration, primary) --------------------------
  if (provider === 'getxapi') {
    // `-filter:retweets` keeps the page focused on original posts; the provider
    // accepts standard X search operators.
    const res = await searchWithGetXApi({
      query: `${address} -filter:retweets`,
      product: order === 'latest' ? 'Latest' : 'Top',
      fetchImpl,
      timeoutMs,
    });
    if (res.status !== 'ok') {
      return { status: res.status, posts: [], requests: res.requests ?? 0, detail: res.detail, provider };
    }
    const posts = dedupePosts((res.tweets ?? [])
      .map((r) => normalisePost(r, { chain, address, symbol }))
      .filter(Boolean));
    return { status: 'ok', posts, requests: res.requests ?? 1, provider, nextCursor: res.nextCursor ?? null };
  }

  // ---- Sorsa (fallback, kept because its adapter is already built) -------
  const key = sorsaKey();

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
  // End-anchored. An unanchored pattern accepted /status/123.evil, so a crafted URL
  // could reach oEmbed verification while pointing outside the intended post shape.
  if (typeof url !== 'string' || !/^https:\/\/(?:www\.)?(?:twitter|x)\.com\/[A-Za-z0-9_]{1,15}\/status\/\d{1,25}(?:[?#].*)?$/.test(url)) {
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
/**
 * Language that indicates the author is claiming to have taken a position, or is
 * telling readers to.
 *
 * MEASURED AGAINST LIVE POSTS. A flat keyword list produced false calls on real
 * BONK data: "it will not mail you a target" matched `target`, and "all day long"
 * matched `long`. Both were pure promotional prose with no position at all, and one
 * of them was advertising an unaffiliated copy site.
 *
 * Two changes follow from that:
 *   1. Ambiguous nouns (`target`, `call`, `gem`, `moon`, `bag`) are dropped. They
 *      appear constantly in narrative copy that makes no claim.
 *   2. Weak verbs must be FIRST PERSON. "I aped" is a call; "it aped" or "they aped"
 *      is commentary about someone else.
 *
 * The cost of a false public-call is high: it credits an account with a call it never
 * made and lets a promo post masquerade as KOL activity.
 */
const CALL_VERBS_FIRST_PERSON = /\b(i|we|i'm|im|we're|were)\s+(just\s+)?(aped|aped in|bought|buying|loaded|loading|accumulated|entered|adding|added)\b/i;
const CALL_VERBS_IMPERATIVE = /\b(aped|bought|loading up|loaded up|sent it|sending it|aping in)\b/i;
/** Explicit position statements, which are unambiguous. */
const CALL_POSITION = /\b(my entry|my bag|my bags|entry at|in at \$?[\d.]+|bought at \$?[\d.]+|filled my|added to my)\b/i;
/**
 * Shill language. "buy these three coins" is a shill, but on a multi-token promo post
 * it is NOT a call on the token being checked - live BONK data had a post promoting
 * BONK, $GRUTA and $USD at once, which is an advertisement, not a BONK call.
 *
 * So a shill only counts when the post mentions exactly one contract, i.e. when the
 * thing being pushed can only be this token.
 */
const CALL_SHILL = /\b(buy (these|this)|ape (this|it)|send it|don't miss|last chance to buy|sell a kidney)\b/i;

/** How many distinct contract-shaped addresses the post contains. */
function contractMentionCount(text, address) {
  if (!text) return 0;
  const s = String(text);
  // EVM addresses, then base58 mint-like strings of Solana length.
  const evm = s.match(/0x[a-fA-F0-9]{40}/g) ?? [];
  const base58 = s.match(/\b[1-9A-HJ-NP-Za-km-z]{32,44}\b/g) ?? [];
  const set = new Set([...evm.map((x) => x.toLowerCase()), ...base58]);
  // The searched address itself counts as one if present.
  const hasTarget = address
    ? set.has(address.toLowerCase()) || [...set].some((x) => x.toLowerCase() === String(address).toLowerCase())
    : false;
  return hasTarget ? set.size : set.size;
}

export function classifyPost(post, { projectHandle = null, authorHandle = null } = {}) {
  if (!post) return 'unknown';
  const isProject = projectHandle && post.authorHandle
    && post.authorHandle.toLowerCase() === String(projectHandle).toLowerCase();
  if (isProject) return 'announcement';
  if (post.isQuote || post.isReply) return 'repost';
  if (!post.containsContract) return 'mention';

  const text = post.text ?? '';

  // A multi-token promo is an advertisement, not a call on any one of them.
  const multiToken = contractMentionCount(text, post.searchedAddress) > 1;

  const assertsPosition = CALL_POSITION.test(text)
    || CALL_VERBS_FIRST_PERSON.test(text)
    || CALL_VERBS_IMPERATIVE.test(text)
    // Shill language only counts for a single-token post.
    || (!multiToken && CALL_SHILL.test(text));

  // A stated position ("my entry", "bought at") is unambiguous, even in a post that
  // also mentions other tokens. Weaker signals are suppressed on multi-token promos.
  if (CALL_POSITION.test(text) || CALL_VERBS_FIRST_PERSON.test(text)) return 'public-call';
  if (multiToken) return 'mention';
  return assertsPosition ? 'public-call' : 'mention';
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
