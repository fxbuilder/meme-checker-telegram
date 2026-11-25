/**
 * Pons launchpad intelligence on Robinhood Chain (4663).
 *
 * Pons has TWO GENERATIONS OF CONTRACTS THAT ARE DIFFERENT PROTOCOLS, not versions of one:
 *
 *   V1  no bonding curve. Each token gets its own Uniswap V3 pool at launch.
 *   V2  bonding curve per token, graduating into a Uniswap V4 pool behind a Pons hook.
 *
 * Their events have different signatures and different topic0 values, so a V1 token queried
 * against the V2 factory returns fifteen zero words from getLaunchedToken() rather than
 * reverting - it is simply not a member. Treating that zero record as an answer is what made
 * PONS itself appear to be "still on a bonding curve" after it had long graduated.
 *
 * Everything below is derived from documented signatures whose topic0 hashes were
 * reproduced by our own Keccak implementation before use, and every read was verified
 * against live chain state.
 */
import { selectorOf, topicOf } from './keccak.mjs';

const TIMEOUT_MS = 12_000;

/** Documented Pons + Uniswap V4 contracts on Robinhood Chain. */
export const PONS = {
  chainId: 4663,
  v2: {
    factory: '0x7eD598BcEf8bd9Edd8C97A195C6d13f40801EC7e',
    locker: '0x267444D099b10fB5Ed7c3Cc7B7c767AdcA574952',
    hook: '0xE5e702641Ea86F4ae6cC3cDaeD2B886f976Be044',
    graduationExecutor: '0xC7819B64A1dAECD7eC19856d026cb14EfBd89046',
    feeEscrow: '0xd3AFEB2a57f70eF218Aa82451c51B2fb0416Ac9e',
    buybackVault: '0x42df2a798f82289E177311362e8f5ccC45c1219c',
    // Archived stacks: launches are OFF but their tokens still trade. A token from one of
    // these is not a V3-generation launch and must not be reported as "not a Pons token".
    archived: '0x7E1EAbd52Ae29598e6483F72dCf1a70b14284dB8',
    legacy: '0xD3C2280f23d813BE8F9A6B5452753efFF7799fd7',
    migrations: [
      '0x050e5C224466e2d377a7E555E139D51268239b39',
      '0xF72c4Be7C8D3071537436c37ee8f84E9F61227d1',
      '0x22E9504714C7cdFb464863D3c7Df61b27B05ef79',
    ],
  },
  v1: {
    proxyFactory: '0xF4fC0CD27fC8EcF17E55eE4c3f7201897dF3eb75',
    proxyLocker: '0x10F2756e373bAb14999fdC9177587D51D30a1Cf5',
    factory: '0xA5aAb3F0c6EeadF30Ef1D3Eb997108E976351feB',
    locker: '0x736D76699C26D0d966744cAe304C000d471f7F35',
    // This one launched PONS itself.
    legacyFactory: '0x0c37a24F5D23A486FA692d1500881d698B1F77a4',
    legacyLocker: '0x31ca5E101941A93A7DD6d0497928700625CF54B5',
  },
  uniswapV4: {
    poolManager: '0x8366a39CC670B4001A1121B8F6A443A643e40951',
    positionManager: '0x58daec3116aae6D93017bAAea7749052E8a04fA7',
    stateView: '0xF3334192D15450CdD385c8B70e03f9A6bD9E673b',
  },
};

/** All known Pons lockers, so a position owner can be recognised as "a Pons locker". */
export const PONS_LOCKERS = [
  PONS.v2.locker,
  PONS.v1.locker,
  PONS.v1.proxyLocker,
  PONS.v1.legacyLocker,
].map((a) => a.toLowerCase());

/** Documented event signatures. Topic0 verified against published hashes. */
export const EVENTS = {
  // V2 factory
  poolGraduated: 'PoolGraduated(address,uint256,uint256,uint256)',
  graduationTokensPermanentlyLocked: 'GraduationTokensPermanentlyLocked(address,uint256)',
  launchSwept: 'LaunchSwept(address,uint256,uint256,uint256)',
  // V1 factory - DIFFERENT signature from V2
  v1TokenLaunched: 'TokenLaunched(address,address,address,address,address,uint256,uint256,uint256,uint256,uint256)',
  v1TokenDeployed: 'TokenDeployed(address,address,address,address,uint256,uint256)',
};

