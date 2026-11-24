/**
 * src/deep-link.mjs
 * Short, opaque deep-link tokens for caller profiles.
 *
 * REQUIREMENTS DRIVING THE DESIGN
 *   - startapp/start payload is limited to 64 characters, and `A-Za-z0-9_-` only
 *   - the payload must not leak a user id or a group id in a readable form
 *     (a guessed or forwarded link must not become a directory of group members)
 *   - a link must resolve to the caller AND the group it was minted for, so the
 *     same person gets different tokens in different groups
 *   - it must survive a restart, so the mapping is persisted, not in-memory
 *
 * FORMAT
 *   payload = "cp_" + base64url(HMAC-SHA256(secret, scope)[0..N])
 * The scope is `${chatId}:${callerKey}:${period}`. The token is therefore:
 *   - deterministic (no expiry bookkeeping, no random store growth)
 *   - unguessable without the secret
 *   - self-scoping: the server recomputes the HMAC for a candidate and only
 *     accepts an exact match
 *
 * RESOLUTION is by comparison, not by lookup: the bot recomputes the token for
 * each known (chat, caller) pair in that group and matches. That is O(callers in
 * the group) and avoids trusting a client-supplied identifier at all.
 *
 * ACCESS
 * During staging the profile is OWNER-only. Phase 6 adds membership verification
 * via getChatMember; the limitation is documented in docs/phase2-caller-profile.md.
 */

import crypto from 'node:crypto';

/** Telegram's documented start-payload ceiling. */
export const MAX_PAYLOAD_LEN = 64;
const PREFIX = 'cp_';
/** Bytes of HMAC kept. 12 bytes = 96 bits, 16 base64url chars: ample against guessing. */
const TOKEN_BYTES = 12;

/**
 * The signing secret. Derived from an env value when present so tokens survive a
 * restart; otherwise a per-process random secret is used (tokens then stop
 * resolving after a restart, which is safe but less convenient).
 */
let cachedSecret = null;
export function signingSecret(env = process.env) {
  const configured = (env.CALLER_LINK_SECRET ?? '').trim();
  if (configured) {
    // Domain-separate so the raw env value is never used directly as the key.
    return crypto.createHash('sha256').update(`mc-caller-link:${configured}`).digest();
  }
  if (!cachedSecret) {
    cachedSecret = crypto.randomBytes(32);
    console.warn('[deep-link] CALLER_LINK_SECRET is not set; caller links will not survive a restart.');
  }
  return cachedSecret;
}

/** Test hook so a suite can reset the per-process secret. */
export function resetSecretForTests() {
  cachedSecret = null;
}

function b64url(buf) {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** Scope string for a caller in a group for a period. */
export function scopeFor(chatId, callerKey, period = '7d') {
  return `${chatId}:${callerKey}:${period}`;
}

/**
 * Mint a payload for one (chat, caller, period).
 * Returns a string guaranteed to fit Telegram's payload limit.
 */
export function mintCallerToken(chatId, callerKey, period = '7d', { secret = signingSecret() } = {}) {
  if (chatId == null || !callerKey) throw new Error('chatId and callerKey are required');
  const mac = crypto.createHmac('sha256', secret).update(scopeFor(chatId, callerKey, period)).digest();
  const payload = PREFIX + b64url(mac.subarray(0, TOKEN_BYTES));
  if (payload.length > MAX_PAYLOAD_LEN) throw new Error(`payload over ${MAX_PAYLOAD_LEN} chars`);
  return payload;
}

/** Full t.me link for a payload. */
export function callerDeepLink(botUsername, payload) {
  if (!botUsername) return null;
  return `https://t.me/${botUsername}?start=${encodeURIComponent(payload)}`;
}

/** Is this string shaped like one of our payloads? */
export function looksLikeCallerToken(s) {
  return typeof s === 'string' && s.startsWith(PREFIX) && /^[A-Za-z0-9_-]+$/.test(s);
}

/**
 * Resolve a payload back to a caller.
 *
 * `candidates` is the set of callerKeys known in the group: [{ callerKey }].
 * Returns { callerKey, period } or null. Comparison is constant-time per
 * candidate so timing cannot be used to narrow the space.
 */
export function resolveCallerToken(payload, chatId, candidates, {
  periods = ['1d', '7d', '14d', '30d'],
  secret = signingSecret(),
} = {}) {
  if (!looksLikeCallerToken(payload) || chatId == null) return null;
  for (const { callerKey } of candidates ?? []) {
    for (const period of periods) {
      let expected;
      try { expected = mintCallerToken(chatId, callerKey, period, { secret }); }
      catch { continue; }
      const a = Buffer.from(payload);
      const b = Buffer.from(expected);
      if (a.length === b.length && crypto.timingSafeEqual(a, b)) {
        return { callerKey, period };
      }
    }
  }
  return null;
}
