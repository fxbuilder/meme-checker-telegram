/**
 * Position-based LP intelligence for V3 and V4.
 *
 * The defects these tests guard are specific and were each observed:
 *
 *   1. "V3/V4" is not an answer. Identifying a pool type and stopping there leaves the reader
 *      unable to tell whether liquidity can be pulled.
 *   2. A revert is not proof of a contract's shape. Probing upgradeTo() and reading the revert
 *      made an immutable locker look upgradeable.
 *   3. A position's liquidity is NOT a share of the pool. Dividing it and calling the result a
 *      "locked percentage" produces a number that is comparable to nothing.
 *   4. V3 and V4 store liquidity in different places, so one ABI cannot serve both.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { selectorOf } from '../src/security/keccak.mjs';
import {
  detectPositionKind, assessV3Position, assessV4PositionLp, probeWithdrawability,
  classifyPosition, POSITION_MANAGERS, KNOWN_LOCKERS,
} from '../src/security/positions.mjs';

const word = (n) => BigInt(n).toString(16).padStart(64, '0');
const addrWord = (a) => a.toLowerCase().replace(/^0x/, '').padStart(64, '0');

/** Stub by call-data prefix; unknown selectors revert (which is itself meaningful). */
function stub(routes) {
  return async (url, opts) => {
    const body = JSON.parse(opts.body);
    if (body.method === 'eth_getStorageAt') {
      return { ok: true, status: 200, json: async () => ({ jsonrpc: '2.0', id: 1, result: routes.__storage ?? ('0x' + '0'.repeat(64)) }) };
    }
    const data = body.params?.[0]?.data ?? '';
    for (const [prefix, result] of Object.entries(routes)) {
      if (prefix === '__storage') continue;
      if (data.startsWith(prefix)) {
        if (result === 'revert') {
          return { ok: true, status: 200, json: async () => ({ jsonrpc: '2.0', id: 1, error: { message: 'execution reverted' } }) };
        }
        return { ok: true, status: 200, json: async () => ({ jsonrpc: '2.0', id: 1, result }) };
      }
    }
    return { ok: true, status: 200, json: async () => ({ jsonrpc: '2.0', id: 1, error: { message: 'execution reverted' } }) };
  };
}

// ---------------------------------------------------------------------------
// V3: liquidity lives on the position
// ---------------------------------------------------------------------------

const V3_POS = '0x' + [word(0), word(1), addrWord('0x1f9840a85d5af5bf1d1762f925bdaddc4201f984'),
  addrWord('0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2'), word(3000), word(0), word(0),
  word(383995753785830744n), word(0), word(0), word(0), word(0)].join('');

test('a V3 position reports its OWN liquidity, not a pool share', async () => {
  const f = stub({
    [selectorOf('ownerOf(uint256)')]: '0x' + addrWord('0x50ec05ade8280758e2077fcbc08d878d4aef79c3'),
    [selectorOf('positions(uint256)')]: V3_POS,
  });
  const a = await assessV3Position('rpc', '0xpm', 1, { fetchImpl: f, chain: 'ethereum' });
  assert.equal(a.status, 'ok');
  assert.equal(a.version, 'v3');
  assert.equal(a.fee, 3000);
  assert.equal(a.liquidity, '383995753785830744');
  assert.equal(a.hasActiveLiquidity, true);
  assert.equal(a.scope, 'position', 'reported as a position fact, never as a pool percentage');
  assert.equal(a.isKnownLocker, false);
});

test('a V3 position with zero liquidity but fees owed is not "active"', async () => {
  // Closed positions keep claimable fees; reporting those as active liquidity overstates.
  const posWithFees = '0x' + [word(0), word(1), addrWord('0x1f9840a85d5af5bf1d1762f925bdaddc4201f984'),
    addrWord('0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2'), word(3000), word(0), word(0),
    word(0), word(0), word(0), word(500), word(700)].join('');
  const f = stub({
    [selectorOf('ownerOf(uint256)')]: '0x' + addrWord('0x50ec05ade8280758e2077fcbc08d878d4aef79c3'),
    [selectorOf('positions(uint256)')]: posWithFees,
  });
  const a = await assessV3Position('rpc', '0xpm', 1, { fetchImpl: f, chain: 'ethereum' });
  assert.equal(a.hasActiveLiquidity, false);
  assert.equal(a.tokensOwed.token0, '500', 'fees are still reported');
  const cls = classifyPosition(a);
  assert.equal(cls.state, 'staked-or-inactive');
});

