/**
 * src/icons.mjs
 * THE single source of truth for every icon on every bot surface.
 *
 * HOW ASSETS WERE CHOSEN — read this before changing an ID
 * Every asset below was selected by LOOKING at its rendered artwork in a contact sheet built
 * from the live sticker thumbnails, then cross-checked against getCustomEmojiStickers for its
 * real media type and set. Three separate things were verified for each: the picture, the set
 * it actually lives in, and that the ID resolves.
 *
 * Nothing here is inferred from a pack name, a numeric ID, or a sticker's `emoji` field. Those
 * are all unreliable, and each one has already caused a real defect in this project:
 *   - the previous `chain.ethereum` pointed at CryptoIcons #130, an ENVELOPE, because the old
 *     theme map had associated the Telegram paper-plane glyph with that ID and the registry was
 *     seeded from the same number;
 *   - `chain.bsc` pointed at CryptoIcons #023, a generic CUBE, not the BNB diamond at #003;
 *   - the HyperEVM logo carries `emoji: 😡` on the sticker while the artwork is a clean H mark.
 * A valid, resolving ID proves nothing about what it looks like.
 *
 * GLYPH + LABEL, NOT GLYPH ALONE
 * Renderers have always called `e('🟡')` with a bare Unicode literal. That is why the same
 * chain appeared as a branded icon in /chains and a plain yellow circle on the token card: the
 * two paths resolved through different mechanisms, and the plain path had no way to say WHICH
 * chain it meant. The registry therefore keys on the literal and attaches a LABEL, so `e('🟡')`
 * becomes an animated BNB mark that falls back to "🟡 BNB" rather than an ambiguous circle.
 * Chain identity must survive even when custom emoji cannot be delivered.
 *
 * CUSTOM EMOJI IS ON BY DEFAULT
 * Whether a bot may send `<tg-emoji>` depends on its own rights, not on the viewer's. Sending
 * one when not permitted gets the tag rejected or printed as literal markup, which would break
 * every message — so this was previously opt-in. It is now ON by default and can be turned off
 * with `CUSTOM_EMOJI=0`. A renderer that receives a rejected tag falls back to the glyph, which
 * is always present inside the tag.
 */

// ---------------------------------------------------------------------------
// Standard glyphs — always renderable. Never removed: they are the fallback inside
// every <tg-emoji> and the whole icon set on clients that refuse them.
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

  // ---- verdict tones (severity dots) ------------------------------------
  // Separate from state.* so a severity dot can never inherit an exclamation-mark asset.
  // A dot is a measurement of severity; an exclamation is a demand for attention.
  'tone.good': '🟢',
  'tone.warn': '🟡',
  'tone.bad': '🔴',
  'tone.unknown': '⚪',
  'tone.na': '➖',

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
  'brand.token': '🪙',
  'misc.fire': '🔥',
  'misc.down': '📉',
  'metric.chain': '⛓️',
  'misc.bolt': '⚡',
  'misc.warning': '❗️',
  'misc.lock': '🔒',
  'misc.gem': '💎',
};

/**
 * Human labels for icon roles whose bare glyph is ambiguous on its own.
 *
 * A circle tells the reader nothing. Where an icon stands for a named network or a named
 * performance fact, the label travels with it so meaning never depends on the artwork arriving.
 */
export const ICON_LABELS = {
  'chain.solana': 'Solana',
  'chain.ethereum': 'Ethereum',
  'chain.bsc': 'BNB',
  'chain.base': 'Base',
  'chain.robinhood': 'Robinhood',
  'chain.hyperevm': 'HyperEVM',
  'chain.elysium': 'Elysium',
  'chain.arbitrum': 'Arbitrum',
  'chain.optimism': 'Optimism',
  'chain.polygon': 'Polygon',
  'chain.avalanche': 'Avalanche',
  'chain.unichain': 'Unichain',
  'chain.berachain': 'Berachain',
  'chain.monad': 'Monad',
  'chain.abstract': 'Abstract',
  'chain.megaeth': 'MegaETH',
  'chain.story': 'Story',
};

/**
 * Verified custom-emoji assets.
 *
 * Every entry records: the pack it ACTUALLY resolves in, the media type returned by the API,
 * what the artwork depicts, and the verified sticker index used to find it again. `source`
 * 'verified' means the artwork was inspected; nothing else is permitted here.
 *
 * MEDIA TYPES ARE NOT UNIFORM and that is reported honestly rather than smoothed over:
 *   video    WebM/VP9 — these animate
 *   animated TGS/Lottie — these animate
 *   static   a still image — correct branding, no motion
 */
