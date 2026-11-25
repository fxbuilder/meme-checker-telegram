/**
 * src/help.mjs
 * The /help screen and the single catalogue of what this bot actually does.
 *
 * WHY THIS IS A MODULE AND NOT A STRING LITERAL
 * The old help was a hand-maintained array that claimed "Solana or BNB Chain" long after more
 * chains were supported, advertised /help before it existed, and described a chain picker for
 * every EVM paste after automatic resolution had replaced it. A hand-written capability list
 * drifts the moment a feature lands.
 *
 * ROUND 6 CHANGES (owner UI polish):
 *   - /ca is the documented scan command. /check is NOT advertised; it remains a working
 *     compatibility alias so saved messages and muscle memory keep functioning.
 *   - /short, /detail, /standard and /compact are not advertised: the standard card is the
 *     only public view. The commands remain as compatibility stubs that say so.
 *   - The chain list is the SEVEN priority networks, framed as primary coverage. Non-priority
 *     chains are still supported but are not the headline, and no total count is claimed.
 *     An earlier version asserted "Supported chains (15)" — breadth was never the product.
 *   - The cooldown line previously said "15 s per user, 60 s repeat", which Round 4 had already
 *     replaced with 3 s group / 1 s private plus cache-served repeats. Stale limits in help are
 *     worse than none, so the numbers are no longer spelled out; the behaviour is described.
 *
 * A test asserts every command named here is registered, and that no retired command reappears.
 */

import { CHAINS } from './chains.mjs';
import { PRIORITY_CHAINS, CHAIN_LABELS, icon, chainIcon } from './icons.mjs';

/**
 * Command catalogue, grouped for scanning.
 *
 * `usage` renders as the typed/tapped form. `note` is a short qualifier shown only where the
 * behaviour needs one. Nothing here claims a capability that is not wired.
 */
export const HELP_SECTIONS = [
  {
    key: 'scan',
    title: 'Token Scan',
    icon: 'section.market',
    commands: [
      { usage: 'paste a contract', note: 'chain auto-detected', plain: true },
      { usage: '/ca <address>', note: 'scan a token' },
      { usage: '/ca <chain> <address>', note: 'force a chain' },
      { usage: '/justscan <address>', note: 'skip the research pass' },
      { usage: '/chains', note: 'coverage per network' },
    ],
  },
  {
    key: 'calls',
    title: 'Call Tracking & PnL',
    icon: 'section.pnl',
    commands: [
      { usage: '/call <address>', note: 'record a call' },
      { usage: '/calls', note: 'recent calls here' },
      { usage: '/pnl', note: 'shareable PnL image' },
      { usage: '/pnlbg', note: 'custom PnL background' },
      { usage: '/pnlreset', note: 'reset background' },
      { usage: '/callsettings', note: 'auto-call, min mcap' },
    ],
  },
  {
    key: 'research',
    title: 'Narrative / Research',
    icon: 'section.narrative',
    commands: [
      { usage: '/narrative <address>', note: 'what the project published' },
      { usage: '/x <address>', note: 'X discussion' },
      { usage: '/kol <handle>', note: 'recorded public calls' },
      { usage: '/website <address>', note: 'project link' },
    ],
  },
  {
    key: 'security',
    title: 'Security',
    icon: 'section.security',
    commands: [
      { usage: '/risk <address>', note: 'full security detail' },
      { usage: '/dev <address>', note: 'creator holding' },
      { usage: '/bundle <address>', note: 'holder clustering' },
    ],
  },
  {
    key: 'community',
    title: 'Community',
    icon: 'section.leaderboard',
    commands: [
      { usage: '/lb', note: 'group leaderboard' },
      { usage: '/profile', note: 'caller profile' },
      { usage: '/fc <address>', note: 'first caller' },
      { usage: '/gpnl', note: 'group performance' },
      { usage: '/alerts', note: 'alert settings' },
    ],
  },
  {
    key: 'settings',
    title: 'Settings',
    icon: 'section.settings',
    commands: [
      { usage: '/settings', note: 'this chat' },
      { usage: '/resettheme', note: 'reset emoji theme' },
      { usage: '/about', note: 'version' },
    ],
  },
];

