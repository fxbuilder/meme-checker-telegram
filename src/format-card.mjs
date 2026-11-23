/**
 * src/format-card.mjs
 * Build the Telegram HTML result card.
 *
 * THREE MODES
 *   'standard' (BOT DEFAULT) — the balanced, premium card. Branding + logo +
 *              identity + copyable CA, a MARKET OVERVIEW of aligned metric rows,
 *              a SECURITY OVERVIEW with tone dots, narrative, project links, and
 *              a compact inline action row. Information-rich but scannable.
 *   'short'  — minimal summary for groups that explicitly ask for it
 *              (/short, or SHORT=1). Deliberately smaller; NOT the default.
 *   'detailed' — full technical output: expanded market block, security flags,
 *              provenance notes and the DYOR block for the website funnel.
 *
 * BACKWARD COMPATIBILITY
 *   formatCard(result, opts) keeps its signature and `view` option. The previous
 *   build's 'compact' and 'detailed' are both still accepted; 'compact' aliases
 *   to 'short' so any existing caller keeps rendering something sensible rather
 *   than breaking. The §4.1 detailed layout and every prior assertion still hold.
 *
 * DESIGN NOTES
 *   - aligned label/value rows, never one dense statistics line
 *   - whitespace between sections, not repeated horizontal rules
 *   - short meaningful labels ("MC", "LP Locked", "Creator Holds", "Tax (B/S)")
 *   - the creator label says "Holds" on purpose: it is a current balance, not a
 *     dev-history verdict
 *   - every interpolated value is escaped; "<1%" and "<-100%" are display
 *     strings that would otherwise be parsed as HTML tags and kill the message
 */
import { noTheme } from './emoji-theme.mjs';
import {
  esc, fmtUsd, fmtPct, fmtInt, fmtPp, marketLooksImplausible,
  resolveQuickCheck, quickChecks, securityPairs, alignedRows, sectionTitle,
} from './card-layout.mjs';
import { getChain } from './chains.mjs';

/**
 * Returns true only for absolute HTTPS URLs with no credentials and no
 * placeholder host. Mirrors the scan-result-contract §fullAnalysisUrl rule.
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

function chainName(chain) {
  return getChain(chain)?.name ?? (chain ? String(chain) : 'Unknown');
}

function chainIcon(chain) {
  return getChain(chain)?.emoji ?? '⛓️';
}

/** Holder numbers may come from the risk provider or a flat mock object. */
function holderData(result) {
  const fromRisk = result?.risk?.holders;
  if (fromRisk && (fromRisk.total != null || fromRisk.top10Percentage != null)) return fromRisk;
  return result?.holders ?? {};
}

/** The three-link block, used by standard and detailed. */
function projectLinkLines(project, e) {
  const rows = [];
  if (project?.website) rows.push(`<a href="${esc(project.website)}">${e('🌍')} Website</a>`);
  if (project?.x) rows.push(`<a href="${esc(project.x)}">${e('✖️')} X</a>`);
  if (project?.telegram) rows.push(`<a href="${esc(project.telegram)}">${e('✈️')} Telegram</a>`);
  return rows;
}

/**
 * Short, honest message for every non-ok status.
 * A capability gap is never phrased as a token finding.
 */
function renderStatusCard(result, e, mockLabel) {
  const { status = 'api-error', mode } = result;
  const mockSuffix = (mockLabel || mode === 'mock') ? ' <i>[mock]</i>' : '';
  const msgs = {
    'not-found': `${e('❗️')} <b>Token Not Found</b>${mockSuffix}\n\nNo trading pair exists for this contract yet.`,
    'invalid-response': `${e('❗️')} <b>Scan Error</b>${mockSuffix}\n\nThe data provider returned an unexpected response. Please try again.`,
    'api-error': `${e('❗️')} <b>Unable to fetch data</b>${mockSuffix}\n\nThe data provider returned an error. This says nothing about the token itself. Please try again shortly.`,
    'rate-limited': `${e('⏳')} <b>Rate Limited</b>${mockSuffix}\n\nToo many requests right now. Please wait a moment.`,
    'chain-unsupported': `${e('❗️')} <b>Chain Not Supported Yet</b>\n\n${esc(chainName(result.chain ?? ''))} is recognised, but no market data source covers it yet. This is not a statement about the token.`,
  };
  return msgs[status] ?? `${e('❗️')} <b>Scan Failed</b>${mockSuffix} Please try again.`;
}

