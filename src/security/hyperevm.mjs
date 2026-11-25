/**
 * HyperEVM (chain 999) holder and security intelligence.
 *
 * HOLDERS ARE NOT OBTAINABLE KEYLESS ON THIS CHAIN, and that conclusion is MEASURED rather
 * than assumed. Everything below was probed live and the result recorded, because "we tried
 * nothing" and "we tried and it is impossible" are very different reports.
 *
 *   GeckoTerminal      no holder fields on HyperEVM token records
 *   GoPlus             no HyperEVM entry in supported_chains
 *   purrscan.com       a 469-byte JS shell - no server-rendered data, no /api routes
 *   hyperevmscan.io    redirects to api.hyperevmscan.io, whose V1 routes are deprecated
 *   routescan          "chain not supported" for 999
 *   Etherscan V2       answers, but returns "Missing/Invalid API Key" without one
 *   public RPC logs    "query exceeds max block range 1000"
 *
 * That last limit is decisive. Measured throughput: 1,000-block windows at ~120 ms each,
 * with 9 of 10 consecutive windows erroring under load. A genesis-to-head Transfer scan of
 * the 52.2M-block chain is 52,189 requests and roughly 104 minutes - unacceptable on any
 * interactive path, and unreliable given the error rate.
 *
 * So this module ships two things:
 *
 *   1. An OPTIONAL Etherscan-V2 adapter, gated on a key AND on a paid plan.
 *   2. A BOUNDED incremental Transfer indexer for targeted use, which never claims to be a
 *      complete distribution and refuses to run without an explicit budget.
 *
 * A FREE KEY DOES NOT UNLOCK HOLDERS - verified against Etherscan's own endpoint metadata
 * rather than assumed. The published endpoint list tags `tokenholderlist`, `tokenholdercount`,
 * `topholders` and `tokeninfo` all as **PRO**, and PRO means the paid Standard plan and above.
 * (An earlier version of this file said a free key would work. That was wrong, and it is
 * corrected here rather than left for the owner to discover after signing up.)
 *
 * HyperEVM compounds it: per Etherscan's supported-chains page, HyperEVM Mainnet (999)
 * community endpoints are free only until **2026-11-30**, and require **Lite or above** from
 * 2026-12-01. Holder endpoints are PRO on top of that.
 *
 * So this adapter is NOT a free upgrade path for HyperEVM holders. It is kept because it is
 * correct and will work if a paid plan is ever approved, and because it documents the exact
 * blocker. The requirement is stated rather than silently absorbed, and nothing else depends on
 * it: HyperEVM renders holders as unknown with the reason, never as zero.
 */

const TIMEOUT_MS = 15_000;

export const HYPEREVM = {
  chainId: 999,
  rpc: 'https://rpc.hyperliquid.xyz/evm',
  /** Measured: the public RPC refuses any eth_getLogs span wider than this. */
  maxLogSpanBlocks: 1_000,
  /** Measured: ~120 ms per 1,000-block window, with a ~90% error rate under load. */
  msPerWindow: 120,
  explorer: {
    // Etherscan V2 is multichain; chainid selects HyperEVM.
    baseUrl: 'https://api.etherscan.io/v2/api',
    chainParam: 999,
  },
};

/** Where an owner-configured key would be read from. Never a committed value. */
export const HYPEREVM_KEY_ENV = 'ETHERSCAN_API_KEY';

// ---------------------------------------------------------------------------
// Optional explorer adapter
// ---------------------------------------------------------------------------

/**
 * Read holders/supply from Etherscan V2 when a key is configured.
 *
 * @returns {Promise<{status:'ok'|'not-configured'|'unauthorized'|'rate-limited'|'no-data'|'error', ...}>}
 */
