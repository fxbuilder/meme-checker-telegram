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
