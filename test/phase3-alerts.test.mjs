/**
 * test/phase3-alerts.test.mjs
 *
 * Phase 3 cover: milestone detection, consolidation, dedupe, persistence,
 * Dex Paid transitions, migration gating, movement windows, delivery failures.
 *
 * No network, no Telegram: `scan` and `send` are injected.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { CallStore, isActive } from '../src/store.mjs';
import { recordCall } from '../src/call-service.mjs';
import { resolveCaller } from '../src/caller-identity.mjs';
import {
  eventId, highestReachedMilestone, renderMilestoneAlert, renderDexPaidAlert,
  renderMigrationAlert, renderMovementAlert, ALL_MILESTONES, retryAfterMs,
} from '../src/alerts.mjs';
import {
  deliverAlert, processMilestoneEvents, processDexPaid, processMigration, processMovement,
} from '../src/alert-service.mjs';
import { runCycle, detectMovement, mapBounded, backoffMs, sleep } from '../src/observer-loop.mjs';

const CA = 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263';
const GROUP = '-5333984336';
const OTHER = '-1009999999999';

function tmpStore() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-p3-'));
  return new CallStore(path.join(dir, 'calls.json'));
}

const scanAt = (mcap, chain = 'solana', address = CA) => ({
  status: 'ok',
  token: { chain, address, name: 'Bonk', symbol: 'BONK' },
  market: { marketCapUsd: mcap, liquidityUsd: 200_000, priceUsd: mcap / 1e12 },
  media: {},
});

const caller = resolveCaller({ from: { id: 1, first_name: 'Foxy', username: 'foxy' } }, { id: Number(GROUP) });

async function seedCall(store, { chatId = GROUP, entry = 1_000_000, now = Date.now(), source = 'auto' } = {}) {
  const rec = await recordCall({
    store, caller, chatId, source, messageId: 77,
    scanResult: scanAt(entry),
    now,
  });
  return rec.call;
}

function recorder() {
  const sent = [];
  const send = async ({ chatId, text, replyToMessageId }) => {
    sent.push({ chatId, text, replyToMessageId });
    return { message_id: sent.length };
  };
  return { sent, send };
}

// ---- milestone maths ------------------------------------------------------

test('highestReachedMilestone picks the highest enabled milestone reached', () => {
  assert.equal(highestReachedMilestone(1.9, [2, 5]), null);
  assert.equal(highestReachedMilestone(2, [2, 5]), 2);
  assert.equal(highestReachedMilestone(7.4, [2, 5, 10]), 5);
  assert.equal(highestReachedMilestone(120, [2, 5, 10, 20, 50, 100]), 100);
  // A milestone the group did NOT enable is not reported.
  assert.equal(highestReachedMilestone(7.4, [2, 10]), 2);
  assert.equal(highestReachedMilestone(NaN, [2]), null);
});

test('every documented milestone is supported', () => {
  for (const m of [2, 2.5, 3, 5, 10, 20, 30, 50, 100, 250, 500, 1000]) {
    assert.ok(ALL_MILESTONES.includes(m), `${m}x missing`);
  }
});

// ---- the alert message ----------------------------------------------------

test('the milestone message uses real stored values and the documented layout', async () => {
  const store = tmpStore();
  const call = await seedCall(store, { entry: 100_000 });
  const text = renderMilestoneAlert({ call, milestone: 5, currentMarketCapUsd: 500_000, groupTitle: 'sissooo1' });

  assert.match(text, /JUST HIT 5X/);
  assert.match(text, /Entry MC: <b>\$100\.00K<\/b>/);
  assert.match(text, /Current MC: <b>\$500\.00K<\/b>/);
  assert.match(text, /Return: <b>5\.00x<\/b>/);
  assert.match(text, /Called by <b>Foxy<\/b>/);
  assert.match(text, /Powered by MEME CHECKER/);
});

test('a hostile token symbol is escaped in the alert', async () => {
  const store = tmpStore();
  const call = await seedCall(store);
  const hostile = { ...call, symbol: '<script>x</script>' };
  const text = renderMilestoneAlert({ hostile, milestone: 2, currentMarketCapUsd: 2e6, call: hostile });
  assert.ok(!text.includes('<script>'));
  assert.ok(text.includes('&lt;script&gt;'));
});

// ---- consolidation --------------------------------------------------------

test('crossing several milestones at once sends ONE alert for the highest', async () => {
  const store = tmpStore();
  const call = await seedCall(store, { entry: 100_000 });
  const { sent, send } = recorder();

  const out = await processMilestoneEvents({
    store, call, currentMarketCapUsd: 1_200_000, // 12x -> crossed 2,5,10
    send, now: Date.now(), enabled: [2, 5, 10, 20],
  });

  assert.equal(sent.length, 1, 'exactly one Telegram message');
  assert.match(sent[0].text, /JUST HIT 10X/);
  const announced = out.filter((o) => o.announced).length;
  assert.equal(announced, 1);
  // The lower milestones are recorded as delivered so they cannot fire later.
  for (const m of [2, 5]) {
    assert.equal(store.alertDelivered(eventId.milestone(call.id, m)), true, `${m}x must be suppressed`);
  }
});

test('a suppressed milestone never fires on a later observation', async () => {
  const store = tmpStore();
  const call = await seedCall(store, { entry: 100_000 });
  const { sent, send } = recorder();

  await processMilestoneEvents({ store, call, currentMarketCapUsd: 1_200_000, send, now: Date.now(), enabled: [2, 5, 10] });
  sent.length = 0;

  // A later reading still above 10x must not re-send anything.
  const again = await processMilestoneEvents({ store, call, currentMarketCapUsd: 1_300_000, send, now: Date.now() + 60_000, enabled: [2, 5, 10] });
  assert.equal(sent.length, 0);
  assert.equal(again.filter((o) => o.announced).length, 0);
});

test('dropping below a milestone and crossing again does not re-alert', async () => {
  const store = tmpStore();
  const call = await seedCall(store, { entry: 100_000 });
  const { sent, send } = recorder();

  await processMilestoneEvents({ store, call, currentMarketCapUsd: 500_000, send, now: Date.now(), enabled: [2, 5] });
  assert.equal(sent.length, 1);
  sent.length = 0;

  // Falls back to 3x, then recovers past 5x.
  await processMilestoneEvents({ store, call, currentMarketCapUsd: 300_000, send, now: Date.now() + 1000, enabled: [2, 5] });
  await processMilestoneEvents({ store, call, currentMarketCapUsd: 520_000, send, now: Date.now() + 2000, enabled: [2, 5] });
  assert.equal(sent.length, 0, 'no repeat alert for an already-announced milestone');
});

// ---- unconfirmed extremes -------------------------------------------------

test('an observation awaiting confirmation does NOT produce a milestone alert', async () => {
  const store = tmpStore();
  const call = await seedCall(store, { entry: 100_000 });
  // Simulate what observeCall does for an unverified 100x: peak untouched, candidate held.
  const held = await store.updateCall(call.id, {
    lastMarketCapUsd: 10_000_000,
    pendingPeak: { marketCapUsd: 10_000_000, firstSeenAt: Date.now(), confirmations: 1, required: 2 },
  });
  const { sent, send } = recorder();

  const out = await processMilestoneEvents({ store, call: held, currentMarketCapUsd: 10_000_000, send, now: Date.now(), enabled: [2, 5, 100] });
  assert.equal(sent.length, 0, 'must not announce an unconfirmed return');
  assert.match(out[0].reason, /awaiting confirmation/);
});

// ---- dedupe + persistence -------------------------------------------------

test('a delivered alert is never sent twice, even from a fresh store object', async () => {
  const store = tmpStore();
  const call = await seedCall(store, { entry: 100_000 });
  const { sent, send } = recorder();

  await processMilestoneEvents({ store, call, currentMarketCapUsd: 500_000, send, now: Date.now(), enabled: [5] });
  assert.equal(sent.length, 1);

  // A second store instance on the same file = a restart.
  const reloaded = new CallStore(store.filePath);
  reloaded.load();
  const call2 = reloaded.openCalls({ now: Date.now() })[0];
  const out2 = await processMilestoneEvents({ store: reloaded, call: call2, currentMarketCapUsd: 600_000, send, now: Date.now(), enabled: [5] });
  assert.equal(sent.length, 1, 'no duplicate after restart');
  assert.equal(out2.filter((o) => o.announced).length, 0);
});

test('claimAlert is atomic: only the first claim wins', async () => {
  const store = tmpStore();
  const id = 'c1:milestone:5';
  const results = await Promise.all([
    store.claimAlert(id, { type: 'milestone' }),
    store.claimAlert(id, { type: 'milestone' }),
    store.claimAlert(id, { type: 'milestone' }),
  ]);
  assert.equal(results.filter((r) => r.claimed).length, 1);
});

// ---- delivery failure handling -------------------------------------------

test('a definite delivery failure is recorded as failed, not delivered', async () => {
  const store = tmpStore();
  const call = await seedCall(store, { entry: 100_000 });
  const err = Object.assign(new Error('chat not found'), { response: { error_code: 400 }, description: 'Bad Request: chat not found' });
  const send = async () => { throw err; };

  const res = await deliverAlert({
    store, call, id: 'x:1', text: 'hello', send, now: Date.now(),
  });
  assert.equal(res.sent, false);
  assert.equal(res.reason, 'delivery-rejected');
  assert.equal(store.alertDelivered('x:1'), false, 'a failure must not look delivered');
  assert.equal(store.alertState('x:1').state, 'failed');
});

test('an ambiguous network error is NOT retried automatically', async () => {
  const store = tmpStore();
  const call = await seedCall(store, { entry: 100_000 });
  const send = async () => { throw new Error('socket hang up'); };

  const res = await deliverAlert({ store, call, id: 'x:2', text: 'hi', send, now: Date.now() });
  assert.equal(res.reason, 'ambiguous');
  assert.equal(store.alertState('x:2').state, 'ambiguous');

  // The claim blocks any retry.
  const again = await store.claimAlert('x:2', { type: 'milestone' });
  assert.equal(again.claimed, false);
});

test('HTTP 429 is recorded with retry_after and is retryable', async () => {
  const store = tmpStore();
  const call = await seedCall(store, { entry: 100_000 });
  const err = Object.assign(new Error('Too Many Requests'), {
    response: { error_code: 429, parameters: { retry_after: 7 } },
  });
  const res = await deliverAlert({ store, call, id: 'x:3', text: 'hi', send: async () => { throw err; }, now: Date.now() });
  assert.equal(res.reason, 'rate-limited');
  assert.equal(res.retryAfterMs, 7000);
  assert.equal(retryAfterMs(err), 7000);
});

// ---- dex paid -------------------------------------------------------------

test('a first-observed paid token is recorded but NOT announced', async () => {
  const store = tmpStore();
  const call = await seedCall(store);
  const { sent, send } = recorder();

  const out = await processDexPaid({ store, call, status: 'paid', detail: 'active tokenProfile', send, now: Date.now() });
  assert.equal(out.announced, false);
  assert.match(out.reason, /first observation/);
  assert.equal(sent.length, 0);
  assert.equal(store.alertState(eventId.dexPaid(call.id)).lastStatus, 'paid');
});

test('a transition INTO paid is announced once', async () => {
  const store = tmpStore();
  const call = await seedCall(store);
  const { sent, send } = recorder();

  await processDexPaid({ store, call, status: 'not-paid', send, now: Date.now() });
  const out = await processDexPaid({ store, call, status: 'paid', detail: 'active tokenProfile', send, now: Date.now() + 1000 });
  assert.equal(out.announced, true);
  assert.equal(sent.length, 1);
  assert.match(sent[0].text, /DEX PAID CONFIRMED/);

  // Re-observing paid must not announce again.
  const again = await processDexPaid({ store, call, status: 'paid', send, now: Date.now() + 2000 });
  assert.equal(again.announced, false);
  assert.equal(sent.length, 1);
});

test('a provider failure is never treated as not-paid, and never overwrites confirmed status', async () => {
  const store = tmpStore();
  const call = await seedCall(store);
  const { sent, send } = recorder();
  await processDexPaid({ store, call, status: 'not-paid', send, now: Date.now() });
  const out = await processDexPaid({ store, call, status: 'unknown', detail: 'http 500', send, now: Date.now() + 1000 });
  assert.equal(out.announced, false);
  // An outage must NOT be recorded as the status: overwriting it made
  // 'paid -> unknown -> paid' look like a fresh payment and sent a false alert.
  assert.equal(store.alertState(eventId.dexPaid(call.id)).lastStatus, 'not-paid',
    'confirmed status must survive an outage');
  assert.equal(sent.length, 0);

  // Recovering to paid after an outage with NO prior paid observation is a genuine
  // transition and IS announced.
  const recover = await processDexPaid({ store, call, status: 'paid', detail: 'active tokenProfile', send, now: Date.now() + 2000 });
  assert.equal(recover.announced, true);
  assert.equal(sent.length, 1);
});

test('the Dex Paid message distinguishes the documented states', () => {
  const call = { id: 'c1', chain: 'solana', symbol: 'BONK', entryMarketCapUsd: 1e6, callerName: 'Foxy' };
  assert.match(renderDexPaidAlert({ call, status: 'paid' }), /CONFIRMED/);
  assert.match(renderDexPaidAlert({ call, status: 'processing' }), /PROCESSING/);
  assert.match(renderDexPaidAlert({ call, status: 'cancelled' }), /CANCELLED/);
  assert.match(renderDexPaidAlert({ call, status: 'not-paid' }), /NO PAID ORDER/);
});

// ---- migration ------------------------------------------------------------

test('migration is only announced with verified evidence, and only once', async () => {
  const store = tmpStore();
  const call = await seedCall(store);
  const { sent, send } = recorder();

  const unverified = await processMigration({ store, call, evidence: { verified: false, note: 'new pool seen' }, send, now: Date.now() });
  assert.equal(unverified.announced, false);
  assert.equal(sent.length, 0);

  const verified = await processMigration({
    store, call, evidence: { verified: true, launchpad: 'pump.fun', pool: 'Raydium', note: 'bonding curve completed' }, send, now: Date.now() + 1000,
  });
  assert.equal(verified.announced, true);
  assert.match(sent[0].text, /MIGRATED/);
  assert.match(sent[0].text, /pump\.fun/);

  const again = await processMigration({ store, call, evidence: { verified: true }, send, now: Date.now() + 2000 });
  assert.equal(again.announced, false);
  assert.equal(sent.length, 1);
});

test('the migration message names the evidence', () => {
  const call = { id: 'c1', chain: 'solana', symbol: 'BONK', entryMarketCapUsd: 1e6, callerName: 'Foxy' };
  const text = renderMigrationAlert({ call, evidence: { verified: true, launchpad: 'pump.fun', pool: 'Raydium', note: 'bonding curve completed' } });
  assert.match(text, /Launchpad: <b>pump\.fun<\/b>/);
  assert.match(text, /Now trading on: <b>Raydium<\/b>/);
});

// ---- movement -------------------------------------------------------------

test('a movement alert needs two real observations inside the window', () => {
  const now = Date.now();
  const call = {
    id: 'c1', chatId: GROUP, entryMarketCapUsd: 1e6,
    lastMarketCapUsd: 1.6e6, lastObservedAt: now,
    peakMarketCapUsd: 1.6e6,
    recentObservations: [{ at: now - 5 * 60_000, marketCapUsd: 1e6 }, { at: now, marketCapUsd: 1.6e6 }],
  };
  const settings = { pumpPercent: 50, pumpWindowMs: 15 * 60_000, dumpPercent: 30, dumpWindowMs: 15 * 60_000, drawdownPercent: 50 };
  const mv = detectMovement(call, { now, settings });
  assert.equal(mv.kind, 'pump');
  assert.ok(mv.changePercent >= 50);
});

test('a stale pair of observations cannot claim a 15-minute move', () => {
  const now = Date.now();
  const call = {
    id: 'c1', chatId: GROUP, entryMarketCapUsd: 1e6,
    lastMarketCapUsd: 1.6e6, lastObservedAt: now, peakMarketCapUsd: 1.6e6,
    // Previous sample is 3 hours old: outside the 15-minute window.
    recentObservations: [{ at: now - 3 * 3600_000, marketCapUsd: 1e6 }, { at: now, marketCapUsd: 1.6e6 }],
  };
  const settings = { pumpPercent: 50, pumpWindowMs: 15 * 60_000, dumpPercent: 30, dumpWindowMs: 15 * 60_000, drawdownPercent: 50 };
  assert.equal(detectMovement(call, { now, settings }), null);
});

test('a single observation cannot produce a movement alert', () => {
  const now = Date.now();
  const call = {
    id: 'c1', entryMarketCapUsd: 1e6, lastMarketCapUsd: 2e6, lastObservedAt: now,
    peakMarketCapUsd: 2e6, recentObservations: [{ at: now, marketCapUsd: 2e6 }],
  };
  const settings = { pumpPercent: 50, pumpWindowMs: 15 * 60_000, dumpPercent: 30, dumpWindowMs: 15 * 60_000, drawdownPercent: 90 };
  assert.equal(detectMovement(call, { now, settings }), null);
});

test('drawdown is measured from the verified peak', () => {
  const now = Date.now();
  const call = {
    id: 'c1', entryMarketCapUsd: 1e6, lastMarketCapUsd: 4e6, lastObservedAt: now,
    peakMarketCapUsd: 10e6, recentObservations: [],
  };
  const settings = { pumpPercent: 50, pumpWindowMs: 15 * 60_000, dumpPercent: 30, dumpWindowMs: 15 * 60_000, drawdownPercent: 50 };
  const mv = detectMovement(call, { now, settings });
  assert.equal(mv.kind, 'drawdown');
  assert.equal(Math.round(mv.changePercent), -60);
});

test('the movement message reports measurement, not a cause', () => {
  const call = { id: 'c1', chain: 'solana', symbol: 'BONK', entryMarketCapUsd: 1e6, callerName: 'Foxy' };
  const text = renderMovementAlert({ call, kind: 'dump', changePercent: -35, windowLabel: '12m', currentMarketCapUsd: 650_000 });
  assert.match(text, /DOWN 35%/);
  assert.match(text, /Measured price movement, not trading advice/);
  assert.ok(!/rug|manipulat|scam/i.test(text), 'must not assert a cause');
});

// ---- scheduler ------------------------------------------------------------

test('one provider request serves several groups tracking the same token', async () => {
  const store = tmpStore();
  store.groupSettings(GROUP, { title: 'A' });
  store.groupSettings(OTHER, { title: 'B' });
  await store.setGroupSetting(GROUP, { alerts: { multiplier: true, dexPaid: false } });
  await store.setGroupSetting(OTHER, { alerts: { multiplier: true, dexPaid: false } });
  await seedCall(store, { chatId: GROUP, entry: 1_000_000 });
  await seedCall(store, { chatId: OTHER, entry: 100_000 });

  let fetches = 0;
  const scan = async () => { fetches += 1; return scanAt(2_000_000); };
  const { send } = recorder();

  const summary = await runCycle({
    store, scan, send, now: Date.now() + 60_000, maxCalls: 10,
    dexPaid: async () => ({ status: 'unknown' }), dexPaidEveryMs: 10 ** 9,
  });

  assert.equal(fetches, 1, 'exactly one provider request');
  assert.equal(summary.observed, 2, 'both groups updated');
});

test('each group keeps its own entry market cap and therefore its own multiple', async () => {
  const store = tmpStore();
  await store.setGroupSetting(GROUP, { alerts: { multiplier: true, dexPaid: false, milestones: [2] } });
  await store.setGroupSetting(OTHER, { alerts: { multiplier: true, dexPaid: false, milestones: [20] } });
  store.groupSettings(GROUP, { title: 'A' });
  store.groupSettings(OTHER, { title: 'B' });
  await seedCall(store, { chatId: GROUP, entry: 1_000_000 }); // 2x at 2M
  await seedCall(store, { chatId: OTHER, entry: 100_000 });   // 20x at 2M

  const scan = async () => scanAt(2_000_000);
  const { sent, send } = recorder();

  await runCycle({
    store, scan, send, now: Date.now() + 60_000, maxCalls: 10,
    dexPaid: async () => ({ status: 'unknown' }), dexPaidEveryMs: 10 ** 9,
  });

  const forA = sent.filter((s) => s.chatId === GROUP);
  const forB = sent.filter((s) => s.chatId === OTHER);
  assert.equal(forA.length, 1);
  assert.match(forA[0].text, /JUST HIT 2X/);
  assert.equal(forB.length, 1);
  assert.match(forB[0].text, /JUST HIT 20X/);
});

test('a provider failure writes nothing and sends nothing', async () => {
  const store = tmpStore();
  store.groupSettings(GROUP, { title: 'A' });
  await store.setGroupSetting(GROUP, { alerts: { multiplier: true, dexPaid: false } });
  const call = await seedCall(store, { entry: 1_000_000 });
  const before = { ...store.alertState('none') };

  const { sent, send } = recorder();
  const summary = await runCycle({
    store, scan: async () => { throw new Error('provider down'); }, send, now: Date.now() + 60_000,
    dexPaid: async () => ({ status: 'unknown' }), dexPaidEveryMs: 10 ** 9,
  });

  assert.equal(summary.observed, 0);
  assert.ok(summary.failed >= 1);
  assert.equal(sent.length, 0);
  const after = store.openCalls({ now: Date.now() + 60_000 })[0];
  assert.equal(after.lastMarketCapUsd, call.entryMarketCapUsd, 'no price written from a failure');
});

test('cancelled and synthetic calls are never monitored or alerted', async () => {
  const store = tmpStore();
  store.groupSettings(GROUP, { title: 'A' });
  await store.setGroupSetting(GROUP, { alerts: { multiplier: true, dexPaid: false, milestones: [2] } });
  const real = await seedCall(store, { entry: 1_000_000 });
  const synth = await seedCall(store, { entry: 1_000_000, source: 'synthetic' });
  await store.updateCall(real.id, { status: 'cancelled' });

  const { sent, send } = recorder();
  await runCycle({
    store, scan: async () => scanAt(10_000_000), send, now: Date.now() + 60_000,
    dexPaid: async () => ({ status: 'unknown' }), dexPaidEveryMs: 10 ** 9,
  });
  assert.equal(sent.length, 0, 'neither a cancelled nor a synthetic call may alert');
  assert.equal(isActive(store.openCalls({ now: Date.now() + 60_000 })[0] ?? {}), false);
});

test('mapBounded respects its concurrency limit and keeps order', async () => {
  let active = 0;
  let peak = 0;
  const items = [1, 2, 3, 4, 5, 6, 7, 8];
  const out = await mapBounded(items, 3, async (n) => {
    active += 1; peak = Math.max(peak, active);
    await new Promise((r) => setTimeout(r, 5));
    active -= 1;
    return n * 2;
  });
  assert.ok(peak <= 3, `concurrency exceeded: ${peak}`);
  assert.deepEqual(out.map((o) => o.value), items.map((n) => n * 2));
});

test('mapBounded isolates a rejected task instead of failing the batch', async () => {
  const out = await mapBounded([1, 2, 3], 2, async (n) => {
    if (n === 2) throw new Error('boom');
    return n;
  });
  assert.equal(out[0].value, 1);
  assert.ok(out[1].error instanceof Error);
  assert.equal(out[2].value, 3);
});

test('backoff grows and stays capped', () => {
  for (let i = 1; i <= 10; i += 1) {
    const ms = backoffMs(i, { base: 1000, max: 60_000 });
    assert.ok(ms <= 60_000 * 1.2, `uncapped: ${ms}`);
  }
  assert.ok(backoffMs(10, { base: 1000, max: 60_000 }) > backoffMs(1, { base: 1000, max: 60_000 }));
});

test('sleep resolves early on abort so Ctrl+C is not delayed', async () => {
  const ac = new AbortController();
  const p = sleep(60_000, ac.signal);
  setTimeout(() => ac.abort(), 20);
  const started = Date.now();
  assert.equal(await p, 'aborted');
  assert.ok(Date.now() - started < 2000);
});

test('the observer stops when its signal aborts', async () => {
  const store = tmpStore();
  store.groupSettings(GROUP, { title: 'A' });
  await seedCall(store);

  const { startObserver } = await import('../src/observer-loop.mjs');
  const logs = [];
  const log = { log: (m) => logs.push(m), warn: () => {}, error: () => {} };
  const ac = new AbortController();
  const obs = startObserver({
    store, scan: async () => scanAt(2_000_000), send: async () => ({}),
    intervalMs: 10_000, log, signal: ac.signal,
    dexPaid: async () => ({ status: 'unknown' }),
  });
  ac.abort();
  await obs.done;
  assert.ok(logs.some((l) => /stopped after/.test(l)), logs.join(' | '));
});

// ---- settings authorization ----------------------------------------------

test('a non-owner cannot change alert settings', async () => {
  const store = tmpStore();
  store.groupSettings(GROUP, { title: 'A' });
  await store.setGroupSetting(GROUP, { alerts: { multiplier: true, dexPaid: true, milestones: [2] } });

  const { handleAlertsCallback } = await import('../src/alert-commands.mjs');
  const { loadPolicy } = await import('../src/access.mjs');
  const policy = loadPolicy({ OWNER_USER_IDS: '1307106746', ALLOWED_CHAT_IDS: GROUP });

  const before = JSON.stringify(store.groupSettings(GROUP).alerts);
  const answers = [];
  const ctx = {
    chat: { id: Number(GROUP), type: 'group', title: 'A' },
    from: { id: 999, first_name: 'Stranger' },
    callbackQuery: { data: 'al:dexPaid' },
    async answerCbQuery(t) { answers.push(t ?? ''); },
    async editMessageText() {},
  };

  await handleAlertsCallback(ctx, { store, policy });

  const after = JSON.stringify(store.groupSettings(GROUP).alerts);
  assert.equal(after, before, 'settings must be untouched');
  assert.ok(answers.some((a) => /owner/i.test(a)), `expected an owner-only answer, got ${JSON.stringify(answers)}`);
});

test('the owner CAN change alert settings', async () => {
  const store = tmpStore();
  store.groupSettings(GROUP, { title: 'A' });
  await store.setGroupSetting(GROUP, { alerts: { multiplier: true, dexPaid: true, milestones: [2] } });

  const { handleAlertsCallback } = await import('../src/alert-commands.mjs');
  const { loadPolicy } = await import('../src/access.mjs');
  const policy = loadPolicy({ OWNER_USER_IDS: '1307106746', ALLOWED_CHAT_IDS: GROUP });

  const ctx = {
    chat: { id: Number(GROUP), type: 'group', title: 'A' },
    from: { id: 1307106746, first_name: 'Foxy' },
    callbackQuery: { data: 'al:dexPaid' },
    async answerCbQuery() {},
    async editMessageText() {},
  };
  await handleAlertsCallback(ctx, { store, policy });
  assert.equal(store.groupSettings(GROUP).alerts.dexPaid, false, 'owner toggle applied');
});

test('the /alerts panel refuses to render switches for a non-owner', async () => {
  const store = tmpStore();
  store.groupSettings(GROUP, { title: 'A' });
  const { handleAlerts } = await import('../src/alert-commands.mjs');
  const { loadPolicy } = await import('../src/access.mjs');
  const policy = loadPolicy({ OWNER_USER_IDS: '1307106746', ALLOWED_CHAT_IDS: GROUP });

  const replies = [];
  const ctx = {
    chat: { id: Number(GROUP), type: 'group', title: 'A' },
    from: { id: 999, first_name: 'Stranger' },
    async reply(t, o) { replies.push({ t, o }); },
  };
  await handleAlerts(ctx, { store, policy });
  const kb = replies[0]?.o?.reply_markup?.inline_keyboard;
  assert.equal(kb, undefined, 'no panel or buttons for a non-owner');
  assert.match(replies[0].t, /owner-only/);
});

test('synthetic and cancelled calls never accumulate Dex Paid alert state', async () => {
  const store = tmpStore();
  store.groupSettings(GROUP, { title: 'A' });
  await store.setGroupSetting(GROUP, { alerts: { multiplier: true, dexPaid: true, milestones: [2] } });
  // Distinct addresses: uniqueness is per (group, chain, contract), so sharing one
  // CA would make the synthetic and cancelled calls collide with the real one.
  const mk = (addr) => ({
    status: 'ok',
    token: { chain: 'solana', address: addr, name: 'T', symbol: 'T' },
    market: { marketCapUsd: 1_000_000, liquidityUsd: 200_000, priceUsd: 1 },
    media: {},
  });
  const mkCall = async (addr, source) => (await recordCall({
    store, caller, chatId: GROUP, source, messageId: 1, scanResult: mk(addr), now: Date.now() - 5 * 60_000,
  })).call;

  const real = await mkCall('So11111111111111111111111111111111111111112', 'auto');
  const synth = await mkCall('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', 'synthetic');
  const gone = await mkCall('DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263', 'auto');
  await store.updateCall(gone.id, { status: 'cancelled' });

  await runCycle({
    store, scan: async () => scanAt(2_000_000), send: async () => ({}),
    now: Date.now() + 60_000,
    dexPaid: async () => ({ status: 'paid', detail: 'active tokenProfile' }),
    dexPaidEveryMs: 0,
  });

  const ids = Object.keys(store.doc.alerts);
  assert.ok(!ids.some((k) => k.startsWith(`${synth.id}:`)), 'a synthetic record must not get alert state');
  assert.ok(!ids.some((k) => k.startsWith(`${gone.id}:`)), 'a cancelled record must not be polled');
  assert.ok(ids.some((k) => k.startsWith(`${real.id}:`)), 'the live call is tracked');
});
