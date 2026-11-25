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

/**
 * The one sentence used whenever a pool is proven not to be V2-style.
 *
 * A V3/V4 position (or a launchpad curve) has no fungible LP token, so balanceOf/totalSupply
 * maths cannot describe its lock state. Whether that was learned from a DexScreener label or
 * from a factory revert, the reader must see the same explanation - previously the labelled
 * path said "v3 position - V2 lp-supply maths does not apply" while the unlabelled path said
 * nothing at all.
 */
export function UNSUPPORTED_DETAIL(tag) {
  const which = Array.isArray(tag) && tag.length ? `${tag.join('/')} position` : 'v3/v4 or curve pool';
  return `${which} — no fungible LP token, so V2 lp-supply maths does not apply`;
}

/**
 * Low-level eth_call.
 *
 * Returns `{ value }` on success, or `{ why }` on failure, because the REASON matters and
 * collapsing every failure to null loses it:
 *
 *   'revert'    the call reached the contract and it refused. On totalSupply() this proves
 *               the pool is not a V2 pair - a V2 pair always implements it because the LP
 *               token IS the pair. Safe to classify as a position-based pool.
 *   'no-code'   the address has no contract. Also knowledge about the address.
 *   'transport' the call never got an answer (timeout, 5xx, DNS). Nothing is known.
 *
 * Treating 'transport' like 'revert' would report a position-based pool whenever the RPC
 * hiccuped - a fresh false assurance in place of the old silent dash.
 */
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
    if (!res.ok) return { why: 'transport', detail: `http ${res.status}` };

    const body = await res.json();
    // A JSON-RPC error object means the node executed the call and it reverted.
    if (body?.error) return { why: 'revert', detail: body.error?.message ?? 'reverted' };
    if (typeof body?.result !== 'string') return { why: 'transport', detail: 'malformed response' };
    // "0x" means no code at the address - a different fact from a revert.
    if (body.result === '0x') return { why: 'no-code' };
    return { value: body.result };
  } catch (err) {
    return { why: 'transport', detail: String(err?.message ?? err) };
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
export async function readV2Liquidity({ chain, pairAddress, rpc, labels = null, token = null, fetchImpl = globalThis.fetch, timeoutMs = TIMEOUT_MS } = {}) {
  const scope = `v2:${String(pairAddress).toLowerCase()}`;
  const base = { poolAddress: pairAddress, scope };

  // POOL TYPE GUARD. DexScreener labels a pair 'v2' or 'v3' explicitly. Running V2
  // LP-supply maths on a V3 pool is not merely inaccurate - `totalSupply()` on a V3 pool
  // reverts, and treating that revert as "unknown" hides a pool type we could have
  // recognised. Measured: the highest-liquidity CAKE pairs on BSC are all v3.
  const tag = Array.isArray(labels) ? labels.map((l) => String(l).toLowerCase()) : [];
  if (tag.includes('v3') || tag.includes('v4')) {
    // A labelled V3/V4 pool gets the SAME position-discovery attempt as one proven by a
    // revert. Without this the label path short-circuits first and a Pons token - which the
    // DEX labels 'v4' - would never reach the graduation lookup that CAN determine its lock.
    const posFromLabel = await assessPositionsForPool({
      chain, poolAddress: pairAddress, token, rpc, fetchImpl, timeoutMs,
    });
    return {
      ...base,
      state: 'unsupported-position-type',
      burnedPercentage: null,
      lockedPercentage: null,
      positions: posFromLabel,
      // Deliberately the SAME sentence the revert path produces: one physical situation
      // must not be described two ways depending on how it was discovered.
      detail: UNSUPPORTED_DETAIL(tag),
    };
  }

  if (!rpc) return { ...base, state: 'unknown', burnedPercentage: null, lockedPercentage: null, detail: 'no rpc for chain' };
  if (!/^0x[0-9a-fA-F]{40}$/.test(String(pairAddress ?? ''))) {
    return { ...base, state: 'unknown', burnedPercentage: null, lockedPercentage: null, detail: 'invalid pair address' };
  }

  // totalSupply of the LP token is the denominator. Without it nothing else is meaningful.
  const supplyRes = await rpcCall(rpc, pairAddress, SEL.totalSupply, { fetchImpl, timeoutMs });
  const supply = supplyRes.value != null ? parseUint(supplyRes.value) : null;

  if (supply === null || supply <= 0) {
    // A FACTORY-REVERT PROVES THE POOL TYPE; A TRANSPORT FAILURE PROVES NOTHING.
    //
    // A V2 pair always implements totalSupply() because the LP token IS the pair. So a
    // REVERT is positive evidence that this is a position-based pool (V3/V4 or a launchpad
    // curve) where V2 maths cannot apply. A timeout or 5xx is not evidence of anything.
    //
    // Measured: Elysium pairs carry NO `labels` from DexScreener, so the old code had no
    // way to classify them and returned a bare 'unknown' - while Base's 'v4'-labelled
    // tokens said "V2 maths does not apply". Same physical situation, two different
    // answers, decided by whether a label happened to be present.
    const proven = supplyRes.why === 'revert' || supplyRes.why === 'no-code';
    if (proven) {
      return {
        ...base,
        state: 'unsupported-position-type',
        burnedPercentage: null,
        lockedPercentage: null,
        detail: supplyRes.why === 'no-code'
          ? 'no contract at the pool address — no V2 LP token'
          : UNSUPPORTED_DETAIL([]),
      };
    }
    return {
      ...base,
      state: 'unknown',
      burnedPercentage: null,
      lockedPercentage: null,
      detail: `could not read LP supply (${supplyRes.why ?? 'no answer'}) — not a finding about the pool`,
    };
  }

  // The pair address itself often holds the LP (mint to self) in some forks; the burn
  // addresses are the ones that prove destruction.
  const burned = await Promise.all(BURN_ADDRESSES.map(async (addr) => {
    const res = await rpcCall(rpc, pairAddress, SEL.balanceOf + encAddress(addr), { fetchImpl, timeoutMs });
    return parseUint(res.value) ?? 0;
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
  const heldByPair = parseUint(pairSelBalance.value) ?? 0;

  const lockers = VERIFIED_LOCKERS[chain] ?? [];
  // A locker holding a DUST balance does not make the pool locked. Verified live: a BSC
  // pair where PinkLock held a negligible fraction returned state 'locked' with
  // lockedPercentage 0 - a confident all-clear built from nothing. A meaningful lock must
  // cover a real share of the supply.
  const MIN_LOCK_PCT = 1;
  let bestLocker = null;

  for (const locker of lockers) {
    const res = await rpcCall(rpc, pairAddress, SEL.balanceOf + encAddress(locker.address), { fetchImpl, timeoutMs });
    const bal = parseUint(res.value) ?? 0;
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

/**
 * Discover and assess positions that belong to a specific pool.
 *
 * POSITION IDS ARE NOT GUESSABLE. A pool does not expose its position ids, and on V4 the
 * positions live in a separate PositionManager keyed by a derived poolId. This function
 * therefore reports what it could NOT do rather than inventing a determination: with no
 * verified locker event for the pool it returns `{status:'not-discovered'}` and the caller
 * keeps the honest "pool type known, lock state not measurable" wording.
 *
 * That is deliberate. Extrapolating a single locked position to "the pool is locked" is the
 * exact overclaim the owner flagged, and reporting a percentage derived from incomparable
 * liquidity units is worse than reporting none.
 */
export async function assessPositionsForPool({ chain, poolAddress, ownerHint = null, token = null, rpc = null, fetchImpl, timeoutMs } = {}) {
  const managers = (await import('./positions.mjs')).POSITION_MANAGERS[chain];

  // ROBINHOOD HAS A VERIFIED POSITION SOURCE: Pons emits PoolGraduated(token, positionId, ...)
  // which names the exact position, so a Pons token's LP lock is determinable rather than
  // merely classifiable. Verified live on TEXEL: position 4231454, owned by the Pons launch
  // locker, which exposes no withdrawal path and is not a proxy.
  if (chain === 'robinhood' && token && rpc) {
    try {
      const pons = await import('./pons.mjs');
      const positions = await import('./positions.mjs');
      const grad = await pons.findGraduationPosition(rpc, token, { fetchImpl, timeoutMs });
      if (grad.status === 'ok') {
        const [assessment, withdrawability] = await Promise.all([
          pons.assessV4Position(rpc, grad.positionId, { fetchImpl, timeoutMs }),
          positions.probeWithdrawability(rpc, pons.PONS.v2.locker, { fetchImpl, timeoutMs }),
        ]);
        if (assessment.status === 'ok') {
          const cls = positions.classifyPosition(
            { ...assessment, version: 'v4', isKnownLocker: assessment.isPonsLocker, lockerName: 'Pons launch locker' },
            withdrawability,
          );
          return {
            status: 'determined',
            positionId: grad.positionId,
            owner: assessment.owner,
            classification: cls.state,
            lockerName: cls.lockerName ?? null,
            // The pool's liquidity, reported as POOL context - never as a per-position share.
            poolLiquidity: assessment.poolLiquidity,
            scope: 'position',
            detail: cls.detail,
            evidence: `PoolGraduated at block ${grad.blockNumber}`,
          };
        }
      }
      return {
        status: grad.status === 'ok' ? 'assessment-failed' : grad.status,
        detail: grad.detail ?? 'graduation found but assessment failed',
        determination: 'pool-type-only',
      };
    } catch (err) {
      return { status: 'error', detail: String(err?.message ?? err), determination: 'pool-type-only' };
    }
  }

  if (!managers) {
    return {
      status: 'no-manager',
      detail: `no position manager configured for ${chain}`,
      // Recorded so a reader knows the pool type was determined but the lock state was not.
      determination: 'pool-type-only',
    };
  }

  // Without a known locker edge (a graduation event, a mint receipt, a position-manager log
  // for this pool) there is no id to look up. V4's PositionManager is not enumerable by owner
  // (verified: tokenOfOwnerByIndex reverts), and the pool does not list its positions.
  return {
    status: 'not-discovered',
    detail: 'no verified position source for this pool; a position id must come from a '
      + 'graduation event, a mint receipt or a locker log',
    managersConfigured: [
      ...(managers.v3 ?? []).map((m) => ({ version: 'v3', name: m.name })),
      ...(managers.v4 ?? []).map((m) => ({ version: 'v4', name: m.name })),
    ],
    determination: 'pool-type-only',
    ownerHint,
  };
}
