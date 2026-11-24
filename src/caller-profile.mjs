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

import { callMetrics, fmtMultiple } from './calls.mjs';
import { fmtUsd } from './card-layout.mjs';
import { callerLabel } from './caller-identity.mjs';

/** A call counts as a hit at or above this peak multiple. */
export const HIT_THRESHOLD = 2;

/** Periods offered in the UI. */
export const PERIODS = [
  { id: '1d', label: '1D', ms: 24 * 3600_000 },
  { id: '7d', label: '7D', ms: 7 * 24 * 3600_000 },
  { id: '14d', label: '14D', ms: 14 * 24 * 3600_000 },
  { id: '30d', label: '30D', ms: 30 * 24 * 3600_000 },
];

export function periodById(id) {
  return PERIODS.find((p) => p.id === String(id).toLowerCase()) ?? PERIODS[1];
}

function esc(v) {
  if (v == null) return '';
  return String(v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
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

  const withPeak = inPeriod
    .map((c) => ({ call: c, m: callMetrics(c, now) }))
    .filter((x) => Number.isFinite(x.m.peakMultiple));

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
  pageSize = 8,
}) {
  const agg = aggregateCaller(calls, { period, now });
  const label = callerLabel(agg.calls[0] ?? { callerKey, callerName: null });
  const name = agg.calls[0] ? callerLabel(agg.calls[0]) : (callerKey?.startsWith('c:') ? 'Anonymous admin' : 'Caller');

  const lines = [];
  lines.push(`👤 <b>${esc(clip(name, 40))}</b>`);
  lines.push(`📁 ${esc(clip(groupTitle ?? 'this group', 40))}`);
  lines.push(`🗓 <b>${agg.period.label}</b>`);
  lines.push('');

  if (!agg.totalCalls) {
    lines.push(`<i>No calls by this caller in the last ${agg.period.label}.</i>`);
    return { text: lines.join('\n'), agg, page: 0, pages: 0 };
  }

  lines.push(`Total calls: <b>${agg.totalCalls}</b>`);
  if (agg.hitRate == null) {
    lines.push('Hit rate: <i>no observed peak yet</i>');
  } else {
    lines.push(`Hit rate: <b>${agg.hitRate.toFixed(0)}%</b> (${agg.hits}/${agg.measuredCalls} at ≥${agg.hitThreshold}x peak)`);
  }

  if (agg.bestCall) {
    const sym = agg.bestCall.symbol ? `$${agg.bestCall.symbol}` : (agg.bestCall.name ?? 'token');
    lines.push(`Best call: <b>${esc(clip(sym, 24))}</b> at <b>${esc(fmtMultiple(agg.bestMultiple))}</b> peak`);
  }

  if (agg.averagePeak != null) {
    lines.push('');
    lines.push(`Average peak: <b>${esc(fmtMultiple(agg.averagePeak))}</b>`);
    lines.push(`Median peak: <b>${esc(fmtMultiple(agg.medianPeak))}</b>`);
  }

  // ---- token list ------------------------------------------------------
  const sorted = agg.calls;
  const pages = Math.max(1, Math.ceil(sorted.length / pageSize));
  const safePage = Math.min(Math.max(0, page), pages - 1);
  const slice = sorted.slice(safePage * pageSize, safePage * pageSize + pageSize);

  lines.push('');
  lines.push(`<b>Tokens called</b>${pages > 1 ? ` (${safePage + 1}/${pages})` : ''}`);
  for (const c of slice) {
    const m = callMetrics(c, now);
    const sym = c.symbol ? `$${c.symbol}` : (c.name ?? 'token');
    // Current vs peak are labelled separately on purpose.
    const cur = m.currentMultiple != null ? fmtMultiple(m.currentMultiple) : '—';
    const peak = m.peakIsObserved ? fmtMultiple(m.peakMultiple) : 'not observed';
    lines.push(
      `• <b>${esc(clip(sym, 18))}</b> — now ${esc(cur)} · peak ${esc(peak)} · ${esc(m.ageLabel ?? '')} ago`,
    );
  }

  if (agg.unmeasuredCalls > 0) {
    lines.push('');
    lines.push(`<i>${agg.unmeasuredCalls} call(s) excluded: no observed peak to measure.</i>`);
  }

  lines.push('');
  lines.push('<i>Peak = highest observed since the call, not all-time high. Multiples are price ratios, not realized profit.</i>');

  return { text: lines.join('\n'), agg, page: safePage, pages };
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
