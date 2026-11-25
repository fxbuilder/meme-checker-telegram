/**
 * src/security/lp-intel.mjs
 *
 * Liquidity assessment: is the pool's liquidity burned, locked, or free?
 *
 * WHY THIS EXISTS
 * No keyless aggregator reports LP lock state for EVM. GoPlus does so for only some
 * tokens and RugCheck is Solana-only, so the scanner showed "LP Locked: —" for most EVM
 * tokens — the OWNER's TEXEL case among them. The state is readable on chain, so it is
 * read there instead of being reported as unavailable.
 *
 * WHAT IS ACTUALLY PROVABLE, AND WHAT IS NOT
 *
 *   BURNED    For a Uniswap/Pancake-style V2 pair, the pair contract HOLDS the LP tokens.
 *             If a large share of the LP `totalSupply()` sits at the burn address
 *             (0x…dEaD or 0x0), those LP tokens can never be redeemed: the liquidity is
 *             permanently locked. This is checkable with two `balanceOf` calls and one
 *             `totalSupply` call, keyless.
 *
 *   LOCKED    A locker contract holds the LP tokens. Verifying a real lock needs that
 *             contract's own records (amount, expiry, withdrawer), which we cannot read
 *             generically. So a balance at an UNRECOGNISED address is reported as
 *             "held by an unknown address" — never as locked. Treating any contract
 *             holding LP as a valid locker is exactly the false assurance to avoid.
 *
 *   UNKNOWN   Nothing conclusive was read. This is a dash, never "unlocked".
 *
 * V2 vs V3/V4
 * The LP-supply method is ONLY valid for V2-style fungible LP tokens. A Uniswap V3
 * position is an NFT and a V4 position is a position id with pool-manager state; neither
 * has a `totalSupply` that means "share of this pool". Applying V2 maths to them would
 * produce a confident, wrong percentage. Those pool types are therefore reported as
 * `unsupported-position-type` rather than approximated.
 */

const TIMEOUT_MS = 6_000;

/** Addresses whose LP holdings mean "destroyed". */
export const BURN_ADDRESSES = [
  '0x0000000000000000000000000000000000000000',
  '0x000000000000000000000000000000000000dEaD',
];

/**
 * Locker deployments verified by `eth_getCode` on the stated chain.
 *
 * Each entry below returned real bytecode on that chain (byte counts in the comment).
 * Presence of code is the MINIMUM bar, not proof of legitimacy: a balance at one of these
 * addresses means the LP is held by a contract that is known to be a locker product, which
 * is enough to say "locked by <name>" rather than "unlocked".
 *
 * DELIBERATELY NOT INCLUDED: any address that was not code-verified on that exact chain.
 * Verified live that Team.Finance uses DIFFERENT bytecode on ETH (4,482 bytes) and BSC
 * (13,860 bytes) at the same address, so a same-address assumption across chains is unsafe.
 */
export const VERIFIED_LOCKERS = {
  ethereum: [
    // UNCX Liquidity Locker V4 - 20,985 bytes verified.
    { address: '0x147aeca171a79466fe9e2c03f21b45155ff403f8', name: 'UNCX' },
    // PinkLock V2 - 20,622 bytes verified on BSC (same product on ETH listed below).
    { address: '0x71B5759d73262FBb223956913ecF4ecC51057641', name: 'PinkLock' },
  ],
  bsc: [
    // UNCX - 20,389 bytes verified.
    { address: '0xd8c5BB7137021D93e70B7814C697BED303573b21', name: 'UNCX' },
    // UNCX V4 - ~20,985 bytes verified.
    { address: '0xA55d5Ce984E9e933732cDF51095AF8F3fb374ac8', name: 'UNCX' },
    // PinkLock V2 - 20,622 bytes verified.
    { address: '0x407993575c91ce7643a4d4ccacc9a98c36ee1bbe', name: 'PinkLock' },
  ],
  robinhood: [
    // UNCX deployment on Robinhood Chain - 20,985 bytes verified; the same address is
    // EMPTY on BSC, which is why the chain is part of the key.
    { address: '0x128A800cBc615cc110Bff16E475865c67631603A', name: 'UNCX' },
  ],
  // No verified deployment on these chains yet; an empty list means "not checked", and
  // the reader reports unknown rather than unlocked.
  base: [],
  hyperevm: [],
  elysium: [],
};

