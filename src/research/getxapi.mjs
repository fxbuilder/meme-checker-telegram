/**
 * src/research/getxapi.mjs
 * GetXAPI adapter — the recovered, primary X search backend.
 *
 * RECOVERED FROM E:\Projects\Onchain-Intelligence-Scanner (read-only), commit 9ca3db5
 * "feat(x): add GetXAPI as a second live search provider, behind a real spend guard".
 * The wire contract below is copied from that implementation, not guessed:
 *
 *   GET  {BASE}/twitter/tweet/advanced_search
 *        ?q=<query>&product=Latest|cursor=<next>
 *        Authorization: Bearer <GETXAPI_KEY>
 *        Accept: application/json
 *   ->   { tweets: [...], has_more, next_cursor, tweet_count }
 *
 *   GET  {BASE}/twitter/user/info?userName=<handle>
 *        same auth              -> { data: { userName, name, ... } }
 *
 * Env var name: `GETXAPI_KEY` (exactly that — verified in that repo's source and
 * its diagnostics route). An optional `GETXAPI_BASE_URL` overrides the host.
 *
 * PUBLISHED COST: $0.001 per standard search call, so one page is one cent and the
 * cost of a search is knowable before it is spent. That figure comes from the
 * existing project's committed constant, and is re-exported rather than re-invented.
 *
 * READ-ONLY BY CONSTRUCTION
 * GetXAPI also exposes create/delete/like/retweet/follow/DM endpoints. None are
 * reachable from this module: the host is a constant, only the two read paths above
 * are ever built, and no parameter can assemble a mutating path. That is stronger
 * than a comment promising restraint.
 *
 * WHAT IT NEVER DOES
 * It does not invent a field. A missing metric is null, `containsContract` is
 * computed from the post's own text, and identity is never inferred from a ticker.
 */

const DEFAULT_BASE_URL = 'https://api.getxapi.com';
const SEARCH_PATH = '/twitter/tweet/advanced_search';
const USER_INFO_PATH = '/twitter/user/info';
const TIMEOUT_MS = 12_000;

/** Published per-request price, from the existing project's committed constant. */
export const GETXAPI_COST_PER_REQUEST_USD = 0.001;

export function getxapiKey(env = process.env) {
  const k = env.GETXAPI_KEY;
  return typeof k === 'string' && k.trim().length > 0 ? k.trim() : null;
}

export function getxapiBaseUrl(env = process.env) {
  const v = env.GETXAPI_BASE_URL;
  return typeof v === 'string' && v.trim() ? v.trim().replace(/\/+$/, '') : DEFAULT_BASE_URL;
}

export function getxapiConfigured(env = process.env) {
  return getxapiKey(env) !== null;
}

/** Reported instead of the value, so presence can be confirmed without disclosure. */
export function getxapiKeyLength(env = process.env) {
  return getxapiKey(env)?.length ?? 0;
}

/** The search URL this module can build. Exported for diagnostics. */
export function getxapiSearchEndpoint(env = process.env) {
  return `${getxapiBaseUrl(env)}${SEARCH_PATH}`;
}

/**
 * Classify a failure so the caller can tell the states apart.
 * 401/403 are credential problems; 429 is a throttle; everything else is generic.
 */
export function classifyHttpFailure(status, body = '') {
  const text = String(body ?? '').slice(0, 300);
  if (status === 401) return { status: 'unauthorized', detail: 'the API key was rejected' };
  if (status === 403) return { status: 'forbidden', detail: 'the key is present but not permitted' };
  if (status === 429) return { status: 'rate-limited', detail: 'provider throttled the request' };
  if (status === 402) return { status: 'payment-required', detail: 'the provider account has no credit' };
  if (status >= 500) return { status: 'provider-error', detail: `provider ${status}` };
  return { status: 'provider-error', detail: `http ${status}${text ? `: ${text}` : ''}` };
}

/**
 * Search X for one token, one page.
 *
 * One request per call, deliberately: the provider bills per request and the free
 * allowance is finite, so pagination is the caller's explicit decision.
 *
 * @returns {Promise<{status:string, tweets?:Array, requests:number, nextCursor?:string|null, tweetCount?:number}>}
 */
