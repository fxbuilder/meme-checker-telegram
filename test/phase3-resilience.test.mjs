/**
 * test/phase3-resilience.test.mjs
 *
 * Crash-resilience and shutdown cover for the Phase 3 observer: malformed stored
 * records, malformed settings, pre-aborted signals, in-flight abort, and a loop that
 * must survive repeated provider failures.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { CallStore } from '../src/store.mjs';
import { recordCall } from '../src/call-service.mjs';
import { resolveCaller } from '../src/caller-identity.mjs';
import { runCycle, startObserver } from '../src/observer-loop.mjs';

const GROUP = '-5333984336';
const CA = 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263';

function tmpStore() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-res-'));
  return new CallStore(path.join(dir, 'calls.json'));
}

const scanAt = (mcap, address = CA) => ({
  status: 'ok',
  token: { chain: 'solana', address, name: 'T', symbol: 'T' },
  market: { marketCapUsd: mcap, liquidityUsd: 200_000, priceUsd: 1 },
  media: {},
});

const caller = resolveCaller({ from: { id: 1, first_name: 'Foxy', username: 'f' } }, { id: Number(GROUP) });

async function seed(store, { entry = 1_000_000, now = Date.now() - 600_000 } = {}) {
  const rec = await recordCall({
    store, caller, chatId: GROUP, source: 'auto', messageId: 1,
    scanResult: scanAt(entry), now,
  });
  return rec.call;
}

const quiet = { log: () => {}, warn: () => {}, error: () => {} };

test('a malformed or null call record cannot break a healthy observation', async () => {
  const store = tmpStore();
  await store.setGroupSetting(GROUP, { alerts: { multiplier: true, dexPaid: false, milestones: [2] } });
  store.groupSettings(GROUP, { title: 'A' });
  const call = await seed(store);

  // Corrupt the array the way a hand-edited or partially-written file could.
  store.doc.calls.unshift(null, { status: 'active' }, { id: 'sparse', status: 'active', calledAt: Date.now() - 1 });

  const sent = [];
  const summary = await runCycle({
    store, now: Date.now() + 60_000,
    scan: async () => scanAt(2_000_000),
    send: async ({ text }) => { sent.push(text); return { message_id: sent.length }; },
    dexPaid: async () => ({ status: 'unknown' }),
    dexPaidEveryMs: 10 ** 9,
    log: quiet,
  });

  assert.equal(summary.observed, 1, 'the healthy call is still observed');
  assert.equal(sent.length, 1, 'and still alerts');
  assert.ok(store.openCalls({ now: Date.now() }).some((c) => c?.id === call.id));
});

test('malformed milestone settings fall back instead of throwing', async () => {
  const store = tmpStore();
  const { effectiveAlertSettings } = await import('../src/alert-commands.mjs');
  for (const bad of [null, {}, 'nope', [null, 'x', -1], [0, 1]]) {
    await store.setGroupSetting(GROUP, { alerts: { milestones: bad } });
    const s = effectiveAlertSettings(store, GROUP);
    assert.ok(Array.isArray(s.milestones), `milestones must stay an array for ${JSON.stringify(bad)}`);
    assert.ok(
      s.milestones.every((m) => Number.isFinite(m) && m >= 2),
      `${JSON.stringify(bad)} left invalid entries: ${JSON.stringify(s.milestones)}`,
    );
  }
});

test('an already-aborted signal runs no cycle at all', async () => {
  const store = tmpStore();
  const ac = new AbortController();
  ac.abort();
  let scans = 0;
  const obs = startObserver({
    store, log: quiet, signal: ac.signal, intervalMs: 1000,
    scan: async () => { scans += 1; return scanAt(2e6); },
    send: async () => ({ message_id: 1 }),
    dexPaid: async () => ({ status: 'unknown' }),
  });
  await obs.done;
  assert.equal(obs.cycles, 0);
  assert.equal(scans, 0);
});

test('abort interrupts an in-flight provider and prevents writes and sends', async () => {
  const store = tmpStore();
  await store.setGroupSetting(GROUP, { alerts: { multiplier: true, dexPaid: false, milestones: [2] } });
  store.groupSettings(GROUP, { title: 'A' });
  await seed(store);

  const ac = new AbortController();
  let began;
  const started = new Promise((r) => { began = r; });
  let requests = 0;
  let writes = 0;
  let sends = 0;
  const update = store.updateCall.bind(store);
  store.updateCall = async (...a) => { writes += 1; return update(...a); };

  const fetchImpl = async (_url, opts = {}) => new Promise((resolve, reject) => {
    requests += 1;
    began();
    const timer = setTimeout(() => { cleanup(); resolve({ ok: true }); }, 150);
    function abort() { cleanup(); reject(Object.assign(new Error('aborted'), { name: 'AbortError' })); }
    function cleanup() { clearTimeout(timer); opts.signal?.removeEventListener('abort', abort); }
    opts.signal?.addEventListener('abort', abort, { once: true });
    if (opts.signal?.aborted) abort();
  });

  const obs = startObserver({
    store, log: quiet, signal: ac.signal, intervalMs: 3_600_000, fetchImpl,
    scan: async (_req, options = {}) => {
      await (options.fetchImpl ?? fetchImpl)('https://audit.invalid/x', { signal: options.signal });
      return scanAt(2_000_000);
    },
    send: async () => { sends += 1; return { message_id: 1 }; },
    dexPaid: async () => ({ status: 'unknown' }),
  });

  await started;
  const t0 = performance.now();
  ac.abort();
  await obs.done;
  const elapsed = performance.now() - t0;

  assert.ok(elapsed < 100, `shutdown waited ${elapsed.toFixed(0)}ms for an uncancelled provider`);
  assert.equal(requests, 1, 'no further provider requests after abort');
  assert.equal(writes, 0, 'no observation written after abort');
  assert.equal(sends, 0, 'no alert sent after abort');
});

test('the observer loop survives repeated provider failures', async () => {
  const store = tmpStore();
  await store.setGroupSetting(GROUP, { alerts: { multiplier: true, dexPaid: false, milestones: [2] } });
  store.groupSettings(GROUP, { title: 'A' });
  const call = await seed(store);

  let attempts = 0;
  const ac = new AbortController();
  const obs = startObserver({
    store, log: quiet, signal: ac.signal, intervalMs: 150,
    scan: async () => { attempts += 1; throw new Error('provider exploded'); },
    send: async () => ({ message_id: 1 }),
    dexPaid: async () => ({ status: 'unknown' }),
  });
  await new Promise((r) => setTimeout(r, 2500));
  ac.abort();
  await obs.done;

  assert.ok(obs.cycles > 1, `loop stalled after ${obs.cycles} cycle(s)`);
  assert.ok(attempts >= 1, 'the provider was actually retried');
  // A failure must not write a price.
  const after = store.openCalls({ now: Date.now() })[0];
  assert.equal(after.lastMarketCapUsd, call.entryMarketCapUsd, 'no price written from a failure');
});
