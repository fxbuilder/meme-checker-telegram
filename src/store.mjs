/**
 * src/store.mjs
 * Durable call history. Single local JSON file with atomic writes.
 *
 * WHY THIS SHAPE
 * The call record is the shared substrate for Phase 2 (PnL), Phase 3 (alerts)
 * and Phase 6 (leaderboard). It therefore stores OBSERVATIONS, not just totals:
 * an entry snapshot, the running peak, and the last seen value. Anything a later
 * feature needs can be derived from those without re-scanning history.
 *
 * DURABILITY
 * - atomic write: serialize to `<file>.tmp`, then rename over the target. A crash
 *   mid-write cannot leave a half-written file where the real one was.
 * - `schemaVersion` on every document, with an explicit migration hook, so a
 *   future Postgres/Redis move has a version to branch on.
 * - a corrupt or unreadable file is preserved as `<file>.corrupt-<ts>` and the
 *   store starts empty rather than silently discarding data or throwing on boot.
 * - writes are serialized through a promise queue: concurrent handlers cannot
 *   interleave two renames and lose an update.
 *
 * WHAT IS NOT STORED
 * No API keys, no message text, no user profile beyond the display name and
 * username already public in the group. Nothing here is a trading record: a
 * "call" is a social observation, not a position.
 */

import fs from 'node:fs';
import path from 'node:path';
import { classifyPost } from './research/x-source.mjs';

export const SCHEMA_VERSION = 3;

/**
 * How many delivery attempts one alert may take before it is abandoned.
 * A permanent rejection (bot blocked, chat deleted) must not be retried forever.
 */
export const MAX_ALERT_ATTEMPTS = 3;

/** Where the store lives. Overridable for tests and for a future volume mount. */
export function defaultStorePath() {
  return process.env.CALLS_DB_PATH
    ? path.resolve(process.env.CALLS_DB_PATH)
    : path.resolve(process.cwd(), 'data', 'calls.json');
}

function emptyDoc() {
  return {
    schemaVersion: SCHEMA_VERSION,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    /** chatId(string) -> settings */
    groups: {},
    /** array of call records, append-mostly (rewritten on update) */
    calls: [],
    /** monotonic id source; avoids Date.now() collisions in one millisecond */
    seq: 0,
    /**
     * Phase 3 alert state, keyed by a STABLE event id rather than array position:
     *   `${callId}:milestone:${value}`      one row per crossed multiplier
     *   `${callId}:dexpaid`                 the Dex Paid status tracker
     *   `${callId}:migration`               the migration tracker
     *   `${callId}:pump|dump|drawdown`      price-movement trackers
     * Storing by key makes dedupe a property of the data, not of the loop that
     * writes it, so a restart or a second observer cannot re-send an alert.
     */
    alerts: {},
    /**
     * Phase 4 public X call evidence.
     *
     * DELIBERATELY SEPARATE from `calls`. A Telegram group call is a record of what
     * a member of THIS group did; a public X call is what a stranger posted on X.
     * Merging them would let a KOL's post contaminate a group's caller stats, and
     * would leak group call history into /kol. They share a file for operational
     * simplicity but never share a code path.
     *
     * Keyed by a stable composite so the same post can never be recorded twice:
     *   `${authorHandle.toLowerCase()}:${postId}`
     */
    xCalls: {},
  };
}

/**
 * Migrate a loaded document to the current schema.
 * Each step is explicit so a downgrade is detectable rather than silent.
 */
export function migrate(docRaw) {
  if (!docRaw || typeof docRaw !== 'object') return { doc: emptyDoc(), migrated: false };
  const doc = { ...emptyDoc(), ...docRaw };
  let migrated = false;

  const from = Number(doc.schemaVersion ?? 0);
  if (from < 1) {
    // v0 (pre-versioned) had no `groups`, no `seq`. Normalise in place.
    doc.groups = doc.groups && typeof doc.groups === 'object' ? doc.groups : {};
    doc.calls = Array.isArray(doc.calls) ? doc.calls : [];
    doc.seq = Number.isFinite(Number(doc.seq)) ? Number(doc.seq) : doc.calls.length;
    doc.schemaVersion = 1;
    migrated = true;
  }

  if (from < 2) {
    // v1 had no alert state. Additive only: existing calls and settings are
    // untouched, so a v1 file keeps every record and gains an empty alert map.
    doc.alerts = doc.alerts && typeof doc.alerts === 'object' ? doc.alerts : {};
    doc.schemaVersion = 2;
    migrated = true;
  }

  if (from < 3) {
    // v2 had no public X call evidence. Additive only.
    doc.xCalls = doc.xCalls && typeof doc.xCalls === 'object' ? doc.xCalls : {};
    doc.schemaVersion = 3;
    migrated = true;
  }

  if (Number(doc.schemaVersion) > SCHEMA_VERSION) {
    // A newer binary wrote this file. Refuse to operate rather than corrupt it.
    throw new Error(
      `calls store schemaVersion ${doc.schemaVersion} is newer than this build supports (${SCHEMA_VERSION}). ` +
      'Upgrade the bot or point CALLS_DB_PATH at a different file.',
    );
  }
  return { doc, migrated };
}

