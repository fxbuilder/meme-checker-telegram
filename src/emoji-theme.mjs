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
 * Pre-resolved CryptoIcons (t.me/addemoji/CryptoIcons) expanded theme map.
 * Identified by sticker index (not unreliable alt-emoji).
 * Uncovered slots (📊 🧠 🔎 👉 🔒 ⚠️ ⏳ 🪙 ⛓ 📍) keep standard emoji fallback.
 * Apply via EMOJI_THEME env or the DM approval flow.
 */
export const CRYPTO_ICONS_MAP = {
  '🚀': '5292284235711784694',  // Rocket header           (CryptoIcons i194)
  '🟣': '5291923604487808793',  // Solana logo             (CryptoIcons i34)
  '🟡': '5291751363414336197',  // BNB gold diamond        (CryptoIcons i23)
  // 💰 (bar-chart) removed — user override: Market Data now uses 📊 from RestrictedEmoji
  '🌐': '5402068075153476626',  // Globe / Project header  (CryptoIcons i92)
  '🌍': '5402068075153476626',  // Globe / Website link    (CryptoIcons i92, reused)
  '✖️': '5195042564062865767',  // X logo                  (CryptoIcons i138)
  '✈️': '5291812201626084541',  // Telegram paper plane    (CryptoIcons i130)
  '⚡': '5291824180289872393',  // Lightning / Footer      (CryptoIcons i152)
};

/**
 * Resolved utility icons from RestrictedEmoji + SM Animated packs.
 * All verified is_animated=true.
 * Keys use the pack's exact strings (with variation selector U+FE0F where present).
 * buildEmojiTheme automatically aliases bare/styled forms.
 */
export const UTILITY_ICONS_MAP = {
  '📊':  '5431577498364158238',  // Market Data    (RestrictedEmoji)
  '👥':  '5372926953978341366',  // Holders        (RestrictedEmoji)
  '🧠':  '5237799019329105246',  // Narrative      (RestrictedEmoji)
  '🔎':  '5188311512791393083',  // DYOR           (RestrictedEmoji)
  '🔐':  '5472308992514464048',  // Premium        (RestrictedEmoji)
  '❗️': '5467928559664242360',  // Warning        (RestrictedEmoji, with VS16)
  '⏳':  '5451732530048802485',  // Cooldown       (RestrictedEmoji)
  '⛓️': '5318757666800031348',  // Chain          (RestrictedEmoji, with VS16)
  '➡️': '5321300317504030049',  // Full Analysis  (SM Animated, with VS16)
  '📌':  '5321006159488892145',  // CA pin         (SM Animated)
};

/**
 * Complete combined theme: CryptoIcons logos + RestrictedEmoji utilities + SM Animated.
 * Apply this map via the DM approval flow or EMOJI_THEME env after user approval.
 */
export const FULL_THEME_MAP = {
  ...CRYPTO_ICONS_MAP,
  ...UTILITY_ICONS_MAP,
};

/**
 * Build an emoji resolver from a {standard: custom_emoji_id} map.
 * Returns noTheme when the map is empty or invalid.
 * Each resolved emoji becomes <tg-emoji emoji-id="ID">standard</tg-emoji>.
 *
 * Variation-selector aliasing: some emoji exist in both bare (U+2639) and
 * emoji-style (U+2639 U+FE0F) forms. The map is keyed to the pack's exact string;
 * the renderer may emit either form. Both are tried before falling back.
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
      // Also index the alternate variation-selector form so both bare and styled match.
      const VS16 = '\uFE0F';
      if (std.endsWith(VS16)) {
        validated[std.slice(0, -1)] = id.trim();   // bare form → same id
      } else {
        // Only add the emoji-style form if the base is a known symbol codepoint.
        // We key it conservatively: only single-codepoint base chars.
        if ([...std].length === 1) {
          validated[std + VS16] = id.trim();        // styled form → same id
        }
      }
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
