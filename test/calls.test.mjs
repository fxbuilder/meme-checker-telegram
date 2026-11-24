/**
 * test/calls.test.mjs
 * Phase 2: store durability, entry validation, peak-vs-ATH correctness,
 * attribution, dedup, migration detection and PnL maths.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { CallStore, migrate, normaliseAddress, defaultGroupSettings } from '../src/store.mjs';
import {
  validateEntry, roiMultiple, multipleToPercent, nextPeak, detectMigration,
  timeSince, buildCallRecord, callMetrics, fmtMultiple, fmtSignedPercent,
} from '../src/calls.mjs';
import { recordCall, observeCall, CALL_STATUS, resolveCall } from '../src/call-service.mjs';
import { renderPnlText, renderPnlSvg, roiTone } from '../src/pnl-card.mjs';
import { buildPnlPayload } from '../src/pnl-render.mjs';

const CHAT = '-100123';
const CA = '0x0e09fabb73bd3ade0a17ecc321fd13a19e81ce82';

/** Fresh store in a temp dir. */
function tmpStore() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-calls-'));
  return new CallStore(path.join(dir, 'calls.json'));
}

function okScan(over = {}) {
  return {
    mode: 'live', status: 'ok',
    token: { chain: 'bsc', address: CA, name: 'Cake', symbol: 'CAKE' },
    market: {
      priceUsd: 1.5, marketCapUsd: 5_000_000, fdvUsd: 5_200_000,
      liquidityUsd: 400_000, volume24hUsd: 90_000,
      priceChange24h: 3, priceChange1h: 0.5, pairAge: '1mo',
    },
    riskStatus: 'ok', holders: null, narrative: null,
    project: { website: null, x: null, telegram: null },
    source: { provider: 'dexscreener', pairs: 3, pairAddress: 'PAIR-A' },
    ...over,
  };
}

const caller = { id: 42, displayName: 'Foxy', username: 'foxy' };

// ---- Store: durability and migration -------------------------------------

test('a missing store file loads as empty without throwing', () => {
  const s = tmpStore().load();
  assert.equal(s.doc.calls.length, 0);
  assert.equal(s.doc.schemaVersion, 1);
});

test('calls survive a restart (new store instance, same file)', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-calls-'));
  const file = path.join(dir, 'calls.json');

  const a = new CallStore(file);
  const rec = await recordCall({
    store: a, scanResult: okScan(), caller, chatId: CHAT, source: 'manual', now: Date.now(),
  });
  assert.equal(rec.status, CALL_STATUS.RECORDED);

  // Simulate a bot restart: brand-new instance reading the same file.
  const b = new CallStore(file);
  const calls = b.callsForChat(CHAT);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].callerUsername, 'foxy');
  assert.equal(calls[0].entryMarketCapUsd, 5_000_000);
});

test('a corrupt file is quarantined and the store starts clean', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-calls-'));
  const file = path.join(dir, 'calls.json');
  fs.writeFileSync(file, '{ this is not json', 'utf8');
  const s = new CallStore(file).load();
  assert.equal(s.doc.calls.length, 0);
  const quarantined = fs.readdirSync(dir).filter((f) => f.includes('.corrupt-'));
  assert.equal(quarantined.length, 1, 'original bytes must be preserved');
});

test('an older schema is migrated rather than rejected', () => {
  const { doc, migrated } = migrate({ calls: [{ id: 'c1' }], groups: undefined, schemaVersion: 0 });
  assert.equal(migrated, true);
  assert.equal(doc.schemaVersion, 1);
  assert.equal(doc.calls.length, 1);
  assert.deepEqual(doc.groups, {});
});

test('a newer schema is refused instead of being silently downgraded', () => {
  assert.throws(() => migrate({ schemaVersion: 99, calls: [] }), /newer than this build/);
});

test('writes are atomic: no .tmp file is left behind', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-calls-'));
  const file = path.join(dir, 'calls.json');
  const s = new CallStore(file);
  await recordCall({ store: s, scanResult: okScan(), caller, chatId: CHAT });
  assert.ok(fs.existsSync(file));
  assert.ok(!fs.existsSync(`${file}.tmp`), 'temp file must be renamed away');
});

