/**
 * src/research/research-cache.mjs
 * Cache, in-flight sharing and request budget for research providers.
 *
 * WHY A SEPARATE LAYER
 * Phase 3 showed the cost of letting each call site roll its own cache: the Dex
 * Paid adapter cached only completed results, so two groups on one token made two
 * requests, and the budget had to be patched in later. This module exists so the
 * same mistake cannot be made again — every research read goes through `cached()`
 * and every paid request goes through `spend()`.
 *
 * LAYERS
 *   L1  in-process Map, per token; survives for the life of the bot process
 *   L2  in-flight promise sharing, so N concurrent scans of one token make ONE call
 *   budget  a hard per-window counter for credentialed providers
 *
 * TTLs are split by volatility, following the existing project's verified policy:
 *   description  6h    project prose changes rarely
 *   identity     1h    contract facts are immutable but a failed read should retry
 *   posts        30m   engagement moves; a post's existence does not change
 *   failure      30s   a throttle must recover without being hammered
 */

/** TTLs in ms. */
export const TTL_MS = {
  description: 6 * 60 * 60_000,
  identity: 60 * 60_000,
  posts: 30 * 60_000,
  failure: 30_000,
};

const L1_MAX_ENTRIES = 800;

/** Cache key: provider + canonical chain + normalised address. */
export function cacheKey(provider, chain, address) {
  const a = chain === 'solana' ? String(address ?? '') : String(address ?? '').toLowerCase();
  return `${provider}:${chain}:${a}`;
}

export class ResearchCache {
  constructor({ now = () => Date.now(), maxEntries = L1_MAX_ENTRIES } = {}) {
    this.now = now;
    this.maxEntries = maxEntries;
    this.entries = new Map();
    this.inflight = new Map();
    this.hits = 0;
    this.misses = 0;
  }

  get(key) {
    const e = this.entries.get(key);
    if (!e) return null;
    if (e.expiresAt <= this.now()) { this.entries.delete(key); return null; }
    return e.value;
  }

  set(key, value, ttlMs) {
    // Bound the map: evict the oldest inserted entry rather than growing forever.
    if (this.entries.size >= this.maxEntries) {
      const oldest = this.entries.keys().next().value;
      if (oldest !== undefined) this.entries.delete(oldest);
    }
    this.entries.set(key, { value, expiresAt: this.now() + ttlMs });
  }

  /**
   * Cache read-through with in-flight sharing.
   *
   * `fn` runs at most once per key concurrently. A failure is cached briefly via
   * `ttlOnFailure` so a provider outage does not get hammered by every scan.
   */
  async cached(key, ttlMs, fn, { ttlOnFailure = TTL_MS.failure } = {}) {
    const hit = this.get(key);
    if (hit !== null) { this.hits += 1; return hit; }

    const pending = this.inflight.get(key);
    if (pending) { this.hits += 1; return pending; }

    this.misses += 1;
    const task = (async () => {
      try {
        const value = await fn();
        // Negative results are cached too, on a short TTL: "no description" is a
        // real finding worth remembering, but not for six hours.
        const ok = value && typeof value === 'object' && 'status' in value
          ? value.status === 'ok' || value.status === 'not-found' || value.status === 'unsupported-chain'
          : true;
        this.set(key, value, ok ? ttlMs : ttlOnFailure);
        return value;
      } catch (err) {
        const value = { status: 'provider-error', detail: String(err?.message ?? err) };
        this.set(key, value, ttlOnFailure);
        return value;
      }
    })();

    this.inflight.set(key, task);
    try {
      return await task;
    } finally {
      this.inflight.delete(key);
    }
  }

  stats() {
    return {
      entries: this.entries.size,
      inflight: this.inflight.size,
      hits: this.hits,
      misses: this.misses,
      hitRate: this.hits + this.misses ? this.hits / (this.hits + this.misses) : 0,
    };
  }

  clear() {
    this.entries.clear();
    this.inflight.clear();
    this.hits = 0;
    this.misses = 0;
  }
}

/**
 * Request budget for a credentialed provider.
 *
 * The existing research used a free tier with a hard lifetime ceiling (Sorsa: 100
 * requests, no refill), so the budget is deliberately conservative and visible:
 * when it is exhausted the caller reports `budget-exhausted` rather than silently
 * making the request.
 */
export class RequestBudget {
  constructor({ limit, windowMs = 24 * 60 * 60_000, now = () => Date.now(), label = 'provider' } = {}) {
    this.limit = Number.isFinite(limit) ? limit : 0;
    this.windowMs = windowMs;
    this.now = now;
    this.label = label;
    this.used = 0;
    this.windowStart = now();
  }

  /** Roll the window if it has elapsed. */
  #roll() {
    if (this.now() - this.windowStart >= this.windowMs) {
      this.used = 0;
      this.windowStart = this.now();
    }
  }

  remaining() {
    this.#roll();
    return Math.max(0, this.limit - this.used);
  }

  /** Reserve one request. Returns false when the budget is spent. */
  spend(n = 1) {
    this.#roll();
    if (this.used + n > this.limit) return false;
    this.used += n;
    return true;
  }

  stats() {
    this.#roll();
    return { label: this.label, used: this.used, limit: this.limit, remaining: this.remaining(), windowMs: this.windowMs };
  }
}

/** The process-wide research cache. One instance, shared by every command. */
export const researchCache = new ResearchCache();

/**
 * X request budget. Default 0 means "no credential configured"; a configured
 * deployment sets RESEARCH_X_BUDGET to the real allowance.
 *
 * The free Sorsa tier is 100 requests for the life of the account, so a daily
 * window of 20 is deliberately conservative: it keeps a busy group from burning
 * the allowance in an afternoon.
 */
export function xBudgetFromEnv(env = process.env) {
  const raw = Number(env.RESEARCH_X_BUDGET);
  const limit = Number.isFinite(raw) && raw >= 0 ? raw : 20;
  return new RequestBudget({ limit, windowMs: 24 * 60 * 60_000, label: 'x-search' });
}

export const xBudget = xBudgetFromEnv();
