import test from 'node:test';
import assert from 'node:assert/strict';
import { formatCard, renderFirstCallLine } from '../src/format-card.mjs';
import { aggregateCaller, renderCallerProfile, HIT_THRESHOLD, PERIODS } from '../src/caller-profile.mjs';

const RESULT = {
  status: 'ok',
  chain: 'solana',
  address: 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263',
  name: 'Bonk',
  symbol: 'BONK',
  priceUsd: 0.00000228,
  marketCapUsd: 201_030_000,
  liquidityUsd: 226_200,
  volume24hUsd: 367_800,
  change1h: 4.98,
  change24h: 9.89,
  pairCreatedAt: Date.now() - 3 * 365 * 86400_000,
  website: 'https://bonkcoin.com',
  socials: { x: 'https://x.com/bonk_inu' },
  risk: null,
  dexPaid: 'unknown',
  holders: null,
  top10Pct: null,
  narrative: null,
};

const CALL = {
  id: 'c1', callerKey: 'u:1307106746', callerName: 'Foxy',
  entryMarketCapUsd: 18_220_000, calledAt: Date.now() - 3600_000,
  chain: 'solana', address: RESULT.address, symbol: 'BONK', status: 'active',
};

test('the First Call line appears inside the card, before the footer', () => {
  const { text } = formatCard(RESULT, { view: 'standard', firstCall: CALL, botUsername: 'MemeCheckerStagingBot', callerToken: 'cp_abc' });
  assert.ok(text.includes('First Call'), 'line present');
  assert.ok(text.includes('$18.22M'), 'entry market cap present');
  const fi = text.indexOf('First Call');
  const footer = text.indexOf('Powered by MEME CHECKER');
  assert.ok(fi > -1 && footer > fi, 'First Call must come before the footer');
});

test('no call means no First Call line at all', () => {
  const { text } = formatCard(RESULT, { view: 'standard' });
  assert.ok(!text.includes('First Call'));
});

test('the caller name is a t.me start deep link, not a user profile link', () => {
  const { text } = formatCard(RESULT, { view: 'standard', firstCall: CALL, botUsername: 'MemeCheckerStagingBot', callerToken: 'cp_abc' });
  assert.match(text, /<a href="https:\/\/t\.me\/MemeCheckerStagingBot\?start=cp_abc">Foxy<\/a>/);
  assert.ok(!text.includes('tg://user'), 'must not link to a Telegram user profile');
});

test('without a token the name is plain bold text, never a broken link', () => {
  const { text } = formatCard(RESULT, { view: 'standard', firstCall: CALL, botUsername: 'MemeCheckerStagingBot' });
  assert.ok(text.includes('<b>Foxy</b>'));
  assert.ok(!text.includes('<a href'));
});

test('a hostile caller name is escaped inside the link', () => {
  const hostile = { ...CALL, callerName: '<script>alert(1)</script>' };
  const { text } = formatCard(RESULT, { view: 'standard', firstCall: hostile, botUsername: 'B', callerToken: 'cp_abc' });
  assert.ok(!text.includes('<script>'), 'raw script tag must not survive');
  assert.ok(text.includes('&lt;script&gt;'));
});

test('an anonymous admin renders without a fake person name', () => {
  const anon = { ...CALL, callerKey: 'c:-5333984336', callerName: null, callerUsername: null };
  const { text } = formatCard(RESULT, { view: 'standard', firstCall: anon, botUsername: 'B', callerToken: 'cp_abc' });
  assert.ok(text.includes('Anonymous admin'));
});

test('the line renders even when the entry market cap is missing', () => {
  const noMcap = { ...CALL, entryMarketCapUsd: null };
  const line = renderFirstCallLine(noMcap);
  assert.ok(line.includes('First Call'));
  assert.ok(!line.includes('undefined'));
  assert.ok(!line.includes('null'));
});

// ---- caller profile aggregation -----------------------------------------

function mkCall(over, i = 0) {
  return {
    id: `c${i}`, chatId: '-1', callerKey: 'u:42', callerName: 'Foxy',
    chain: 'solana', address: `addr${i}`, symbol: `T${i}`,
    entryMarketCapUsd: 1_000_000,
    calledAt: Date.now() - 3600_000 * (i + 1),
    ...over,
  };
}