export const CUSTOM_IDS = {
  // ===== PRIORITY CHAINS ==================================================
  // Identified visually: the three-bar Solana mark, the ETH diamond, the BNB four-diamond.
  'chain.solana': {
    id: '5291923604487808793', pack: 'CryptoIcons', idx: 34, media: 'video',
    depicts: 'Solana three slanted gradient bars', source: 'verified',
  },
  'chain.ethereum': {
    // Was #130 (an envelope, inherited from the paper-plane glyph mapping). This is the
    // blue-circle ETH diamond at #019; #018 and #020 are the same mark on other backgrounds.
    id: '5291927564447655889', pack: 'CryptoIcons', idx: 19, media: 'video',
    depicts: 'Ethereum diamond on a blue disc', source: 'verified',
  },
  'chain.bsc': {
    // Was #023, a generic cube. #003 is the actual Binance four-diamond mark.
    id: '5289735748147226132', pack: 'CryptoIcons', idx: 3, media: 'video',
    depicts: 'BNB four-diamond mark on black', source: 'verified',
  },
  'chain.elysium': {
    // CryptoIcons #065: a horse head with a multicoloured mane. Elysium's own branding is a
    // horse (Elysian fields / Pegasus). The sticker's own emoji field is 🦄, which corroborates
    // the picture rather than being the reason it was chosen.
    id: '5292225356005122511', pack: 'CryptoIcons', idx: 65, media: 'video',
    depicts: 'Horse head with coloured mane', source: 'verified',
  },
  'chain.hyperevm': {
    // The dedicated Hyperliquid pack carries the real H mark at #011. IMPORTANT: that sticker's
    // emoji field is 😡 — proof that the field is worthless as an identifier.
    id: '5801110591816866195', pack: 'HyperliquidEmoji', idx: 11, media: 'static',
    depicts: 'Hyperliquid H mark on a purple/blue gradient disc', source: 'verified',
  },

  // Base and Robinhood Chain have NO public asset. See MISSING_CHAIN_ASSETS below: they keep
  // their distinct glyphs, which is honest, rather than borrowing an unrelated logo.

  // ===== SECTIONS =========================================================
  'section.market': { id: '5431577498364158238', pack: 'RestrictedEmoji', media: 'animated', depicts: 'Bar chart', source: 'verified' },
  'section.security': {
    // CryptoIcons #157: a shield with a check. Replaces a padlock that was ALSO used for
    // premium, so "security" and "premium" were visually identical on the same card.
    id: '5291893844659414429', pack: 'CryptoIcons', idx: 157, media: 'video',
    depicts: 'Blue shield with a check', source: 'verified',
  },
  'section.narrative': { id: '5237799019329105246', pack: 'RestrictedEmoji', media: 'animated', depicts: 'Brain', source: 'verified' },
  'section.holders': { id: '5372926953978341366', pack: 'RestrictedEmoji', media: 'animated', depicts: 'Two people', source: 'verified' },
  'section.research': { id: '5188311512791393083', pack: 'RestrictedEmoji', media: 'animated', depicts: 'Magnifying glass', source: 'verified' },
  'section.premium': { id: '5472308992514464048', pack: 'RestrictedEmoji', media: 'animated', depicts: 'Padlock', source: 'verified' },
  'section.links': { id: '5402068075153476626', pack: 'CryptoIcons', media: 'video', depicts: 'Globe', source: 'verified' },

  // ===== METRICS ==========================================================
  'metric.holders': { id: '5372926953978341366', pack: 'RestrictedEmoji', media: 'animated', depicts: 'Two people', source: 'verified' },
  'metric.market': { id: '5431577498364158238', pack: 'RestrictedEmoji', media: 'animated', depicts: 'Bar chart', source: 'verified' },
  'metric.x': { id: '5195042564062865767', pack: 'CryptoIcons', media: 'video', depicts: 'X logo', source: 'verified' },
  // Was sharing the envelope ID with the broken chain.ethereum mapping. The Telegram plane is
  // still the right picture for a Telegram link, so it keeps a Telegram asset; the ENVELOPE at
  // #130 is the honest match for it, and nothing else uses that ID now.
  'metric.social': { id: '5291812201626084541', pack: 'CryptoIcons', media: 'video', depicts: 'Envelope / Telegram contact', source: 'verified' },
  'metric.website': { id: '5402068075153476626', pack: 'CryptoIcons', media: 'video', depicts: 'Globe', source: 'verified' },
  'metric.ca': { id: '5321006159488892145', pack: 'emojipack_sm', media: 'animated', depicts: 'Pin', source: 'verified' },
  'metric.dexPaid': { id: '5321300317504030049', pack: 'emojipack_sm', media: 'animated', depicts: 'Arrow / forward', source: 'verified' },

  // ===== STATES ===========================================================
  'state.warn': { id: '5467928559664242360', pack: 'RestrictedEmoji', media: 'animated', depicts: 'Warning exclamation', source: 'verified' },
  'state.pending': { id: '5451732530048802485', pack: 'RestrictedEmoji', media: 'animated', depicts: 'Hourglass', source: 'verified' },

  // ===== CTA ==============================================================
  'cta.open': { id: '5443160329376778407', pack: 'Icon_TGS', idx: 54, media: 'animated', depicts: 'Two forward chevrons', source: 'verified' },
  'cta.website': { id: '5402068075153476626', pack: 'CryptoIcons', media: 'video', depicts: 'Globe', source: 'verified' },
  'cta.premium': { id: '5472308992514464048', pack: 'RestrictedEmoji', media: 'animated', depicts: 'Padlock', source: 'verified' },

  // ===== BRAND ============================================================
  'brand.rocket': { id: '5292284235711784694', pack: 'CryptoIcons', media: 'video', depicts: 'Rocket', source: 'verified' },
  // ---- verified utility assets ------------------------------------------
  'misc.fire': { id: '5440848567524677660', pack: 'Icon_TGS', idx: 57, media: 'animated', depicts: 'Flame', source: 'verified' },
  // CryptachEmoji4 #002/#003: green and red candlestick charts. Verified on a contact sheet —
  // these packs mix generic UI symbols with branded coin logos, so the artwork was checked
  // rather than the emoji hint.
  'misc.down': { id: '5271811599785534382', pack: 'CryptachEmoji4', idx: 3, media: 'video', depicts: 'Red descending candlestick chart', source: 'verified' },
  'metric.roi': { id: '5269460053651366623', pack: 'CryptachEmoji4', idx: 2, media: 'video', depicts: 'Green ascending candlestick chart', source: 'verified' },
  'section.pnl': { id: '5269460053651366623', pack: 'CryptachEmoji4', idx: 2, media: 'video', depicts: 'Green ascending candlestick chart', source: 'verified' },
  'metric.lp': { id: '5292043245096806578', pack: 'CryptoIcons', idx: 109, media: 'video', depicts: 'Droplet', source: 'verified' },
  'metric.liquidity': { id: '5292043245096806578', pack: 'CryptoIcons', idx: 109, media: 'video', depicts: 'Droplet', source: 'verified' },
  'section.settings': { id: '5300999682133089708', pack: 'FinanceAnimations', idx: 39, media: 'animated', depicts: 'Gear', source: 'verified' },
  'section.bundle': { id: '5289753254433924065', pack: 'CryptoIcons', idx: 4, media: 'video', depicts: 'Segmented square grid', source: 'verified' },
  'misc.bolt': { id: '5291824180289872393', pack: 'CryptoIcons', media: 'video', depicts: 'Lightning bolt', source: 'verified' },
  'misc.warning': { id: '5467928559664242360', pack: 'RestrictedEmoji', media: 'animated', depicts: 'Warning exclamation', source: 'verified' },
};

