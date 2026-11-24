/** Independent runtime audit. All providers and deliveries are mocked. */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CallStore } from '../src/store.mjs';
import { runCycle, startObserver } from '../src/observer-loop.mjs';
import { deliverAlert, processMilestoneEvents } from '../src/alert-service.mjs';
import { handleAlerts } from '../src/alert-commands.mjs';
import { spawnSync } from 'node:child_process';

const NOW = 1_800_000_000_000;
const GROUP = '-5333984336';
const quiet = { log() {}, warn() {}, error() {} };
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const snapshot = (mcap = 200_000) => ({
  status: 'ok', market: { marketCapUsd: mcap, liquidityUsd: 200_000 },
});

async function fixture(n = 1, { paid = false } = {}) {
  const dir = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'mc-independent-'));
  const store = new CallStore(path.join(dir, 'calls.json')).load();
  store.groupSettings(GROUP);
  store.doc.groups[GROUP].alerts.dexPaid = paid;
  store.doc.calls = Array.from({ length: n }, (_, i) => ({
    id: `c${i + 1}`, chatId: GROUP, chain: 'bsc',
    address: `0x${(i + 1).toString(16).padStart(40, '0')}`,
    symbol: `T${i}`, name: `Token ${i}`, callerName: 'Audit',
    status: 'active', source: 'manual', calledAt: NOW - 600_000,
    entryMarketCapUsd: 100_000, peakMarketCapUsd: 100_000,
    lastMarketCapUsd: 100_000, lastObservedAt: NOW - 60_000,
  }));
  store.doc.seq = n;
  await store.persist();
  return store;
}

test('audit: concurrent cycles on one file coalesce scans, writes and sends', async () => {
  const store = await fixture();
  const sibling = new CallStore(store.filePath).load();
  let scans = 0; let writes = 0; let sends = 0;
  const update = store.updateCall.bind(store);
  const countedUpdate = async (...args) => { writes += 1; return update(...args); };
  store.updateCall = sibling.updateCall = countedUpdate;
  const args = {
    now: NOW, scan: async () => { scans += 1; await pause(15); return snapshot(); },
    send: async () => { sends += 1; return { message_id: sends }; },
    dexPaid: async () => { throw new Error('paid disabled'); },
  };
  await Promise.all([runCycle({ store, ...args }), runCycle({ store: sibling, ...args })]);
  console.log(`AUDIT concurrent: scans=${scans} observationWrites=${writes} sends=${sends}`);
  assert.equal(sends, 1, 'claims must stop double-send');
  assert.equal(writes, 1, 'cycle overlap must not double-write an observation');
  assert.equal(scans, 1, 'cycle overlap must not double-fetch a token');
});

for (const n of [100, 500, 1000]) {
  test(`audit: combined market and paid requests stay within budget at ${n} calls`, async () => {
    const store = await fixture(n, { paid: true });
    let market = 0; let paid = 0; let active = 0; let peak = 0;
    const summary = await runCycle({
      store, now: NOW, maxCalls: 12, maxRequests: 24, concurrency: 3,
      scan: async () => { market += 1; return snapshot(100_000); },
      dexPaid: async () => {
        paid += 1; active += 1; peak = Math.max(peak, active);
        await pause(1); active -= 1; return { status: 'not-paid' };
      },
      send: async () => { throw new Error('flat price must not send'); },
    });
    console.log(`AUDIT budget ${n}: market=${market} paid=${paid} total=${market + paid} paidConcurrency=${peak}`);
    assert.ok(market + paid <= 24, `${market + paid} requests exceeds combined budget 24`);
    assert.equal(market, 12);
    assert.equal(paid, 12);
    assert.ok(peak <= 3);
    assert.equal(summary.paidBudgetSkipped, n - 12);
  });
}

test('audit: market-only live adapter does not issue hidden risk/paid requests', async () => {
  const { liveScan, clearLiveCache } = await import('../src/live-scan.mjs');
  const { clearDexPaidCache } = await import('../src/dex-paid.mjs');
  clearLiveCache(); clearDexPaidCache();
  const address = `0x${'a'.repeat(40)}`;
  let requests = 0;
  const result = await liveScan({ chain: 'bsc', address }, {
    enrich: false,
    fetchImpl: async (url) => {
      requests += 1;
      const body = String(url).includes('/token-pairs/') ? [{
        baseToken: { address, name: 'Audit', symbol: 'AUD' },
        marketCap: 100_000, liquidity: { usd: 100_000 },
      }] : {};
      return { ok: true, status: 200, json: async () => body };
    },
  });
  console.log(`AUDIT market-only HTTP requests=${requests}`);
  assert.equal(result.status, 'ok');
  assert.equal(requests, 1, 'a price observation must not silently fan out to enrichment APIs');
});

