/**
 * Position-based LP intelligence for Uniswap V3 and V4 (and PancakeSwap V3, which uses the
 * same V3 position interface).
 *
 * WHY "V3/V4" IS NOT AN ANSWER: the previous implementation stopped at identifying the pool
 * type and rendered an ambiguous dash. That is real information, but it does not tell a
 * reader whether the liquidity can be pulled - which is the actual question.
 *
 * THE STRUCTURAL DIFFERENCE THAT DRIVES EVERYTHING HERE:
 *
 *   V3  liquidity lives ON the position. `positions(tokenId)` returns it directly, so one
 *       call plus `ownerOf` fully answers "who holds it and how much".
 *   V4  liquidity lives in the PoolManager, keyed by poolId. `positions()` reverts on a V4
 *       PositionManager; you must read the PoolKey via `getPoolAndPositionInfo`, hash it to
 *       get the poolId, and ask StateView. Verified live: positions() reverts on Pons's V4
 *       PositionManager on Robinhood while getPoolAndPositionInfo works.
 *
 * WHAT THIS MODULE REFUSES TO DO:
 *
 *   - It never divides a position's liquidity by the pool's total and calls the result a
 *     "locked percentage". Liquidity units are only comparable within a tick range, and a
 *     full-range position's `L` is not a share of anything. A single position is reported as
 *     a POSITION-LEVEL fact, with the pool's own liquidity alongside it as context.
 *   - It never infers "permanently locked" from graduation. Ownership by a known locker plus
 *     the absence of a withdrawal function is evidence; graduation alone is not.
 *   - A revert, no-code and a timeout are kept apart. Only the first two say anything about
 *     contract shape.
 */
import { selectorOf, keccak256 } from './keccak.mjs';

const TIMEOUT_MS = 12_000;

/**
 * Per-chain position managers. Addresses are the canonical deployments and are only used
 * after `eth_getCode` confirms bytecode exists at that address ON THAT CHAIN - the same
 * address on another chain is a different contract.
 */
export const POSITION_MANAGERS = {
  ethereum: {
    v3: [{ name: 'uniswap-v3', address: '0xC36442b4a4522E871399CD717aBDD847Ab11FE88', fee: 'standard' }],
    v4: [{ name: 'uniswap-v4', address: '0x429ba70129df741B2Ca2a85BC3A2a337BfE72b5e', stateView: '0x7fFE42C4a5DeEAc017B14F65A713423DcE18A6C7' }],
  },
  base: {
    v3: [{ name: 'uniswap-v3', address: '0x03a520b32C04BF3bEEf7BEb72E919cf822Ed34f1', fee: 'standard' }],
    v4: [{ name: 'uniswap-v4', address: '0x7C5f5A4bBd8fD63184577525326123B519429bDc', stateView: '0xA3c0c9b65baD0b08107Aa264b0f3dB444b867A71' }],
  },
  bsc: {
    // PancakeSwap V3 uses the same V3 position interface.
    v3: [{ name: 'pancakeswap-v3', address: '0x46A15B0b27311cedF172AB29E4f4766fbE7F4364', fee: 'pancake' }],
  },
  robinhood: {
    v4: [{
      name: 'pons-uniswap-v4',
      address: '0x58daec3116aae6D93017bAAea7749052E8a04fA7',
      stateView: '0xF3334192D15450CdD385c8B70e03f9A6bD9E673b',
      poolManager: '0x8366a39CC670B4001A1121B8F6A443A643e40951',
    }],
  },
};

/** Lockers whose ownership implies a lock, per chain. Populated only from code-verified deployments. */
export const KNOWN_LOCKERS = {
  ethereum: [
    { name: 'UNCX V4', address: '0x147aeca171a79466fe9e2c03f21b45155ff403f8' },
    { name: 'PinkLock', address: '0x71B5759d73262FBb223956913ecF4ecC51057641' },
  ],
  bsc: [
    { name: 'UNCX', address: '0xd8c5BB7137021D93e70B7814C697BED303573b21' },
    { name: 'UNCX V4', address: '0xA55d5Ce984E9e933732cDF51095AF8F3FC374ac8' },
    { name: 'PinkLock', address: '0x407993575c91ce7643a4d4ccacc9a98c36ee1bbe' },
  ],
  robinhood: [
    { name: 'Pons launch locker', address: '0x267444D099b10fB5Ed7c3Cc7B7c767AdcA574952' },
    { name: 'UNCX', address: '0x128A800cBc615cc110Bff16E475865c67631603A' },
  ],
};