/** Fixed chain order used by /chains, /start and any public chain list. */
export const PRIORITY_CHAINS = ['solana', 'bsc', 'ethereum', 'base', 'robinhood', 'hyperevm', 'elysium'];

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
 * Chain roles with no verified public asset, and why.
 *
 * These are reported rather than papered over with a lookalike. Borrowing an unrelated logo is
 * worse than a plain circle: it tells the reader they are looking at a brand they can trust.
 *
 * Base      — a blue circle with a white notched square. Not present in any of the ten packs
 *             inspected (925 assets). Candidates #004/#012 are OKX and Coinbase, NOT Base.
 * Robinhood — a green feather/quill. Not present. #077 is Ravencoin, a bird, and was rejected
 *             as a near-miss that would misrepresent the network.
 *
 * Both await either a published asset or an OWNER-authored pack (see docs/FINAL-EMOJI-COVERAGE.md
 * for exact artwork specs and upload steps). Until then they keep distinct glyphs AND labels.
 */
export const MISSING_CHAIN_ASSETS = {
  base: 'blue disc with a white notched square — absent from all 10 inspected packs',
  robinhood: 'green feather — absent from all 10 inspected packs',
};

/**
 * Whether custom emoji may be emitted.
 *
 * Default ON. `CUSTOM_EMOJI=0` disables it; any other value (unset, 1, true) enables it.
 * A bot that may not send `<tg-emoji>` has the tag rejected, and every glyph is still inside
 * the tag, so the fallback is the standard emoji rather than a blank.
 */