// ---------------------------------------------------------------------------
// V4: liquidity lives in the PoolManager
// ---------------------------------------------------------------------------

const POOL_KEY = '0x' + addrWord('0x0000000000000000000000000000000000000000')
  + addrWord('0x0ddcab9ae04bda0c87ecc1640636fa11e8e613e8') + word(0) + word(200)
  + addrWord('0xe5e702641ea86f4ae6cc3cdaed2b886f976be044');

test('a V4 position reports POOL liquidity and admits it has no position liquidity', async () => {
  // The single most important honesty point here: V4 positions do not store liquidity, so
  // filling positionLiquidity from the pool would be a fabricated per-position figure.
  const f = stub({
    [selectorOf('ownerOf(uint256)')]: '0x' + addrWord('0x267444D099b10fB5Ed7c3Cc7B7c767AdcA574952'),
    [selectorOf('getPoolAndPositionInfo(uint256)')]: POOL_KEY + word(0),
    [selectorOf('getLiquidity(bytes32)')]: '0x' + word(29277002188455997195507n),
  });
  const a = await assessV4PositionLp('rpc', '0xpm', 4231454, { fetchImpl: f, chain: 'robinhood', stateView: '0xsv' });
  assert.equal(a.status, 'ok');
  assert.equal(a.version, 'v4');
  assert.equal(a.positionLiquidity, null, 'V4 stores none - null, not a copy of the pool figure');
  assert.equal(a.poolLiquidity, '29277002188455997195507');
  assert.equal(a.scope, 'pool');
  assert.equal(a.isKnownLocker, true);
  assert.equal(a.lockerName, 'Pons launch locker');
});

test('V3 and V4 are distinguished by which ABI answers, not by configuration', async () => {
  const v3 = await detectPositionKind('rpc', '0xpm', 1, {
    fetchImpl: stub({ [selectorOf('positions(uint256)')]: V3_POS }),
  });
  assert.equal(v3.kind, 'v3');

  const v4 = await detectPositionKind('rpc', '0xpm', 1, {
    fetchImpl: stub({
      [selectorOf('positions(uint256)')]: 'revert',
      [selectorOf('getPoolAndPositionInfo(uint256)')]: POOL_KEY + word(0),
    }),
  });
  assert.equal(v4.kind, 'v4', 'a V3 revert is what proves the V4 ABI applies');
});

test('a transport failure during detection is unknown, not a version guess', async () => {
  const f = async () => ({ ok: false, status: 503, json: async () => ({}) });
  const r = await detectPositionKind('rpc', '0xpm', 1, { fetchImpl: f });
  assert.equal(r.kind, 'unknown');
});

// ---------------------------------------------------------------------------
// Withdrawal and upgradeability
// ---------------------------------------------------------------------------

test('EIP-1967 storage decides upgradeability - a revert tells you nothing', async () => {
  // The real bug this replaced: probing upgradeTo() and reading the revert as "upgradeable"
  // made the immutable Pons locker look upgradeable, which blocked its legitimate
  // "permanently locked" classification.
  const immutable = await probeWithdrawability('rpc', '0xlocker', {
    fetchImpl: stub({ __storage: '0x' + '0'.repeat(64) }),
  });
  assert.equal(immutable.looksUpgradeable, false);
  assert.equal(immutable.upgradeabilityKnown, true);

  const proxy = await probeWithdrawability('rpc', '0xproxy', {
    fetchImpl: stub({ __storage: '0x' + '0'.repeat(24) + '02081d3dec43f816b145672cfc65029948d396ae' }),
  });
  assert.equal(proxy.looksUpgradeable, true);
  assert.equal(proxy.implementation, '0x02081d3dec43f816b145672cfc65029948d396ae');
});

