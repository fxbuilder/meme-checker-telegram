/**
 * src/icons.mjs
 * THE single source of truth for icons across every bot surface.
 *
 * WHY A REGISTRY
 * Emoji were previously scattered as literals through bot.mjs, format-card.mjs,
 * card-layout.mjs, leaderboard.mjs and the help text. That meant:
 *   - the same concept had different glyphs on different screens (a chain showed 🟣 in
 *     the card and ⛓️ in the profile)
 *   - swapping an icon required edits in a dozen files
 *   - an animated custom-emoji ID could be added in one place and silently missing in
 *     the rest
 *
 * So every surface resolves icons through `ICON.<name>`. Adding a custom-emoji ID to
 * `CUSTOM_IDS` upgrades that icon EVERYWHERE at once, and nothing else changes. If an ID
 * is absent the standard glyph is used - visual polish is never load-bearing for meaning.
 *
 * NAMING
 *   chain.<id>     one per supported network (7 priority + others)
 *   section.*      a block heading (market, security, narrative, ...)
 *   metric.*       a field label inside a block (holders, top10, tax, lp, dev, ...)
 *   state.*        a verdict tone (good, warn, bad, unknown, neutral)
 *   cta.*          an action link/button
 *
 * ADAPTERS
 * `env(name, theme)` accepts the existing EmojiTheme resolver from emoji-theme.mjs, so
 * SVG/custom rendering stays compatible. It simply delegates when a theme is active and
 * falls back to the registry glyph otherwise.
 */

// ---------------------------------------------------------------------------
// Standard glyphs — always renderable, no Premium, no sticker pack.
// ---------------------------------------------------------------------------

export const GLYPHS = {
  // ---- chains -----------------------------------------------------------
  'chain.solana': '🟣',
  'chain.ethereum': '🔷',
  'chain.bsc': '🟡',
  'chain.base': '🔵',
  'chain.robinhood': '🟢',
  'chain.hyperevm': '🟪',
  'chain.elysium': '🟠',
  'chain.arbitrum': '🔹',
  'chain.optimism': '🔴',
  'chain.polygon': '🟪',
  'chain.avalanche': '🔺',
  'chain.unichain': '⚪',
  'chain.berachain': '🟤',
  'chain.monad': '⚫',
  'chain.abstract': '🔘',
  'chain.megaeth': '🔘',
  'chain.story': '🔘',
  'chain.default': '⛓️',

  // ---- section headings -------------------------------------------------
  'section.market': '📊',
  'section.security': '🛡️',
  'section.narrative': '🧠',
  'section.holders': '👥',
  'section.holderOverview': '👥',
  'section.links': '🔗',
  'section.dev': '👨‍💻',
  'section.bundle': '🧩',
  'section.alerts': '🔔',
  'section.pnl': '📈',
  'section.leaderboard': '🏆',
  'section.premium': '🔐',
  'section.research': '🔎',
  'section.community': '👥',
  'section.settings': '⚙️',
  'section.utility': '🛠️',

  // ---- metrics ----------------------------------------------------------
  'metric.holders': '👥',
  'metric.top10': '🔟',
  'metric.tax': '💸',
  'metric.lp': '💧',
  'metric.dev': '👨‍💻',
  'metric.dexPaid': '💳',
  'metric.market': '📊',
  'metric.volume': '📦',
  'metric.liquidity': '💧',
  'metric.price': '💰',
  'metric.mcap': '🏦',
  'metric.x': '✖️',
  'metric.social': '✈️',
  'metric.website': '🌐',
  'metric.ca': '📌',
  'metric.peak': '⛰️',
  'metric.roi': '📈',
  'metric.hitRate': '🎯',
  'metric.calls': '📞',
  'metric.avg': '📐',
  'metric.median': '📏',

  // ---- states -----------------------------------------------------------
  'state.good': '🟢',
  'state.warn': '🟡',
  'state.bad': '🔴',
  'state.unknown': '⚪',
  'state.neutral': '⚬',
  'state.pending': '⏳',

  // ---- CTA / navigation -------------------------------------------------
  'cta.open': '➡️',
  'cta.website': '🌍',
  'cta.premium': '🔐',
  'cta.refresh': '🔄',
  'cta.back': '‹',
  'cta.next': '›',

  // ---- misc -------------------------------------------------------------
  'brand.rocket': '🚀',
  'misc.bolt': '⚡',
  'misc.warning': '❗️',
  'misc.lock': '🔒',
  'misc.gem': '💎',
};

