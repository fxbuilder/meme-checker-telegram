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
  esc, fmtUsd, fmtPct, fmtInt, fmtPp, marketLooksImplausible, marketImplausibilities,
  resolveQuickCheck, quickChecks, securityPairs, alignedRows, sectionTitle,
} from './card-layout.mjs';
import { getChain } from './chains.mjs';
import { callerLabel } from './caller-identity.mjs';

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

  // A material inconsistency is disclosed, never hidden to keep the card short - and the
  // WARNING NAMES THE FIELD. "Some figures look inconsistent" told the reader nothing
  // they could act on; naming the figure lets them decide which parts of the card to
  // trust.
  const implausible = marketImplausibilities(market);
  if (implausible.length) {
    rows.push('');
    const named = implausible.slice(0, 2).map((i) => i.label).join(' and ');
    rows.push(`<i>⚠️ ${named} look inconsistent for this pair — verify before acting.</i>`);
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

  // A capability caveat is kept ONLY when it states a real limitation (no source
  // covers this chain). The former "Signals only, not a safety verdict..." note
  // was removed at the owner's request and is deliberately not replaced.
  const anyData = pairs.some((p) => p.value !== '—' && p.value !== 'n/a');
  if (!anyData && result?.riskStatus === 'unsupported') {
    rows.push('');
    rows.push('<i>No on-chain risk source covers this chain yet.</i>');
  }
  return rows;
}

/** NARRATIVE — concise evidence-based summary, or one clean unavailable line. */
/**
 * Narrative lines for the card.
 *
 * OWNER requirement (4A/C): the standard card must not carry a technical source footer
 * like `Source: Project's own description — unverified claim · Project description
 * (GeckoTerminal)`. It is noise on a phone, and it repeated the same string on every
 * scan.
 *
 * Epistemic accuracy is preserved IN THE PROSE instead: a self-reported description is
 * introduced with wording that attributes it to the project, so removing the footer
 * does not silently promote a claim to a verified fact. Full attribution stays in
 * `/narrative CA`, which is where someone auditing evidence will look.
 *
 * The prose is also kept to roughly 25-45 words: a card is not an article, and a
 * mid-sentence truncation reads as a bug.
 */
function buildNarrative(result, e, mode = 'standard') {
  const n = result?.narrative;
  if (n?.summary) {
    const body = narrativeProse(n);
    if (!body) {
      return [mode === 'detailed'
        ? '<i>Narrative unavailable</i>'
        : '<i>No reliable narrative available.</i>'];
    }
    return [body];
  }
  // Detailed keeps the documented §4.1 sentence; standard uses plainer wording.
  return [mode === 'detailed'
    ? '<i>Narrative unavailable</i>'
    : '<i>No reliable narrative available.</i>'];
}

/**
 * Trim prose to a word budget without cutting mid-clause.
 *
 * Preference order: a complete sentence that fits; otherwise the last comma/semicolon
 * boundary that fits; otherwise drop trailing words until the budget is met. Never
 * leaves a dangling preposition or an ellipsis glued to a half word.
 */
export function clipWords(text, { min = 25, max = 45 } = {}) {
  const clean = String(text ?? '').replace(/\s+/g, ' ').trim();
  if (!clean) return '';
  const words = clean.split(' ');
  if (words.length <= max) {
    // Already short: keep it whole. Upstream already rejects stub text, so a brief
    // sentence here is a genuinely brief description - dropping it would turn a real
    // narrative into "No reliable narrative available".
    return words.length >= 4 ? clean : '';
  }

  const head = words.slice(0, max).join(' ');

  // 1. A sentence end inside the budget is ideal.
  const sentenceEnd = Math.max(head.lastIndexOf('. '), head.lastIndexOf('! '), head.lastIndexOf('? '));
  if (sentenceEnd > 0) {
    const cut = head.slice(0, sentenceEnd + 1);
    if (cut.split(' ').length >= min) return cut;
  }
  // 2. A clause boundary reads much better than an arbitrary word cut.
  const clauseEnd = Math.max(head.lastIndexOf(', '), head.lastIndexOf('; '), head.lastIndexOf(' — '));
  if (clauseEnd > 0) {
    const cut = head.slice(0, clauseEnd);
    if (cut.split(' ').length >= Math.min(min, 15)) return `${cut}.`;
  }
  // 3. Last resort: the budget itself, with no ellipsis mid-sentence.
  return head.replace(/[,;:\-—]$/, '') + '.';
}

