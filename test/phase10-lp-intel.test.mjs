/**
 * test/phase10-lp-intel.test.mjs
 *
 * LP intelligence: burned / locked / partial / unlocked / bonding-curve / unknown, with
 * V2 maths never applied to a V3/V4 position.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { readV2Liquidity, mergeLpIntel, BURN_ADDRESSES } from '../src/security/lp-intel.mjs';
import { classifyLiquidity } from '../src/risk-classify.mjs';

const PAIR = '0xA39Af17CE4a8eb807E076805Da1e2B8EA7D0755b';
const RPC = 'https://bsc-dataseed.binance.org';

/** Stub JSON-RPC: map a call `data` prefix to a hex result. */
function rpcStub(byData) {
  return async (url, opts) => {
    const { data } = JSON.parse(opts.body).params[0];
    for (const [prefix, result] of Object.entries(byData)) {
      if (data.startsWith(prefix)) {
        return { ok: true, status: 200, json: async () => ({ jsonrpc: '2.0', id: 1, result }) };
      }
    }
    return { ok: true, status: 200, json: async () => ({ jsonrpc: '2.0', id: 1, error: { message: 'revert' } }) };
  };
}

/** Stub whose calls never get an answer - a timeout or a 5xx. */
function transportFail() {
  return async () => ({ ok: false, status: 503, json: async () => ({}) });
}

const word = (n) => '0x' + BigInt(n).toString(16).padStart(64, '0');
/** balanceOf selector + padded address. */
const bal = (addr) => `0x70a08231${addr.replace(/^0x/, '').toLowerCase().padStart(64, '0')}`;

test('LP held at the burn address is BURNED', async () => {
  const f = rpcStub({
    '0x18160ddd': word(1000),
    [bal(BURN_ADDRESSES[1])]: word(1000),
    [bal(BURN_ADDRESSES[0])]: word(0),
  });
  const r = await readV2Liquidity({ chain: 'bsc', pairAddress: PAIR, rpc: RPC, fetchImpl: f });
  assert.equal(r.state, 'burned');
  assert.equal(r.burnedPercentage, 100);
  // The scope and pool address must be recorded so a displayed result is auditable.
  assert.equal(r.poolAddress, PAIR);
  assert.match(r.scope, /^v2:/);
});

test('a partial burn is PARTIALLY-LOCKED with the real share, not rounded to burned', async () => {
  const f = rpcStub({
    '0x18160ddd': word(1000),
    [bal(BURN_ADDRESSES[1])]: word(400),
    [bal(BURN_ADDRESSES[0])]: word(0),
  });
  const r = await readV2Liquidity({ chain: 'bsc', pairAddress: PAIR, rpc: RPC, fetchImpl: f });
  assert.equal(r.state, 'partially-locked');
  assert.equal(r.burnedPercentage, 40);
});

test('LP held by an UNRECOGNISED address is never reported as locked', async () => {
  // The critical distinction: "someone else holds the LP" is not "the LP is locked".
  // Treating any holding contract as a locker is a false assurance.
  const f = rpcStub({
    '0x18160ddd': word(1000),
    [bal(BURN_ADDRESSES[1])]: word(0),
    [bal(BURN_ADDRESSES[0])]: word(0),
  });
  const r = await readV2Liquidity({ chain: 'bsc', pairAddress: PAIR, rpc: RPC, fetchImpl: f });
  assert.equal(r.state, 'unknown');
  assert.notEqual(r.state, 'locked');
  assert.notEqual(r.state, 'burned');
});

test('a V3 position is refused, not approximated with V2 maths', async () => {
  const f = rpcStub({ '0x18160ddd': word(1000) });
  const r = await readV2Liquidity({ chain: 'bsc', pairAddress: PAIR, rpc: RPC, labels: ['v3'], fetchImpl: f });
  assert.equal(r.state, 'unsupported-position-type');
  assert.equal(r.burnedPercentage, null, 'no fabricated percentage for a V3 pool');
  assert.match(r.detail, /V2/);
});

