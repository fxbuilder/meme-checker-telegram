/**
 * src/pnl-background.mjs
 * Per-user PnL card background.
 *
 * WHY A file_id AND NOT A DOWNLOADED IMAGE
 * The PnL card is SHAREABLE — users post it into groups. Two consequences decide the design:
 *
 *   1. A background that embeds a bot-token download URL would leak the credential into every
 *      image anyone shares. Telegram `file_id`s are opaque handles resolved with the bot's own
 *      authenticated API call, so nothing sensitive ever travels inside the picture.
 *   2. Downloading and storing bytes per user means unbounded disk growth and a cleanup
 *      problem nobody asked for. A file_id is a few dozen bytes.
 *
 * The trade-off is that a file_id is only valid for THIS bot, which is exactly right here: the
 * background is used exclusively by this bot's own renderer.
 *
 * Images are validated by content type and size BEFORE being stored, and a rejected upload says
 * why. A user who sends a PDF gets a clear message rather than a silently ignored message.
 */

import fs from 'node:fs';
import path from 'node:path';

/** Telegram's photo limits; documented so the rejection message can state them. */
export const PNL_BG_LIMITS = {
  maxBytes: 5 * 1024 * 1024,
  accepted: ['image/jpeg', 'image/png', 'image/webp'],
  helpText: 'JPEG, PNG or WebP up to 5 MB.',
};

/**
 * Choose the largest photo size Telegram offers.
 *
 * Telegram sends `photo` as an array of sizes, ascending. Taking `[0]` yields a thumbnail that
 * stretches badly behind a 800x500 card, so the largest is used deliberately.
 */
export function pickLargestPhoto(message) {
  const sizes = message?.photo;
  if (!Array.isArray(sizes) || !sizes.length) return null;
  return [...sizes].sort((a, b) => (b?.file_size ?? 0) - (a?.file_size ?? 0))[0] ?? null;
}

/** A file sent as a document keeps its exact bytes; acceptable if it is a real image. */
export function pickDocumentImage(message) {
  const doc = message?.document;
  if (!doc) return null;
  const mime = String(doc.mime_type ?? '').toLowerCase();
  if (!PNL_BG_LIMITS.accepted.includes(mime)) return { rejected: `Unsupported file type${mime ? ` (${mime})` : ''}` };
  if (Number.isFinite(doc.file_size) && doc.file_size > PNL_BG_LIMITS.maxBytes) {
    return { rejected: 'Image is too large' };
  }
  return doc;
}

/**
 * Persisted per-user backgrounds.
 *
 * Shape: { [userId]: { fileId, uniqueId, setAt } }
 *
 * `uniqueId` is Telegram's stable media identifier. Storing it lets a caller tell whether the
 * user replaced the image or re-sent the same one, which is what makes "updated" wording honest.
 */
export class PnlBackgroundStore {
  constructor({ file = null, fsImpl = fs } = {}) {
    this.file = file;
    this.fs = fsImpl;
    this.map = new Map();
    this.loaded = false;
  }

  load() {
    if (this.loaded) return this;
    this.loaded = true;
    if (!this.file) return this;
    try {
      const raw = this.fs.readFileSync(this.file, 'utf8');
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object') {
        for (const [k, v] of Object.entries(parsed)) {
          if (v && typeof v.fileId === 'string' && v.fileId) this.map.set(String(k), v);
        }
      }
    } catch {
      // A corrupt or missing file starts clean. The feature is cosmetic: failing to read it must
      // never block a /pnl render, so this deliberately does not throw.
    }
    return this;
  }

  #persist() {
    if (!this.file) return;
    try {
      this.fs.mkdirSync(path.dirname(this.file), { recursive: true });
      this.fs.writeFileSync(this.file, JSON.stringify(Object.fromEntries(this.map), null, 2));
    } catch {
      // Best-effort: an unwritable store degrades to in-memory for this process.
    }
  }

  /** @returns {{fileId:string, uniqueId?:string, setAt:number}|null} */
  get(userId) {
    this.load();
    return this.map.get(String(userId)) ?? null;
  }

  set(userId, { fileId, uniqueId = null }) {
    this.load();
    if (!fileId || typeof fileId !== 'string') return false;
    const prior = this.map.get(String(userId));
    if (prior && prior.fileId === fileId) return { changed: false, entry: prior };
    const entry = { fileId, uniqueId, setAt: Date.now() };
    this.map.set(String(userId), entry);
    this.#persist();
    return { changed: true, entry };
  }

  reset(userId) {
    this.load();
    const had = this.map.has(String(userId));
    this.map.delete(String(userId));
    if (had) this.#persist();
    return had;
  }

  size() {
    this.load();
    return this.map.size;
  }
}

/**
 * Resolve the background to use for a render.
 *
 * Returns null when the user has no background, which the renderer treats as "use the default
 * gradient". Absence is a normal state, not an error.
 */
export function backgroundFor(store, userId) {
  if (!store) return null;
  const entry = store.get(userId);
  return entry?.fileId ?? null;
}

/** The confirmation copy for a successful set. */
export function setConfirmation({ changed }) {
  return changed
    ? '✅ <b>PnL background updated.</b>\nYour next <code>/pnl</code> card will use it.'
    : 'ℹ️ That image is already your PnL background.';
}

/** The rejection copy, stating the limits rather than just refusing. */
export function rejectionMessage(reason = null) {
  return `❌ ${reason ? `${reason}. ` : ''}Send a JPEG, PNG or WebP image up to 5 MB.`;
}
