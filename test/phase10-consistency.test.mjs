/**
 * test/phase10-consistency.test.mjs
 *
 * Round 4: ONE risk classification engine, shared by card and /risk.
 *
 * The OWNER reported a token whose Top 10 was 20%: GREEN on the main card, YELLOW on the
 * detailed security card. Two causes, both fixed here:
 *   1. Two threshold tables (card: >=25 warn; /risk: >=25 'elevated', and 'low' -> yellow).
 *   2. Severity banded on the RAW value while the DISPLAYED value was rounded, so 19.98
 *      printed as "20.0%" but classified below the 20 line.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  classifyTop10, classifyTax, classifyTransferFee, classifyLiquidity,
  classifyCreatorHolding, classifyHoneypot, classifyFlag, classifyRugCheckScore,
  classifyRiskBlock, iconFor, statePlaceholder, FIELD_STATE, SEVERITY_ICON,
} from '../src/risk-classify.mjs';
import { resolveQuickCheck } from '../src/card-layout.mjs';
import { renderRisk, concentrationTone, taxTone } from '../src/risk-commands.mjs';
import { emptyRisk } from '../src/risk-intel.mjs';

const TARGET = { address: '0xabc', chain: 'robinhood' };
const render = (risk) => renderRisk({ target: TARGET, chain: 'robinhood', chainName: 'Robinhood', risk });

// ---- the reported contradiction ------------------------------------------

test('a 20% concentration is MEDIUM on the card AND in /risk', () => {
  // The exact OWNER case. TEXEL returned 19.98, which is displayed as "20.0%".
  const risk = { ...emptyRisk(), holders: { top10Percentage: 19.98 } };

  const card = resolveQuickCheck('top10', { risk, riskStatus: 'ok' });
  const detail = render({ status: 'ok', data: risk });

  assert.equal(card.value, '20.0%', 'the card shows the rounded figure');
  assert.equal(card.tone, 'medium', 'and classifies on that same figure');

  // Both surfaces must resolve to the same severity token.
  assert.equal(concentrationTone(19.98), 'medium');
  assert.equal(iconFor(classifyTop10(19.98)), SEVERITY_ICON.medium);
  assert.ok(detail.includes('🟡'), '/risk must show the same yellow');
  assert.ok(!detail.includes('🔴'), 'and must not overstate it as critical');
});

test('the same input yields the same severity glyph on both surfaces', () => {
  for (const pct of [0, 5, 19.98, 20, 24.96, 25, 49.9, 50, 75, 100]) {
    const cls = classifyTop10(pct);
    const card = resolveQuickCheck('top10', {
      risk: { ...emptyRisk(), holders: { top10Percentage: pct } }, riskStatus: 'ok',
    });
    assert.equal(card.tone, cls.severity, `card severity for ${pct}`);

    const detail = render({ status: 'ok', data: { ...emptyRisk(), holders: { top10Percentage: pct } } });
    assert.ok(detail.includes(iconFor(cls)), `/risk glyph for ${pct} (${cls.severity})`);
  }
});

test('rounding to a band boundary sets the band, not the raw value', () => {
  // 24.96 displays as "25.0%", so it must read as medium, never low.
  assert.equal(classifyTop10(24.96).severity, 'medium');
  assert.equal(classifyTop10(24.96).shown, 25);
  // 49.96 displays as "50.0%", so it must read as high.
  assert.equal(classifyTop10(49.96).severity, 'high');
});

// ---- four evidence states, never collapsed --------------------------------

test('unknown is grey on every surface, never green and never red', () => {
  const c = classifyTop10(null);
  assert.equal(c.state, FIELD_STATE.UNKNOWN);
  assert.equal(iconFor(c), '⚪');
  assert.notEqual(iconFor(c), SEVERITY_ICON.low);

  const card = resolveQuickCheck('top10', { risk: { ...emptyRisk() }, riskStatus: 'ok' });
  assert.equal(card.value, '—');
  assert.equal(card.tone, 'muted');
});

test('a null LP state is UNKNOWN, never "unlocked"', () => {
  // The most dangerous possible misreading: "we could not tell" must not become
  // "the liquidity is free to be pulled".
  const c = classifyLiquidity(null);
  assert.equal(c.state, FIELD_STATE.UNKNOWN);
  assert.notEqual(c.kind, 'unlocked');
  const card = resolveQuickCheck('lpLock', { risk: { ...emptyRisk() }, riskStatus: 'ok' });
  assert.equal(card.value, '—');
  assert.notEqual(card.value, '0%');
});

test('burned and locked are distinct and are never summed', () => {
  const burned = classifyLiquidity({ burnedPercentage: 100, lockedPercentage: 0 });
  assert.equal(burned.kind, 'burned');
  // A fully burned LP is the strongest possible guarantee, so its severity is 'none'.
  assert.equal(burned.severity, 'none');

  const locked = classifyLiquidity({ burnedPercentage: 0, lockedPercentage: 95 });
  assert.equal(locked.kind, 'locked');
  assert.notEqual(locked.kind, 'burned', 'a lock is not a burn');
});

test('a partial lock is not reported as fully locked', () => {
  assert.equal(classifyLiquidity({ lockedPercentage: 60 }).kind, 'partially-locked');
  assert.equal(classifyLiquidity({ lockedPercentage: 60 }).severity, 'medium');
});

test('an expired time lock reads as unlocked, because the guarantee is gone', () => {
  const past = Math.floor(Date.now() / 1000) - 86_400;
  const c = classifyLiquidity({ lockedPercentage: 100, expiresAt: past });
  assert.equal(c.kind, 'unlocked');
  assert.equal(c.severity, 'high');
});

test('a pre-graduation bonding curve is its own state, not unlocked', () => {
  const c = classifyLiquidity({ kind: 'bonding-curve' });
  assert.equal(c.kind, 'bonding-curve');
  assert.notEqual(c.kind, 'unlocked');
  assert.equal(c.state, FIELD_STATE.VERIFIED);
});

test('not-applicable and unknown are different strings', () => {
  assert.equal(statePlaceholder(FIELD_STATE.NOT_APPLICABLE), 'N/A');
  assert.equal(statePlaceholder(FIELD_STATE.UNKNOWN), 'UNKNOWN');
  assert.notEqual(statePlaceholder(FIELD_STATE.NOT_APPLICABLE), statePlaceholder(FIELD_STATE.UNKNOWN));
});

// ---- tax ----------------------------------------------------------------

test('a measured zero tax is "none" and a missing tax is UNKNOWN', () => {
  assert.equal(classifyTax(0, 0).severity, 'none');
  assert.equal(classifyTax(0, 0).state, FIELD_STATE.VERIFIED);
  // Missing is NOT zero: one is a green light, the other is an absence of evidence.
  assert.equal(classifyTax(null, null).state, FIELD_STATE.UNKNOWN);
  assert.equal(classifyTax(null, null).severity, 'unknown');
});

test('tax bands are shared between the card and /risk', () => {
  for (const [buy, sell, expected] of [[0, 0, 'none'], [1, 1, 'low'], [6, 6, 'medium'], [15, 15, 'high']]) {
    const card = resolveQuickCheck('tax', {
      risk: { ...emptyRisk(), tax: { buy, sell } }, riskStatus: 'ok',
    });
    assert.equal(card.tone, expected, `card tax tone for ${buy}/${sell}`);
  }
});

test('a transfer fee is labelled separately from a tax', () => {
  const card = resolveQuickCheck('tax', {
    risk: { ...emptyRisk(), tax: { kind: 'transfer-fee', pct: 2.5 } }, riskStatus: 'ok',
  });
  assert.equal(card.label, 'Transfer Fee');
  assert.notEqual(card.label, 'Tax (B/S)');
});

test('legacy SPL is NOT_APPLICABLE, an unknown standard is UNKNOWN', () => {
  assert.equal(classifyTransferFee(null, 'spl-token').state, FIELD_STATE.NOT_APPLICABLE);
  assert.equal(classifyTransferFee(null, null).state, FIELD_STATE.UNKNOWN);
});

// ---- honeypot and flags --------------------------------------------------

test('honeypot is a level, and UNKNOWN is never LOW', () => {
  assert.equal(classifyHoneypot(null).level, 'UNKNOWN');
  assert.equal(classifyHoneypot(null).severity, 'unknown');
  assert.notEqual(classifyHoneypot(null).level, 'LOW');
  assert.equal(classifyHoneypot(false).level, 'LOW');
  assert.equal(classifyHoneypot(true).level, 'HIGH');
});

test('a false flag is a measured pass and a null flag is unknown', () => {
  assert.equal(classifyFlag(false).severity, 'none');
  assert.equal(classifyFlag(null).severity, 'unknown');
  assert.notEqual(classifyFlag(null).severity, 'none', 'unmeasured must never read as safe');
});

// ---- impossible values ---------------------------------------------------

test('an impossible percentage is CONFLICTING, not critical', () => {
  // Calling a >100% figure "critical risk" would accuse the token of something the
  // number cannot actually show.
  const c = classifyTop10(150);
  assert.equal(c.state, FIELD_STATE.CONFLICTING);
  assert.equal(iconFor(c), '⚪', 'a contradiction is grey, not red');
});

test('an out-of-range RugCheck score is refused', () => {
  assert.equal(classifyRugCheckScore(101).state, FIELD_STATE.CONFLICTING);
  assert.equal(classifyRugCheckScore(null).state, FIELD_STATE.UNKNOWN);
});

// ---- whole-block consistency --------------------------------------------

test('classifyRiskBlock covers every displayed field', () => {
  const b = classifyRiskBlock({
    holders: { top10Percentage: 20, total: 500, largestHolderPercentage: 5 },
    tax: { buy: 0, sell: 0 },
    lpLock: { burnedPercentage: 100 },
    dev: { balancePercentage: 0 },
    security: { honeypot: false, mintable: false, freezable: null, rugcheckScore: 7 },
  });
  for (const key of ['top10', 'holders', 'largestHolder', 'tax', 'liquidity', 'creator', 'honeypot', 'mintable', 'freezable', 'rugcheckScore']) {
    assert.ok(b[key], `missing classification: ${key}`);
    assert.ok(b[key].state, `${key} needs a state`);
  }
  assert.equal(b.top10.severity, 'medium');
  assert.equal(b.liquidity.kind, 'burned');
  assert.equal(b.honeypot.level, 'LOW');
});
