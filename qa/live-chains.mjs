/**
 * qa/live-chains.mjs
 * Real end-to-end verification across every scannable chain.
 * Uses the real live adapter, not mocks. Prints exactly what came back so a
 * capability claim can be checked against evidence.
 *
 * Usage: SCAN_MODE=live node qa/live-chains.mjs
 */
import { liveScan, clearLiveCache } from '../src/live-scan.mjs';
import { clearRiskCache } from '../src/risk-intel.mjs';
import { clearDexPaidCache } from '../src/dex-paid.mjs';
import { formatCard } from '../src/format-card.mjs';
import { SCANNABLE_CHAINS, CHAINS } from '../src/chains.mjs';

// One known-real token per chain, each taken from a live DexScreener pair payload
// during setup and then re-verified through token-pairs. Not guessed.
const SAMPLES = {
  solana: '7vfCXTUXx5WJV5JADk17DUJ4ksgau7utNKj4b963voxs',
  ethereum: '0x6982508145454Ce325dDbE47a25d4ec3d2311933',
  bsc: '0x25d887Ce7a35172C62FeBFD67a1856F20FaEbB00',
  base: '0xfde4C96c8593536E31F229EA8f37b2ADa2699bb2',
  arbitrum: '0x912CE59144191C1204E64559FE8253a0e49E6548',
  optimism: '0x4200000000000000000000000000000000000042',
  polygon: '0xE6417f0BFDAb8264C0A798150c74fd1D996d1435',
  avalanche: '0x2F6F07CDcf3588944Bf4C42aC74ff24bF56e7590',
  hyperevm: '0xb88339CB7199b77E23DB6E890353E22632Ba630f',
  monad: '0x3bd359C1119dA7Da1D913D1C4D2B7c461115433A',
  robinhood: '0xcDcABf520Be369123C36796F9e53680C657f08f0',
  unichain: '0xe64dF0C18c010BDfba5093a3Fed7Bb6ceabec22C',
  berachain: '0x0F81001eF0A83ecCE5ccebf63EB302c70a39a654',
  abstract: '0x0709F39376dEEe2A2dfC94A58EdEb2Eb9DF012bD',
  megaeth: '0x28B7E77f82B25B95953825F1E3eA0E36c1c29861',
};

clearLiveCache(); clearRiskCache(); clearDexPaidCache();

const rows = [];
for (const chain of SCANNABLE_CHAINS) {
  const address = SAMPLES[chain];
  if (!address) { rows.push({ chain, status: 'NO-SAMPLE' }); continue; }
  const r = await liveScan({ chain, address });
  let compactOk = null, detailedOk = null;
  if (r.status === 'ok') {
    const c = formatCard(r, { view: 'compact' });
    const d = formatCard(r, { view: 'detailed' });
    compactOk = c.text.length;
    detailedOk = d.text.length;
  }
  rows.push({
    chain,
    name: CHAINS[chain].name,
    status: r.status,
    symbol: r.token?.symbol ?? null,
    mcap: r.market?.marketCapUsd ?? null,
    liq: r.market?.liquidityUsd ?? null,
    holders: r.risk?.holders?.total ?? null,
    top10: r.risk?.holders?.top10Percentage ?? null,
    tax: r.risk?.tax ? `${r.risk.tax.buy}/${r.risk.tax.sell}` : null,
    lp: r.risk?.lpLock?.lockedPercentage ?? null,
    dev: r.risk?.dev?.balancePercentage ?? null,
    riskStatus: r.riskStatus,
    dexPaid: r.dexPaid?.status,
    links: [r.project?.website, r.project?.x, r.project?.telegram].filter(Boolean).length,
    compactLen: compactOk, detailedLen: detailedOk,
  });
  await new Promise((s) => setTimeout(s, 400));
}

console.log('\n=== LIVE CHAIN MATRIX ===');
const pad = (v, n) => String(v ?? '-').padEnd(n);
console.log(pad('chain', 12), pad('status', 9), pad('sym', 10), pad('mcap', 13), pad('holders', 9), pad('top10', 7), pad('tax', 9), pad('lp%', 6), pad('dev%', 7), pad('risk', 11), pad('paid', 9), 'links');
for (const r of rows) {
  console.log(
    pad(r.chain, 12), pad(r.status, 9), pad(r.symbol, 10),
    pad(r.mcap ? `$${(r.mcap / 1e6).toFixed(1)}M` : '-', 13),
    pad(r.holders, 9), pad(r.top10 != null ? r.top10.toFixed(1) : '-', 7),
    pad(r.tax, 9), pad(r.lp != null ? r.lp.toFixed(0) : '-', 6),
    pad(r.dev != null ? r.dev.toFixed(1) : '-', 7),
    pad(r.riskStatus, 11), pad(r.dexPaid, 9), r.links,
  );
}

const ok = rows.filter((r) => r.status === 'ok').length;
console.log(`\nOK: ${ok}/${rows.length} chains returned a real, matching pair.`);
const withHolders = rows.filter((r) => r.holders != null).length;
const withTax = rows.filter((r) => r.tax != null).length;
const withPaidAssert = rows.filter((r) => r.dexPaid && r.dexPaid !== 'unknown').length;
console.log(`holders: ${withHolders} chains · tax: ${withTax} chains · dexPaid assertable: ${withPaidAssert} chains`);
