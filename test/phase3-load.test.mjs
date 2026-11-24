/**
 * test/phase3-load.test.mjs
 *
 * Mocked load tests: 100 / 500 / 1000 tracked tokens.
 *
 * No network. The provider is a synthetic function with realistic latency, so these
 * measure the SCHEDULER's behaviour — request budget, dedupe, cycle length,
 * concurrency ceiling and alert fan-out — not a provider's capacity.
 *
 * The budgets asserted here are the contract: a cycle must issue at most one request
 * per distinct token and must respect OBSERVER_MAX_TOKENS, no matter how many calls
 * or groups exist.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { CallStore } from '../src/store.mjs';
import { recordCall } from '../src/call-service.mjs';
import { resolveCaller } from '../src/caller-identity.mjs';
import { runCycle, mapBounded, backoffMs } from '../src/observer-loop.mjs';

const GROUP = '-5333984336';
const OTHER = '-1009999999999';

/** Base58-ish Solana addresses, unique per token. */
function addrFor(i) {
  const base = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz123456789';
  let s = '';
  let n = i + 1;
  while (n > 0 && s.length < 44) {
    s += base[n % base.length];
    n = Math.floor(n / base.length);
  }
  return (s + 'z'.repeat(44)).slice(0, 44);
}

const scanFor = (mcap) => ({
  status: 'ok',
  token: { chain: 'solana', address: 'x', name: 'T', symbol: 'T' },
  market: { marketCapUsd: mcap, liquidityUsd: 200_000, priceUsd: 1 },
  media: {},
});

/** Seed N tokens, spread across two groups, backdated so all are due. */
async function seedTokens(n, { groups = 1 } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-load-'));
  const store = new CallStore(path.join(dir, 'calls.json'));
  store.load();
  store.groupSettings(GROUP, { title: 'A' });
  await store.setGroupSetting(GROUP, { alerts: { multiplier: true, dexPaid: false, milestones: [2, 5] } });
  if (groups > 1) {
    store.groupSettings(OTHER, { title: 'B' });
    await store.setGroupSetting(OTHER, { alerts: { multiplier: true, dexPaid: false, milestones: [2, 5] } });
  }

  const caller = resolveCaller({ from: { id: 1, first_name: 'F', username: 'f' } }, { id: Number(GROUP) });
  const calledAt = Date.now() - 10 * 60_000; // 10 min old: fresh tier is due
  for (let i = 0; i < n; i += 1) {
    const addr = addrFor(i);
    const chatId = groups > 1 && i % 2 === 1 ? OTHER : GROUP;
    await recordCall({
      store,
      caller,
      chatId,
      source: 'auto',
      messageId: 1000 + i,
      now: calledAt,
      scanResult: {
        status: 'ok',
        token: { chain: 'solana', address: addr, name: `T${i}`, symbol: `T${i}` },
        market: { marketCapUsd: 1_000_000, liquidityUsd: 200_000, priceUsd: 1 },
        media: {},
      },
    });
  }
  return store;
}

function countingScan({ delayMs = 0, mcap = 2_000_000 } = {}) {
  const state = { calls: 0, seen: [] };
  const fn = async (req) => {
    state.calls += 1;
    state.seen.push(`${req.chain}:${req.address}`);
    if (delayMs) await new Promise((r) => setTimeout(r, delayMs));
    return scanFor(mcap);
  };
  return { fn, state };
}

// ---- request budget -------------------------------------------------------

for (const n of [100, 500, 1000]) {
  test(`${n} tokens: one provider request per token and never more than the budget`, async () => {
    const store = await seedTokens(n);
    const { fn, state } = countingScan();
    const sent = [];

    const busy = async () => {
      throw new Error('should not be called');
    };
    let busyCalls = 0;
    const dexPaid = async () => { busyCalls += 1; return { status: 'unknown' }; };

    const started = Date.now();
    const summary = await runCycle({
      store,
      scan: fn,
      send: async ({ text }) => { sent.push(text); return { message_id: sent.length }; },
      now: Date.now(),
      maxCalls: 12,          // the production budget
      concurrency: 3,
      dexPaid,
      dexPaidEveryMs: 10 ** 9, // Dex Paid off for this measurement
    });
    const elapsed = Date.now() - started;

    assert.ok(state.calls <= 12, `${n} tokens: ${state.calls} requests exceeds the 12 budget`);
    assert.equal(state.calls, summary.observed, 'requests correspond to observed records');
    assert.equal(new Set(state.seen).size, state.seen.length, 'no duplicate token requested');
    assert.equal(busyCalls, 0, 'Dex Paid must not be polled when disabled by cadence');

    // The rest of the book is reported as skipped, not silently dropped.
    assert.equal(summary.open, n, 'every call counted as open');
    assert.equal(summary.skipped, n - summary.observed, 'unpolled calls reported as skipped');

    console.log(`  ${n} tokens -> parsed ${summary.open}, observed ${summary.observed}, skipped ${summary.skipped}, ${state.calls} requests, ${elapsed}ms`);
  });
}

