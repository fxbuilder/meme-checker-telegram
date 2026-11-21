/**
 * src/cooldown.mjs
 * Per-user and per-group cooldown + duplicate-response protection.
 *
 * Cooldown:  a user (or group+user) must wait USER_COOLDOWN_MS between scans.
 * Duplicate: the same CA in the same chat within DEDUP_WINDOW_MS returns nothing
 *            (avoid flooding when multiple members paste the same address).
 */

const USER_COOLDOWN_MS = 15_000;   // 15 s per user
const DEDUP_WINDOW_MS  = 60_000;   // 60 s same CA in same chat

/** Map<key, timestamp> */
const userLastScan  = new Map();
const dedupCache    = new Map();

function userKey(userId, chatId)   { return `u:${userId}:c:${chatId}`; }
// Do NOT lowercase here: detect-ca.mjs already lowercases EVM; Solana is case-sensitive.
function dedupKey(chatId, address) { return `d:${chatId}:${address}`; }

function pruneMap(map, windowMs) {
  const cutoff = Date.now() - windowMs;
  for (const [k, ts] of map) {
    if (ts < cutoff) map.delete(k);
  }
}

/**
 * Returns null if the scan should proceed, or a string reason if it must be skipped.
 * Pass dryRun=true to check without recording.
 */
export function checkCooldown({ userId, chatId, address, dryRun = false }) {
  pruneMap(userLastScan, USER_COOLDOWN_MS);
  pruneMap(dedupCache,   DEDUP_WINDOW_MS);

  const uk = userKey(userId, chatId);
  const dk = dedupKey(chatId, address);
  const now = Date.now();

  const lastUser = userLastScan.get(uk) ?? 0;
  if (now - lastUser < USER_COOLDOWN_MS) {
    const wait = Math.ceil((USER_COOLDOWN_MS - (now - lastUser)) / 1000);
    return { blocked: true, reason: 'cooldown', waitSeconds: wait };
  }

  if (dedupCache.has(dk)) {
    return { blocked: true, reason: 'duplicate' };
  }

  if (!dryRun) {
    userLastScan.set(uk, now);
    dedupCache.set(dk, now);
  }
  return { blocked: false };
}

/** Call after a scan completes to register the dedup entry separately if needed. */
export function registerScan({ userId, chatId, address }) {
  const uk = userKey(userId, chatId);
  const dk = dedupKey(chatId, address);
  userLastScan.set(uk, Date.now());
  dedupCache.set(dk, Date.now());
}