for (const [name, props, expected] of [
  ['403 bot was blocked', { response: { error_code: 403 } }, 'failed'],
  ['400 chat not found', { response: { error_code: 400 } }, 'failed'],
  ['429', { response: { error_code: 429, parameters: { retry_after: 7 } } }, 'failed'],
  ['ECONNRESET', { code: 'ECONNRESET' }, 'ambiguous'],
  ['unknown no code', {}, 'ambiguous'],
]) {
  test(`audit: delivery classification ${name} cannot duplicate a delivered message`, async (t) => {
    let clock = NOW;
    t.mock.method(Date, 'now', () => clock);
    const store = await fixture();
    const call = store.doc.calls[0];
    const id = `${call.id}:milestone:2`;
    let attempts = 0; let delivered = 0;
    const send = async () => {
      attempts += 1;
      if (attempts === 1) throw Object.assign(new Error(name), props);
      delivered += 1; return { message_id: 42 };
    };
    const args = { store, call, id, text: 'audit', send };
    const first = await deliverAlert(args);
    assert.equal(store.alertState(id).state, expected);
    if (name === '429') assert.equal(first.retryAfterMs, 7000);
    clock += 7001;
    await Promise.all([deliverAlert(args), deliverAlert(args)]);
    await deliverAlert(args);
    console.log(`AUDIT ${name}: initial=${expected} attempts=${attempts} accepted=${delivered} final=${store.alertState(id).state}`);
    assert.equal(delivered, expected === 'failed' ? 1 : 0);
    assert.equal(attempts, expected === 'failed' ? 2 : 1);
  });
}

test('audit: a crash-left pending row survives real reload and remains terminal', async () => {
  const store = await fixture();
  const call = store.doc.calls[0];
  const id = `${call.id}:milestone:2`;
  await store.claimAlert(id, { callId: call.id });
  const { CallStore: FreshStore } = await import(`../src/store.mjs?pending=${Math.random()}`);
  const fresh = new FreshStore(store.filePath).load();
  let sends = 0;
  const result = await deliverAlert({ store: fresh, call, id, text: 'audit', send: async () => { sends += 1; } });
  assert.equal(result.reason, 'already pending');
  assert.equal(sends, 0);
  assert.equal(fresh.alertStats().pending, 1);
  assert.equal(typeof fresh.reclaimStale, 'undefined');
  console.log(`AUDIT crash recovery: reason=${result.reason} pending=${fresh.alertStats().pending} reclaimStale=${typeof fresh.reclaimStale}`);
});

test('audit: delivered milestone persists across a separate Node process', async () => {
  const store = await fixture();
  const call = store.doc.calls[0];
  let sent = 0;
  await Promise.all([store, new CallStore(store.filePath)].map((s) => processMilestoneEvents({
    store: s, call, currentMarketCapUsd: 200_000, enabled: [2],
    send: async () => { sent += 1; return { message_id: 9 }; },
  })));
  assert.equal(sent, 1);
  const script = `
    import { CallStore } from ${JSON.stringify(new URL('../src/store.mjs', import.meta.url).href)};
    import { processMilestoneEvents } from ${JSON.stringify(new URL('../src/alert-service.mjs', import.meta.url).href)};
    const store = new CallStore(process.argv[1]).load();
    let sent = 0;
    const call = store.doc.calls[0];
    await processMilestoneEvents({store, call, currentMarketCapUsd: 250000, enabled:[2], send:async()=>{sent++;return {message_id:10}}});
    console.log(JSON.stringify({sent,state:store.alertState(call.id+':milestone:2').state}));
  `;
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', script, store.filePath], {
    encoding: 'utf8', timeout: 5000, env: { ...process.env, BOT_NO_LAUNCH: '1', CALLS_DB_PATH: store.filePath },
  });
  assert.equal(child.status, 0, child.stderr);
  assert.deepEqual(JSON.parse(child.stdout.trim()), { sent: 0, state: 'delivered' });
  console.log(`AUDIT restart: ${child.stdout.trim()}`);
});

test('audit: abort interrupts a long observer sleep without leaving timers', async () => {
  const ac = new AbortController();
  let finished;
  const first = new Promise((resolve) => { finished = resolve; });
  const obs = startObserver({
    signal: ac.signal, log: quiet, intervalMs: 3_600_000,
    runCycleFn: async () => {
      finished(); return { observed: 0, failures: [], tiers: {}, open: 0 };
    },
  });
  await first;
  await new Promise((resolve) => setImmediate(resolve));
  const started = performance.now();
  ac.abort();
  await obs.done;
  const ms = performance.now() - started;
  console.log(`AUDIT idle shutdown=${ms.toFixed(2)}ms`);
  assert.ok(ms < 500);
});

test('audit: a pre-aborted signal starts zero observer cycles', async () => {
  const ac = new AbortController(); ac.abort();
  let cycles = 0;
  const obs = startObserver({
    signal: ac.signal, log: quiet,
    runCycleFn: async () => { cycles += 1; return { observed: 0, failures: [], tiers: {} }; },
  });
  obs.stop(); await obs.done;
  console.log(`AUDIT pre-aborted cycles=${cycles}`);
  assert.equal(cycles, 0);
});