export const RPC_WHY = { REVERT: 'revert', NO_CODE: 'no-code', TRANSPORT: 'transport' };

export async function ethCall(rpc, to, data, { fetchImpl = globalThis.fetch, timeoutMs = TIMEOUT_MS } = {}) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const res = await fetchImpl(rpc, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      signal: ac.signal,
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_call', params: [{ to, data }, 'latest'] }),
    }).finally(() => clearTimeout(timer));
    if (!res.ok) return { why: RPC_WHY.TRANSPORT, detail: `http ${res.status}` };
    const body = await res.json();
    if (body?.error) return { why: RPC_WHY.REVERT, detail: body.error?.message ?? 'reverted' };
    if (typeof body?.result !== 'string') return { why: RPC_WHY.TRANSPORT, detail: 'malformed' };
    if (body.result === '0x') return { why: RPC_WHY.NO_CODE };
    return { value: body.result };
  } catch (err) {
    return { why: RPC_WHY.TRANSPORT, detail: String(err?.message ?? err) };
  }
}

const pad32 = (hex) => String(hex).replace(/^0x/, '').toLowerCase().padStart(64, '0');
const addr = (w) => '0x' + String(w).slice(-40).toLowerCase();
const words = (hex) => {
  const h = String(hex).replace(/^0x/, '');
  const out = [];
  for (let i = 0; i + 64 <= h.length; i += 64) out.push(h.slice(i, i + 64));
  return out;
};
const toBig = (w) => BigInt('0x' + String(w ?? '0').replace(/^0x/i, ''));

// ---------------------------------------------------------------------------
// Position reads
// ---------------------------------------------------------------------------

/**
 * Best-effort detection of which position interface a manager implements.
 *
 * Probing `ownerOf` is safe because every position manager is an ERC-721. `positions()` is
 * the V3 discriminator: it reverts on a V4 manager (verified), so a revert PROVES the V3
 * ABI is wrong rather than proving the position does not exist.
 */
export async function detectPositionKind(rpc, manager, positionId, { fetchImpl, timeoutMs } = {}) {
  const v3 = await ethCall(rpc, manager, selectorOf('positions(uint256)') + pad32('0x' + BigInt(positionId).toString(16)), { fetchImpl, timeoutMs });
  if (v3.value) return { kind: 'v3', sample: v3.value };
  if (v3.why === RPC_WHY.REVERT) {
    // A revert here is evidence of the V4 ABI, so confirm the V4 entry point answers.
    const v4 = await ethCall(rpc, manager, selectorOf('getPoolAndPositionInfo(uint256)') + pad32('0x' + BigInt(positionId).toString(16)), { fetchImpl, timeoutMs });
    if (v4.value) return { kind: 'v4', sample: v4.value };
    if (v4.why === RPC_WHY.TRANSPORT) return { kind: 'unknown', detail: 'transport during v4 probe' };
    return { kind: 'unknown', detail: 'neither V3 nor V4 position ABI answered' };
  }
  if (v3.why === RPC_WHY.TRANSPORT) return { kind: 'unknown', detail: 'transport' };
  return { kind: 'unknown', detail: v3.why };
}

/**
 * Assess a V3 position: owner, pair, fee tier, tick range and liquidity.
 *
 * Liquidity is reported as an ABSOLUTE position figure. It is deliberately not converted to a
 * percentage of the pool: `L` is only meaningful within a tick range, and dividing one
 * position's `L` by the pool's total `L` would produce a number that looks like a share and
 * is not one.
 */
export async function assessV3Position(rpc, manager, positionId, { fetchImpl, timeoutMs, chain } = {}) {
  const id = pad32('0x' + BigInt(positionId).toString(16));
  const [ownerRes, posRes] = await Promise.all([
    ethCall(rpc, manager, selectorOf('ownerOf(uint256)') + id, { fetchImpl, timeoutMs }),
    ethCall(rpc, manager, selectorOf('positions(uint256)') + id, { fetchImpl, timeoutMs }),
  ]);

  if (!ownerRes.value) return { status: 'error', detail: `ownerOf: ${ownerRes.why ?? 'no answer'}`, why: ownerRes.why };
  if (!posRes.value) return { status: 'error', detail: `positions: ${posRes.why ?? 'no answer'}`, why: posRes.why };

  const w = words(posRes.value);
  if (w.length < 12) return { status: 'error', detail: 'short positions() response' };

  const owner = addr(ownerRes.value);
  const locker = (KNOWN_LOCKERS[chain] ?? []).find((l) => l.address.toLowerCase() === owner);
  const liquidity = toBig(w[7]);
  const tokensOwed0 = toBig(w[10]);
  const tokensOwed1 = toBig(w[11]);

  return {
    status: 'ok',
    version: 'v3',
    positionId: BigInt(positionId).toString(),
    owner,
    lockerName: locker?.name ?? null,
    isKnownLocker: Boolean(locker),
    fee: Number(toBig(w[4])),
    tickLower: Number(BigInt.asIntN(24, toBig(w[5]))),
    tickUpper: Number(BigInt.asIntN(24, toBig(w[6]))),
    liquidity: liquidity.toString(),
    // A position with zero liquidity but non-zero owed tokens has been closed while the fees
    // remain claimable - different from an active position.
    hasActiveLiquidity: liquidity > 0n,
    tokensOwed: { token0: tokensOwed0.toString(), token1: tokensOwed1.toString() },
    // Reported as a position-level fact, NOT a share of the pool.
    scope: 'position',
  };
}

