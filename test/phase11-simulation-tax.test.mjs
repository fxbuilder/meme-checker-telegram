/**
 * Tax measurement by read-only simulation.
 *
 * The failure this guards is specific and was observed: a simulated transfer from a
 * balance-overridden SYNTHETIC sender reverts on the token's own balance check, and reading
 * "100% tax" from that revert is a fabrication. Overriding `balance` grants native currency,
 * not ERC-20 tokens.
 *
 * The working method passes a REAL holder as `from`, so no storage slot and no balance
 * override are needed and the transfer genuinely executes. Measured live on TEXEL this way:
 * statuses [0x1, 0x1], sent 1e18, received 1e18 => transfer fee 0 bps.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  simulateTransferTax, taxCapability, readDeclaredFees, SIMULATION_SUPPORT, TAX_STATUS,
} from '../src/security/simulation-tax.mjs';
import { selectorOf } from '../src/security/keccak.mjs';

const RPC = 'https://rpc.mainnet.chain.robinhood.com';
const TEXEL = '0x0ddcab9ae04bda0c87ecc1640636fa11e8e613e8';
const LOCKER = '0x267444D099b10fB5Ed7c3Cc7B7C767AdcA574952';

const word = (n) => BigInt(n).toString(16).padStart(64, '0');

/** Stub eth_simulateV1 outcomes. */
function stubSim({ holderBalance = 10n ** 24n, statuses = ['0x1', '0x1'], returnData = null, err = null } = {}) {
  return async (url, opts) => {
    const body = JSON.parse(opts.body);
    if (body.method === 'eth_call') {
      return { ok: true, status: 200, json: async () => ({ jsonrpc: '2.0', id: 1, result: '0x' + word(holderBalance) }) };
    }
    if (body.method === 'eth_simulateV1') {
      if (err) return { ok: true, status: 200, json: async () => ({ jsonrpc: '2.0', id: 1, error: { message: err } }) };
      return {
        ok: true,
        status: 200,
        json: async () => ({
          jsonrpc: '2.0',
          id: 1,
          result: [{
            calls: statuses.map((st, i) => ({
              status: st,
              returnData: i === 1 ? (returnData ?? '0x' + word(10n ** 18n)) : '0x',
              error: st === '0x0' ? { message: 'execution reverted' } : undefined,
            })),
          }],
        }),
      };
    }
    return { ok: true, status: 200, json: async () => ({ jsonrpc: '2.0', id: 1, result: '0x0' }) };
  };
}

// ---------------------------------------------------------------------------
// Capability, decided before spending a request
// ---------------------------------------------------------------------------

test('HyperEVM has no post-state method, so tax is unmeasurable there', async () => {
  const cap = taxCapability('hyperevm');
  assert.equal(cap.measurable, false);
  assert.equal(cap.status, TAX_STATUS.UNMEASURABLE);
  assert.match(cap.reason, /no eth_simulateV1, no debug_traceCall/);
});

test('Robinhood and Elysium have simulation, but still cannot measure without a holder', () => {
  for (const chain of ['robinhood', 'elysium']) {
    const cap = taxCapability(chain);
    assert.equal(cap.simulationAvailable, true, `${chain} exposes eth_simulateV1`);
    assert.equal(cap.measurable, false, 'but a synthetic sender has no tokens');
    assert.match(cap.reason, /storage slot/);
  }
});

test('the verified simulation matrix is recorded per chain', () => {
  assert.equal(SIMULATION_SUPPORT.robinhood.eth_simulateV1, true);
  assert.equal(SIMULATION_SUPPORT.robinhood.debug_traceCall, false);
  assert.equal(SIMULATION_SUPPORT.elysium.debug_traceCall, true);
  assert.equal(SIMULATION_SUPPORT.hyperevm.eth_simulateV1, false);
});

// ---------------------------------------------------------------------------
// A revert is not a tax
// ---------------------------------------------------------------------------

test('a reverted simulated transfer yields NO tax figure', async () => {
  // The exact trap: status 0x0 means nothing executed, so any "tax" derived from it is invented.
  const r = await simulateTransferTax({
    chainId: 'robinhood', rpc: RPC, token: TEXEL, sender: LOCKER,
    fetchImpl: stubSim({ statuses: ['0x0', '0x1'] }),
  });
  assert.equal(r.taxBps, null, 'a revert measured nothing');
  assert.equal(r.status, TAX_STATUS.ERROR);
  assert.match(r.reason, /did not succeed/);
});

