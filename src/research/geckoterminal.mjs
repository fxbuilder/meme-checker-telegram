/**
 * src/research/geckoterminal.mjs
 * GeckoTerminal token metadata — the primary narrative source across chains.
 *
 * WHY THIS REPLACES COINGECKO AS THE BACKBONE
 * CoinGecko's platform map covers 8 of our 16 chains, and most NEW memecoins are not
 * listed there at all. GeckoTerminal's token-info endpoint is keyless (60 calls/min,
 * documented), covers 15 of 16 registered chains, and returns the things a narrative
 * is actually built from:
 *
 *   GET /api/v2/networks/{network}/tokens/{address}/info
 *   -> attributes.description, .websites[], .twitter_handle, .telegram_handle,
 *      .discord_url, .image_url, .coingecko_coin_id, .name, .symbol
 *
 * The description is the project's own prose about itself, so it is a CLAIM, never a
 * verified fact. Attribution is carried on the object so no caller has to guess.
 *
 * COST: free. No key, no billing. Rate limiting is the only constraint, so every call
 * goes through a shared paced gate and results are cached by the caller.
 */

const BASE = 'https://api.geckoterminal.com/api/v2';
const TIMEOUT_MS = 9_000;

/**
 * Our chain id -> GeckoTerminal network id.
 *
 * Verified against GET /api/v2/networks (pages 1-2) rather than guessed. Chains NOT
 * present there are absent here on purpose: an unknown network id returns 404, and a
 * silent miss is better than a wrong mapping.
 */
export const GT_NETWORK = {
  solana: 'solana',
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
  story: 'story',
  // robinhood: NOT on GeckoTerminal - covered by DexScreener only.
};

/** True when this chain has a GeckoTerminal network mapping. */
export function gtSupportsChain(chain) {
  return Boolean(GT_NETWORK[String(chain ?? '').toLowerCase()]);
}

/** The GeckoTerminal network id for a chain, or null when unmapped. */
export function gtNetwork(chain) {
  return GT_NETWORK[String(chain ?? '').toLowerCase()] ?? null;
}

/**
 * A shared gate so concurrent research cannot burst the provider.
 *
 * MEASURED, not documented: bursts and even 3s spacing returned 429 in testing, while
 * 20s spacing always succeeded. The published allowance is around 30/min, so the real
 * limiter is burst-sensitive rather than purely count-based. 6s spacing (10/min) is
 * deliberately conservative, and the cache means most lookups never reach the gate.
 */
export class PacedGate {
  constructor({ minIntervalMs = 6_000, now = () => Date.now(), sleep } = {}) {
    this.minIntervalMs = minIntervalMs;
    this.now = now;
    this.sleep = sleep ?? ((ms) => new Promise((r) => { setTimeout(r, ms); }));
    this.lastAt = null;
    this.__chain = Promise.resolve();
  }

  async wait() {
    // Serialised like the X budget: computing a wait then writing the timestamp is a
    // read-modify-write race that lets concurrent callers wake together.
    const prior = this.__chain;
    let release;
    this.__chain = new Promise((r) => { release = r; });
    await prior;
    try {
      if (this.minIntervalMs > 0 && this.lastAt !== null) {
        const wait = Math.max(0, this.minIntervalMs - (this.now() - this.lastAt));
        if (wait > 0) await this.sleep(wait);
      }
      this.lastAt = this.now();
    } finally {
      release();
    }
  }
}


/**
 * Extract the token address from a GeckoTerminal relationship id.
 *
 * The id is `"<network>_<address>"`, but network names may themselves contain an
 * underscore - `polygon_pos`, `polygon-zkevm`. Splitting on the FIRST underscore
 * turns `polygon_pos_0xabc` into `pos_0xabc`, a token that cannot exist, which is
 * exactly how Polygon lookups silently returned not-found.
 *
 * Solana/EVM addresses never contain an underscore, so stripping the known network
 * prefix is both correct and unambiguous.
 */
export function addressFromRelationshipId(relId, network = null) {
  const s = String(relId ?? '').trim();
  if (!s) return null;
  if (network && s.startsWith(`${network}_`)) return s.slice(network.length + 1);
  // Fallback: the address is the segment after the LAST underscore, because addresses
  // are alphanumeric only.
  const idx = s.lastIndexOf('_');
  return idx === -1 ? null : s.slice(idx + 1);
}

/** One shared gate for all GeckoTerminal traffic in this process. */
export const gtGate = new PacedGate();

/**
 * Fetch token metadata for one (chain, address).
 *
 * Never throws. Every outcome is a status the caller can render honestly:
 *   ok | unsupported-chain | not-found | rate-limited | provider-error | timeout
 *
 * @returns {Promise<{status:string, token?:object, detail?:string}>}
 */