/**
 * Assess a V4 position: owner, PoolKey, derived poolId and the POOL's liquidity.
 *
 * The pool liquidity is context for the position, not a locked percentage - see the module
 * note. `positionLiquidity` is null for V4 because the position does not store it; only the
 * pool does.
 */
export async function assessV4PositionLp(rpc, manager, positionId, { fetchImpl, timeoutMs, chain, stateView } = {}) {
  const id = pad32('0x' + BigInt(positionId).toString(16));
  const [ownerRes, infoRes] = await Promise.all([
    ethCall(rpc, manager, selectorOf('ownerOf(uint256)') + id, { fetchImpl, timeoutMs }),
    ethCall(rpc, manager, selectorOf('getPoolAndPositionInfo(uint256)') + id, { fetchImpl, timeoutMs }),
  ]);

  if (!ownerRes.value) return { status: 'error', detail: `ownerOf: ${ownerRes.why ?? 'no answer'}`, why: ownerRes.why };
  if (!infoRes.value) return { status: 'error', detail: `getPoolAndPositionInfo: ${infoRes.why ?? 'no answer'}`, why: infoRes.why };

  const w = words(infoRes.value);
  if (w.length < 5) return { status: 'error', detail: 'short PoolKey response' };

  const poolKeyWords = w.slice(0, 5);
  const poolId = '0x' + keccak256(Buffer.from(poolKeyWords.join(''), 'hex')).toString('hex');
  const owner = addr(ownerRes.value);
  const locker = (KNOWN_LOCKERS[chain] ?? []).find((l) => l.address.toLowerCase() === owner);

  let poolLiquidity = null;
  let liquidityStatus = 'no-state-view';
  if (stateView) {
    const lq = await ethCall(rpc, stateView, selectorOf('getLiquidity(bytes32)') + poolId.slice(2), { fetchImpl, timeoutMs });
    if (lq.value) { poolLiquidity = toBig(lq.value).toString(); liquidityStatus = 'measured'; }
    else liquidityStatus = lq.why ?? 'unknown';
  }

  return {
    status: 'ok',
    version: 'v4',
    positionId: BigInt(positionId).toString(),
    owner,
    lockerName: locker?.name ?? null,
    isKnownLocker: Boolean(locker),
    pool: {
      poolId,
      currency0: addr(poolKeyWords[0]),
      currency1: addr(poolKeyWords[1]),
      fee: Number(toBig(poolKeyWords[2])),
      tickSpacing: Number(toBig(poolKeyWords[3])),
      hooks: addr(poolKeyWords[4]),
    },
    // V4 stores no per-position liquidity, so this is honestly null rather than copied from
    // the pool and mislabelled.
    positionLiquidity: null,
    poolLiquidity,
    liquidityStatus,
    scope: 'pool',
  };
}

/**
 * Can the owning contract release this position?
 *
 * Absence of the obvious withdrawal entry points is evidence, not proof: a contract may
 * expose a differently named escape hatch, or be upgradeable. So the result says
 * `noStandardWithdrawal` rather than "permanently locked", and `permanent` is only claimed
 * when the caller also knows the owner is a non-upgradeable locker.
 */
