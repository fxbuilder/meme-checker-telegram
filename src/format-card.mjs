/**
 * src/format-card.mjs
 * Build the Telegram HTML result card from a normalized scan result.
 *
 * TWO RENDER MODES
 *   'compact'  — token identity, price + one dense stats line, Quick Checks,
 *                project links, footer. Built for group chats where the card
 *                must not dominate the screen. The BOT sends this by default.
 *   'detailed' — the product brief §4.1 layout: full market block, holder
 *                overview, narrative, project info, DYOR teaser, plus security
 *                flags and provenance notes.
 *
 * WHY THIS DEFAULTS TO 'detailed': the library contract is the §4.1 layout and
 * existing callers depend on it. The bot passes 'compact' explicitly via
 * CARD_VIEW, so the user-facing default is the compact card without breaking
 * the documented contract or existing callers.
 *
 * HONESTY RULES (both modes)
 *   - null is stated as unavailable, never as 0 / "No" / "Not Paid"
 *   - a chain with no data source says so explicitly
 *   - no fabricated narrative, holders, tax or freshness
 *
 * Public API unchanged: formatCard(result, options) → { text, buttons }.
 */
import { noTheme } from './emoji-theme.mjs';
import { renderQuickChecks, quickChecks, fmtUsd, fmtPct, marketLooksImplausible } from './card-layout.mjs';
import { getChain } from './chains.mjs';

