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
import { fetchRugCheck } from './security/rugcheck.mjs';
import { securityFromTokenInfo, hasUsableSecurity } from './security/geckoterminal-security.mjs';
import { readV2Liquidity, mergeLpIntel } from './security/lp-intel.mjs';
import { fetchTokenInfo, gtSupportsChain } from './research/geckoterminal.mjs';

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
 * Addresses that are holders on paper but do not represent a real concentration risk.
 * Excluding them is what keeps a Top-10 figure meaningful; the LP pool in particular
 * can hold most of the supply and would otherwise dominate the number.
 */
const BURN_ADDRESSES = new Set([
  '0x0000000000000000000000000000000000000000',
  '0x000000000000000000000000000000000000dead',
  // Solana incinerator
  '1incinertwvfzyqtqkgnrf8dhprwmhzwjmtuwzqhrs',
]);

function isBurnAddress(addr) {
  const a = String(addr ?? '').trim().toLowerCase();
  return a.length > 0 && BURN_ADDRESSES.has(a);
}

/**
 * Holder concentration over the top N REAL holders.
 *
 * WHY THIS IS NOT A SIMPLE SUM. The OWNER saw `Top 10: 111.1%` on a real token, which
 * is an impossible figure for a consistent, non-overlapping denominator. Three
 * distinct causes produce it, and each needs its own handling:
 *
 *   1. DUPLICATE ROWS - the provider can list the same address twice. A duplicate
 *      inflates the sum while adding no information, so rows are de-duplicated by
 *      address.
 *   2. NON-HOLDER ACCOUNTS - the LP pool, burn addresses and the token contract itself
 *      hold balances that are not "someone controlling supply". The LP share in
 *      particular can be the single largest line.
 *   3. INCONSISTENT DENOMINATORS - some providers report a holder's share of
 *      circulating supply while others use total supply, so rows are not guaranteed to
 *      be mutually comparable.
 *
 * After 1 and 2 the total is normally < 100%. If it is STILL above 100%, the rows
 * cannot be reconciled into a concentration reading and the honest answer is null
 * ("unknown"), never a clamped 100% - clamping would present an invalid measurement as
 * a genuine risk score.
 *
 * @returns {{percentage:number|null, counted:number, excluded:number, reason?:string}}
 */
