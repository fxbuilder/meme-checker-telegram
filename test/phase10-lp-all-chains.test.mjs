/**
 * test/phase10-lp-all-chains.test.mjs
 *
 * The LP read must run on chains WITHOUT GoPlus coverage too.
 *
 * Root cause found by measurement: `fetchRisk` returned early via `fetchFallbackRisk()` for
 * any chain with no GoPlus entry, and the LP block sat BELOW that early return. So Elysium,
 * HyperEVM and MegaETH never attempted an LP read - Elysium's V4 pools showed a bare dash
 * while Base's V4 pools correctly said "V2 maths does not apply". The same situation,
 * answered two different ways, because of where a code block happened to sit.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { fetchRisk, clearRiskCache } from '../src/risk-intel.mjs';
import { resolveQuickCheck } from '../src/card-layout.mjs';

const TOKEN = '0xb47c4c8f73f009cc0c0d3f92b388d13e293f0b65';
const PAIR = '0x97796D80b6A1db78632f7451196b04f307329EB6';

/** GoPlus has no Elysium entry, so this chain takes the fallback path. */
test('elysium is a chain that takes the no-GoPlus fallback path', async () => {
  const { getChain } = await import('../src/chains.mjs');
  const chain = getChain('elysium');
  assert.ok(chain, 'elysium must be registered');
  assert.equal(chain.goplus, null, 'no GoPlus coverage - this is the path being tested');
  assert.ok(chain.rpc, 'but it does have an RPC, so an LP read IS possible');
});

/**
 * A stub for the fallback path: GeckoTerminal's token-info returns nothing useful, and the
 * pool contract reverts totalSupply() - which is exactly a V3/V4 pool.
 */
function stub() {
  return async (url, opts) => {
    const u = String(url);
    if (u.includes('geckoterminal')) {
      return { ok: true, status: 200, json: async () => ({ data: null }) };
    }
    // JSON-RPC: revert, the signature of a position-based pool.
    return { ok: true, status: 200, json: async () => ({ jsonrpc: '2.0', id: 1, error: { message: 'execution reverted' } }) };
  };
}

test('a no-GoPlus chain still reports the pool type instead of a bare dash', async () => {
  clearRiskCache();
  const r = await fetchRisk('elysium', TOKEN, {
    fetchImpl: stub(),
    pair: { pairAddress: PAIR, labels: null },
  });
  const lp = r.data?.lpLock;
  assert.ok(lp, 'an LP block must be produced even with no security provider');
  assert.equal(lp.positionType, 'v3-v4', 'the pool type is identified from the revert');
  assert.ok(String(lp.positionTypeDetail).length > 0, 'and the reason is stated');

  // The card must explain itself rather than showing an unexplained dash.
  const card = resolveQuickCheck('lpLock', { risk: r.data, riskStatus: r.status });
  assert.notEqual(card.value, '—', 'a determined pool type is not a dash');
  assert.equal(card.value, 'V3/V4', 'the card states the pool type it identified');
});

test('the same pool type is described identically on a GoPlus chain', async () => {
  // Base has GoPlus coverage AND V4 pools. The wording must not differ by which code path
  // the chain happens to take.
  clearRiskCache();
  const r = await fetchRisk('base', '0x532f27101965dd16442E59d40670FaF5eBB142E4', {
    fetchImpl: stub(),
    pair: { pairAddress: PAIR, labels: ['v4'] },
  });
  const lp = r.data?.lpLock;
  assert.equal(lp?.positionType, 'v3-v4');
  assert.match(String(lp?.positionTypeDetail), /V2 lp-supply maths does not apply/,
    'the same underlying situation must produce the same explanation');
});
