/**
 * Full capability matrix, 16 chains, paced + retried. Live read-only.
 */
import { gtNetwork, gtGate, fetchTokenInfo } from './src/research/geckoterminal.mjs';
import { readSolanaMint, mintFacts } from './src/research/onchain-metadata.mjs';
import { composeNarrative } from './src/research/narrative-pipeline.mjs';

gtGate.minIntervalMs = 7000; // extra room for a clean sweep

const CHAINS = [
  ['solana', 'Solana'], ['ethereum', 'Ethereum'], ['bsc', 'BNB Chain'], ['base', 'Base'],
  ['arbitrum', 'Arbitrum'], ['optimism', 'Optimism'], ['polygon', 'Polygon'],
  ['avalanche', 'Avalanche'], ['hyperevm', 'HyperEVM'], ['monad', 'Monad'],
  ['robinhood', 'Robinhood'], ['unichain', 'Unichain'], ['berachain', 'Berachain'],
  ['abstract', 'Abstract'], ['megaeth', 'MegaETH'], ['story', 'Story'],
];

const rows = [];

async function topToken(net) {
  const res = await fetch(`https://api.geckoterminal.com/api/v2/networks/${net}/pools?page=1`, {
    headers: { accept: 'application/json' },
  });
  if (!res.ok) return { status: res.status };
  const j = await res.json();
  const rel = j?.data?.[0]?.relationships?.base_token?.data?.id;
  if (!rel) return { status: 'no-pool' };
  return { status: 200, address: String(rel).slice(String(rel).indexOf('_') + 1) };
}

for (const [chain, label] of CHAINS) {
  const net = gtNetwork(chain);
  const row = {
    chain, label, metadataSource: Boolean(net), network: net,
    address: null, gtStatus: null, descLen: 0, available: false,
    source: null, claims: 0, summary: null,
  };

  if (!net) {
    rows.push(row);
    console.log(`${label.padEnd(10)} ✗ no metadata source`);
    continue;
  }

  await gtGate.wait();
  const t = await topToken(net);
  if (t.status !== 200) {
    row.gtStatus = `pools:${t.status}`;
    rows.push(row);
    console.log(`${label.padEnd(10)} pools=${t.status}`);
    continue;
  }
  row.address = t.address;

  const info = await fetchTokenInfo(chain, t.address, {});
  row.gtStatus = info.status;

  if (info.status === 'ok') {
    row.descLen = (info.token?.description ?? '').length;
    const composed = composeNarrative({
      result: { token: { chain, address: t.address, symbol: info.token?.symbol, name: info.token?.name } },
      gtToken: info.token,
    });
    row.available = composed.available;
    row.source = composed.summarySource ?? null;
    row.claims = composed.claims?.length ?? 0;
    row.summary = (composed.summary ?? '').replace(/\s+/g, ' ').slice(0, 90) || null;

    if (chain === 'solana' && !composed.available) {
      const m = await readSolanaMint(t.address);
      if (m.status === 'ok') row.claims = mintFacts(m.mint).length;
    }
  }

  rows.push(row);
  console.log(`${label.padEnd(10)} gt=${String(row.gtStatus).padEnd(11)} desc=${String(row.descLen).padStart(5)} avail=${String(row.available).padEnd(5)} claims=${row.claims} src=${row.source ?? '-'}`);
}

console.log('\n=== MATRIX SUMMARY ===');
console.log('registered chains:            ', rows.length);
console.log('with a metadata source:       ', rows.filter((r) => r.metadataSource).length);
console.log('GT returned ok:               ', rows.filter((r) => r.gtStatus === 'ok').length);
console.log('GT returned a description:    ', rows.filter((r) => r.descLen > 0).length);
console.log('narrative composed:           ', rows.filter((r) => r.available).length);
console.log('verified-facts-only (no prose):', rows.filter((r) => !r.available && r.claims > 0).length);

const fs = await import('node:fs');
fs.writeFileSync('E:/Hermes/data/cache/scratch/narrative-matrix.json', JSON.stringify(rows, null, 2));
console.log('\nwritten: narrative-matrix.json');