/**
 * Animated custom-emoji IDs, keyed by the SAME icon name.
 *
 * Every ID here was read off a real sticker pack and verified animated; each carries the
 * pack and the concept it was chosen for so a future swap is a data edit, not a hunt.
 * Absend an entry and that icon simply uses its standard glyph.
 *
 * Packs in use: CryptoIcons, RestrictedEmoji, SM Animated.
 */
export const CUSTOM_IDS = {
  // Chains — CryptoIcons chain logos where a clear one exists.
  'chain.solana': { id: '5291923604487808793', pack: 'CryptoIcons' },
  'chain.bsc': { id: '5291751363414336197', pack: 'CryptoIcons' },
  'chain.ethereum': { id: '5291812201626084541', pack: 'CryptoIcons' }, // diamond-ish mark
  // Robinhood/HyperEVM/Base/Elysium deliberately have NO custom ID. Assigning one shared
  // sticker to all four made them render identically in the coverage list, which defeats the
  // only purpose that list has. Their distinct standard glyphs (🔵 🟢 🟪 🟠) read correctly
  // today, and a per-chain asset can be dropped in later without touching any caller.

  // Sections
  'section.market': { id: '5431577498364158238', pack: 'RestrictedEmoji' },
  'section.holders': { id: '5372926953978341366', pack: 'RestrictedEmoji' },
  'section.narrative': { id: '5237799019329105246', pack: 'RestrictedEmoji' },
  'section.security': { id: '5472308992514464048', pack: 'RestrictedEmoji' },
  'section.research': { id: '5188311512791393083', pack: 'RestrictedEmoji' },
  'section.premium': { id: '5472308992514464048', pack: 'RestrictedEmoji' },
  'section.links': { id: '5402068075153476626', pack: 'CryptoIcons' },

  // Metrics
  'metric.holders': { id: '5372926953978341366', pack: 'RestrictedEmoji' },
  'metric.market': { id: '5431577498364158238', pack: 'RestrictedEmoji' },
  'metric.x': { id: '5195042564062865767', pack: 'CryptoIcons' },
  'metric.social': { id: '5291812201626084541', pack: 'CryptoIcons' },
  'metric.website': { id: '5402068075153476626', pack: 'CryptoIcons' },
  'metric.ca': { id: '5321006159488892145', pack: 'SM Animated' },
  'metric.dexPaid': { id: '5321300317504030049', pack: 'SM Animated' },

  // States
  'state.warn': { id: '5467928559664242360', pack: 'RestrictedEmoji' },
  'state.pending': { id: '5451732530048802485', pack: 'RestrictedEmoji' },

  // CTA
  'cta.open': { id: '5321300317504030049', pack: 'SM Animated' },
  'cta.website': { id: '5402068075153476626', pack: 'CryptoIcons' },
  'cta.premium': { id: '5472308992514464048', pack: 'RestrictedEmoji' },

  // Brand
  'brand.rocket': { id: '5292284235711784694', pack: 'CryptoIcons' },
  'misc.bolt': { id: '5291824180289872393', pack: 'CryptoIcons' },
  'misc.warning': { id: '5467928559664242360', pack: 'RestrictedEmoji' },
};

/** Fixed chain order used by /chains, /start and any public chain list. */
export const PRIORITY_CHAINS = [
  'solana', 'bsc', 'ethereum', 'base', 'robinhood', 'hyperevm', 'elysium',
];