// ---------------------------------------------------------------------------
// Section builders
// ---------------------------------------------------------------------------

/** Header: branding, optional logo, name/ticker, chain, copyable CA. */
function buildHeader(result, e, mockTag) {
  const { token } = result;
  const name = token?.name ?? 'Unknown';
  const symbol = token?.symbol ?? '?';
  const chain = token?.chain ?? 'unknown';
  const address = token?.address ?? '';
  const logo = isAcceptableUrl(token?.logo) ? token.logo : null;

  const lines = [];
  lines.push(`${e('🚀')} <b>MEME CHECKER</b>${mockTag}`);

  // Logo as a one-line HTML image preview above the name block. Telegram renders
  // this as a web preview; if the URL is absent we simply omit it. It is never
  // invented and never blocks the rest of the card.
  if (logo) {
    lines.push(`<a href="${esc(logo)}">&#8203;</a>`);
    lines[lines.length - 1] = '';
  }

  lines.push(`${e('🪙')} <b>${esc(name)}</b>  <code>$${esc(symbol)}</code>`);
  lines.push(`${chainIcon(chain)} ${esc(chainName(chain))}`);
  lines.push('');
  lines.push(`<code>${esc(address)}</code>`);
  return lines;
}

/** MARKET OVERVIEW — aligned rows, never a dense one-liner. */
function buildMarket(result, e) {
  const { market } = result;
  const rows = [];

  const price = fmtUsd(market?.priceUsd, 8);
  const mcap = fmtUsd(market?.marketCapUsd);
  const fdv = fmtUsd(market?.fdvUsd);
  const liq = fmtUsd(market?.liquidityUsd);
  const vol = market?.volume24hUsd === 0 ? '$0' : fmtUsd(market?.volume24hUsd, 2);
  const ch1h = fmtPct(market?.priceChange1h);
  const ch24h = fmtPct(market?.priceChange24h);
  const age = market?.pairAge != null ? String(market.pairAge) : null;

  const pairs = [];
  if (price) pairs.push({ label: 'Price', value: price });
  if (mcap) pairs.push({ label: 'Market Cap', value: mcap });
  if (fdv && fdv !== mcap) pairs.push({ label: 'FDV', value: fdv });
  if (liq) pairs.push({ label: 'Liquidity', value: liq });
  if (vol) pairs.push({ label: 'Volume 24H', value: vol });
  if (ch1h) pairs.push({ label: 'Change 1H', value: ch1h });
  if (ch24h) pairs.push({ label: 'Change 24H', value: ch24h });
  if (age) pairs.push({ label: 'Pair Age', value: age });

  if (!pairs.length) {
    rows.push('<i>Market data unavailable</i>');
    return rows;
  }
  rows.push(...alignedRows(pairs));

  // A material inconsistency is disclosed, never hidden to keep the card short.
  if (marketLooksImplausible(market)) {
    rows.push('');
    rows.push('<i>⚠️ Some figures look inconsistent for this pair — verify before acting.</i>');
  }
  return rows;
}

/**
 * SECURITY OVERVIEW — holders, concentration, Dex Paid, tax, LP, creator.
 * Holder values may arrive on the flat `holders` object (mock fixtures, older
 * callers) instead of via risk data; merge so a present value is never shown as
 * missing just because it came from the other shape.
 */
