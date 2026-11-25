/**
 * src/emoji-resolve.mjs
 * ONE resolver used by every renderer, so a glyph literal no longer decides how it is drawn.
 *
 * THE PROBLEM THIS SOLVES
 * Renderers were written as `e('🟡')` — a bare Unicode literal passed through a theme map. That
 * design has two failures:
 *   1. A circle is ambiguous. 🟡 is BNB on the chain list and "warning" in a risk row, and the
 *      literal alone cannot distinguish them, so the same glyph drifted to different artwork on
 *      different screens.
 *   2. Any glyph missing from the theme map silently stayed a plain Unicode character. That is
 *      why most section headings were still ordinary emoji.
 *
 * THE FIX
 * Resolve by MEANING, not by codepoint, wherever the caller can say what it means:
 *
 *     e.icon('chain.bsc')            → animated BNB diamond
 *     e.glyph('🟡', 'chain.bsc')     → same, and keeps the 🟡 fallback
 *
 * Legacy single-argument calls still work and are upgraded through the glyph reverse index, so
 * no surface is left behind merely because it was not rewritten. A glyph that maps to a chain
 * becomes that chain's branded asset instead of a coloured dot.
 *
 * Deliberate exception: a glyph in a string that also contains a user-visible word (a label, a
 * count, a sentence) is NOT rewritten, because the glyph there is decoration inside prose rather
 * than a semantic slot. Those are listed in docs/FINAL-EMOJI-COVERAGE.md.
 */

import { GLYPHS, CUSTOM_IDS, GLYPH_TO_NAME, ICON_LABELS, customEmojiEnabled, tgEmoji } from './icons.mjs';

/**
 * Build the resolver handed to a renderer.
 *
 * @param {object} [opts]
 * @param {Function} [opts.theme]  EmojiTheme from emoji-theme.mjs; wins when it resolves
 * @param {boolean} [opts.custom] override the global custom-emoji switch
 * @returns {Function} callable as e(literal), e.icon(name), e.glyph(literal, name)
 */
/**
 * Glyph → role, including the variation-selector variants.
 *
 * A registry glyph stored as "⛓️" (with U+FE0F) does not match text containing the bare "⛓",
 * so keying only the exact string silently left icons unmigrated. Both forms are indexed.
 */
const VS16 = String.fromCharCode(0xFE0F);
export const GLYPH_VARIANTS = (() => {
  const out = new Map();
  for (const [glyph, name] of GLYPH_TO_NAME) {
    out.set(glyph, name);
    const bare = String(glyph).split(VS16).join('');
    if (bare !== glyph && !out.has(bare)) out.set(bare, name);
    const styled = bare + VS16;
    if (styled !== glyph && !out.has(styled)) out.set(styled, name);
  }
  return out;
})();

/**
 * Normalise whatever a caller supplied as `emojiTheme` into a full resolver.
 *
 * `buildEmojiTheme()` from emoji-theme.mjs returns a BARE function with no `.icon` method, and
 * several call sites pass that straight through as `e`. Renderers that now call `e.icon(...)`
 * would throw "e.icon is not a function" — a real regression this caught. Rather than require
 * every caller to upgrade, a bare function is wrapped so it keeps its own mappings and gains the
 * role-based API on top.
 */
export function asEmojiResolver(input, opts = {}) {
  if (typeof input?.icon === 'function') return input;          // already a resolver
  if (typeof input === 'function') return makeEmojiResolver({ ...opts, theme: input });
  return makeEmojiResolver(opts);
}

