/**
 * test/risk-dexpaid.test.mjs
 * The honesty rules for risk indicators and Dex Paid.
 * Every failure here corresponds to a card that would lie about a token.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeRisk, fetchRisk, clearRiskCache, emptyRisk } from '../src/risk-intel.mjs';
import { classifyOrders, fetchDexPaid, clearDexPaidCache } from '../src/dex-paid.mjs';
import { resolveQuickCheck, quickChecks, QUICK_CHECK_KEYS } from '../src/card-layout.mjs';

const jsonRes = (body, status = 200) => ({ ok: status >= 200 && status < 300, status, json: async () => body });
const stub = (impl) => { const f = async () => impl(); f.calls = []; return f; };

// ---- GoPlus normalization: EVM ---------------------------------------------

const GOPLUS_ETH = {
  holder_count: '1000',
  holders: [
    { percent: '0.30', is_locked: 0 },
    { percent: '0.25', is_locked: 0 },
    { percent: '0.05', is_locked: 0 },
  ],
  buy_tax: '0',
  sell_tax: '0.05',
  is_honeypot: '0',
  is_mintable: '1',
  creator_address: '0xabc',
  creator_percent: '0.02',
  owner_address: '0x0000000000000000000000000000000000000000',
  lp_holders: [
    { percent: '0.80', is_locked: 1 },
    { percent: '0.20', is_locked: 0 },
  ],
  is_open_source: '1',
};

test('EVM risk normalizes holders, tax, LP lock and dev', () => {
  const r = normalizeRisk('ethereum', GOPLUS_ETH);
  assert.equal(r.holders.total, 1000);
  // GoPlus percents are fractions: 0.30 + 0.25 + 0.05 = 0.60 -> 60%
  assert.equal(Math.round(r.holders.top10Percentage), 60);
  assert.equal(r.holders.largestHolderPercentage, 30);
  assert.deepEqual(r.tax, { buy: 0, sell: 5 }, 'buy 0% and sell 5% are distinct');
  assert.equal(r.security.honeypot, false);
  assert.equal(r.security.mintable, true);
  assert.equal(r.dev.address, '0xabc');
  assert.equal(Math.round(r.dev.balancePercentage), 2);
  assert.equal(Math.round(r.lpLock.lockedPercentage), 80);
});

test('a real 0% tax is preserved as 0, not treated as missing', () => {
  const r = normalizeRisk('bsc', { ...GOPLUS_ETH, buy_tax: '0', sell_tax: '0' });
  assert.deepEqual(r.tax, { buy: 0, sell: 0 });
});

test('absent tax fields become null, never 0% (Base omits them)', () => {
  const r = normalizeRisk('base', { ...GOPLUS_ETH, buy_tax: undefined, sell_tax: undefined });
  assert.equal(r.tax, null, 'unknown tax must not render as 0%');
});

test('Solana has no tax concept — null even if a value were present', () => {
  const r = normalizeRisk('solana', { holder_count: '5', buy_tax: '0.01', sell_tax: '0.01' });
  assert.equal(r.tax, null);
  assert.equal(r.holders.total, 5);
});

test('Solana honeypot flag is absent by design — null, not false', () => {
  const r = normalizeRisk('solana', { holder_count: '5' });
  assert.equal(r.security.honeypot, null, 'must not imply "checked, not a honeypot"');
});

test('a row with no usable fields returns null rather than an all-null block', () => {
  assert.equal(normalizeRisk('ethereum', { some_unrelated: 'x' }), null);
});

test('emptyRisk is the explicit all-unknown shape', () => {
  const r = emptyRisk();
  assert.deepEqual(r.holders, { total: null, top10Percentage: null, largestHolderPercentage: null });
  assert.equal(r.tax, null);
  assert.equal(r.lpLock, null);
  assert.equal(r.dev, null);
});

// ---- fetchRisk statuses ----------------------------------------------------

test('a chain with no GoPlus coverage falls back instead of giving up', async () => {
  clearRiskCache();
  // HyperEVM has no GoPlus id. It now consults GeckoTerminal, which DOES carry holder
  // concentration and authority flags - so "no GoPlus" is not "no data".
  // fetchTokenInfo reads res.text() and parses it, so the stub must supply text().
  const body = {
    data: {
      attributes: {
        holders: { count: 1234, distribution_percentage: { top_10: '44.5' } },
        mint_authority: null,
        freeze_authority: null,
        is_honeypot: 'unknown',
      },
    },
  };
  const f = stub(() => ({ ok: true, status: 200, text: async () => JSON.stringify(body) }));
  const r = await fetchRisk('hyperevm', '0x1111111111111111111111111111111111111111', { fetchImpl: f });
  assert.equal(r.status, 'ok', 'the fallback supplied usable fields');
  assert.equal(r.data.holders.top10Percentage, 44.5);
  assert.equal(r.data.security.mintable, false, 'an explicit null authority means renounced');
});

test('a fallback that yields nothing usable still reports a capability gap', async () => {
  clearRiskCache();
  const body = { data: { attributes: { name: 'X', symbol: 'X' } } };
  const f = stub(() => ({ ok: true, status: 200, text: async () => JSON.stringify(body) }));
  const r = await fetchRisk('hyperevm', '0x2222222222222222222222222222222222222222', { fetchImpl: f });
  assert.equal(r.status, 'no-data', 'no security fields is "provider has nothing", not "safe"');
  assert.equal(r.data, null);
});

test('GoPlus code:1 with empty result is no-data, not an error and not zero', async () => {
  clearRiskCache();
  const f = stub(() => jsonRes({ code: 1, message: 'OK', result: {} }));
  const r = await fetchRisk('ethereum', '0x1111111111111111111111111111111111111111', { fetchImpl: f });
  assert.equal(r.status, 'no-data');
  assert.equal(r.data, null);
});

test('a 429 becomes error, never a clean-looking empty result', async () => {
  clearRiskCache();
  const r = await fetchRisk('bsc', '0x1111111111111111111111111111111111111111', {
    fetchImpl: stub(() => jsonRes(null, 429)),
  });
  assert.equal(r.status, 'error');
  assert.match(r.detail, /rate/);
});

test('transport failure becomes error', async () => {
  clearRiskCache();
  const r = await fetchRisk('bsc', '0x1111111111111111111111111111111111111111', {
    fetchImpl: async () => { throw new Error('ECONNRESET'); },
  });
  assert.equal(r.status, 'error');
  assert.match(r.detail, /ECONNRESET/);
});

test('Solana uses the solana endpoint, EVM uses the numeric chain id', async () => {
  clearRiskCache();
  const seen = [];
  const f = async (url) => { seen.push(url); return jsonRes({ code: 1, result: {} }); };
  await fetchRisk('solana', 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263', { fetchImpl: f });
  await fetchRisk('optimism', '0x4200000000000000000000000000000000000042', { fetchImpl: f });
  // Solana also consults RugCheck now, so assert on the GoPlus URL specifically
  // rather than assuming it is the first call.
  const goplusSolana = seen.find((u) => /gopluslabs/.test(u) && /solana/.test(u));
  assert.ok(goplusSolana, `expected a GoPlus solana call among ${seen.join(', ')}`);
  assert.match(goplusSolana, /\/solana\/token_security/);
  const optimism = seen.find((u) => /token_security\/10\?/.test(u));
  assert.ok(optimism, 'optimism must use the numeric chain id 10');
});

// ---- Dex Paid classification ----------------------------------------------

test('Dex Paid: approved order means paid', () => {
  const r = classifyOrders('ethereum', { orders: [{ type: 'tokenProfile', status: 'approved' }], boosts: [] });
  assert.equal(r.status, 'paid');
  assert.deepEqual(r.types, ['tokenProfile']);
});

test('Dex Paid: empty on an indexed chain is genuinely not-paid', () => {
  const r = classifyOrders('bsc', { orders: [], boosts: [] });
  assert.equal(r.status, 'not-paid');
});

test('Dex Paid: empty on an UNINDEXED chain is unknown, never not-paid', () => {
  // This is the trap: an invalid slug also returns 200 + empty.
  const r = classifyOrders('arbitrum', { orders: [], boosts: [] });
  assert.equal(r.status, 'unknown');
  assert.match(r.detail, /not proven to index/);
});

test('Dex Paid: cancelled order is not paid, but is distinguishable', () => {
  const r = classifyOrders('solana', { orders: [{ type: 'communityTakeover', status: 'cancelled' }], boosts: [] });
  assert.equal(r.status, 'not-paid');
  assert.match(r.detail, /no active order/);
});

test('Dex Paid: on-hold is not paid', () => {
  const r = classifyOrders('bsc', { orders: [{ type: 'tokenProfile', status: 'on-hold' }], boosts: [] });
  assert.equal(r.status, 'not-paid');
});

test('Dex Paid: boosts alone count as a signal, and paid requires approved', () => {
  const r = classifyOrders('solana', { orders: [], boosts: [{ totalAmount: 10 }] });
  assert.equal(r.status, 'not-paid', 'boost without an approved order is not the paid product');
  assert.equal(r.boosts, 1);
});

test('Dex Paid: feature-gated chain returns unknown without any request', async () => {
  clearDexPaidCache();
  let called = false;
  const f = async () => { called = true; return jsonRes({}); };
  const r = await fetchDexPaid('monad', '0x1111111111111111111111111111111111111111', { fetchImpl: f });
  assert.equal(r.status, 'unknown');
  assert.equal(called, false, 'must not call the provider for an unindexed chain');
});

test('Dex Paid: provider failure is unknown, never an accusation', async () => {
  clearDexPaidCache();
  const r = await fetchDexPaid('base', '0x1111111111111111111111111111111111111111', {
    fetchImpl: stub(() => jsonRes(null, 503)),
  });
  assert.equal(r.status, 'unknown');
  assert.match(r.detail, /503/);
});

// ---- Quick check presentation ---------------------------------------------

test('all six quick checks exist in a fixed order', () => {
  assert.deepEqual(QUICK_CHECK_KEYS, ['top10', 'holders', 'dexPaid', 'tax', 'lpLock', 'dev']);
});

test('quick checks render unavailable states honestly', () => {
  // Chain with no risk source at all.
  const unsupported = { risk: emptyRisk(), riskStatus: 'unsupported', dexPaid: { status: 'unknown' } };
  const q = quickChecks(unsupported);
  assert.equal(q.find((x) => x.key === 'top10').value, 'n/a');
  assert.equal(q.find((x) => x.key === 'holders').value, 'n/a');
  assert.equal(q.find((x) => x.key === 'dexPaid').value, 'Unknown');
  // Never claim "Not Paid" when the chain is not indexed.
  assert.notEqual(q.find((x) => x.key === 'dexPaid').value, 'Not Paid');
});

test('a checked-but-absent value uses a dash, distinguishable from unsupported', () => {
  const noData = { risk: emptyRisk(), riskStatus: 'no-data', dexPaid: { status: 'unknown' } };
  const q = quickChecks(noData);
  assert.equal(q.find((x) => x.key === 'holders').value, '—');
});

test('tax shows symmetric value collapsed, asymmetric as buy/sell', () => {
  const sym = resolveQuickCheck('tax', { risk: { ...emptyRisk(), tax: { buy: 5, sell: 5 } }, riskStatus: 'ok' });
  assert.equal(sym.value, '5.0%');
  const asym = resolveQuickCheck('tax', { risk: { ...emptyRisk(), tax: { buy: 3, sell: 8 } }, riskStatus: 'ok' });
  assert.equal(asym.value, '3.0/8.0%');
});

test('tax with zero renders 0.0% and is not hidden', () => {
  const r = resolveQuickCheck('tax', { risk: { ...emptyRisk(), tax: { buy: 0, sell: 0 } }, riskStatus: 'ok' });
  assert.equal(r.value, '0.0%');
  assert.equal(r.tone, 'good');
});

test('partial tax states which side is known', () => {
  const r = resolveQuickCheck('tax', { risk: { ...emptyRisk(), tax: { buy: null, sell: 4 } }, riskStatus: 'ok' });
  assert.equal(r.value, 'Sell 4.0%');
});

test('LP lock and dev never fabricate a percentage', () => {
  const r = resolveQuickCheck('dev', { risk: { ...emptyRisk(), dev: { address: '0xabc', balancePercentage: null } }, riskStatus: 'ok' });
  assert.equal(r.value, 'Known', 'knowing a dev exists is not 0%');
  const lp = resolveQuickCheck('lpLock', { risk: { ...emptyRisk(), lpLock: { lockedPercentage: null } }, riskStatus: 'ok' });
  assert.equal(lp.value, '—');
});

test('sub-percent LP lock shows <1% rather than rounding to 0%', () => {
  const r = resolveQuickCheck('lpLock', { risk: { ...emptyRisk(), lpLock: { lockedPercentage: 0.09 } }, riskStatus: 'ok' });
  assert.equal(r.value, '<1%');
  // Genuinely zero stays 0%.
  const zero = resolveQuickCheck('lpLock', { risk: { ...emptyRisk(), lpLock: { lockedPercentage: 0 } }, riskStatus: 'ok' });
  assert.equal(zero.value, '0%');
});

test('a tiny non-zero dev holding shows <0.1% rather than 0.0%', () => {
  const r = resolveQuickCheck('dev', { risk: { ...emptyRisk(), dev: { address: '0xabc', balancePercentage: 0.04 } }, riskStatus: 'ok' });
  assert.equal(r.value, '<0.1%');
  const zero = resolveQuickCheck('dev', { risk: { ...emptyRisk(), dev: { address: '0xabc', balancePercentage: 0 } }, riskStatus: 'ok' });
  assert.equal(zero.value, '0.0%');
});

test('the raw float GoPlus returns for a fractional holding never reaches the card', () => {
  // Observed live on BNB Chain: 0.00009999999999999999. It must never print as-is,
  // and never round down to a confident 0.0% either, because that reads as "no holding".
  const observed = 0.00009999999999999999;
  const r = resolveQuickCheck('dev', { risk: { ...emptyRisk(), dev: { address: '0xabc', balancePercentage: observed } }, riskStatus: 'ok' });
  assert.equal(r.value, '<0.1%');
  assert.notEqual(r.value, '0.0%');
  assert.ok(!r.value.includes('9999'), 'the raw float does not leak through');
  assert.equal(r.tone, 'warn', 'a non-zero holding is not a clean bill of health');
});

test('the raw float GoPlus returns for a fractional LP lock never reaches the card', () => {
  // Observed live on Ethereum: 0.009091289719550899. It is a real, tiny lock - a
  // near-total absence of protection - and must read as such, not as a rounded 0%.
  const observed = 0.009091289719550899;
  const r = resolveQuickCheck('lpLock', { risk: { ...emptyRisk(), lpLock: { lockedPercentage: observed, burnedPercentage: 0 } }, riskStatus: 'ok' });
  assert.equal(r.value, '<1%');
  assert.equal(r.tone, 'bad');
  assert.ok(!r.value.includes('9091'), 'the raw float does not leak through');
});

test('Solana with an EMPTY creators array reports no dev, not "Known"', () => {
  const r = normalizeRisk('solana', { holder_count: '10', creators: [] });
  assert.equal(r.dev, null, 'empty creators must not render as a known dev');
  const q = resolveQuickCheck('dev', { risk: r, riskStatus: 'ok' });
  assert.equal(q.value, '—');
});

test('Solana reports the creator address but NOT a holding from creators[].percent', () => {
  // ROUND 2 CORRECTION. `creators[].percent` on a Metaplex record is that creator's
  // share of ROYALTIES, not a share of token supply. The old assertion (0.05 -> 5%)
  // published a royalty split as if it were a token holding - an invented risk figure.
  // A real Solana holding comes from RugCheck's creatorBalance.
  const r = normalizeRisk('solana', { holder_count: '10', creators: [{ address: 'Dev111', percent: '0.05' }] });
  assert.equal(r.dev.address, 'Dev111');
  assert.equal(r.dev.role, 'creator');
  assert.equal(r.dev.balancePercentage, null, 'royalty share must never become a holding');
});
