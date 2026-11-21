/**
 * src/format-card.mjs
 * Build the Telegram HTML result card and inline keyboard from a normalized scan result.
 * Uses HTML parse mode to escape characters safely.
 */

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

function explorerUrl(chain, address) {
  if (chain === 'solana') return `https://solscan.io/token/${address}`;
  if (chain === 'bsc')    return `https://bscscan.com/token/${address}`;
  return null;
}

/**
 * Returns true only for absolute HTTPS URLs with no credentials and no placeholder host.
 * Mirrors the scan-result-contract §fullAnalysisUrl rule.
 */
function isAcceptableUrl(url) {
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

/** Build the HTML card text and inline keyboard buttons. */
export function formatCard(result, { mockLabel = false, websiteBase = '' } = {}) {
  const { token, market, holders, narrative, project, fullAnalysisUrl, updatedAt, status, mode } = result;

  // ---- Error cards --------------------------------------------------------
  if (status !== 'ok') {
    const mockSuffix = (mockLabel || mode === 'mock') ? ' <i>[mock]</i>' : '';
    const msgs = {
      'not-found':        `⚠️ <b>Token Not Found</b>${mockSuffix}\n\nNo data for this address. It may not have a trading pair yet.`,
      'invalid-response': `⚠️ <b>Scan Error</b>${mockSuffix}\n\nThe backend returned an unexpected response. Please try again.`,
      'api-error':        `⚠️ <b>Unable to fetch data</b>${mockSuffix}\n\nThe data provider returned an error. Please try again later.`,
      'rate-limited':     `⏳ <b>Rate Limited</b>${mockSuffix}\n\nToo many requests. Please wait a moment and try again.`,
    };
    return {
      text: msgs[status] ?? `⚠️ <b>Scan failed.</b>${mockSuffix} Please try again.`,
      buttons: [],
    };
  }

  // ---- Identity -----------------------------------------------------------
  const chain   = token?.chain  ?? 'unknown';
  const address = token?.address ?? '';
  const name    = token?.name   ?? 'Unknown';
  const symbol  = token?.symbol ?? '?';

  const explorerLink = explorerUrl(chain, address);
  const addrDisplay  = esc(shortAddr(address, chain));
  const addrFull     = esc(address);

  let lines = [];

  lines.push(`🚀 <b>MEME CHECKER | TOKEN ANALYSIS</b>${mockLabel || mode === 'mock' ? ' <i>[mock]</i>' : ''}`);
  lines.push('');
  lines.push(`🪙 <b>${esc(name)} ($${esc(symbol)})</b>`);
  lines.push(`⛓ Chain: ${esc(chainLabel(chain))}`);

  if (explorerLink) {
    lines.push(`📍 CA: <a href="${esc(explorerLink)}">${addrDisplay}</a>`);
  } else {
    lines.push(`📍 CA: <code>${addrFull}</code>`);
  }

  // ---- Market data --------------------------------------------------------
  const price    = fmt(market?.priceUsd, 8);
  const mcap     = fmt(market?.marketCapUsd);
  const fdv      = fmt(market?.fdvUsd);
  const liq      = fmt(market?.liquidityUsd);
  const vol24h   = fmt(market?.volume24hUsd);
  const ch24h    = fmtPct(market?.priceChange24h);

  const hasMarket = price || mcap || liq || vol24h;
  if (hasMarket) {
    lines.push('');
    lines.push('━━━━━━━━━━━━━━━━━━');
    lines.push('💰 <b>MARKET DATA</b>');
    lines.push('');
    if (price)  lines.push(`Price: ${price}`);
    if (mcap)   lines.push(`Market Cap: ${mcap}`);
    // FDV shown only when explicitly present AND distinct from mcap
    if (fdv && fdv !== mcap) lines.push(`FDV: ${fdv}`);
    if (liq)    lines.push(`Liquidity: ${liq}`);
    if (vol24h) lines.push(`Volume 24H: ${vol24h}`);
    if (ch24h)  lines.push(`Price Change 24H: ${ch24h}`);
    if (!price && !mcap) lines.push('<i>Market data unavailable</i>');
  } else {
    lines.push('');
    lines.push('━━━━━━━━━━━━━━━━━━');
    lines.push('💰 <b>MARKET DATA</b>');
    lines.push('');
    lines.push('<i>Market data unavailable</i>');
  }

  // ---- Holders ------------------------------------------------------------
  const totalH = fmtNum(holders?.total);
  const top10  = holders?.top10Percentage != null && Number.isFinite(holders.top10Percentage)
    ? `${holders.top10Percentage.toFixed(1)}%` : null;
  const largest = holders?.largestHolderPercentage != null && Number.isFinite(holders.largestHolderPercentage)
    ? `${holders.largestHolderPercentage.toFixed(1)}%` : null;

  if (totalH || top10 || largest) {
    lines.push('');
    lines.push('━━━━━━━━━━━━━━━━━━');
    lines.push('📊 <b>HOLDER OVERVIEW</b>');
    lines.push('');
    if (totalH)  lines.push(`Total Holders: ${totalH}`);
    if (top10)   lines.push(`Top 10 Holders: ${top10}`);
    if (largest) lines.push(`Largest Holder: ${largest}`);
  }

  // ---- Narrative (only when a verified source is present) -----------------
  if (narrative?.summary && narrative?.source) {
    lines.push('');
    lines.push('━━━━━━━━━━━━━━━━━━');
    lines.push('🧠 <b>NARRATIVE</b>');
    lines.push('');
    lines.push(esc(narrative.summary));
    lines.push(`<i>Source: ${esc(narrative.source)}</i>`);
  }

  // ---- Project info -------------------------------------------------------
  const hasProject = project?.website || project?.x || project?.telegram;
  if (hasProject) {
    lines.push('');
    lines.push('━━━━━━━━━━━━━━━━━━');
    lines.push('🌐 <b>PROJECT INFO</b>');
    lines.push('');
    lines.push(`Website: ${project.website ? `<a href="${esc(project.website)}">Open Website</a>` : 'Not Available'}`);
    lines.push(`X: ${project.x ? `<a href="${esc(project.x)}">Open X</a>` : 'Not Available'}`);
    lines.push(`Telegram: ${project.telegram ? `<a href="${esc(project.telegram)}">Open Telegram</a>` : 'Not Available'}`);
  }

  // ---- Premium teaser -----------------------------------------------------
  lines.push('');
  lines.push('━━━━━━━━━━━━━━━━━━');
  lines.push('🔒 <b>MORE INTELLIGENCE AVAILABLE</b>');
  lines.push('');
  lines.push('Want to know more about this token?');
  lines.push('');
  lines.push('• Are wallets connected to the Dev?');
  lines.push('• Is the supply concentrated in related wallets?');
  lines.push('• Which KOLs have mentioned this token?');
  lines.push('• What does the Bubble Map reveal?');
  lines.push('• Are large wallets buying or selling?');

  // ---- Updated at ---------------------------------------------------------
  if (updatedAt) {
    lines.push('');
    lines.push('━━━━━━━━━━━━━━━━━━');
    lines.push(`<i>Updated: ${esc(updatedAt)}</i>`);
  }

  lines.push('');
  lines.push('⚡ <i>Powered by MEME CHECKER</i>');

  // ---- Inline keyboard ----------------------------------------------------
  // Only use fullAnalysisUrl when the adapter explicitly provided it.
  // Never synthesize a token URL from websiteBase — the route is not confirmed.
  // Additionally reject placeholder hosts and credentialed URLs per the scan-result contract.
  const analysisUrl = isAcceptableUrl(fullAnalysisUrl) ? fullAnalysisUrl : null;

  const premiumUrl = websiteBase ? `${websiteBase}/pricing?utm_source=telegram&utm_medium=group_bot&utm_campaign=premium` : null;
  const websiteUrl = websiteBase ? `${websiteBase}?utm_source=telegram&utm_medium=group_bot&utm_campaign=explore` : null;

  const buttons = [];
  if (analysisUrl) buttons.push([{ text: '🔍 View Full Analysis', url: analysisUrl }]);

  const row2 = [];
  if (premiumUrl) row2.push({ text: '⚡ Unlock Premium', url: premiumUrl });
  if (websiteUrl) row2.push({ text: '🌐 Explore', url: websiteUrl });
  if (row2.length) buttons.push(row2);

  return { text: lines.join('\n'), buttons };
}