/** Default per-group settings. Auto-call is OFF: recording must be deliberate. */
export function defaultGroupSettings(chatId) {
  return {
    chatId: String(chatId),
    // 'auto'   — a pasted CA records a call automatically
    // 'manual' — a pasted CA only scans; /call records the call
    autoCall: 'manual',
    // minimum USD market cap for a pasted CA to become a call. Guards against
    // recording garbage dust tokens that the provider mis-reports.
    minMarketCapUsd: 5_000,
    /**
     * Phase 3 alert switches. Multiplier alerts default ON because they are the
     * headline feature; the noisier, judgement-dependent ones default OFF so a
     * group is never surprised by alerts it did not ask for.
     */
    alerts: {
      multiplier: true,
      dexPaid: true,
      migration: true,
      priceMovement: false,
      // Default enabled subset: the round numbers people actually screenshot.
      milestones: [2, 5, 10, 20, 50, 100],
      pumpPercent: 50,
      pumpWindowMs: 15 * 60_000,
      dumpPercent: 30,
      dumpWindowMs: 15 * 60_000,
      drawdownPercent: 50,
    },
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

// One document AND persistence queue per file in this process. Independent store
// objects must not check stale snapshots or race the same atomic-write temp path.
// This is an in-process guarantee; separate bot processes must not share a file.
const fileStates = new Map();

export class CallStore {
  constructor(filePath = defaultStorePath()) {
    this.filePath = path.resolve(filePath);
    const key = process.platform === 'win32' ? this.filePath.toLowerCase() : this.filePath;
    if (!fileStates.has(key)) {
      fileStates.set(key, {
        doc: emptyDoc(), loaded: false, writeQueue: Promise.resolve(), migrated: false,
      });
    }
    const state = fileStates.get(key);
    for (const name of ['doc', 'loaded', 'writeQueue', 'migrated']) {
      Object.defineProperty(this, name, {
        enumerable: true,
        get: () => state[name],
        set: (value) => { state[name] = value; },
      });
    }
  }

  /** Read the file. Never throws for a missing file; quarantines a corrupt one. */
  load() {
    if (this.loaded) return this;
    let raw;
    try {
      raw = fs.readFileSync(this.filePath, 'utf8');
    } catch (err) {
      if (err.code === 'ENOENT') {
        this.doc = emptyDoc();
        this.loaded = true;
        return this;
      }
      throw err;
    }
    try {
      const parsed = JSON.parse(raw);
      const { doc, migrated } = migrate(parsed);
      this.doc = doc;
      this.migrated = migrated;
    } catch (err) {
      // Preserve the unreadable file; never destroy user data on a parse error.
      const quarantine = `${this.filePath}.corrupt-${Date.now()}`;
      try { fs.copyFileSync(this.filePath, quarantine); } catch { /* best effort */ }
      console.error(`[store] ${this.filePath} is unreadable (${err.message}); preserved as ${quarantine}. Starting empty.`);
      this.doc = emptyDoc();
    }
    this.loaded = true;
    return this;
  }

  /** Serialized atomic write. */
  async persist() {
    this.doc.updatedAt = new Date().toISOString();
    const payload = JSON.stringify(this.doc, null, 2);
    const run = async () => {
      const dir = path.dirname(this.filePath);
      await fs.promises.mkdir(dir, { recursive: true });
      const tmp = `${this.filePath}.tmp`;
      await fs.promises.writeFile(tmp, payload, 'utf8');
      await fs.promises.rename(tmp, this.filePath);
    };
    this.writeQueue = this.writeQueue.then(run, run);
    return this.writeQueue;
  }

  // ---- groups -------------------------------------------------------------

  groupSettings(chatId, { title = null } = {}) {
    this.load();
    const key = String(chatId);
    if (!this.doc.groups[key]) this.doc.groups[key] = defaultGroupSettings(key);
    const g = this.doc.groups[key];
    // Remember the human title when we are told it, so caller profiles and PnL
    // cards can name the group instead of showing a numeric chat id.
    if (title && g.title !== title) {
      g.title = title;
      g.updatedAt = new Date().toISOString();
      this.persist().catch(() => {});
    }
    return g;
  }

  async setGroupSetting(chatId, patch) {
    this.load();
    const key = String(chatId);
    const cur = this.groupSettings(key);
    this.doc.groups[key] = { ...cur, ...patch, chatId: key, updatedAt: new Date().toISOString() };
    await this.persist();
    return this.doc.groups[key];
  }

  // ---- calls --------------------------------------------------------------

  /**
   * Calls for one group. Newest first.
   * `address` matching is chain-aware: EVM is case-insensitive, Solana is not.
   */
  callsForChat(chatId, { limit = 20 } = {}) {
    this.load();
    const key = String(chatId);
    return this.doc.calls
      .filter((c) => c.chatId === key)
      .sort((a, b) => b.calledAt - a.calledAt)
      .slice(0, limit);
  }

  /**
   * Real, non-cancelled calls recorded for ONE address in ONE group, across
   * chains. Used to resolve `/pnl <address>` from our own records BEFORE any
   * chain detection, so an unrecorded address never reaches a market provider or
   * a chain picker. Synthetic records are excluded: a simulated call must never
   * be reachable as a PnL card.
   */
  recordedCallsForAddress(chatId, address) {
    this.load();
    const key = String(chatId);
    const addr = String(address ?? '').trim();
    if (!addr) return [];
    // EVM addresses are case-insensitive; Solana base58 is not. Match on the
    // normalised form for the chain the record was written with.
    return this.doc.calls.filter((c) => {
      if (c.chatId !== key) return false;
      if (!isActive(c)) return false;
      if (isSynthetic(c)) return false;
      return normaliseAddress(c.chain, c.address) === normaliseAddress(c.chain, addr);
    }).sort((a, b) => b.calledAt - a.calledAt);
  }

  /** Distinct chains among the recorded calls for one address in one group. */
  recordedChainsForAddress(chatId, address) {
    return [...new Set(this.recordedCallsForAddress(chatId, address).map((c) => c.chain))];
  }

  // ---- Phase 4: public X call evidence ----------------------------------
  // Separate from `calls` on purpose. See the xCalls comment in emptyDoc().

  /**
   * Record one public X call, once.
   *
   * Idempotent by (authorHandle, postId): re-discovering the same post is a no-op,
   * so a re-scan or a second process cannot inflate a KOL's recorded call count.
   *
   * @returns {{added:boolean, key?:string, reason?:string}}
   */
  async recordXCall(entry) {
    this.load();
    const author = String(entry?.authorHandle ?? '').replace(/^@/, '').trim();
    const postId = String(entry?.postId ?? '').trim();
    if (!author || !postId) return { added: false, reason: 'missing-identity' };

    // Only a genuine public call against a matched contract is evidence.
    if (entry?.role !== 'public-call') return { added: false, reason: 'not-a-call' };
    if (!entry?.containsContract) return { added: false, reason: 'no-contract-match' };

    const key = `${author.toLowerCase()}:${postId}`;
    if (this.doc.xCalls[key]) return { added: false, reason: 'duplicate' };

    this.doc.xCalls[key] = {
      authorHandle: author,
      postId,
      chain: entry.chain ?? null,
      address: entry.address ?? null,
      symbol: entry.symbol ?? null,
      // Entry market cap is recorded ONLY when the caller supplied a verified one.
      // /kol must never present an unverifiable entry as a number.
      entryMarketCapUsd: Number.isFinite(entry.entryMarketCapUsd) ? entry.entryMarketCapUsd : null,
      text: String(entry.text ?? '').slice(0, 280),
      url: entry.url ?? null,
      createdAt: entry.createdAt ?? null,
      observedAt: new Date().toISOString(),
    };
    this.doc.updatedAt = new Date().toISOString();
    await this.persist();
    return { added: true, key };
  }

  /** Every recorded public call by one handle, newest first. */
  recordedXCallsForHandle(handle) {
    this.load();
    const want = String(handle ?? '').replace(/^@/, '').toLowerCase();
    if (!want) return [];
    return Object.values(this.doc.xCalls)
      .filter((e) => String(e.authorHandle).toLowerCase() === want)
      .sort((a, b) => String(b.createdAt ?? '').localeCompare(String(a.createdAt ?? '')));
  }

  /** All recorded public calls for one canonical token. */
  recordedXCallsForToken(chain, address) {
    this.load();
    const addr = String(address ?? '').trim();
    if (!addr) return [];
    return Object.values(this.doc.xCalls).filter((e) => {
      if (String(e.chain) !== String(chain)) return false;
      // Reuse the same address normalisation as group calls.
      return normaliseAddress(chain, e.address) === normaliseAddress(chain, addr);
    });
  }

  /** Persist every public call found in a research result. Idempotent. */
  async recordXCallsFromResearch(research, { chain, address, symbol } = {}) {
    this.load();
    const posts = research?.x?.posts ?? [];
    let added = 0;
    for (const p of posts) {
      const role = classifyPost(p, { projectHandle: research?.x?.projectHandle ?? null });
      if (role !== 'public-call') continue;
      const res = await this.recordXCall({
        authorHandle: p.authorHandle,
        postId: p.id,
        chain,
        address,
        symbol,
        text: p.text,
        url: p.url,
        createdAt: p.createdAt,
        role,
        containsContract: p.containsContract,
      });
      if (res.added) added += 1;
    }
    return { added };
  }

  /** The call that owns first-caller attribution for (chat, chain, address). */
  firstCall(chatId, chain, address) {
    this.load();
    const key = String(chatId);
    const norm = normaliseAddress(chain, address);
    // Attribution must come from a live, real record. A cancelled call was
    // withdrawn by the caller, and a synthetic one was never a real call, so
    // neither may own attribution.
    return this.doc.calls
      .filter((c) => c.chatId === key && c.chain === chain
        && normaliseAddress(chain, c.address) === norm
        && isActive(c)
        && !isSynthetic(c))
      .sort((a, b) => a.calledAt - b.calledAt)[0] ?? null;
  }

  /** All calls for one (chat, chain, address), newest first. */
  callsForToken(chatId, chain, address) {
    this.load();
    const key = String(chatId);
    const norm = normaliseAddress(chain, address);
    return this.doc.calls
      .filter((c) => c.chatId === key && c.chain === chain && normaliseAddress(chain, c.address) === norm)
      .sort((a, b) => b.calledAt - a.calledAt);
  }

  /**
   * Has this user already called this token in this chat recently?
   * Used to prevent one member spamming the same call (duplicate protection).
   */
  /**
   * The same member's recent call for one token, inside `windowMs`.
   * `now` is injectable: callers pass the same clock they stamp records with, so
   * a record and its dedup check can never disagree about when "now" is.
   */
  recentCallByUser(chatId, chain, address, callerIdentity, windowMs, now = Date.now()) {
    const cutoff = now - windowMs;
    const want = String(callerIdentity ?? '');
    // Records may carry either the stable callerKey ("u:42") or the legacy
    // numeric callerId ("42"); match on both so dedup cannot be bypassed by a
    // record written before the identity model changed.
    const wantBare = want.replace(/^u:/, '');
    return this.callsForToken(chatId, chain, address)
      .find((c) => {
        if (!(c.calledAt > cutoff)) return false;
        // A synthetic record must never suppress a genuine call: a simulated
        // acceptance run would otherwise block the real member from being
        // recorded for the rest of the dedup window.
        if (isSynthetic(c)) return false;
        // Only an ACTIVE call blocks a new one: a cancelled call was withdrawn and
        // a superseded duplicate lost to the canonical record.
        if (!isActive(c)) return false;
        const keys = [c.callerKey, c.callerId].filter(Boolean).map(String);
        return keys.includes(want) || keys.includes(wantBare);
      }) ?? null;
  }

  /** Append a validated call record. */
  /**
   * Insert a call — ENFORCING one canonical call per (group, chain, contract).
   *
   * The uniqueness rule lives here, at the storage layer, not in a cooldown or in
   * UI filtering. Repeated scans of the same contract must not create new tracked
   * calls no matter how much time passes, and the original first caller, entry
   * market cap and timestamp must survive.
   *
   * All instances for this file share the document and persistence queue. The
   * synchronous existence check and push cannot interleave; only persistence
   * yields, after the canonical record is already visible to every instance.
   *
   * Returns { row, duplicate: true, existing } when the token is already tracked.
   */
  async addCall(record) {
    this.load();
    const chatId = String(record.chatId);
    const chain = record.chain;
    const normAddr = normaliseAddress(chain, record.address);
    const synthetic = record.source === SYNTHETIC_FLAG;

    // CHECK AND PUSH WITH NO AWAIT BETWEEN THEM.
    // Node runs this section without yielding, so two concurrent callers cannot
    // both observe "not tracked" and both insert: the existence check and the
    // push are one atomic step. Persisting afterwards is what is async, and
    // persist() serialises its own writes.
    //
    // A cancelled call does NOT reserve the token, so an accidental call cannot
    // permanently block a later legitimate first call.
    const existing = this.doc.calls.find((c) => c.chatId === chatId
      && c.chain === chain
      && normaliseAddress(chain, c.address) === normAddr
      && isActive(c)
      && (isSynthetic(c) === synthetic));

    if (existing) return { row: existing, duplicate: true, existing };

    this.doc.seq += 1;
    const row = {
      ...record,
      id: `c${this.doc.seq}`,
      chatId,
      calledAt: record.calledAt ?? Date.now(),
    };
    this.doc.calls.push(row);
    await this.persist();
    return { row, duplicate: false, existing: null };
  }

  /** Apply a partial update to one record (observations, cancellation, repair). */
  async updateCall(id, patch) {
    this.load();
    const i = this.doc.calls.findIndex((c) => c?.id === id);
    if (i === -1) return null;
    this.doc.calls[i] = { ...this.doc.calls[i], ...patch, updatedAt: Date.now() };
    await this.persist();
    return this.doc.calls[i];
  }

  // ---- alert state -------------------------------------------------------

  /**
   * Read one alert state row, or null.
   * Rows are keyed by a stable event id, so this is a plain map lookup.
   */
  alertState(eventId) {
    this.load();
    return this.doc.alerts?.[eventId] ?? null;
  }

  /** Has this exact alert already been delivered successfully? */
  alertDelivered(eventId) {
    return this.alertState(eventId)?.state === 'delivered';
  }

  /**
   * CLAIM an alert for delivery.
   *
   * Returns `{ claimed: true }` only if nothing has claimed or delivered this
   * event id. The claim is written synchronously before any await, so two
   * observers in one process cannot both win it.
   *
   * A row left in 'pending' by a crash is NOT automatically retried: re-sending a
   * possibly-delivered alert is worse than dropping one. `reclaimStale` exists for
   * an explicit operator decision instead of an automatic one.
   */
  async claimAlert(eventId, row) {
    this.load();
    const existing = this.doc.alerts[eventId];
    // 'ambiguous' is terminal: we could not tell whether Telegram delivered it, so
    // a retry risks a visible duplicate. 'failed' is retryable because the failure
    // was definite (nothing reached the group).
    if (existing && ['delivered', 'pending', 'ambiguous'].includes(existing.state)) {
      return { claimed: false, existing };
    }
    // Preserve the previous attempt count and history: resetting it on every claim
    // made a permanently-failing event look like a first attempt forever, so it
    // could be retried without limit.
    const priorAttempts = Number(existing?.attempts) || 0;
    if (existing?.state === 'failed' && priorAttempts >= MAX_ALERT_ATTEMPTS) {
      return { claimed: false, existing, exhausted: true };
    }
    // Telegram told us to wait. Refuse a claim that ignores that instruction, which
    // otherwise retried immediately and earned another 429.
    if (existing?.retryAt && Number(existing.retryAt) > Date.now()) {
      return { claimed: false, existing, tooSoon: true, retryAt: existing.retryAt };
    }
    this.doc.alerts[eventId] = {
      ...(existing ?? {}),
      ...row,
      eventId,
      state: 'pending',
      claimedAt: Date.now(),
      attempts: priorAttempts + 1,
      firstClaimedAt: existing?.firstClaimedAt ?? Date.now(),
    };
    await this.persist();
    return { claimed: true, existing: existing ?? null };
  }

  /** Mark a claimed alert delivered, recording the Telegram message id. */
  async markAlertDelivered(eventId, { messageId = null, at = Date.now() } = {}) {
    this.load();
    const cur = this.doc.alerts[eventId];
    if (!cur) return null;
    this.doc.alerts[eventId] = { ...cur, state: 'delivered', messageId, deliveredAt: at };
    await this.persist();
    return this.doc.alerts[eventId];
  }

  /**
   * Record a delivery failure.
   *
   * 'failed' is retryable (nothing reached Telegram, or Telegram said no).
   * 'ambiguous' means we could not tell whether the message was sent; it is never
   * retried automatically, because a duplicate alert looks worse than a missed one.
   */
  async markAlertFailed(eventId, { reason, ambiguous = false, at = Date.now() } = {}) {
    this.load();
    const cur = this.doc.alerts[eventId];
    if (!cur) return null;
    this.doc.alerts[eventId] = {
      ...cur,
      state: ambiguous ? 'ambiguous' : 'failed',
      failureReason: reason ?? null,
      failedAt: at,
      // Do NOT increment here: claimAlert already counted this attempt, and counting
      // twice per attempt made the budget meaningless.
      attempts: cur.attempts ?? 1,
    };
    await this.persist();
    return this.doc.alerts[eventId];
  }

  /** Set or update an arbitrary alert tracker row (dex paid, migration, movement). */
  async setAlertState(eventId, patch) {
    this.load();
    this.doc.alerts[eventId] = { ...(this.doc.alerts[eventId] ?? {}), ...patch, eventId };
    await this.persist();
    return this.doc.alerts[eventId];
  }

  /** Count alerts by state, for the observer's status line. */
  alertStats() {
    this.load();
    const out = { pending: 0, delivered: 0, failed: 0, ambiguous: 0 };
    for (const row of Object.values(this.doc.alerts ?? {})) {
      if (out[row.state] != null) out[row.state] += 1;
    }
    return out;
  }

  /**
   * Calls that still want observation.
   *
   * The default horizon is Infinity: calls are never retired. An earlier 7-day
   * default silently excluded an eight-day-old call from every alert query while
   * the observer itself still tracked it, so the two disagreed about what existed.
   */
  openCalls({ maxAgeMs = Infinity, now = Date.now() } = {}) {
    this.load();
    const cutoff = now - maxAgeMs;
    return this.doc.calls.filter((c) => isActive(c) && c.calledAt > cutoff);
  }

  /**
   * Delete a record outright. Used ONLY to clean up acceptance artefacts that were
   * inserted by mistake; normal history is never deleted (cancellation marks a
   * record instead, so the audit trail survives).
   */
  async removeCall(id) {
    this.load();
    const before = this.doc.calls.length;
    this.doc.calls = this.doc.calls.filter((c) => c.id !== id);
    const removed = before - this.doc.calls.length;
    if (removed) await this.persist();
    return removed;
  }

  stats() {
    this.load();
    return {
      schemaVersion: this.doc.schemaVersion,
      groups: Object.keys(this.doc.groups).length,
      calls: this.doc.calls.length,
      active: this.doc.calls.filter((c) => c.status === 'active').length,
      filePath: this.filePath,
      migrated: this.migrated,
    };
  }
}

/** Canonical address for comparison. Mirrors the scanner's identity rule. */
export function normaliseAddress(chain, address) {
  if (typeof address !== 'string') return '';
  // EVM addresses are case-insensitive; Solana base58 is not.
  return chain === 'solana' ? address : address.toLowerCase();
}

/** Simulated/test records are tagged so they can be filtered out of real stats. */
export const SYNTHETIC_FLAG = 'synthetic';

/**
 * The only status that represents a real, current call.
 *
 *   active      the canonical tracked call
 *   cancelled   withdrawn by the caller via /justscan
 *   superseded  a duplicate that lost to the canonical call during repair
 *
 * Every query that answers "what is tracked here" must use this, so the three
 * statuses cannot drift apart between callers, PnL, correction and the observer.
 */
export function isActive(call) {
  return call?.status === 'active';
}

/** True when a record came from a controlled scenario rather than a real caller. */
export function isSynthetic(call) {
  return call?.source === SYNTHETIC_FLAG;
}