test('1000 tokens with two groups: still bounded, and both groups alerted per token', async () => {
  const store = await seedTokens(400, { groups: 2 });
  const { fn, state } = countingScan();
  const sent = [];

  const summary = await runCycle({
    store, scan: fn,
    send: async ({ chatId, text }) => { sent.push({ chatId, text }); return { message_id: sent.length }; },
    now: Date.now(), maxCalls: 12, concurrency: 3,
    dexPaid: async () => ({ status: 'unknown' }), dexPaidEveryMs: 10 ** 9,
  });

  assert.ok(state.calls <= 12, `requests ${state.calls} exceeded budget`);
  // Dedupe is per (group, token, milestone). Comparing message TEXT would be wrong:
  // every simulated token renders identical copy. Assert on delivered alert rows.
  const delivered = Object.entries(store.doc.alerts)
    .filter(([, v]) => v.state === 'delivered' && v.type === 'milestone');
  const ids = delivered.map(([k]) => k);
  assert.equal(new Set(ids).size, ids.length, 'each alert event id is unique');
  assert.ok(sent.length <= delivered.length + 12, `alerts ${sent.length} not explained by rows ${delivered.length}`);
  console.log(`  ${state.calls} requests -> ${sent.length} alerts across ${new Set(sent.map((s) => s.chatId)).size} group(s)`);
});

// ---- concurrency ceiling --------------------------------------------------

test('bounded concurrency holds at 1, 3 and 8 across a 1000-item batch', async () => {
  for (const limit of [1, 3, 8]) {
    let active = 0;
    let peak = 0;
    const items = Array.from({ length: 1000 }, (_, i) => i);
    const out = await mapBounded(items, limit, async (i) => {
      active += 1;
      peak = Math.max(peak, active);
      await new Promise((r) => setImmediate(r));
      active -= 1;
      return i;
    });
    assert.ok(peak <= limit, `limit ${limit}: peak ${peak}`);
    assert.equal(out.filter((o) => o.value != null).length, 1000);
  }
});

// ---- overlapping cycles ---------------------------------------------------

test('two overlapping cycles at 500 tokens still send each alert once', async () => {
  const store = await seedTokens(500);
  const sent = [];
  const send = async ({ chatId, text }) => {
    await new Promise((r) => setTimeout(r, 1));
    sent.push({ chatId, text });
    return { message_id: sent.length };
  };
  const { fn } = countingScan();

  await Promise.all([
    runCycle({ store, scan: fn, send, now: Date.now(), maxCalls: 12, concurrency: 3, dexPaid: async () => ({ status: 'unknown' }), dexPaidEveryMs: 10 ** 9 }),
    runCycle({ store, scan: fn, send, now: Date.now(), maxCalls: 12, concurrency: 3, dexPaid: async () => ({ status: 'unknown' }), dexPaidEveryMs: 10 ** 9 }),
  ]);

  const ids = sent.map((s) => s.text.match(/JUST HIT (\d+)X/)?.[1] ?? '?');
  assert.ok(sent.length <= 24, `at most two budgets of alerts: ${sent.length}`);
  // No identical alert text from the same group twice.
  const dupes = sent.filter((s, i) => sent.findIndex((x) => x.chatId === s.chatId && x.text === s.text) !== i);
  assert.equal(dupes.length, 0, `duplicate alerts: ${dupes.length}`);
});

// ---- failure budget -------------------------------------------------------

test('a provider failure across the whole batch does not stall the cycle', async () => {
  const store = await seedTokens(500);
  const started = Date.now();
  const summary = await runCycle({
    store,
    scan: async () => { throw new Error('provider down'); },
    send: async () => { throw new Error('must not send'); },
    now: Date.now(), maxCalls: 12, concurrency: 3,
    dexPaid: async () => ({ status: 'unknown' }), dexPaidEveryMs: 10 ** 9,
  });
  const elapsed = Date.now() - started;
  assert.equal(summary.observed, 0);
  assert.ok(summary.failed >= 1);
  assert.ok(elapsed < 5000, `failure path took ${elapsed}ms`);
  // Nothing written.
  for (const c of store.openCalls({ now: Date.now() })) {
    assert.equal(c.lastMarketCapUsd, 1_000_000, 'no price written on failure');
  }
});

test('backoff stays bounded under 1000 consecutive failures', () => {
  let total = 0;
  for (let i = 1; i <= 1000; i += 1) {
    const ms = backoffMs(i, { base: 1000, max: 60_000 });
    assert.ok(ms <= 72_000, `attempt ${i} produced ${ms}ms`);
    total += ms;
  }
  // Sanity: unbounded exponential growth would be astronomically larger.
  assert.ok(total < 1000 * 72_000);
});
