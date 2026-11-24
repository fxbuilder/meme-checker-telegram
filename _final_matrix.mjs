/**
 * Consolidated 16-chain matrix, 30s spacing so no chain is throttled.
 * Writes the authoritative matrix file.
 */
import { gtNetwork, fetchTokenInfo } from './src/research/geckoterminal.mjs';
import { readSolanaMint } from './src/research/onchain-metadata.mjs';
import { composeNarrative } from './src/research/narrative-pipeline.mjs';

const CHAINS = [
  ['solana', 'Solana'], ['ethereum', 'Ethereum'], ['bsc', 'BNB Chain'], ['base', 'Base'],
  ['arbitrum', 'Arbitrum'], ['optimism', 'Optimism'], ['polygon', 'Polygon'],
  ['avalanche', 'Avalanche'], ['hyperevm', 'HyperEVM'], ['monad', 'Monad'],
  ['robinhood', 'Robinhood'], ['unichain', 'Unichain'], ['berachain', 'Berachain'],
  ['abstract', 'Abstract'], ['megaeth', 'MegaETH'], ['story', 'Story'],
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const rows = [];

for (const [chain, label] of CHAINS) {
  const net = gtNetwork(chain);
  const row = { chain, label, metadataSource: Boolean(net), network: net, gtStatus: null, descLen: 0, available: false, source: null, claims: 0, note: null };

  if (!net) {
    row.note = 'no metadata source on GeckoTerminal';
    rows.push(row);
    continue;
  }

  // Pools list, retried through throttling.
  let addr = null;
  for (let attempt = 0; attempt < 3 && !addr; attempt += 1) {
    if (attempt) await sleep(30000);
    const res = await fetch(`https://api.geckoterminal.com/api/v2/networks/${net}/pools?page=1`, { headers: { accept: 'application/json' } });
    if (res.status === 429) { row.gtStatus = 'pools:429'; continue; }
    if (!res.ok) { row.gtStatus = `pools:${res.status}`; break; }
    const j = await res.json();
    const rel = j?.data?.[0]?.relationships?.base_token?.data?.id;
    if (rel) addr = String(rel).slice(String(rel).indexOf('_') + 1);
  }

  if (addr) {
    await sleep(30000);
    let info = { status: 'rate-limited' };
    for (let attempt = 0; attempt < 3; attempt += 1) {
      if (attempt) await sleep(30000);
      info = await fetchTokenInfo(chain, addr, { retriesLeft: 0 });
      if (info.status !== 'rate-limited') break;
    }
    row.gtStatus = info.status;
    if (info.status === 'ok') {
      row.descLen = (info.token?.description ?? '').length;
      const c = composeNarrative({
        result: { token: { chain, address: addr, symbol: info.token?.symbol, name: info.token?.name } },
        gtToken: info.token,
      });
      row.available = c.available;
      row.source = c.summarySource ?? null;
      row.claims = c.claims?.length ?? 0;
      if (chain === 'solana' && !c.available) {
        const m = await readSolanaMint(addr);
        if (m.status === 'ok') row.claims = Math.max(row.claims, 1) + 2;
      }
    }
  }

  rows.push(row);
  console.log(`${label.padEnd(10)} ${String(row.gtStatus).padEnd(13)} desc=${String(row.descLen).padStart(5)} ${row.available ? 'PROSE' : (row.claims ? 'FACTS' : 'NONE ')}`);
}

const fs = await import('node:fs');
fs.writeFileSync('E:/Hermes/data/cache/scratch/narrative-matrix.json', JSON.stringify(rows, null, 2));

console.log('\n=== AUTHORITATIVE MATRIX ===');
console.log('chains:', rows.length);
console.log('metadata source:', rows.filter((r) => r.metadataSource).length);
console.log('gt reachable:', rows.filter((r) => r.gtStatus === 'ok').length);
console.log('prose narrative:', rows.filter((r) => r.available).length);
console.log('verified facts only:', rows.filter((r) => !r.available && r.claims > 0).length);
console.log('no source:', rows.filter((r) => !r.metadataSource).length);
