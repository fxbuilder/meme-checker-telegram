/**
 * test/phase6-community.test.mjs
 *
 * Phase 6 — leaderboard, group summary, settings.
 *
 * The honest-ranking rules are the substance here: eligibility, deterministic order,
 * losers retained, unmeasured calls not hidden, and settings that fail closed.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildLeaderboard, buildGroupSummary, summariseCaller, rankCallers,
  renderLeaderboard, renderGroupPnl,
} from '../src/leaderboard.mjs';
import { renderSettings } from '../src/settings-commands.mjs';

const NOW = Date.UTC(2026, 10, 24, 12, 0, 0);
const HOUR = 3600_000;

const call = (callerKey, symbol, hoursAgo, peakMultiple, { entry = 100, status = 'active' } = {}) => ({
  callerKey,
  callerName: callerKey.replace('u:', 'User '),
  symbol,
  name: symbol,
  calledAt: NOW - hoursAgo * HOUR,
  entryMarketCapUsd: entry,
  peakMarketCapUsd: peakMultiple === null ? null : entry * peakMultiple,
  currentMarketCapUsd: peakMultiple === null ? null : entry * peakMultiple,
  peakObservedAt: peakMultiple === null ? null : NOW - 60_000,
  lastObservedAt: peakMultiple === null ? null : NOW - 60_000,
  status,
});

// ---- eligibility ---------------------------------------------------------

test('losers stay in the sample; winners are not the whole history', () => {
  const board = buildLeaderboard([
    call('u:1', 'WIN', 1, 10),
    call('u:1', 'LOSS', 2, 0.4),
  ], { period: '7d', now: NOW });
  const row = board.rows[0];
  assert.equal(row.calls, 2, 'the losing call is counted');
  assert.equal(row.hitRate, 50, 'one of two cleared 2x');
});

test('an unmeasured call is eligible but reported as unmeasured, not dropped', () => {
  const board = buildLeaderboard([
    call('u:1', 'A', 1, 3),
    call('u:1', 'B', 2, null),
  ], { period: '7d', now: NOW });
  const row = board.rows[0];
  assert.equal(row.calls, 2);
  assert.equal(row.measuredCalls, 1);
  assert.equal(row.unmeasuredCalls, 1);

  const text = renderLeaderboard({ groupTitle: 'g', board }).text;
  assert.match(text, /not yet observed/i);
});

test('a caller with no measured calls sorts below one with evidence', () => {
  const rows = rankCallers([
    summariseCaller([call('u:Y', 'Q', 1, null)], { now: NOW }),
    summariseCaller([call('u:X', 'P', 1, 4)], { now: NOW }),
  ]);
  assert.equal(rows[0].callerKey, 'u:X', 'real performance outranks no evidence');
  assert.equal(rows[1].measuredCalls, 0);
});

test('calls outside the period are excluded', () => {
  const board = buildLeaderboard([
    call('u:1', 'RECENT', 2, 5),
    call('u:1', 'OLD', 24 * 20, 100),
  ], { period: '7d', now: NOW });
  assert.equal(board.rows[0].calls, 1, 'the 20-day-old call is outside 7D');
  assert.equal(board.totalCalls, 1);
});

test('period filters change the sample', () => {
  const calls = [
    call('u:1', 'A', 30, 5),        // 30 hours ago: inside 7D, outside 1D
    call('u:1', 'B', 24 * 10, 5),   // 10 days ago: only inside 30D
  ];
  assert.equal(buildLeaderboard(calls, { period: '1d', now: NOW }).totalCalls, 0);
  assert.equal(buildLeaderboard(calls, { period: '7d', now: NOW }).totalCalls, 1);
  assert.equal(buildLeaderboard(calls, { period: '30d', now: NOW }).totalCalls, 2);
});

// ---- ordering ------------------------------------------------------------

test('ordering is deterministic across identical runs', () => {
  const calls = [
    call('u:b', 'A', 1, 5),
    call('u:a', 'B', 1, 5),
    call('u:c', 'C', 1, 5),
  ];
  const first = buildLeaderboard(calls, { period: '7d', now: NOW }).rows.map((r) => r.callerKey);
  const second = buildLeaderboard(calls, { period: '7d', now: NOW }).rows.map((r) => r.callerKey);
  assert.deepEqual(first, second, 'the same input must produce the same order');
});

test('ties break on best peak, then volume, then key — never randomly', () => {
  const rows = rankCallers([
    summariseCaller([call('u:c', 'A', 1, 2), call('u:c', 'B', 2, 2)], { now: NOW }),
    summariseCaller([call('u:b', 'C', 1, 9)], { now: NOW }),
    summariseCaller([call('u:a', 'D', 1, 2), call('u:a', 'E', 2, 2)], { now: NOW }),
  ]);
  // All have 100% hit rate; b has the best peak, a and c tie on peak and volume so
  // the key decides.
  assert.equal(rows[0].callerKey, 'u:b');
  assert.deepEqual(rows.slice(1).map((r) => r.callerKey), ['u:a', 'u:c']);
});

test('hit rate outranks best peak', () => {
  const rows = rankCallers([
    summariseCaller([call('u:streaky', 'A', 1, 20), call('u:streaky', 'B', 2, 0.5), call('u:streaky', 'C', 3, 0.5)], { now: NOW }),
    summariseCaller([call('u:steady', 'D', 1, 3), call('u:steady', 'E', 2, 3)], { now: NOW }),
  ]);
  assert.equal(rows[0].callerKey, 'u:steady', '67% consistent beats 33% with one outlier');
});

// ---- rendering -----------------------------------------------------------

test('every performance number carries its sample size', () => {
  const board = buildLeaderboard([call('u:1', 'A', 1, 5), call('u:2', 'B', 1, 0.5)], { period: '7d', now: NOW });
  const text = renderLeaderboard({ groupTitle: 'sissooo1', board }).text;
  assert.match(text, /2 callers · 2 calls/);
  assert.match(text, /not realised trading profit/i);
  assert.match(text, /Losers are included/i);
});

test('an empty board says so instead of showing a zero-filled table', () => {
  const text = renderLeaderboard({ groupTitle: 'g', board: buildLeaderboard([], { period: '7d', now: NOW }) }).text;
  assert.match(text, /No calls in this period/i);
});

test('pagination pages the rows and clamps out-of-range pages', () => {
  const calls = Array.from({ length: 25 }, (_, i) => call(`u:${String(i).padStart(2, '0')}`, `T${i}`, 1, 2 + i / 100));
  const board = buildLeaderboard(calls, { period: '7d', now: NOW });
  const out = renderLeaderboard({ groupTitle: 'g', board, page: 99 });
  assert.match(out.text, /page 3\/3/, 'an out-of-range page clamps to the last page');
});

test('the period buttons mark the active period', () => {
  const board = buildLeaderboard([call('u:1', 'A', 1, 5)], { period: '7d', now: NOW });
  const out = renderLeaderboard({ groupTitle: 'g', board });
  const labels = out.keyboard[0].map((b) => b.text);
  assert.ok(labels.some((l) => l.startsWith('• 1W')), 'the selected period is marked');
  assert.ok(out.keyboard[0].every((b) => b.callback_data.startsWith('lb:')), 'period buttons are callbacks');
});

// ---- group summary -------------------------------------------------------

test('the group summary shares the same eligible sample', () => {
  const calls = [call('u:1', 'A', 1, 5), call('u:2', 'B', 2, null), call('u:3', 'C', 24 * 40, 100)];
  const s = buildGroupSummary(calls, { period: '7d', now: NOW });
  assert.equal(s.calls, 2, 'the 40-day-old call is outside 7D');
  assert.equal(s.measured, 1);
  assert.equal(s.unmeasured, 1);
  assert.equal(s.hitRate, 100);
});

test('an unmeasured group reports no figures rather than zeros', () => {
  const s = buildGroupSummary([call('u:1', 'A', 1, null)], { period: '7d', now: NOW });
  assert.equal(s.measured, 0);
  assert.equal(s.mean, null);
  const text = renderGroupPnl({ groupTitle: 'g', summary: s }).text;
  assert.match(text, /no performance figures are shown/i);
  assert.ok(!/Best peak: <b>0/.test(text));
});

// ---- settings ------------------------------------------------------------

test('settings render read-only for an unauthorised member and with no buttons', () => {
  const out = renderSettings({
    groupTitle: 'sissooo1',
    settings: { autoCall: 'manual', alertsEnabled: true, milestones: [2, 5, 10] },
    canEdit: false,
    reason: 'Only the group owner can change these settings.',
  });
  assert.match(out.text, /Only the group owner/i);
  assert.equal(out.keyboard.length, 0, 'no controls are offered to someone who cannot use them');
});

test('settings show the real current state', () => {
  const out = renderSettings({
    groupTitle: 'sissooo1',
    settings: { autoCall: 'auto', alertsEnabled: false, milestones: [2, 5] },
    canEdit: true,
  });
  assert.match(out.text, /Call mode: <b>Auto<\/b>/);
  assert.match(out.text, /Alerts: <b>Off<\/b>/);
  assert.ok(out.keyboard.length > 0, 'an authorised user gets controls');
});

test('group titles are HTML-escaped', () => {
  const out = renderSettings({
    groupTitle: '<script>x</script>', settings: { autoCall: 'manual' }, canEdit: false,
  });
  assert.ok(!/<script>/.test(out.text));
});