/**
 * Commands retired from the public surface in Round 6.
 *
 * Kept so a test can prove none of them reappears in rendered help. The commands themselves
 * still exist as compatibility stubs where removing them risked breaking a saved message.
 */
export const RETIRED_COMMANDS = ['/check', '/short', '/detail', '/standard', '/compact', '/scan'];

/** Every command name this help text mentions, for the drift test. */
export function documentedCommands() {
  const out = new Set();
  for (const section of HELP_SECTIONS) {
    for (const c of section.commands) {
      const m = /^\/([a-z]+)/i.exec(c.usage);
      if (m) out.add(m[1].toLowerCase());
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
 * @param {Function|null} opts.theme      emoji theme resolver
 */
export function renderHelp({ websiteBase = null, premiumUrl = null, theme = null } = {}) {
  const E = (name) => icon(name, { theme });
  const L = [];

  L.push(`${E('brand.rocket')} <b>MEME CHECKER — Commands</b>`);
  L.push('');

  for (const section of HELP_SECTIONS) {
    L.push(`${E(section.icon)} <b>${section.title}</b>`);
    for (const c of section.commands) {
      const usage = c.plain ? `<i>${esc(c.usage)}</i>` : `<code>${esc(c.usage)}</code>`;
      L.push(c.note ? `   ${usage} — ${esc(c.note)}` : `   ${usage}`);
    }
    L.push('');
  }

  // ---- primary coverage: seven networks, no total-count claim --------------
  L.push(`${E('chain.default')} <b>Primary coverage</b>`);
  L.push(PRIORITY_CHAINS.map((c) => `${chainIcon(c, { theme })} ${esc(CHAIN_LABELS[c])}`).join('  ·  '));
  L.push('<i>Additional networks are supported with reduced data.</i>');
  L.push('');

  // ---- chain detection ----------------------------------------------------
  // Kept short, but retained because the old text promised a picker for every EVM paste.
  L.push(`${E('cta.refresh')} <b>Chain detection</b>`);
  L.push('EVM addresses are resolved automatically. If one contract exists on several chains you get only those choices; <code>/ca &lt;chain&gt; &lt;address&gt;</code> always wins.');
  L.push('Solana addresses are detected directly — they cannot be confused with an EVM one.');;
  L.push('');

  // ---- honest capability note ---------------------------------------------
  L.push('<i>Not every field exists on every network. A dash means unmeasured — it never means safe.</i>');
  if (websiteBase || premiumUrl) {
    L.push('');
    L.push(`${E('section.premium')} <i>Full reports, saved PnL and live X research are on the website.</i>`);
  }

  const links = [];
  if (websiteBase) links.push({ text: `${icon('cta.website', { theme })} Website`, url: websiteBase });
  if (premiumUrl) links.push({ text: `${icon('cta.premium', { theme })} Premium`, url: premiumUrl });

  return { text: L.join('\n').replace(/\n{3,}/g, '\n\n').trim(), links };
}

/** Short version for a group where the full text would be too long. */
export function renderHelpShort() {
  const L = [
    '📖 <b>MEME CHECKER — quick help</b>',
    '',
    '• Paste any contract address to scan it',
    '• <code>/ca [chain] &lt;address&gt;</code> — full card',
    '• <code>/risk</code> · <code>/dev</code> · <code>/narrative</code> — deeper checks',
    '• <code>/call &lt;address&gt;</code> · <code>/calls</code> · <code>/pnl</code> — call tracking',
    '• <code>/lb</code> · <code>/gpnl</code> — group leaderboard',
    '• <code>/help</code> — everything',
  ];
  return L.join('\n');
}