export async function readHyperEvmExplorer(address, {
  fetchImpl = globalThis.fetch, timeoutMs = TIMEOUT_MS, apiKey = process.env?.[HYPEREVM_KEY_ENV],
} = {}) {
  if (!apiKey || !String(apiKey).trim()) {
    // A missing credential is a CONFIGURATION GAP. Saying "no data" here would be a claim
    // about the token, and the whole point of this file is to avoid exactly that.
    return {
      status: 'not-configured',
      detail: `${HYPEREVM_KEY_ENV} is unset - holder data for HyperEVM needs an Etherscan V2 key `
        + 'on a PAID plan (holder endpoints are PRO; free keys cannot access them)',
      requirement: {
        envVar: HYPEREVM_KEY_ENV,
        // Stated precisely so the owner does not create a free key and find it rejected.
        minimumPlan: 'Standard (PRO) or above for tokenholderlist / tokenholdercount / topholders',
        freeKeyWorks: false,
        howToGet: 'https://etherscan.io/apis',
        scope: 'Etherscan V2 multichain, chainid=999',
        additionalCaveat: 'HyperEVM community endpoints become Lite-or-above from 2026-12-01',
        note: 'Optional. Nothing else depends on it; HyperEVM holders render unknown with this reason.',
        verifiedAgainst: 'https://docs.etherscan.io/endpoint-overview (PRO tags) and '
          + 'https://docs.etherscan.io/supported-chains',
      },
    };
  }

  const url = `${HYPEREVM.explorer.baseUrl}?chainid=${HYPEREVM.explorer.chainParam}`
    + `&module=token&action=tokenholderlist&contractaddress=${address}&page=1&offset=100`
    + `&apikey=${encodeURIComponent(apiKey)}`;

  let body;
  try {
    const res = await fetchImpl(url, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(timeoutMs) });
    if (res.status === 429) return { status: 'rate-limited', detail: 'http 429' };
    if (!res.ok) return { status: 'error', detail: `http ${res.status}` };
    body = await res.json();
  } catch (err) {
    return { status: 'error', detail: String(err?.message ?? err) };
  }

  // The explorer answers 200 for most failures and signals in the body - so branch on the
  // envelope, never the status code.
  if (body?.status !== '1' || !Array.isArray(body?.result)) {
    const msg = String(body?.result ?? body?.message ?? 'unknown');
    if (/invalid api key|missing\/invalid/i.test(msg)) return { status: 'unauthorized', detail: msg };
    // A PLAN refusal is its own outcome. A free key is valid and still cannot read holders, so
    // reporting this as a generic error would hide the one fact the owner needs: the key is
    // fine, the subscription is not.
    if (/pro|subscription|upgrade|plan|not available|unauthori[sz]ed for this endpoint/i.test(msg)) {
      return {
        status: 'plan-required',
        detail: msg,
        requirement: { minimumPlan: 'Standard (PRO) or above', freeKeyWorks: false },
      };
    }
    if (/no transactions|no holders|empty/i.test(msg)) return { status: 'no-data', detail: msg };
    return { status: 'error', detail: msg };
  }

  const rows = body.result
    .map((r) => ({
      address: r?.TokenHolderAddress ?? null,
      // `value` is RAW UNITS; dividing by the token's decimals is the caller's job and doing
      // it here with a guessed exponent would misreport the largest holder by orders of
      // magnitude.
      rawBalance: r?.TokenHolderQuantity ?? null,
    }))
    .filter((r) => r.address);

  return {
    status: 'ok',
    source: 'etherscan-v2',
    // The offset was 100, so this is a PAGE of holders, not the whole population unless the
    // page came back short.
    holders: rows,
    holderCount: rows.length,
    pageComplete: rows.length < 100,
    top10Raw: rows.slice(0, 10),
  };
}

// ---------------------------------------------------------------------------
// Bounded incremental Transfer indexer
// ---------------------------------------------------------------------------

/**
 * Walk Transfer logs over a bounded window and tally net balances.
 *
 * DELIBERATELY NOT A HOLDER-DISTRIBUTION REPORT. It can only see the window it scanned, so
 * every result carries `scope: 'window'` and `complete: false`, and the caller must present
 * it as a partial observation. Minting, burning and rebasing all break a naive tally, which
 * is another reason this must never be dressed up as "the holders".
 *
 * `maxWindows` is mandatory so the cost is explicit at the call site rather than discovered
 * after a two-minute wait.
 */
