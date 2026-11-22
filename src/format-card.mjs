/**
 * src/format-card.mjs
 * Build the Telegram HTML result card and inline keyboard from a normalized scan result.
 *
 * Layout follows §4.1 of the product brief:
 *   Header → Market Data → Holder Overview → Narrative → Project Info →
 *   WANT TO DYOR DEEPER? (feature list + FULL TOKEN ANALYSIS CTA line) →
 *   Powered by MEME CHECKER
 *
 * Button order follows §9:
 *   Row 1: 🔍 Full Analysis
 *   Row 2: ⚡ Premium   🌐 Website
 *   Row 3: ➕ Add Bot to Group
 *
 * Accepts an optional `emojiTheme` function (from emoji-theme.mjs) for custom emoji.
 * Standard emoji is the default and automatic fallback.
 */
import { noTheme } from './emoji-theme.mjs';

function esc(v) {
  if (v == null) return '';
  return String(v)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function fmt(v, digits = 4) {
  if (v == null || !Number.isFinite(v)) return null;
  if (v === 0) return '$0';
  if (v >= 1e9) return `$${(v / 1e9).toFixed(2)}B`;
  if (v >= 1e6) return `$${(v / 1e6).toFixed(2)}M`;
  if (v >= 1e3) return `$${(v / 1e3).toFixed(1)}K`;
  if (v >= 1)   return `$${v.toFixed(2)}`;
  return `$${v.toFixed(digits)}`;
}

function fmtPct(v) {
  if (v == null || !Number.isFinite(v)) return null;
  return `${v >= 0 ? '+' : ''}${v.toFixed(2)}%`;
}

function fmtNum(v) {
  if (v == null || !Number.isFinite(v)) return null;
  return v.toLocaleString('en-US');
}

function shortAddr(addr, chain) {
  if (!addr) return '';
  if (chain === 'solana') return `${addr.slice(0, 4)}...${addr.slice(-4)}`;
  return `${addr.slice(0, 6)}...${addr.slice(-4)}`;
}

function chainLabel(chain) {
  if (chain === 'solana') return 'Solana';
  if (chain === 'bsc')    return 'BNB Chain';
  return chain ?? 'Unknown';
}

/** Standard emoji slot for a chain icon. BNB kept as standard 🟡 until custom logo confirmed. */
function chainIcon(chain) {
  if (chain === 'solana') return '🟣';
  if (chain === 'bsc')    return '🟡';
  return '⛓';
}

function explorerUrl(chain, address) {
  if (chain === 'solana') return `https://solscan.io/token/${address}`;
  if (chain === 'bsc')    return `https://bscscan.com/token/${address}`;
  return null;
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

/** Build the HTML card text and inline keyboard buttons. */
export function formatCard(result, {
  mockLabel    = false,
  websiteBase  = '',
  premiumUrl   = '',
  addBotUrl    = '',
  botUsername  = '',
  emojiTheme   = noTheme,
} = {}) {
  const { token, market, holders, narrative, project, fullAnalysisUrl, updatedAt, status, mode } = result;
  const e = typeof emojiTheme === 'function' ? emojiTheme : noTheme;

  // ---- Error cards --------------------------------------------------------
  if (status !== 'ok') {
    const mockSuffix = (mockLabel || mode === 'mock') ? ' <i>[mock]</i>' : '';
    const msgs = {
      'not-found':        `${e('⚠️')} <b>Token Not Found</b>${mockSuffix}\n\nNo data for this address. It may not have a trading pair yet.`,
      'invalid-response': `${e('⚠️')} <b>Scan Error</b>${mockSuffix}\n\nThe backend returned an unexpected response. Please try again.`,
      'api-error':        `${e('⚠️')} <b>Unable to fetch data</b>${mockSuffix}\n\nThe data provider returned an error. Please try again later.`,
      'rate-limited':     `${e('⏳')} <b>Rate Limited</b>${mockSuffix}\n\nToo many requests. Please wait a moment and try again.`,
    };
    return {
      text: msgs[status] ?? `${e('⚠️')} <b>Scan failed.</b>${mockSuffix} Please try again.`,
      buttons: [],
    };
  }

  const chain   = token?.chain   ?? 'unknown';
  const address = token?.address ?? '';
  const name    = token?.name    ?? 'Unknown';
  const symbol  = token?.symbol  ?? '?';

  const explorerLink = explorerUrl(chain, address);
  const addrDisplay  = esc(shortAddr(address, chain));
  const addrFull     = esc(address);

  const lines = [];

  const mockTag = (mockLabel || mode === 'mock') ? ' <i>[mock]</i>' : '';
  lines.push(`${e('🚀')} <b>MEME CHECKER | TOKEN ANALYSIS</b>${mockTag}`);
  lines.push('');
  lines.push(`${e('🪙')} <b>${esc(name)} ($${esc(symbol)})</b>`);
  lines.push(`${e('⛓')} Chain: ${esc(chainLabel(chain))} (${e(chainIcon(chain))})`);

  if (explorerLink) {
    lines.push(`${e('📍')} CA: <a href="${esc(explorerLink)}">${addrDisplay}</a> — <a href="${esc(explorerLink)}">Explorer ↗</a>`);
  } else {
    lines.push(`${e('📍')} CA:`);
  }
  // Full address on its own copyable monospace line (casing preserved, no link)
  lines.push(`<code>${addrFull}</code>`);

  // ---- Market Data --------------------------------------------------------
  lines.push('');
  lines.push(DIV);
  lines.push(`${e('💰')} <b>MARKET DATA</b>`);
  lines.push('');

  const price  = fmt(market?.priceUsd, 8);
  const mcap   = fmt(market?.marketCapUsd);
  const fdv    = fmt(market?.fdvUsd);
  const liq    = fmt(market?.liquidityUsd);
  const vol24h = fmt(market?.volume24hUsd);
  const ch1h   = fmtPct(market?.priceChange1h);
  const ch24h  = fmtPct(market?.priceChange24h);
  const pairAge = market?.pairAge != null ? esc(String(market.pairAge)) : null;

  if (price)   lines.push(`Price: ${price}`);
  if (mcap)    lines.push(`Market Cap: ${mcap}`);
  if (fdv && fdv !== mcap) lines.push(`FDV: ${fdv}`);
  if (liq)     lines.push(`Liquidity: ${liq}`);
  if (market?.volume24hUsd === 0) lines.push(`Volume 24H: $0`);
  else if (vol24h) lines.push(`Volume 24H: ${vol24h}`);
  if (ch1h)    lines.push(`Price Change 1H: ${ch1h}`);
  if (ch24h)   lines.push(`Price Change 24H: ${ch24h}`);
  if (pairAge) lines.push(`Pair Age: ${pairAge}`);

  const hasAnyMarket = price || mcap || liq || market?.volume24hUsd === 0 || vol24h || ch1h || ch24h;
  if (!hasAnyMarket) lines.push('<i>Market data unavailable</i>');

  // ---- Holder Overview ----------------------------------------------------
  lines.push('');
  lines.push(DIV);
  lines.push(`${e('📊')} <b>HOLDER OVERVIEW</b>`);
  lines.push('');

  const totalH  = fmtNum(holders?.total);
  const top10   = holders?.top10Percentage != null && Number.isFinite(holders.top10Percentage)
    ? `${holders.top10Percentage.toFixed(1)}%` : null;
  const largest = holders?.largestHolderPercentage != null && Number.isFinite(holders.largestHolderPercentage)
    ? `${holders.largestHolderPercentage.toFixed(1)}%` : null;

  if (totalH)  lines.push(`Total Holders: ${totalH}`);
  if (top10)   lines.push(`Top 10 Holders: ${top10}`);
  if (largest) lines.push(`Largest Holder: ${largest}`);
  if (!totalH && !top10 && !largest) lines.push('<i>Holder data unavailable</i>');

  // ---- Narrative ----------------------------------------------------------
  lines.push('');
  lines.push(DIV);
  lines.push(`${e('🧠')} <b>NARRATIVE</b>`);
  lines.push('');

  if (narrative?.summary && narrative?.source) {
    lines.push(esc(narrative.summary));
    lines.push(`<i>Source: ${esc(narrative.source)}</i>`);
  } else {
    lines.push('<i>Narrative unavailable</i>');
  }

  // ---- Project Info -------------------------------------------------------
  lines.push('');
  lines.push(DIV);
  lines.push(`${e('🌐')} <b>PROJECT INFO</b>`);
  lines.push('');
  lines.push(`${e('🌍')} Website: ${project?.website ? `<a href="${esc(project.website)}">Open Website</a>` : 'Not Available'}`);
  lines.push(`${e('✖️')} X: ${project?.x ? `<a href="${esc(project.x)}">Open X</a>` : 'Not Available'}`);
  lines.push(`${e('✈️')} Telegram: ${project?.telegram ? `<a href="${esc(project.telegram)}">Open Telegram</a>` : 'Not Available'}`);

  // ---- WANT TO DYOR DEEPER? (§4.1 / §5.3) --------------------------------
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
  lines.push(`${e('👉')} <b>FULL TOKEN ANALYSIS:</b>`);

  // ---- Updated at ---------------------------------------------------------
  if (updatedAt) {
    lines.push('');
    lines.push('━━━━━━━━━━━━━━━━━━');
    lines.push(`<i>Updated: ${esc(updatedAt)}</i>`);
  }

  lines.push('');
  lines.push(`${e('⚡')} <i>Powered by MEME CHECKER</i>`);

  // ---- Inline keyboard (§9 order) -----------------------------------------
  // Row 1: Full Analysis — from adapter-supplied URL only, never synthesized.
  const analysisUrl = isAcceptableUrl(fullAnalysisUrl) ? fullAnalysisUrl : null;

  // Row 2: Premium (independent setting) + Website
  // premiumUrl is a separate env — NOT auto-derived from websiteBase.
  const resolvedPremiumUrl = isAcceptableUrl(premiumUrl) ? premiumUrl : null;
  const resolvedWebsiteUrl = isAcceptableUrl(websiteBase)
    ? `${websiteBase}?utm_source=telegram&utm_medium=group_bot&utm_campaign=explore` : null;

  // Row 3: Add Bot to Group
  const resolvedAddBotUrl = isAcceptableUrl(addBotUrl) ? addBotUrl
    : (botUsername ? `https://t.me/${encodeURIComponent(botUsername)}?startgroup=true` : null);

  const buttons = [];
  if (analysisUrl)        buttons.push([{ text: '🔍 View Full Analysis', url: analysisUrl }]);

  const row2 = [];
  if (resolvedPremiumUrl) row2.push({ text: '⚡ Unlock Premium', url: resolvedPremiumUrl });
  if (resolvedWebsiteUrl) row2.push({ text: '🌐 Explore', url: resolvedWebsiteUrl });
  if (row2.length)        buttons.push(row2);

  if (resolvedAddBotUrl)  buttons.push([{ text: '➕ Add Meme Checker to Your Group', url: resolvedAddBotUrl }]);

  return { text: lines.join('\n'), buttons };
}
