/**
 * Pons launchpad intelligence (Robinhood Chain 4663).
 *
 * Milestone A. The load-bearing claims here were each verified against live chain state
 * before being encoded:
 *
 *   - launchFactory() on the token is the authoritative generation discriminator
 *   - PoolGraduated gives the positionId; ownerOf() proves the locker holds it
 *   - getPoolAndPositionInfo gives the PoolKey, and keccak(PoolKey) gives a poolId that
 *     StateView answers for
 *   - locked TOKEN SUPPLY (4/49 = 8.16%) is a different fact from locked LIQUIDITY
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { selectorOf, topicOf, keccak256 } from '../src/security/keccak.mjs';
import {
  PONS, PONS_LOCKERS, EVENTS, resolveLaunch, findGraduationPosition,
  assessV4Position, readLockedSupply, ethCall,
} from '../src/security/pons.mjs';

const TEXEL = '0x0ddcab9ae04bda0c87ecc1640636fa11e8e613e8';
const PONS_TOKEN = '0x39dbed3a2bd333467115de45665cc57f813c4571';
const RPC = 'https://rpc.mainnet.chain.robinhood.com';

const word = (n) => BigInt(n).toString(16).padStart(64, '0');
const addrWord = (a) => a.toLowerCase().replace(/^0x/, '').padStart(64, '0');

// ---------------------------------------------------------------------------
// Keccak is the foundation of every selector and topic here, so it is pinned.
// ---------------------------------------------------------------------------

test('keccak256 matches known vectors including multi-block input', () => {
  assert.equal(keccak256('').toString('hex'),
    'c5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470');
  assert.equal(keccak256('abc').toString('hex'),
    '4e03657aea45a94fc7d47ba826c8d667c0d1e6e33a64a036ec44f58fa12d6c45');
  // 160 bytes is more than one 136-byte rate block, so this exercises the absorb loop.
  const a = Buffer.alloc(160, 0x11);
  const b = Buffer.alloc(160, 0x11);
  b[159] ^= 1;
  assert.notEqual(keccak256(a).toString('hex'), keccak256(b).toString('hex'),
    'a one-bit change must avalanche');
});

test('selectors and event topics match values proven against live contracts', () => {
  assert.equal(selectorOf('transfer(address,uint256)'), '0xa9059cbb');
  assert.equal(selectorOf('totalSupply()'), '0x18160ddd');
  assert.equal(selectorOf('balanceOf(address)'), '0x70a08231');
  assert.equal(selectorOf('getTokenInfo()'), '0xabb1dc44');
  assert.equal(selectorOf('ownerOf(uint256)'), '0x6352211e');
  // Published in Pons/Bitquery documentation; reproduced exactly by our implementation.
  assert.equal(topicOf('PoolGraduated(address,uint256,uint256,uint256)'),
    '0x0a44ef75df69c534f43cd6c1aa3ef8983065fe5fe79ef9e79f6494e6f258c259');
  assert.equal(topicOf('TokenDeployed(address,address,address,address,uint256,uint256)'),
    '0x1461370115e1c2be79cb529f8cfcbd11316e789d9c6099fc83417b0b4c48c62a');
});

test('V1 and V2 events have DIFFERENT topic0 values', () => {
  // The two generations are different protocols, not versions of one. Sharing a signature
  // table between them would silently mis-decode one of them.
  const v1 = topicOf(EVENTS.v1TokenLaunched);
  const v2 = topicOf(EVENTS.poolGraduated);
  assert.notEqual(v1, v2);
});

// ---------------------------------------------------------------------------
// Generation resolution
// ---------------------------------------------------------------------------

/** Stub a JSON-RPC endpoint by matching the call data prefix. */
function stub(routes) {
  return async (url, opts) => {
    const body = JSON.parse(opts.body);
    if (body.method === 'eth_blockNumber') {
      return { ok: true, status: 200, json: async () => ({ jsonrpc: '2.0', id: 1, result: '0x1000' }) };
    }
    if (body.method === 'eth_getLogs') {
      const r = routes.logs;
      if (r === 'error') {
        return { ok: true, status: 200, json: async () => ({ jsonrpc: '2.0', id: 1, error: { message: 'query spans too many blocks' } }) };
      }
      return { ok: true, status: 200, json: async () => ({ jsonrpc: '2.0', id: 1, result: r ?? [] }) };
    }
    const data = body.params?.[0]?.data ?? '';
    for (const [prefix, result] of Object.entries(routes)) {
      if (prefix === 'logs') continue;
      if (data.startsWith(prefix)) {
        if (result === 'revert') {
          return { ok: true, status: 200, json: async () => ({ jsonrpc: '2.0', id: 1, error: { message: 'execution reverted' } }) };
        }
        return { ok: true, status: 200, json: async () => ({ jsonrpc: '2.0', id: 1, result }) };
      }
    }
    return { ok: true, status: 200, json: async () => ({ jsonrpc: '2.0', id: 1, result: '0x' }) };
  };
}