test('a locker with no standard withdrawal and no proxy is permanently locked', async () => {
  const f = stub({
    [selectorOf('ownerOf(uint256)')]: '0x' + addrWord('0x267444D099b10fB5Ed7c3Cc7B7c767AdcA574952'),
    [selectorOf('getPoolAndPositionInfo(uint256)')]: POOL_KEY + word(0),
    [selectorOf('getLiquidity(bytes32)')]: '0x' + word(1),
    __storage: '0x' + '0'.repeat(64),
  });
  const a = await assessV4PositionLp('rpc', '0xpm', 1, { fetchImpl: f, chain: 'robinhood', stateView: '0xsv' });
  const wd = await probeWithdrawability('rpc', '0x267444D099b10fB5Ed7c3Cc7B7c767AdcA574952', { fetchImpl: f });
  const cls = classifyPosition(a, wd);
  assert.equal(cls.state, 'permanently-locked');
  assert.equal(cls.scope, 'position', 'one position, never extrapolated to the whole pool');
});

test('a locker whose owner is UPGRADEABLE is only "locked", not "permanently"', async () => {
  const f = stub({
    [selectorOf('ownerOf(uint256)')]: '0x' + addrWord('0x267444D099b10fB5Ed7c3Cc7B7c767AdcA574952'),
    [selectorOf('getPoolAndPositionInfo(uint256)')]: POOL_KEY + word(0),
    [selectorOf('getLiquidity(bytes32)')]: '0x' + word(1),
    __storage: '0x' + '0'.repeat(24) + '1111111111111111111111111111111111111111',
  });
  const a = await assessV4PositionLp('rpc', '0xpm', 1, { fetchImpl: f, chain: 'robinhood', stateView: '0xsv' });
  const wd = await probeWithdrawability('rpc', '0x267444D099b10fB5Ed7c3Cc7B7c767AdcA574952', { fetchImpl: f });
  assert.equal(classifyPosition(a, wd).state, 'locked', 'a proxy can be replaced, so "permanent" is not earned');
});

test('an unknown owner with active liquidity is withdrawable, not locked', async () => {
  const f = stub({
    [selectorOf('ownerOf(uint256)')]: '0x' + addrWord('0x2222222222222222222222222222222222222222'),
    [selectorOf('positions(uint256)')]: V3_POS,
  });
  const a = await assessV3Position('rpc', '0xpm', 1, { fetchImpl: f, chain: 'ethereum' });
  const cls = classifyPosition(a);
  assert.equal(cls.state, 'withdrawable');
  assert.equal(cls.lockerName, undefined);
});

test('a failed assessment classifies as unknown, never as safe', () => {
  const cls = classifyPosition({ status: 'error', detail: 'transport' });
  assert.equal(cls.state, 'unknown');
  assert.notEqual(cls.state, 'withdrawable');
  assert.notEqual(cls.state, 'permanently-locked');
});

// ---------------------------------------------------------------------------
// Configuration hygiene
// ---------------------------------------------------------------------------

test('lockers are listed per chain, never shared across chains', () => {
  // The same address on another chain is a different contract - Team.Finance proved this with
  // different bytecode on ETH and BSC. A flat global list would misattribute a lock.
  const eth = KNOWN_LOCKERS.ethereum.map((l) => l.address.toLowerCase());
  const bsc = KNOWN_LOCKERS.bsc.map((l) => l.address.toLowerCase());
  const rh = KNOWN_LOCKERS.robinhood.map((l) => l.address.toLowerCase());
  for (const a of eth) assert.ok(!bsc.includes(a) || a === '0x407993575c91ce7643a4d4ccacc9a98c36ee1bbe',
    'PinkLock is the one address genuinely deployed on both');
  assert.ok(rh.includes('0x267444d099b10fb5ed7c3cc7b7c767adca574952'), 'the Pons locker is on Robinhood only');
});

test('every configured manager has an address and a version slot', () => {
  for (const [chain, cfg] of Object.entries(POSITION_MANAGERS)) {
    assert.ok(cfg.v3 || cfg.v4, `${chain} must configure a manager`);
    for (const m of cfg.v3 ?? []) assert.match(m.address, /^0x[0-9a-fA-F]{40}$/);
    for (const m of cfg.v4 ?? []) assert.match(m.address, /^0x[0-9a-fA-F]{40}$/);
  }
});