export async function fetchTokenInfo(chain, address, {
  fetchImpl = globalThis.fetch, timeoutMs = TIMEOUT_MS, gate = gtGate, skipGate = false,
  retriesLeft = 2, attemptsMade = 0, retryBackoffMs = 8_000,
} = {}) {
  const net = gtNetwork(chain);
  if (!net) return { status: 'unsupported-chain' };
  const addr = String(address ?? '').trim();
  if (!addr) return { status: 'provider-error', detail: 'empty address' };
  if (typeof fetchImpl !== 'function') return { status: 'provider-error', detail: 'no fetch' };

  if (!skipGate) await gate.wait();

  const url = `${BASE}/networks/${encodeURIComponent(net)}/tokens/${encodeURIComponent(addr)}/info`;
  let res;
  try {
    res = await fetchImpl(url, {
      headers: { accept: 'application/json;version=20230302' },
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    const timedOut = err?.name === 'TimeoutError' || err?.name === 'AbortError';
    return { status: timedOut ? 'timeout' : 'provider-error', detail: String(err?.message ?? err) };
  }

  if (res.status === 404) return { status: 'not-found' };

  // A 429 is a "try again", not a verdict about the token. Without a retry the card
  // would report "no narrative" for a token that has a perfectly good description -
  // a false negative caused entirely by our own throughput.
  if (res.status === 429) {
    if (retriesLeft > 0) {
      const backoff = retryBackoffMs * (attemptsMade + 1);
      await gate.sleep(backoff);
      return fetchTokenInfo(chain, address, {
        fetchImpl, timeoutMs, gate, skipGate, retriesLeft: retriesLeft - 1, attemptsMade: attemptsMade + 1,
      });
    }
    return { status: 'rate-limited', detail: 'provider throttled after retries' };
  }
  if (!res.ok) return { status: 'provider-error', detail: `http ${res.status}` };

  let body;
  try {
    body = await res.text();
  } catch {
    return { status: 'provider-error', detail: 'body read failed' };
  }
  let parsed;
  try {
    parsed = JSON.parse(body);
  } catch {
    return { status: 'provider-error', detail: 'non-JSON' };
  }

  const a = parsed?.data?.attributes;
  if (!a || typeof a !== 'object') return { status: 'not-found' };

  return {
    status: 'ok',
    token: normaliseTokenInfo(a, { chain, address: addr }),
  };
}

/** Only absolute http(s) URLs survive; anything else is dropped, not repaired. */
function cleanUrl(v) {
  if (typeof v !== 'string') return null;
  const s = v.trim();
  if (!/^https?:\/\//i.test(s)) return null;
  try {
    const u = new URL(s);
    return u.protocol === 'http:' || u.protocol === 'https:' ? u.toString() : null;
  } catch {
    return null;
  }
}

/**
 * Shape a GeckoTerminal token payload.
 * Every field is either grounded in the payload or null — never synthesised.
 */
export function normaliseTokenInfo(a, { chain, address } = {}) {
  const sites = Array.isArray(a.websites)
    ? a.websites.map(cleanUrl).filter(Boolean)
    : [];

  // A social handle the provider reports, as a URL we can actually link.
  const twHandle = typeof a.twitter_handle === 'string' && /^[A-Za-z0-9_]{1,15}$/.test(a.twitter_handle)
    ? a.twitter_handle
    : null;
  const tgHandle = typeof a.telegram_handle === 'string' && /^[A-Za-z0-9_]{1,64}$/.test(a.telegram_handle.replace(/^@/, ''))
    ? a.telegram_handle.replace(/^@/, '')
    : null;

  return {
    source: 'geckoterminal',
    chain: chain ?? null,
    address: a.address ?? address ?? null,
    name: typeof a.name === 'string' ? a.name.trim() : null,
    symbol: typeof a.symbol === 'string' ? a.symbol.trim() : null,
    // The project's own prose. A CLAIM about itself, not a verified fact.
    description: typeof a.description === 'string' && a.description.trim()
      ? a.description.trim()
      : null,
    websites: sites,
    website: sites[0] ?? null,
    twitter: twHandle ? `https://x.com/${twHandle}` : null,
    twitterHandle: twHandle,
    telegram: tgHandle ? `https://t.me/${tgHandle}` : null,
    discord: cleanUrl(a.discord_url),
    imageUrl: cleanUrl(a.image_url),
    // Present when GeckoTerminal knows the CoinGecko listing, so the supplementary
    // source can be skipped rather than guessed at.
    coingeckoId: typeof a.coingecko_coin_id === 'string' && a.coingecko_coin_id
      ? a.coingecko_coin_id
      : null,
    categories: Array.isArray(a.categories) ? a.categories.filter((c) => typeof c === 'string').slice(0, 6) : [],

    // ---- security-relevant fields carried by this same payload --------------
    // Surfaced here because the endpoint is already being called for narrative.
    // They are kept raw-ish (not defaulted) so a missing field stays distinguishable
    // from a measured one: `holders: null` is "not reported", not "zero holders".
    holders: a.holders && typeof a.holders === 'object'
      ? {
        count: Number.isFinite(Number(a.holders.count)) ? Number(a.holders.count) : null,
        top10Percentage: (() => {
          const v = Number(a.holders?.distribution_percentage?.top_10);
          return Number.isFinite(v) && v >= 0 && v <= 100 ? v : null;
        })(),
      }
      : null,
    // Absent key = unknown; explicit null = renounced. Preserved as `undefined` so the
    // difference survives.
    mintAuthority: Object.prototype.hasOwnProperty.call(a, 'mint_authority') ? a.mint_authority : undefined,
    freezeAuthority: Object.prototype.hasOwnProperty.call(a, 'freeze_authority') ? a.freeze_authority : undefined,
    isHoneypot: a.is_honeypot,
    developerAddress: typeof a.developer_address === 'string' && a.developer_address ? a.developer_address : null,
    developerHoldingPercentage: (() => {
      const v = Number(a.developer_holding_percentage);
      return Number.isFinite(v) && v >= 0 && v <= 100 ? v : null;
    })(),
  };
}

/**
 * Does this chain have ANY narrative source at all?
 * Used to build the capability matrix and to render an honest unavailable state
 * instead of implying the token has no story.
 */
export function narrativeCoverageForChain(chain) {
  const net = gtNetwork(chain);
  if (net) return { available: true, primary: 'geckoterminal', network: net };
  return { available: false, reason: 'no-metadata-source' };
}
