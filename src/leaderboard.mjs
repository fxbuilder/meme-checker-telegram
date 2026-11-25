/**
 * src/leaderboard.mjs
 * Group leaderboard - three sections, one period.
 *
 * SCOPE: internal to one Telegram group. This is not a global competition and not a
 * claim about anyone's trading profit. Everything here ranks RECORDED TOKEN
 * PERFORMANCE - the observed peak multiple of a called token after the call - which is a
 * property of the call, not of the caller's realised PnL.
 *
 * ELIGIBILITY is the part that decides whether the board is honest:
 *   - only ACTIVE, non-synthetic, non-superseded calls count (a cancelled call cannot
 *     inflate anyone's record)
 *   - a call whose peak was never observed stays in the sample and is shown as
 *     unmeasured; dropping it would flatter the board
 *   - losers stay in the sample. Ranking is not "best calls only".
 *
 * RANKING FORMULA (deterministic, and stated to users):
 *
 *   primary   : measured hit rate - share of MEASURED calls whose peak reached >=2x
 *   tiebreak 1: best observed peak
 *   tiebreak 2: number of measured calls
 *   tiebreak 3: caller key (stable, lowercased)
 *
 * Hit rate leads because it is the only field comparable across sample sizes. There are
 * no invented points, no weighting, and nothing that could be mistaken for realised
 * profit. A caller with zero measured calls sorts last, never first.
 */

import { callMetrics } from './calls.mjs';
import { callerLabel } from './caller-identity.mjs';
import { periodById, PERIODS, HIT_THRESHOLD } from './caller-profile.mjs';
import { mintCallerToken, DEFAULT_PERIOD } from './deep-link.mjs';

const PAGE_SIZE = 10;
/** How many individual calls the TOP CALLS section lists. */
const TOP_CALLS = 10;
/** How many callers the collapsed view shows before the Top-10 expansion. */
const TOP_CALLERS_COLLAPSED = 3;

/** Ranking periods exposed to users, reusing the Caller Profile vocabulary. */
export const LB_PERIODS = PERIODS.map((p) => ({ ...p }));

export function lbPeriodById(id) {
  return periodById(id);
}