function esc(v) {
  if (v == null) return '';
  return String(v)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/**
 * Returns true only for absolute HTTPS URLs with no credentials and no placeholder host.
 * Mirrors the scan-result-contract §fullAnalysisUrl rule.
 */
export function isAcceptableUrl(url) {
  if (!url || typeof url !== 'string') return false;
  try {
    const u = new URL(url);
    if (u.protocol !== 'https:') return false;
    if (u.username || u.password) return false;
    if (u.hostname.endsWith('.example') || u.hostname === 'example' || u.hostname === 'localhost') return false;
    return true;
  } catch {
    return false;
  }
}

const DIV = '━━━━━━━━━━━━━━━━━━';

function chainLabel(chain) {
  return getChain(chain)?.name ?? (chain ? String(chain) : 'Unknown');
}

function chainIcon(chain) {
  return getChain(chain)?.emoji ?? '⛓️';
}

function fmtInt(v) {
  if (v == null || !Number.isFinite(v)) return null;
  return Math.round(v).toLocaleString('en-US');
}

function fmtPp(v, digits = 1) {
  if (v == null || !Number.isFinite(v)) return null;
  return `${v.toFixed(digits)}%`;
}

/** Short, honest message for every non-ok status. */
function renderStatusCard(result, e, mockLabel) {
  const { status = 'api-error', mode } = result;
  const mockSuffix = (mockLabel || mode === 'mock') ? ' <i>[mock]</i>' : '';
  const msgs = {
    'not-found': `${e('❗️')} <b>Token Not Found</b>${mockSuffix}\n\nNo trading pair exists for this contract yet.`,
    'invalid-response': `${e('❗️')} <b>Scan Error</b>${mockSuffix}\n\nThe data provider returned an unexpected response. Please try again.`,
    'api-error': `${e('❗️')} <b>Unable to fetch data</b>${mockSuffix}\n\nThe data provider returned an error. This says nothing about the token itself. Please try again later.`,
    'rate-limited': `${e('⏳')} <b>Rate Limited</b>${mockSuffix}\n\nToo many requests. Please wait a moment and try again.`,
    'chain-unsupported': `${e('❗️')} <b>Chain Not Supported Yet</b>\n\n${esc(chainLabel(result.chain ?? ''))} is recognised, but no market data source covers it yet. This is not a statement about the token.`,
  };
  return msgs[status] ?? `${e('❗️')} <b>Scan failed.</b>${mockSuffix} Please try again.`;
}

/**
 * Holder numbers may arrive from the risk provider (live) or as a flat
 * `holders` object (mock fixtures and older callers). Prefer risk when present
 * so the card can never disagree with the Quick Checks block.
 */
function holderData(result) {
  const fromRisk = result?.risk?.holders;
  if (fromRisk && (fromRisk.total != null || fromRisk.top10Percentage != null)) return fromRisk;
  return result?.holders ?? {};
}

export function formatCard(result, {
  mockLabel    = false,
  websiteBase  = '',
  premiumUrl   = '',
  addBotUrl    = '',
  botUsername  = '',
  emojiTheme   = noTheme,
  view         = 'detailed',
} = {}) {
  const e = typeof emojiTheme === 'function' ? emojiTheme : noTheme;

  // ---- Failure cards ------------------------------------------------------
  if (!result || result.status !== 'ok') {
    return { text: renderStatusCard(result ?? { status: 'api-error' }, e, mockLabel), buttons: [] };
  }

  const { token, market, narrative, project, fullAnalysisUrl, updatedAt, mode } = result;
  const chain   = token?.chain ?? 'unknown';
  const address = token?.address ?? '';
  const name    = token?.name ?? 'Unknown';
  const symbol  = token?.symbol ?? '?';
  const detailed = view === 'detailed';

  const lines = [];

  // ---- Header -------------------------------------------------------------
  const mockTag = (mockLabel || mode === 'mock') ? ' <i>[mock]</i>' : '';
  if (detailed) {
    lines.push(`${e('🚀')} <b>MEME CHECKER | TOKEN ANALYSIS</b>${mockTag}`);
    lines.push('');
    lines.push(`${e('🪙')} <b>${esc(name)} ($${esc(symbol)})</b>`);
    lines.push(`${e('⛓️')} Chain: ${esc(chainLabel(chain))} (${e(chainIcon(chain))})`);
    lines.push(`${e('📌')} CA:`);
  } else {
    // Compact: identity and chain on two tight lines, then the CA.
    lines.push(`${e('🚀')} <b>${esc(name)}</b> <code>$${esc(symbol)}</code>${mockTag}`);
    lines.push(`${e(chainIcon(chain))} ${esc(chainLabel(chain))}`);
  }
  // Full contract address, once, on its own copyable line. Casing preserved.
  lines.push(`<code>${esc(address)}</code>`);

  // ---- Market -------------------------------------------------------------
  const price  = fmtUsd(market?.priceUsd, 8);
  const mcap   = fmtUsd(market?.marketCapUsd);
  const fdv    = fmtUsd(market?.fdvUsd);
  const liq    = fmtUsd(market?.liquidityUsd);
  const vol24h = fmtUsd(market?.volume24hUsd);
  const ch1h   = fmtPct(market?.priceChange1h);
  const ch24h  = fmtPct(market?.priceChange24h);
  const pairAge = market?.pairAge != null ? esc(String(market.pairAge)) : null;
  // fmtPct can emit "<-100%" for a clamped negative move, which is an illegal
  // HTML tag opener under parse_mode=HTML. Escape before interpolation.
  const ch1hHtml  = ch1h  ? esc(ch1h)  : null;
  const ch24hHtml = ch24h ? esc(ch24h) : null;

  lines.push('');
  if (detailed) {
    lines.push(DIV);
    lines.push(`${e('📊')} <b>MARKET DATA</b>`);
    lines.push('');
    if (price) lines.push(`Price: ${price}`);
    if (mcap)  lines.push(`Market Cap: ${mcap}`);
    if (fdv && fdv !== mcap) lines.push(`FDV: ${fdv}`);
    if (liq)   lines.push(`Liquidity: ${liq}`);
    if (market?.volume24hUsd === 0) lines.push('Volume 24H: $0');
    else if (vol24h) lines.push(`Volume 24H: ${vol24h}`);
    if (ch1hHtml)  lines.push(`Price Change 1H: ${ch1hHtml}`);
    if (ch24hHtml) lines.push(`Price Change 24H: ${ch24hHtml}`);
    if (pairAge) lines.push(`Pair Age: ${pairAge}`);
    const hasAnyMarket = price || mcap || liq || market?.volume24hUsd === 0 || vol24h || ch1h || ch24h;
    if (!hasAnyMarket) lines.push('<i>Market data unavailable</i>');
    if (marketLooksImplausible(market)) {
      lines.push('<i>⚠️ Market figures look inconsistent for this pair — treat with caution.</i>');
    }
  } else {
    // Compact: price is the headline, then one dense stats line.
    lines.push(price ? `${e('💰')} <b>Price</b> ${price}` : `${e('💰')} <b>Price</b> <i>unavailable</i>`);
    const stats = [];
    if (mcap) stats.push(`MC ${mcap}`);
    if (liq) stats.push(`Liq ${liq}`);
    if (ch24hHtml) stats.push(`24H ${ch24hHtml}`);
    if (pairAge) stats.push(`${pairAge} old`);
    lines.push(stats.length ? stats.join('  ·  ') : '<i>No market data available</i>');
    // Provider data is sometimes internally inconsistent, most often on
    // replica/low-liquidity pairs. Flag it instead of implying precision.
    if (marketLooksImplausible(market)) {
      lines.push('<i>⚠️ Market figures look inconsistent for this pair — treat with caution.</i>');
    }
  }

  // ---- Quick Checks (both modes, fixed order) ----------------------------
  lines.push('');
  lines.push(...renderQuickChecks(result, e));

  // ---- Holder Overview (detailed; compact covers it in Quick Checks) ------
  const h = holderData(result);
  const totalH  = fmtInt(h?.total);
  const top10   = fmtPp(h?.top10Percentage);
  const largest = fmtPp(h?.largestHolderPercentage);

  if (detailed) {
    lines.push('');
    lines.push(DIV);
    lines.push(`${e('👥')} <b>HOLDER OVERVIEW</b>`);
    lines.push('');
    if (totalH)  lines.push(`Total Holders: ${totalH}`);
    if (top10)   lines.push(`Top 10 Holders: ${top10}`);
    if (largest) lines.push(`Largest Holder: ${largest}`);
    if (!totalH && !top10 && !largest) lines.push('<i>Holder data unavailable</i>');

    // Security flags — only stated when actually known.
    const s = result?.risk?.security ?? {};
    const flags = [];
    if (s.honeypot === true) flags.push('⛔ Honeypot');
    else if (s.honeypot === false) flags.push('✅ Not honeypot');
    if (s.mintable === true) flags.push('⚠️ Mintable');
    else if (s.mintable === false) flags.push('✅ Fixed supply');
    if (s.freezable === true) flags.push('⚠️ Freezable');
    if (s.canTakeBackOwnership === true) flags.push('⚠️ Ownership retake');
    if (s.hiddenOwner === true) flags.push('⚠️ Hidden owner');
    if (s.cannotSellAll === true) flags.push('⚠️ Cannot sell all');
    if (s.openSource === false) flags.push('⚠️ Closed source');
    if (flags.length) {
      lines.push('');
      lines.push(`${e('🔐')} <b>SECURITY</b>`);
      lines.push(flags.join('  ·  '));
    }
  }

  // ---- Narrative ----------------------------------------------------------
  const hasNarrative = Boolean(narrative?.summary && narrative?.source);
  if (detailed) {
    lines.push('');
    lines.push(DIV);
    lines.push(`${e('🧠')} <b>NARRATIVE</b>`);
    lines.push('');
    if (hasNarrative) {
      lines.push(esc(narrative.summary));
      lines.push(`<i>Source: ${esc(narrative.source)}</i>`);
    } else {
      lines.push('<i>Narrative unavailable</i>');
    }
  } else if (hasNarrative) {
    lines.push('');
    lines.push(`${e('🧠')} ${esc(narrative.summary)}`);
  }

  // ---- Project info -------------------------------------------------------
  const links = [];
  if (project?.website) links.push(`<a href="${esc(project.website)}">${e('🌍')} Website</a>`);
  if (project?.x) links.push(`<a href="${esc(project.x)}">${e('✖️')} X</a>`);
  if (project?.telegram) links.push(`<a href="${esc(project.telegram)}">${e('✈️')} Telegram</a>`);

  if (detailed) {
    lines.push('');
    lines.push(DIV);
    lines.push(`${e('🌐')} <b>PROJECT INFO</b>`);
    lines.push('');
    lines.push(`${e('🌍')} Website: ${project?.website ? `<a href="${esc(project.website)}">Open Website</a>` : 'Not Available'}`);
    lines.push(`${e('✖️')} X: ${project?.x ? `<a href="${esc(project.x)}">Open X</a>` : 'Not Available'}`);
    lines.push(`${e('✈️')} Telegram: ${project?.telegram ? `<a href="${esc(project.telegram)}">Open Telegram</a>` : 'Not Available'}`);
  } else if (links.length) {
    lines.push('');
    lines.push(links.join('  ·  '));
  }

  // ---- DYOR teaser (detailed only) ---------------------------------------
  if (detailed) {
    lines.push('');
    lines.push(DIV);
    lines.push(`${e('🔎')} <b>WANT TO DYOR DEEPER?</b>`);
    lines.push('');
    lines.push('Discover more about this token:');
    lines.push('');
    lines.push('• Advanced Narrative');
    lines.push('• Dev Wallet Investigation');
    lines.push('• Bundle Wallet Analysis');
    lines.push('• Bubble Map &amp; Wallet Clusters');
    lines.push('• KOL Call History');
    lines.push('• Smart Money Insights');
    lines.push('');
    lines.push(`${e('➡️')} <b>FULL TOKEN ANALYSIS:</b>`);
    // Never end on a dangling label: say why there is nothing to tap.
    if (!isAcceptableUrl(fullAnalysisUrl)) {
      lines.push('<i>Full analysis page coming soon.</i>');
    }

    // Provenance so an "unknown" is explainable rather than mysterious.
    if (result?.dexPaid?.status === 'unknown' && result?.dexPaid?.detail) {
      lines.push(`<i>Dex Paid unknown: ${esc(result.dexPaid.detail)}</i>`);
    }
    if (result?.riskStatus === 'error' && result?.riskDetail) {
      lines.push(`<i>Risk data unavailable: ${esc(result.riskDetail)}</i>`);
    }
  }

  // ---- Updated / footer ---------------------------------------------------
  if (updatedAt) {
    lines.push('');
    lines.push(`<i>Updated: ${esc(updatedAt)}</i>`);
  }
  lines.push('');
  lines.push(`${e('⚡')} <i>Powered by MEME CHECKER</i>`);

  // ---- Inline keyboard (§9 order preserved) ------------------------------
  const analysisUrl = isAcceptableUrl(fullAnalysisUrl) ? fullAnalysisUrl : null;
  const resolvedPremiumUrl = isAcceptableUrl(premiumUrl) ? premiumUrl : null;
  const resolvedWebsiteUrl = isAcceptableUrl(websiteBase)
    ? `${websiteBase}?utm_source=telegram&utm_medium=group_bot&utm_campaign=explore` : null;
  const resolvedAddBotUrl = isAcceptableUrl(addBotUrl) ? addBotUrl
    : (botUsername ? `https://t.me/${encodeURIComponent(botUsername)}?startgroup=true` : null);

  const buttons = [];
  if (analysisUrl) buttons.push([{ text: '🔍 View Full Analysis', url: analysisUrl }]);

  const row2 = [];
  if (resolvedPremiumUrl) row2.push({ text: '🔐 Unlock Premium', url: resolvedPremiumUrl });
  if (resolvedWebsiteUrl) row2.push({ text: '🌐 Explore', url: resolvedWebsiteUrl });
  if (row2.length) buttons.push(row2);

  if (resolvedAddBotUrl) buttons.push([{ text: '➕ Add Meme Checker to Your Group', url: resolvedAddBotUrl }]);

  return { text: lines.join('\n'), buttons };
}

export { quickChecks };