test('a holder with too little balance is unmeasurable, not 0%', async () => {
  const r = await simulateTransferTax({
    chainId: 'robinhood', rpc: RPC, token: TEXEL, sender: LOCKER, amount: 10n ** 18n,
    fetchImpl: stubSim({ holderBalance: 5n }),
  });
  assert.equal(r.status, TAX_STATUS.UNMEASURABLE);
  assert.notEqual(r.taxBps, 0);
  assert.match(r.reason, /less than/);
});

test('no sender and no storage slot is unmeasurable with the reason', async () => {
  const r = await simulateTransferTax({ chainId: 'robinhood', rpc: RPC, token: TEXEL, fetchImpl: stubSim() });
  assert.equal(r.status, TAX_STATUS.UNMEASURABLE);
  assert.equal(r.taxBps, null);
  assert.match(r.reason, /balance storage slot unknown/);
});

// ---------------------------------------------------------------------------
// The working path: a real holder
// ---------------------------------------------------------------------------

test('a real holder with zero fee measures 0 bps BY OBSERVATION', async () => {
  // Measured live on TEXEL: sent 1e18, received 1e18.
  const r = await simulateTransferTax({
    chainId: 'robinhood', rpc: RPC, token: TEXEL, sender: LOCKER,
    fetchImpl: stubSim({ returnData: '0x' + word(10n ** 18n) }),
  });
  assert.equal(r.status, TAX_STATUS.MEASURED);
  assert.equal(r.taxBps, 0);
  assert.equal(r.kind, 'transfer-fee', 'a transfer fee is not a buy/sell tax');
  assert.equal(r.method, 'simulateV1-from-holder');
});

test('a non-zero fee is computed from the observed shortfall', async () => {
  // 5% fee: 0.95e18 received of 1e18 sent.
  const r = await simulateTransferTax({
    chainId: 'robinhood', rpc: RPC, token: TEXEL, sender: LOCKER,
    fetchImpl: stubSim({ returnData: '0x' + word(95n * 10n ** 16n) }),
  });
  assert.equal(r.status, TAX_STATUS.MEASURED);
  assert.equal(r.taxBps, 500);
});

test('receiving MORE than was sent is refused rather than reported as a negative fee', async () => {
  const r = await simulateTransferTax({
    chainId: 'robinhood', rpc: RPC, token: TEXEL, sender: LOCKER,
    fetchImpl: stubSim({ returnData: '0x' + word(2n * 10n ** 18n) }),
  });
  assert.equal(r.taxBps, null);
  assert.equal(r.status, TAX_STATUS.ERROR);
});

test('an rpc error is an error status, never a zero tax', async () => {
  const r = await simulateTransferTax({
    chainId: 'robinhood', rpc: RPC, token: TEXEL, sender: LOCKER,
    fetchImpl: stubSim({ err: 'method not found' }),
  });
  assert.equal(r.status, TAX_STATUS.ERROR);
  assert.notEqual(r.taxBps, 0);
});

// ---------------------------------------------------------------------------
// Declared fees are not measured fees
// ---------------------------------------------------------------------------

test('a declared getter is labelled `declared`, never passed off as measured', async () => {
  const f = async (url, opts) => {
    const data = JSON.parse(opts.body).params[0].data;
    if (data === selectorOf('buyFeeBps()')) {
      return { ok: true, status: 200, json: async () => ({ jsonrpc: '2.0', id: 1, result: '0x' + word(300) }) };
    }
    return { ok: true, status: 200, json: async () => ({ jsonrpc: '2.0', id: 1, error: { message: 'revert' } }) };
  };
  const r = await readDeclaredFees({ rpc: RPC, token: TEXEL, fetchImpl: f, selectorOf });
  assert.equal(r.status, 'declared');
  assert.equal(r.values['buyFeeBps()'], 300);
  assert.equal(r.source, 'declared-getter', 'a self-reported value is not an observation');
});

test('a token declaring nothing reports none-declared, not zero', async () => {
  const f = async () => ({ ok: true, status: 200, json: async () => ({ jsonrpc: '2.0', id: 1, error: { message: 'revert' } }) });
  const r = await readDeclaredFees({ rpc: RPC, token: TEXEL, fetchImpl: f, selectorOf });
  assert.equal(r.status, 'none-declared');
  assert.deepEqual(r.values, {});
});
