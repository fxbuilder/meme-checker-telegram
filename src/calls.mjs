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

/**
 * Observation horizons.
 *
 * A call is NEVER retired or deleted because it is old: history and recorded
 * performance are permanent. What changes with age is polling FREQUENCY, so a
 * long tail of old calls cannot burn API budget.
 *
 * `MAX_PEAK_AGE_MS` used to stop observation entirely at 7 days, which silently
 * froze the peak of a perfectly valid call. It is now the boundary of the
 * "hot" tier only.
 */
export const HOT_WINDOW_MS = 7 * 24 * 3600_000;        // first week: poll often
export const WARM_WINDOW_MS = 30 * 24 * 3600_000;      // first month: poll less
export const COLD_POLL_MS = 24 * 3600_000;             // older: once a day
export const MAX_PEAK_AGE_MS = Number.POSITIVE_INFINITY; // never stop tracking

/**
 * Adaptive polling interval for a call, by age.
 * Younger calls move fast and matter most; older ones still get tracked, just
 * cheaply. Returns milliseconds between observations.
 */
export function pollIntervalFor(ageMs, {
  fresh = 20_000,        // 0-1h   : 15-30s  — the window where calls actually move
  hourly = 60_000,       // 1-24h  : 60s
  daily = 4 * 60_000,    // 1-7d   : 3-5min
  weekly = 12 * 60_000,  // 7-30d  : 10-15min
  stale = 45 * 60_000,   // 30d+   : 30-60min
} = {}) {
  if (!Number.isFinite(ageMs) || ageMs < 0) return fresh;
  if (ageMs <= 3600_000) return fresh;
  if (ageMs <= 24 * 3600_000) return hourly;
  if (ageMs <= 7 * 24 * 3600_000) return daily;
  if (ageMs <= 30 * 24 * 3600_000) return weekly;
  return stale;
}

/** Which tier a call is in, for reporting and for Phase 3 scheduling. */
export function pollTierFor(ageMs) {
  if (!Number.isFinite(ageMs) || ageMs < 0) return 'hot';
  if (ageMs <= HOT_WINDOW_MS) return 'hot';
  if (ageMs <= WARM_WINDOW_MS) return 'warm';
  return 'cold';
}

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
/**
 * How many independent confirmations an extreme observation needs before it is
 * admitted to the trusted peak. Two: the first sighting plus one more.
 */
export const EXTREME_CONFIRMATIONS = 2;

/**
 * Decide whether an observation should update the stored peak.
 *
 * EXTREME RETURNS ARE LEGITIMATE
 * A memecoin can genuinely do 50x, 100x, 1000x. Rejecting a large multiple
 * outright would make the tracker wrong about the best calls, which is the
 * opposite of its purpose. So a large jump is not discarded — it is HELD.
 *
 * An observation above `extremeMultiple` (default 50x entry) is parked as a
 * candidate and only enters the trusted peak once EXTREME_CONFIRMATIONS separate
 * observations agree within `agreementTolerance` (default 3x of each other).
 * Until then it is reported as `pending` with the candidate value visible, so an
 * operator can see what is awaiting confirmation rather than a silent gap.
 *
 * Everything below the threshold behaves as before: monotonic, and a value at or
 * below the current peak never moves it.
 *
 * @returns {{
 *   peakMarketCapUsd:number|null, peakAt:number|null, changed:boolean,
 *   rejected?:string, pending?:boolean, candidate?:number,
 *   confirmations?:number, required?:number, reason?:string
 * }}
 */
export function nextPeak(call, currentMcap, {
  now = Date.now(),
  extremeMultiple = 50,
  agreementTolerance = 3,
  requiredConfirmations = EXTREME_CONFIRMATIONS,
} = {}) {
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

  const multiple = currentMcap / entry;
  if (multiple <= extremeMultiple) {
    // Ordinary move: accept immediately.
    return { peakMarketCapUsd: currentMcap, peakAt: now, changed: true };
  }

  // ---- Extreme observation: verify rather than reject or trust blindly ------
  const cand = call?.pendingPeak;
  const sameCluster = cand
    && Number.isFinite(cand.marketCapUsd)
    && currentMcap <= cand.marketCapUsd * agreementTolerance
    && currentMcap >= cand.marketCapUsd / agreementTolerance;

  const confirmations = sameCluster ? (Number(cand.confirmations) || 1) + 1 : 1;
  const clusterValue = sameCluster
    ? Math.max(cand.marketCapUsd, currentMcap)   // keep the highest confirmed
    : currentMcap;
  const clusterFirstSeenAt = sameCluster ? (cand.firstSeenAt ?? now) : now;

  if (confirmations >= requiredConfirmations) {
    // Confirmed by independent observations: admit it as a real peak.
    return {
      peakMarketCapUsd: clusterValue,
      peakAt: clusterFirstSeenAt,
      changed: true,
      confirmedExtreme: true,
      confirmations,
      required: requiredConfirmations,
      multiple,
    };
  }

  // Not yet confirmed: hold it, do not touch the trusted peak.
  return {
    peakMarketCapUsd: prevPeak,
    peakAt: call?.peakAt ?? null,
    changed: false,
    pending: true,
    candidate: clusterValue,
    confirmations,
    required: requiredConfirmations,
    multiple,
    reason: `extreme ${multiple.toFixed(0)}x needs ${requiredConfirmations} confirmations`,
  };
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
  if (min < 1) return 'just now';
  if (min < 60) return `${min}m`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ${min % 60}m`;
  const d = Math.floor(hr / 24);
  return `${d}d ${hr % 24}h`;
}

/**
 * Human age that reads correctly in a sentence: "just now", "26m ago".
 *
 * timeSince() returns a bare unit ("26m") except for the complete phrase
 * "just now". Every caller appending " ago" therefore produced "just now ago".
 * Use THIS function wherever an age is shown, and the bug cannot recur.
 * Returns '' for an unknown time so callers can omit the parenthetical.
 */
export function timeAgo(calledAt, now = Date.now()) {
  const label = timeSince(calledAt, now);
  if (!label) return '';
  return label === 'just now' ? label : `${label} ago`;
}

/** Build the record written on a successful call. */
export function buildCallRecord({
  chatId, userId, displayName, username, entry, source,
  messageId = null, messageDate = null, now = Date.now(),
  callerKey = null, callerKind = 'user', senderChatId = null,
}) {
  return {
    chatId: String(chatId),
    // callerId is retained for older records; callerKey is the stable identity.
    callerId: String(userId ?? callerKey ?? ''),
    callerKey: callerKey ?? (userId != null ? `u:${userId}` : null),
    callerKind,
    senderChatId,
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
    // The original message timestamp, so call time is the post time rather than
    // the moment a retry happened to be processed.
    messageDate: Number.isFinite(messageDate) ? messageDate : null,
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
    // Two distinct facts, kept separate so a display never contradicts a metric:
    //   peakMeasured — we have a peak value at all (peak is seeded to entry, so this
    //                  is true as soon as the call exists)
    //   peakIsObserved — the token actually rose above entry at some point
    // Statistics must use peakMeasured; narrative copy about "rose above entry"
    // uses peakIsObserved. Conflating them produced a card that said both
    // "peak 1.00x" and "peak not observed".
    peakMeasured: Boolean(peak && entry),
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