/** Extract the phase of a Pons launch, from the documented getLaunchedToken record. */
export const PHASES = { 0: 'curve-created', 1: 'curve-trading', 2: 'pool-created' };

// ---------------------------------------------------------------------------
// JSON-RPC with a reason, not a bare null
// ---------------------------------------------------------------------------

export const RPC_WHY = { REVERT: 'revert', NO_CODE: 'no-code', TRANSPORT: 'transport' };

/**
 * eth_call that reports WHY it failed.
 *
 * A revert here is meaningful evidence (a V4 position has no `positions()` entry, a factory
 * does not know a token); a timeout is evidence of nothing. Collapsing them would let a
 * network hiccup become a claim about a contract.
 */
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
    // A JSON-RPC error means the node EXECUTED the call and it reverted.
    if (body?.error) return { why: RPC_WHY.REVERT, detail: body.error?.message ?? 'reverted' };
    if (typeof body?.result !== 'string') return { why: RPC_WHY.TRANSPORT, detail: 'malformed' };
    if (body.result === '0x') return { why: RPC_WHY.NO_CODE };
    return { value: body.result };
  } catch (err) {
    return { why: RPC_WHY.TRANSPORT, detail: String(err?.message ?? err) };
  }
}

async function rpcCall(rpc, method, params, { fetchImpl = globalThis.fetch, timeoutMs = TIMEOUT_MS } = {}) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const res = await fetchImpl(rpc, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      signal: ac.signal,
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    }).finally(() => clearTimeout(timer));
    if (!res.ok) return { why: RPC_WHY.TRANSPORT, detail: `http ${res.status}` };
    const body = await res.json();
    if (body?.error) return { why: RPC_WHY.REVERT, detail: body.error?.message ?? 'error' };
    return { value: body?.result };
  } catch (err) {
    return { why: RPC_WHY.TRANSPORT, detail: String(err?.message ?? err) };
  }
}

const pad32 = (hex) => String(hex).replace(/^0x/, '').toLowerCase().padStart(64, '0');
const addrFromWord = (w) => '0x' + String(w).slice(-40).toLowerCase();
const words = (hex) => {
  const h = String(hex).replace(/^0x/, '');
  const out = [];
  for (let i = 0; i + 64 <= h.length; i += 64) out.push(h.slice(i, i + 64));
  return out;
};
// Accepts a bare hex word OR a 0x-prefixed value. Passing a whole eth_call result here
// produced '0x0x...' and threw - the two shapes are not interchangeable.
const toBig = (w) => {
  const h = String(w ?? '0').replace(/^0x/i, '');
  return BigInt('0x' + (h || '0'));
};

// ---------------------------------------------------------------------------
// Launch record: which generation, and what phase
// ---------------------------------------------------------------------------

/**
 * Resolve which Pons generation a token belongs to, and its launch phase.
 *
 * `launchFactory()` on the token is the AUTHORITATIVE answer, and it is a single eth_call.
 * This replaced an event-log search that was both slow and silently WRONG: eth_getLogs from
 * block 0 fails on this provider ("query spans N blocks but only 1000 allowed"), and because
 * that error was being treated as "no matching logs", PONS came back as `not-pons` even
 * though it is a real launch. A capped log query is an OUTAGE, never a negative finding.
 *
 * Verified live:
 *   TEXEL, AI -> 0x7eD598Bc... (V2 factory), phase 2 = pool-created
 *   PONS      -> 0x0c37a24F... (legacy V1 factory) - its own docs say this factory launched it
 *   a non-Pons token -> empty return, i.e. the function does not exist
 */