test('hit rate counts peaks at or above the declared threshold', () => {
  // Peaks of 3x, 1.2x, 2x → 2 hits out of 3 at >= 2x.
  const calls = [
    mkCall({ peakMarketCapUsd: 3_000_000, currentMarketCapUsd: 2_000_000 }, 0),
    mkCall({ peakMarketCapUsd: 1_200_000, currentMarketCapUsd: 1_100_000 }, 1),
    mkCall({ peakMarketCapUsd: 2_000_000, currentMarketCapUsd: 1_500_000 }, 2),
  ];
  const agg = aggregateCaller(calls, { period: '7d' });
  assert.equal(agg.measuredCalls, 3);
  assert.equal(agg.hits, 2);
  assert.equal(Math.round(agg.hitRate), 67);
  assert.equal(agg.hitThreshold, HIT_THRESHOLD);
});

test('average and median differ when one call is an outlier', () => {
  const calls = [
    mkCall({ peakMarketCapUsd: 100_000_000 }, 0), // 100x
    mkCall({ peakMarketCapUsd: 2_000_000 }, 1),   // 2x
    mkCall({ peakMarketCapUsd: 3_000_000 }, 2),   // 3x
  ];
  const agg = aggregateCaller(calls, { period: '7d' });
  assert.ok(agg.averagePeak > 30, `average ${agg.averagePeak}`);
  assert.equal(agg.medianPeak, 3, `median ${agg.medianPeak}`);
});

test('calls outside the period are excluded', () => {
  const old = mkCall({ peakMarketCapUsd: 5_000_000, calledAt: Date.now() - 20 * 86400_000 }, 0);
  const fresh = mkCall({ peakMarketCapUsd: 2_000_000 }, 1);
  assert.equal(aggregateCaller([old, fresh], { period: '7d' }).totalCalls, 1);
  assert.equal(aggregateCaller([old, fresh], { period: '30d' }).totalCalls, 2);
  assert.equal(aggregateCaller([old, fresh], { period: '1d' }).totalCalls, 1);
  assert.equal(aggregateCaller([old, fresh], { period: '14d' }).totalCalls, 1);
});

test('calls with no observed peak are excluded from the rate, not counted as misses', () => {
  const calls = [mkCall({ peakMarketCapUsd: 3_000_000 }, 0), mkCall({ peakMarketCapUsd: null }, 1)];
  const agg = aggregateCaller(calls, { period: '7d' });
  assert.equal(agg.totalCalls, 2);
  assert.equal(agg.measuredCalls, 1);
  assert.equal(agg.unmeasuredCalls, 1);
  assert.equal(Math.round(agg.hitRate), 100, 'one measured hit out of one measured');
});

test('an empty period says so instead of showing zero percentages', () => {
  const { text } = renderCallerProfile({ callerKey: 'u:42', calls: [], groupTitle: 'sissooo1', period: '7d' });
  assert.match(text, /No calls by this caller/);
  assert.ok(!text.includes('0%'));
});

test('the profile states its hit threshold and distinguishes current from peak', () => {
  const calls = [mkCall({ peakMarketCapUsd: 3_000_000, currentMarketCapUsd: 1_500_000 }, 0)];
  const { text } = renderCallerProfile({ callerKey: 'u:42', calls, groupTitle: 'sissooo1', period: '7d' });
  assert.ok(text.includes('≥2x peak'), 'threshold stated');
  assert.ok(text.includes('now '), 'current shown');
  assert.ok(text.includes('peak '), 'peak shown');
  assert.match(text, /not all-time high/);
});

test('the profile includes caller, group and period', () => {
  const calls = [mkCall({}, 0)];
  const { text } = renderCallerProfile({ callerKey: 'u:42', calls, groupTitle: 'sissooo1', period: '14d' });
  assert.ok(text.includes('Foxy'));
  assert.ok(text.includes('sissooo1'));
  assert.ok(text.includes('14D'));
});

test('all four periods exist with the right ids', () => {
  assert.deepEqual(PERIODS.map((p) => p.id), ['1d', '7d', '14d', '30d']);
});
