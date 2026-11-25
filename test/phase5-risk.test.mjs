/**
 * test/phase5-risk.test.mjs
 *
 * Phase 5 — risk evidence honesty.
 *
 * The failure mode this suite guards against is a scanner that implies safety from
 * missing data: "Honeypot: No" when the provider returned nothing, "Tax 0%" when tax
 * was never measured, "n/a" rendering as a green tick.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  renderRisk, renderDev, renderBundle, riskCapabilityMatrix,
  concentrationTone, taxTone,
} from '../src/risk-commands.mjs';

const TARGET = { chain: 'ethereum', address: '0x6982508145454ce325ddbe47a25d4ec3d2311933' };

const fullData = () => ({
  holders: { total: 579980, top10Percentage: 38.61, largestHolderPercentage: 11.9 },
  tax: { buy: 0, sell: 0 },
  lpLock: { lockedPercentage: 96, coveredPercentage: 100 },
  dev: { address: '0xabc', balancePercentage: 0.02 },
  security: {
    honeypot: false, mintable: false, freezable: true,
    canTakeBackOwnership: false, hiddenOwner: false, openSource: true, cannotSellAll: false,
  },
});

const render = (risk, chain = 'ethereum') => renderRisk({
  target: { ...TARGET, chain }, risk, chainName: chain === 'solana' ? 'Solana' : 'Ethereum',
});

// ---- unsupported must never look clean ----------------------------------

test('an unsupported chain says nothing was verified, not that the token is safe', () => {
  const t = render({ status: 'unsupported' }, 'monad');
  assert.match(t, /No risk provider covers/i);
  assert.match(t, /not a clean result/i);
  assert.ok(!/Honeypot: 🟢/.test(t), 'no green flags may appear without data');
  assert.ok(!/0\.00%/.test(t));
});

test('a provider error draws no conclusion', () => {
  const t = render({ status: 'error', detail: 'timeout' });
  assert.match(t, /could not be reached/i);
  assert.match(t, /No conclusion can be drawn/i);
});

test('no provider record is stated as unknown, not safe', () => {
  const t = render({ status: 'no-data' });
  assert.match(t, /no record for this contract/i);
  assert.match(t, /says nothing about safety/i);
});

// ---- unknown fields ------------------------------------------------------

test('an absent honeypot flag renders UNKNOWN, never a green pass', () => {
  const t = render({ status: 'ok', data: { holders: {}, tax: null, lpLock: null, dev: null, security: { honeypot: null, mintable: null, freezable: null } } });
  // ROUND 3: the honeypot is now an explicit four-state RISK LEVEL rather than a
  // yes/no flag, because "No" in green overstated what a provider actually verified.
  assert.match(t, /Honeypot Risk: ⚪ <b>UNKNOWN<\/b>/);
  assert.match(t, /Mintable: —/);
  assert.match(t, /Freezable: —/);
  assert.ok(!/Honeypot Risk: 🟢/.test(t), 'unknown must never read as a pass');
  assert.ok(!/Honeypot Risk: LOW/.test(t), 'an unmeasured flag is not LOW risk');
});

test('a measured clean honeypot flag is LOW and a detected one is HIGH', () => {
  const low = render({ status: 'ok', data: { holders: {}, tax: null, lpLock: null, dev: null, security: { honeypot: false } } });
  assert.match(low, /Honeypot Risk: 🟢 <b>LOW<\/b>/);
  const high = render({ status: 'ok', data: { holders: {}, tax: null, lpLock: null, dev: null, security: { honeypot: true } } });
  assert.match(high, /Honeypot Risk: 🔴 <b>HIGH<\/b>/);
});

test('a RugCheck score is attributed to RugCheck and never invented', () => {
  const withScore = render({ status: 'ok', data: { holders: {}, tax: null, lpLock: null, dev: null, security: { rugcheckScore: 42 } } });
  assert.match(withScore, /RugCheck Score: 🟡 <b>42<\/b>\/100 \(MEDIUM risk\)/);
  // Absent score: no line at all, rather than a zero that reads as clean.
  const noScore = render({ status: 'ok', data: { holders: {}, tax: null, lpLock: null, dev: null, security: {} } });
  assert.ok(!/RugCheck Score/.test(noScore));
  assert.ok(!/RugCheck Score: .*<b>0<\/b>/.test(noScore), 'a missing score is not 0');
});

test('missing tax is not zero tax', () => {
  const t = render({ status: 'ok', data: { holders: {}, security: {}, tax: null, lpLock: null, dev: null } });
  assert.ok(!/Buy 🟢 0/.test(t), 'no measured tax may be printed as 0%');
  assert.match(t, /Buy|—/);
});

test('Solana tax is explained as a non-concept rather than unknown', () => {
  const t = render({ status: 'ok', data: { ...fullData(), tax: null } }, 'solana');
  assert.match(t, /no tax concept on Solana/i);
});

// ---- concentration -------------------------------------------------------

test('an irreconcilable Top 10 is shown as unknown with a reason', () => {
  const t = render({
    status: 'ok',
    data: { ...fullData(), holders: { total: 100, top10Percentage: null, concentrationReason: 'inconsistent-denominator' } },
  });
  assert.match(t, /Top 10: —/);
  assert.match(t, /could not be reconciled/i);
});

test('a concentration above 100 can never be rendered', () => {
  const t = render({ status: 'ok', data: { ...fullData(), holders: { total: 1, top10Percentage: 111.1 } } });
  // The value reaching the renderer is a defect upstream; it must not print as valid.
  assert.ok(!/111\.1%/.test(t), 'an impossible percentage must never be displayed');
});

test('concentration tones are thresholds, and null has no tone', () => {
  assert.equal(concentrationTone(null), null);
  assert.equal(concentrationTone(10), 'low');
  assert.equal(concentrationTone(25), 'elevated');
  assert.equal(concentrationTone(50), 'high');
});

test('a tiny positive holding never prints as 0.00%', () => {
  const t = render({ status: 'ok', data: { ...fullData(), holders: { total: 10, top10Percentage: 0.004, largestHolderPercentage: 0.004 } } });
  assert.match(t, /<0\.01%/);
  // Only the holder lines matter: other lines legitimately contain "100.0%".
  const holderLines = t.split('\n').filter((l) => /Top 10|Largest holder/.test(l)).join(' ');
  assert.ok(!/0\.00%/.test(holderLines), '"holds nothing" and "holds a little" are different claims');
});

// ---- LP ------------------------------------------------------------------

test('LP with low provider coverage is unknown, not "unlocked"', () => {
  const t = render({ status: 'ok', data: { ...fullData(), lpLock: { lockedPercentage: 0.4, coveredPercentage: 0.4 } } });
  assert.match(t, /provider reported only/i);
  assert.match(t, /no conclusion possible/i);
  assert.ok(!/unlocked/i.test(t));
});

test('high LP lock over full coverage reads as positive', () => {
  const t = render({ status: 'ok', data: fullData() });
  assert.match(t, /LP locked\/burned: 🟢/);
  assert.match(t, /measured across 100\.0% of LP/);
});

// ---- /dev ---------------------------------------------------------------

test('an absent creator record is not evidence the creator holds nothing', () => {
  const t = renderDev({ target: TARGET, risk: { status: 'ok', data: { ...fullData(), dev: null } }, chainName: 'Ethereum' });
  assert.match(t, /No creator record/i);
  assert.match(t, /not evidence that a creator holds nothing/i);
});

test('an exact zero creator holding is stated as measured', () => {
  const t = renderDev({ target: TARGET, risk: { status: 'ok', data: { ...fullData(), dev: { address: '0xa', balancePercentage: 0 } } }, chainName: 'Ethereum' });
  assert.match(t, /0% \(none at snapshot\)/);
});

test('/dev on an unsupported chain is a coverage gap', () => {
  const t = renderDev({ target: { chain: 'monad', address: '0x1' }, risk: { status: 'unsupported' }, chainName: 'Monad' });
  assert.match(t, /No creator data source covers/i);
});

// ---- /bundle ------------------------------------------------------------

test('/bundle states what it does NOT measure instead of a false all-clear', () => {
  const t = renderBundle({ target: TARGET, risk: { status: 'ok', data: fullData() }, chainName: 'Ethereum' });
  assert.match(t, /Not measured/i);
  assert.match(t, /Bundled buys/i);
  assert.match(t, /sniper/i);
  // The critical assertion: no all-clear wording.
  assert.ok(!/Bundle: (No|None|Clean)/i.test(t), 'a missing analysis must not read as a pass');
  assert.match(t, /do not prove coordination/i);
});

// ---- capability matrix ---------------------------------------------------

test('the risk capability matrix matches the chain registry', () => {
  const m = riskCapabilityMatrix([
    { id: 'ethereum', name: 'Ethereum', goplus: 'evm', goplusId: 1 },
    { id: 'solana', name: 'Solana', goplus: 'solana' },
    { id: 'monad', name: 'Monad' },
  ]);
  assert.equal(m.length, 3);
  assert.equal(m.find((x) => x.chain === 'ethereum').tax, true, 'EVM has a tax concept');
  assert.equal(m.find((x) => x.chain === 'solana').tax, false, 'Solana has none');
  assert.equal(m.find((x) => x.chain === 'monad').provider, null);
  assert.ok(m.every((x) => x.bundle === false), 'bundle analysis is not implemented anywhere');
});

// ---- malicious content ---------------------------------------------------

test('provider-supplied text is HTML-escaped', () => {
  const t = renderRisk({
    target: { chain: 'ethereum', address: '0x<script>alert(1)</script>' },
    risk: { status: 'ok', data: fullData() },
    chainName: '<img onerror=x>',
  });
  assert.ok(!/<script>/.test(t));
  assert.ok(!/<img onerror/.test(t));
});