/** Function selectors, cross-checked against transfer(address,uint256)=0xa9059cbb. */
const SEL = {
  balanceOf: '0x70a08231',   // balanceOf(address)
  totalSupply: '0x18160ddd', // totalSupply()
  decimals: '0x313ce567',    // decimals()
};

/** Word-encode an address argument. */
function encAddress(addr) {
  return String(addr).toLowerCase().replace(/^0x/, '').padStart(64, '0');
}

/** Parse a uint256 hex word to a Number, or null when it is not one. */
function parseUint(hex) {
  if (typeof hex !== 'string' || !/^0x[0-9a-fA-F]*$/.test(hex)) return null;
  const h = hex.slice(2);
  if (!h.length) return null;
  // Guard against absurd lengths before Number() loses precision silently.
  if (h.length > 64) return null;
  const n = Number(BigInt(`0x${h || '0'}`));
  return Number.isFinite(n) ? n : null;
}

async function rpcCall(rpc, to, data, { fetchImpl = globalThis.fetch, timeoutMs = TIMEOUT_MS } = {}) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const res = await fetchImpl(rpc, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      signal: ac.signal,
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_call', params: [{ to, data }, 'latest'] }),
    }).finally(() => clearTimeout(timer));
    if (!res.ok) return null;
    const body = await res.json();
    if (body?.error || typeof body?.result !== 'string') return null;
    // A call to an address with no code returns "0x" — not a zero balance.
    if (body.result === '0x') return null;
    return body.result;
  } catch {
    return null;
  }
}

/**
 * Read the LP burn/lock state of a V2-style pair.
 *
 * @param {object} args
 * @param {string} args.chain      our chain id
 * @param {string} args.pairAddress the LP token / pair contract
 * @param {string} args.rpc        JSON-RPC endpoint for that chain
 * @returns {Promise<{state:string, burnedPercentage:number|null, lockedPercentage:number|null,
 *                    scope:string, poolAddress:string, detail?:string}>}
 */