test('launchFactory() identifies the V2 generation and reads phase 2', async () => {
  const rec = '0x' + addrWord(TEXEL) + word(1) + word(2) + word(3) + word(4)
    + word(4200000000000000000n) + word(0) + word(200) + word(185) + word(0) + word(2)
    + word(0) + word(0) + word(0) + word(1);
  const f = stub({
    [selectorOf('launchFactory()')]: '0x' + addrWord(PONS.v2.factory),
    [selectorOf('getLaunchedToken(address)')]: rec,
  });
  const L = await resolveLaunch(RPC, TEXEL, { fetchImpl: f });
  assert.equal(L.status, 'ok');
  assert.equal(L.generation, 'v2');
  assert.equal(L.phase, 2);
  assert.equal(L.graduated, true, 'phase 2 = a pool exists = graduated');
});

test('PONS is identified as V1-LEGACY, not as a non-Pons token', async () => {
  // This was a real bug: an over-wide getLogs failed with a range error, the error was read
  // as "no matching logs", and PONS came back not-pons even though its own docs say the
  // legacy factory launched it. launchFactory() answers in one call and cannot be confused.
  const f = stub({ [selectorOf('launchFactory()')]: '0x' + addrWord(PONS.v1.legacyFactory) });
  const L = await resolveLaunch(RPC, PONS_TOKEN, { fetchImpl: f });
  assert.equal(L.status, 'ok');
  assert.equal(L.generation, 'v1-legacy');
  assert.equal(L.curve, null, 'V1 has no bonding curve - each token gets a V3 pool at launch');
});

test('a token with no launchFactory() is not-pons, not an error', async () => {
  const f = stub({ [selectorOf('launchFactory()')]: '0x' });
  const L = await resolveLaunch(RPC, '0x6982508145454ce325ddbe47a25d4ec3d2311933', { fetchImpl: f });
  assert.equal(L.status, 'not-pons');
});

test('an unlisted factory is reported, never called "not Pons"', async () => {
  // A newer generation we do not know about is a COVERAGE GAP. Reporting it as
  // non-membership would be a false negative about a real Pons token.
  const f = stub({ [selectorOf('launchFactory()')]: '0x' + addrWord('0x1111111111111111111111111111111111111111') });
  const L = await resolveLaunch(RPC, PONS_TOKEN, { fetchImpl: f });
  assert.equal(L.status, 'unknown-generation');
  assert.equal(L.factory, '0x1111111111111111111111111111111111111111');
});

test('a transport failure is an error, not a claim about membership', async () => {
  const f = async () => ({ ok: false, status: 503, json: async () => ({}) });
  const L = await resolveLaunch(RPC, TEXEL, { fetchImpl: f });
  assert.equal(L.status, 'error', 'an outage says nothing about whether this is a Pons token');
});

test('a zero-filled launch record does not become a phase', async () => {
  // An unknown token yields a zero record rather than a revert, and phase 0 is legitimate,
  // so the token address must echo back in word 0 before anything is decoded.
  const f = stub({
    [selectorOf('launchFactory()')]: '0x' + addrWord(PONS.v2.factory),
    [selectorOf('getLaunchedToken(address)')]: '0x' + word(0).repeat(15),
  });
  const L = await resolveLaunch(RPC, TEXEL, { fetchImpl: f });
  assert.equal(L.phase, null, 'a non-echoing record is not phase 0');
  assert.equal(L.graduated, null);
});