test('audit: malformed milestone settings do not break the owner panel', async () => {
  const store = await fixture();
  for (const milestones of [null, 7, 'broken', {}, [2, null, '<bad>']]) {
    store.doc.groups[GROUP].alerts.milestones = milestones;
    let response;
    await handleAlerts({
      from: { id: 1 }, chat: { id: GROUP, type: 'group' }, reply: async (text) => { response = text; },
    }, { store, policy: { ownerIds: new Set(['1']) } });
    assert.match(response, /Milestones:/);
    assert.ok(!response.includes('<bad>'));
  }
});

test('audit: sparse or null call records cannot poison a healthy observation', async () => {
  const store = await fixture();
  store.doc.calls.unshift(null, { status: 'active' }, { id: 'sparse', status: 'active', calledAt: NOW - 1 });
  let scans = 0;
  const summary = await runCycle({
    store, now: NOW, scan: async () => { scans += 1; return snapshot(); },
    send: async () => ({ message_id: 1 }), dexPaid: async () => ({ status: 'unknown' }),
  });
  console.log(`AUDIT malformed calls: observed=${summary.observed} scans=${scans}`);
  assert.equal(summary.observed, 1);
  assert.equal(scans, 1);
  assert.deepEqual(summary.failures, []);
});

test('audit: abort reaches an in-flight provider and skips remaining observations', async (t) => {
  t.mock.method(Date, 'now', () => NOW);
  const store = await fixture(3);
  const ac = new AbortController();
  let began;
  const started = new Promise((resolve) => { began = resolve; });
  let requests = 0; let writes = 0; let sends = 0;
  const update = store.updateCall.bind(store);
  store.updateCall = async (...args) => { writes += 1; return update(...args); };
  const fetchImpl = async (_url, opts = {}) => new Promise((resolve, reject) => {
    requests += 1; began();
    const timer = setTimeout(() => { cleanup(); resolve({ ok: true }); }, 150);
    function abort() { cleanup(); reject(Object.assign(new Error('aborted'), { name: 'AbortError' })); }
    function cleanup() { clearTimeout(timer); opts.signal?.removeEventListener('abort', abort); }
    opts.signal?.addEventListener('abort', abort, { once: true });
    if (opts.signal?.aborted) abort();
  });
  const obs = startObserver({
    store, log: quiet, signal: ac.signal, intervalMs: 3_600_000, fetchImpl,
    scan: async (_req, options = {}) => {
      await (options.fetchImpl ?? fetchImpl)('https://audit.invalid/provider', { signal: options.signal });
      return snapshot();
    },
    send: async () => { sends += 1; return { message_id: 1 }; },
    dexPaid: async () => ({ status: 'unknown' }),
  });
  await started;
  const time = performance.now();
  ac.abort(); await obs.done;
  const ms = performance.now() - time;
  console.log(`AUDIT inflight abort=${ms.toFixed(2)}ms requests=${requests} writes=${writes} sends=${sends}`);
  assert.ok(ms < 100, `shutdown waited ${ms}ms for uncancelled provider`);
  assert.equal(requests, 1);
  assert.equal(writes, 0);
  assert.equal(sends, 0);
});

test('audit: fatal cycle rejection is caught and does not escape the loop', async () => {
  const ac = new AbortController();
  const errors = []; const unhandled = [];
  const onUnhandled = (err) => unhandled.push(err);
  process.on('unhandledRejection', onUnhandled);
  try {
    const obs = startObserver({
      signal: ac.signal,
      runCycleFn: async () => { throw new Error('malformed provider fixture'); },
      log: { ...quiet, error: (text) => { errors.push(text); ac.abort(); } },
    });
    await obs.done;
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(errors.length, 1);
    assert.deepEqual(unhandled, []);
    console.log(`AUDIT fatal cycle: logged=${errors.length} unhandled=${unhandled.length}`);
  } finally { process.removeListener('unhandledRejection', onUnhandled); }
});

test('audit: zero global request budget makes zero provider calls', async () => {
  const store = await fixture(3, { paid: true });
  let requests = 0;
  const summary = await runCycle({
    store, now: NOW, maxRequests: 0,
    scan: async () => { requests += 1; return snapshot(); },
    dexPaid: async () => { requests += 1; return { status: 'not-paid' }; },
    send: async () => { throw new Error('must not send'); },
  });
  assert.equal(requests, 0);
  assert.equal(summary.providerRequests, 0);
});

test('audit: Dex Paid request budget is per token, not per group', async () => {
  const store = await fixture(1, { paid: true });
  store.doc.calls.push({ ...store.doc.calls[0], id: 'c2', chatId: '-999' });
  store.groupSettings('-999');
  let requests = 0;
  const summary = await runCycle({
    store, now: NOW, maxCalls: 0, maxRequests: 1,
    scan: async () => { throw new Error('no market budget'); },
    dexPaid: async () => { requests += 1; return { status: 'not-paid' }; },
    send: async () => { throw new Error('must not send'); },
  });
  assert.equal(requests, 1);
  assert.equal(summary.providerRequests, 1);
  assert.equal(store.alertState('c1:dex-paid').lastStatus, 'not-paid');
  assert.equal(store.alertState('c2:dex-paid').lastStatus, 'not-paid');
});