export async function readV2Liquidity({ chain, pairAddress, rpc, labels = null, fetchImpl = globalThis.fetch, timeoutMs = TIMEOUT_MS } = {}) {
  const scope = `v2:${String(pairAddress).toLowerCase()}`;
  const base = { poolAddress: pairAddress, scope };

  // POOL TYPE GUARD. DexScreener labels a pair 'v2' or 'v3' explicitly. Running V2
  // LP-supply maths on a V3 pool is not merely inaccurate - `totalSupply()` on a V3 pool
  // reverts, and treating that revert as "unknown" hides a pool type we could have
  // recognised. Measured: the highest-liquidity CAKE pairs on BSC are all v3.
  const tag = Array.isArray(labels) ? labels.map((l) => String(l).toLowerCase()) : [];
  if (tag.includes('v3') || tag.includes('v4')) {
    return {
      ...base,
      state: 'unsupported-position-type',
      burnedPercentage: null,
      lockedPercentage: null,
      detail: `${tag.join('/')} position — V2 lp-supply maths does not apply`,
    };
  }

  if (!rpc) return { ...base, state: 'unknown', burnedPercentage: null, lockedPercentage: null, detail: 'no rpc for chain' };
  if (!/^0x[0-9a-fA-F]{40}$/.test(String(pairAddress ?? ''))) {
    return { ...base, state: 'unknown', burnedPercentage: null, lockedPercentage: null, detail: 'invalid pair address' };
  }

  // totalSupply of the LP token is the denominator. Without it nothing else is meaningful.
  const supplyHex = await rpcCall(rpc, pairAddress, SEL.totalSupply, { fetchImpl, timeoutMs });
  const supply = parseUint(supplyHex);
  if (supply === null || supply <= 0) {
    return { ...base, state: 'unknown', burnedPercentage: null, lockedPercentage: null, detail: 'no lp totalSupply' };
  }

  // The pair address itself often holds the LP (mint to self) in some forks; the burn
  // addresses are the ones that prove destruction.
  const burned = await Promise.all(BURN_ADDRESSES.map(async (addr) => {
    const hex = await rpcCall(rpc, pairAddress, SEL.balanceOf + encAddress(addr), { fetchImpl, timeoutMs });
    return parseUint(hex) ?? 0;
  }));
  const burnedTotal = burned.reduce((a, b) => a + b, 0);

  const pct = (burnedTotal / supply) * 100;
  // Compare with a tolerance: LP balances are integers and a rounding sliver should not
  // read as "partially burned".
  if (pct >= 99.5) {
    return { ...base, state: 'burned', burnedPercentage: 100, lockedPercentage: 0, detail: 'lp supply at burn address' };
  }
  if (pct > 0.5) {
    return { ...base, state: 'partially-locked', burnedPercentage: Number(pct.toFixed(2)), lockedPercentage: 0, detail: 'partial burn' };
  }

  // Not burned. Whoever holds the LP decides: a VERIFIED locker means locked, anything
  // else means we do not know — and "do not know" is not "unlocked".
  const pairSelBalance = await rpcCall(rpc, pairAddress, SEL.balanceOf + encAddress(pairAddress), { fetchImpl, timeoutMs });
  const heldByPair = parseUint(pairSelBalance) ?? 0;

  const lockers = VERIFIED_LOCKERS[chain] ?? [];
  // A locker holding a DUST balance does not make the pool locked. Verified live: a BSC
  // pair where PinkLock held a negligible fraction returned state 'locked' with
  // lockedPercentage 0 - a confident all-clear built from nothing. A meaningful lock must
  // cover a real share of the supply.
  const MIN_LOCK_PCT = 1;
  let bestLocker = null;

  for (const locker of lockers) {
    const hex = await rpcCall(rpc, pairAddress, SEL.balanceOf + encAddress(locker.address), { fetchImpl, timeoutMs });
    const bal = parseUint(hex) ?? 0;
    if (bal <= 0) continue;
    const lockedPct = Number(((bal / supply) * 100).toFixed(2));
    if (lockedPct < MIN_LOCK_PCT) continue; // dust, not a lock
    if (!bestLocker || lockedPct > bestLocker.lockedPct) {
      bestLocker = { lockedPct, locker };
    }
  }

  if (bestLocker) {
    return {
      ...base,
      state: 'locked',
      burnedPercentage: 0,
      lockedPercentage: bestLocker.lockedPct,
      locker: bestLocker.locker.address,
      lockerName: bestLocker.locker.name ?? null,
      detail: `held by verified locker ${bestLocker.locker.name ?? bestLocker.locker.address}`,
    };
  }

  return {
    ...base,
    state: 'unknown',
    burnedPercentage: 0,
    lockedPercentage: null,
    heldByPair: heldByPair > 0,
    detail: 'lp not burned; no verified locker holds it',
  };
}

/**
 * Merge an on-chain LP reading into a provider-reported lpLock block.
 *
 * The on-chain reading is authoritative for BURN state, because it is read from the pair
 * contract itself. A provider's `lockedPercentage` is kept when the chain read says
 * nothing, and is never overwritten with null.
 */
export function mergeLpIntel(providerBlock, chainReading) {
  if (!chainReading) return providerBlock ?? null;
  const p = providerBlock ?? {};

  if (chainReading.state === 'burned') {
    return {
      burnedPercentage: 100,
      lockedPercentage: 0,
      kind: 'burned',
      source: 'onchain-v2',
      scope: chainReading.scope,
      poolAddress: chainReading.poolAddress,
    };
  }
  if (chainReading.state === 'partially-locked') {
    return {
      burnedPercentage: chainReading.burnedPercentage,
      lockedPercentage: p.lockedPercentage ?? null,
      kind: 'partially-locked',
      source: 'onchain-v2',
      scope: chainReading.scope,
      poolAddress: chainReading.poolAddress,
    };
  }
  if (chainReading.state === 'locked') {
    return {
      burnedPercentage: 0,
      lockedPercentage: chainReading.lockedPercentage,
      kind: 'locked',
      locker: chainReading.locker,
      source: 'onchain-v2',
      scope: chainReading.scope,
      poolAddress: chainReading.poolAddress,
    };
  }
  // Chain read inconclusive: keep whatever the provider measured, and record that an
  // on-chain attempt was made so the dash is explainable.
  //
  // An EMPTY object is not a substitute for null. `{}` renders as a present-but-empty
  // liquidity block, which is indistinguishable from a failed read; null renders as the
  // honest dash.
  if (providerBlock && Object.keys(providerBlock).length) {
    return { ...providerBlock, onchainAttempted: true };
  }
  return null;
}