export async function searchWithGetXApi({
  query,
  product = 'Latest',
  cursor = null,
  fetchImpl = globalThis.fetch,
  timeoutMs = TIMEOUT_MS,
  env = process.env,
} = {}) {
  const key = getxapiKey(env);
  if (!key) return { status: 'not-configured', requests: 0 };
  if (typeof fetchImpl !== 'function') return { status: 'provider-error', detail: 'no fetch', requests: 0 };
  const q = String(query ?? '').trim();
  if (!q) return { status: 'provider-error', detail: 'empty query', requests: 0 };

  const url = new URL(`${getxapiBaseUrl(env)}${SEARCH_PATH}`);
  url.searchParams.set('q', q);
  url.searchParams.set('product', product);
  if (cursor) url.searchParams.set('cursor', cursor);

  try {
    const res = await fetchImpl(url.toString(), {
      method: 'GET',
      headers: { Authorization: `Bearer ${key}`, Accept: 'application/json' },
      signal: AbortSignal.timeout(timeoutMs),
      cache: 'no-store',
    });

    // Read the body even on failure: the provider bills on attempt, and its error
    // text is what makes a key problem diagnosable.
    const body = await res.text();
    if (!res.ok) {
      return { ...classifyHttpFailure(res.status, body), requests: 1 };
    }

    let parsed;
    try {
      parsed = JSON.parse(body);
    } catch {
      return { status: 'provider-error', detail: 'provider returned non-JSON', requests: 1 };
    }

    const tweets = Array.isArray(parsed?.tweets) ? parsed.tweets : [];
    return {
      status: 'ok',
      tweets,
      requests: 1,
      nextCursor: parsed?.next_cursor ?? null,
      tweetCount: typeof parsed?.tweet_count === 'number' ? parsed.tweet_count : tweets.length,
    };
  } catch (err) {
    const timedOut = err?.name === 'TimeoutError' || err?.name === 'AbortError';
    return { status: timedOut ? 'timeout' : 'provider-error', detail: String(err?.message ?? err), requests: 1 };
  }
}

/**
 * Look up one account. Used to confirm a handle exists before reporting on it, and
 * to get the stable author identity rather than trusting a display name.
 */
export async function userInfoWithGetXApi({ userName, fetchImpl = globalThis.fetch, timeoutMs = TIMEOUT_MS, env = process.env } = {}) {
  const key = getxapiKey(env);
  if (!key) return { status: 'not-configured', requests: 0 };
  const handle = String(userName ?? '').replace(/^@/, '').trim();
  if (!handle) return { status: 'provider-error', detail: 'no handle', requests: 0 };

  const url = new URL(`${getxapiBaseUrl(env)}${USER_INFO_PATH}`);
  url.searchParams.set('userName', handle);
  try {
    const res = await fetchImpl(url.toString(), {
      method: 'GET',
      headers: { Authorization: `Bearer ${key}`, Accept: 'application/json' },
      signal: AbortSignal.timeout(timeoutMs),
      cache: 'no-store',
    });
    const body = await res.text();
    if (!res.ok) return { ...classifyHttpFailure(res.status, body), requests: 1 };
    let parsed;
    try { parsed = JSON.parse(body); } catch { return { status: 'provider-error', detail: 'non-JSON', requests: 1 }; }
    const d = parsed?.data ?? parsed;
    if (!d?.userName && !d?.screen_name) return { status: 'not-found', requests: 1 };
    return {
      status: 'ok',
      user: {
        handle: d.userName ?? d.screen_name,
        name: d.name ?? null,
        followers: Number.isFinite(Number(d.followers)) ? Number(d.followers) : null,
        verified: typeof d.isBlueVerified === 'boolean' ? d.isBlueVerified : null,
      },
      requests: 1,
    };
  } catch (err) {
    const timedOut = err?.name === 'TimeoutError' || err?.name === 'AbortError';
    return { status: timedOut ? 'timeout' : 'provider-error', detail: String(err?.message ?? err), requests: 1 };
  }
}
