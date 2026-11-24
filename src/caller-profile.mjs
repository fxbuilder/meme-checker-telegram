/**
 * src/caller-profile.mjs
 * Individual caller history for one group. NOT the leaderboard (Phase 6).
 *
 * DEFINITIONS (stated on the card so a reader cannot invent them)
 *   Hit          a call whose PEAK multiple reached >= HIT_THRESHOLD (2x).
 *                Peak, not current: a call that touched 3x and fell back to 1.1x
 *                still hit — the peak is what was reliably observed.
 *   Hit rate     hits / calls with a usable peak, as a percentage.
 *   Best call    the highest peak multiple in the period.
 *   Average      arithmetic mean of peak multiples.
 *   Median       middle value of peak multiples (robust to one 100x outlier).
 *   Peak return  highest OBSERVED market cap since the call. Never all-time high,
 *                never realised profit.
 *
 * Every figure comes from persisted call records. Nothing is synthesized: a
 * period with no calls says so rather than showing zeros that look like failure.
 */

import { callMetrics, fmtMultiple, timeAgo } from './calls.mjs';
import { fmtUsd } from './card-layout.mjs';
import { callerLabel } from './caller-identity.mjs';

/** A call counts as a hit at or above this peak multiple. */
export const HIT_THRESHOLD = 2;

/** Periods offered in the UI. */
export const PERIODS = [
  { id: '1d', label: '1D', ms: 24 * 3600_000 },
  { id: '7d', label: '1W', ms: 7 * 24 * 3600_000 },
  { id: '14d', label: '2W', ms: 14 * 24 * 3600_000 },
  { id: '30d', label: '1M', ms: 30 * 24 * 3600_000 },
];

export function periodById(id) {
  return PERIODS.find((p) => p.id === String(id).toLowerCase()) ?? PERIODS[1];
}

function esc(v) {
  if (v == null) return '';
  return String(v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/**
 * Profile multiples are written with at most ONE decimal, matching the requested
 * layout ("1.0x", "11.8x", "3x"). The card's two-decimal format reads as false
 * precision for a summary row.
 */
export function fmtProfileMultiple(m) {
  if (!Number.isFinite(m)) return '—';
  const rounded = Math.round(m * 10) / 10;
  return Number.isInteger(rounded) ? `${rounded.toFixed(1)}x` : `${rounded.toFixed(1)}x`;
}

function clip(s, n) {
  const chars = [...String(s ?? '')];
  return chars.length <= n ? chars.join('') : `${chars.slice(0, n - 1).join('')}…`;
}

/**
 * Aggregate one caller's calls inside a period.
 * @param {Array} calls  records for this caller in this group
 */
export function aggregateCaller(calls, { period = '7d', now = Date.now(), hitThreshold = HIT_THRESHOLD } = {}) {
  const p = periodById(period);
  const cutoff = now - p.ms;
  const inPeriod = (calls ?? []).filter((c) => Number.isFinite(c.calledAt) && c.calledAt >= cutoff);

  // A call is measurable once it HAS a peak value. `peakIsObserved` is a
  // different fact (did it rise above entry) and must not gate the statistics.
  const withPeak = inPeriod
    .map((c) => ({ call: c, m: callMetrics(c, now) }))
    .filter((x) => x.m.peakMeasured && Number.isFinite(x.m.peakMultiple));

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
    calls: inPeriod.sort((a, b) => b.calledAt - a.calledAt),
    metrics: withPeak,
    hitThreshold,
  };
}

/**
 * Render the caller profile as Telegram HTML.
 * Includes 1D/7D/14D/30D inline buttons (callback data carries the period only —
 * the caller is re-derived from the signed token in the message, never trusted
 * from the button).
 */
export function renderCallerProfile({
  callerKey,
  calls,
  groupTitle,
  period = '7d',
  now = Date.now(),
  page = 0,
  pageSize = 10,
}) {
  const agg = aggregateCaller(calls, { period, now });
  const first = agg.calls[0] ?? null;
  const name = first ? callerLabel(first) : (String(callerKey).startsWith('c:') ? 'Anonymous admin' : 'Caller');

  const L = [];
  L.push(`👤 <b>${esc(clip(name, 32))}</b>`);
  L.push(`📁 ${esc(clip(groupTitle ?? 'this group', 40))}`);
  L.push('');
  L.push(`Period: <b>${agg.period.label}</b>`);
  L.push(`Calls: <b>${agg.totalCalls}</b>`);

  if (!agg.totalCalls) {
    L.push('');
    L.push('<i>No tracked calls in this period.</i>');
    return { text: L.join('\n'), agg, page: 0, pages: 0 };
  }

  // One metric, stated once. "hit" = an observed peak of at least 2x.
  if (agg.hitRate == null) {
    L.push('Hit Rate: <i>no peak observed yet</i>');
  } else {
    L.push(`Hit Rate: <b>${agg.hitRate.toFixed(0)}%</b> ≥${agg.hitThreshold}x`);
  }
  L.push(`Best Call: <b>${agg.bestMultiple != null ? esc(fmtProfileMultiple(agg.bestMultiple)) : '—'}</b>`);
  L.push(`Median: <b>${agg.medianPeak != null ? esc(fmtProfileMultiple(agg.medianPeak)) : '—'}</b>`);
  L.push(`Avg. Peak: <b>${agg.averagePeak != null ? esc(fmtProfileMultiple(agg.averagePeak)) : '—'}</b>`);

  // ---- one row per tracked contract -------------------------------------
  const sorted = agg.calls;
  const pages = Math.max(1, Math.ceil(sorted.length / pageSize));
  const safePage = Math.min(Math.max(0, page), pages - 1);
  const slice = sorted.slice(safePage * pageSize, safePage * pageSize + pageSize);

  L.push('');
  for (const c of slice) {
    const m = callMetrics(c, now);
    const sym = c.symbol ? `$${c.symbol}` : esc(clip(c.name ?? 'token', 16));
    // The peak is the single performance figure. When no peak was observed the
    // row says so rather than implying a 1.0x result.
    const perf = m.peakMeasured ? `[${esc(fmtProfileMultiple(m.peakMultiple))}]` : '[no peak]';
    // timeAgo() appends " ago" only when it reads correctly ("26m ago", never
    // "just now ago").
    const age = timeAgo(c.calledAt, now);
    L.push(`🟣 <b>${esc(sym)}</b> ${perf} (${esc(age)})`);
  }

  return { text: L.join('\n'), agg, page: safePage, pages };
}

/** Inline keyboard for period switching and pagination. */
export function profileKeyboard({ callerToken, period, page = 0, pages = 1 }) {
  const rows = PERIODS.map((p) => ({
    text: p.id === period ? `• ${p.label} •` : p.label,
    callback_data: `cp:${callerToken}:${p.id}`,
  }));
  const kb = [rows];
  if (pages > 1) {
    const nav = [];
    if (page > 0) nav.push({ text: '‹ Prev', callback_data: `cg:${callerToken}:${period}:${page - 1}` });
    if (page < pages - 1) nav.push({ text: 'Next ›', callback_data: `cg:${callerToken}:${period}:${page + 1}` });
    if (nav.length) kb.push(nav);
  }
  return kb;
}
