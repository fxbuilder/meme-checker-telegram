/**
 * src/risk-intel.mjs
 * On-chain risk indicators via GoPlus (keyless, free tier).
 *
 * Provides: holders (count + top-10 concentration), tax, LP lock, dev/creator,
 * honeypot, mint/pause authority.
 *
 * HONESTY RULES (each one is a bug that was caught before shipping):
 *  1. Every field is tri-state: a real value, `null` when the provider did not
 *     report it, or `null` when the chain is unsupported. The renderer turns null
 *     into "Unavailable"/"Unsupported" and NEVER into 0, "No", or "Not Paid".
 *  2. GoPlus reports tax as "0" for a real 0% tax and omits the field entirely
 *     when it does not know (verified: Base omits buy_tax). Absent -> null.
 *  3. GoPlus returns `{code:1, result:{}}` for a well-formed address it has no
 *     record for. That is "no data", not an error and not a zero.
 *  4. Solana's payload has different fields than EVM: there is no buy_tax /
 *     sell_tax / is_honeypot. Tax is therefore null on Solana, not 0%.
 *  5. A provider failure must never surface as "safe" or "no risk". It becomes
 *     `status` on the block and the card says the data could not be checked.
 */
import { getChain } from './chains.mjs';

const GOPLUS_BASE = 'https://api.gopluslabs.io/api/v1';
const TIMEOUT_MS = 8_000;
const OK_TTL_MS = 60_000;
const FAIL_TTL_MS = 15_000;

const cache = new Map();

/** GoPlus reports percentages as fractional strings ("0.246" = 24.6%). */
function pct(value) {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  return n * 100;
}

