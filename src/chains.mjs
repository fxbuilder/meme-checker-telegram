/**
 * src/chains.mjs
 * Chain registry — single source of truth for what each chain can honestly show.
 *
 * EVERY capability flag here was verified by a live probe on 2026-11-23, not
 * taken from documentation. Re-verify before changing a flag.
 *
 *   market   — DexScreener `token-pairs/v1/{slug}/{address}` returned a real pair
 *   goplus   — GoPlus returns token_security data for this chain
 *   dexPaid  — DexScreener `orders/v1/{slug}/{address}` is demonstrably indexed,
 *              i.e. a non-empty orders/boosts array was observed for at least one
 *              token on that chain. Only where this is true may the card say
 *              "Not Paid" — everywhere else must say "Unknown", because an empty
 *              orders response is indistinguishable from an unindexed chain
 *              (verified: an invalid slug also returns 200 + empty arrays).
 *
 * A capability set to false renders an explicit unsupported/unavailable state.
 * It is never faked, defaulted to zero, or filled from another chain.
 */

/** Address shapes. `evm` covers every 0x…40-hex chain. */
export const ADDRESS_KIND = {
  solana: /^[1-9A-HJ-NP-Za-km-z]{32,44}$/,
  evm: /^0x[0-9a-fA-F]{40}$/,
};

/**
 * Chain definitions.
 * `ds` is the DexScreener slug; `goplusId` is GoPlus's EVM chain id.
 */
export const CHAINS = {
  solana: {
    id: 'solana', name: 'Solana', short: 'SOL', kind: 'solana', ds: 'solana',
    market: true, goplus: 'solana', goplusId: null, dexPaid: true, emoji: '🟣',
  },
  ethereum: {
    id: 'ethereum', name: 'Ethereum', short: 'ETH', kind: 'evm', ds: 'ethereum',
    market: true, goplus: 'evm', goplusId: '1', dexPaid: true, emoji: '🔷',
  },
  bsc: {
    id: 'bsc', name: 'BNB Chain', short: 'BSC', kind: 'evm', ds: 'bsc',
    market: true, goplus: 'evm', goplusId: '56', dexPaid: true, emoji: '🟡',
  },
  base: {
    id: 'base', name: 'Base', short: 'BASE', kind: 'evm', ds: 'base',
    market: true, goplus: 'evm', goplusId: '8453', dexPaid: true, emoji: '🔵',
  },
  arbitrum: {
    id: 'arbitrum', name: 'Arbitrum', short: 'ARB', kind: 'evm', ds: 'arbitrum',
    market: true, goplus: 'evm', goplusId: '42161', dexPaid: false, emoji: '🔵',
  },
  optimism: {
    id: 'optimism', name: 'Optimism', short: 'OP', kind: 'evm', ds: 'optimism',
    market: true, goplus: 'evm', goplusId: '10', dexPaid: true, emoji: '🔴',
  },
  polygon: {
    id: 'polygon', name: 'Polygon', short: 'POL', kind: 'evm', ds: 'polygon',
    market: true, goplus: 'evm', goplusId: '137', dexPaid: false, emoji: '🟣',
  },
  avalanche: {
    id: 'avalanche', name: 'Avalanche', short: 'AVAX', kind: 'evm', ds: 'avalanche',
    market: true, goplus: 'evm', goplusId: '43114', dexPaid: false, emoji: '🔺',
  },
  hyperevm: {
    id: 'hyperevm', name: 'HyperEVM', short: 'HYPE', kind: 'evm', ds: 'hyperevm',
    market: true, goplus: null, goplusId: null, dexPaid: false, emoji: '🟢',
  },
  monad: {
    id: 'monad', name: 'Monad', short: 'MON', kind: 'evm', ds: 'monad',
    // GoPlus id verified live (GET /api/v1/supported_chains).
    market: true, goplus: 'evm', goplusId: '143', dexPaid: false, emoji: '🟪',
  },
  robinhood: {
    id: 'robinhood', name: 'Robinhood Chain', short: 'RH', kind: 'evm', ds: 'robinhood',
    market: true, goplus: 'evm', goplusId: '4663', dexPaid: true, emoji: '🟩',
  },
  unichain: {
    id: 'unichain', name: 'Unichain', short: 'UNI', kind: 'evm', ds: 'unichain',
    market: true, goplus: 'evm', goplusId: '130', dexPaid: false, emoji: '🦄',
  },
  berachain: {
    id: 'berachain', name: 'Berachain', short: 'BERA', kind: 'evm', ds: 'berachain',
    market: true, goplus: 'evm', goplusId: '80094', dexPaid: true, emoji: '🐻',
  },
  abstract: {
    id: 'abstract', name: 'Abstract', short: 'ABS', kind: 'evm', ds: 'abstract',
    market: true, goplus: 'evm', goplusId: '2741', dexPaid: false, emoji: '⬜',
  },
  megaeth: {
    id: 'megaeth', name: 'MegaETH', short: 'MEGA', kind: 'evm', ds: 'megaeth',
    market: true, goplus: null, goplusId: null, dexPaid: false, emoji: '⚡',
  },
  story: {
    // Probed with STORY/IP/WIP/IPX/Story Protocol/SPG and token feeds: DexScreener
    // returned ZERO pairs for this chain. Scanning is unsupported, not "not found".
    id: 'story', name: 'Story', short: 'IP', kind: 'evm', ds: 'story',
    market: false, goplus: null, goplusId: null, dexPaid: false, emoji: '📖',
  },
};

