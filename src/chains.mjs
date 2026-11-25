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

import { GLYPHS } from './icons.mjs';

/** Address shapes. `evm` covers every 0x…40-hex chain. */
export const ADDRESS_KIND = {
  solana: /^[1-9A-HJ-NP-Za-km-z]{32,44}$/,
  evm: /^0x[0-9a-fA-F]{40}$/,
};

/**
 * Per-chain glyphs, derived from the shared registry.
 *
 * These were hand-maintained literals in this file, and they silently drifted from
 * `src/icons.mjs`: the token card read THIS table while /chains read the registry, so BNB showed
 * its branded mark in one place and a generic yellow circle in the other. Deriving them leaves
 * exactly one place to change a chain's icon.
 *
 * The value stays a plain glyph string, not `<tg-emoji>` markup, so `getChain(id).emoji` remains
 * usable wherever a caller just needs the character. Renderers that want the animated asset
 * resolve it by chain id through the registry.
 */
export const CHAIN_EMOJI = {
  solana: GLYPHS['chain.solana'],
  ethereum: GLYPHS['chain.ethereum'],
  bsc: GLYPHS['chain.bsc'],
  base: GLYPHS['chain.base'],
  arbitrum: GLYPHS['chain.arbitrum'],
  optimism: GLYPHS['chain.optimism'],
  polygon: GLYPHS['chain.polygon'],
  avalanche: GLYPHS['chain.avalanche'],
  robinhood: GLYPHS['chain.robinhood'],
  hyperevm: GLYPHS['chain.hyperevm'],
  elysium: GLYPHS['chain.elysium'],
  monad: GLYPHS['chain.monad'],
  unichain: GLYPHS['chain.unichain'],
  berachain: GLYPHS['chain.berachain'],
  megaeth: GLYPHS['chain.megaeth'],
  abstract: GLYPHS['chain.abstract'],
  story: GLYPHS['chain.story'],
};

/**
 * Chain definitions.
 * `ds` is the DexScreener slug; `goplusId` is GoPlus's EVM chain id.
 */