/** Human labels for public copy. Non-priority chains are never the headline. */
export const CHAIN_LABELS = {
  solana: 'Solana',
  bsc: 'BNB Chain',
  ethereum: 'Ethereum',
  base: 'Base',
  robinhood: 'Robinhood Chain',
  hyperevm: 'HyperEVM',
  elysium: 'Elysium',
  arbitrum: 'Arbitrum',
  optimism: 'Optimism',
  polygon: 'Polygon',
  avalanche: 'Avalanche',
  unichain: 'Unichain',
  berachain: 'Berachain',
  monad: 'Monad',
  abstract: 'Abstract',
  megaeth: 'MegaETH',
  story: 'Story',
};

/**
 * Resolve an icon name to a renderable glyph, optionally through a custom theme.
 *
 * @param {string} name    a key from GLYPHS, e.g. 'chain.solana'
 * @param {object} [opts]
 * @param {Function} [opts.theme]  EmojiTheme resolver from emoji-theme.mjs
 * @param {string} [opts.fallback] glyph to use when `name` is not registered
 * @returns {string} glyph, or `<tg-emoji …>` markup when the theme resolves it
 */
/**
 * Whether custom (animated) emoji may be emitted at all.
 *
 * A bot can only send <tg-emoji> if it owns a Fragment username. Sending one from an ordinary
 * bot gets the tag rejected or rendered as literal text, so emitting it UNCONDITIONALLY would
 * break every message, not just look wrong.
 *
 * The registry therefore DEFAULTS TO STANDARD GLYPHS. Custom IDs activate only when the owner
 * has opted in — either CUSTOM_EMOJI=1 after registering the asset pack, or a theme resolver
 * supplied through the existing emoji-theme approval flow. This keeps one registry for both
 * states: swapping assets later changes IDs here, never the callers.
 */
export function customEmojiEnabled(env = process.env) {
  const flag = String(env.CUSTOM_EMOJI ?? '').trim().toLowerCase();
  return flag === '1' || flag === 'true' || flag === 'yes';
}

export function icon(name, { theme = null, fallback = null, custom = undefined } = {}) {
  const glyph = GLYPHS[name] ?? fallback ?? '•';
  // A theme resolver takes precedence: it may be driven by EMOJI_THEME or a DM-applied map,
  // which is the owner's explicit override.
  if (typeof theme === 'function') {
    const viaTheme = theme(glyph);
    if (viaTheme && viaTheme !== glyph) return viaTheme;
  }
  const allow = custom === undefined ? customEmojiEnabled() : Boolean(custom);
  if (allow) {
    const entry = CUSTOM_IDS[name];
    if (entry?.id) return tgEmoji(entry.id, glyph);
  }
  return glyph;
}

/** Build `<tg-emoji>` markup. Standard glyph inside is the client fallback. */
export function tgEmoji(id, glyph) {
  return `<tg-emoji emoji-id="${id}">${glyph}</tg-emoji>`;
}

/** Convenience: the chain icon for a chain id, with a safe default. */
export function chainIcon(chainId, opts = {}) {
  const key = `chain.${String(chainId ?? '').toLowerCase()}`;
  return icon(key, { ...opts, fallback: GLYPHS['chain.default'] });
}

/** Convenience: the tone icon for a severity word. */
export function stateIcon(severity, opts = {}) {
  const map = {
    none: 'state.good', low: 'state.good', good: 'state.good',
    medium: 'state.warn', warn: 'state.warn', warning: 'state.warn',
    high: 'state.bad', bad: 'state.bad', critical: 'state.bad',
    unknown: 'state.unknown', neutral: 'state.neutral',
  };
  return icon(map[String(severity ?? 'unknown').toLowerCase()] ?? 'state.unknown', opts);
}

/** Every registered icon name. Used by tests to prove the registry is complete. */
export function iconNames() {
  return Object.keys(GLYPHS);
}

/** Chain ids that have a dedicated glyph. */
export function chainIconNames() {
  return Object.keys(GLYPHS).filter((k) => k.startsWith('chain.') && k !== 'chain.default');
}
