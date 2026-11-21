import {pathToFileURL} from 'node:url';

// Synthetic fixtures based on the illustrative payload in brief §7.3.
const fixtures = {
  solana: {
    chain: 'solana', address: 'FiXtUrE111111111111111111111111111111111111',
    token: {name: 'Mock Solana Token', symbol: 'MOCKSOL', logo: null},
    market: {price_usd: 0.000123, market_cap_usd: 1250000, fdv_usd: 1500000, liquidity_usd: 85400, volume_24h_usd: 320000, price_change_24h: 18.5},
    holders: {total: 2450, top10_percentage: 24.6, largest_holder_percentage: 5.2},
    narrative: {summary: 'Synthetic example only.', source: 'project_metadata'},
    project: {website: null, x: null, telegram: null},
    updated_at: '2026-11-21T00:00:00Z',
  },
  bsc: {
    chain: 'bsc', address: '0xabcdef0123456789abcdef0123456789abcdef01',
    token: {name: 'Mock BNB Chain Token', symbol: 'MOCKBNB', logo: null},
    market: {price_usd: 0.0002, market_cap_usd: null, fdv_usd: 1500000, volume_24h_usd: 0},
    holders: null, narrative: null, project: null,
    updated_at: '2026-11-21T00:00:00Z',
  },
};

function addressKey(chain, address) {
  if (typeof address !== 'string') return null;
  // This is an identity/URL guard, not proof that an address is a token.
  if (chain === 'solana' && /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(address)) return address;
  if (chain === 'bsc' && /^0x[0-9a-f]{40}$/i.test(address)) return address.toLowerCase();
  return null;
}

const metric = value => Number.isFinite(value) ? value : null;
const outcome = status => ({mode: 'mock', status});

export function normalizeMock(request, payload) {
  const chain = request?.chain;
  const address = addressKey(chain, request?.address);
  const data = payload?.data;
  if (!address || payload?.success !== true || data?.chain !== chain ||
      addressKey(chain, data.address) !== address ||
      typeof data.token?.name !== 'string' || !data.token.name.trim() ||
      typeof data.token?.symbol !== 'string' || !data.token.symbol.trim()) {
    return outcome('invalid-response');
  }
  return {
    ...outcome('ok'),
    token: {chain, address, name: data.token.name, symbol: data.token.symbol},
    market: {
      priceUsd: metric(data.market?.price_usd),
      marketCapUsd: metric(data.market?.market_cap_usd),
      fdvUsd: metric(data.market?.fdv_usd),
      liquidityUsd: metric(data.market?.liquidity_usd),
      volume24hUsd: metric(data.market?.volume_24h_usd),
      priceChange24h: metric(data.market?.price_change_24h),
    },
    holders: {
      total: metric(data.holders?.total),
      top10Percentage: metric(data.holders?.top10_percentage),
      largestHolderPercentage: metric(data.holders?.largest_holder_percentage),
    },
    narrative: null,
    project: {website: null, x: null, telegram: null},
    updatedAt: typeof data.updated_at === 'string' && Number.isFinite(Date.parse(data.updated_at)) ? data.updated_at : null,
    fullAnalysisUrl: `https://meme-checker.example/check/${chain}/${encodeURIComponent(address)}`,
  };
}

export async function mockScan(request) {
  const address = addressKey(request?.chain, request?.address);
  const fixture = address && fixtures[request.chain];
  if (!fixture || address !== fixture.address) return outcome('not-found');
  return normalizeMock(request, {success: true, data: fixture});
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const chain = process.argv[2];
  if (chain !== 'solana' && chain !== 'bsc') {
    console.error('Usage: node src/mock-scan.mjs solana|bsc');
    process.exitCode = 2;
  } else {
    console.log(JSON.stringify(await mockScan(fixtures[chain]), null, 2));
  }
}
