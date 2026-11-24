/**
 * src/help.mjs
 * The /help screen, and the single list of what this bot actually does.
 *
 * WHY THIS IS A MODULE AND NOT A STRING LITERAL
 * The old help text was a hand-maintained array in bot.mjs. It claimed the bot was for
 * "Solana or BNB Chain" long after 15 chains were supported, advertised /help while
 * /help did not exist as a command, and described a chain picker for every EVM paste
 * after automatic resolution had replaced it. A hand-written capability list drifts the
 * moment a feature lands.
 *
 * So the chain list comes from the registry, the sections are declared once, and a test
 * asserts every command named here is actually registered on the bot. A command that is
 * described but not wired is worse than an undocumented one.
 */

import { CHAINS } from './chains.mjs';

/**
 * Command catalogue, grouped for humans.
 *
 * `usage` renders as the tappable/typed form. `note` is a short qualifier shown only
 * where the behaviour needs one. Nothing here claims a capability that is not wired.
 */
export const HELP_SECTIONS = [
  {
    title: ' 🔎 Token Scanner',
    commands: [
      { usage: 'paste any contract', note: 'auto-detects the chain', plain: true },
      { usage: '/check <address>', note: 'market, holders, security, narrative' },
      { usage: '/check <chain> <address>', note: 'force a chain' },
      { usage: '/chains', note: 'every supported network' },
      { usage: '/compact', note: 'compact card (default)' },
      { usage: '/detail', note: 'detailed card' },
    ],
  },
  {
    title: '📞 Call Tracking & PnL',
    commands: [
      { usage: '/call <address>', note: 'record a call (groups)' },
      { usage: '/justscan <address>', note: 'scan without recording' },
      { usage: '/calls', note: 'recent calls in this group' },
      { usage: '/fc <address>', note: 'who called it first' },
      { usage: '/pnl [n|address]', note: 'shareable PnL image' },
      { usage: '/profile', note: 'your caller profile' },
      { usage: '/callsettings', note: 'auto-call and minimum market cap' },
    ],
  },
  {
    title: '🧠 Narrative & Intelligence',
    commands: [
      { usage: '/narrative <address>', note: 'what the token is, with sources' },
      { usage: '/x <address>', note: 'cached X preview (free)' },
      { usage: '/kol <@user>', note: 'recorded public calls by an account' },
    ],
  },
  {
    title: '🛡 Security',
    commands: [
      { usage: '/risk <address>', note: 'holders, tax, liquidity, contract' },
      { usage: '/dev <address>', note: 'creator and current holding' },
      { usage: '/bundle <address>', note: 'what bundle checks can show' },
    ],
  },
  {
    title: '👥 Community & Leaderboard',
    commands: [
      { usage: '/lb', note: 'callers, group stats, top calls' },
      { usage: '/leaderboard', note: 'same as /lb' },
      { usage: '/gpnl', note: 'group performance summary' },
      { usage: '/alerts', note: 'smart alert settings' },
      { usage: '/alerttest <x>', note: 'send a clearly-marked test alert' },
    ],
  },
  {
    title: '⚙️ Settings',
    commands: [
      { usage: '/settings', note: 'group scan and alert settings' },
      { usage: '/resettheme', note: 'clear the custom emoji theme' },
    ],
  },
  {
    title: 'ℹ️ General',
    commands: [
      { usage: '/start', note: 'introduction' },
      { usage: '/help', note: 'this message' },
      { usage: '/about', note: 'what Meme Checker is' },
      { usage: '/website', note: 'open the website' },
      { usage: '/upgrade', note: 'premium information' },
    ],
  },
];

/** Every command name this help text mentions, for the drift test. */
export function documentedCommands() {
  const out = new Set();
  for (const section of HELP_SECTIONS) {
    for (const c of section.commands) {
      const m = /^\/([a-z]+)/.exec(c.usage);
      if (m) out.add(m[1]);
    }
  }
  return [...out].sort();
}