// ---------------------------------------------------------------------------
// Position discovery
// ---------------------------------------------------------------------------

test('PoolGraduated decodes positionId, token and pair amounts', async () => {
  const log = {
    blockNumber: '0x' + (109366842).toString(16),
    transactionHash: '0xabc',
    topics: [topicOf(EVENTS.poolGraduated), '0x' + addrWord(TEXEL)],
    data: '0x' + word(4231454) + word(204081632653061000000000000n) + word(8090000262n),
  };
  const f = stub({ logs: [log] });
  const p = await findGraduationPosition(RPC, TEXEL, { fetchImpl: f });
  assert.equal(p.status, 'ok');
  assert.equal(p.positionId, '4231454');
  assert.equal(p.blockNumber, 109366842);
});

test('a range-limited log query is an OUTAGE, reported as incomplete not absent', async () => {
  // The bug that hid PONS: a provider error was read as "no logs", converting a limit of the
  // provider into a negative finding about the token.
  const f = stub({ logs: 'error' });
  const p = await findGraduationPosition(RPC, TEXEL, { fetchImpl: f, maxQueries: 3 });
  assert.notEqual(p.status, 'no-graduation', 'an error must never read as "never graduated"');
  assert.equal(p.status, 'incomplete');
  assert.ok(p.lastError, 'the provider error is retained for diagnosis');
});

test('the search is contiguous, so it cannot step over a graduation', async () => {
  // A strided search spent 110 queries and 32s failing to find a graduation that a
  // contiguous one returns in 3. Assert the windows actually abut.
  const ranges = [];
  const f = async (url, opts) => {
    const body = JSON.parse(opts.body);
    if (body.method === 'eth_blockNumber') {
      return { ok: true, status: 200, json: async () => ({ jsonrpc: '2.0', id: 1, result: '0x' + (50_000_000).toString(16) }) };
    }
    const [{ fromBlock, toBlock }] = body.params;
    ranges.push([Number(BigInt(fromBlock)), Number(BigInt(toBlock))]);
    return { ok: true, status: 200, json: async () => ({ jsonrpc: '2.0', id: 1, result: [] }) };
  };
  await findGraduationPosition(RPC, TEXEL, { fetchImpl: f, maxQueries: 3, windowBlocks: 5_000_000 });
  assert.equal(ranges.length, 3);
  for (let i = 1; i < ranges.length; i += 1) {
    assert.equal(ranges[i][1], ranges[i - 1][0], 'each window must END where the previous BEGAN');
  }
});

// ---------------------------------------------------------------------------
// Position assessment: locked liquidity
// ---------------------------------------------------------------------------

test('a W3 field index is not used - the PoolKey words ARE the encoded struct', async () => {
  // A delegated report claimed a struct index that read a zero word. The real answer is that
  // getPoolAndPositionInfo returns the PoolKey as its first five words, so hashing those
  // five words gives the poolId - which StateView then answers for. That answer is the proof.
  const key = '0x'
    + addrWord('0x0000000000000000000000000000000000000000')
    + addrWord(TEXEL)
    + word(0) + word(200)
    + addrWord(PONS.v2.hook);
  const expectedPoolId = '0x' + keccak256(Buffer.from(key.slice(2), 'hex')).toString('hex');

  const f = stub({
    [selectorOf('ownerOf(uint256)')]: '0x' + addrWord(PONS.v2.locker),
    [selectorOf('getPoolAndPositionInfo(uint256)')]: key + word(0),
    [selectorOf('getLiquidity(bytes32)')]: '0x' + word(29277002188455997195507n),
  });
  const a = await assessV4Position(RPC, 4231454, { fetchImpl: f });
  assert.equal(a.status, 'ok');
  assert.equal(a.owner, PONS.v2.locker.toLowerCase());
  assert.equal(a.isPonsLocker, true);
  assert.equal(a.hookIsPons, true, 'the hook must be Pons own, not assumed');
  assert.equal(a.pool.fee, 0, 'fee 0 - all fees are taken by the hook');
  assert.equal(a.pool.tickSpacing, 200);
  assert.equal(a.pool.poolId, expectedPoolId);
  assert.equal(a.poolLiquidity, '29277002188455997195507');
});

