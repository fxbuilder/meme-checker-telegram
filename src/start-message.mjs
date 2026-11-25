/**
 * src/start-message.mjs
 * The /start screen.
 *
 * DESIGN RULES (owner brief, Round 6):
 *   - compact, high-signal, CTA-driven, no word walls
 *   - never claims a chain count ("15 chains supported" is gone for good)
 *   - present the PRIMARY flow (paste a CA) above everything else
 *   - premium/premium-adjacent surfaces are described by what they ADD, not teased vaguely
 *   - every icon resolves through the registry so a custom-emoji swap needs no edit here
 *
 * The website CTA renders only when a URL is configured. A dead button is worse than no
 * button, and the brief's "website CTA if configured" is enforced rather than assumed.
 */

import { icon, PRIORITY_CHAINS, CHAIN_LABELS, chainIcon } from './icons.mjs';

/**
 * @param {object} opts
 * @param {string|null} opts.websiteUrl   TOKEN_PAGE_BASE_URL or a landing URL
 * @param {string|null} opts.premiumUrl   PREMIUM_URL
 * @param {Function|null} opts.theme      emoji theme resolver
 * @returns {{text:string, keyboard:Array}}
 */
export function renderStart({ websiteUrl = null, premiumUrl = null, theme = null } = {}) {
  const E = (name) => icon(name, { theme });
  const L = [];

  L.push(`${E('brand.rocket')} <b>MEME CHECKER</b>`);
  L.push('<i>Token intelligence, in Telegram.</i>');
  L.push('');

  // ---- what it does, in one line each ------------------------------------
  L.push(`${E('section.market')} <b>Market</b> · price, liquidity, mcap`);
  L.push(`${E('section.security')} <b>Security</b> · holders, tax, LP, dev`);
  L.push(`${E('section.narrative')} <b>Narrative</b> · what the project says it is`);
  L.push('');

  // ---- the main flow, stated once ---------------------------------------
  L.push(`${E('misc.bolt')} <b>How to use</b>`);
  L.push(`Paste any contract address — the chain is detected for you.`);
  L.push(`Or type <code>/ca &lt;address&gt;</code>, or <code>/ca &lt;chain&gt; &lt;address&gt;</code> to be explicit.`);
  L.push('');

  // ---- priority networks -------------------------------------------------
  // Named explicitly because the owner's strategy is the SEVEN priority networks. This
  // deliberately replaces an earlier "15 chains supported" headline: breadth was never the
  // product, and listing chains the card cannot fully fill invites bad first impressions.
  L.push(`${E('chain.default')} <b>Primary coverage</b>`);
  L.push(PRIORITY_CHAINS.map((c) => `${chainIcon(c, { theme })} ${CHAIN_LABELS[c]}`).join('  ·  '));
  L.push('');

  // ---- deeper analysis ---------------------------------------------------
  L.push(`${E('section.premium')} <b>Deeper analysis</b>`);
  L.push('<i>Full token report, call history and leaderboard, live X research, saved PnL cards.</i>');
  L.push('');

  L.push(`${E('section.research')} <code>/help</code> for every command`);

  const keyboard = [];
  const row = [];
  if (websiteUrl) row.push({ text: '🌐 Open website', url: websiteUrl });
  if (premiumUrl) row.push({ text: '🔐 Premium', url: premiumUrl });
  if (row.length) keyboard.push(row);

  return { text: L.join('\n'), keyboard };
}
