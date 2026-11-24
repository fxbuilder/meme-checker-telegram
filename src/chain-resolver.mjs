/**
 * Automatic EVM chain resolution.
 *
 * WHY THIS EXISTS
 * A bare `0x…` address is syntactically valid on 13 supported chains, so the bot used to
 * answer every pasted EVM address with a full chain picker. That is a bad default: for
 * the overwhelming majority of real pastes the token exists on exactly ONE supported
 * chain, and making the user choose from 13 buttons to reach the only correct answer is
 * friction on a free, high-frequency feature.
 *
 * WHAT IT DOES
 * Asks two keyless, address-scoped indexers which chain(s) actually hold this exact
 * contract, and returns one of:
 *
 *   { status: 'resolved', chain, evidence }        -> scan automatically
 *   { status: 'ambiguous', candidates: [...] }     -> show the picker, narrowed
 *   { status: 'not-found' }                        -> providers answered, no records
 *   { status: 'unavailable', detail }              -> providers failed; NOT evidence
 *
 * THE RULE THAT MATTERS MOST: never guess. A wrong chain silently shows the wrong token
 * at the wrong price, and the user has no way to notice. If two chains genuinely carry
 * distinct deployments of the same address, that is 'ambiguous' and the user decides.
 * Falling back to BSC or Ethereum because nothing answered is explicitly forbidden.
 *
 * IDENTITY: candidates are filtered on the EXACT contract address AND a supported
 * network. A pair address, a quote token, or a matching ticker is not the requested
 * token, so each provider's response is matched field-by-field rather than trusted
 * wholesale.
 */

import { CHAINS, getChain } from './chains.mjs';

const TIMEOUT_MS = 8_000;

/** Chain ids DexScreener uses that differ from ours. */
const DEXSCREENER_ALIAS = {
  polygon: 'polygon',
  avalanche: 'avalanche',
  bnb: 'bsc',
  ethereum: 'ethereum',
  arbitrum: 'arbitrum',
  optimism: 'optimism',
  base: 'base',
  solana: 'solana',
};

/** GeckoTerminal network slugs for chains we support. */
const GT_SLUG = {
  ethereum: 'eth',
  bsc: 'bsc',
  base: 'base',
  arbitrum: 'arbitrum',
  optimism: 'optimism',
  polygon: 'polygon_pos',
  avalanche: 'avax',
  hyperevm: 'hyperevm',
  monad: 'monad',
  unichain: 'unichain',
  berachain: 'berachain',
  abstract: 'abstract',
  megaeth: 'megaeth',
  robinhood: 'robinhood',
  solana: 'solana',
};

/** Is this a 0x-style EVM address? (Solana base58 is handled by the caller.) */
export function isEvmAddress(address) {
  return typeof address === 'string' && /^0x[0-9a-fA-F]{40}$/.test(address.trim());
}

/** Our chain id for a provider's chain string, or null when unsupported. */
export function supportedChainFromProvider(raw) {
  if (!raw) return null;
  const key = String(raw).trim().toLowerCase();
  const mapped = DEXSCREENER_ALIAS[key] ?? key;
  const chain = getChain(mapped);
  // Only chains we can actually market-scan are valid answers.
  return chain && chain.market ? chain.id : null;
}

/**
 * Reverse GeckoTerminal slug -> our chain id.
 *
 * GeckoTerminal does not use our ids: it calls Ethereum `eth`, Polygon `polygon_pos`,
 * Avalanche `avax`. Feeding those straight to `getChain()` returns null, so a real
 * answer from GT was silently discarded and only DexScreener's opinion survived.
 * Derived from GT_SLUG so the two directions cannot drift apart.
 */
const GT_SLUG_TO_CHAIN = Object.fromEntries(
  Object.entries(GT_SLUG).map(([chain, slug]) => [slug, chain]),
);

/** Our chain id for a GeckoTerminal network slug, or null. */
export function chainFromGtSlug(slug) {
  if (!slug) return null;
  const key = String(slug).trim().toLowerCase();
  const direct = GT_SLUG_TO_CHAIN[key];
  if (direct) {
    const chain = getChain(direct);
    return chain && chain.market ? chain.id : null;
  }
  // Fall back to the plain-name path for slugs that already match our ids.
  return supportedChainFromProvider(key);
}

/**
 * Chains where providers are known to index at all. Used to describe a negative
 * honestly: "not found on any indexed chain" is a weaker statement than "does not exist".
 */
