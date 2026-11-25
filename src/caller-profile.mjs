/**
 * src/caller-profile.mjs
 * Individual caller history for one group. NOT the leaderboard.
 *
 * DEFINITIONS (stated on the card so a reader cannot invent them)
 *   Hit          a call whose PEAK multiple reached >= HIT_THRESHOLD (2x).
 *                Peak, not current: a call that touched 3x and fell back to 1.1x still hit —
 *                the peak is what was reliably observed.
 *   Hit rate     hits / calls with a usable peak, as a percentage.
 *   Best call    the highest peak multiple in the period.
 *   Average      arithmetic mean of peak multiples.
 *   Median       middle value of peak multiples (robust to one 100x outlier).
 *
 * TWO INDEPENDENT PERFORMANCE FACTS, NEVER MERGED
 *   peak    how high the token went after the call — a HISTORICAL observation
 *   now     current mark-to-market against the call's entry — NOT realised profit
 * A call can have a 5x peak and a negative current ROI, and that is the most misleading
 * situation to collapse: it means "it ran, and it came back". Both are shown, each with its
 * own tone, and neither is ever called profit.
 *
 * ROUND 6 ORDERING FIX
 * Calls used to be listed newest-first, which put the best-performing tokens at the BOTTOM and
 * made a caller's actual record hard to see. The default is now peak multiple DESCENDING.
 * Sorting happens on the WHOLE period dataset before pagination, so page 2 continues the
 * ranking rather than showing an unrelated slice.
 */

import { callMetrics, timeAgo } from './calls.mjs';
import { callerLabel } from './caller-identity.mjs';
import { icon, chainIcon } from './icons.mjs';

/** A call counts as a hit at or above this peak multiple. */
export const HIT_THRESHOLD = 2;

/** Periods offered in the UI. */
export const DEFAULT_PERIOD = '1d';

export const PERIODS = [
  { id: '1d', label: '1D', ms: 24 * 3600_000 },
  { id: '7d', label: '1W', ms: 7 * 24 * 3600_000 },
  { id: '14d', label: '2W', ms: 14 * 24 * 3600_000 },
  { id: '30d', label: '1M', ms: 30 * 24 * 3600_000 },
];

/**
 * Ranking modes.
 *   peak  historical peak multiple, highest first (DEFAULT — what the brief asks for)
 *   roi   current mark-to-market multiple, highest first
 * Both are deterministic: ties fall through to calledAt then the token key.
 */
export const RANK_MODES = [
  { id: 'peak', label: 'Best Calls' },
  { id: 'roi', label: 'Current ROI' },
];
export const DEFAULT_RANK = 'peak';

export function periodById(id) {
  return PERIODS.find((p) => p.id === String(id).toLowerCase()) ?? PERIODS[1];
}

export function rankModeById(id) {
  return RANK_MODES.find((m) => m.id === String(id).toLowerCase()) ?? RANK_MODES[0];
}