/**
 * Attribute a description to the project in natural language.
 *
 * A claim rendered as a bare sentence reads as fact. This keeps the card honest
 * without a footer.
 */
/**
 * Append a compact provenance marker to a self-contained description.
 *
 * "TEXEL is the token of Texel..." is the project's own sentence, so it must not be
 * dressed up with a prefix. Attribution is a short trailing tag instead, which keeps the
 * prose intact and still tells the reader whose words these are.
 */
function appendProvenance(text) {
  const t = String(text).trim();
  // Only add the tag once, and never on text that already carries attribution.
  if (/\b(project|team|according to|official)\b/i.test(t.slice(-40))) return t;
  return `${t} (project description)`;
}

export function narrativeProse(n) {
  const raw = clipWords(n.summary);
  if (!raw) return '';

  if (n.evidence === 'project-claim') {
    // A description that already names its own subject is a complete sentence. Prefixing
    // it produced "The project describes itself in these terms. TEXEL is the token of
    // Texel, the onchain GPU cloud..." - mechanical filler in front of something that
    // reads perfectly well on its own. The OWNER flagged exactly this.
    //
    // Attribution matters, so it is carried by a short parenthetical at the END where it
    // does not interrupt the sentence, and only when the summary does not already open
    // with the project's name.
    if (/^(the project|its team|the team|according to|we |our )/i.test(raw)) return esc(raw);

    const opensWithSubject = /^[A-Z][\w$.'\u2019\-]*\s+(is|was|are|were)\b/.test(raw);
    if (opensWithSubject) {
      // No preamble: the sentence is already complete. Provenance is appended instead.
      return esc(appendProvenance(raw));
    }
    // "describes itself as A community-driven token" needs the article lowered, or the
    // sentence reads like a heading pasted mid-line.
    const lowered = raw.replace(/^(A|An|The)\b/, (m) => m.toLowerCase());
    return esc(`The project describes itself as ${lowered}`);
  }
  if (n.evidence === 'reported') {
    return esc(`Third-party descriptions report: ${raw}`);
  }
  if (n.evidence === 'verified') {
    return esc(raw);
  }
  return esc(raw);
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
  const resolvedWebsite = isAcceptableUrl(websiteBase)
    ? `${websiteBase}?utm_source=telegram&utm_medium=group_bot&utm_campaign=explore` : null;
  const resolvedPremium = isAcceptableUrl(premiumUrl) ? premiumUrl : null;
  const resolvedAddBot = isAcceptableUrl(addBotUrl) ? addBotUrl
    : (botUsername ? `https://t.me/${encodeURIComponent(botUsername)}?startgroup=true` : null);

  // Card buttons: Add to Group, plus a Refresh action when the card can identify
  // what to re-scan.
  //
  // Chart, Full Analysis, Premium and Website were removed at the owner's request.
  // Only the real startgroup link is used - never a synthesized URL.
  //
  // REFRESH carries a callback (`r:<chain>:<address>`), not a URL. It re-reads market
  // data through the existing provider path and edits this card in place, so it must
  // never create a second card or a second call record.
  const buttons = [];
  if (resolvedAddBot) buttons.push([{ text: '➕ Add to Group', url: resolvedAddBot }]);

  const refreshData = result?.refreshData;
  if (typeof refreshData === 'string' && refreshData.length > 0 && refreshData.length <= 64) {
    buttons.push([{ text: '🔄 Refresh', callback_data: refreshData }]);
  }
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

/**
 * The "First Call" line shown inside the token card.
 *
 * Shape:  🔥 First Call <a>Name</a> @ $18.22M
 * The name is a deep link into the bot DM so the profile opens in-chat rather
 * than a Telegram user profile (which a bot cannot target anyway). When no
 * signed token is available the name renders as plain bold text — an
 * unclickable name is better than a link that goes somewhere wrong.
 */
export function renderFirstCallLine(firstCall, e = (x) => x, { botUsername = '', callerToken = null } = {}) {
  const name = callerLabel(firstCall);
  const mcap = fmtUsd(firstCall?.entryMarketCapUsd);
  const label = clipText(name, 24);
  const nameHtml = (callerToken && botUsername)
    ? `<a href="https://t.me/${encodeURIComponent(botUsername)}?start=${encodeURIComponent(callerToken)}">${esc(label)}</a>`
    : `<b>${esc(label)}</b>`;
  const at = mcap ? ` @ <b>${esc(mcap)}</b>` : '';
  return `${e('🔥')} First Call ${nameHtml}${at}`;
}

/**
 * Compact elapsed format: `3h 8m`, `4h`, `12m`, `2d 3h`.
 * Minutes are dropped once the call is days old — the precision is noise by then.
 */
export function elapsedLabel(calledAt, now = Date.now()) {
  if (!Number.isFinite(calledAt)) return null;
  const ms = Math.max(0, now - calledAt);
  const min = Math.floor(ms / 60_000);
  if (min < 1) return 'just now';
  if (min < 60) return `${min}m`;
  const hr = Math.floor(min / 60);
  if (hr < 24) {
    const rem = min % 60;
    return rem ? `${hr}h ${rem}m` : `${hr}h`;
  }
  const d = Math.floor(hr / 24);
  const remH = hr % 24;
  return remH ? `${d}d ${remH}h` : `${d}d`;
}

/**
 * The compact live call-performance line.
 *
 *   🔥 Foxy @ $2.04M [+144.6%] (3h 8m)
 *   📉 Foxy @ $2.04M [-25%] (4h)
 *      Foxy @ $2.04M [0%] (4h)
 *
 * WHY THIS REPLACES "First Call" ON REPEAT SCANS: "First Call" is a statement about
 * RECORDING — it is true once, on the card that first attributed the call. Printing it
 * on every later scan and every Refresh turns a one-time event into a permanent label
 * and hides the number a reader actually wants: how the call is doing.
 *
 * CURRENT RETURN, NOT PEAK. The figure is
 *   (currentMarketCap / entryMarketCap - 1) * 100
 * Peak ROI is a different question ("how high did it go") and is answered elsewhere.
 * Mixing them would make a token that pumped and retraced look like a live winner.
 *
 * The return is OMITTED rather than shown as 0% when the current market cap is
 * unverified — a fabricated 0% reads as "flat" when the truth is "unknown".
 */
export function renderCallPerformanceLine(call, e = (x) => x, {
  botUsername = '', callerToken = null, currentMarketCapUsd = null, now = Date.now(),
} = {}) {
  const name = clipText(callerLabel(call), 24);
  const nameHtml = (callerToken && botUsername)
    ? `<a href="https://t.me/${encodeURIComponent(botUsername)}?start=${encodeURIComponent(callerToken)}">${esc(name)}</a>`
    : `<b>${esc(name)}</b>`;

  const entry = Number(call?.entryMarketCapUsd);
  const entryHtml = Number.isFinite(entry) && entry > 0 ? ` @ <b>${esc(fmtUsd(entry))}</b>` : '';

  const age = elapsedLabel(call?.calledAt, now);
  const ageHtml = age ? ` (${esc(age)})` : '';

  const current = Number(currentMarketCapUsd);

  // Entry unverified → we cannot make a return claim at all.
  if (!Number.isFinite(entry) || entry <= 0) {
    return `${e('🔥')} ${nameHtml}${entryHtml}${ageHtml}`;
  }
  // Current unverified → state that, never invent 0%.
  if (!Number.isFinite(current) || current <= 0) {
    return `${e('🔥')} ${nameHtml}${entryHtml} [<i>return unavailable</i>]${ageHtml}`;
  }

  const pct = (current / entry - 1) * 100;
  // Sign and magnitude. 0% is legitimate only when it is actually flat.
  // One decimal up to 1000%, because "144.6%" is more informative than "145%" and the
  // owner's reference format keeps the decimal. Beyond 1000% the decimal is noise.
  const abs = Math.abs(pct);
  const shown = abs < 0.05
    ? '0%'
    : `${pct > 0 ? '+' : '-'}${abs >= 1000 ? abs.toFixed(0) : abs.toFixed(1)}%`;

  const icon = pct > 0.05 ? e('🔥') : pct < -0.05 ? e('📉') : '';
  const prefix = icon ? `${icon} ` : '';
  return `${prefix}${nameHtml}${entryHtml} [<b>${esc(shown)}</b>]${ageHtml}`;
}

function clipText(v, n) {
  const chars = [...String(v ?? '')];
  return chars.length <= n ? chars.join('') : `${chars.slice(0, n - 1).join('')}…`;
}

export function formatCard(result, {
  mockLabel   = false,
  websiteBase = '',
  premiumUrl  = '',
  addBotUrl   = '',
  botUsername = '',
  emojiTheme  = noTheme,
  firstCall   = null,
  callerToken = null,
  /**
   * True only on the card that FIRST records the call. On every later scan and on
   * Refresh this is false, so the line becomes live performance instead of repeating
   * a one-time "First Call" label.
   */
  isFirstCallCard = false,
  /** Verified current market cap, used for the live return. null = unverified. */
  currentMarketCapUsd = null,
  /** Timestamp of this observation, for the elapsed label and freshness. */
  observedAt = null,
  research    = null,
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
  // VARIANT A (owner-selected final baseline) always shows the NARRATIVE section.
  // An absent narrative is ONE line of honest copy, not an empty heading, so it
  // does not reserve excessive space — and the section's presence is part of the
  // approved structure, so it is not conditionally dropped.
  lines.push('');
  lines.push(sectionTitle(e('🧠'), 'NARRATIVE'));
  lines.push('');
  lines.push(...buildNarrative(result, e, mode));

  // ===== X / KOL INTELLIGENCE (optional) ==================================
  // Only rendered when research actually produced something. Absent research
  // prints NOTHING here — not a zero, not "0 posts" — because an empty count
  // would assert that we looked and found nothing.
  //
  // PHASE 4 STRATEGY + 4A/C: deep X/KOL research is a premium WEBSITE feature.
  //
  // The card no longer prints technical status text like "No X research cached for
  // this token yet". That reads as a system error on a product card. It now shows a
  // clean LOCKED TEASER instead: a visual lock placeholder plus an invitation.
  //
  // The dots are a placeholder for the locked section, NOT hidden results. No count,
  // name, call or return is implied. When a verified premium destination exists it
  // becomes a link; otherwise the invitation is plain text, never a dead button.
  //
  // OWNER staging keeps the detailed lines so research can be verified while testing.
  if (research?.premiumTeaser) {
    lines.push('');
    lines.push(sectionTitle(e('🔒'), 'X & KOL INTELLIGENCE'));
    lines.push('');
    lines.push('KOL Activity: •••••• (Locked)');
    lines.push('');
    if (research.premiumUrl) {
      lines.push(`<a href="${esc(research.premiumUrl)}">Unlock full X & KOL insights on Meme Checker Premium.</a>`);
    } else {
      lines.push('Unlock full X & KOL insights on Meme Checker Premium.');
    }
  } else {
    const previewLines = Array.isArray(research?.previewLines) ? research.previewLines : null;
    const detailLines = [research?.xLine, research?.kolLine].filter(Boolean);
    if (previewLines?.length || detailLines.length) {
      lines.push('');
      lines.push(sectionTitle(e('𝕏'), 'X INTELLIGENCE'));
      lines.push('');
      if (previewLines?.length) lines.push(...previewLines);
      else lines.push(...detailLines.map(esc));
    }
  }

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

  // ===== First Call attribution (Phase 2) =================================
  // Rendered INSIDE the same card, just above the footer — never a separate
  // message. Only present in group mode when a call exists for this token.
  if (firstCall) {
    lines.push('');
    if (isFirstCallCard) {
      // The one card that establishes attribution keeps the label.
      lines.push(renderFirstCallLine(firstCall, e, { botUsername, callerToken }));
    } else {
      // Every later card shows how the call is doing right now.
      const mcap = currentMarketCapUsd ?? result?.market?.marketCapUsd ?? null;
      lines.push(renderCallPerformanceLine(firstCall, e, {
        botUsername, callerToken, currentMarketCapUsd: mcap, now: observedAt ?? Date.now(),
      }));
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
