/**
 * src/caller-identity.mjs
 * Resolve WHO sent a message, from the real Telegram update shape.
 *
 * WHY THIS IS NOT JUST `ctx.from.id`
 * Telegram puts a FAKE sender in `from` whenever a message is sent on behalf of a
 * chat. Verified in the official Bot API changelog and the Message type:
 *
 *   from.id 1087968824 = @GroupAnonymousBot  — anonymous group administrator
 *   from.id 136817688  = @Channel_Bot        — posted on behalf of a channel
 *   from.id 777000     = Telegram service    — auto-forwarded channel post
 *
 * In all three cases `from` is a placeholder and `sender_chat` carries the real
 * identity. Attributing those messages to the placeholder would credit an
 * anonymous admin's call to a bot user id shared by every group on Telegram —
 * an attribution bug that silently corrupts a leaderboard.
 *
 * IDENTITY MODEL
 *   callerKey  — the stable database identity, scoped to the group:
 *                `u:<userId>`     ordinary user
 *                `c:<chatId>`     anonymous admin (the supergroup itself)
 *                `c:<channelId>`  posted as a channel
 *   display    — human label only, never a primary key
 *
 * Anonymous admins of one group cannot be told apart from each other: their
 * sender_chat IS the group. That is a Telegram limitation, recorded here so it is
 * not mistaken for a bug in our code.
 */

/** Placeholder user ids Telegram uses when a message is sent on behalf of a chat. */
export const PLACEHOLDER_USER_IDS = new Set([
  1087968824, // @GroupAnonymousBot — anonymous group admin
  136817688,  // @Channel_Bot — sent as a channel
  777000,     // Telegram service — auto-forwarded channel post
]);

/**
 * Resolve the author of a message.
 *
 * @returns {{
 *   kind: 'user'|'anonymous_admin'|'channel'|'unknown',
 *   callerKey: string|null,
 *   userId: string|null,
 *   senderChatId: string|null,
 *   displayName: string,
 *   username: string|null,
 *   isAnonymous: boolean,
 *   placeholders: boolean,
 *   attributionNote: string|null
 * }}
 */
export function resolveCaller(message, chat) {
  const from = message?.from ?? null;
  const senderChat = message?.sender_chat ?? null;
  const chatId = chat?.id ?? null;

  const fromId = from?.id != null ? Number(from.id) : null;
  const isPlaceholder = fromId != null && PLACEHOLDER_USER_IDS.has(fromId);

  // ---- 1. Sent on behalf of a chat: sender_chat is authoritative ----------
  if (senderChat && (isPlaceholder || !from || from.is_bot)) {
    const scId = senderChat.id != null ? Number(senderChat.id) : null;
    const isGroupItself = scId != null && chatId != null && scId === Number(chatId);

    // Anonymous admin posts as the group; a channel post carries the channel id.
    const kind = isGroupItself ? 'anonymous_admin' : 'channel';
    const display = isGroupItself
      ? (chat?.title ?? senderChat.title ?? 'Anonymous admin')
      : (senderChat.title ?? 'Channel');

    return {
      kind,
      callerKey: scId != null ? `c:${scId}` : null,
      userId: null,
      senderChatId: scId != null ? String(scId) : null,
      displayName: display,
      username: senderChat.username ?? null,
      isAnonymous: isGroupItself,
      placeholders: isPlaceholder,
      attributionNote: isGroupItself
        ? 'Anonymous admin — Telegram attributes this to the group itself, so individual anonymous admins cannot be separated.'
        : 'Posted on behalf of a channel.',
    };
  }

  // ---- 2. A placeholder with no sender_chat: do NOT attribute to it ------
  if (isPlaceholder) {
    return {
      kind: 'unknown',
      callerKey: null,
      userId: null,
      senderChatId: null,
      displayName: 'Unknown sender',
      username: null,
      isAnonymous: false,
      placeholders: true,
      attributionNote: 'Telegram reported only a placeholder sender and no sender_chat, so this call has no reliable author.',
    };
  }

  // ---- 3. Ordinary user --------------------------------------------------
  if (from?.id != null) {
    const name = [from.first_name, from.last_name].filter(Boolean).join(' ').trim();
    const display = name || (from.username ? `@${from.username}` : `user ${from.id}`);
    return {
      kind: 'user',
      callerKey: `u:${from.id}`,
      userId: String(from.id),
      senderChatId: null,
      displayName: display,
      username: from.username ?? null,
      isAnonymous: false,
      placeholders: false,
      attributionNote: null,
    };
  }

  return {
    kind: 'unknown',
    callerKey: null,
    userId: null,
    senderChatId: null,
    displayName: 'Unknown sender',
    username: null,
    isAnonymous: false,
    placeholders: false,
    attributionNote: 'Message has no identifiable sender.',
  };
}

/** Is this a key that can own attribution? */
export function isAttributable(identity) {
  return Boolean(identity?.callerKey);
}

/**
 * Readable label for a stored call, from whatever fields it has.
 * Prefers the stored display name, falling back to the key so an old record is
 * still attributable rather than showing "unknown".
 */
export function callerLabel(call) {
  if (!call) return 'unknown';
  if (call.callerName) return call.callerName;
  if (call.callerUsername) return `@${call.callerUsername}`;
  if (call.callerKey?.startsWith('c:')) return 'Anonymous admin';
  return 'unknown';
}