export async function resolveLaunch(rpc, token, { fetchImpl, timeoutMs } = {}) {
  const tokenArg = pad32(token);

  // ---- Authoritative: launchFactory() tells us the generation in one call.
  const lf = await ethCall(rpc, token, selectorOf('launchFactory()'), { fetchImpl, timeoutMs });
  let factory = null;
  if (lf.value) {
    const hex = String(lf.value).replace(/^0x/, '');
    // A 32-byte word with a non-zero low 20 bytes is a real address; empty means the
    // function does not exist on this token (verified against a BSC token).
    if (hex.length >= 40 && !/^0+$/.test(hex.slice(-40))) factory = '0x' + hex.slice(-40).toLowerCase();
  } else if (lf.why === RPC_WHY.TRANSPORT) {
    // An outage says nothing about whether this is a Pons token.
    return { status: 'error', generation: null, detail: lf.detail ?? 'rpc transport' };
  }

  const V2_FACTORIES = [PONS.v2.factory, PONS.v2.archived, PONS.v2.legacy, ...PONS.v2.migrations,
    ...PONS.v2.additionalFactories ?? []].map((a) => a.toLowerCase());
  const V1_FACTORIES = [PONS.v1.factory, PONS.v1.legacyFactory, PONS.v1.proxyFactory].map((a) => a.toLowerCase());

  if (factory && V2_FACTORIES.includes(factory)) {
    // Read the launch record for the PHASE. Word 10 holds it (verified: adjacent words 7 and
    // 8 are the documented poolFee 200 and tickSpacing 185, which confirms the alignment).
    const rec = await ethCall(rpc, PONS.v2.factory, selectorOf('getLaunchedToken(address)') + tokenArg, { fetchImpl, timeoutMs });
    if (!rec.value) {
      // The factory answered launchFactory() but not the record: report the generation with
      // an unknown phase rather than inventing one.
      return { status: 'ok', generation: 'v2', factory, phase: null, phaseName: 'unknown', graduated: null, evidence: 'launchFactory() only' };
    }
    const w = words(rec.value);
    if (w.length < 11 || addrFromWord(w[0]) !== token.toLowerCase()) {
      // A zero-filled record is what an unknown token returns instead of reverting, so the
      // echo is the only safe discriminator between that and a legitimate phase 0.
      return { status: 'ok', generation: 'v2', factory, phase: null, phaseName: 'unknown', graduated: null, evidence: 'record did not echo token' };
    }
    const phase = Number(toBig(w[10]));
    return {
      status: 'ok',
      generation: 'v2',
      factory,
      phase,
      phaseName: PHASES[phase] ?? `phase-${phase}`,
      graduated: phase >= 2,
      curve: w.length > 1 ? addrFromWord(w[1]) : null,
      evidence: 'launchFactory() + launch record',
    };
  }

  if (factory && V1_FACTORIES.includes(factory)) {
    // V1 has NO bonding curve: every token trades in its own Uniswap V3 pool from launch.
    return {
      status: 'ok',
      generation: factory === PONS.v1.legacyFactory.toLowerCase() ? 'v1-legacy'
        : factory === PONS.v1.proxyFactory.toLowerCase() ? 'v1-proxy' : 'v1',
      factory,
      phase: 2,
      phaseName: 'v3-pool',
      graduated: true,
      curve: null,
      evidence: 'launchFactory()',
    };
  }

  if (factory) {
    // A factory we do not recognise: report it rather than calling it "not Pons", because an
    // unlisted newer generation is a coverage gap, not evidence of non-membership.
    return {
      status: 'unknown-generation',
      generation: null,
      factory,
      phase: null,
      phaseName: 'unknown',
      graduated: null,
      evidence: 'launchFactory() returned an unlisted factory',
    };
  }

  return { status: 'not-pons', generation: null, detail: lf.why ?? 'no launchFactory() function' };
}

// ---------------------------------------------------------------------------
// Graduation position: the actual liquidity lock
// ---------------------------------------------------------------------------

/**
 * Find the graduated pool position for a token.
 *
 * PoolGraduated(token indexed, positionId, tokenAmount, pairTokenAmount) names the token as
 * topic1, so a token-filtered getLogs finds it. The difficulty is the SEARCH WINDOW:
 *
 *   - the provider rejects any query spanning more than ~50,000 blocks, and a from-0 query
 *     fails outright ("only 1000 allowed" on some paths). An error like that is an outage,
 *     never a negative finding - treating it as "no logs" is what made PONS appear absent.
 *   - graduations are old. TEXEL's sits 13.5M blocks back, so a recent-window search finds
 *     nothing even though the token is definitively graduated.
 *
 * So the search pages backwards in bounded windows with a hard query budget, and reports
 * whether it STOPPED EARLY. A budget-exhausted search is `incomplete`, never `no-graduation`
 * - the difference between "this token never graduated" and "we stopped looking".
 */
