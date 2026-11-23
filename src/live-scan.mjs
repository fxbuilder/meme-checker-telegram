/**
 * src/live-scan.mjs
 * Live scan adapter — real token and market data for `SCAN_MODE=live`.
 *
 * SCOPE NOTE
 * This is NOT the Core Backend API. The Core contract (endpoint, auth, field
 * units, error codes) is still unconfirmed — see docs/backend-contract-checklist.md
 * — and the project rule is to never call a guessed live path. DexScreener's
 * public token-pairs endpoint is used instead because it is real, keyless and
 * address-scoped, which makes the CA scan flow genuinely functional today.
 * When Core is confirmed, replace `fetchTokenPairs` and keep `normalizePairs`;
 * the normalized shape is the scanner-to-card contract (docs/scan-result-contract.md).
 *
 * WHAT IS REAL HERE
 *   market (price, mcap, fdv, liquidity, volume 24h, price change 1h/24h, pair age)
 *   token identity (name, symbol)
 *   project links (website / X / Telegram) when the provider lists them
 *
 * WHAT IS DELIBERATELY null
 *   holders  — no keyless source. Public Solana RPC rejects
 *              `getTokenLargestAccounts` with 429 for every token, and
 *              `getProgramAccounts` returns 600 MB on a large mint. Reporting
 *              null is honest; reporting 0 would claim "measured, no holders".
 *   narrative — DexScreener pairs carry no description field (verified: info
 *              has only imageUrl/header/openGraph/websites/socials). The card
 *              prints "Narrative unavailable" rather than inventing a story.
 *   updatedAt — the provider publishes no observation timestamp, and freshness
 *              must never be synthesized.
 */
import { isAcceptableUrl } from './format-card.mjs';

const DEX_BASE = 'https://api.dexscreener.com/token-pairs/v1';
const DEFAULT_TIMEOUT_MS = 8_000;

/** Success cache is short because these are live prices. */
const OK_TTL_MS = 30_000;
/** Failure cache is shorter so a throttle sheds and recovers on its own. */
const FAIL_TTL_MS = 10_000;

const cache = new Map();

// ---------------------------------------------------------------------------
// Identity
// ---------------------------------------------------------------------------

/**
 * Validate an address for its chain and return the canonical form.
 * This is an identity/URL guard, not proof the address is a token.
 */
export function addressKey(chain, address) {
  if (typeof address !== 'string') return null;
  if (chain === 'solana' && /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(address)) return address;
  if (chain === 'bsc' && /^0x[0-9a-f]{40}$/i.test(address)) return address.toLowerCase();
  return null;
}

/** EVM addresses are case-insensitive; Solana base58 is case-sensitive. */
function sameAddress(chain, a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  return chain === 'bsc' ? a.toLowerCase() === b.toLowerCase() : a === b;
}

const num = (v) => {
  if (v === null || v === undefined || v === '') return null;
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : null;
};

// ---------------------------------------------------------------------------
// Provider call
// ---------------------------------------------------------------------------

/**
 * Fetch raw pairs for one token. Never throws.
 * Returns { status, pairs, httpStatus, detail }.
 *   status: 'ok' | 'rate-limited' | 'api-error' | 'invalid-response'
 * A 200 with `[]` is a real negative finding, not a failure.
 */
