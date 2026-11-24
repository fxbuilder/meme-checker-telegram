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

export const SCHEMA_VERSION = 1;

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

  // Future: if (doc.schemaVersion < 2) { ...doc.schemaVersion = 2; migrated = true; }

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
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

export class CallStore {
  constructor(filePath = defaultStorePath()) {
    this.filePath = filePath;
    this.doc = emptyDoc();
    this.loaded = false;
    this.writeQueue = Promise.resolve();
    this.migrated = false;
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
      if (c.status === 'cancelled') return false;
      if (isSynthetic(c)) return false;
      return normaliseAddress(c.chain, c.address) === normaliseAddress(c.chain, addr);
    }).sort((a, b) => b.calledAt - a.calledAt);
  }

  /** Distinct chains among the recorded calls for one address in one group. */
  recordedChainsForAddress(chatId, address) {
    return [...new Set(this.recordedCallsForAddress(chatId, address).map((c) => c.chain))];
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
        && c.status !== 'cancelled'
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
        // A cancelled call was withdrawn, so it must not block a fresh one.
        if (c.status === 'cancelled') return false;
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
   * Insertion is serialised through `writeQueue` so two concurrent updates for the
   * same token cannot both pass the existence check and then both insert — the
   * check and the push happen inside one queued section.
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
      && c.status !== 'cancelled'
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
    const i = this.doc.calls.findIndex((c) => c.id === id);
    if (i === -1) return null;
    this.doc.calls[i] = { ...this.doc.calls[i], ...patch, updatedAt: Date.now() };
    await this.persist();
    return this.doc.calls[i];
  }

  /** Calls that still want observation (not cancelled, not older than `maxAgeMs`). */
  openCalls({ maxAgeMs = 7 * 24 * 3600_000, now = Date.now() } = {}) {
    this.load();
    const cutoff = now - maxAgeMs;
    return this.doc.calls.filter((c) => c.status === 'active' && c.calledAt > cutoff);
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

/** True when a record came from a controlled scenario rather than a real caller. */
export function isSynthetic(call) {
  return call?.source === SYNTHETIC_FLAG;
}