test('concurrent writes do not lose records', async () => {
  const s = tmpStore();
  await Promise.all(Array.from({ length: 10 }, (_, i) => recordCall({
    store: s,
    scanResult: okScan({ token: { chain: 'bsc', address: `0x${String(i).padStart(40, 'a')}`, name: 'T', symbol: 'T' } }),
    caller: { id: 100 + i, displayName: `u${i}`, username: `u${i}` },
    chatId: CHAT,
  })));
  assert.equal(s.callsForChat(CHAT, { limit: 100 }).length, 10);
});

// ---- Entry validation ----------------------------------------------------

test('a failed scan can never be recorded as an entry', () => {
  for (const status of ['not-found', 'api-error', 'rate-limited', 'invalid-response', 'chain-unsupported']) {
    const v = validateEntry({ status });
    assert.equal(v.ok, false, `${status} must be rejected`);
  }
});

test('a token with no market cap is rejected, never given a fake entry', () => {
  const v = validateEntry(okScan({ market: { ...okScan().market, marketCapUsd: null } }));
  assert.equal(v.ok, false);
  assert.match(v.reason, /no market cap/);
});

test('FDV is never substituted for a missing market cap', () => {
  const v = validateEntry(okScan({ market: { ...okScan().market, marketCapUsd: null, fdvUsd: 9_999_999 } }));
  assert.equal(v.ok, false);
});

test('implausible provider values are rejected as entries', () => {
  assert.equal(validateEntry(okScan({ market: { ...okScan().market, marketCapUsd: 1e13 } })).ok, false);
  assert.equal(validateEntry(okScan({ market: { ...okScan().market, priceChange24h: 5000 } })).ok, false);
  assert.equal(validateEntry(okScan({ market: { ...okScan().market, volume24hUsd: 5_000_000_000 } })).ok, false);
});

test('a valid scan yields a normalised entry', () => {
  const v = validateEntry(okScan());
  assert.equal(v.ok, true);
  assert.equal(v.entry.address, CA);
  assert.equal(v.entry.entryMarketCapUsd, 5_000_000);
  assert.equal(v.entry.entryPairAddress, 'PAIR-A');
});

// ---- Peak vs ATH: the central correctness rule ---------------------------

test('peak starts at entry and never comes from pre-call history', () => {
  const call = buildCallRecord({
    chatId: CHAT, userId: 1, displayName: 'a', username: 'a',
    entry: { chain: 'bsc', address: CA, displayName: CA, name: 'Cake', symbol: 'CAKE', entryMarketCapUsd: 2_000_000, entryPriceUsd: 1, entryLiquidityUsd: 100, entryPairAddress: 'P' },
    now: 1000,
  });
  assert.equal(call.peakMarketCapUsd, 2_000_000, 'peak must baseline at entry, not at some historical ATH');
  const m = callMetrics(call);
  assert.equal(m.peakIsObserved, false, 'no observation above entry yet');
});

test('a peak can only move upward', () => {
  const call = { entryMarketCapUsd: 1_000_000, peakMarketCapUsd: 3_000_000, calledAt: 0, peakAt: 500 };
  const down = nextPeak(call, 2_000_000, { now: 900 });
  assert.equal(down.changed, false);
  assert.equal(down.peakMarketCapUsd, 3_000_000);
  const up = nextPeak(call, 4_000_000, { now: 900 });
  assert.equal(up.changed, true);
  assert.equal(up.peakMarketCapUsd, 4_000_000);
});

test('an implausible jump is not trusted as a peak', () => {
  const call = { entryMarketCapUsd: 1_000_000, peakMarketCapUsd: 1_000_000, calledAt: 0 };
  const r = nextPeak(call, 900_000_000, { now: 100 }); // 900x in one tick
  assert.equal(r.changed, false);
  assert.match(r.rejected, /implausible jump/);
  assert.equal(r.peakMarketCapUsd, 1_000_000);
});

test('a drawdown below entry never becomes a peak', () => {
  const call = { entryMarketCapUsd: 5_000_000, peakMarketCapUsd: 5_000_000, calledAt: 0 };
  const r = nextPeak(call, 400_000, { now: 10 });
  assert.equal(r.peakMarketCapUsd, 5_000_000);
  assert.equal(r.changed, false);
});

