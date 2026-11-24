/**
 * src/security/rugcheck.mjs
 * RugCheck.xyz — free, keyless Solana security data.
 *
 * WHY THIS EXISTS: GoPlus's Solana payload genuinely does not carry a transfer fee, a
 * real LP-lock figure, or the creator's CURRENT balance, which is why the BONK card
 * showed `Tax: —`, `LP Locked: —`, `Creator Holds: —`. RugCheck answers all three from
 * the on-chain state it indexes, with no key and no cost.
 *
 *   GET https://api.rugcheck.xyz/v1/tokens/{mint}/report
 *     -> creator, creatorBalance, token{supply,decimals}, transferFee{pct,maxAmount,authority},
 *        mintAuthority, freezeAuthority, rugged, lockers{...}, lockerScanStatus,
 *        markets[].lp{lpMint,lpLockedPct,lpTotalSupply,lpLocked}, topHolders[], totalHolders,
 *        token_extensions
 *
 * FIELD SEMANTICS THAT MATTER (verified against real payloads):
 *   - creatorBalance is in RAW token units; it must be divided by 10^decimals before it
 *     means anything. Reporting the raw integer as a percentage would be catastrophically
 *     wrong.
 *   - transferFee.pct is a percentage, and is 0 both for "legacy SPL token, no fee
 *     concept" and for "Token-2022 with the fee set to zero". The token PROGRAM decides
 *     which of those two statements is true, so the caller must not interpret 0 without
 *     it - that is why `standard` is returned alongside.
 *   - lpMint === the system program (1111...1111) means the LP mint was DESTROYED. That is
 *     burned liquidity, which is stronger than a lock, not the absence of one.
 */

const BASE = 'https://api.rugcheck.xyz/v1';
const TIMEOUT_MS = 12_000;
const OK_TTL_MS = 10 * 60_000;
const FAIL_TTL_MS = 2 * 60_000;
const SYSTEM_PROGRAM = '11111111111111111111111111111111';

/** Token programs, so the "standard" claim is derived rather than assumed. */
const TOKEN_PROGRAM = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
const TOKEN_2022_PROGRAM = 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb';

const cache = new Map();

export function clearRugCheckCache() {
  cache.clear();
}

/** True only for a Solana base58 mint; RugCheck is Solana-only. */
export function isSolanaMint(address) {
  return typeof address === 'string' && /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(address);
}

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/**
 * Burned vs locked LP, from the pool records.
 *
 * Returns null when there are no markets at all: "no pool found" is not "LP unlocked".
 */
export function lpFromMarkets(markets) {
  if (!Array.isArray(markets) || !markets.length) return null;

  let burnedSupply = 0;
  let totalSupply = 0;
  let sawAny = false;
  let maxLockedPct = 0;

  for (const m of markets) {
    const lp = m?.lp;
    if (!lp) continue;
    sawAny = true;

    const supply = num(lp.lpTotalSupply) ?? 0;
    // A destroyed LP mint cannot be unlocked by anyone: treat its supply as burned.
    if (lp.lpMint === SYSTEM_PROGRAM) {
      burnedSupply += supply;
      continue;
    }
    const lockedPct = num(lp.lpLockedPct) ?? 0;
    if (lockedPct > maxLockedPct) maxLockedPct = lockedPct;
    totalSupply += supply;
  }

  if (!sawAny) return null;

  const grand = burnedSupply + totalSupply;
  const burnedPct = grand > 0 ? (burnedSupply / grand) * 100 : null;
  // Locked percentage is the provider's own per-pool figure; the deepest pool decides,
  // which is what `maxLockedPct` already captures.
  const lockedPct = totalSupply > 0 ? maxLockedPct : null;
  const securedPct = (burnedPct ?? 0) + (lockedPct ?? 0);

  return {
    burnedPct: burnedPct === null ? null : Number(burnedPct.toFixed(2)),
    lockedPct: lockedPct === null ? null : Number(lockedPct.toFixed(2)),
    // Any at-or-near-full securing means liquidity cannot be pulled.
    securedPct: Number(Math.min(100, securedPct).toFixed(2)),
    state: securedPct >= 99 ? 'burned-or-locked'
      : securedPct >= 50 ? 'partially-secured'
        : securedPct > 0 ? 'mostly-unlocked' : 'unlocked',
    poolsScanned: markets.filter((m) => m?.lp).length,
  };
}

/** Top-10 concentration over real holders, excluding burn/system accounts. */
export function holdersFromTop(topHolders, { total = null, top = 10 } = {}) {
  if (!Array.isArray(topHolders) || !topHolders.length) {
    return { top10Percentage: null, largestHolderPercentage: null, total, counted: 0 };
  }
  const exclude = new Set([SYSTEM_PROGRAM]);
  const seen = new Set();
  const kept = [];
  for (const h of topHolders) {
    const addr = String(h?.address ?? '');
    if (!addr || exclude.has(addr) || seen.has(addr)) continue;
    const pct = num(h.pct);
    if (pct === null || pct < 0) continue;
    seen.add(addr);
    kept.push({ addr, pct, insider: h.insider === true });
  }
  kept.sort((a, b) => b.pct - a.pct);
  if (!kept.length) return { top10Percentage: null, largestHolderPercentage: null, total, counted: 0 };

  const sum = kept.slice(0, top).reduce((s, h) => s + h.pct, 0);
  // A concentration above 100 is impossible for a consistent denominator; refuse it.
  const pct10 = sum > 100.5 ? null : Number(sum.toFixed(2));
  return {
    top10Percentage: pct10,
    largestHolderPercentage: Number(kept[0].pct.toFixed(2)),
    total,
    counted: Math.min(kept.length, top),
    insiders: kept.filter((h) => h.insider).length,
  };
}

