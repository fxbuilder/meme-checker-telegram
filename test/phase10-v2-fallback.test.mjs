/**
 * test/phase10-v2-fallback.test.mjs
 *
 * The primary pair is often V3 while the token ALSO has a readable V2 pair.
 *
 * Measured: CAKE's deepest pool is V3, and it has four V2 pairs, the largest holding
 * $755k. Reading only the primary meant a perfectly readable lock state was skipped and the
 * token fell through to "v3-v4 - V2 maths does not apply". A V2 fallback now runs, with a
 * depth floor so a $462 V2 pair beside a $5M V3 pool cannot describe the wrong liquidity.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { fetchRisk, clearRiskCache } from '../src/risk-intel.mjs';
import { resolveQuickCheck } from '../src/card-layout.mjs';

const TOKEN = '0x0E09FaBB73Bd3Ade0a17ECC321fD13a19e81cE82';
const V3_PAIR = '0x1111111111111111111111111111111111111111';
const V2_PAIR = '0x2222222222222222222222222222222222222222';

const word = (n) => '0x' + BigInt(n).toString(16).padStart(64, '0');
const bal = (a) => `0x70a08231${a.replace(/^0x/, '').toLowerCase().padStart(64, '0')}`;

/**
 * Stub answering DexScreener pair lists and JSON-RPC.
 *
 * `burn` is put at 0xdEaD only; 0x0 holds zero. Keeping the two distinct is the point -
 * a stub that returns the same number for both cannot tell a burn from a zero balance.
 */
function stub({ pairs = [], supply = 1000, burn = 0, locker = null } = {}) {
  return async (url, opts) => {
    const u = String(url);
    if (u.includes('token-pairs')) return { ok: true, status: 200, json: async () => pairs };

    // Non-RPC calls (e.g. the security provider) are answered with an empty envelope so
    // they resolve instantly instead of falling through to the real network.
    let data = null;
    try { data = JSON.parse(opts?.body ?? '{}')?.params?.[0]?.data ?? null; } catch { data = null; }
    if (!data) return { ok: true, status: 200, json: async () => ({ code: 1, result: {} }) };
    const rpc = (result) => ({ ok: true, status: 200, json: async () => ({ jsonrpc: '2.0', id: 1, result }) });

    if (data.startsWith('0x18160ddd')) return rpc(word(supply));

    if (data.startsWith('0x70a08231')) {
      // Selector is 10 chars; the address occupies the following 32-byte word.
      const arg = '0x' + data.slice(10).toLowerCase();
      const isZero = /^0x0+$/.test(arg);
      const isDead = /^0x0+dead$/.test(arg);
      if (isDead) return rpc(word(burn));
      if (isZero) return rpc(word(0));
      if (locker && arg === '0x' + locker.slice(2).toLowerCase()) return rpc(word(supply));
      return rpc(word(0));
    }
    return { ok: true, status: 200, json: async () => ({ jsonrpc: '2.0', id: 1, error: { message: 'revert' } }) };
  };
}

test('a V3 primary with a deep V2 pair falls back to the V2 pair', async () => {
  clearRiskCache();
  const f = stub({
    pairs: [
      { pairAddress: V3_PAIR, labels: ['v3'], liquidity: { usd: 5_000_000 } },
      { pairAddress: V2_PAIR, labels: ['v2'], liquidity: { usd: 755_000 } },
    ],
    supply: 1000,
    burn: 1000, // fully burned
  });
  const r = await fetchRisk('bsc', TOKEN, {
    fetchImpl: f,
    pair: { pairAddress: V3_PAIR, labels: ['v3'] },
  });
  const lp = r.data?.lpLock;
  assert.ok(lp, 'a lock state must be produced');
  assert.equal(lp.kind, 'burned', 'the V2 pool decides, and it is burned');
  assert.match(String(lp.scope), /^v2:/, 'the scope records which pool was read');
});

test('a shallow V2 pair is NOT used to describe a deep pool', async () => {
  // fetchRisk caches on (chain, address) and every test here uses the same token, so the
  // previous case's verdict would otherwise be replayed.
  clearRiskCache();
  // A $462 V2 pair beside a multi-million V3 pool tells you nothing about the liquidity
  // holders actually trade against.
  const f = stub({
    pairs: [
      { pairAddress: V3_PAIR, labels: ['v3'], liquidity: { usd: 5_000_000 } },
      { pairAddress: V2_PAIR, labels: ['v2'], liquidity: { usd: 462 } },
    ],
  });
  const r = await fetchRisk('bsc', TOKEN, { fetchImpl: f, pair: { pairAddress: V3_PAIR, labels: ['v3'] } });
  const kind = r.data?.lpLock?.kind ?? r.data?.lpLock?.positionType;
  assert.equal(kind, 'v3-v4', 'falls back to the known-unsupported V3 answer');
});

test('a V2 primary is read directly, with no fallback lookup', async () => {
  clearRiskCache();
  let pairListCalls = 0;
  const inner = stub({ supply: 1000, burn: 1000 });
  const f = async (url, opts) => {
    if (String(url).includes('token-pairs')) pairListCalls += 1;
    return inner(url, opts);
  };
  const r = await fetchRisk('bsc', TOKEN, { fetchImpl: f, pair: { pairAddress: V2_PAIR, labels: ['v2'] } });
  assert.equal(r.data?.lpLock?.kind, 'burned');
  assert.equal(pairListCalls, 0, 'no extra market lookup when the primary already works');
});

test('an on-chain "not burned, no locker" is reported as Unlocked, not hidden', async () => {
  clearRiskCache();
  // This is a real finding: we read the pool and the liquidity is withdrawable.
  //
  // NOTE: this case reaches the GeckoTerminal security fallback, which applies a 6 s
  // pacing gate before fetching. That is genuine production behaviour, so the test is
  // slow by design rather than by accident - the alternative would be asserting on a
  // code path that does not run in production.
  const f = stub({
    pairs: [{ pairAddress: V2_PAIR, labels: ['v2'], liquidity: { usd: 100_000 } }],
    supply: 1000,
    burn: 0,
  });
  const r = await fetchRisk('bsc', TOKEN, { fetchImpl: f, pair: { pairAddress: V3_PAIR, labels: ['v3'] } });
  assert.equal(r.data?.lpLock?.kind, 'not-burned');
  // resolveQuickCheck takes a SCAN-shaped result ({risk, riskStatus}), not a fetchRisk
  // result ({status, data}) - passing the latter silently read an empty block.
  const card = resolveQuickCheck('lpLock', { risk: r.data, riskStatus: r.status });
  assert.equal(card.value, 'Unlocked');
  assert.equal(card.tone, 'high', 'withdrawable liquidity is a real risk');
  assert.notEqual(card.value, '—', 'a checked pool is not a dash');
});