export function holderConcentration(rows, { top = 10, exclude = [], excludeBurn = true } = {}) {
  if (!Array.isArray(rows) || !rows.length) {
    return { percentage: null, counted: 0, excluded: 0, reason: 'no-holder-rows' };
  }

  // Normalise the exclusion set: pools, the token contract, any caller-supplied
  // non-holder account. Case-insensitive because EVM addresses are.
  const excluded = new Set(
    [...exclude].filter(Boolean).map((a) => String(a).trim().toLowerCase()),
  );

  const seen = new Set();
  const kept = [];
  let excludedCount = 0;

  // Rows may legitimately lack an address: GoPlus does not always include one, and
  // dropping those rows silently deleted real concentration data (a valid 60% became
  // "unknown"). An address-less row can still be EXCLUDED by position - when a caller
  // names the LP pool - but it must otherwise be counted. It simply cannot be
  // de-duplicated, because we have no identity to compare.
  rows.forEach((r, index) => {
    const p = Number(r?.percent);
    if (!Number.isFinite(p) || p < 0) { excludedCount += 1; return; }

    const addr = String(r?.address ?? '').trim().toLowerCase();
    if (!addr) {
      kept.push({ addr: null, percent: p, index });
      return;
    }
    if (excluded.has(addr)) { excludedCount += 1; return; }
    if (excludeBurn && isBurnAddress(addr)) { excludedCount += 1; return; }
    // Cause 1: the same account listed twice.
    if (seen.has(addr)) { excludedCount += 1; return; }
    seen.add(addr);
    kept.push({ addr, percent: p, index });
  });

  const topRows = kept.slice(0, top);
  if (!topRows.length) {
    return { percentage: null, counted: 0, excluded: excludedCount, reason: 'all-rows-excluded' };
  }

  const total = topRows.reduce((acc, r) => acc + r.percent, 0) * 100;

  // Cause 3: even after cleaning, an impossible total means the rows are mutually
  // inconsistent. Report unknown and keep the diagnostic rather than inventing a value.
  if (!Number.isFinite(total) || total > 100.5) {
    return {
      percentage: null,
      counted: topRows.length,
      excluded: excludedCount,
      reason: 'inconsistent-denominator',
      rawTotal: Number.isFinite(total) ? Number(total.toFixed(2)) : null,
    };
  }

  return {
    percentage: Number(Math.max(0, total).toFixed(2)),
    counted: topRows.length,
    excluded: excludedCount,
  };
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

/**
 * Dev / creator info.
 *
 * FOUR DIFFERENT THINGS are reported by providers under similar names, and conflating
 * them produces a false risk verdict:
 *
 *   creator            the address that minted the token. The original author.
 *   developer holding   the creator's CURRENT token balance, as % of supply.
 *   owner / authority   who controls the contract or mint right now. Not the author.
 *   metadata authority  who can update the token's name/symbol/URI. Not the author.
 *
 * `role` records which one a value actually is, so the renderer can label it honestly
 * instead of calling every address "Creator".
 *
 * Solana note: `creators[].percent` on a Metaplex record is that creator's share of
 * ROYALTIES, not a share of the token supply. Treating it as a holding would invent a
 * percentage, so it is never used as `balancePercentage`.
 */
function devFrom(row, kind) {
  if (kind === 'solana') {
    // An EMPTY creators array means the provider has no creator record. Returning an
    // object of nulls here would render as "Dev: Known", implying we found one.
    const creators = Array.isArray(row?.creators) ? row.creators : [];
    const first = creators[0];
    if (!first?.address) return null;
    return {
      address: first.address,
      role: 'creator',
      // Deliberately null: see the royalty-share note above. A real holding figure for
      // Solana comes from RugCheck's creatorBalance, which is a token balance.
      balancePercentage: null,
      verifiedCreator: first.verified === true ? true : (first.verified === false ? false : null),
    };
  }

  const creator = row?.creator_address;
  const owner = row?.owner_address;
  const creatorPct = pct(row?.creator_percent);

  if (!creator && !owner && creatorPct === null) return null;

  // When the provider supplies a holding percentage it is the CREATOR's share. If only
  // an owner is known, the address is an owner with no creator identity, so it is
  // labelled accordingly and no holding is claimed.
  const hasCreator = Boolean(creator);
  return {
    address: creator ?? owner ?? null,
    role: hasCreator ? 'creator' : 'owner',
    ownerAddress: owner ?? null,
    balancePercentage: hasCreator ? creatorPct : null,
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

  // The LP pool and the token contract itself appear in holder lists but are not
  // accounts "controlling" supply. Excluding them is what makes a concentration
  // figure meaningful, and it is also the main reason a raw sum could exceed 100%.
  const lpAddresses = Array.isArray(row.lp_holders)
    ? row.lp_holders.map((r) => r?.address).filter(Boolean)
    : [];

  const concentration = holderConcentration(holdersRows, {
    top: 10,
    exclude: [row.owner_address, row.creator_address, ...lpAddresses],
  });

  const out = {
    holders: {
      total: numOrNull(row.holder_count),
      // null means "cannot be reconciled", which the card renders as unknown rather
      // than as a percentage. A clamped 100% would be a fabricated reading.
      top10Percentage: concentration.percentage,
      largestHolderPercentage: holdersRows.length ? pct(holdersRows[0]?.percent) : null,
      // Diagnostic kept so an operator can see WHY a figure was withheld.
      concentrationReason: concentration.reason ?? null,
      concentrationCounted: concentration.counted,
      concentrationExcluded: concentration.excluded,
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
 * Merge a fallback security source into a primary one, FIELD BY FIELD.
 *
 * WHY FIELD-LEVEL AND NOT PROVIDER-LEVEL: the BONK card showed `Tax: —`, `LP Locked: —`
 * and `Creator Holds: —` because GoPlus's Solana payload simply does not carry those
 * three. Falling back only when the WHOLE provider fails would have left them empty;
 * taking the fallback wholesale would have thrown away GoPlus's holder total.
 *
 * A primary value is never overwritten. Only nulls are filled, so a measured 0 stays 0
 * and a measured lock percentage is not replaced by another vendor's methodology.
 */
export function mergeRisk(primary, fallback) {
  // A fallback-only result still needs the full shape: callers read holders/security
  // unconditionally, so returning the raw provider object would throw.
  if (!primary) {
    if (!fallback) return null;
    return {
      ...fallback,
      holders: { ...(fallback.holders ?? {}) },
      security: { ...(fallback.security ?? {}) },
      tax: fallback.tax ?? null,
      lpLock: fallback.lpLock ?? null,
      dev: fallback.dev ?? null,
      sources: { ...(fallback.sources ?? {}), primary: 'none', fallback: fallback.source ?? null },
    };
  }
  if (!fallback) return primary;

  const out = {
    holders: { ...(primary.holders ?? {}) },
    security: { ...(primary.security ?? {}) },
    tax: primary.tax ?? fallback.tax ?? null,
    lpLock: primary.lpLock ?? fallback.lpLock ?? null,
    // A block WITH a measured holding outranks one that only names an address,
    // regardless of which provider supplied it. Otherwise a fallback that knows the
    // creator's address but not the balance would erase a real percentage.
    dev: (() => {
      const a = primary.dev;
      const b = fallback.dev;
      if (!a) return b ?? null;
      if (!b) return a;
      if (a.balancePercentage != null) return a;
      if (b.balancePercentage != null) return { ...b, address: b.address ?? a.address };
      return a;
    })(),
    // Record where each block came from, so the UI can be precise.
    sources: { ...(primary.sources ?? {}) },
  };

  // Holders: fill each field independently.
  const fbH = fallback.holders ?? {};
  for (const k of ['total', 'top10Percentage', 'largestHolderPercentage']) {
    if (out.holders[k] === null || out.holders[k] === undefined) {
      if (fbH[k] !== null && fbH[k] !== undefined) out.holders[k] = fbH[k];
    }
  }
  // Provider-reported vs independently verified concentration must be distinguishable.
  if (out.holders.top10Percentage !== null && primary.holders?.top10Percentage == null) {
    out.holders.concentrationSource = 'rugcheck';
  } else if (out.holders.top10Percentage !== null) {
    out.holders.concentrationSource = 'goplus';
  }

  const fbS = fallback.security ?? {};
  for (const k of Object.keys(fbS)) {
    if (out.security[k] === null || out.security[k] === undefined) {
      if (fbS[k] !== null && fbS[k] !== undefined) out.security[k] = fbS[k];
    }
  }

  out.sources = {
    ...(primary.sources ?? {}),
    // Only claim the fallback for blocks it actually supplied.
    ...(primary.tax == null && fallback.tax ? { tax: fallback.source } : {}),
    ...(primary.lpLock == null && fallback.lpLock ? { lpLock: fallback.source } : {}),
    ...(primary.dev == null && fallback.dev ? { dev: fallback.source } : {}),
    ...(primary.holders?.top10Percentage == null && fallback.holders?.top10Percentage != null
      ? { holders: fallback.source } : {}),
  };

  return out;
}

/**
 * Fetch risk intel for one token.
 * Returns { status, data, detail }:
 *   'ok'          — data is the normalized block
 *   'unsupported' — this chain has no GoPlus coverage (a capability gap)
 *   'no-data'     — chain is covered but this token has no record
 *   'error'       — provider/transport failure. NOT evidence about the token.
 */
export async function fetchRisk(chainId, address, {
  fetchImpl = globalThis.fetch, timeoutMs = TIMEOUT_MS,
  /**
   * The pair the market scan already identified, when the caller has one.
   *
   * LP lock state is not reported by any keyless aggregator for most EVM chains, so it is
   * read from the pair contract itself. Passing the pair here is what makes that possible
   * without a second market lookup.
   */
  pair = null,
} = {}) {
  const chain = getChain(chainId);
  if (!chain) {
    return { status: 'unsupported', data: null, detail: `unknown chain ${chainId}` };
  }
  if (typeof fetchImpl !== 'function') {
    return { status: 'error', data: null, detail: 'no fetch implementation' };

  }

  // A chain with NO primary provider is not the end of the story: GeckoTerminal may
  // still supply concentration and authority flags. Returning 'unsupported' here - as
  // this function used to - skipped every fallback, which is why HyperEVM and MegaETH
  // always reported nothing even though GeckoTerminal covers them.
  if (!chain.goplus) {
    return fetchFallbackRisk(chainId, address, { fetchImpl, timeoutMs });
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

  // ---- Second fallback: GeckoTerminal's embedded security fields ----------
  // This endpoint is ALREADY fetched for narrative on most scans, and its token-info
  // payload carries holder concentration, authorities and a honeypot flag that we were
  // discarding. On chains with no GoPlus coverage it is the only keyless source of
  // concentration, and it costs nothing extra where narrative already ran.
  //
  // It is consulted when the chain has no GoPlus coverage OR GoPlus returned nothing
  // usable - never as a replacement for a provider that actually answered.
  const needsGt = !chain.goplus || result.status !== 'ok';
  if (needsGt && gtSupportsChain(chainId)) {
    try {
      const gt = await fetchTokenInfo(chainId, address, { fetchImpl });
      const block = gt?.status === 'ok' ? securityFromTokenInfo(gt.token?._attributes ?? null) : null;
      // fetchTokenInfo normalises away the raw attributes, so fall back to its token
      // shape when the raw block is unavailable.
      const fallbackBlock = block ?? (gt?.status === 'ok' ? securityFromTokenInfo({
        holders: gt.token?.holders ?? null,
        mint_authority: gt.token?.mintAuthority ?? undefined,
        freeze_authority: gt.token?.freezeAuthority ?? undefined,
        is_honeypot: gt.token?.isHoneypot ?? undefined,
        developer_address: gt.token?.developerAddress ?? null,
        developer_holding_percentage: gt.token?.developerHoldingPercentage ?? null,
      }) : null);

      if (hasUsableSecurity(fallbackBlock)) {
        const primary = result.status === 'ok' ? result.data : null;
        const merged = mergeRisk(primary, fallbackBlock);
        if (merged) result = { status: 'ok', data: merged, detail: result.detail ?? null };
      }
    } catch {
      // A fallback that throws is not a reason to fail the whole check.
    }
  }

  // ---- On-chain LP intelligence (EVM) ------------------------------------
  // Only attempted when the provider gave nothing conclusive about LP state, and only
  // for a V2-style pair, because V2 lp-supply maths does not apply to V3/V4 positions.
  if (chain.kind === 'evm' && chain.rpc && pair?.pairAddress) {
    const alreadyKnown = result.status === 'ok' && result.data?.lpLock
      && (result.data.lpLock.burnedPercentage != null || result.data.lpLock.lockedPercentage != null);
    if (!alreadyKnown) {
      try {
        const reading = await readV2Liquidity({
          chain: chainId,
          pairAddress: pair.pairAddress,
          rpc: chain.rpc,
          labels: pair.labels ?? null,
          fetchImpl,
          timeoutMs,
        });

        // A V3/V4 position is a KNOWN-UNSUPPORTED type, not an unknown value. Recorded so
        // the card can say why rather than showing an unexplained dash.
        if (reading.state === 'unsupported-position-type') {
          const baseData = result.status === 'ok' ? result.data : (result.data ?? {});
          result = {
            status: result.status === 'ok' ? 'ok' : result.status,
            data: {
              ...baseData,
              lpLock: { ...(baseData?.lpLock ?? {}), positionType: 'v3-v4', positionTypeDetail: reading.detail },
            },
            detail: result.detail ?? null,
          };
        } else if (reading.state !== 'unknown') {
          const merged = mergeLpIntel(result.status === 'ok' ? result.data?.lpLock : null, reading);
          if (result.status === 'ok') {
            result = {
              status: 'ok',
              data: { ...result.data, lpLock: merged },
              detail: result.detail ?? null,
            };
          } else {
            // No provider block at all: an on-chain burn is still real evidence and is
            // enough to populate the field honestly.
            result = {
              status: 'ok',
              data: {
                holders: { total: null, top10Percentage: null, largestHolderPercentage: null },
                security: {},
                tax: null,
                lpLock: merged,
                dev: null,
                sources: { lpLock: 'onchain-v2' },
              },
              detail: result.detail ?? null,
            };
          }
        }
      } catch {
        // An LP read that throws is not a reason to lose the rest of the risk report.
      }
    }
  }

  // ---- Field-level fallback for Solana -----------------------------------
  // GoPlus's Solana payload has no transfer fee, no LP-lock figure and no creator
  // BALANCE, which is exactly the trio the owner saw as dashes. RugCheck supplies all
  // three from on-chain state, free and keyless. The merge fills only the gaps.
  if (chain.goplus === 'solana') {
    const rc = await fetchRugCheck(address, { fetchImpl });
    if (rc.status === 'ok' && rc.data) {
      const primary = result.status === 'ok' ? result.data : null;
      const merged = mergeRisk(primary, rc.data);
      if (merged) {
        result = { status: 'ok', data: merged, detail: result.detail ?? null };
      }
    } else if (result.status !== 'ok') {
      // GoPlus failed entirely but RugCheck works: RugCheck alone is a real answer.
      result = { status: 'ok', data: rc.data, detail: `goplus ${result.status}; rugcheck ok` };
    }
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

/**
 * Risk lookup using only non-GoPlus sources.
 *
 * Used for chains GoPlus does not cover. GeckoTerminal's token-info endpoint carries
 * holder concentration, mint/freeze authority and a honeypot flag, so "no GoPlus" is
 * frequently not "no data". If it yields nothing usable the chain genuinely has no
 * source and the caller gets an honest 'unsupported'.
 */
async function fetchFallbackRisk(chainId, address, { fetchImpl, timeoutMs }) {
  const ck = `risk:${chainId}:${address}`;
  const hit = cache.get(ck);
  if (hit && hit.expiresAt > Date.now()) return hit.result;

  let result = { status: 'unsupported', data: null, detail: `no risk data source for ${chainId}` };

  if (gtSupportsChain(chainId)) {
    try {
      const gt = await fetchTokenInfo(chainId, address, { fetchImpl, timeoutMs });
      if (gt?.status === 'ok') {
        const block = securityFromTokenInfo({
          holders: gt.token?.holders ?? null,
          mint_authority: gt.token?.mintAuthority,
          freeze_authority: gt.token?.freezeAuthority,
          is_honeypot: gt.token?.isHoneypot,
          developer_address: gt.token?.developerAddress ?? null,
          developer_holding_percentage: gt.token?.developerHoldingPercentage ?? null,
        });
        if (hasUsableSecurity(block)) {
          result = { status: 'ok', data: mergeRisk(null, block), detail: 'geckoterminal only' };
        } else {
          result = { status: 'no-data', data: null, detail: 'geckoterminal returned no security fields' };
        }
      } else if (gt?.status === 'not-found') {
        result = { status: 'no-data', data: null, detail: 'no token record' };
      } else {
        result = { status: 'error', data: null, detail: gt?.status ?? 'provider-error' };
      }
    } catch (err) {
      result = { status: 'error', data: null, detail: String(err?.message ?? err) };
    }
  }

  cache.set(ck, {
    result,
    expiresAt: Date.now() + (result.status === 'ok' ? OK_TTL_MS : FAIL_TTL_MS),
  });
  return result;
}
