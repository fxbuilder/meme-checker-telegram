/**
 * test/phase4-pacing.test.mjs
 *
 * Concurrent reservations must take turns. The measured provider behaviour was
 * 200 then 429 on back-to-back searches, and the 429 was still billed - so a burst is
 * both wasteful and unrecoverable.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { RequestBudget } from '../src/research/research-cache.mjs';

/** A fake clock that advances only when sleep() is awaited. */
function fakeClock() {
  const state = { t: 0, waits: [] };
  globalThis.__researchSleep = (ms) => { state.t += ms; state.waits.push(ms); return Promise.resolve(); };
  return state;
}

test('concurrent reservations are serialised, not fired together', async () => {
  const clock = fakeClock();
  const b = new RequestBudget({ limit: 10, label: 'x', now: () => clock.t, minIntervalMs: 5000 });

  // Previously these all read the same lastSpendAt, waited the same interval, and
  // woke together - the floor held for sequential calls only.
  const results = await Promise.all([1, 2, 3, 4, 5].map(() => b.reserve()));

  assert.deepEqual(results, [true, true, true, true, true]);
  assert.equal(b.used, 5);
  assert.equal(clock.t, 20_000, 'four gaps of 5s after the first free request');
  delete globalThis.__researchSleep;
});

test('a clock that reads 0 still paces (null sentinel, not zero)', async () => {
  const clock = fakeClock();
  const b = new RequestBudget({ limit: 5, label: 'x', now: () => clock.t, minIntervalMs: 3000 });
  // lastSpendAt starts null; the first call must be free, the second must wait.
  assert.equal(await b.reserve(), true);
  assert.equal(clock.t, 0, 'the first request is never delayed');
  assert.equal(await b.reserve(), true);
  assert.equal(clock.t, 3000);
  delete globalThis.__researchSleep;
});

test('the lock is released on a refused spend, so later calls still resolve', async () => {
  const clock = fakeClock();
  const b = new RequestBudget({ limit: 1, label: 'x', now: () => clock.t, minIntervalMs: 1000 });
  assert.equal(await b.reserve(), true);
  assert.equal(await b.reserve(), false, 'over the limit');
  // A deadlocked chain would hang here forever.
  b.limit = 2;
  assert.equal(await b.reserve(), true, 'the chain is still usable');
  delete globalThis.__researchSleep;
});

test('concurrent exhaustion allows exactly the remaining budget', async () => {
  const clock = fakeClock();
  const b = new RequestBudget({ limit: 2, label: 'x', now: () => clock.t, minIntervalMs: 1000 });
  const results = await Promise.all([1, 2, 3, 4].map(() => b.reserve()));
  assert.equal(results.filter(Boolean).length, 2, 'no overspend under concurrency');
  assert.equal(b.used, 2);
  delete globalThis.__researchSleep;
});

test('pacing can be disabled explicitly', async () => {
  const clock = fakeClock();
  const b = new RequestBudget({ limit: 5, label: 'x', now: () => clock.t, minIntervalMs: 0 });
  await b.reserve();
  await b.reserve();
  assert.equal(clock.t, 0);
  delete globalThis.__researchSleep;
});
