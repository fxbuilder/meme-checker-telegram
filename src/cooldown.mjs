/**
 * src/cooldown.mjs
 * Per-user scan pacing, concurrent coalescing, and honest feedback.
 *
 * WHAT WAS WRONG
 * A 15 s per-user cooldown plus a 60 s "same CA in this chat" window that returned
 * SILENTLY. The OWNER pasted the same token three times and received nothing: the second
 * and third pastes hit the duplicate branch, which produced no message, no card and no
 * error. A user cannot distinguish a broken bot from one ignoring them.
 *
 * Two responsibilities were fused and must not be:
 *
 *   pacing      - "do not let one user hammer the providers". Real; keep it, but short.
 *   suppression - "do not reply twice for the same token". This was the harmful part. A
 *                 repeated scan is a NORMAL action (checking for an update), and a cached
 *                 scan costs nothing anyway.
 *
 * WHAT IT DOES NOW
 *   - Group per-user: 3 s. Private chat: 1 s. Both env-configurable.
 *   - OWNER bypasses per-user pacing (staging and testing).
 *   - A repeat address is no longer dropped: it is allowed through and served from the
 *     scan/research cache. Duplicate TRACKED CALLS are prevented by the store, which is
 *     the right layer for that rule.
 *   - Concurrent identical scans are COALESCED, so the second paste awaits the first
 *     result instead of issuing a parallel provider request.
 *   - When genuinely paced, the reply states how long. Silence is never the answer.
 */

/** Group per-user pacing. Short on purpose: a repeat check is a normal user action. */
const GROUP_COOLDOWN_MS = Math.max(0, Number(process.env.GROUP_COOLDOWN_MS ?? 3_000) || 0);
/** Private-chat pacing. Shorter still: a DM has no audience to flood. */
const PRIVATE_COOLDOWN_MS = Math.max(0, Number(process.env.PRIVATE_COOLDOWN_MS ?? 1_000) || 0);

/** Map<key, timestamp> for user pacing. */
const userLastScan = new Map();
/** Map<coalesceKey, Promise> for in-flight scans. */
const inflight = new Map();

function userKey(userId, chatId) { return `u:${userId}:c:${chatId}`; }

/**
 * Coalescing key. Not lowercased blindly: detect-ca already lowercases EVM addresses,
 * and Solana addresses are case-sensitive.
 */
function coalesceKey(chatId, chain, address) { return `s:${chatId}:${chain}:${address}`; }

function pruneMap(map, windowMs) {
  const cutoff = Date.now() - windowMs;
  for (const [k, ts] of map) {
    if (ts < cutoff) map.delete(k);
  }
}

/** Is this user exempt from per-user pacing? */
export function isPacingExempt({ userId, ownerIds = [] } = {}) {
  if (!userId) return false;
  return (ownerIds ?? []).map(String).includes(String(userId));
}

/**
 * Decide whether this scan may start.
 *
 * `isPrivate` selects the shorter private-chat interval. A duplicate address is NOT a
 * blocking reason any more - see the module comment.
 *
 * @returns {{blocked:boolean, reason?:string, waitSeconds?:number}}
 */
export function checkCooldown({
  userId, chatId, address, isPrivate = false, ownerIds = [],
} = {}) {
  const windowMs = isPrivate ? PRIVATE_COOLDOWN_MS : GROUP_COOLDOWN_MS;
  // Prune against a floor so a zero/one-second window cannot leave stale entries that
  // never expire.
  pruneMap(userLastScan, Math.max(windowMs, 1_000));

  if (isPacingExempt({ userId, ownerIds })) return { blocked: false };

  const now = Date.now();
  const uk = userKey(userId, chatId);
  const last = userLastScan.get(uk) ?? null;

  // `null`, not 0: a clock reading legitimately zero must not look like "never scanned".
  if (last !== null && now - last < windowMs) {
    const waitMs = windowMs - (now - last);
    return {
      blocked: true,
      reason: 'cooldown',
      // Ceil so a sub-second remainder reads as "1s", never "0s".
      waitSeconds: Math.max(1, Math.ceil(waitMs / 1000)),
    };
  }

  userLastScan.set(uk, now);
  return { blocked: false };
}

/** Record a completed scan, so pacing is measured from completion. */
export function registerScan({ userId, chatId, address }) {
  userLastScan.set(userKey(userId, chatId), Date.now());
}

/**
 * Run `fn` at most once for concurrent identical scans in the same chat.
 *
 * The second caller awaits the first caller's promise instead of issuing a duplicate
 * provider request. This replaces silently dropping the request, which produced no
 * answer at all rather than a result.
 */
export async function coalesceScan({ chatId, chain, address }, fn) {
  const key = coalesceKey(chatId, chain, address);
  const existing = inflight.get(key);
  if (existing) {
    try {
      const shared = await existing;
      return { ...shared, coalesced: true };
    } catch {
      // The leader failed; fall through and let this caller try for itself.
    }
  }

  const p = (async () => fn())();
  inflight.set(key, p);
  try {
    return await p;
  } finally {
    if (inflight.get(key) === p) inflight.delete(key);
  }
}

/** Feedback text for a genuinely paced request. Silence is never the answer. */
export function cooldownMessage(waitSeconds) {
  return `\u23F3 One moment \u2014 you can scan again in ${waitSeconds}s.`;
}

/** Test hooks. */
export function _reset() {
  userLastScan.clear();
  inflight.clear();
}

/** Current pacing values, for /help and diagnostics. */
export function pacingConfig() {
  return { groupMs: GROUP_COOLDOWN_MS, privateMs: PRIVATE_COOLDOWN_MS };
}