function esc(v) {
  if (v == null) return '';
  return String(v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** One decimal, matching the requested layout ("1.0x", "11.8x"). */
export function fmtProfileMultiple(m) {
  if (!Number.isFinite(m)) return '—';
  const rounded = Math.round(m * 10) / 10;
  return `${rounded.toFixed(1)}x`;
}

function clip(s, n) {
  const chars = [...String(s ?? '')];
  return chars.length <= n ? chars.join('') : `${chars.slice(0, n - 1).join('')}…`;
}

// ---------------------------------------------------------------------------
// Tone classification — the two facts, each with its own scale
// ---------------------------------------------------------------------------

/**
 * PEAK tone. A historical observation.
 *   >= 2x        good    (a hit)
 *   > 1x, < 2x   warn    (it ran, but not to a hit)
 *   === 1x       neutral (flat)
 *   no peak      unknown
 *
 * NOT a loss indicator. A token that has not reached 2x is not "losing" — it may simply not
 * have run yet, and the current ROI is the separate fact that answers that question.
 */
export function peakTone(peakMultiple) {
  if (!Number.isFinite(peakMultiple)) return 'unknown';
  if (peakMultiple >= HIT_THRESHOLD) return 'good';
  if (peakMultiple > 1) return 'warn';
  return 'neutral';
}

/**
 * CURRENT ROI tone. Mark-to-market against entry — explicitly not realised profit.
 *   > 1x   good
 *   < 1x   bad
 *   === 1x neutral
 *   null   unknown (no current price; NEVER treated as a loss)
 */
export function roiTone(currentMultiple) {
  if (!Number.isFinite(currentMultiple)) return 'unknown';
  if (currentMultiple > 1) return 'good';
  if (currentMultiple < 1) return 'bad';
  return 'neutral';
}

function toneIcon(tone, theme) {
  const map = { good: 'state.good', warn: 'state.warn', bad: 'state.bad', neutral: 'state.neutral', unknown: 'state.unknown' };
  return icon(map[tone] ?? 'state.unknown', { theme });
}

function tokenKey(call) {
  return `${call?.chain ?? '?'}:${call?.address ?? call?.contract ?? '?'}`;
}

/**
 * Order the period's calls for display.
 *
 * Peak-descending by default. The comparator is TOTAL, so pagination is stable:
 *   1. the mode's multiple, DESC   (missing sorts last, never as 0)
 *   2. calledAt DESC               (newest first among equals)
 *   3. contract key ASC            (fixed tiebreak so identical rows cannot swap)
 */
export function orderCalls(entries, mode = DEFAULT_RANK, now = Date.now()) {
  void now;
  const multipleOf = (e) => (mode === 'roi' ? e.m.currentMultiple : e.m.peakMultiple);
  return [...entries].sort((a, b) => {
    const av = multipleOf(a);
    const bv = multipleOf(b);
    const aOk = Number.isFinite(av);
    const bOk = Number.isFinite(bv);
    // A call with no value for THIS mode sorts below every call that has one. Sorting a
    // missing value as 0 would place "unknown" beneath a genuine 0.5x, implying a measurement.
    if (aOk !== bOk) return aOk ? -1 : 1;
    if (aOk && bOk && av !== bv) return bv - av;
    const at = Number.isFinite(a.call?.calledAt) ? a.call.calledAt : 0;
    const bt = Number.isFinite(b.call?.calledAt) ? b.call.calledAt : 0;
    if (at !== bt) return bt - at;
    return String(a.key).localeCompare(String(b.key));
  });
}

/**
 * Aggregate one caller's calls inside a period.
 * @param {Array} calls  records for this caller in this group
 */
export function aggregateCaller(calls, { period = DEFAULT_PERIOD, now = Date.now(), hitThreshold = HIT_THRESHOLD } = {}) {
  const p = periodById(period);
  const cutoff = now - p.ms;
  const inPeriod = (calls ?? []).filter((c) => Number.isFinite(c.calledAt) && c.calledAt >= cutoff);

  // `peakMeasured` gates the statistics. `peakIsObserved` is a different fact (did it rise
  // above entry) and must not gate them - conflating the two produced a card that said both
  // "peak 1.00x" and "peak not observed".
  const entries = inPeriod.map((c) => ({ call: c, key: tokenKey(c), m: callMetrics(c, now) }));
  const withPeak = entries.filter((x) => x.m.peakMeasured && Number.isFinite(x.m.peakMultiple));

  const peaks = withPeak.map((x) => x.m.peakMultiple).sort((a, b) => a - b);
  const hits = withPeak.filter((x) => x.m.peakMultiple >= hitThreshold);

  const mean = peaks.length ? peaks.reduce((s, v) => s + v, 0) / peaks.length : null;
  const median = peaks.length
    ? (peaks.length % 2
      ? peaks[(peaks.length - 1) / 2]
      : (peaks[peaks.length / 2 - 1] + peaks[peaks.length / 2]) / 2)
    : null;

  const best = withPeak.length
    ? withPeak.reduce((a, b) => (b.m.peakMultiple > a.m.peakMultiple ? b : a))
    : null;

  // Current-ROI buckets. A call with no usable current price is UNKNOWN - never a loss.
  const withCurrent = entries.filter((x) => Number.isFinite(x.m.currentMultiple));
  const profitable = withCurrent.filter((x) => x.m.currentMultiple > 1).length;
  const losing = withCurrent.filter((x) => x.m.currentMultiple < 1).length;
  const breakeven = withCurrent.filter((x) => x.m.currentMultiple === 1).length;
  const currentUnknown = entries.length - withCurrent.length;

  const ordered = orderCalls(entries, DEFAULT_RANK, now);

  return {
    period: p,
    totalCalls: inPeriod.length,
    measuredCalls: withPeak.length,
    unmeasuredCalls: inPeriod.length - withPeak.length,
    hits: hits.length,
    hitRate: withPeak.length ? (hits.length / withPeak.length) * 100 : null,
    averagePeak: mean,
    medianPeak: median,
    bestCall: best?.call ?? null,
    bestMultiple: best?.m.peakMultiple ?? null,
    entries: ordered,
    // Legacy field kept so existing callers do not break: same order, mapped to records.
    calls: ordered.map((x) => x.call),
    metrics: withPeak,
    current: { profitable, losing, breakeven, unknown: currentUnknown, measured: withCurrent.length },
    hitThreshold,
  };
}

/**
 * Render the caller profile as Telegram HTML.
 *
 * Inline buttons carry the ranking mode and period only; the caller is re-derived from the
 * signed token in the message, never trusted from the button. Changing period or ranking mode
 * resets to page 0 — page 4 of a differently-ordered list would show an unrelated slice.
 */
export function renderCallerProfile({
  callerKey,
  calls,
  groupTitle,
  period = DEFAULT_PERIOD,
  rank = DEFAULT_RANK,
  now = Date.now(),
  page = 0,
  pageSize = 10,
  theme = null,
}) {
  const E = (name) => icon(name, { theme });
  const agg = aggregateCaller(calls, { period, now });
  const mode = rankModeById(rank);
  const first = agg.entries[0]?.call ?? null;
  const name = first ? callerLabel(first) : (String(callerKey).startsWith('c:') ? 'Anonymous admin' : 'Caller');

  const L = [];
  L.push(`${E('section.community')} <b>${esc(clip(name, 32))}</b>`);
  // The period belongs on the card: the same caller reads very differently over 1D and 1M, and
  // a profile that omits it invites comparing two screenshots taken over different windows.
  L.push(`${E('section.leaderboard')} ${esc(clip(groupTitle ?? 'this group', 40))} · Period <b>${agg.period.label}</b>`);
  L.push('');

  if (!agg.totalCalls) {
    L.push('<i>No tracked calls in this period.</i>');
    return { text: L.join('\n'), agg, page: 0, pages: 0, rank: mode.id };
  }

  // ---- compact performance summary ----------------------------------------
  L.push(`${E('metric.calls')} Calls <b>${agg.totalCalls}</b>   `
    + `${E('metric.hitRate')} Hit <b>${agg.hitRate != null ? `${agg.hitRate.toFixed(0)}%` : '—'}</b> ≥${agg.hitThreshold}x`);
  L.push(`${E('metric.peak')} Best <b>${agg.bestMultiple != null ? fmtProfileMultiple(agg.bestMultiple) : '—'}</b>   `
    + `${E('metric.avg')} Avg <b>${agg.averagePeak != null ? fmtProfileMultiple(agg.averagePeak) : '—'}</b>   `
    + `${E('metric.median')} Med <b>${agg.medianPeak != null ? fmtProfileMultiple(agg.medianPeak) : '—'}</b>`);

  const c = agg.current;
  L.push(`${E('metric.roi')} Now: ${toneIcon('good', theme)} <b>${c.profitable}</b> up · `
    + `${toneIcon('bad', theme)} <b>${c.losing}</b> down · `
    + `${toneIcon('unknown', theme)} <b>${c.unknown}</b> no price`);
  L.push('');

  // The two facts are named once, so neither is read as the other.
  L.push('<i>Peak = highest observed after the call. Now = current vs entry, not realised profit.</i>');
  L.push('');

  // ---- ranked rows ---------------------------------------------------------
  // Sorted on the WHOLE dataset before slicing, so page N continues the ranking.
  const sorted = orderCalls(agg.entries, mode.id, now);
  const pages = Math.max(1, Math.ceil(sorted.length / pageSize));
  const safePage = Math.min(Math.max(0, page), pages - 1);
  const slice = sorted.slice(safePage * pageSize, safePage * pageSize + pageSize);

  L.push(`<b>${mode.label}</b>${pages > 1 ? `  <i>page ${safePage + 1}/${pages}</i>` : ''}`);
  for (const e of slice) {
    const m = e.m;
    const sym = e.call.symbol ? `$${e.call.symbol}` : esc(clip(e.call.name ?? 'token', 16));
    const pTone = peakTone(m.peakMultiple);
    const peakTxt = m.peakMeasured ? fmtProfileMultiple(m.peakMultiple) : 'no peak';
    const rTone = roiTone(m.currentMultiple);
    const roiTxt = Number.isFinite(m.currentMultiple) ? fmtProfileMultiple(m.currentMultiple) : '—';
    // Age is kept on the row: the peak figure means something different for a call made an hour
    // ago and one from three weeks ago, and dropping it made two very different rows look alike.
    const age = timeAgo(e.call.calledAt, now);
    L.push(
      `${chainIcon(e.call.chain, { theme })} <b>${esc(sym)}</b>  `
      + `peak ${toneIcon(pTone, theme)} <b>${esc(peakTxt)}</b>  ·  `
      + `now ${toneIcon(rTone, theme)} ${esc(roiTxt)}`
      + (age ? `  ·  <i>${esc(age)}</i>` : ''),
    );
  }

  return { text: L.join('\n'), agg, page: safePage, pages, rank: mode.id };
}

/**
 * Inline keyboard: ranking modes, period filters, pagination.
 *
 * Callback data encodes (token, period, rank, page) so a tap is self-describing and the handler
 * never has to guess which ordering produced the current page.
 */
export function profileKeyboard({ callerToken, period, rank = DEFAULT_RANK, page = 0, pages = 1 }) {
  const modeRow = RANK_MODES.map((m) => ({
    text: m.id === rank ? `• ${m.label} •` : m.label,
    callback_data: `cr:${callerToken}:${period}:${m.id}:0`,
  }));
  const periodRow = PERIODS.map((p) => ({
    text: p.id === period ? `• ${p.label} •` : p.label,
    callback_data: `cp:${callerToken}:${p.id}:${rank}:0`,
  }));

  const kb = [modeRow, periodRow];
  if (pages > 1) {
    const nav = [];
    if (page > 0) nav.push({ text: '‹ Prev', callback_data: `cg:${callerToken}:${period}:${rank}:${page - 1}` });
    if (page < pages - 1) nav.push({ text: 'Next ›', callback_data: `cg:${callerToken}:${period}:${rank}:${page + 1}` });
    if (nav.length) kb.push(nav);
  }
  return kb;
}