function esc(v) {
  return String(v ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

export function fmtMult(v) {
  if (v == null || !Number.isFinite(Number(v))) return null;
  const n = Number(v);
  if (n >= 100) return `${Math.round(n)}x`;
  if (n >= 10) return `${n.toFixed(1)}x`;
  return `${n.toFixed(2)}x`;
}

function fmtPct(v) {
  if (v == null || !Number.isFinite(Number(v))) return '\u2014';
  return `${Math.round(Number(v))}%`;
}

/**
 * Chain glyph for a token row.
 *
 * Standard Unicode rather than Telegram custom emoji: custom emoji need a premium
 * sticker set plus message entities, which silently degrade for users who cannot render
 * them. An unknown chain gets a neutral dot, never a wrong flag.
 */
export const CHAIN_EMOJI = {
  solana: '\u{1F7E3}',
  ethereum: '\u{1F537}',
  bsc: '\u{1F7E1}',
  base: '\u{1F535}',
  arbitrum: '\u{1F539}',
  optimism: '\u{1F534}',
  polygon: '\u{1F7EA}',
  avalanche: '\u{1F53A}',
  hyperevm: '\u{1F7E9}',
  monad: '\u{1F7E8}',
  robinhood: '\u{1F7E2}',
  unichain: '\u{1F984}',
  berachain: '\u{1F43B}',
  abstract: '\u2B1C',
  megaeth: '\u26A1',
  story: '\u{1F4D6}',
};

export function chainEmoji(chain) {
  return CHAIN_EMOJI[String(chain ?? '').toLowerCase()] ?? '\u2022';
}

/**
 * Group one caller's eligible calls into a ranking row.
 * Exported for testing: the eligibility rules are the thing that must not drift.
 */
export function summariseCaller(calls, { now = Date.now(), hitThreshold = HIT_THRESHOLD } = {}) {
  if (!Array.isArray(calls) || !calls.length) return null;

  // Unmeasured calls still COUNT toward the call total, so a caller with many
  // unobserved calls is visible rather than invisible.
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
  const bestEntry = measured.find((x) => x.multiple === best) ?? null;

  const key = String(calls[0]?.callerKey ?? '').toLowerCase();

  // Label from the MOST RECENT call so it tracks the caller's current name. Cosmetic
  // only - identity and grouping stay on callerKey.
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
    bestChain: bestEntry?.call?.chain ?? null,
    mean,
    median,
    sortKey: key,
  };
}

/**
 * Minimum sample before HIT RATE is allowed to decide a ranking.
 *
 * One lucky call gives a 100% hit rate and would top the board ahead of someone with a real
 * record. Below this threshold a caller still APPEARS with their figures — they are simply not
 * ranked by rate, because the rate is not yet meaningful. Documented here so the rule is
 * inspectable rather than implied by a magic number.
 *
 * The floor is 2, not 3: the misleading case the brief names is a SINGLE call, and setting the
 * bar higher silently disqualified callers with a short but real two-call record.
 */
export const MIN_CALLS_FOR_HIT_RATE = 2;

/**
 * Ranking modes.
 *   best  highest single Best Call multiple — the DEFAULT (owner brief)
 *   hit   hit rate, for callers with at least MIN_CALLS_FOR_HIT_RATE measured calls
 *   avg   average peak multiple
 */
export const RANK_MODES = [
  { id: 'best', label: 'Best Call' },
  { id: 'hit', label: 'Hit Rate', minSample: MIN_CALLS_FOR_HIT_RATE },
  { id: 'avg', label: 'Average Peak' },
];
export const DEFAULT_RANK = 'best';

export function rankModeById(id) {
  return RANK_MODES.find((m) => m.id === String(id).toLowerCase()) ?? RANK_MODES[0];
}

/**
 * Rank rows deterministically.
 *
 * A caller with NO measured calls sorts last regardless of how many calls they made: they have
 * no performance evidence, and floating them above a caller with real results would
 * misrepresent both.
 *
 * Ties are broken all the way down (measured sample, then key) so the board cannot reshuffle
 * between two identical renders.
 */
export function rankCallers(rows, { mode = DEFAULT_RANK } = {}) {
  const m = rankModeById(mode);
  // A row's value in the CURRENT mode. null when the row has no evidence for that mode.
  const valueOf = (r) => {
    if (r.measuredCalls === 0) return null;
    if (m.id === 'hit') {
      // Below the sample floor the rate is not comparable, so it contributes no value and the
      // row falls back to the other tiebreaks rather than ranking on an unstable number.
      if (r.measuredCalls < (m.minSample ?? 1)) return null;
      return Number.isFinite(r.hitRate) ? r.hitRate : null;
    }
    if (m.id === 'avg') return Number.isFinite(r.averagePeak) ? r.averagePeak : null;
    return Number.isFinite(r.best) ? r.best : null;
  };

  return [...rows].sort((a, b) => {
    const aMeasured = a.measuredCalls > 0;
    const bMeasured = b.measuredCalls > 0;
    if (aMeasured !== bMeasured) return aMeasured ? -1 : 1;

    const av = valueOf(a);
    const bv = valueOf(b);
    const aOk = Number.isFinite(av);
    const bOk = Number.isFinite(bv);
    // A row with no comparable value in this mode sorts below every row that has one. Never
    // treated as 0, which would rank an unknown beneath a genuine poor result.
    if (aOk !== bOk) return aOk ? -1 : 1;
    if (aOk && bOk && av !== bv) return bv - av;

    // Fallbacks make the order total: best call, then hit rate, then sample size, then key.
    const aBest = Number.isFinite(a.best) ? a.best : -1;
    const bBest = Number.isFinite(b.best) ? b.best : -1;
    if (aBest !== bBest) return bBest - aBest;

    const aRate = Number.isFinite(a.hitRate) ? a.hitRate : -1;
    const bRate = Number.isFinite(b.hitRate) ? b.hitRate : -1;
    if (aRate !== bRate) return bRate - aRate;

    if (a.measuredCalls !== b.measuredCalls) return b.measuredCalls - a.measuredCalls;
    return String(a.sortKey).localeCompare(String(b.sortKey));
  });
}

/** Calls in one period, eligibility already applied by the store. */
function inPeriodCalls(calls, period, now) {
  const p = periodById(period);
  const cutoff = now - (p?.ms ?? 0);
  return (calls ?? []).filter((c) => Number.isFinite(c.calledAt) && c.calledAt >= cutoff);
}

/**
 * Build the board for one group.
 *
 * @param {Array} calls  already group-scoped and eligibility-filtered by the store
 */
export function buildLeaderboard(calls, { period = '7d', now = Date.now(), rank = DEFAULT_RANK } = {}) {
  const p = periodById(period);
  const inPeriod = inPeriodCalls(calls, period, now);

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
  const mode = rankModeById(rank);
  return { period: p, rank: mode.id, rows: rankCallers(rows, { mode: mode.id }), totalCalls: inPeriod.length, calls: inPeriod };
}

/** Group-level performance summary - shares the same eligible sample as the board. */
export function buildGroupSummary(calls, { period = '7d', now = Date.now() } = {}) {
  const p = periodById(period);
  const inPeriod = inPeriodCalls(calls, period, now);

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

  // Unique callers over the SAME eligible sample, so the two counts always agree.
  const uniqueCallers = new Set(inPeriod.map((c) => String(c.callerKey ?? 'unknown'))).size;

  return {
    period: p,
    calls: inPeriod.length,
    uniqueCallers,
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
 * The best individual calls in the period, highest peak first.
 *
 * Only MEASURED calls rank here: an unobserved peak has no multiplier to compare, and
 * treating one as 1x (or 0x) would fabricate performance.
 */
export function buildTopCalls(calls, { period = '7d', now = Date.now(), limit = TOP_CALLS } = {}) {
  const inPeriod = inPeriodCalls(calls, period, now);

  const scored = [];
  for (const c of inPeriod) {
    const m = callMetrics(c, now);
    if (!m.peakMeasured || !Number.isFinite(m.peakMultiple)) continue;
    scored.push({
      call: c,
      multiple: m.peakMultiple,
      callerKey: c.callerKey ?? null,
      symbol: c.symbol ?? c.name ?? null,
      chain: c.chain ?? null,
      address: c.address ?? null,
    });
  }

  scored.sort((a, b) => {
    if (b.multiple !== a.multiple) return b.multiple - a.multiple;
    // Stable tiebreak so equal peaks do not shuffle between renders.
    const at = Number(a.call?.calledAt ?? 0);
    const bt = Number(b.call?.calledAt ?? 0);
    if (at !== bt) return at - bt;
    return String(a.callerKey ?? '').localeCompare(String(b.callerKey ?? ''));
  });

  return scored.slice(0, limit);
}

/** Display name for a call row's caller. */
function labelForCall(call) {
  if (!call) return 'caller';
  try {
    return callerLabel(call) ?? call.callerKey ?? 'caller';
  } catch {
    return call.callerKey ?? 'caller';
  }
}

/**
 * Clickable caller name.
 *
 * Reuses the SAME signed, group-scoped token the Caller Profile and alerts use, so a tap
 * opens that caller's private profile for THIS group at the default period. No new
 * authorisation path: if the token format or secret changes, every surface changes
 * together. A mint failure degrades to plain text rather than a broken href.
 */
function callerLink(row, { chatId, botUsername }) {
  const name = row?.label ?? row?.callerKey ?? 'caller';
  if (!chatId || !botUsername || !row?.callerKey) return esc(name);
  try {
    const token = mintCallerToken(String(chatId), row.callerKey, DEFAULT_PERIOD);
    const url = `https://t.me/${encodeURIComponent(botUsername)}?start=${encodeURIComponent(token)}`;
    return `<a href="${url}">${esc(name)}</a>`;
  } catch {
    return esc(name);
  }
}

/** Period selector row. `x` carries the expansion state so both views stay in sync. */
function periodRow(periodId, expanded) {
  return LB_PERIODS.map((p) => ({
    text: p.id === periodId ? `\u2022 ${p.label}` : p.label,
    callback_data: `lb:${p.id}:${expanded ? 1 : 0}`,
  }));
}

/**
 * Render the leaderboard: TOP CALLERS + GROUP STATS + TOP CALLS.
 *
 * All three sections read from the SAME period object, so a period change updates them
 * together. This function fetches nothing - it is a pure render over persisted records.
 */
export function renderLeaderboard({
  groupTitle,
  board,
  summary = null,
  topCalls = [],
  chatId = null,
  botUsername = null,
  expanded = false,
  hitThreshold = HIT_THRESHOLD,
}) {
  const L = [];

  // Derive a summary from the board when the caller did not supply one, so a partial
  // call renders a complete message instead of throwing on an undefined field. The
  // numbers come from the board's own eligible sample, so the two blocks still agree.
  const stats = summary ?? (() => {
    const rows = board?.rows ?? [];
    const measuredRows = rows.filter((r) => r.measuredCalls > 0);
    const measuredTotal = measuredRows.reduce((s2, r) => s2 + r.measuredCalls, 0);
    const hits = measuredRows.reduce((s2, r) => s2 + r.hits, 0);
    const best = measuredRows.reduce((s2, r) => (r.best != null && (s2 == null || r.best > s2) ? r.best : s2), null);
    return {
      period: board?.period ?? null,
      calls: rows.reduce((s2, r) => s2 + r.calls, 0),
      uniqueCallers: rows.length,
      measured: measuredTotal,
      unmeasured: rows.reduce((s2, r) => s2 + r.unmeasuredCalls, 0),
      hits,
      hitRate: measuredTotal ? (hits / measuredTotal) * 100 : null,
      best,
      mean: null,
      median: null,
    };
  })();
  const periodLabel = board.period?.label ?? '';

  L.push('\u{1F3C6} <b>GROUP LEADERBOARD</b>');
  L.push(`\u{1F4C1} ${esc(groupTitle ?? 'This group')} \u00B7 <b>${esc(periodLabel)}</b>`);
  L.push('');

  // ---- TOP CALLERS -------------------------------------------------------
  L.push('\u{1F451} <b>TOP CALLERS</b>');
  if (!board.rows.length) {
    L.push('<i>No calls in this period.</i>');
  } else {
    const limit = expanded ? PAGE_SIZE : TOP_CALLERS_COLLAPSED;
    const shown = board.rows.slice(0, limit);
    shown.forEach((row, i) => {
      const rank = i + 1;
      const medal = rank === 1 ? '\u{1F947}' : rank === 2 ? '\u{1F948}' : rank === 3 ? '\u{1F949}' : `${rank}.`;
      const name = callerLink(row, { chatId, botUsername });
      const perf = row.measuredCalls === 0
        ? 'no measured peak yet'
        : `${fmtPct(row.hitRate)} hit \u00B7 best ${fmtMult(row.best) ?? '\u2014'}`;
      const unobserved = row.unmeasuredCalls > 0 ? ` \u00B7 ${row.unmeasuredCalls} unobserved` : '';
      L.push(`${medal} ${name} \u2014 <b>${row.calls}</b> call${row.calls === 1 ? '' : 's'} \u00B7 ${perf}${unobserved}`);
    });

    const topN = Math.min(board.rows.length, PAGE_SIZE);
    if (!expanded && board.rows.length > TOP_CALLERS_COLLAPSED) {
      L.push(`<i>\u2026${topN - TOP_CALLERS_COLLAPSED} more in the top ${topN}</i>`);
    } else if (expanded && board.rows.length > PAGE_SIZE) {
      L.push(`<i>\u2026${board.rows.length - PAGE_SIZE} more callers</i>`);
    }
  }
  L.push('');

  // ---- GROUP STATS -------------------------------------------------------
  L.push('\u{1F4CA} <b>GROUP STATS</b>');
  L.push(`Period: <b>${esc(periodLabel)}</b>`);
  L.push(`Total calls: <b>${stats.calls}</b>`);
  L.push(`Unique callers: <b>${stats.uniqueCallers}</b>`);
  if (stats.measured) {
    L.push(`Hit rate \u2265${hitThreshold}x: <b>${fmtPct(stats.hitRate)}</b> (${stats.hits}/${stats.measured})`);
    L.push(`Median peak: <b>${fmtMult(stats.median) ?? '\u2014'}</b>`);
    L.push(`Average peak: <b>${fmtMult(stats.mean) ?? '\u2014'}</b>`);
    const bestCall = topCalls[0];
    L.push(`Best call: <b>${fmtMult(stats.best) ?? '\u2014'}</b>${bestCall?.symbol ? ` $${esc(bestCall.symbol)}` : ''}`);
  } else {
    // "No measured peak at all" is a different statement from "zero performance".
    L.push('<i>No call in this period has an observed peak yet, so no performance figures are shown.</i>');
  }
  if (stats.unmeasured) {
    L.push(`<i>${stats.unmeasured} call${stats.unmeasured === 1 ? '' : 's'} without an observed peak</i>`);
  }
  L.push('');

  // ---- TOP CALLS ---------------------------------------------------------
  L.push(`\u{1F525} <b>TOP ${TOP_CALLS} CALLS</b>`);
  if (!topCalls.length) {
    L.push('<i>No measured calls in this period.</i>');
  } else {
    topCalls.forEach((entry, i) => {
      const rank = i + 1;
      const med = rank === 1 ? '\u{1F947}' : rank === 2 ? '\u{1F948}' : rank === 3 ? '\u{1F949}' : `${rank}.`;
      const sym = entry.symbol ? `$${esc(entry.symbol)}` : 'Unknown token';
      // The caller shown is the caller OF THAT CALL, not the leaderboard row.
      const who = callerLink(
        { label: labelForCall(entry.call), callerKey: entry.callerKey },
        { chatId, botUsername },
      );
      L.push(`${med} ${chainEmoji(entry.chain)} ${sym} \u00B7 <b>${fmtMult(entry.multiple)}</b> \u00B7 ${who}`);
    });
  }

  L.push('');
  L.push('<i>Peak = highest observed market cap after the call. This is token performance, not realised trading profit. Losing calls stay in the stats.</i>');

  // ---- keyboard ----------------------------------------------------------
  const keyboard = [periodRow(board.period?.id, expanded)];
  const nav = [];
  if (board.rows.length > TOP_CALLERS_COLLAPSED) {
    nav.push({
      text: expanded ? '\u{1F451} Show top 3' : `\u{1F451} Show top ${Math.min(board.rows.length, PAGE_SIZE)}`,
      callback_data: `lb:${board.period?.id}:${expanded ? 0 : 1}`,
    });
  }
  nav.push({ text: '\u{1F504} Refresh', callback_data: `lb:${board.period?.id}:${expanded ? 1 : 0}` });
  keyboard.push(nav);

  return { text: L.join('\n'), keyboard };
}

/** Render the group performance summary (kept for /gpnl). */
export function renderGroupPnl({ groupTitle, summary, chatId = null, botUsername = null }) {
  const L = [];
  L.push('\u{1F4CA} <b>GROUP PERFORMANCE</b>');
  L.push('');
  L.push(`\u{1F4C1} ${esc(groupTitle ?? 'This group')} \u00B7 ${esc(summary.period?.label ?? '')}`);
  L.push('');

  if (!summary.calls) {
    L.push('<i>No calls in this period.</i>');
    return { text: L.join('\n'), keyboard: [] };
  }

  L.push(`Calls recorded: <b>${summary.calls}</b>`);
  L.push(`Unique callers: <b>${summary.uniqueCallers}</b>`);
  if (summary.measured) {
    L.push(`With an observed peak: <b>${summary.measured}</b>`);
  }
  if (summary.unmeasured) {
    L.push(`Not yet observed: <b>${summary.unmeasured}</b>`);
  }
  L.push('');

  if (summary.measured) {
    L.push(`Best peak: <b>${fmtMult(summary.best) ?? '\u2014'}</b>`);
    L.push(`Median peak: <b>${fmtMult(summary.median) ?? '\u2014'}</b>`);
    L.push(`Hit rate: <b>${fmtPct(summary.hitRate)}</b> \u2265${HIT_THRESHOLD}x (${summary.hits}/${summary.measured})`);
  } else {
    L.push('<i>No call has a measured peak yet, so no performance figures are shown.</i>');
  }

  L.push('');
  L.push('<i>Peak is the highest observed market cap after the call. This is token performance, not realised trading profit.</i>');

  const periodButtons = LB_PERIODS.map((p) => ({
    text: p.id === summary.period?.id ? `\u2022 ${p.label}` : p.label,
    callback_data: `gp:${p.id}`,
  }));
  return { text: L.join('\n'), keyboard: [periodButtons] };
}