/** A real 0 stays 0; absent/empty becomes null. */
function numOrNull(value) {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

/** GoPlus flags are "1"/"0" strings; anything else is unknown. */
function flag(value) {
  if (value === '1' || value === 1) return true;
  if (value === '0' || value === 0) return false;
  return null; // absent or unrecognised — never assume safe
}

/** Sum of `percent` over an array of GoPlus holder rows, as a percentage. */
function sumPercent(rows) {
  if (!Array.isArray(rows) || !rows.length) return null;
  const total = rows.reduce((s, r) => s + (Number(r?.percent) || 0), 0);
  return Number.isFinite(total) ? total * 100 : null;
}

/**
 * LP lock: GoPlus gives lp_holders rows for the LP token itself.
 * "Locked" means the row is marked is_locked=1 (burned or time-locked).
 * We report the share of LP held by locked/burned holders.
 */
function lpLockFrom(lpRows) {
  if (!Array.isArray(lpRows) || !lpRows.length) return null;
  const locked = lpRows.filter((r) => String(r?.is_locked) === '1');
  const lockedPct = sumPercent(locked);
  const totalPct = sumPercent(lpRows);
  if (lockedPct === null) return null;
  return {
    lockedPercentage: lockedPct,
    // Some pools report LP rows whose percents do not sum to 100; keep both so
    // the renderer never implies more precision than exists.
    coveredPercentage: totalPct,
  };
}

/** Dev / creator info. Present on EVM; Solana reports `creators`. */
function devFrom(row, kind) {
  if (kind === 'solana') {
    // An EMPTY creators array means the provider has no creator record. Returning
    // an object of nulls here would render as "Dev: Known", implying we found one.
    const creators = Array.isArray(row?.creators) ? row.creators : [];
    const first = creators[0];
    if (!first?.address) return null;
    return {
      address: first.address,
      balancePercentage: pct(first.percent),
    };
  }
  const creator = row?.creator_address;
  const owner = row?.owner_address;
  const creatorPct = pct(row?.creator_percent);
  if (!creator && !owner && creatorPct === null) return null;
  return {
    address: creator ?? null,
    ownerAddress: owner ?? null,
    balancePercentage: creatorPct,
  };
}

/**
 * Normalize a raw GoPlus row into our risk-intel shape.
 * Exported for testing.
 */
export function normalizeRisk(chainId, row) {
  const chain = getChain(chainId);
  if (!row || typeof row !== 'object') return null;
  const isSolana = chain?.kind === 'solana';

  const holdersRows = Array.isArray(row.holders) ? row.holders : [];
  const top10 = holdersRows.length ? holdersRows.slice(0, 10) : [];

  const out = {
    holders: {
      total: numOrNull(row.holder_count),
      top10Percentage: top10.length ? sumPercent(top10) : null,
      largestHolderPercentage: holdersRows.length ? pct(holdersRows[0]?.percent) : null,
    },
    // Tax genuinely does not exist as a concept in the Solana payload.
    tax: isSolana ? null : (() => {
      const buy = pct(row.buy_tax);
      const sell = pct(row.sell_tax);
      if (buy === null && sell === null) return null;
      return { buy, sell };
    })(),
    lpLock: lpLockFrom(row.lp_holders),
    dev: devFrom(row, chain?.kind),
    security: {
      honeypot: isSolana ? null : flag(row.is_honeypot),
      mintable: isSolana ? flag(row.mintable?.status) : flag(row.is_mintable),
      freezable: isSolana ? flag(row.freezable?.status) : null,
      canTakeBackOwnership: flag(row.can_take_back_ownership),
      hiddenOwner: flag(row.hidden_owner),
      openSource: flag(row.is_open_source),
      // Buy/sell must not be blocked; null when unreported.
      cannotSellAll: flag(row.cannot_sell_all),
    },
  };

  // If literally nothing came back, report no data rather than an all-null block
  // that could be mistaken for "checked and clean".
  const hasAny =
    out.holders.total !== null || out.holders.top10Percentage !== null ||
    out.tax !== null || out.lpLock !== null || out.dev !== null ||
    Object.values(out.security).some((v) => v !== null);
  return hasAny ? out : null;
}

/**
 * Fetch risk intel for one token.
 * Returns { status, data, detail }:
 *   'ok'          — data is the normalized block
 *   'unsupported' — this chain has no GoPlus coverage (a capability gap)
 *   'no-data'     — chain is covered but this token has no record
 *   'error'       — provider/transport failure. NOT evidence about the token.
 */
export async function fetchRisk(chainId, address, { fetchImpl = globalThis.fetch, timeoutMs = TIMEOUT_MS } = {}) {
  const chain = getChain(chainId);
  if (!chain || !chain.goplus) {
    return { status: 'unsupported', data: null, detail: `no risk data source for ${chainId}` };
  }
  if (typeof fetchImpl !== 'function') {
    return { status: 'error', data: null, detail: 'no fetch implementation' };
  }

  const ck = `risk:${chainId}:${address}`;
  const hit = cache.get(ck);
  if (hit && hit.expiresAt > Date.now()) return hit.result;

  const url = chain.goplus === 'solana'
    ? `${GOPLUS_BASE}/solana/token_security?contract_addresses=${encodeURIComponent(address)}`
    : `${GOPLUS_BASE}/token_security/${chain.goplusId}?contract_addresses=${encodeURIComponent(address)}`;

  let result;
  try {
    const res = await fetchImpl(url, {
      headers: { accept: 'application/json' },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (res.status === 429) {
      result = { status: 'error', data: null, detail: 'rate-limited' };
    } else if (!res.ok) {
      result = { status: 'error', data: null, detail: `http ${res.status}` };
    } else {
      const body = await res.json();
      const rows = body?.result ?? {};
      const row = rows[address] ?? rows[address.toLowerCase()] ?? Object.values(rows)[0];
      if (!row) {
        // code:1 + empty result is GoPlus's "I have no record", not a failure.
        result = { status: 'no-data', data: null, detail: `provider has no record (code ${body?.code})` };
      } else {
        const data = normalizeRisk(chainId, row);
        result = data
          ? { status: 'ok', data, detail: null }
          : { status: 'no-data', data: null, detail: 'record present but no usable fields' };
      }
    }
  } catch (err) {
    const timedOut = err?.name === 'TimeoutError' || err?.name === 'AbortError';
    result = { status: 'error', data: null, detail: timedOut ? 'timeout' : `transport: ${err?.message ?? err}` };
  }

  if (result.status !== 'no-data') {
    cache.set(ck, {
      result,
      expiresAt: Date.now() + (result.status === 'ok' ? OK_TTL_MS : FAIL_TTL_MS),
    });
  }
  return result;
}

/** Empty risk block for chains where nothing can be checked. */
export function emptyRisk() {
  return {
    holders: { total: null, top10Percentage: null, largestHolderPercentage: null },
    tax: null,
    lpLock: null,
    dev: null,
    security: {
      honeypot: null, mintable: null, freezable: null, canTakeBackOwnership: null,
      hiddenOwner: null, openSource: null, cannotSellAll: null,
    },
  };
}

export function clearRiskCache() {
  cache.clear();
}
