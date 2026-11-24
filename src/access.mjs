/**
 * src/access.mjs
 * WHO may do WHAT, per chat.
 *
 * Two independent gates, deliberately separate:
 *
 *  1. GROUP ALLOWLIST — during staging the bot must only act in the authorised
 *     OWNER-only test group. Any other chat is ignored entirely (no scan, no
 *     reply, no call record). This is a staging safety rail, not a product
 *     permission model.
 *
 *  2. SETTINGS AUTHORITY — /callsettings changes group-wide state, so it is
 *     restricted to the OWNER while staging. Ordinary members must not be able to
 *     switch auto-call on or change the market-cap floor.
 *
 * Phase 6 will replace gate 2 with real Telegram group-admin checks
 * (getChatMember). Until then the owner is identified by numeric user id, which
 * the Bot API does report reliably.
 */

/** Parse a comma-separated id list from env into a Set of strings. */
function parseIds(raw) {
  return new Set(
    String(raw ?? '')
      .split(/[,\s]+/)
      .map((s) => s.trim())
      .filter(Boolean),
  );
}

/**
 * Resolve access policy from the environment.
 * OWNER_USER_IDS and ALLOWED_CHAT_IDS are the two switches.
 */
export function loadPolicy(env = process.env) {
  return {
    ownerIds: parseIds(env.OWNER_USER_IDS ?? env.OWNER_USER_ID ?? ''),
    allowedChatIds: parseIds(env.ALLOWED_CHAT_IDS ?? env.TELEGRAM_TEST_GROUP_ID ?? ''),
    // When true, an empty allowlist means "no restriction" (developer convenience).
    // Defaults to false so an unconfigured deploy cannot act anywhere by accident.
    allowAnyChat: String(env.ALLOW_ANY_CHAT ?? '').toLowerCase() === 'true',
  };
}

/** Is this user the owner? */
export function isOwner(policy, userId) {
  if (userId == null || !(policy?.ownerIds instanceof Set)) return false;
  return policy.ownerIds.has(String(userId));
}

/**
 * May the bot act in this chat at all?
 * Returns { allowed, reason }.
 */
export function isChatAllowed(policy, chatId) {
  if (chatId == null) return { allowed: false, reason: 'no chat id' };
  if (policy.allowAnyChat) return { allowed: true, reason: null };
  if (!policy.allowedChatIds.size) {
    // Nothing configured: refuse rather than silently acting everywhere.
    return { allowed: false, reason: 'no ALLOWED_CHAT_IDS configured' };
  }
  return policy.allowedChatIds.has(String(chatId))
    ? { allowed: true, reason: null }
    : { allowed: false, reason: `chat ${chatId} is not in ALLOWED_CHAT_IDS` };
}

/**
 * May this user change GROUP-WIDE settings?
 * Staging rule: owner only. A group admin is NOT sufficient yet, because the bot
 * does not verify admin status — allowing any admin claim would be worse.
 */
export function canChangeSettings(policy, { userId }) {
  if (isOwner(policy, userId)) return { allowed: true, reason: null };
  return {
    allowed: false,
    reason: 'Staging: only the bot owner can change group call settings. '
      + 'Group-admin permissions arrive in Phase 6.',
  };
}

/** A human-readable summary for startup logs and /callsettings output. */
export function describePolicy(policy) {
  return {
    owners: [...policy.ownerIds],
    allowedChats: [...policy.allowedChatIds],
    allowAnyChat: policy.allowAnyChat,
  };
}
