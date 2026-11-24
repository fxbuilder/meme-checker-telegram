/**
 * src/leaderboard.mjs
 * Phase 6 — inside-group caller rankings.
 *
 * SCOPE: internal to one Telegram group. This is not a global competition and not a
 * claim about anyone's trading profit. Everything here ranks RECORDED TOKEN
 * PERFORMANCE — the observed peak multiple of a called token after the call — which is
 * a property of the call, not of the caller's realised PnL.
 *
 * ELIGIBILITY is the part that decides whether the board is honest:
 *   - only ACTIVE, non-synthetic, non-superseded calls count (a cancelled call cannot
 *     inflate anyone's record)
 *   - a call whose peak was never observed is ELIGIBLE but shown as unmeasured; it is
 *     not silently dropped, because dropping unmeasured calls would flatter the board
 *   - losers stay in the sample. Ranking is not "best calls only".
 *
 * ORDERING is deterministic: primary by measured hit rate, then by best peak, then by
 * call volume, then by caller key. Ties therefore resolve identically on every run,
 * which matters because a shifting order looks like live data changing.
 */

import { callMetrics, timeAgo } from './calls.mjs';
import { callerLabel } from './caller-identity.mjs';
import { periodById, PERIODS, HIT_THRESHOLD } from './caller-profile.mjs';

const PAGE_SIZE = 10;

/** Ranking periods exposed to users, reusing the Caller Profile vocabulary. */
export const LB_PERIODS = PERIODS.map((p) => ({ ...p }));

export function lbPeriodById(id) {
  return periodById(id);
}

