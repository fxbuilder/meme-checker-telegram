/**
 * test/phase10-bonding-and-lockers.test.mjs
 *
 * Two false-assurance bugs found by the LP research, both verified live before fixing:
 *
 *   1. A pre-graduation pump.fun token carries the SAME `lpMint` sentinel as a destroyed
 *      LP mint, so the scanner reported "LP burned 100%" for a token still on its bonding
 *      curve - liquidity that does not exist as a pool at all.
 *
 *   2. A verified locker holding a DUST balance made the pool report state 'locked' with
 *      lockedPercentage 0.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { normalizeRugCheck } from '../src/security/rugcheck.mjs';
import { readV2Liquidity, VERIFIED_LOCKERS, BURN_ADDRESSES } from '../src/security/lp-intel.mjs';
import { classifyLiquidity } from '../src/risk-classify.mjs';

const SYS = '11111111111111111111111111111111';
const TOKEN_PROG = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
const PAIR = '0xA39Af17CE4a8eb807E076805Da1e2B8EA7D0755b';
const RPC = 'https://bsc-dataseed.binance.org';

const word = (n) => '0x' + BigInt(n).toString(16).padStart(64, '0');
const bal = (addr) => `0x70a08231${addr.replace(/^0x/, '').toLowerCase().padStart(64, '0')}`;

function rpcStub(byData) {
  return async (_url, opts) => {
    const { data } = JSON.parse(opts.body).params[0];
    for (const [prefix, result] of Object.entries(byData)) {
      if (data.startsWith(prefix)) {
        return { ok: true, status: 200, json: async () => ({ jsonrpc: '2.0', id: 1, result }) };
      }
    }
    return { ok: true, status: 200, json: async () => ({ jsonrpc: '2.0', id: 1, error: { message: 'revert' } }) };
  };
}

// ---- bonding curve is not burned liquidity ------------------------------

test('a pre-graduation pump.fun token is BONDING CURVE, not burned LP', () => {
  // Shape verified live against BoSrCHeCk…pump: launchpad pump_fun, marketType pump_fun,
  // mintLP == system program, lpLockedPct 100.
  const report = {
    tokenProgram: TOKEN_PROG,
    token: { supply: 1_000_000_000, decimals: 6 },
    totalHolders: 100,
    topHolders: [],
    markets: [{
      marketType: 'pump_fun',
      mintLP: SYS,
      lp: { lpMint: SYS, lpLockedPct: 100, lpLocked: 8_570_797, lpUnlocked: 0, lpTotalSupply: 8_570_797 },
    }],
  };
  const n = normalizeRugCheck(report);
  assert.equal(n.lpLock.state, 'bonding-curve');
  // The normalised field is burnedPercentage (the internal builder uses burnedPct).
  assert.equal(n.lpLock.burnedPercentage, null, 'a bonding curve is not a burn');
  assert.notEqual(n.lpLock.burnedPercentage, 100, 'this was the false "burned 100%"');

  // And the shared classifier must not call it burned either.
  const c = classifyLiquidity(n.lpLock);
  assert.equal(c.kind, 'bonding-curve');
  assert.notEqual(c.kind, 'burned');
});

test('a real destroyed LP mint is still reported as burned', () => {
  // Contrast case: a genuine DEX market with the destroyed-mint sentinel.
  const report = {
    tokenProgram: TOKEN_PROG,
    token: { supply: 1_000_000_000, decimals: 6 },
    totalHolders: 100,
    topHolders: [],
    markets: [{
      marketType: 'raydium',
      mintLP: SYS,
      lp: { lpMint: SYS, lpTotalSupply: 500_000, lpLockedPct: 0 },
    }],
  };
  const n = normalizeRugCheck(report);
  assert.equal(n.lpLock.state, 'burned-or-locked');
  assert.ok(n.lpLock.burnedPercentage >= 99, 'a real burn still reads as burned');
});

test('a graduated pool with a normal LP mint is not treated as a curve', () => {
  const report = {
    tokenProgram: TOKEN_PROG,
    token: { supply: 1_000_000_000, decimals: 6 },
    totalHolders: 100,
    topHolders: [],
    markets: [{
      marketType: 'orca',
      mintLP: 'NormalLPmint111111111111111111111111111111',
      lp: { lpMint: 'NormalLPmint111111111111111111111111111111', lpTotalSupply: 1000, lpLockedPct: 95 },
    }],
  };
  const n = normalizeRugCheck(report);
  assert.notEqual(n.lpLock.state, 'bonding-curve');
  assert.ok(n.lpLock.lockedPercentage >= 90);
});

// ---- locker dust is not a lock ------------------------------------------

test('a locker holding a dust balance does NOT report the pool as locked', () => {
  // Verified live: PinkLock held a negligible fraction and the pool still reported
  // 'locked' with lockedPercentage 0.
  const locker = VERIFIED_LOCKERS.bsc[0].address;
  const f = rpcStub({
    '0x18160ddd': word(1_000_000),
    [bal(BURN_ADDRESSES[1])]: word(0),
    [bal(BURN_ADDRESSES[0])]: word(0),
    [bal(locker)]: word(10), // 0.001%
  });
  return readV2Liquidity({ chain: 'bsc', pairAddress: PAIR, rpc: RPC, fetchImpl: f }).then((r) => {
    assert.notEqual(r.state, 'locked', 'dust is not a lock');
    assert.equal(r.state, 'unknown');
  });
});

test('a locker holding a real share DOES report locked, with the real percentage', () => {
  const locker = VERIFIED_LOCKERS.bsc[0].address;
  const f = rpcStub({
    '0x18160ddd': word(1_000_000),
    [bal(BURN_ADDRESSES[1])]: word(0),
    [bal(BURN_ADDRESSES[0])]: word(0),
    [bal(locker)]: word(800_000), // 80%
  });
  return readV2Liquidity({ chain: 'bsc', pairAddress: PAIR, rpc: RPC, fetchImpl: f }).then((r) => {
    assert.equal(r.state, 'locked');
    assert.equal(r.lockedPercentage, 80);
    assert.equal(r.lockerName, VERIFIED_LOCKERS.bsc[0].name);
  });
});

// ---- the allowlist itself ------------------------------------------------

test('every listed locker is a real address on its own chain, not a shared assumption', () => {
  // Team.Finance uses different bytecode on ETH and BSC at the same address, so the chain
  // is part of the key. Any entry must at least be a well-formed address.
  for (const [chain, lockers] of Object.entries(VERIFIED_LOCKERS)) {
    for (const l of lockers) {
      assert.match(l.address, /^0x[0-9a-fA-F]{40}$/, `${chain} locker address malformed`);
      assert.ok(l.name && l.name.length, `${chain} locker needs a name for attribution`);
    }
  }
});

test('chains with no verified locker report unknown rather than unlocked', async () => {
  const f = rpcStub({
    '0x18160ddd': word(1_000_000),
    [bal(BURN_ADDRESSES[1])]: word(0),
    [bal(BURN_ADDRESSES[0])]: word(0),
  });
  const r = await readV2Liquidity({ chain: 'hyperevm', pairAddress: PAIR, rpc: RPC, fetchImpl: f });
  assert.equal(r.state, 'unknown');
  assert.notEqual(r.state, 'unlocked');
});