/** Chains we recognise for input, including ones with no data coverage. */
export const ALL_CHAIN_IDS = Object.keys(CHAINS);

/** Chains that can actually return market data. */
export const SCANNABLE_CHAINS = ALL_CHAIN_IDS.filter((id) => CHAINS[id].market);

/** Chains whose address space is unambiguous on its own (only Solana). */
export function chainsForKind(kind) {
  return ALL_CHAIN_IDS.filter((id) => CHAINS[id].kind === kind);
}

export function getChain(id) {
  if (typeof id !== 'string') return null;
  return CHAINS[id.toLowerCase()] ?? null;
}

/** Accepts "bsc", "BNB Chain", "bsc chain", "binance" → chain id. */
const ALIASES = {
  sol: 'solana', solana: 'solana',
  eth: 'ethereum', ethereum: 'ethereum', mainnet: 'ethereum',
  bsc: 'bsc', bnb: 'bsc', binance: 'bsc', bnbchain: 'bsc',
  base: 'base',
  arb: 'arbitrum', arbitrum: 'arbitrum',
  op: 'optimism', optimism: 'optimism',
  poly: 'polygon', polygon: 'polygon', matic: 'polygon',
  avax: 'avalanche', avalanche: 'avalanche',
  hype: 'hyperevm', hyperevm: 'hyperevm', hyper: 'hyperevm',
  monad: 'monad', mon: 'monad',
  robinhood: 'robinhood', rh: 'robinhood',
  unichain: 'unichain', uni: 'unichain',
  berachain: 'berachain', bera: 'berachain',
  abstract: 'abstract',
  story: 'story',
  megaeth: 'megaeth', mega: 'megaeth',
};

export function resolveChainAlias(token) {
  if (typeof token !== 'string') return null;
  const clean = token.trim().toLowerCase().replace(/[\s_-]+/g, '');
  return ALIASES[clean] ?? null;
}

/** Which address kind does this string look like? null if neither. */
export function detectKind(address) {
  if (typeof address !== 'string') return null;
  if (ADDRESS_KIND.solana.test(address)) return 'solana';
  if (ADDRESS_KIND.evm.test(address)) return 'evm';
  return null;
}

/** Human label for a chain id, falling back to the raw id. */
export function chainLabel(id) {
  return CHAINS[id]?.name ?? (id ? String(id) : 'Unknown');
}

/** Capability summary for docs and /chains output. */
export function capabilitySummary() {
  return ALL_CHAIN_IDS.map((id) => {
    const c = CHAINS[id];
    return {
      id,
      name: c.name,
      market: c.market,
      holders: Boolean(c.goplus),
      tax: c.goplus === 'evm',
      lpLock: Boolean(c.goplus),
      dev: Boolean(c.goplus),
      dexPaid: c.dexPaid,
    };
  });
}
