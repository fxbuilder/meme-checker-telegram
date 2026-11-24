/**
 * test/phase4a-corrections.test.mjs
 *
 * Section 4A OWNER corrections. Each test here corresponds to a specific instruction
 * from real Telegram testing, and asserts the observable consequence rather than the
 * implementation detail.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { mintCallerToken, resolveCallerToken, DEFAULT_PERIOD, scopeFor } from '../src/deep-link.mjs';
import { aggregateCaller, PERIODS, DEFAULT_PERIOD as PROFILE_DEFAULT } from '../src/caller-profile.mjs';

const CHAT = '-5333984336';
const CALLER = 'u:1307106746';
const CANDIDATES = [{ chatId: CHAT, callerKey: CALLER }];

// ---- 4A/E: Caller Profile defaults to 1D ---------------------------------

test('a newly minted deep-link opens on 1D, not 1W', () => {
  assert.equal(DEFAULT_PERIOD, '1d');
  assert.equal(PROFILE_DEFAULT, '1d');

  const token = mintCallerToken(CHAT, CALLER);
  const decoded = resolveCallerToken(token, CHAT, CANDIDATES);
  assert.equal(decoded.period, '1d', 'a fresh open must land on 1D');
});

test('the scope is minted for 1D, so the window itself is right', () => {
  assert.equal(scopeFor(CHAT, CALLER), `${CHAT}:${CALLER}:1d`);
});

test('every period still decodes, so the buttons are not broken', () => {
  for (const p of ['1d', '7d', '14d', '30d']) {
    const t = mintCallerToken(CHAT, CALLER, p);
    assert.equal(resolveCallerToken(t, CHAT, CANDIDATES)?.period, p, p);
  }
});

test('all four period buttons are still offered', () => {
  assert.deepEqual(PERIODS.map((p) => p.label), ['1D', '1W', '2W', '1M']);
});

test('a token minted for another group never decodes here', () => {
  const foreign = mintCallerToken('-1004300723955', CALLER);
  assert.equal(resolveCallerToken(foreign, CHAT, CANDIDATES), null);
});

test('aggregating without an explicit period uses 1D', () => {
  const now = Date.now();
  const calls = [
    { calledAt: new Date(now - 3600_000).toISOString(), peakMultiple: 2, symbol: 'A', status: 'active' },
    { calledAt: new Date(now - 10 * 86400_000).toISOString(), peakMultiple: 9, symbol: 'B', status: 'active' },
  ];
  const agg = aggregateCaller(calls, { now });
  assert.equal(agg.period.id, '1d');
  // The 10-day-old call must be outside a 1D window.
  assert.ok(agg.calls.every((c) => c.symbol !== 'B'), 'older calls are outside the 1D window');
});