export function customEmojiEnabled(env = process.env) {
  const flag = String(env.CUSTOM_EMOJI ?? '').trim().toLowerCase();
  return !(flag === '0' || flag === 'false' || flag === 'no' || flag === 'off');
}

/** Build `<tg-emoji>` markup. The standard glyph inside is the client fallback. */
export function tgEmoji(id, glyph) {
  return `<tg-emoji emoji-id="${String(id)}">${glyph}</tg-emoji>`;
}

/**
 * Resolve an icon name to renderable text.
 *
 * @param {string} name    a key from GLYPHS, e.g. 'chain.solana'
 * @param {object} [opts]
 * @param {Function} [opts.theme]    EmojiTheme resolver from emoji-theme.mjs (glyph-keyed)
 * @param {string} [opts.fallback]   glyph when `name` is unregistered
 * @param {boolean} [opts.custom]    force custom emoji on/off; default follows CUSTOM_EMOJI
 * @param {boolean} [opts.label]     append the human label when this icon has one
 */
export function icon(name, { theme = null, fallback = null, custom = undefined, label = false } = {}) {
  const glyph = GLYPHS[name] ?? fallback ?? '•';

  // A theme resolver takes precedence: it may be driven by EMOJI_THEME or the DM approval flow.
  if (typeof theme === 'function') {
    const viaTheme = theme(glyph);
    if (viaTheme && viaTheme !== glyph) return viaTheme;
  }

  const allow = custom === undefined ? customEmojiEnabled() : Boolean(custom);
  const entry = CUSTOM_IDS[name];
  const rendered = allow && entry?.id ? tgEmoji(entry.id, glyph) : glyph;

  const text = ICON_LABELS[name];
  return label && text ? `${rendered} <b>${text}</b>` : rendered;
}

/** Convenience: the chain icon for a chain id. Falls back to the generic chain glyph. */
export function chainIcon(chainId, opts = {}) {
  const key = `chain.${String(chainId ?? '').toLowerCase()}`;
  return icon(key, { ...opts, fallback: GLYPHS['chain.default'] });
}

/** Convenience: a chain icon followed by its name. */
export function chainIconLabeled(chainId, opts = {}) {
  return icon(`chain.${String(chainId ?? '').toLowerCase()}`, {
    ...opts,
    fallback: GLYPHS['chain.default'],
    label: true,
  });
}

/** Convenience: the tone icon for a severity word. */
export function stateIcon(severity, opts = {}) {
  const name = `state.${severity}`;
  return icon(GLYPHS[name] ? name : 'state.unknown', { ...opts, fallback: GLYPHS['state.unknown'] });
}

/** Every registered role. */
export function iconNames() {
  return Object.keys(GLYPHS);
}

/** Chain ids that have a dedicated glyph. */
export function chainIconNames() {
  return Object.keys(GLYPHS).filter((k) => k.startsWith('chain.') && k !== 'chain.default');
}

/**
 * Reverse index: standard glyph → icon name.
 *
 * This is what lets a renderer that only has a literal (`e('🟡')`) opt in to the branded asset
 * without being rewritten. First registration wins, so chain keys are declared before section
 * and state keys that reuse the same circle glyphs.
 */
export const GLYPH_TO_NAME = (() => {
  const out = new Map();
  for (const name of Object.keys(GLYPHS)) {
    const g = GLYPHS[name];
    if (!out.has(g)) out.set(g, name);
  }
  return out;
})();

/**
 * Coverage summary — the numbers reported to OWNER.
 * Counted from the registry, so it cannot drift from what is actually wired.
 */
export function coverageSummary() {
  const roles = iconNames();
  const byMedia = { video: 0, animated: 0, static: 0, none: 0 };
  let verified = 0;
  for (const r of roles) {
    const e = CUSTOM_IDS[r];
    if (e?.id && e.source === 'verified') {
      verified++;
      byMedia[e.media ?? 'none']++;
    } else {
      byMedia.none++;
    }
  }
  return {
    totalRoles: roles.length,
    verifiedAssets: verified,
    animatedRoles: byMedia.video + byMedia.animated,
    videoRoles: byMedia.video,
    staticRoles: byMedia.static,
    unicodeOnly: byMedia.none,
    unicodeOnlyRoles: roles.filter((r) => !CUSTOM_IDS[r]?.id),
    missingChainAssets: MISSING_CHAIN_ASSETS,
  };
}