export function resolvableChains() {
  return Object.values(CHAINS).filter((c) => c.market && c.kind === 'evm').map((c) => c.id);
}

/** Fetch JSON with a hard timeout; returns {ok, status, json} and never throws. */
async function fetchJson(url, { fetchImpl = globalThis.fetch, timeoutMs = TIMEOUT_MS } = {}) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const res = await fetchImpl(url, {
      signal: ac.signal,
      headers: { accept: 'application/json', 'user-agent': 'MemeChecker/1.0' },
    });
    if (!res.ok) return { ok: false, status: res.status, json: null };
    const json = await res.json();
    return { ok: true, status: res.status, json };
  } catch (err) {
    return { ok: false, status: 0, json: null, error: String(err?.name ?? err) };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * DexScreener: GET /latest/dex/search?q={address}
 *
 * The response is a fuzzy multi-token search — it returns anything the query resembles —
 * so every pair is filtered on `baseToken.address === address`. Without that filter a
 * search for one contract happily reports chains where only a *different* token matched.
 */
export async function chainsFromDexScreener(address, opts = {}) {
  const url = `https://api.dexscreener.com/latest/dex/search?q=${encodeURIComponent(address)}`;
  const r = await fetchJson(url, opts);
  if (!r.ok) return { status: r.status === 0 ? 'error' : 'http-error', httpStatus: r.status, chains: [] };

  const pairs = Array.isArray(r.json?.pairs) ? r.json.pairs : [];
  const target = address.toLowerCase();
  const chains = new Set();
  let matchedPairs = 0;

  for (const p of pairs) {
    const base = String(p?.baseToken?.address ?? '').toLowerCase();
    // EXACT contract match only. A quote token or an unrelated result is not this token.
    if (base !== target) continue;
    const chain = supportedChainFromProvider(p?.chainId);
    if (!chain) continue;
    chains.add(chain);
    matchedPairs += 1;
  }

  return { status: 'ok', httpStatus: r.status, chains: [...chains], pairs: pairs.length, matchedPairs };
}

/**
 * GeckoTerminal: GET /search/pools?query={address}
 *
 * Used as a second opinion. Its `relationships` carry the token id as
 * `<network>_<address>`, which we match exactly.
 */
export async function chainsFromGeckoTerminal(address, opts = {}) {
  const url = `https://api.geckoterminal.com/api/v2/search/pools?query=${encodeURIComponent(address)}&page=1`;
  const r = await fetchJson(url, opts);
  if (!r.ok) return { status: r.status === 0 ? 'error' : 'http-error', httpStatus: r.status, chains: [] };

  const items = Array.isArray(r.json?.data) ? r.json.data : [];
  const target = address.toLowerCase();
  const chains = new Set();
  let matched = 0;

  for (const it of items) {
    const rel = it?.relationships ?? {};
    // Both sides of the pool are candidates for the requested contract.
    for (const side of ['base_token', 'quote_token']) {
      const id = rel?.[side]?.data?.id;
      if (typeof id !== 'string') continue;
      // ids look like "<slug>_<address>"; the slug itself may contain underscores
      // (polygon_pos), so split from the END.
      const idx = id.lastIndexOf('_');
      if (idx <= 0) continue;
      const slug = id.slice(0, idx);
      const addr = id.slice(idx + 1).toLowerCase();
      if (addr !== target) continue;
      const chain = chainFromGtSlug(slug);
      if (chain) { chains.add(chain); matched += 1; }
    }
  }

  return { status: 'ok', httpStatus: r.status, chains: [...chains], pools: items.length, matched };
}

/**
 * Deterministic preference when several chains are equally evidenced.
 *
 * Registry order is the tiebreak, NOT liquidity or popularity: a name-collision cannot
 * buy a higher position, and the ordering is stable across runs so the same address
 * always produces the same prompt.
 */
function preferenceOrder(chains) {
  const order = Object.keys(CHAINS);
  return [...chains].sort((a, b) => {
    const ia = order.indexOf(a);
    const ib = order.indexOf(b);
    if (ia !== ib) return ia - ib;
    return a.localeCompare(b);
  });
}

/**
 * Resolve an EVM address to one supported chain.
 *
 * Provider agreement is treated as strong evidence; disagreement is 'ambiguous'. A
 * provider ERROR is never folded into 'not-found', because "we could not ask" and
 * "nothing is there" are different statements.
 *
 * @returns {Promise<{status:'resolved'|'ambiguous'|'not-found'|'unavailable', chain?:string,
 *                    candidates?:string[], detail?:string, evidence?:object}>}
 */
export async function resolveEvmChain(address, { fetchImpl = globalThis.fetch, timeoutMs = TIMEOUT_MS } = {}) {
  if (!isEvmAddress(address)) {
    return { status: 'not-found', detail: 'not an EVM address', evidence: { checked: [] } };
  }

  const [ds, gt] = await Promise.all([
    chainsFromDexScreener(address, { fetchImpl, timeoutMs }),
    chainsFromGeckoTerminal(address, { fetchImpl, timeoutMs }),
  ]);

  const dsOk = ds.status === 'ok';
  const gtOk = gt.status === 'ok';
  const dsChains = new Set(dsOk ? ds.chains : []);
  const gtChains = new Set(gtOk ? gt.chains : []);
  const union = new Set([...dsChains, ...gtChains]);

  const evidence = {
    dexscreener: dsOk ? { chains: [...dsChains], pairs: ds.pairs, matched: ds.matchedPairs } : { error: ds.httpStatus },
    geckoterminal: gtOk ? { chains: [...gtChains], pools: gt.pools, matched: gt.matched } : { error: gt.httpStatus },
  };

  // Both providers failed: this is an outage, NOT a missing token.
  if (!dsOk && !gtOk) {
    return { status: 'unavailable', detail: 'chain-resolution providers unreachable', evidence };
  }

  if (union.size === 0) {
    return { status: 'not-found', detail: 'no supported chain holds this contract', evidence };
  }

  if (union.size === 1) {
    const chain = [...union][0];
    return { status: 'resolved', chain, evidence, agreement: dsChains.has(chain) && gtChains.has(chain) };
  }

  // Several candidates. If the providers AGREE on the full set, the address is genuinely
  // deployed on multiple supported chains and the user must choose.
  const agree = dsChains.size === gtChains.size && [...dsChains].every((c) => gtChains.has(c));
  return {
    status: 'ambiguous',
    candidates: preferenceOrder(union),
    // A single-provider claim for one chain while the other says something different is
    // weak; surfaced so the caller can word the prompt honestly.
    agreement: agree,
    evidence,
  };
}

/**
 * Resolve with cache.
 *
 * TTL is asymmetric on purpose:
 *   resolved / ambiguous -> 6h. Deployment on a chain does not change, but a brand-new
 *                           token appears after its first pool, so a cached negative
 *                           must expire.
 *   not-found            -> 10m. Short, because "not indexed YET" is the common case
 *                           for a token pasted seconds after launch.
 *   unavailable          -> 60s. Shed an outage quickly.
 */
export function createChainResolver({
  cache = new Map(),
  now = () => Date.now(),
  ttlResolvedMs = 6 * 60 * 60 * 1000,
  ttlNotFoundMs = 10 * 60 * 1000,
  ttlUnavailableMs = 60 * 1000,
  fetchImpl = globalThis.fetch,
  timeoutMs = TIMEOUT_MS,
} = {}) {
  const inflight = new Map();

  async function resolve(address) {
    const key = String(address ?? '').toLowerCase();
    if (!isEvmAddress(key)) return { status: 'not-found', detail: 'not an EVM address', evidence: { checked: [] } };

    const hit = cache.get(key);
    if (hit && hit.expiresAt > now()) return { ...hit.result, fromCache: true };

    // Concurrent pastes of the same address must not double-spend provider quota.
    if (inflight.has(key)) return inflight.get(key);

    const p = (async () => {
      const result = await resolveEvmChain(key, { fetchImpl, timeoutMs });
      const ttl = result.status === 'resolved' || result.status === 'ambiguous'
        ? ttlResolvedMs
        : result.status === 'not-found' ? ttlNotFoundMs : ttlUnavailableMs;
      cache.set(key, { result, expiresAt: now() + ttl });
      return result;
    })().finally(() => inflight.delete(key));

    inflight.set(key, p);
    return p;
  }

  return {
    resolve,
    /** Exposed for tests and diagnostics. */
    _cache: cache,
    _clear: () => cache.clear(),
  };
}

/** Process-wide resolver used by the bot and commands. */
export const chainResolver = createChainResolver();