// ---- Migration / abnormal conditions -------------------------------------

test('a changed primary pool is flagged as possible migration', () => {
  const call = { entryPairAddress: 'PAIR-A', entryLiquidityUsd: 400_000 };
  const r = detectMigration(call, okScan({ source: { pairAddress: 'PAIR-B' } }));
  assert.equal(r.migrated, true);
  assert.equal(r.pairChanged, true);
});

test('a liquidity collapse is flagged even if the pair address is unchanged', () => {
  const call = { entryPairAddress: 'PAIR-A', entryLiquidityUsd: 400_000 };
  const r = detectMigration(call, okScan({ market: { ...okScan().market, liquidityUsd: 1_000 } }));
  assert.equal(r.migrated, true);
  assert.equal(r.liquidityCollapsed, true);
});

test('a stable pool is not flagged', () => {
  const call = { entryPairAddress: 'PAIR-A', entryLiquidityUsd: 400_000 };
  const r = detectMigration(call, okScan());
  assert.equal(r.migrated, false);
});

// ---- Attribution and duplicates ------------------------------------------

test('the first caller keeps attribution when someone else calls later', async () => {
  const s = tmpStore();
  const first = await recordCall({ store: s, scanResult: okScan(), caller, chatId: CHAT, now: Date.now() });
  assert.equal(first.isFirstCall, true);

  const second = await recordCall({
    store: s, scanResult: okScan(),
    caller: { id: 99, displayName: 'Other', username: 'other' },
    chatId: CHAT, now: Date.now() + 1000,
  });
  assert.equal(second.isFirstCall, false);
  assert.equal(second.firstCall.callerUsername, 'foxy', 'the first caller must not be replaced');

  // Persisted attribution agrees.
  const fc = s.firstCall(CHAT, 'bsc', CA);
  assert.equal(fc.callerId, '42');
});

test('the same caller cannot double-record the same token inside the window', async () => {
  const s = tmpStore();
  const a = await recordCall({ store: s, scanResult: okScan(), caller, chatId: CHAT, now: 1000 });
  const b = await recordCall({ store: s, scanResult: okScan(), caller, chatId: CHAT, now: 2000, duplicateWindowMs: 60_000 });
  assert.equal(a.status, CALL_STATUS.RECORDED);
  assert.equal(b.status, CALL_STATUS.DUPLICATE);
  assert.equal(s.callsForChat(CHAT).length, 1, 'only one record');
});

test('a legitimate re-call after the dedup window IS recorded', async () => {
  const s = tmpStore();
  await recordCall({ store: s, scanResult: okScan(), caller, chatId: CHAT, now: 1_000_000 });
  const b = await recordCall({ store: s, scanResult: okScan(), caller, chatId: CHAT, now: 1_000_000 + 20 * 60_000, duplicateWindowMs: 10 * 60_000 });
  assert.equal(b.status, CALL_STATUS.RECORDED);
  assert.equal(b.isFirstCall, false, 'but it is not the first call');
});

test('calls are isolated per group', async () => {
  const s = tmpStore();
  await recordCall({ store: s, scanResult: okScan(), caller, chatId: '-100AAA' });
  assert.equal(s.callsForChat('-100BBB').length, 0);
  assert.equal(s.firstCall('-100BBB', 'bsc', CA), null);
});

