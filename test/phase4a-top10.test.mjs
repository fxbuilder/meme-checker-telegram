/**
 * test/phase4a-top10.test.mjs
 *
 * Section 4A/F: `Top 10: 111.1%` from a real OWNER screenshot.
 *
 * A concentration percentage above 100 is impossible for a consistent, non-overlapping
 * denominator. The fix must correct the cause, not clamp the symptom.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { holderConcentration, normalizeRisk } from '../src/risk-intel.mjs';

const DEAD = '0x000000000000000000000000000000000000dead';

test('the exact OWNER case (111.1%) is reproduced by a naive sum', () => {
  const rows = [
    { address: 'LP', percent: '0.35' },
    { address: '0xAAA', percent: '0.30' },
    { address: '0xAAA', percent: '0.30' },
    { address: '0xBBB', percent: '0.16' },
    { address: DEAD, percent: '0.001' },
  ];
  const naive = rows.reduce((s, r) => s + Number(r.percent), 0) * 100;
  assert.equal(Number(naive.toFixed(1)), 111.1, 'this is the reported number');
});

test('duplicate addresses are counted once', () => {
  const r = holderConcentration([
    { address: '0xAAA', percent: '0.30' },
    { address: '0xAAA', percent: '0.30' },
  ]);
  assert.equal(r.percentage, 30, 'the same wallet listed twice is one wallet');
  assert.equal(r.counted, 1);
});

test('the LP pool and burn addresses are excluded from concentration', () => {
  const r = holderConcentration([
    { address: '0xLP', percent: '0.5' },
    { address: DEAD, percent: '0.2' },
    { address: '0xAAA', percent: '0.1' },
  ], { exclude: ['0xLP'] });
  assert.equal(r.percentage, 10, 'only the real holder counts');
  assert.equal(r.excluded, 2);
});

test('address exclusion is case-insensitive for EVM', () => {
  const r = holderConcentration([
    { address: '0xABCDEF', percent: '0.9' },
    { address: '0xabc', percent: '0.1' },
  ], { exclude: ['0xabcdef'] });
  assert.equal(r.percentage, 10);
});

test('only the top 10 are summed', () => {
  const rows = Array.from({ length: 15 }, (_, i) => ({ address: `0x${i}`, percent: '0.05' }));
  const r = holderConcentration(rows);
  assert.equal(r.counted, 10);
  assert.equal(r.percentage, 50);
});

test('irreconcilable rows report unknown, never a clamped 100%', () => {
  const r = holderConcentration([
    { address: '0x1', percent: '0.8' },
    { address: '0x2', percent: '0.7' },
  ]);
  assert.equal(r.percentage, null, 'an impossible total must not be presented as a reading');
  assert.equal(r.reason, 'inconsistent-denominator');
  assert.equal(r.rawTotal, 150, 'the diagnostic is kept for operators');
});

test('no rows at all is unknown, not zero', () => {
  const r = holderConcentration([]);
  assert.equal(r.percentage, null);
  assert.equal(r.reason, 'no-holder-rows');
});

test('a genuine low-concentration token still reports its real value', () => {
  const r = holderConcentration([
    { address: '0xa', percent: '0.05' },
    { address: '0xb', percent: '0.04' },
    { address: '0xc', percent: '0.03' },
  ]);
  assert.equal(r.percentage, 12);
});

test('normalizeRisk withholds an invalid figure end to end', () => {
  const out = normalizeRisk('bsc', {
    holder_count: '500',
    holders: [
      { address: '0x1', percent: '0.9' },
      { address: '0x2', percent: '0.9' },
    ],
  });
  assert.equal(out.holders.top10Percentage, null);
  assert.equal(out.holders.concentrationReason, 'inconsistent-denominator');
});

test('normalizeRisk excludes the provider-reported LP holders', () => {
  const out = normalizeRisk('bsc', {
    holder_count: '500',
    holders: [
      { address: '0xLP', percent: '0.40' },
      { address: '0xA', percent: '0.10' },
    ],
    lp_holders: [{ address: '0xLP' }],
  });
  assert.equal(out.holders.top10Percentage, 10);
});