function esc(v) {
  return String(v ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** Market-data chains, in registry order. Only these can be scanned. */
export function marketChains() {
  return Object.values(CHAINS).filter((c) => c.market);
}

/**
 * Render the help text.
 *
 * @param {object} opts
 * @param {string|null} opts.websiteBase  project website, when configured
 * @param {string|null} opts.premiumUrl   premium destination, when configured
 */
export function renderHelp({ websiteBase = null, premiumUrl = null } = {}) {
  const L = [];

  L.push('📖 <b>MEME CHECKER — Help</b>');
  L.push('');
  L.push('Paste any contract address in a group or DM and get a full token card.');
  L.push('');

  for (const section of HELP_SECTIONS) {
    L.push(`<b>${section.title}</b>`);
    for (const c of section.commands) {
      const usage = c.plain ? esc(c.usage) : `<code>${esc(c.usage)}</code>`;
      L.push(c.note ? `• ${usage} — ${esc(c.note)}` : `• ${usage}`);
    }
    L.push('');
  }

  // ---- chains ------------------------------------------------------------
  const chains = marketChains();
  L.push(`<b>🌐 Supported chains (${chains.length})</b>`);
  L.push(chains.map((c) => esc(c.name)).join(' · '));
  L.push('');

  // ---- how chain detection works ----------------------------------------
  // This section exists because the OLD text told users they would always be asked to
  // pick a chain. Automatic resolution changed that, and the help must match.
  L.push('<b>🔄 How chain detection works</b>');
  L.push('• <b>EVM addresses (0x…)</b> are resolved automatically against two independent indexers. If the contract exists on exactly one supported chain, it is scanned with no prompt.');
  L.push('• If the same contract is genuinely deployed on several chains, you get a short list of only those chains.');
  L.push('• If nothing is indexed yet — normal for a token seconds old — you can still pick the chain yourself.');
  L.push('• <b>Solana addresses</b> are detected directly, no prompt.');
  L.push('• To force a chain, use <code>/check base 0x…</code>. An explicit chain always wins.');
  L.push('');

  // ---- free vs premium ---------------------------------------------------
  L.push('<b>🆓 Free in Telegram</b>');
  L.push('Token scanning · market overview · basic security · basic narrative · first caller · call tracking · caller profiles · PnL images · smart alerts · group leaderboard');
  L.push('');
  L.push('<b>⭐ Premium preview</b>');
  L.push('Scan cards show a cached X/KOL preview: post count, account count and up to two relevant accounts. Ordinary scans never make a paid X request.');
  L.push('Deeper X research, full KOL discovery and historical performance live on the website.');
  L.push('');

  // ---- cooldowns ---------------------------------------------------------
  L.push('<b>⏱ Limits</b>');
  L.push('15 s per user. A repeat of the same address in the same chat is skipped for 60 s.');
  L.push('');

  // ---- honest capability note -------------------------------------------
  // Stated plainly rather than implied, because a card shows "n/a" on these chains.
  L.push('<i>Not every field exists on every chain: security coverage comes from GoPlus, RugCheck (Solana) and GeckoTerminal, and a few chains have only partial coverage. A dash means unmeasured; it never means safe.</i>');

  const links = [];
  if (websiteBase) links.push({ text: '🌐 Website', url: websiteBase });
  if (premiumUrl) links.push({ text: '⭐ Premium', url: premiumUrl });

  return { text: L.join('\n'), links };
}

/** Short version for a group where the full text would be too long. */
export function renderHelpShort() {
  const L = [
    '📖 <b>MEME CHECKER — quick help</b>',
    '',
    '• Paste any contract address to scan it',
    '• <code>/check [chain] &lt;address&gt;</code> — full card',
    '• <code>/risk</code> · <code>/dev</code> · <code>/narrative</code> — deeper checks',
    '• <code>/call &lt;address&gt;</code> · <code>/calls</code> · <code>/pnl</code> — call tracking',
    '• <code>/lb</code> · <code>/gpnl</code> — group leaderboard',
    '• <code>/help</code> — everything',
  ];
  return L.join('\n');
}
