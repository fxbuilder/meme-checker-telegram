/**
 * test/phase10-matrix-fixes.test.mjs
 *
 * Defects found by the live coverage matrix (not by unit tests), codified so they cannot
 * regress:
 *   - a one-holder sample rendering a green "Top 10: 0%"
 *   - an inconsistency warning that does not name the inconsistency
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { holderConcentration } from '../src/risk-intel.mjs';
import { marketImplausibilities, marketLooksImplausible } from '../src/card-layout.mjs';
import { resolveQuickCheck } from '../src/card-layout.mjs';
import { emptyRisk } from '../src/risk-intel.mjs';

// ---- the one-holder false-safe -------------------------------------------

test('a single holder row does NOT become a green Top 10 of 0%', () => {
  // Measured live on BSC: provider returned one holder row at 0.000000%, which rendered as
  // a confident green "Top 10: 0%" - a fabricated all-clear from almost no evidence.
  const r = holderConcentration([{ address: '0xa1', percent: '0.0' }]);
  assert.equal(r.percentage, null, 'no figure may be published from one row');
  assert.equal(r.reason, 'too-few-holder-rows');

  const card = resolveQuickCheck('top10', {
    risk: { ...emptyRisk(), holders: { top10Percentage: r.percentage } },
    riskStatus: 'ok',
  });
  assert.equal(card.value, '—', 'the card shows a dash, not 0%');
  assert.notEqual(card.tone, 'low');
  assert.notEqual(card.tone, 'none');
});

test('two rows are still too few, three are enough', () => {
  const two = holderConcentration([
    { address: '0xa1', percent: '0.1' },
    { address: '0xa2', percent: '0.2' },
  ]);
  assert.equal(two.percentage, null);
  assert.equal(two.reason, 'too-few-holder-rows');

  const three = holderConcentration([
    { address: '0xa1', percent: '0.1' },
    { address: '0xa2', percent: '0.2' },
    { address: '0xa3', percent: '0.05' },
  ]);
  assert.equal(three.percentage, 35);
});

test('an impossible total is reported as inconsistent BEFORE the sample-size guard', () => {
  // "The provider's rows contradict each other" is a stronger finding than "there are few
  // of them", and the old ordering masked it.
  const r = holderConcentration([
    { address: '0x1', percent: '0.8' },
    { address: '0x2', percent: '0.7' },
  ]);
  assert.equal(r.reason, 'inconsistent-denominator');
  assert.equal(r.rawTotal, 150);
});

// ---- named inconsistency -------------------------------------------------

test('the inconsistency warning names the field that is wrong', () => {
  const list = marketImplausibilities({ marketCapUsd: 1e6, volume24hUsd: 2e8 });
  assert.equal(list.length, 1);
  assert.equal(list[0].field, 'volume24hUsd');
  assert.equal(list[0].label, 'Volume 24H');
  assert.match(list[0].reason, /100x/);
});

test('each distinct implausibility is identified separately', () => {
  const cases = [
    [{ marketCapUsd: 9e12 }, 'marketCapUsd'],
    [{ priceChange24h: 5000 }, 'priceChange24h'],
    [{ priceChange1h: -2000 }, 'priceChange1h'],
    [{ marketCapUsd: 1e6, liquidityUsd: 5e7 }, 'liquidityUsd'],
    [{ marketCapUsd: 1e6, fdvUsd: 5e9 }, 'fdvUsd'],
  ];
  for (const [market, expected] of cases) {
    const list = marketImplausibilities(market);
    assert.ok(list.some((i) => i.field === expected), `${expected} not identified`);
  }
});

test('a clean market produces no warning at all', () => {
  assert.deepEqual(marketImplausibilities({ marketCapUsd: 1e6, volume24hUsd: 5e5, liquidityUsd: 2e5, fdvUsd: 1.2e6 }), []);
  assert.equal(marketLooksImplausible({ marketCapUsd: 1e6 }), false);
});

test('the boolean form stays consistent with the detailed list', () => {
  // Legacy callers use the boolean; it must never disagree with the named list.
  for (const m of [
    { marketCapUsd: 9e12 },
    { marketCapUsd: 1e6, volume24hUsd: 2e8 },
    { marketCapUsd: 1e6 },
    null,
  ]) {
    assert.equal(marketLooksImplausible(m), marketImplausibilities(m).length > 0);
  }
});
