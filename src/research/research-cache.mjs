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
import fs from 'node:fs';
import path from 'node:path';

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

  /**
   * Read an entry. Returns `undefined` for a miss so that a legitimately cached
   * `null` is still a HIT — using null for both made every null-valued load run
   * again on every scan, which defeats the cache entirely.
   */
  get(key) {
    const e = this.entries.get(key);
    if (!e) return undefined;
    if (e.expiresAt <= this.now()) { this.entries.delete(key); return undefined; }
    return e.value;
  }

  /** Has this key, and is the entry still fresh? */
  has(key) {
    return this.get(key) !== undefined;
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
    if (hit !== undefined) { this.hits += 1; return hit; }

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
/** Indirection so tests can stub waiting without faking timers globally. */
const defaultSleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

export class RequestBudget {
  constructor({ limit, windowMs = 24 * 60 * 60_000, now = () => Date.now(), label = 'provider', minIntervalMs } = {}) {
    this.limit = Number.isFinite(limit) ? limit : 0;
    this.windowMs = windowMs;
    this.now = now;
    this.label = label;
    this.used = 0;
    this.windowStart = now();
    // null, not 0: a clock that legitimately reads 0 must not be mistaken for
    // "never spent", which silently disabled pacing.
    this.lastSpendAt = null;
    /**
     * Measured, not guessed: consecutive GetXAPI searches returned 200 then 429.
     * 5000ms clears it in practice. Set to 0 to disable pacing (tests, or a provider
     * with real rate-limit headers).
     */
    this.minIntervalMs = Number.isFinite(minIntervalMs) ? minIntervalMs : 5_000;
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
    // Persist immediately: a crash between spend and delivery must not hand the
    // allowance back, or a restart loop becomes a free-request exploit.
    this.__persist?.();
    return true;
  }

  /**
   * Wait until this provider will accept another request, then reserve it.
   *
   * WHY THIS EXISTS. GetXAPI throttles bursts: two searches fired back to back
   * returned 200 then 429, and the 429 was still billed. Counting requests without
   * pacing them therefore wastes real money to learn nothing. Measured spacing that
   * reliably clears the throttle is ~5s between searches, so that is the floor.
   *
   * Returns false when the budget is exhausted, in which case nothing is awaited.
   */
  async reserve({ minIntervalMs = this.minIntervalMs, sleep = globalThis.__researchSleep ?? defaultSleep } = {}) {
    // SERIALISED. Reading lastSpendAt, computing a wait and writing lastSpendAt is a
    // read-modify-write race: two concurrent reservations both observe the same
    // `since`, both sleep the same interval, and wake together - so the floor held
    // for sequential calls but not for simultaneous ones, which is precisely when a
    // burst would be sent.
    //
    // Chaining through this promise makes reservations take turns, so each computes
    // its wait against the PREVIOUS reservation's completion.
    const prior = this.__reserveChain ?? Promise.resolve();
    let release;
    const mine = new Promise((resolve) => { release = resolve; });
    this.__reserveChain = prior.then(() => mine);

    await prior;
    try {
      // Charge inside the critical section so budget and pacing stay consistent.
      if (!this.spend(1)) return false;
      if (minIntervalMs > 0 && this.lastSpendAt !== null) {
        const since = this.now() - this.lastSpendAt;
        const wait = Math.max(0, minIntervalMs - since);
        if (wait > 0) await sleep(wait);
      }
      this.lastSpendAt = this.now();
      return true;
    } finally {
      // Always release, even on a refused spend or a throwing sleep, or the next
      // reservation would wait forever.
      release();
    }
  }

  stats() {
    this.#roll();
    return { label: this.label, used: this.used, limit: this.limit, remaining: this.remaining(), windowMs: this.windowMs };
  }

  /**
   * Serialise the window so the allowance survives a restart.
   *
   * WITHOUT THIS the daily budget resets every time the bot restarts. An operator who
   * restarts twice in an afternoon quietly gets three times the intended allowance,
   * which is exactly the failure the budget exists to prevent.
   */
  toJSON() {
    this.#roll();
    return { used: this.used, windowStart: this.windowStart, limit: this.limit, windowMs: this.windowMs };
  }

  /** Restore a persisted window. A window that has already elapsed keeps its reset. */
  restore(state) {
    if (!state || typeof state !== 'object') return false;
    const used = Number(state.used);
    const windowStart = Number(state.windowStart);
    if (!Number.isFinite(used) || !Number.isFinite(windowStart)) return false;
    // A different limit or window length means the stored state is from another
    // configuration; its `used` count would be meaningless, so ignore it.
    if (Number.isFinite(Number(state.limit)) && Number(state.limit) !== this.limit) return false;
    if (Number.isFinite(Number(state.windowMs)) && Number(state.windowMs) !== this.windowMs) return false;
    if (used < 0 || used > this.limit) return false;
    this.used = used;
    this.windowStart = windowStart;
    this.#roll();
    return true;
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
  const budget = new RequestBudget({ limit, windowMs: 24 * 60 * 60_000, label: 'x-search' });
  attachBudgetPersistence(budget, env);
  return budget;
}

/** Where the budget window is remembered between restarts. */
export function budgetStatePath(env = process.env) {
  return env.RESEARCH_BUDGET_PATH
    ? path.resolve(env.RESEARCH_BUDGET_PATH)
    : path.resolve(process.cwd(), 'data', 'research-budget.json');
}

/**
 * Make a budget remember itself.
 *
 * Loads the stored window on construction and writes it after every spend. Every
 * filesystem interaction is best-effort: a budget that cannot persist still works
 * for this process, and a broken state file must never stop a scan.
 */
export function attachBudgetPersistence(budget, env = process.env) {
  const file = budgetStatePath(env);
  try {
    if (fs.existsSync(file)) {
      const state = JSON.parse(fs.readFileSync(file, 'utf8'));
      budget.restore(state?.[budget.label]);
    }
  } catch {
    // Unreadable state is treated as absent, not as a hard failure.
  }
  const save = () => {
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      const prev = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : {};
      prev[budget.label] = budget.toJSON();
      fs.writeFileSync(file, JSON.stringify(prev, null, 2));
    } catch {
      // Persistence is an optimisation, never a precondition.
    }
  };
  budget.__persist = save;
  return budget;
}

export const xBudget = xBudgetFromEnv();
