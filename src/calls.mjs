/**
 * src/calls.mjs
 * Call-tracking domain logic: recording, observation, ROI.
 *
 * THE CENTRAL CORRECTNESS RULE
 * "Peak" means the highest market cap RELIABLY OBSERVED SINCE THIS CALL, never
 * the token's all-time high. A token that hit $50M before you called it and sits
 * at $2M after has a post-call peak of ~$2M, not $50M. Conflating the two is the
 * single most damaging error a call tracker can make, so:
 *   - entry is snapshotted from a validated scan at call time
 *   - peak starts AT entry and only moves forward on later observations
 *   - a peak can never be lower than entry, and never comes from history
 *
 * PERFORMANCE vs PROFIT
 * ROI here is a PRICE/market-cap ratio: "if you had bought at the call and held,
 * what is the token worth now". It is not realised profit, does not model fees,
 * slippage, position size or sells, and the cards say so.
 */

import { normaliseAddress } from './store.mjs';

/** Observation windows. Peak tracking stops after MAX_PEAK_AGE_MS. */
export const MAX_PEAK_AGE_MS = 7 * 24 * 3600_000;

/**
 * Is this scan result good enough to persist as an ENTRY?
 * Rejecting bad inputs here is what keeps PnL honest: an entry recorded from a
 * broken provider value would poison every ROI figure derived from it.
 */
export function validateEntry(result) {
  if (!result || result.status !== 'ok') {
    return { ok: false, reason: `scan status is ${result?.status ?? 'missing'}` };
  }
  const { token, market } = result;
  if (!token?.chain || !token?.address) {
    return { ok: false, reason: 'scan result has no chain/address identity' };
  }
  const mcap = market?.marketCapUsd;
  if (mcap == null || !Number.isFinite(mcap)) {
    // No market cap means no ROI baseline. FDV is never substituted.
    return { ok: false, reason: 'no market cap reported, so ROI cannot be measured' };
  }
  if (mcap <= 0) return { ok: false, reason: `market cap is not positive (${mcap})` };
  // Reuse the card's implausibility rule: a $1.5T microcap entry is a provider
  // artefact, and every ROI from it would be fiction.
  const { priceChange24h, priceChange1h, volume24hUsd } = market;
  if (mcap > 5e12) return { ok: false, reason: 'market cap implausibly large; provider data looks wrong' };
  if (Number.isFinite(priceChange24h) && Math.abs(priceChange24h) > 1000) {
    return { ok: false, reason: 'price change implausible (>1000%); provider data looks wrong' };
  }
  if (Number.isFinite(priceChange1h) && Math.abs(priceChange1h) > 1000) {
    return { ok: false, reason: 'price change implausible (>1000%); provider data looks wrong' };
  }
  if (Number.isFinite(volume24hUsd) && volume24hUsd > mcap * 100) {
    return { ok: false, reason: 'volume exceeds market cap by 100x; probable unit error' };
  }
  return {
    ok: true,
    entry: {
      chain: token.chain,
      address: normaliseAddress(token.chain, token.address),
      displayAddress: token.address,
      name: token.name ?? null,
      symbol: token.symbol ?? null,
      entryMarketCapUsd: mcap,
      entryPriceUsd: Number.isFinite(market.priceUsd) ? market.priceUsd : null,
      entryLiquidityUsd: Number.isFinite(market.liquidityUsd) ? market.liquidityUsd : null,
      entryPairAddress: result.source?.pairAddress ?? null,
    },
  };
}

/**
 * Compute ROI from an entry market cap and a current one.
 * Returns null when either side is unusable — never 0, which would read as
 * "flat" and is a different claim from "unknown".
 */
export function roiMultiple(entryMcap, currentMcap) {
  if (!Number.isFinite(entryMcap) || !Number.isFinite(currentMcap)) return null;
  if (entryMcap <= 0) return null;
  return currentMcap / entryMcap;
}

/** Percentage form of a multiple, e.g. 2.5x -> +150.0%. */
export function multipleToPercent(mult) {
  if (!Number.isFinite(mult)) return null;
  return (mult - 1) * 100;
}

/**
 * Decide whether an observation should update the stored peak.
 * Returns { peakMarketCapUsd, peakAt, changed }.
 *
 * Guards:
 *  - a current value below the recorded entry is a drawdown, not a peak
 *  - a wildly implausible jump is not trusted as "reliable": a single reading
 *    more than 50x the entry is far more likely a provider glitch (wrong pair,
 *    post-migration units) than a real move inside one refresh window
 */
export function nextPeak(call, currentMcap, { now = Date.now(), maxJumpMultiple = 50 } = {}) {
  const prevPeak = Number.isFinite(call?.peakMarketCapUsd) ? call.peakMarketCapUsd : call?.entryMarketCapUsd;
  const entry = call?.entryMarketCapUsd;
  if (!Number.isFinite(currentMcap) || !Number.isFinite(entry)) {
    return { peakMarketCapUsd: prevPeak ?? null, peakAt: call?.peakAt ?? null, changed: false, rejected: 'no numeric market cap' };
  }
  if (!Number.isFinite(prevPeak)) {
    return { peakMarketCapUsd: entry, peakAt: call?.calledAt ?? now, changed: false, rejected: 'no prior peak' };
  }
  if (currentMcap <= prevPeak) {
    return { peakMarketCapUsd: prevPeak, peakAt: call?.peakAt ?? call?.calledAt ?? now, changed: false };
  }
  // Reliability gate: a jump this large in one observation is not a peak.
  if (currentMcap > entry * maxJumpMultiple) {
    return { peakMarketCapUsd: prevPeak, peakAt: call?.peakAt ?? null, changed: false, rejected: 'implausible jump vs entry' };
  }
  return { peakMarketCapUsd: currentMcap, peakAt: now, changed: true };
}