test('a below-minimum market cap is refused with a reason', async () => {
  const s = tmpStore();
  await s.setGroupSetting(CHAT, { minMarketCapUsd: 1_000_000 });
  const out = await recordCall({
    store: s, scanResult: okScan({ market: { ...okScan().market, marketCapUsd: 50_000 } }),
    caller, chatId: CHAT,
  });
  assert.equal(out.status, CALL_STATUS.LOW_MCAP);
  assert.match(out.reason, /below this group's/);
  assert.equal(s.callsForChat(CHAT).length, 0);
});

test('EVM address casing does not split identity', async () => {
  const s = tmpStore();
  await recordCall({ store: s, scanResult: okScan(), caller, chatId: CHAT, now: 1 });
  const upper = { ...okScan(), token: { chain: 'bsc', address: CA.toUpperCase().replace('0X', '0x'), name: 'Cake', symbol: 'CAKE' } };
  const second = await recordCall({ store: s, scanResult: upper, caller: { id: 7, displayName: 'x', username: 'x' }, chatId: CHAT, now: 5000 });
  assert.equal(second.isFirstCall, false, 'same token despite casing');
});

test('Solana addresses stay case-sensitive', () => {
  const a = 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263';
  assert.equal(normaliseAddress('solana', a), a);
  assert.notEqual(normaliseAddress('solana', a), a.toLowerCase());
  assert.equal(normaliseAddress('bsc', CA.toUpperCase()), CA.toLowerCase());
});

// ---- Observation ---------------------------------------------------------

test('observation updates current and peak from a valid scan', async () => {
  const s = tmpStore();
  const rec = await recordCall({ store: s, scanResult: okScan(), caller, chatId: CHAT, now: 1000 });
  const obs = await observeCall({
    store: s, call: rec.call,
    scanResult: okScan({ market: { ...okScan().market, marketCapUsd: 12_000_000 } }),
    now: 5000,
  });
  assert.equal(obs.updated, true);
  assert.equal(obs.call.lastMarketCapUsd, 12_000_000);
  assert.equal(obs.call.peakMarketCapUsd, 12_000_000);
  assert.equal(obs.peakChanged, true);
});

test('a failed observation changes nothing (not a zero price)', async () => {
  const s = tmpStore();
  const rec = await recordCall({ store: s, scanResult: okScan(), caller, chatId: CHAT, now: 1000 });
  const obs = await observeCall({ store: s, call: rec.call, scanResult: { status: 'api-error' }, now: 5000 });
  assert.equal(obs.updated, false);
  const after = s.firstCall(CHAT, 'bsc', CA);
  assert.equal(after.lastMarketCapUsd, 5_000_000, 'must keep the last good value');
});

// ---- PnL maths -----------------------------------------------------------

test('ROI maths and formatting', () => {
  assert.equal(roiMultiple(1_000_000, 2_500_000), 2.5);
  assert.equal(multipleToPercent(2.5), 150);
  assert.equal(roiMultiple(0, 100), null, 'zero entry is unusable');
  assert.equal(roiMultiple(1_000_000, null), null);
  assert.equal(fmtMultiple(2.5), '2.50x');
  assert.equal(fmtMultiple(12.34), '12.3x');
  assert.equal(fmtMultiple(250), '250x');
  assert.equal(fmtSignedPercent(150), '+150.0%');
  assert.equal(fmtSignedPercent(-40), '-40.0%');
});

test('a call with no post-entry observation reports unknown, not 1.0x', () => {
  const call = {
    entryMarketCapUsd: 1_000_000, lastMarketCapUsd: 1_000_000,
    peakMarketCapUsd: 1_000_000, calledAt: Date.now() - 60_000,
  };
  const m = callMetrics(call);
  assert.equal(m.currentMultiple, 1);
  assert.equal(m.peakIsObserved, false);
  const text = renderPnlText(call);
  assert.ok(/no higher observation since call/.test(text));
});

test('drawdown from peak is computed only when a peak was observed', () => {
  const m = callMetrics({
    entryMarketCapUsd: 1_000_000, lastMarketCapUsd: 2_000_000,
    peakMarketCapUsd: 4_000_000, calledAt: 0,
  });
  assert.equal(m.peakIsObserved, true);
  assert.equal(Math.round(m.drawdownFromPeak), -50);
});

// ---- PnL cards -----------------------------------------------------------

test('PnL text card states the ATH caveat and is escaped', () => {
  const call = {
    chain: 'solana', address: 'DezX', name: '<script>x</script>', symbol: 'A&B',
    callerUsername: 'foxy', entryMarketCapUsd: 1e6, lastMarketCapUsd: 3e6,
    peakMarketCapUsd: 4e6, calledAt: Date.now() - 3600_000,
  };
  const t = renderPnlText(call);
  assert.ok(!t.includes('<script>'), 'must be escaped');
  assert.ok(/not realized profit/.test(t));
  assert.ok(/not all-time high/.test(t));
  assert.ok(/since call/.test(t));
});

test('PnL SVG is well-formed and carries the same caveat', () => {
  const call = {
    chain: 'bsc', address: CA, name: 'Cake', symbol: 'CAKE', callerName: 'Foxy',
    entryMarketCapUsd: 1e6, lastMarketCapUsd: 2e6, peakMarketCapUsd: 3e6,
    calledAt: Date.now() - 7200_000,
  };
  const svg = renderPnlSvg(call);
  assert.ok(svg.startsWith('<svg'));
  assert.ok(svg.trim().endsWith('</svg>'));
  assert.ok(/not all-time high/.test(svg));
  // Unbalanced tags would break rasterisers.
  const opens = (svg.match(/<text/g) ?? []).length;
  const closes = (svg.match(/<\/text>/g) ?? []).length;
  assert.equal(opens, closes);
});

test('the PNG payload matches the text card numbers', () => {
  const call = {
    chain: 'bsc', address: CA, name: 'Cake', symbol: 'CAKE', callerUsername: 'foxy',
    entryMarketCapUsd: 1_000_000, lastMarketCapUsd: 4_000_000,
    peakMarketCapUsd: 6_000_000, calledAt: Date.now() - 3600_000,
  };
  const p = buildPnlPayload(call);
  assert.equal(p.entryMarketCap, '$1.00M');
  assert.equal(p.currentMarketCap, '$4.00M');
  assert.equal(p.multipleLabel, '4.00x');
  assert.equal(p.percent, '+300.0%');
  assert.equal(p.peakIsObserved, true);
  assert.equal(p.caller, '@foxy');
});

test('ROI tone thresholds are sane', () => {
  assert.equal(roiTone(3).label, 'up');
  assert.equal(roiTone(1).label, 'flat');
  assert.equal(roiTone(0.3).label, 'down-big');
  assert.equal(roiTone(null).label, 'unknown');
});

// ---- resolveCall ---------------------------------------------------------

test('resolveCall handles bare, indexed and address lookups', async () => {
  const s = tmpStore();
  await recordCall({ store: s, scanResult: okScan(), caller, chatId: CHAT, now: 1000 });
  await recordCall({
    store: s,
    scanResult: okScan({ token: { chain: 'bsc', address: `0x${'b'.repeat(40)}`, name: 'Other', symbol: 'OTH' } }),
    caller: { id: 7, displayName: 'o', username: 'o' }, chatId: CHAT, now: 2000,
  });

  assert.ok(resolveCall(s, CHAT, {}), 'bare resolves to newest');
  assert.equal(resolveCall(s, CHAT, { index: 1 }).symbol, 'OTH', 'index 1 is newest');
  assert.equal(resolveCall(s, CHAT, { index: 2 }).symbol, 'CAKE');
  const byAddr = resolveCall(s, CHAT, { chain: 'bsc', address: CA });
  assert.equal(byAddr.symbol, 'CAKE');
});

test('time-since formatting', () => {
  const now = 10_000_000_000;
  assert.equal(timeSince(now - 30_000, now), 'just now');
  assert.equal(timeSince(now - 5 * 60_000, now), '5m');
  assert.equal(timeSince(now - 90 * 60_000, now), '1h 30m');
  assert.equal(timeSince(now - 26 * 3600_000, now), '1d 2h');
});

// ---- Synthetic isolation -------------------------------------------------

test('synthetic records are tagged and filterable from real stats', async () => {
  const { isSynthetic, SYNTHETIC_FLAG } = await import('../src/store.mjs');
  const s = tmpStore();
  await recordCall({ store: s, scanResult: okScan(), caller, chatId: CHAT, source: 'manual' });
  await s.addCall({
    chatId: CHAT, callerId: 'sim', chain: 'bsc', address: `0x${'c'.repeat(40)}`,
    entryMarketCapUsd: 1, status: 'active', source: SYNTHETIC_FLAG, calledAt: Date.now(),
  });
  const all = s.callsForChat(CHAT, { limit: 50 });
  assert.equal(all.length, 2);
  assert.equal(all.filter((c) => !isSynthetic(c)).length, 1);
});

// ---- Observer (Phase 3 substrate) ---------------------------------------

test('crossedMilestone only reports at or above 2x', async () => {
  const { crossedMilestone, MILESTONES } = await import('../src/call-observer.mjs');
  assert.equal(crossedMilestone(1.9), null);
  assert.equal(crossedMilestone(2), 2);
  assert.equal(crossedMilestone(4.4), 3);
  assert.equal(crossedMilestone(4.6), 3);
  assert.equal(crossedMilestone(7), 5);
  assert.equal(crossedMilestone(120), 100);
  assert.equal(crossedMilestone(null), null);
  assert.deepEqual(MILESTONES, [2, 3, 5, 10, 25, 50, 100]);
});

test('observePass updates calls and emits a milestone event once', async () => {
  const { observePass } = await import('../src/call-observer.mjs');
  const s = tmpStore();
  const rec = await recordCall({ store: s, scanResult: okScan(), caller, chatId: CHAT, now: 1000 });

  const scan = async () => okScan({ market: { ...okScan().market, marketCapUsd: 11_000_000 } }); // 2.2x
  const pass = await observePass({ store: s, scan, now: 2000, perCallCooldownMs: 0 });

  assert.equal(pass.observed, 1);
  assert.ok(pass.events.some((e) => e.type === 'milestone' && e.milestone === 2));
  const after = s.callsForChat(CHAT)[0];
  assert.equal(after.peakMarketCapUsd, 11_000_000);
});

test('observePass writes nothing when the provider fails', async () => {
  const { observePass } = await import('../src/call-observer.mjs');
  const s = tmpStore();
  await recordCall({ store: s, scanResult: okScan(), caller, chatId: CHAT, now: 1000 });
  const pass = await observePass({ store: s, scan: async () => ({ status: 'api-error' }), now: 2000, perCallCooldownMs: 0 });
  assert.equal(pass.observed, 0);
  assert.equal(pass.failed, 1);
  assert.equal(s.callsForChat(CHAT)[0].lastMarketCapUsd, 5_000_000, 'last good value preserved');
});

test('observePass respects the per-call cooldown', async () => {
  const { observePass } = await import('../src/call-observer.mjs');
  const s = tmpStore();
  await recordCall({ store: s, scanResult: okScan(), caller, chatId: CHAT, now: 1000 });
  // lastObservedAt is ~now, so a 5 min cooldown should skip it immediately.
  const pass = await observePass({ store: s, scan: async () => okScan(), now: 1500, perCallCooldownMs: 300_000 });
  assert.equal(pass.observed, 0);
  assert.ok(pass.skipped >= 1);
});

test('observePass observes one token once even with several calls on it', async () => {
  const { observePass } = await import('../src/call-observer.mjs');
  const s = tmpStore();
  await recordCall({ store: s, scanResult: okScan(), caller, chatId: CHAT, now: 1000 });
  await recordCall({ store: s, scanResult: okScan(), caller: { id: 77, displayName: 'b', username: 'b' }, chatId: CHAT, now: 1100 });

  let calls = 0;
  const scan = async () => { calls += 1; return okScan({ market: { ...okScan().market, marketCapUsd: 6_000_000 } }); };
  const pass = await observePass({ store: s, scan, now: 2000, perCallCooldownMs: 0 });

  assert.equal(calls, 1, 'one provider request for the shared token');
  assert.equal(pass.observed, 2, 'but both call records are updated');
});

test('observePass ignores synthetic and cancelled calls', async () => {
  const { observePass } = await import('../src/call-observer.mjs');
  const s = tmpStore();
  await s.addCall({
    chatId: String(CHAT), callerId: 'sim', chain: 'bsc', address: `0x${'e'.repeat(40)}`,
    entryMarketCapUsd: 1e6, peakMarketCapUsd: 1e6, lastMarketCapUsd: 1e6,
    status: 'active', source: 'synthetic', calledAt: 1000,
  });
  await s.addCall({
    chatId: String(CHAT), callerId: '9', chain: 'bsc', address: `0x${'f'.repeat(40)}`,
    entryMarketCapUsd: 1e6, status: 'cancelled', source: 'manual', calledAt: 1000,
  });
  const pass = await observePass({ store: s, scan: async () => okScan(), now: 2000, perCallCooldownMs: 0 });
  assert.equal(pass.observed, 0);
});