export async function fetchTokenPairs(
  { chain, address },
  { fetchImpl = globalThis.fetch, timeoutMs = DEFAULT_TIMEOUT_MS, baseUrl = DEX_BASE } = {},
) {
  const key = addressKey(chain, address);
  if (!key) return { status: 'invalid-response', pairs: [], httpStatus: null, detail: 'bad request identity' };
  if (typeof fetchImpl !== 'function') {
    return { status: 'api-error', pairs: [], httpStatus: null, detail: 'no fetch implementation' };
  }

  const url = `${baseUrl}/${chain}/${encodeURIComponent(key)}`;
  let res;
  try {
    res = await fetchImpl(url, {
      headers: { accept: 'application/json' },
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    const name = err?.name ?? '';
    const timedOut = name === 'TimeoutError' || name === 'AbortError';
    return {
      status: 'api-error',
      pairs: [],
      httpStatus: null,
      detail: timedOut ? `timeout after ${timeoutMs}ms` : `transport: ${err?.message ?? err}`,
    };
  }

  if (res.status === 429) {
    return { status: 'rate-limited', pairs: [], httpStatus: 429, detail: 'provider throttled' };
  }
  if (!res.ok) {
    return { status: 'api-error', pairs: [], httpStatus: res.status, detail: `http ${res.status}` };
  }

  let body;
  try {
    body = await res.json();
  } catch {
    return { status: 'invalid-response', pairs: [], httpStatus: res.status, detail: 'body is not JSON' };
  }
  if (!Array.isArray(body)) {
    return { status: 'invalid-response', pairs: [], httpStatus: res.status, detail: 'body is not an array' };
  }
  return { status: 'ok', pairs: body, httpStatus: res.status, detail: null };
}

// ---------------------------------------------------------------------------
// Normalization
// ---------------------------------------------------------------------------

/** Pairs where this exact contract is the base token. Identity before ranking. */
export function matchingPairs(chain, address, pairs) {
  if (!Array.isArray(pairs)) return [];
  return pairs.filter((p) => sameAddress(chain, p?.baseToken?.address, address));
}

const liquidityOf = (p) => num(p?.liquidity?.usd) ?? 0;

/**
 * The deepest pool is the most reliable read of a token's real market: pairs for
 * the same token disagree on price, and therefore on market cap (observed: 30
 * distinct market-cap values across BONK's pairs). Ranking by depth is not
 * identity selection — identity is already fixed by `matchingPairs`.
 */
export function primaryPair(pairs) {
  if (!Array.isArray(pairs) || !pairs.length) return null;
  return [...pairs].sort((a, b) => liquidityOf(b) - liquidityOf(a))[0] ?? null;
}

function pickUrl(value) {
  return isAcceptableUrl(value) ? value : null;
}

/** First usable project link across the token's pairs (info may appear on any). */
function projectLinks(pairs) {
  const out = { website: null, x: null, telegram: null };
  for (const p of pairs) {
    const info = p?.info;
    if (!info) continue;
    if (!out.website && Array.isArray(info.websites)) {
      for (const w of info.websites) {
        const u = pickUrl(w?.url);
        if (u) { out.website = u; break; }
      }
    }
    if (Array.isArray(info.socials)) {
      for (const s of info.socials) {
        const type = String(s?.type ?? '').toLowerCase();
        const u = pickUrl(s?.url);
        if (!u) continue;
        if (!out.x && (type === 'twitter' || type === 'x')) out.x = u;
        if (!out.telegram && type === 'telegram') out.telegram = u;
      }
    }
    if (out.website && out.x && out.telegram) break;
  }
  return out;
}

/** Human pair age from provider ms timestamp, e.g. "1y 11mo". Never invented. */
export function pairAge(createdAtMs, nowMs = Date.now()) {
  const created = num(createdAtMs);
  if (created === null || created <= 0 || created > nowMs) return null;
  const days = Math.floor((nowMs - created) / 86_400_000);
  if (days < 1) {
    const hours = Math.floor((nowMs - created) / 3_600_000);
    return hours < 1 ? '<1h' : `${hours}h`;
  }
  if (days < 30) return `${days}d`;
  if (days < 365) return `${Math.floor(days / 30)}mo`;
  const years = Math.floor(days / 365);
  const months = Math.floor((days % 365) / 30);
  return months ? `${years}y ${months}mo` : `${years}y`;
}

/**
 * Build the TOKEN_PAGE_BASE_URL-derived CTA. Same guard as mock mode: no
 * placeholder host, no credentials, and null when unset.
 */
function buildAnalysisUrl(chain, address) {
  const base = (process.env.TOKEN_PAGE_BASE_URL ?? '').replace(/\/$/, '').trim();
  if (!base) return null;
  try {
    const url = new URL(
      `/check/${chain}/${encodeURIComponent(address)}?utm_source=telegram&utm_medium=group_bot&utm_campaign=token_check`,
      base,
    );
    if (url.hostname.endsWith('.example') || url.hostname === 'example' || url.hostname === 'localhost' ||
        url.username || url.password) return null;
    return url.toString();
  } catch {
    return null;
  }
}

/**
 * Map a provider pairs array into the normalized scan contract.
 * `pairs` must already be the raw array from the provider.
 */
export function normalizePairs(request, pairs, { nowMs = Date.now() } = {}) {
  const chain = request?.chain;
  const address = addressKey(chain, request?.address);
  if (!address) return { mode: 'live', status: 'invalid-response' };

  if (!Array.isArray(pairs)) return { mode: 'live', status: 'invalid-response' };

  // No pairs at all: the provider genuinely has no record for this contract.
  if (pairs.length === 0) return { mode: 'live', status: 'not-found' };

  const matched = matchingPairs(chain, address, pairs);

  // Pairs came back but none carry this exact contract as base token.
  // That is an identity mismatch, never a "not found".
  if (!matched.length) return { mode: 'live', status: 'invalid-response' };

  const primary = primaryPair(matched);
  const base = primary?.baseToken ?? {};

  const name = typeof base.name === 'string' ? base.name.trim() : '';
  const symbol = typeof base.symbol === 'string' ? base.symbol.trim() : '';
  if (!name || !symbol) return { mode: 'live', status: 'invalid-response' };

  // marketCap and fdv are distinct. Never let FDV stand in for a missing cap.
  const marketCap = num(primary?.marketCap);
  const fdv = num(primary?.fdv);

  return {
    mode: 'live',
    status: 'ok',
    token: { chain, address, name, symbol },
    market: {
      priceUsd: num(primary?.priceUsd),
      marketCapUsd: marketCap,
      fdvUsd: fdv,
      liquidityUsd: num(primary?.liquidity?.usd),
      volume24hUsd: num(primary?.volume?.h24),
      priceChange24h: num(primary?.priceChange?.h24),
      priceChange1h: num(primary?.priceChange?.h1),
      pairAge: pairAge(primary?.pairCreatedAt, nowMs),
    },
    holders: { total: null, top10Percentage: null, largestHolderPercentage: null },
    narrative: null,
    project: projectLinks(matched),
    updatedAt: null,
    fullAnalysisUrl: buildAnalysisUrl(chain, address),
    // Provenance for operators; the renderer ignores unknown keys.
    source: { provider: 'dexscreener', pairs: matched.length, pairAddress: primary?.pairAddress ?? null },
  };
}

// ---------------------------------------------------------------------------
// Entry point used by src/scanner.mjs
// ---------------------------------------------------------------------------

const cacheKey = (chain, key) => `scan:${chain}:${key}`;

/**
 * liveScan({chain, address}) → normalized result.
 * Cached by (chain, address); failures are cached briefly so a throttle is not
 * re-hit by every message in a busy group.
 */
export async function liveScan(request, { fetchImpl, timeoutMs, baseUrl, nowMs } = {}) {
  const chain = request?.chain;
  const key = addressKey(chain, request?.address);
  if (!key) return { mode: 'live', status: 'invalid-response' };

  const ck = cacheKey(chain, key);
  const hit = cache.get(ck);
  if (hit && hit.expiresAt > Date.now()) return hit.result;

  const fetched = await fetchTokenPairs({ chain, address: key }, { fetchImpl, timeoutMs, baseUrl });

  const result = fetched.status === 'ok'
    ? normalizePairs({ chain, address: key }, fetched.pairs, { nowMs })
    : { mode: 'live', status: fetched.status };

  const isOk = result.status === 'ok';
  if (isOk || fetched.status === 'rate-limited' || fetched.status === 'api-error') {
    cache.set(ck, { result, expiresAt: Date.now() + (isOk ? OK_TTL_MS : FAIL_TTL_MS) });
  }
  return result;
}

/** Test/ops helper. */
export function clearLiveCache() {
  cache.clear();
}