export function makeEmojiResolver({ theme = null, custom = undefined } = {}) {
  // Evaluated per render, not captured at construction. Caching it meant a test (or an operator
  // setting the variable mid-process) saw stale behaviour, and `CUSTOM_EMOJI=0` silently did
  // nothing if the resolver had already been built.
  const allow = () => (custom === undefined ? customEmojiEnabled() : Boolean(custom));

  const render = (name, glyph) => {
    // 1. An explicit theme wins. It is the owner's override and may map a glyph to artwork the
    //    registry does not know about.
    if (typeof theme === 'function' && glyph) {
      const viaTheme = theme(glyph);
      if (viaTheme && viaTheme !== glyph) return viaTheme;
    }
    // 2. The registry.
    const entry = CUSTOM_IDS[name];
    if (allow() && entry?.id) return tgEmoji(entry.id, glyph ?? GLYPHS[name] ?? '•');
    // 3. Fallback: the caller's glyph, the registry glyph, or finally a neutral dot.
    return glyph ?? GLYPHS[name] ?? '•';
  };

  function e(input, role = null) {
    if (role) return render(role, input);
    if (typeof input !== 'string' || !input) return '';
    const name = GLYPH_TO_NAME.get(input);
    return name ? render(name, input) : input;
  }

  e.icon = (name) => render(name, GLYPHS[name]);
  e.glyph = (glyph, name) => render(name, glyph);
  /** Literal + label, for surfaces where an unlabelled circle would be ambiguous. */
  e.labeled = (name, text = null) => {
    const g = render(name, GLYPHS[name]);
    const t = text ?? ICON_LABELS[name];
    return t ? `${g} <b>${t}</b>` : g;
  };
  e.available = allow();
  return e;
}

/** Shared, theme-free default. Cheap to build and safe to import anywhere. */
export const defaultEmoji = makeEmojiResolver();

/**
 * Replace the icon slots in a finished string.
 *
 * A slot is a glyph standing as its own token — surrounded by whitespace, string edges,
 * `<b>`, `</b>` or a newline — which is how these templates actually place icons. A glyph
 * embedded inside a word or a number is left alone, because rewriting it would corrupt prose.
 *
 * This exists so surfaces that build strings with template literals (error messages, empty
 * states, confirmations) are migrated without restructuring every call site.
 */
// A slot is an icon that LEADS a line (optionally indented, optionally inside a tag). That is
// how these templates actually place icons, and it is narrow enough that a glyph sitting inside
// prose — "rose 5 🟡 to 6" — is left untouched. Missing an inline icon is harmless (it stays a
// readable Unicode glyph); corrupting a sentence is not.
const SLOT_BOUNDARY = String.raw`(?<=^|
)\s*`;
// A slot may be followed by a colon — "📞: 3 calls" is still an icon at the start of a line.
const SLOT_END = String.raw`(?=$|[\s<:]|&nbsp;)`;

/**
 * Apply the resolver to a whole outgoing message.
 *
 * WHY THIS IS THE MIGRATION MECHANISM
 * The bot has ~200 icon literals spread across command handlers, alerts, error copy and empty
 * states. Rewriting every call site would be a large, error-prone diff and would still miss the
 * next one somebody writes. Wrapping the text on its way out means every surface is covered —
 * including handlers added later — and a single registry change reaches all of them.
 *
 * SAFETY: content inside <code>…</code> and <a …>…</a> is left alone. Those hold contract
 * addresses and user-supplied names, and rewriting a symbol there would corrupt what the user
 * actually typed.
 */
export function upgradeOutgoing(text, resolver = defaultEmoji) {
  if (typeof text !== 'string' || !text) return text;
  // Split on protected regions, upgrade only the plain segments.
  return text
    .split(/(<code>[\s\S]*?<\/code>|<a\s[^>]*>[\s\S]*?<\/a>)/gi)
    .map((seg, i) => (i % 2 === 1 ? seg : upgradeEmojiSlots(seg, resolver)))
    .join('');
}

export function upgradeEmojiSlots(text, resolver = defaultEmoji) {
  if (typeof text !== 'string' || !text) return text;
  // Already-resolved markup must not be re-processed: a second pass would nest tags.
  if (text.includes('<tg-emoji')) {
    return text.replace(/<tg-emoji emoji-id="\d+">([\s\S]*?)<\/tg-emoji>(?![^<]*<\/tg-emoji>)/g, (m) => m);
  }
  let out = text;
  for (const [glyph, name] of GLYPH_VARIANTS) {
    if (!out.includes(glyph)) continue;
    const replacement = resolver.icon(name);
    if (replacement === glyph) continue;
    // Escape the glyph for use in a RegExp, then anchor it to a slot.
    const esc = glyph.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    out = out.replace(new RegExp(`${SLOT_BOUNDARY}${esc}${SLOT_END}`, 'gu'), replacement);
  }
  return out;
}