/**
 * Normalise a RugCheck report into our risk shape.
 *
 * Every field is null when the provider did not supply it. Nothing is defaulted to 0.
 */
export function normalizeRugCheck(raw) {
  if (!raw || typeof raw !== 'object') return null;

  const program = String(raw.tokenProgram ?? '');
  const standard = program === TOKEN_2022_PROGRAM ? 'token-2022'
    : program === TOKEN_PROGRAM ? 'spl-token'
      : program ? 'unknown' : null;

  const decimals = num(raw.token?.decimals);
  const supply = num(raw.token?.supply);

  // Creator holding: convert raw units, then compare against total supply.
  let creatorPct = null;
  const creatorRaw = num(raw.creatorBalance);
  if (creatorRaw !== null && supply && supply > 0) {
    creatorPct = (creatorRaw / supply) * 100;
    if (!Number.isFinite(creatorPct) || creatorPct < 0 || creatorPct > 100) creatorPct = null;
    else creatorPct = Number(creatorPct.toFixed(4));
  }

  // Transfer fee. A percentage of 0 is only meaningful once we know the standard:
  // legacy SPL tokens have no fee concept at all.
  //
  // THREE STATES, and collapsing any two of them is a data-safety bug:
  //   token-2022 + fee measured      -> { kind: 'transfer-fee', pct }   "Transfer Fee 2.5%"
  //   token-2022, fee NOT reported   -> { kind: 'transfer-fee', pct: null }  "—"
  //   legacy SPL, verified          -> { kind: 'not-applicable' }      "N/A"
  //
  // "N/A" is a real finding: the concept does not exist for this token standard. It is
  // not the same as "we failed to measure it", which must stay a dash. Stating N/A
  // requires the standard to be KNOWN, so an unrecognised program string yields null.
  const feePct = num(raw.transferFee?.pct);
  let tax;
  if (standard === 'token-2022') {
    tax = { kind: 'transfer-fee', pct: feePct, maxAmount: num(raw.transferFee?.maxAmount) };
  } else if (standard === 'spl-token') {
    tax = { kind: 'not-applicable' };
  } else {
    tax = null;
  }

  const lp = lpFromMarkets(raw.markets);
  const holders = holdersFromTop(raw.topHolders, { total: num(raw.totalHolders) });

  const out = {
    source: 'rugcheck',
    standard,
    decimals,
    // Both authorities are real, verified risk signals.
    security: {
      mintable: raw.mintAuthority === null ? false : (raw.mintAuthority ? true : null),
      freezable: raw.freezeAuthority === null ? false : (raw.freezeAuthority ? true : null),
      honeypot: null, // RugCheck does not simulate sells; leave honestly unknown.
      rugged: typeof raw.rugged === 'boolean' ? raw.rugged : null,
    },
    tax,
    lpLock: lp ? {
      // Burned and locked are kept distinct: they are different guarantees.
      burnedPercentage: lp.burnedPct,
      lockedPercentage: lp.lockedPct,
      coveredPercentage: lp.securedPct,
      state: lp.state,
      poolsScanned: lp.poolsScanned,
    } : null,
    // `creator` on a RugCheck report is the mint authority that created the token, and
    // `creatorBalance` is that address's CURRENT token balance - a token holding, not a
    // royalty share. The role is recorded so the card can say "Creator" truthfully
    // rather than labelling any address it happens to hold as the creator.
    dev: raw.creator ? {
      address: raw.creator,
      role: 'creator',
      balancePercentage: creatorPct,
    } : null,
    holders: {
      total: holders.total,
      top10Percentage: holders.top10Percentage,
      largestHolderPercentage: holders.largestHolderPercentage,
      concentrationCounted: holders.counted,
    },
  };

  return out;
}

/**
 * Fetch the RugCheck report for one mint.
 *
 * @returns {Promise<{status:'ok'|'unsupported'|'not-found'|'error', data?:object, detail?:string}>}
 */
export async function fetchRugCheck(mint, { fetchImpl = globalThis.fetch, timeoutMs = TIMEOUT_MS } = {}) {
  if (!isSolanaMint(mint)) return { status: 'unsupported', data: null, detail: 'not a Solana mint' };
  if (typeof fetchImpl !== 'function') return { status: 'error', data: null, detail: 'no fetch' };

  const key = `rugcheck:${mint}`;
  const hit = cache.get(key);
  if (hit && hit.expiresAt > Date.now()) return hit.result;

  let result;
  try {
    const res = await fetchImpl(`${BASE}/tokens/${encodeURIComponent(mint)}/report`, {
      headers: { accept: 'application/json' },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (res.status === 404) {
      result = { status: 'not-found', data: null, detail: 'no report for this mint' };
    } else if (res.status === 429) {
      result = { status: 'error', data: null, detail: 'rate-limited' };
    } else if (!res.ok) {
      result = { status: 'error', data: null, detail: `http ${res.status}` };
    } else {
      const body = await res.json();
      const data = normalizeRugCheck(body);
      result = data
        ? { status: 'ok', data, detail: null }
        : { status: 'not-found', data: null, detail: 'report had no usable fields' };
    }
  } catch (err) {
    const timedOut = err?.name === 'TimeoutError' || err?.name === 'AbortError';
    result = { status: 'error', data: null, detail: timedOut ? 'timeout' : String(err?.message ?? err) };
  }

  cache.set(key, {
    result,
    expiresAt: Date.now() + (result.status === 'ok' ? OK_TTL_MS : FAIL_TTL_MS),
  });
  return result;
}