/** Pool migration / identity drift check between an entry and a later scan. */
export function detectMigration(call, result) {
  if (!call || !result || result.status !== 'ok') return { migrated: false };
  const currentPair = result.source?.pairAddress ?? null;
  const entryPair = call.entryPairAddress ?? null;
  // Pair address changing while identity holds usually means a liquidity move.
  const pairChanged = Boolean(entryPair && currentPair && entryPair !== currentPair);
  // A drastic liquidity change on the same contract is also worth flagging.
  const entryLiq = call.entryLiquidityUsd;
  const curLiq = result.market?.liquidityUsd;
  const liquidityCollapsed = Number.isFinite(entryLiq) && Number.isFinite(curLiq) &&
    entryLiq > 0 && curLiq < entryLiq * 0.15;
  return {
    migrated: pairChanged || liquidityCollapsed,
    pairChanged,
    liquidityCollapsed,
    entryPair,
    currentPair,
  };
}

/** Human "time since call". */
export function timeSince(calledAt, now = Date.now()) {
  if (!Number.isFinite(calledAt)) return null;
  const ms = Math.max(0, now - calledAt);
  const min = Math.floor(ms / 60_000);
  // "just now" is a complete phrase; callers append "ago", so keep the units
  // format consistent (callers use `${label} ago`).
  if (min < 1) return 'just now';
  if (min < 60) return `${min}m`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ${min % 60}m`;
  const d = Math.floor(hr / 24);
  return `${d}d ${hr % 24}h`;
}

/** Build the record written on a successful call. */
export function buildCallRecord({ chatId, userId, displayName, username, entry, source, messageId = null, now = Date.now() }) {
  return {
    chatId: String(chatId),
    callerId: String(userId),
    callerName: displayName ?? null,
    callerUsername: username ?? null,
    chain: entry.chain,
    address: entry.address,
    displayAddress: entry.displayAddress,
    name: entry.name,
    symbol: entry.symbol,
    entryMarketCapUsd: entry.entryMarketCapUsd,
    entryPriceUsd: entry.entryPriceUsd,
    entryLiquidityUsd: entry.entryLiquidityUsd,
    entryPairAddress: entry.entryPairAddress,
    // Peak begins at entry: the call's own baseline is the first observation.
    peakMarketCapUsd: entry.entryMarketCapUsd,
    peakAt: now,
    lastMarketCapUsd: entry.entryMarketCapUsd,
    lastObservedAt: now,
    calledAt: now,
    source: source ?? 'manual', // 'manual' | 'auto' | 'synthetic'
    status: 'active',
    messageId,
    notes: null,
  };
}

/**
 * Derive the display metrics for a call.
 * Distinguishes "no observation yet" from "observed and flat".
 */
export function callMetrics(call, now = Date.now()) {
  const entry = call?.entryMarketCapUsd;
  const current = Number.isFinite(call?.lastMarketCapUsd) ? call.lastMarketCapUsd : null;
  const peak = Number.isFinite(call?.peakMarketCapUsd) ? call.peakMarketCapUsd : null;

  const currentMult = roiMultiple(entry, current);
  const peakMult = roiMultiple(entry, peak);

  return {
    entryMarketCapUsd: Number.isFinite(entry) ? entry : null,
    currentMarketCapUsd: current,
    peakMarketCapUsd: peak,
    currentMultiple: currentMult,
    peakMultiple: peakMult,
    currentPercent: multipleToPercent(currentMult),
    peakPercent: multipleToPercent(peakMult),
    ageMs: Number.isFinite(call?.calledAt) ? now - call.calledAt : null,
    ageLabel: timeSince(call?.calledAt, now),
    // Peak is only "post-call" if we actually observed something after entry.
    peakIsObserved: Boolean(peak && entry && peak > entry),
    drawdownFromPeak: (Number.isFinite(peak) && Number.isFinite(current) && peak > 0)
      ? ((current - peak) / peak) * 100
      : null,
  };
}

/** Format a multiple as "2.4x". */
export function fmtMultiple(mult) {
  if (!Number.isFinite(mult)) return null;
  if (mult >= 100) return `${Math.round(mult)}x`;
  if (mult >= 10) return `${mult.toFixed(1)}x`;
  return `${mult.toFixed(2)}x`;
}

/** Format a percentage with a sign. */
export function fmtSignedPercent(pct) {
  if (!Number.isFinite(pct)) return null;
  const sign = pct >= 0 ? '+' : '';
  if (Math.abs(pct) >= 1000) return `${sign}${Math.round(pct / 100) / 10}k%`;
  return `${sign}${pct.toFixed(1)}%`;
}