export const PONS_SCAN = {
  // MEASURED on the Robinhood public RPC: a 5,000,000-block span answers in ~300ms, a
  // 10,000,000-block span is rejected outright. An earlier 45,000-block figure was a
  // misreading of an error produced only by a from-block-0 query.
  windowBlocks: 5_000_000,
  // Contiguous windows, NOT strided. A strided search steps over blocks, so it can skip the
  // very graduation it is looking for - it spent 110 queries and 32s failing to find a
  // graduation that a single contiguous query would have returned.
  maxQueries: 30,         // 30 x 5M = 150M blocks, more than the chain has
  // Tokens are permanent once found, so a resolved position is cached by the caller.
};

export async function findGraduationPosition(rpc, token, {
  fetchImpl, timeoutMs, windowBlocks = PONS_SCAN.windowBlocks, maxQueries = PONS_SCAN.maxQueries,
  queriesUsed = 0,
} = {}) {
  const tokenTopic = `0x${pad32(token)}`;
  const head = await rpcCall(rpc, 'eth_blockNumber', [], { fetchImpl, timeoutMs });
  if (!head.value) return { status: 'error', detail: head.detail ?? 'no head' };
  const latest = Number(BigInt(head.value));

  let queries = queriesUsed;
  let cursor = latest;
  let transportError = null;

  // Contiguous paging backwards: each window ENDS where the previous one began, so no block
  // is skipped. Counting down with a full-width span is what makes the search exhaustive
  // rather than sampled.
  while (cursor > 0 && queries < maxQueries) {
    const from = Math.max(0, cursor - windowBlocks);
    const logs = await rpcCall(rpc, 'eth_getLogs', [{
      address: PONS.v2.factory,
      topics: [topicOf(EVENTS.poolGraduated), tokenTopic],
      fromBlock: '0x' + from.toString(16),
      toBlock: '0x' + cursor.toString(16),
    }], { fetchImpl, timeoutMs });
    queries += 1;

    if (logs.why) {
      // A range error here is a limit of the provider, not evidence about the token. Narrow
      // the window and retry rather than recording a finding.
      transportError = logs.detail ?? logs.why;
      if (windowBlocks > 100_000) {
        // Fall back to a safer width for the remaining windows.
        return findGraduationPosition(rpc, token, {
          fetchImpl, timeoutMs, windowBlocks: 100_000, maxQueries, queriesUsed: queries,
        });
      }
      cursor = from;
      continue;
    }

    if (logs.value?.length) {
      const entry = logs.value[logs.value.length - 1];
      const w = words(entry.data);
      return {
        status: 'ok',
        positionId: toBig(w[0]).toString(),
        tokenAmount: toBig(w[1]).toString(),
        pairTokenAmount: toBig(w[2]).toString(),
        blockNumber: Number(BigInt(entry.blockNumber)),
        txHash: entry.transactionHash,
        queries,
      };
    }
    cursor = from;
  }

  // A search that hit provider errors cannot claim the token never graduated, even if the
  // windows happened to reach genesis - because those windows may have been the ones that
  // failed. "We stopped looking" and "it is not there" are different findings.
  const exhausted = cursor > 0;
  const unreliable = Boolean(transportError);
  return {
    status: exhausted || unreliable ? 'incomplete' : 'no-graduation',
    queries,
    scannedToBlock: Math.max(0, cursor),
    detail: unreliable
      ? `provider refused ${queries} window(s) (${transportError}); cannot conclude this token has no graduation`
      : exhausted
        ? `budget of ${maxQueries} queries spent reaching block ${Math.max(0, cursor)}; graduation may be older`
        : 'paged to genesis without a PoolGraduated log for this token',
    lastError: transportError,
  };
}

/**
 * Assess a V4 position: who owns it, which pool it belongs to, and how much liquidity that
 * pool actually holds.
 *
 * V4 does NOT store liquidity on the position - `positions()` reverts - so the liquidity is
 * read from the PoolManager/StateView for the pool the position names. The poolId is derived
 * from the PoolKey returned by getPoolAndPositionInfo, which is the only correct way to bind
 * a position to a pool.
 */
