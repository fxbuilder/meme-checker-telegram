/**
 * test/owner-r1-security.test.mjs
 *
 * Owner round 1, issue 2 — security data completeness.
 *
 * The rules under test are the ones that stop the bot from stating something false:
 * missing is never zero, burned is not locked, and a transfer fee is not a buy/sell tax.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  normalizeRugCheck, lpFromMarkets, holdersFromTop, isSolanaMint,
} from '../src/security/rugcheck.mjs';
import { mergeRisk } from '../src/risk-intel.mjs';
import { resolveQuickCheck } from '../src/card-layout.mjs';
import { emptyRisk } from '../src/risk-intel.mjs';

const SYSTEM = '11111111111111111111111111111111';
const TOKEN_PROG = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
const T22_PROG = 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb';

const report = (over = {}) => ({
  tokenProgram: TOKEN_PROG,
  token: { supply: 1_000_000, decimals: 6 },
  creator: 'CreatorAddr111',
  creatorBalance: 10_000, // 1% of supply
  transferFee: { pct: 0, maxAmount: 0, authority: SYSTEM },
  mintAuthority: null,
  freezeAuthority: null,
  rugged: false,
  totalHolders: 5000,
  topHolders: [
    { address: 'H1', pct: 12 },
    { address: 'H2', pct: 8 },
    { address: 'H3', pct: 3 },
  ],
  markets: [{ lp: { lpMint: 'LPmint1', lpTotalSupply: 1000, lpLockedPct: 95 } }],
  ...over,
});

// ---- chain identification ------------------------------------------------

test('only a Solana base58 mint is sent to RugCheck', () => {
  assert.equal(isSolanaMint('DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263'), true);
  assert.equal(isSolanaMint('0x6982508145454ce325ddbe47a25d4ec3d2311933'), false);
  assert.equal(isSolanaMint(''), false);
  assert.equal(isSolanaMint(null), false);
});

// ---- burned vs locked ---------------------------------------------------

test('a destroyed LP mint is reported as BURNED, not as zero-locked', () => {
  const lp = lpFromMarkets([{ lp: { lpMint: SYSTEM, lpTotalSupply: 1000, lpLockedPct: 0 } }]);
  assert.equal(lp.burnedPct, 100, 'the whole LP supply was destroyed');
  assert.equal(lp.state, 'burned-or-locked');
});

test('a locked LP is reported as locked, and the two are not conflated', () => {
  const lp = lpFromMarkets([{ lp: { lpMint: 'LPx', lpTotalSupply: 1000, lpLockedPct: 95 } }]);
  assert.equal(lp.lockedPct, 95);
  assert.equal(lp.burnedPct, 0, 'a lock is not a burn');
  // 95% secured is strong but not complete, so the state must not overclaim.
  assert.equal(lp.state, 'partially-secured');

  const full = lpFromMarkets([{ lp: { lpMint: 'LPx', lpTotalSupply: 1000, lpLockedPct: 100 } }]);
  assert.equal(full.state, 'burned-or-locked');
});

test('no markets at all is null, never "unlocked"', () => {
  assert.equal(lpFromMarkets([]), null);
  assert.equal(lpFromMarkets(null), null);
});

test('the card says "Burned N%" rather than "0% locked" for burned liquidity', () => {
  const r = resolveQuickCheck('lpLock', {
    risk: { ...emptyRisk(), lpLock: { burnedPercentage: 99.99, lockedPercentage: 0 } },
    riskStatus: 'ok',
  });
  assert.equal(r.value, 'Burned 100%');
  assert.equal(r.tone, 'good');
});

// ---- unknown is not zero ------------------------------------------------

test('a null locked percentage renders a dash, never a fabricated 0%', () => {
  // Number(null) === 0, which previously produced a confident "0% / unlocked".
  const r = resolveQuickCheck('lpLock', {
    risk: { ...emptyRisk(), lpLock: { lockedPercentage: null } },
    riskStatus: 'ok',
  });
  assert.equal(r.value, '—');
  assert.notEqual(r.value, '0%');
});

test('a genuine zero still renders 0%', () => {
  const r = resolveQuickCheck('lpLock', {
    risk: { ...emptyRisk(), lpLock: { lockedPercentage: 0 } },
    riskStatus: 'ok',
  });
  assert.equal(r.value, '0%');
});

// ---- Solana tax vs Token-2022 transfer fee ------------------------------

test('a legacy SPL token has NO tax field, because there is no fee concept', () => {
  const n = normalizeRugCheck(report({ tokenProgram: TOKEN_PROG, transferFee: { pct: 0 } }));
  assert.equal(n.standard, 'spl-token');
  assert.equal(n.tax, null, 'zero fee on a legacy token does not mean 0% tax');
  const r = resolveQuickCheck('tax', { risk: { ...emptyRisk(), tax: n.tax }, riskStatus: 'ok' });
  assert.equal(r.value, '—');
});

test('a Token-2022 token IS labelled with a transfer fee, not a tax', () => {
  const n = normalizeRugCheck(report({ tokenProgram: T22_PROG, transferFee: { pct: 2.5, maxAmount: 100 } }));
  assert.equal(n.standard, 'token-2022');
  assert.equal(n.tax.kind, 'transfer-fee');
  assert.equal(n.tax.pct, 2.5);
  const r = resolveQuickCheck('tax', { risk: { ...emptyRisk(), tax: n.tax }, riskStatus: 'ok' });
  assert.equal(r.label, 'Transfer Fee');
  assert.match(r.value, /2\.50%/);
});

test('a Token-2022 token with a zero fee states 0%, which is a real measurement', () => {
  const n = normalizeRugCheck(report({ tokenProgram: T22_PROG, transferFee: { pct: 0 } }));
  const r = resolveQuickCheck('tax', { risk: { ...emptyRisk(), tax: n.tax }, riskStatus: 'ok' });
  assert.equal(r.label, 'Transfer Fee');
  assert.equal(r.value, '0%', 'a measured zero fee is not the same as no fee concept');
});

// ---- creator holding ----------------------------------------------------

test('creatorBalance is converted from raw units before becoming a percentage', () => {
  // 10,000 raw with 6 decimals and 1,000,000 supply = 1%
  const n = normalizeRugCheck(report({ creatorBalance: 10_000, token: { supply: 1_000_000, decimals: 6 } }));
  assert.equal(n.dev.balancePercentage, 1);
});

test('an impossible creator percentage is rejected rather than displayed', () => {
  const n = normalizeRugCheck(report({ creatorBalance: 5_000_000, token: { supply: 1_000_000, decimals: 6 } }));
  assert.equal(n.dev.balancePercentage, null, 'a >100% holding cannot be real');
});

test('no creator address means no dev block, not a zero holding', () => {
  const n = normalizeRugCheck(report({ creator: null }));
  assert.equal(n.dev, null);
});

// ---- holder concentration ----------------------------------------------

test('duplicate and system holders do not inflate concentration', () => {
  const h = holdersFromTop([
    { address: 'A', pct: 10 },
    { address: 'A', pct: 10 },
    { address: SYSTEM, pct: 40 },
    { address: 'B', pct: 5 },
  ]);
  assert.equal(h.top10Percentage, 15, 'the duplicate and the system account are excluded');
});

test('an over-100 concentration is refused rather than clamped', () => {
  const h = holdersFromTop([
    { address: 'A', pct: 80 },
    { address: 'B', pct: 70 },
  ]);
  assert.equal(h.top10Percentage, null);
});

// ---- field-level merge --------------------------------------------------

test('the merge fills only nulls, so measured values survive', () => {
  const primary = {
    holders: { total: 1000, top10Percentage: 20, largestHolderPercentage: 5 },
    security: { honeypot: false, mintable: true, freezable: null },
    tax: null, lpLock: null, dev: null,
  };
  const fallback = {
    source: 'rugcheck',
    holders: { total: 9999, top10Percentage: 77, largestHolderPercentage: 40 },
    security: { mintable: false, freezable: false, rugged: false },
    tax: null,
    lpLock: { lockedPercentage: 90 },
    dev: { address: 'C', balancePercentage: 0 },
  };
  const m = mergeRisk(primary, fallback);

  assert.equal(m.holders.total, 1000, 'the primary total is kept, not overwritten');
  assert.equal(m.holders.top10Percentage, 20);
  assert.equal(m.security.mintable, true, 'a measured true is not replaced');
  assert.equal(m.security.freezable, false, 'but a null IS filled');
  assert.equal(m.lpLock.lockedPercentage, 90, 'the missing block is supplied');
  assert.equal(m.dev.address, 'C');
  assert.equal(m.sources.lpLock, 'rugcheck', 'provenance is recorded');
});

test('a fallback-only result still has the full shape so callers cannot throw', () => {
  const m = mergeRisk(null, {
    source: 'rugcheck',
    holders: { top10Percentage: 30 },
    security: { mintable: false },
    lpLock: null, dev: null, tax: null,
  });
  assert.ok(m.holders);
  assert.ok(m.security);
  assert.equal(m.holders.top10Percentage, 30);
});
