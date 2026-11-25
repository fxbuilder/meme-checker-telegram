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
import { getChain, ADDRESS_KIND } from './chains.mjs';
import { fetchRisk, emptyRisk } from './risk-intel.mjs';
import { fetchDexPaid } from './dex-paid.mjs';

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
 * Chain shape comes from the registry, so adding a chain does not need a code
 * change here. Solana base58 is case-sensitive; EVM is canonicalized lowercase.
 */
export function addressKey(chain, address) {
  if (typeof address !== 'string') return null;
  const def = getChain(chain);
  if (!def) return null;
  if (def.kind === 'solana') {
    return ADDRESS_KIND.solana.test(address) ? address : null;
  }
  if (def.kind === 'evm') {
    return ADDRESS_KIND.evm.test(address) ? address.toLowerCase() : null;
  }
  return null;
}

/** EVM addresses are case-insensitive; Solana base58 is case-sensitive. */
function sameAddress(chain, a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  return getChain(chain)?.kind === 'evm' ? a.toLowerCase() === b.toLowerCase() : a === b;
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
 * Pick the pair that best represents the token's real market price.
 *
 * Deepest-liquidity alone is NOT reliable: on BONK one Meteora pool holds $26M
 * liquidity (13x the next pool) but quotes a different asset, reporting a
 * $874B market cap against a true ~$200M everywhere else. Taking that pool as
 * primary would publish a materially wrong number.
 *
 * So: group the matching pairs by reported market cap, take the MEDIAN cap
 * (robust against the outliers that disagree), then choose the deepest pool
 * whose market cap sits closest to that median. Liquidity only breaks ties
 * inside the consistent cluster — identity is already fixed by matchingPairs.
 */
export function primaryPair(pairs) {
  if (!Array.isArray(pairs) || !pairs.length) return null;
  const withCap = pairs.filter((p) => Number.isFinite(num(p?.marketCap)));
  if (!withCap.length) {
    // No market caps reported: fall back to depth alone.
    return [...pairs].sort((a, b) => liquidityOf(b) - liquidityOf(a))[0] ?? null;
  }

  const caps = withCap.map((p) => num(p.marketCap)).sort((a, b) => a - b);
  const median = caps[Math.floor(caps.length / 2)];

  // Prefer pools within 3x of the median (generous, but rejects a 4000x outlier).
  const consistent = withCap.filter((p) => {
    const c = num(p.marketCap);
    return c > 0 && median > 0 && c <= median * 3 && c >= median / 3;
  });
  const pool = consistent.length ? consistent : withCap;
  return [...pool].sort((a, b) => liquidityOf(b) - liquidityOf(a))[0] ?? null;
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
  // Represent the age in whole years + remaining whole months using a 30.44-day
  // average month (365.25/12). The previous 365-day split produced "3y 12mo" and
  // "0y 11mo" at the year boundary; both came from mixing two different month
  // lengths in one calculation.
  const totalMonths = days >= 365
    ? Math.max(12, Math.round(days / 30.4375))
    : Math.floor(days / 30.4375);
  const years = Math.floor(totalMonths / 12);
  const months = totalMonths % 12;
  if (years === 0) return `${months}mo`;
  return months ? `${years}y ${months}mo` : `${years}y`;
}

/**
 * Token logo + chart URL, taken only from the provider payload.
 * `info.imageUrl` is a real CDN URL for the token; `pair.url` is the DEX page.
 * Both are validated before use — never synthesized.
 */
function mediaLinks(pairs, primary) {
  let logo = null;
  let header = null;
  let chart = null;
  // Image fields may appear on any matching pair, not only the deepest. Both are
  // read from the address-scoped payload, so they are bound to this exact
  // contract, never to a ticker match.
  for (const p of pairs) {
    if (!header) {
      const h = p?.info?.header;
      if (isAcceptableUrl(h)) header = h;
    }
    if (!logo) {
      const img = p?.info?.imageUrl;
      if (isAcceptableUrl(img)) logo = img;
    }
    if (header && logo) break;
  }
  const pairUrl = primary?.url;
  if (isAcceptableUrl(pairUrl)) chart = pairUrl;
  return { logo, header, chart };
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
  const media = mediaLinks(matched, primary);

  return {
    mode: 'live',
    status: 'ok',
    token: { chain, address, name, symbol, logo: media.logo },
    // Verified-image candidates for the Telegram card. `header` is a real banner
    // asset, not the web-UI mockup screenshot.
    media: { header: media.header, logo: media.logo },
    chartUrl: media.chart,
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
    // Risk + paid status start empty; liveScan fills them from their own sources
    // so a risk-provider failure can never affect the market read.
    risk: emptyRisk(),
    riskStatus: 'pending',
    dexPaid: { status: 'unknown', detail: 'not checked' },
    // Provenance for operators; the renderer ignores unknown keys.
    // `labels` carries the pool generation (v2/v3/v4) as DexScreener reports it. It is
    // needed downstream because V2 lp-supply maths is invalid for a v3/v4 position.
    source: {
      provider: 'dexscreener',
      pairs: matched.length,
      pairAddress: primary?.pairAddress ?? null,
      labels: Array.isArray(primary?.labels) ? primary.labels : null,
      dexId: primary?.dexId ?? null,
    },
  };
}

/**
 * Attach risk intel and Dex Paid status to an `ok` result.
 * Runs both sources in parallel. A failure in either degrades that block only.
 */
export async function enrichResult(result, { fetchImpl, riskFetch, paidFetch } = {}) {
  if (!result || result.status !== 'ok') return result;
  const { chain, address } = result.token;

  // The scan already knows which pair won, so LP intelligence can be read from that exact
  // pool contract instead of repeating the market lookup. `labels` carries v2/v3, which
  // decides whether V2 lp-supply maths is even valid for this pool.
  const pair = result.source?.pairAddress
    ? { pairAddress: result.source.pairAddress, labels: result.source.labels ?? null }
    : null;

  const [risk, paid] = await Promise.all([
    fetchRisk(chain, address, { fetchImpl: riskFetch ?? fetchImpl, pair }),
    fetchDexPaid(chain, address, { fetchImpl: paidFetch ?? fetchImpl }),
  ]);

  const out = { ...result, dexPaid: paid };

  // `status: 'ok'` promises usable data, but a defensive check costs nothing and a
  // null dereference here would take down an otherwise good scan.
  if (risk.status === 'ok' && risk.data) {
    out.risk = risk.data;
    out.riskStatus = 'ok';
    // The card's Holder Overview reads a flat shape; keep both in sync so the
    // quick-check block and the holder section can never disagree.
    const h = risk.data.holders ?? {};
    out.holders = {
      total: h.total ?? null,
      top10Percentage: h.top10Percentage ?? null,
      largestHolderPercentage: h.largestHolderPercentage ?? null,
    };
  } else {
    out.riskStatus = risk.status; // 'unsupported' | 'no-data' | 'error'
    out.riskDetail = risk.detail;
  }
  return out;
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
export async function liveScan(request, { fetchImpl, riskFetch, paidFetch, timeoutMs, baseUrl, nowMs, enrich = true } = {}) {
  const chain = request?.chain;
  const def = getChain(chain);
  if (!def) return { mode: 'live', status: 'invalid-response' };
  // Chain recognised but no data source covers it (e.g. story).
  // A capability gap is NOT "token not found" and must say so.
  if (!def.market) return { mode: 'live', status: 'chain-unsupported', chain };

  const key = addressKey(chain, request?.address);
  if (!key) return { mode: 'live', status: 'invalid-response' };

  const ck = cacheKey(chain, key) + (enrich ? '' : ':market');
  const hit = cache.get(ck);
  if (hit && hit.expiresAt > Date.now()) return hit.result;

  const fetched = await fetchTokenPairs({ chain, address: key }, { fetchImpl, timeoutMs, baseUrl });

  let result = fetched.status === 'ok'
    ? normalizePairs({ chain, address: key }, fetched.pairs, { nowMs })
    : { mode: 'live', status: fetched.status };

  // Enrich only a real hit. Market data must stand on its own if risk/paid fail.
  if (result.status === 'ok' && enrich) {
    result = await enrichResult(result, { riskFetch: riskFetch ?? fetchImpl, paidFetch: paidFetch ?? fetchImpl });
  }

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