export async function assessV4Position(rpc, positionId, { fetchImpl, timeoutMs } = {}) {
  const id = pad32('0x' + BigInt(positionId).toString(16));

  const owner = await ethCall(rpc, PONS.uniswapV4.positionManager, selectorOf('ownerOf(uint256)') + id, { fetchImpl, timeoutMs });
  if (!owner.value) return { status: 'error', detail: `ownerOf: ${owner.why ?? 'no answer'}` };
  const ownerAddress = addrFromWord(owner.value);

  const info = await ethCall(rpc, PONS.uniswapV4.positionManager, selectorOf('getPoolAndPositionInfo(uint256)') + id, { fetchImpl, timeoutMs });
  if (!info.value) return { status: 'error', detail: `getPoolAndPositionInfo: ${info.why ?? 'no answer'}` };

  const w = words(info.value);
  if (w.length < 5) return { status: 'error', detail: 'short PoolKey response' };

  // PoolKey = (currency0, currency1, fee, tickSpacing, hooks). Those five words ARE the
  // ABI encoding of the struct, so hashing them yields the poolId.
  const poolKeyWords = w.slice(0, 5);
  const { keccak256 } = await import('./keccak.mjs');
  const poolId = '0x' + keccak256(Buffer.from(poolKeyWords.join(''), 'hex')).toString('hex');

  const currency0 = addrFromWord(poolKeyWords[0]);
  const currency1 = addrFromWord(poolKeyWords[1]);
  const fee = Number(toBig(poolKeyWords[2]));
  const tickSpacing = Number(toBig(poolKeyWords[3]));
  const hooks = addrFromWord(poolKeyWords[4]);

  const liquidity = await ethCall(rpc, PONS.uniswapV4.stateView, selectorOf('getLiquidity(bytes32)') + poolId.slice(2), { fetchImpl, timeoutMs });

  const isPonsLocker = PONS_LOCKERS.includes(ownerAddress);
  return {
    status: 'ok',
    positionId: BigInt(positionId).toString(),
    owner: ownerAddress,
    isPonsLocker,
    locker: isPonsLocker ? ownerAddress : null,
    pool: { poolId, currency0, currency1, fee, tickSpacing, hooks },
    // Only call it a Pons pool when the hook is Pons's own, rather than assuming it.
    hookIsPons: hooks.toLowerCase() === PONS.v2.hook.toLowerCase(),
    poolLiquidity: liquidity.value ? BigInt(liquidity.value).toString() : null,
    liquidityStatus: liquidity.value ? 'measured' : (liquidity.why ?? 'unknown'),
  };
}

/**
 * How much TOKEN SUPPLY the locker holds.
 *
 * This is deliberately separate from pool liquidity. Pons locks 4/49 of supply AS TOKENS at
 * graduation (measured 8.1633% on a real launch, matching 4/49 exactly) and separately holds
 * the pool's LP position. Reporting either as "LP locked" conflates two guarantees.
 */
export async function readLockedSupply(rpc, token, locker = PONS.v2.locker, { fetchImpl, timeoutMs } = {}) {
  const [bal, supply] = await Promise.all([
    ethCall(rpc, token, selectorOf('balanceOf(address)') + pad32(locker), { fetchImpl, timeoutMs }),
    ethCall(rpc, token, selectorOf('totalSupply()'), { fetchImpl, timeoutMs }),
  ]);
  if (!bal.value || !supply.value) {
    // A transport failure is an outage; a revert means the token does not implement the
    // function. Those are different findings and must not share a status.
    const why = bal.why ?? supply.why;
    return { status: why === RPC_WHY.TRANSPORT ? 'error' : 'unavailable', detail: why };
  }
  const held = toBig(bal.value);
  const total = toBig(supply.value);
  if (total === 0n) return { status: 'unavailable', detail: 'zero total supply' };
  // Basis points, to avoid float drift on an 18-decimal supply.
  const bps = Number((held * 10_000n) / total);
  return {
    status: 'ok',
    locker,
    lockedTokens: held.toString(),
    totalSupply: total.toString(),
    lockedSupplyBps: bps,
  };
}