function buildSecurity(result, e) {
  const h = holderData(result);
  const merged = {
    ...result,
    risk: {
      ...(result?.risk ?? {}),
      holders: {
        total: result?.risk?.holders?.total ?? h?.total ?? null,
        top10Percentage: result?.risk?.holders?.top10Percentage ?? h?.top10Percentage ?? null,
        largestHolderPercentage: result?.risk?.holders?.largestHolderPercentage ?? h?.largestHolderPercentage ?? null,
      },
    },
  };
  const pairs = securityPairs(merged);
  const rows = alignedRows(pairs);

  // A provider FAILURE is not the same claim as "the provider reported nothing".
  // Say so explicitly rather than showing five identical dashes that read as a
  // clean-ish card.
  if (result?.riskStatus === 'error') {
    rows.push('');
    rows.push('<i>⚠️ Risk data could not be fetched right now — signals above are incomplete, not clear.</i>');
    return rows;
  }

  // A one-line scope note keeps the numbers from reading as a safety verdict.
  // Only shown when there is something to qualify.
  const anyData = pairs.some((p) => p.value !== '—' && p.value !== 'n/a');
  if (anyData) {
    rows.push('');
    rows.push("<i>Signals only, not a safety verdict. Top 10 is the provider's top accounts as returned.</i>");
  } else if (result?.riskStatus === 'unsupported') {
    rows.push('');
    rows.push('<i>No on-chain risk source covers this chain yet.</i>');
  }
  return rows;
}

/** NARRATIVE — concise evidence-based summary, or one clean unavailable line. */
function buildNarrative(result, e, mode = 'standard') {
  const n = result?.narrative;
  if (n?.summary && n?.source) {
    return [esc(n.summary), `<i>Source: ${esc(n.source)}</i>`];
  }
  // Detailed keeps the documented §4.1 sentence; standard uses plainer wording.
  return [mode === 'detailed'
    ? '<i>Narrative unavailable</i>'
    : '<i>No verified narrative available.</i>'];
}

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

/**
 * Build the inline keyboard.
 * Only URLs that actually resolve become buttons — an inactive destination is
 * omitted, never rendered as a dead or fake button.
 */
function buildActions(result, { websiteBase, premiumUrl, addBotUrl, botUsername, view }) {
  const chartUrl = isAcceptableUrl(result?.chartUrl) ? result.chartUrl : null;
  const analysisUrl = isAcceptableUrl(result?.fullAnalysisUrl) ? result.fullAnalysisUrl : null;
  const resolvedWebsite = isAcceptableUrl(websiteBase)
    ? `${websiteBase}?utm_source=telegram&utm_medium=group_bot&utm_campaign=explore` : null;
  const resolvedPremium = isAcceptableUrl(premiumUrl) ? premiumUrl : null;
  const resolvedAddBot = isAcceptableUrl(addBotUrl) ? addBotUrl
    : (botUsername ? `https://t.me/${encodeURIComponent(botUsername)}?startgroup=true` : null);

  const buttons = [];
  const row1 = [];
  if (chartUrl) row1.push({ text: '📈 Chart', url: chartUrl });
  if (analysisUrl) row1.push({ text: '🔍 View Full Analysis', url: analysisUrl });
  if (row1.length) buttons.push(row1);

  const row2 = [];
  if (resolvedPremium) row2.push({ text: '🔐 Premium', url: resolvedPremium });
  if (resolvedWebsite) row2.push({ text: '🌐 Explore', url: resolvedWebsite });
  if (row2.length) buttons.push(row2);

  if (resolvedAddBot) buttons.push([{ text: '➕ Add to Group', url: resolvedAddBot }]);

  return buttons;
}

// ---------------------------------------------------------------------------
// Main entry
// ---------------------------------------------------------------------------

/** Map legacy/alias view names onto the three real modes. */
export function normalizeView(view) {
  const v = String(view ?? '').toLowerCase();
  if (v === 'standard' || v === 'default') return 'standard';
  if (v === 'short' || v === 'compact') return 'short';
  if (v === 'detailed' || v === 'detail') return 'detailed';
  return 'standard';
}