function esc(v) {
  return String(v ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function fmtMult(v) {
  if (!Number.isFinite(Number(v))) return null;
  const n = Number(v);
  if (n >= 100) return `${Math.round(n)}x`;
  if (n >= 10) return `${n.toFixed(1)}x`;
  return `${n.toFixed(2)}x`;
}

/**
 * Group one caller's eligible calls into a ranking row.
 * Exported for testing: the eligibility rules are the thing that must not drift.
 */
export function summariseCaller(calls, { now = Date.now(), hitThreshold = HIT_THRESHOLD } = {}) {
  if (!Array.isArray(calls) || !calls.length) return null;

  // Eligibility: measured peak only. Unmeasured calls still COUNT toward the call
  // total, so a caller with many unobserved calls is visible rather than invisible.
  const measured = [];
  for (const c of calls) {
    const m = callMetrics(c, now);
    if (m.peakMeasured && Number.isFinite(m.peakMultiple)) {
      measured.push({ call: c, metrics: m, multiple: m.peakMultiple });
    }
  }

  const peaks = measured.map((x) => x.multiple).sort((a, b) => a - b);
  const hits = peaks.filter((p) => p >= hitThreshold).length;

  const mean = peaks.length ? peaks.reduce((s, v) => s + v, 0) / peaks.length : null;
  const median = peaks.length
    ? (peaks.length % 2
      ? peaks[(peaks.length - 1) / 2]
      : (peaks[peaks.length / 2 - 1] + peaks[peaks.length / 2]) / 2)
    : null;

  const best = peaks.length ? peaks[peaks.length - 1] : null;
  // The call that produced the best multiple, for the "best call" label.
  const bestEntry = measured.find((x) => x.multiple === best) ?? null;

  // Deterministic tie-break key. Lowercased so casing cannot reorder the board.
  const key = String(calls[0]?.callerKey ?? '').toLowerCase();

  // A display label taken from the MOST RECENT call, so it tracks the caller's current
  // name. It is cosmetic only - identity and grouping stay on callerKey.
  const newest = [...calls].sort((a, b) => (b.calledAt ?? 0) - (a.calledAt ?? 0))[0];
  let label = null;
  if (newest) {
    try {
      label = callerLabel(newest) ?? null;
    } catch {
      label = null;
    }
  }

  return {
    callerKey: calls[0]?.callerKey ?? key,
    label,
    calls: calls.length,
    measuredCalls: measured.length,
    unmeasuredCalls: calls.length - measured.length,
    hits,
    hitRate: measured.length ? (hits / measured.length) * 100 : null,
    best,
    bestSymbol: bestEntry?.call?.symbol ?? bestEntry?.call?.name ?? null,
    mean,
    median,
    sortKey: key,
  };
}

/**
 * Rank rows deterministically.
 *
 * A caller with NO measured calls sorts last regardless of how many calls they made:
 * they have no performance evidence, and floating them above a caller with real
 * results would misrepresent both.
 */
export function rankCallers(rows) {
  return [...rows].sort((a, b) => {
    const aMeasured = a.measuredCalls > 0;
    const bMeasured = b.measuredCalls > 0;
    if (aMeasured !== bMeasured) return aMeasured ? -1 : 1;

    // Hit rate, then best peak, then volume, then stable key.
    const aRate = a.hitRate ?? -1;
    const bRate = b.hitRate ?? -1;
    if (aRate !== bRate) return bRate - aRate;

    const aBest = a.best ?? -1;
    const bBest = b.best ?? -1;
    if (aBest !== bBest) return bBest - aBest;

    if (a.measuredCalls !== b.measuredCalls) return b.measuredCalls - a.measuredCalls;
    return a.sortKey.localeCompare(b.sortKey);
  });
}

/**
 * Build the board for one group.
 *
 * @param {object} args
 * @param {Array} args.calls  already group-scoped and eligibility-filtered by the store
 */
export function buildLeaderboard(calls, { period = '7d', now = Date.now() } = {}) {
  const p = periodById(period);
  const cutoff = now - (p?.ms ?? 0);
  const inPeriod = (calls ?? []).filter((c) => Number.isFinite(c.calledAt) && c.calledAt >= cutoff);

  const byCaller = new Map();
  for (const c of inPeriod) {
    const key = String(c.callerKey ?? 'unknown');
    if (!byCaller.has(key)) byCaller.set(key, []);
    byCaller.get(key).push(c);
  }

  const rows = [];
  for (const group of byCaller.values()) {
    const s = summariseCaller(group, { now });
    if (s) rows.push(s);
  }
  return { period: p, rows: rankCallers(rows), totalCalls: inPeriod.length };
}

/** Group-level performance summary — shares the same eligible sample. */
export function buildGroupSummary(calls, { period = '7d', now = Date.now() } = {}) {
  const p = periodById(period);
  const cutoff = now - (p?.ms ?? 0);
  const inPeriod = (calls ?? []).filter((c) => Number.isFinite(c.calledAt) && c.calledAt >= cutoff);

  const measured = [];
  for (const c of inPeriod) {
    const m = callMetrics(c, now);
    if (m.peakMeasured && Number.isFinite(m.peakMultiple)) measured.push(m.peakMultiple);
  }
  measured.sort((a, b) => a - b);

  const mean = measured.length ? measured.reduce((s, v) => s + v, 0) / measured.length : null;
  const median = measured.length
    ? (measured.length % 2
      ? measured[(measured.length - 1) / 2]
      : (measured[measured.length / 2 - 1] + measured[measured.length / 2]) / 2)
    : null;
  const hits = measured.filter((v) => v >= HIT_THRESHOLD).length;

  return {
    period: p,
    calls: inPeriod.length,
    measured: measured.length,
    unmeasured: inPeriod.length - measured.length,
    best: measured.length ? measured[measured.length - 1] : null,
    mean,
    median,
    hits,
    hitRate: measured.length ? (hits / measured.length) * 100 : null,
  };
}

/**
 * Render the leaderboard.
 *
 * Every number carries its sample size, because "hit rate 50%" over two calls and over
 * two hundred are not the same claim.
 */
export function renderLeaderboard({ groupTitle, board, page = 0, pageSize = PAGE_SIZE, hitThreshold = HIT_THRESHOLD }) {
  const L = [];
  L.push('🏆 <b>GROUP LEADERBOARD</b>');
  L.push('');
  L.push(`📁 ${esc(groupTitle ?? 'This group')} · ${esc(board.period?.label ?? '')}`);
  L.push('');

  if (!board.rows.length) {
    L.push('<i>No calls in this period.</i>');
    return { text: L.join('\n'), keyboard: [] };
  }

  const pages = Math.max(1, Math.ceil(board.rows.length / pageSize));
  const safePage = Math.min(Math.max(0, page), pages - 1);
  const slice = board.rows.slice(safePage * pageSize, safePage * pageSize + pageSize);

  slice.forEach((row, i) => {
    const rank = safePage * pageSize + i + 1;
    const medal = rank === 1 ? '🥇' : rank === 2 ? '🥈' : rank === 3 ? '🥉' : `${rank}.`;
    // The label comes from the most recent call so it tracks the caller's current name.
    const name = row.label ?? row.callerKey;
    L.push(`${medal} <b>${esc(name)}</b> · ${row.calls} call${row.calls === 1 ? '' : 's'}`);

    if (row.measuredCalls === 0) {
      // Eligible but unmeasured: say so instead of showing zeros that look like failure.
      L.push('   <i>No measured peak yet — performance unavailable</i>');
      return;
    }

    const bits = [`Hit ${row.hitRate.toFixed(0)}% ≥${hitThreshold}x`];
    const best = fmtMult(row.best);
    if (best) bits.push(`Best ${best}`);
    const median = fmtMult(row.median);
    if (median) bits.push(`Median ${median}`);
    L.push(`   ${bits.join(' · ')}`);

    if (row.unmeasuredCalls > 0) {
      L.push(`   <i>${row.unmeasuredCalls} call${row.unmeasuredCalls === 1 ? '' : 's'} not yet observed</i>`);
    }
  });

  L.push('');
  L.push(`<i>${board.rows.length} caller${board.rows.length === 1 ? '' : 's'} · ${board.totalCalls} call${board.totalCalls === 1 ? '' : 's'} in ${esc(board.period?.label ?? 'period')} · page ${safePage + 1}/${pages}</i>`);
  L.push('<i>Ranked on observed token peak after the call — not realised trading profit. Losers are included.</i>');

  // Period filter buttons, plus pagination when needed.
  const periodButtons = LB_PERIODS.map((p) => ({
    text: p.id === board.period?.id ? `• ${p.label}` : p.label,
    callback_data: `lb:${p.id}:${safePage}`,
  }));
  const keyboard = [periodButtons];
  if (pages > 1) {
    const nav = [];
    if (safePage > 0) nav.push({ text: '← Prev', callback_data: `lb:${board.period?.id}:${safePage - 1}` });
    if (safePage < pages - 1) nav.push({ text: 'Next →', callback_data: `lb:${board.period?.id}:${safePage + 1}` });
    if (nav.length) keyboard.push(nav);
  }

  return { text: L.join('\n'), keyboard };
}

/** Render the group performance summary. */
export function renderGroupPnl({ groupTitle, summary }) {
  const L = [];
  L.push('📊 <b>GROUP PERFORMANCE</b>');
  L.push('');
  L.push(`📁 ${esc(groupTitle ?? 'This group')} · ${esc(summary.period?.label ?? '')}`);
  L.push('');

  if (!summary.calls) {
    L.push('<i>No calls in this period.</i>');
    return { text: L.join('\n'), keyboard: [] };
  }

  L.push(`Calls recorded: <b>${summary.calls}</b>`);
  if (summary.measured) {
    L.push(`With an observed peak: <b>${summary.measured}</b>`);
  }
  if (summary.unmeasured) {
    L.push(`Not yet observed: <b>${summary.unmeasured}</b>`);
  }
  L.push('');

  if (summary.measured) {
    const best = fmtMult(summary.best);
    const median = fmtMult(summary.median);
    L.push(`Best peak: <b>${best ?? '—'}</b>`);
    L.push(`Median peak: <b>${median ?? '—'}</b>`);
    L.push(`Hit rate: <b>${summary.hitRate.toFixed(0)}%</b> ≥${HIT_THRESHOLD}x (${summary.hits}/${summary.measured})`);
  } else {
    L.push('<i>No call has a measured peak yet, so no performance figures are shown.</i>');
  }

  L.push('');
  L.push('<i>Peak is the highest observed market cap after the call. This is token performance, not realised trading profit.</i>');

  const periodButtons = LB_PERIODS.map((p) => ({
    text: p.id === summary.period?.id ? `• ${p.label}` : p.label,
    callback_data: `gp:${p.id}`,
  }));
  return { text: L.join('\n'), keyboard: [periodButtons] };
}