test('a totalSupply REVERT proves a position-based pool, label or no label', async () => {
  // A V2 pair always implements totalSupply() because the LP token IS the pair. So a
  // revert is positive evidence that this is a V3/V4 position or a curve.
  //
  // The label used to be the only thing that could tell these apart, which left Elysium
  // (whose pairs DexScreener does not label) reporting a bare dash while Base's
  // 'v4'-labelled tokens said "V2 maths does not apply" - the same situation answered two
  // different ways depending on whether a label happened to be present.
  const f = rpcStub({});
  const unlabelled = await readV2Liquidity({ chain: 'bsc', pairAddress: PAIR, rpc: RPC, fetchImpl: f });
  assert.equal(unlabelled.state, 'unsupported-position-type');
  const labelled = await readV2Liquidity({ chain: 'bsc', pairAddress: PAIR, rpc: RPC, labels: ['v3'], fetchImpl: f });
  assert.equal(labelled.state, 'unsupported-position-type');
});

test('a chain with no RPC reports unknown rather than guessing', async () => {
  const r = await readV2Liquidity({ chain: 'monad', pairAddress: PAIR, rpc: null, fetchImpl: async () => { throw new Error('x'); } });
  assert.equal(r.state, 'unknown');
  assert.equal(r.burnedPercentage, null);
});

test('an UNREACHABLE rpc is unknown, never a claim about the pool', async () => {
  // A timeout or 5xx must not be read as "this is a position-based pool" - that would turn
  // a network hiccup into a confident statement about pool architecture, which is the same
  // false-assurance trap as reporting burned liquidity from a dust balance.
  const r = await readV2Liquidity({ chain: 'bsc', pairAddress: PAIR, rpc: RPC, fetchImpl: transportFail() });
  assert.equal(r.state, 'unknown');
  assert.notEqual(r.state, 'unsupported-position-type', 'a hiccup is not a pool-type finding');
  assert.notEqual(r.burnedPercentage, 0, 'an unread supply is not an absence of liquidity');
});

// ---- merge ---------------------------------------------------------------

test('an on-chain burn overrides a provider block', () => {
  const merged = mergeLpIntel({ lockedPercentage: 5, burnedPercentage: 0 }, {
    state: 'burned', burnedPercentage: 100, scope: 'v2:0xabc', poolAddress: '0xabc',
  });
  assert.equal(merged.kind, 'burned');
  assert.equal(merged.burnedPercentage, 100);
  assert.equal(merged.source, 'onchain-v2');
  assert.equal(merged.scope, 'v2:0xabc', 'the scope used is recorded');
});

test('an inconclusive on-chain read never erases a provider measurement', () => {
  const merged = mergeLpIntel({ lockedPercentage: 92 }, { state: 'unknown' });
  assert.equal(merged.lockedPercentage, 92, 'a real provider figure survives');
  assert.equal(merged.onchainAttempted, true, 'and the attempt is recorded');
});

test('nothing from either source stays null, not a fabricated zero', () => {
  assert.equal(mergeLpIntel(null, { state: 'unknown' }), null);
  assert.equal(mergeLpIntel(null, null), null);
});

// ---- classification ------------------------------------------------------

test('the on-chain burned state classifies as a permanent guarantee', () => {
  const c = classifyLiquidity(mergeLpIntel(null, { state: 'burned', burnedPercentage: 100 }));
  assert.equal(c.kind, 'burned');
  assert.equal(c.severity, 'none');
});

test('a V3 position is not classified as unlocked, and not as unchecked either', () => {
  // Two separate mistakes to avoid. It must never read "unlocked" (a pool we cannot assess
  // is not an unsecured pool), and it must not read as an unexamined field either - the
  // pool TYPE was determined, it simply has no fungible LP supply to measure.
  const c = classifyLiquidity({ positionType: 'v3-v4' });
  assert.notEqual(c.kind, 'unlocked');
  assert.equal(c.kind, 'position-pool');
  assert.equal(c.state, 'verified', 'the pool type IS determined');
  assert.equal(c.severity, 'unknown', 'but it must never display a green reassurance');
  assert.equal(c.value, null, 'there is no percentage to show');
});