export async function probeWithdrawability(rpc, ownerContract, { fetchImpl, timeoutMs } = {}) {
  const probes = [
    ['unlock()', selectorOf('unlock()')],
    ['withdraw(uint256)', selectorOf('withdraw(uint256)')],
    ['release(uint256)', selectorOf('release(uint256)')],
    ['transferFrom(address,address,uint256)', selectorOf('transferFrom(address,address,uint256)')],
  ];

  const found = [];
  for (const [name, sel] of probes) {
    // A selector with no arguments still needs a call; transferFrom needs args, so it is
    // probed only to see whether the function EXISTS, and a revert is expected either way.
    const r = await ethCall(rpc, ownerContract, sel + (name.startsWith('transferFrom') ? pad32('0') + pad32('0') + pad32('0') : ''), { fetchImpl, timeoutMs });
    if (r.value !== undefined) found.push(name);
  }

  // Upgradeability is read from EIP-1967 STORAGE, never from a probe of upgradeTo().
  //
  // A revert on upgradeTo() proves NOTHING: a non-upgradeable contract and a proxy that
  // simply does not expose that function look identical. Treating the revert as evidence made
  // the Pons locker report `looksUpgradeable: true` while also reporting no withdrawal path,
  // which would have blocked every "permanently locked" claim on a locker that is in fact a
  // plain immutable contract. Verified: the EIP-1967 slot is zero for the Pons locker and
  // non-zero for the genuinely upgradeable Pons V1 proxy factory.
  const UPGRADEABLE_SLOT = '0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc';
  const impl = await ethGetStorage(rpc, ownerContract, UPGRADEABLE_SLOT, { fetchImpl, timeoutMs });
  const implementation = impl.value && impl.value !== '0x' + '0'.repeat(64)
    ? '0x' + impl.value.slice(-40)
    : null;

  return {
    // Wording matters: this does not say "permanently locked".
    noStandardWithdrawal: found.length === 0,
    callableFunctions: found,
    looksUpgradeable: implementation !== null,
    implementation,
    // A probe that could not read storage is not evidence either way.
    upgradeabilityKnown: impl.value !== undefined,
  };
}

async function ethGetStorage(rpc, address, slot, { fetchImpl = globalThis.fetch, timeoutMs = TIMEOUT_MS } = {}) {
  try {
    const res = await fetchImpl(rpc, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_getStorageAt', params: [address, slot, 'latest'] }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) return { why: RPC_WHY.TRANSPORT, detail: `http ${res.status}` };
    const body = await res.json();
    if (body?.error) return { why: RPC_WHY.REVERT, detail: body.error?.message ?? 'error' };
    return { value: body?.result };
  } catch (err) {
    return { why: RPC_WHY.TRANSPORT, detail: String(err?.message ?? err) };
  }
}

/**
 * Classify what we can actually claim about a position.
 *
 * The five states are deliberately distinct, because collapsing them loses the only thing a
 * reader wants to know.
 */
export function classifyPosition(assessment, withdrawability = null) {
  if (!assessment || assessment.status !== 'ok') {
    return { state: 'unknown', detail: assessment?.detail ?? 'not assessed' };
  }

  const activeLiquidity = assessment.version === 'v3'
    ? assessment.hasActiveLiquidity
    : assessment.poolLiquidity != null && assessment.poolLiquidity !== '0';

  if (assessment.isKnownLocker) {
    // Ownership by a known locker is a LOCK. "Permanent" additionally needs the owner to have
    // no release path; without that probe the honest word is "locked".
    // "Permanent" needs THREE things: a known locker owns it, nothing standard can move it,
    // and the owner cannot be swapped out from under it. Any one missing downgrades the claim
    // to plain "locked".
    const permanent = withdrawability?.noStandardWithdrawal === true
      && withdrawability?.upgradeabilityKnown === true
      && withdrawability?.looksUpgradeable === false;
    return {
      state: permanent ? 'permanently-locked' : 'locked',
      lockerName: assessment.lockerName,
      // Never extrapolated to the pool: this is about ONE position.
      scope: 'position',
      detail: permanent
        ? `${assessment.lockerName} holds it and exposes no standard withdrawal`
        : `${assessment.lockerName} holds it`,
    };
  }

  if (!activeLiquidity) {
    return { state: 'staked-or-inactive', scope: 'position', detail: 'no active liquidity in this position' };
  }
  return {
    state: 'withdrawable',
    scope: 'position',
    detail: `held by ${assessment.owner}, not a recognised locker`,
  };
}

/**
 * Is the owner contract a token-locker by shape rather than by allowlist entry?
 *
 * Used to widen coverage beyond the addresses already verified, while keeping the claim
 * honest: "unrecognised but looks like a locker" is reported as `unknown`, never as locked.
 */
export function lockerEvidence(withdrawability) {
  if (!withdrawability) return 'not probed';
  if (withdrawability.noStandardWithdrawal) return 'no standard withdrawal path';
  return `exposes ${withdrawability.callableFunctions.join(', ')}`;
}