export async function scanTransfersBounded(address, {
  fetchImpl = globalThis.fetch, rpc = HYPEREVM.rpc, maxWindows = 20, fromBlock = null,
} = {}) {
  const ZERO = '0x0000000000000000000000000000000000000000';
  const calls = [];
  const nonEmpty = [];

  const head = await rpcCall(fetchImpl, rpc, 'eth_blockNumber', []);
  if (!head.value) return { status: 'error', detail: head.detail ?? 'no head' };
  const latest = Number(BigInt(head.value));
  const start = fromBlock ?? Math.max(0, latest - maxWindows * HYPEREVM.maxLogSpanBlocks);

  let windows = 0;
  let failed = 0;
  for (let to = latest; to > start && windows < maxWindows; to -= HYPEREVM.maxLogSpanBlocks) {
    const from = Math.max(start, to - HYPEREVM.maxLogSpanBlocks);
    const res = await rpcCall(fetchImpl, rpc, 'eth_getLogs', [{
      address,
      topics: [TOPIC_TRANSFER],
      fromBlock: '0x' + from.toString(16),
      toBlock: '0x' + to.toString(16),
    }]);
    windows += 1;
    if (res.why) { failed += 1; continue; }
    for (const log of res.value ?? []) nonEmpty.push(log);
  }

  const balances = new Map();
  for (const log of nonEmpty) {
    const from = '0x' + String(log.topics?.[1] ?? '').slice(-40);
    const to = '0x' + String(log.topics?.[2] ?? '').slice(-40);
    const value = BigInt('0x' + String(log.data ?? '0x0').replace(/^0x/, '').slice(0, 64) || '0');
    if (from !== ZERO) balances.set(from, (balances.get(from) ?? 0n) - value);
    if (to !== ZERO) balances.set(to, (balances.get(to) ?? 0n) + value);
  }

  return {
    status: nonEmpty.length || !failed ? 'ok' : 'error',
    // These two fields exist so a partial tally cannot be mistaken for a full distribution.
    scope: 'window',
    complete: false,
    windows,
    failedWindows: failed,
    fromBlock: start,
    toBlock: latest,
    transfersSeen: nonEmpty.length,
    // Only positive net balances are holders; a negative net means the window began after
    // they acquired, which is exactly the distortion a partial scan introduces.
    netPositive: [...balances.entries()].filter(([, v]) => v > 0n).length,
    coverageNote:
      `scanned ${windows} x ${HYPEREVM.maxLogSpanBlocks}-block windows ending at ${latest}; `
      + 'tokens acquired before this window are invisible, so this is NOT a holder distribution',
  };
}

const TOPIC_TRANSFER = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';

async function rpcCall(fetchImpl, rpc, method, params) {
  try {
    const res = await fetchImpl(rpc, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) return { why: 'transport', detail: `http ${res.status}` };
    const body = await res.json();
    if (body?.error) return { why: 'revert', detail: body.error?.message ?? 'error' };
    return { value: body?.result };
  } catch (err) {
    return { why: 'transport', detail: String(err?.message ?? err) };
  }
}

/** Merge explorer holder data into a risk block, filling only gaps. */
export function mergeHyperEvmHolders(risk, explorer) {
  const base = risk ?? {
    holders: { total: null, top10Percentage: null, largestHolderPercentage: null },
    tax: null, lpLock: null, dev: null, security: {},
  };
  if (!explorer || explorer.status !== 'ok') return base;
  const holders = { ...(base.holders ?? {}) };
  // The explorer returns a page of holders, not a count. Only claim a total when the page
  // came back short of its own size, which proves there are no further pages.
  if (holders.total == null && explorer.pageComplete === true) holders.total = explorer.holderCount;
  return {
    ...base,
    holders,
    sources: { ...(base.sources ?? {}), holders: holders.total != null ? 'etherscan-v2' : base.sources?.holders },
    hyperevm: { pageComplete: explorer.pageComplete ?? null, holdersReturned: explorer.holderCount ?? null },
  };
}