export function formatCard(result, {
  mockLabel   = false,
  websiteBase = '',
  premiumUrl  = '',
  addBotUrl   = '',
  botUsername = '',
  emojiTheme  = noTheme,
  // Library default stays 'detailed' so the documented §4.1 contract and every
  // existing caller are unchanged. The BOT passes 'standard' explicitly, so the
  // user-facing default is the standard card.
  view        = 'detailed',
} = {}) {
  const e = typeof emojiTheme === 'function' ? emojiTheme : noTheme;
  const mode = normalizeView(view);

  if (!result || result.status !== 'ok') {
    return { text: renderStatusCard(result ?? { status: 'api-error' }, e, mockLabel), buttons: [] };
  }

  const { token, narrative, project, fullAnalysisUrl, updatedAt, mode: scanMode } = result;
  const mockTag = (mockLabel || scanMode === 'mock') ? ' <i>[mock]</i>' : '';

  const lines = [];

  // ===== SHORT =============================================================
  if (mode === 'short') {
    const { market } = result;
    const h = holderData(result);
    lines.push(`${e('🚀')} <b>${esc(token?.name ?? 'Unknown')}</b> <code>$${esc(token?.symbol ?? '?')}</code>${mockTag}`);
    lines.push(`${chainIcon(token?.chain)} ${esc(chainName(token?.chain))}`);
    lines.push(`<code>${esc(token?.address ?? '')}</code>`);
    lines.push('');
    const price = fmtUsd(market?.priceUsd, 8);
    const mcap = fmtUsd(market?.marketCapUsd);
    const liq = fmtUsd(market?.liquidityUsd);
    const ch24h = fmtPct(market?.priceChange24h);
    const shortRows = [];
    if (price) shortRows.push({ label: 'Price', value: price });
    if (mcap) shortRows.push({ label: 'MC', value: mcap });
    if (liq) shortRows.push({ label: 'Liq', value: liq });
    if (ch24h) shortRows.push({ label: '24H', value: ch24h });
    if (shortRows.length) lines.push(...alignedRows(shortRows));
    else lines.push('<i>Market data unavailable</i>');

    const sec = securityPairs(result).filter((p) => p.value !== '—' && p.value !== 'n/a');
    if (sec.length) {
      lines.push('');
      lines.push(...alignedRows(sec));
    }
    lines.push('');
    lines.push(`${e('⚡')} <i>Meme Checker</i>`);

    return {
      text: lines.join('\n'),
      buttons: buildActions(result, { websiteBase, premiumUrl, addBotUrl, botUsername, view: mode }),
    };
  }

  // ===== HEADER (standard + detailed) ======================================
  const logo = isAcceptableUrl(token?.logo) ? token.logo : null;
  if (mode === 'detailed') {
    lines.push(`${e('🚀')} <b>MEME CHECKER | TOKEN ANALYSIS</b>${mockTag}`);
    lines.push('');
  } else {
    lines.push(`${e('🚀')} <b>MEME CHECKER</b>${mockTag}`);
    // NOTE: a logo URL does not render as a token thumbnail in a plain text
    // message, and a bare image glyph read as a rendering bug. The logo is kept
    // in the scan payload for the website/detailed surfaces but is not printed
    // here. A real thumbnail needs sendPhoto or a media group.
    void logo;
  }

  if (mode === 'detailed') {
    lines.push(`${e('🪙')} <b>${esc(token?.name ?? 'Unknown')} ($${esc(token?.symbol ?? '?')})</b>`);
    lines.push(`${e('⛓️')} Chain: ${esc(chainName(token?.chain))} (${e(chainIcon(token?.chain))})`);
    lines.push(`${e('📌')} CA:`);
  } else {
    lines.push(`${e('🪙')} <b>${esc(token?.name ?? 'Unknown')}</b>  <code>$${esc(token?.symbol ?? '?')}</code>`);
    lines.push(`${chainIcon(token?.chain)} ${esc(chainName(token?.chain))}`);
  }
  lines.push(`<code>${esc(token?.address ?? '')}</code>`);

  // ===== MARKET + SECURITY =================================================
  // Detailed keeps the documented §4.1 headings so the earlier contract and its
  // regression tests still hold; standard uses the shorter section names.
  lines.push('');
  lines.push(sectionTitle(e('📊'), mode === 'detailed' ? 'MARKET DATA' : 'MARKET OVERVIEW'));
  lines.push('');
  lines.push(...buildMarket(result, e));

  lines.push('');
  lines.push(sectionTitle(e('🛡️'), mode === 'detailed' ? 'HOLDER OVERVIEW' : 'SECURITY OVERVIEW'));
  lines.push('');
  lines.push(...buildSecurity(result, e));

  // ===== DETAILED-only technical additions ================================
  if (mode === 'detailed') {
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
      lines.push(sectionTitle(e('🔐'), 'RISK FLAGS'));
      lines.push(flags.join('  ·  '));
    }

    const h = holderData(result);
    lines.push('');
    lines.push(sectionTitle(e('👥'), 'HOLDER DETAIL'));
    lines.push('');
    const detailRows = [];
    const total = fmtInt(h?.total);
    const top10 = fmtPp(h?.top10Percentage);
    const largest = fmtPp(h?.largestHolderPercentage);
    if (total) detailRows.push({ label: 'Total Holders', value: total });
    if (top10) detailRows.push({ label: 'Top 10 Holders', value: top10 });
    if (largest) detailRows.push({ label: 'Largest Holder', value: largest });
    lines.push(...(detailRows.length ? alignedRows(detailRows) : ['<i>Holder data unavailable</i>']));

    // Provenance: why a value is unknown, so it is explainable.
    const notes = [];
    if (result?.dexPaid?.status === 'unknown' && result?.dexPaid?.detail) {
      notes.push(`Dex Paid unknown: ${esc(result.dexPaid.detail)}`);
    }
    if (result?.riskStatus === 'error' && result?.riskDetail) {
      notes.push(`Risk data unavailable: ${esc(result.riskDetail)}`);
    }
    if (result?.source?.provider) {
      notes.push(`Market: ${esc(result.source.provider)} · ${esc(result.source.pairs ?? '?')} pairs matched`);
    }
    if (notes.length) {
      lines.push('');
      lines.push(sectionTitle(e('🔎'), 'SOURCES'));
      for (const n of notes) lines.push(`<i>${n}</i>`);
    }
  }

  // ===== NARRATIVE ========================================================
  lines.push('');
  lines.push(sectionTitle(e('🧠'), 'NARRATIVE'));
  lines.push('');
  lines.push(...buildNarrative(result, e, mode));

  // ===== PROJECT LINKS ====================================================
  lines.push('');
  lines.push(sectionTitle(e('🌐'), mode === 'detailed' ? 'PROJECT INFO' : 'PROJECT LINKS'));
  lines.push('');
  if (mode === 'detailed') {
    // §4.1 keeps an explicit cell per destination so absence is unambiguous.
    lines.push(`${e('🌍')} Website: ${project?.website ? `<a href="${esc(project.website)}">Open Website</a>` : 'Not Available'}`);
    lines.push(`${e('✖️')} X: ${project?.x ? `<a href="${esc(project.x)}">Open X</a>` : 'Not Available'}`);
    lines.push(`${e('✈️')} Telegram: ${project?.telegram ? `<a href="${esc(project.telegram)}">Open Telegram</a>` : 'Not Available'}`);
  } else {
    const linkLines = projectLinkLines(project, e);
    lines.push(...(linkLines.length ? [linkLines.join('\n')] : ['<i>No verified project links available.</i>']));
  }

  // ===== DYOR funnel: DETAILED only, and no dead CTA block ================
  if (mode === 'detailed') {
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
    if (!isAcceptableUrl(fullAnalysisUrl)) {
      lines.push('<i>Full analysis page coming soon.</i>');
    }
  }

  // ===== Footer ===========================================================
  if (updatedAt) {
    lines.push('');
    lines.push(`<i>Updated: ${esc(updatedAt)}</i>`);
  }
  lines.push('');
  lines.push(`${e('⚡')} <i>Powered by MEME CHECKER</i>`);

  return {
    text: lines.join('\n'),
    buttons: buildActions(result, { websiteBase, premiumUrl, addBotUrl, botUsername, view: mode }),
  };
}

export { quickChecks, resolveQuickCheck };