export const CHAINS = {
  solana: {
    id: 'solana', name: 'Solana', short: 'SOL', kind: 'solana', ds: 'solana',
    market: true, goplus: 'solana', goplusId: null, dexPaid: true, emoji: CHAIN_EMOJI.solana,
  },
  ethereum: {
    id: 'ethereum', name: 'Ethereum', short: 'ETH', kind: 'evm', ds: 'ethereum',
    market: true, goplus: 'evm', goplusId: '1', dexPaid: true, emoji: CHAIN_EMOJI.ethereum,
    // Verified live: eth_chainId answered on this endpoint.
    rpc: 'https://ethereum-rpc.publicnode.com', chainId: 1,
  },
  bsc: {
    id: 'bsc', name: 'BNB Chain', short: 'BSC', kind: 'evm', ds: 'bsc',
    market: true, goplus: 'evm', goplusId: '56', dexPaid: true, emoji: CHAIN_EMOJI.bsc,
    // Verified live: eth_chainId answered on this endpoint.
    rpc: 'https://bsc-dataseed.binance.org', chainId: 56,
  },
  base: {
    id: 'base', name: 'Base', short: 'BASE', kind: 'evm', ds: 'base',
    market: true, goplus: 'evm', goplusId: '8453', dexPaid: true, emoji: CHAIN_EMOJI.base,
    // Verified live: eth_chainId answered on this endpoint.
    rpc: 'https://mainnet.base.org', chainId: 8453,
  },
  arbitrum: {
    id: 'arbitrum', name: 'Arbitrum', short: 'ARB', kind: 'evm', ds: 'arbitrum',
    market: true, goplus: 'evm', goplusId: '42161', dexPaid: false, emoji: CHAIN_EMOJI.arbitrum,
  },
  optimism: {
    id: 'optimism', name: 'Optimism', short: 'OP', kind: 'evm', ds: 'optimism',
    market: true, goplus: 'evm', goplusId: '10', dexPaid: true, emoji: CHAIN_EMOJI.optimism,
  },
  polygon: {
    id: 'polygon', name: 'Polygon', short: 'POL', kind: 'evm', ds: 'polygon',
    market: true, goplus: 'evm', goplusId: '137', dexPaid: false, emoji: CHAIN_EMOJI.polygon,
  },
  avalanche: {
    id: 'avalanche', name: 'Avalanche', short: 'AVAX', kind: 'evm', ds: 'avalanche',
    market: true, goplus: 'evm', goplusId: '43114', dexPaid: false, emoji: CHAIN_EMOJI.avalanche,
  },
  hyperevm: {
    id: 'hyperevm', name: 'HyperEVM', short: 'HYPE', kind: 'evm', ds: 'hyperevm',
    market: true, goplus: null, goplusId: null, dexPaid: false, emoji: CHAIN_EMOJI.hyperevm,
    // Verified live: eth_chainId returns 0x3e7 (999) and eth_call works against WHYPE.
    rpc: 'https://rpc.hyperliquid.xyz/evm', chainId: 999,
  },
  monad: {
    id: 'monad', name: 'Monad', short: 'MON', kind: 'evm', ds: 'monad',
    // GoPlus id verified live (GET /api/v1/supported_chains).
    market: true, goplus: 'evm', goplusId: '143', dexPaid: false, emoji: CHAIN_EMOJI.monad,
  },
  robinhood: {
    id: 'robinhood', name: 'Robinhood Chain', short: 'RH', kind: 'evm', ds: 'robinhood',
    market: true, goplus: 'evm', goplusId: '4663', dexPaid: true, emoji: CHAIN_EMOJI.robinhood,
    // Verified live: eth_chainId answered on this endpoint.
    rpc: 'https://rpc.mainnet.chain.robinhood.com', chainId: 4663,
  },
  unichain: {
    id: 'unichain', name: 'Unichain', short: 'UNI', kind: 'evm', ds: 'unichain',
    market: true, goplus: 'evm', goplusId: '130', dexPaid: false, emoji: CHAIN_EMOJI.unichain,
  },
  berachain: {
    id: 'berachain', name: 'Berachain', short: 'BERA', kind: 'evm', ds: 'berachain',
    market: true, goplus: 'evm', goplusId: '80094', dexPaid: true, emoji: CHAIN_EMOJI.berachain,
  },
  abstract: {
    id: 'abstract', name: 'Abstract', short: 'ABS', kind: 'evm', ds: 'abstract',
    market: true, goplus: 'evm', goplusId: '2741', dexPaid: false, emoji: CHAIN_EMOJI.abstract,
  },
  megaeth: {
    id: 'megaeth', name: 'MegaETH', short: 'MEGA', kind: 'evm', ds: 'megaeth',
    market: true, goplus: null, goplusId: null, dexPaid: false, emoji: CHAIN_EMOJI.megaeth,
  },
  // Elysium mainnet. Added in Round 4 as a PRIORITY chain.
  //   goplus : NOT supported - verified against GET /api/v1/supported_chains (46 chains,
  //            no 99901 and no 'elysium' entry).
  //   market : GeckoTerminal DOES index it (`elysium` network, real pools observed:
  //            AGI/HYPE, USDC/WHYPE). DexScreener gave no pairs for the sampled tokens,
  //            so gt is the market source.
  //   rpc    : https://elysium.drpc.org answered eth_chainId with 0x1863d (99901).
  elysium: {
    id: 'elysium', name: 'Elysium', short: 'ELYS', kind: 'evm', ds: 'elysium',
    market: true, goplus: null, goplusId: null, dexPaid: false, emoji: CHAIN_EMOJI.elysium,
    rpc: 'https://elysium.drpc.org', chainId: 99901,
  },
  story: {
    // Probed with STORY/IP/WIP/IPX/Story Protocol/SPG and token feeds: DexScreener
    // returned ZERO pairs for this chain. Scanning is unsupported, not "not found".
    id: 'story', name: 'Story', short: 'IP', kind: 'evm', ds: 'story',
    market: false, goplus: null, goplusId: null, dexPaid: false, emoji: CHAIN_EMOJI.story,
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
  elys: 'elysium', elysium: 'elysium', ely: 'elysium',
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
/**
 * Optional adapters that provide coverage GoPlus does not.
 *
 * Elysium (chain id 99901) is not a GoPlus chain, but Round 5 added a dedicated Elyscan holder
 * adapter that is wired into risk-intel and returns real holder counts and Top-10 percentages.
 * Deriving capability from GoPlus alone reported it as "market only", which is a false
 * STATEMENT ABOUT THIS BOT rather than about the token — the same class of error as claiming
 * coverage that does not exist, only inverted.
 *
 * Each flag here must name a verified, wired adapter. Nothing is listed on the strength of a
 * provider's documentation.
 */
const DEDICATED_ADAPTERS = {
  // src/security/elysium.mjs — readElysiumHolders + mergeElysiumHolders, called from
  // risk-intel.mjs. Returns holder count and Top-10 share; tax and LP are NOT provided.
  elysium: { holders: true },
};

export function capabilitySummary() {
  return ALL_CHAIN_IDS.map((id) => {
    const c = CHAINS[id];
    const extra = DEDICATED_ADAPTERS[id] ?? {};
    // Holders come from GoPlus OR a dedicated adapter; the other fields genuinely rely on GoPlus.
    const holders = Boolean(c.goplus) || Boolean(extra.holders);
    return {
      id,
      name: c.name,
      market: c.market,
      holders,
      tax: c.goplus === 'evm',
      lpLock: Boolean(c.goplus),
      dev: Boolean(c.goplus),
      dexPaid: c.dexPaid,
      // Reported so the /chains line can be honest about a partial adapter instead of implying
      // full GoPlus-parity coverage.
      partialHoldersOnly: Boolean(extra.holders) && !c.goplus,
    };
  });
}