test('a position owned by a stranger is NOT reported as locked', async () => {
  const key = '0x' + addrWord('0x0000000000000000000000000000000000000000') + addrWord(TEXEL)
    + word(0) + word(200) + addrWord(PONS.v2.hook);
  const f = stub({
    [selectorOf('ownerOf(uint256)')]: '0x' + addrWord('0x2222222222222222222222222222222222222222'),
    [selectorOf('getPoolAndPositionInfo(uint256)')]: key + word(0),
    [selectorOf('getLiquidity(bytes32)')]: '0x' + word(1),
  });
  const a = await assessV4Position(RPC, 1, { fetchImpl: f });
  assert.equal(a.isPonsLocker, false);
  assert.equal(a.locker, null, 'an unknown owner is not called a locker');
});

test('a non-Pons hook is not claimed as a Pons pool', async () => {
  const key = '0x' + addrWord('0x0000000000000000000000000000000000000000') + addrWord(TEXEL)
    + word(0) + word(200) + addrWord('0x3333333333333333333333333333333333333333');
  const f = stub({
    [selectorOf('ownerOf(uint256)')]: '0x' + addrWord(PONS.v2.locker),
    [selectorOf('getPoolAndPositionInfo(uint256)')]: key + word(0),
    [selectorOf('getLiquidity(bytes32)')]: '0x' + word(1),
  });
  const a = await assessV4Position(RPC, 1, { fetchImpl: f });
  assert.equal(a.hookIsPons, false);
});

// ---------------------------------------------------------------------------
// Locked SUPPLY is not locked LIQUIDITY
// ---------------------------------------------------------------------------

test('locked token supply is measured in basis points, matching 4/49', async () => {
  // Pons locks 4/49 of supply as TOKENS at graduation (8.1633%), separately from holding the
  // pool's LP position. Conflating the two is the defect this separation prevents.
  const supply = 1000000000000000000000000000n;
  const locked = 81632651172847780733814253n;
  const f = stub({
    [selectorOf('balanceOf(address)')]: '0x' + word(locked),
    [selectorOf('totalSupply()')]: '0x' + word(supply),
  });
  const r = await readLockedSupply(RPC, TEXEL, undefined, { fetchImpl: f });
  assert.equal(r.status, 'ok');
  assert.equal(r.lockedSupplyBps, 816, '8.16% in basis points');
  assert.equal(r.lockedTokens, locked.toString());
});

test('a token whose supply cannot be read is unavailable, never 0%', async () => {
  const f = stub({
    [selectorOf('balanceOf(address)')]: 'revert',
    [selectorOf('totalSupply()')]: 'revert',
  });
  const r = await readLockedSupply(RPC, TEXEL, undefined, { fetchImpl: f });
  assert.notEqual(r.lockedSupplyBps, 0, 'an unread supply is not "nothing locked"');
  assert.equal(r.status, 'unavailable');
});

// ---------------------------------------------------------------------------
// Locker identity
// ---------------------------------------------------------------------------

test('all known Pons lockers are recognised, across both generations', () => {
  assert.ok(PONS_LOCKERS.includes(PONS.v2.locker.toLowerCase()));
  assert.ok(PONS_LOCKERS.includes(PONS.v1.locker.toLowerCase()));
  assert.ok(PONS_LOCKERS.includes(PONS.v1.legacyLocker.toLowerCase()));
  // Same address on a different chain would be a different contract, so these must be
  // pinned per chain rather than assumed from a shared list.
  assert.equal(new Set(PONS_LOCKERS).size, PONS_LOCKERS.length, 'no duplicates');
});

test('ethCall distinguishes revert from transport', async () => {
  const revert = await ethCall(RPC, TEXEL, '0x12345678', {
    fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({ jsonrpc: '2.0', id: 1, error: { message: 'execution reverted' } }) }),
  });
  assert.equal(revert.why, 'revert');
  const down = await ethCall(RPC, TEXEL, '0x12345678', {
    fetchImpl: async () => ({ ok: false, status: 503, json: async () => ({}) }),
  });
  assert.equal(down.why, 'transport');
  assert.notEqual(revert.why, down.why);
});
