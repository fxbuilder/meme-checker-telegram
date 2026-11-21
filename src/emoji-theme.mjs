/**
 * src/emoji-theme.mjs
 * Optional custom-emoji theming for Telegram HTML messages.
 *
 * Usage:
 *   import { buildEmojiTheme, noTheme } from './emoji-theme.mjs';
 *
 *   // With a custom map (custom_emoji_id values from Telegram):
 *   const e = buildEmojiTheme({ '🚀': '5368324170671202286', '🪙': '...' });
 *
 *   // Without a theme (standard emoji passthrough):
 *   const e = noTheme;
 *
 *   // In card text:
 *   `${e('🚀')} <b>MEME CHECKER</b>`
 *   // → with theme:    <tg-emoji emoji-id="5368324170671202286">🚀</tg-emoji> <b>MEME CHECKER</b>
 *   // → without theme: 🚀 <b>MEME CHECKER</b>
 *
 * Note: <tg-emoji> renders only when the bot owner has Telegram Premium.
 * Standard emoji is always the automatic fallback and the default.
 */

/** Identity fallback — returns standard emoji unchanged. */
export function noTheme(standard) { return standard; }

/**
 * Build an emoji resolver from a {standard: custom_emoji_id} map.
 * Returns noTheme when the map is empty or invalid.
 * Each resolved emoji becomes <tg-emoji emoji-id="ID">standard</tg-emoji>.
 */
export function buildEmojiTheme(customMap) {
  if (!customMap || typeof customMap !== 'object' || !Object.keys(customMap).length) {
    return noTheme;
  }
  // Validate: IDs must be numeric strings (Telegram custom_emoji_id format).
  const validated = {};
  for (const [std, id] of Object.entries(customMap)) {
    if (typeof id === 'string' && /^\d+$/.test(id.trim())) {
      validated[std] = id.trim();
    }
  }
  if (!Object.keys(validated).length) return noTheme;

  return function emojiTheme(standard) {
    const id = validated[standard];
    if (!id) return standard;
    // emoji-id attr is a plain integer string — no escaping needed.
    return `<tg-emoji emoji-id="${id}">${standard}</tg-emoji>`;
  };
}

/**
 * Load a theme from the EMOJI_THEME env var (JSON object string).
 * Returns noTheme on any parse or validation failure.
 * Never throws.
 */
export function loadEnvTheme() {
  const raw = process.env.EMOJI_THEME ?? '';
  if (!raw.trim()) return noTheme;
  try {
    const map = JSON.parse(raw);
    return buildEmojiTheme(map);
  } catch {
    console.warn('[emoji-theme] EMOJI_THEME is set but could not be parsed as JSON — using standard emoji.');
    return noTheme;
  }
}

/**
 * Render a preview of the theme against the standard emoji set used in cards.
 * Returns a plain-text table string (safe to log or send as a Telegram message).
 */
export function previewTheme(e) {
  const CARD_EMOJI = ['🚀','🪙','⛓','📍','💰','📊','🧠','🌐','🔎','👉','🔒','⚡','⚠️','⏳'];
  const rows = CARD_EMOJI.map(std => `${std} → ${e(std)}`);
  return rows.join('\n');
}

/** The standard emoji slots used in cards, in order. */
export const CARD_EMOJI_SLOTS = ['🚀','🪙','⛓','📍','💰','📊','🧠','🌐','🔎','👉','🔒','⚡','⚠️','⏳'];

/**
 * Extract all custom_emoji_id values from a Telegram message entity array.
 * Returns a deduplicated array of ID strings.
 */
export function extractCustomEmojiIds(entities) {
  if (!Array.isArray(entities)) return [];
  const ids = [];
  const seen = new Set();
  for (const ent of entities) {
    if (ent.type === 'custom_emoji' && ent.custom_emoji_id && !seen.has(ent.custom_emoji_id)) {
      seen.add(ent.custom_emoji_id);
      ids.push(ent.custom_emoji_id);
    }
  }
  return ids;
}

/**
 * Detect a Telegram emoji-pack link from message text.
 * Accepts both https://t.me/addemoji/PACK and t.me/addemoji/PACK formats.
 * Returns the pack name string, or null if not found.
 */
export function detectPackLink(text) {
  if (typeof text !== 'string') return null;
  const m = text.match(/(?:https?:\/\/)?t\.me\/addemoji\/([A-Za-z0-9_]+)/i);
  return m ? m[1] : null;
}

/**
 * Build a pending theme map assigning resolved IDs to card slots by alt-emoji.
 * stickers: array of objects with .emoji (standard) and .custom_emoji_id.
 * Returns a {standard: id} map for the slots that matched.
 *
 * NOTE: pack alt-emoji are unreliable labels (CryptoIcons has Solana tagged 🧬).
 * For packs with misleading alt-emoji, use buildIndexedMap instead.
 */
export function buildPendingMap(stickers) {
  if (!Array.isArray(stickers) || !stickers.length) return {};
  const map = {};
  for (const s of stickers) {
    if (s?.custom_emoji_id && typeof s.emoji === 'string') {
      map[s.emoji] = s.custom_emoji_id;
    }
  }
  return map;
}

/**
 * List pack stickers with their index, alt-emoji, and custom_emoji_id.
 * Returns an array of { index, emoji, custom_emoji_id } for all stickers that have an ID.
 * Use this to identify logos by visual position when alt-emoji are unreliable.
 */
export function listPackStickers(stickers) {
  if (!Array.isArray(stickers)) return [];
  return stickers
    .map((s, i) => ({ index: i, emoji: s?.emoji ?? '', custom_emoji_id: s?.custom_emoji_id ?? null }))
    .filter(s => s.custom_emoji_id);
}

/**
 * Build a theme map directly from a slot→id object provided by the owner.
 * slotMap: { 'standard_emoji': 'custom_emoji_id', ... }
 * This is the preferred path when IDs are already known (e.g. pre-resolved by @mc-lead).
 * Validates IDs are numeric strings; silently drops invalid entries.
 */
export function buildDirectMap(slotMap) {
  if (!slotMap || typeof slotMap !== 'object') return {};
  const map = {};
  for (const [std, id] of Object.entries(slotMap)) {
    if (typeof id === 'string' && /^\d+$/.test(id.trim())) {
      map[std] = id.trim();
    }
  }
  return map;
}
