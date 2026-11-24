/**
 * src/dex-paid.mjs
 * "Dex Paid" status — did the project pay DexScreener for visibility?
 *
 * WHAT THE DATA ACTUALLY MEANS
 * DexScreener exposes `orders/v1/{chain}/{token}` returning `{orders, boosts}`.
 * Orders carry `type` (tokenProfile / tokenAd / communityTakeover) and `status`
 * (approved / cancelled / on-hold ...). A project that paid for enhanced token
 * info or an ad has an APPROVED order. That is the honest meaning of "Paid".
 *
 * THE TRAP — empty is ambiguous
 * An INVALID chain slug returns `200 {orders:[],boosts:[]}`, identical to a real
 * chain where the token simply has no orders. Verified directly. Therefore:
 *   - empty on a chain we have PROVEN is indexed  -> 'not-paid'   (assertable)
 *   - empty on any other chain                    -> 'unknown'    (never 'not-paid')
 *   - non-empty with an approved order            -> 'paid'
 *   - non-empty but only cancelled/on-hold        -> 'not-paid'  (ordered, not active)
 *   - provider failure                            -> 'unknown'
 *
 * Per-chain `dexPaid` in src/chains.mjs carries which chains were proven indexed.
 * That is the feature flag; flipping one to true after a real probe is the whole
 * change needed to light up more chains.
 */
import { getChain } from './chains.mjs';

const DS_BASE = 'https://api.dexscreener.com/orders/v1';
const TIMEOUT_MS = 7_000;
const TTL_MS = 120_000;
const FAIL_TTL_MS = 20_000;

const cache = new Map();
/** key -> in-flight promise, so concurrent callers share one request. */
const inflight = new Map();

/** Order statuses that mean the project currently has the paid product. */
const ACTIVE_STATUSES = new Set(['approved']);

/**
 * Classify an orders payload.
 * Exported for testing — the branch table is the whole point of this module.
 */
export function classifyOrders(chainId, body) {
  const chain = getChain(chainId);
  const orders = Array.isArray(body?.orders) ? body.orders : [];
  const boosts = Array.isArray(body?.boosts) ? body.boosts : [];
  const anySignal = orders.length > 0 || boosts.length > 0;

  if (!anySignal) {
    // Empty. Only assertable as "Not Paid" where indexing is proven.
    return chain?.dexPaid
      ? { status: 'not-paid', detail: 'no orders or boosts on an indexed chain' }
      : { status: 'unknown', detail: `orders/v1 is not proven to index ${chainId}` };
  }

  const active = orders.filter((o) => ACTIVE_STATUSES.has(String(o?.status).toLowerCase()));
  if (active.length) {
    return {
      status: 'paid',
      detail: `active ${[...new Set(active.map((o) => o.type))].join('/')}`,
      types: [...new Set(active.map((o) => o.type))],
      since: active
        .map((o) => (Number.isFinite(Number(o?.paymentTimestamp)) ? Number(o.paymentTimestamp) : null))
        .filter((v) => v !== null)
        .sort((a, b) => a - b)[0] ?? null,
      boosts: boosts.length,
    };
  }

  // Orders exist but none are active: they bought something and it lapsed/cancelled.
  const statuses = [...new Set(orders.map((o) => `${o?.type}:${o?.status}`))];
  return {
    status: 'not-paid',
    detail: `no active order (${statuses.join(', ')})`,
    types: [...new Set(orders.map((o) => o?.type))],
    since: null,
    boosts: boosts.length,
  };
}

/**
 * Fetch Dex Paid status.
 * Returns { status: 'paid'|'not-paid'|'unknown', detail, ... }.
 * Never throws; a failure is 'unknown', never an accusation of non-payment.
 */
export async function fetchDexPaid(chainId, address, { fetchImpl = globalThis.fetch, timeoutMs = TIMEOUT_MS } = {}) {
  const chain = getChain(chainId);
  if (!chain || !chain.dexPaid) {
    // Feature-gated off for this chain: say unknown, do not imply "not paid".
    return { status: 'unknown', detail: `${chainId} is not indexed by orders/v1` };
  }
  if (typeof fetchImpl !== 'function') return { status: 'unknown', detail: 'no fetch implementation' };

  const ck = `paid:${chainId}:${address}`;
  const hit = cache.get(ck);
  if (hit && hit.expiresAt > Date.now()) return hit.result;

  // IN-FLIGHT DEDUPE. The cache above only holds completed results, so two groups
  // asking about the same token in the same cycle both started a request. Sharing
  // the promise means one HTTP call no matter how many groups are waiting.
  const pending = inflight.get(ck);
  if (pending) return pending;

  const task = (async () => {
    let result;
    try {
      const res = await fetchImpl(`${DS_BASE}/${chain.ds}/${encodeURIComponent(address)}`, {
        headers: { accept: 'application/json' },
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!res.ok) {
        result = { status: 'unknown', detail: `http ${res.status}` };
      } else {
        result = classifyOrders(chainId, await res.json());
      }
    } catch (err) {
      const timedOut = err?.name === 'TimeoutError' || err?.name === 'AbortError';
      result = { status: 'unknown', detail: timedOut ? 'timeout' : `transport: ${err?.message ?? err}` };
    }
    cache.set(ck, { result, expiresAt: Date.now() + (result.status === 'unknown' ? FAIL_TTL_MS : TTL_MS) });
    return result;
  })();

  inflight.set(ck, task);
  try {
    return await task;
  } finally {
    inflight.delete(ck);
  }
}

export function clearDexPaidCache() {
  cache.clear();
  inflight.clear();
}
