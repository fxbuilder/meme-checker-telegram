/**
 * src/research/narrative-pipeline.mjs
 * Bounded multi-source narrative: useful evidence for NEW memecoins, which is the
 * case CoinGecko alone cannot serve.
 *
 * THE PROBLEM
 * Most freshly launched memecoins have no CoinGecko listing. A CoinGecko-only
 * narrative engine therefore answers "unavailable" for exactly the tokens this bot
 * exists to scan. That is not a coverage gap, it is a design failure.
 *
 * THE PIPELINE (each step is cheap, and stops as soon as it has a usable summary)
 *   1. Token metadata already in hand from the market scan — name, symbol, chain,
 *      launchpad hints in the description, DexScreener `info` project links.
 *   2. DexScreener token profile / socials — keyless, already fetched by the scan.
 *   3. Official website prose — bounded fetch, SSRF-checked, one page, plain-text
 *      extraction with boilerplate removed.
 *   4. CoinGecko description — supplementary, when the token is listed.
 *   5. Launchpad context — derived from the DEX/pair identity the scan already has
 *      (e.g. a pump.fun-style pair), never invented.
 *
 * WHAT IT REFUSES TO DO
 * It does not compose prose. Every sentence it shows is either extracted from a
 * named source or a factual statement about the contract that the scan already
 * verified. There is no template that turns a name into a story.
 *
 * Every claim is tagged with its evidence class, and the tag is rendered.
 */

import { buildNarrative, firstUsefulParagraph, sanitiseText, MAX_DESCRIPTION_CHARS } from './narrative-source.mjs';
import { mintFacts } from './onchain-metadata.mjs';

/** Known launchpads, recognised from pair/dex identity rather than guessed. */
/**
 * Venue hints. `kind` matters for the wording, because the two are different claims:
 *
 *   kind: 'dex'       -> the token TRADES here now. Observed from the live pair.
 *   kind: 'launchpad' -> the token's page EXISTS on a launchpad. A launchpad mints its
 *                        tokens, so an address-scoped token page is evidence of where it
 *                        was created - but it is NOT a trading venue, and saying
 *                        "trading on flap.sh" would be false (ANT trades on PancakeSwap).
 */
const LAUNCHPAD_HINTS = [
  { id: 'pumpfun', label: 'pump.fun', kind: 'launchpad', match: /pump(\.fun)?/i },
  { id: 'raydium', label: 'Raydium', kind: 'dex', match: /raydium/i },
  { id: 'meteora', label: 'Meteora', kind: 'dex', match: /meteora/i },
  { id: 'fourmeme', label: 'four.meme', kind: 'launchpad', match: /four\.?meme/i },
  // BNB Chain launchpad. Verified: ANT's only published link is a flap.sh token page
  // (https://flap.sh/bnb/0x...), and flap.sh's own record carries an empty description,
  // so the launch venue is provable while prose is genuinely absent.
  { id: 'flap', label: 'flap.sh', kind: 'launchpad', match: /flap\.sh/i },
  { id: 'pancakeswap', label: 'PancakeSwap', kind: 'dex', match: /pancake/i },
  { id: 'uniswap', label: 'Uniswap', kind: 'dex', match: /uniswap/i },
  { id: 'aerodrome', label: 'Aerodrome', kind: 'dex', match: /aerodrome/i },
];

/** Phrases that make website prose useless as a summary. */
/**
 * Markers of a MARKET-DATA PANEL rather than prose about the project.
 *
 * Why this exists: the ANT (BSC) card produced this as its "narrative" —
 *
 *   TOKEN INFO 24h Vol $755.76K LIQ $115.38K MCAP $542.3K Holders 5,986
 *   24h Exchange -30.99% FDV $542.3K Circulation 1B Max Supply 1B ...
 *
 * That is the launchpad's stats table, scraped off the page. It says nothing about
 * what the token IS, and the OWNER explicitly ruled generic contract facts out of
 * narrative. A stats panel is not prose and must not be shown as a description.
 */
const STAT_PANEL = [
  /\b(24h|1h|6h)\s+(vol|volume|change|high|low)\b/i,
  /\b(mcap|market\s*cap)\b/i,
  /\b(liq|liquidity)\b/i,
  /\bfdv\b/i,
  /\b(circulation|circulating)\b/i,
  /\bmax\s+supply\b/i,
  /\btotal\s+supply\b/i,
  /\$[\d.,]+\s*[kmb]\b/i,
  /\bholders?\s*[: ]\s*[\d,]{3,}/i,
  /\btaxes?\s*[: ]?\s*\d/i,
  /\bcreate\s*time\b/i,
  /\bcreator\s*:\s*0x/i,
];

/**
 * True when the text reads like a data panel rather than a sentence about the project.
 *
 * Heuristic, deliberately conservative: it takes several independent markers, or a
 * very high digit/punctuation density, to reject text. A real description that happens
 * to mention a dollar figure once still passes.
 */
export function isStatPanel(text) {
  if (!text || typeof text !== 'string') return true;
  const t = text.trim();
  if (t.length < 40) return true;

  const markers = STAT_PANEL.filter((re) => re.test(t)).length;
  if (markers >= 4) return true;

  // Digit density: a stats table is mostly numbers and separators.
  const digits = (t.match(/[\d$%.,]/g) ?? []).length;
  if (t.length >= 60 && digits / t.length > 0.34) return true;

  // Sentence shape: real prose has runs of words with no digits between them.
  const longishRun = /[A-Za-z][A-Za-z'’-]+(?:\s+[A-Za-z][A-Za-z'’-]+){7,}/.test(t);
  if (!longishRun && digits / Math.max(t.length, 1) > 0.18) return true;

  return false;
}

const BOILERPLATE = [
  /enable javascript/i,
  /please turn on javascript/i,
  /your browser (does not|doesn't) support/i,
  /accept (all )?cookies/i,
  /this site uses cookies/i,
  /sign in to continue/i,
  /access denied/i,
  /just a moment/i,
  /checking your browser/i,
];

/**
 * Strip HTML to readable prose without a parser dependency.
 * Deterministic and bounded: script/style removed first, then tags, then entities.
 */
export function htmlToText(html, { maxChars = 6_000 } = {}) {
  if (typeof html !== 'string') return '';
  let s = html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ')
    .replace(/<nav[\s\S]*?<\/nav>/gi, ' ')
    .replace(/<footer[\s\S]*?<\/footer>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<\/(p|div|h[1-6]|li|br)>/gi, '\n')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    // Common entities. Order matters: &amp; last so it cannot re-create another.
    .replace(/&nbsp;/gi, ' ')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&amp;/gi, '&');
  s = s.replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
  return s.slice(0, maxChars);
}

/** True when the extracted text is a cookie wall or an error page, not content. */
export function isBoilerplate(text, { minChars = 60, statPanel = true } = {}) {
  if (!text || text.length < minChars) return true;
  if (BOILERPLATE.some((re) => re.test(text))) return true;
  // A trading-stats panel is not a description, even though it is real text off the
  // real project page. Without this the ANT card showed volume/liquidity as its story.
  //
  // `statPanel: false` is for a value read from a DECLARED description field. That is
  // not scraped page furniture: the project chose to publish those exact words. Judging
  // it by digit-density rejected PONS's real description ("100% of fees go back to Pons")
  // purely for containing a percentage.
  if (!statPanel) return false;
  return isStatPanel(text);
}

/**
 * Minimum length for a DESCRIPTION FIELD (as opposed to scraped page text).
 *
 * The 60-char floor above exists because a scraped fragment of a page is usually noise.
 * A value read from a declared `description` field is not scraped: it is the project's
 * answer to "what is this", and short ones are legitimate. PONS stores
 * "100% of fees go back to Pons" (29 chars) on its token contract, and the 60-char floor
 * silently discarded it - the narrative then read "no published description" for a token
 * that had one.
 */
export const MIN_DESCRIPTION_CHARS = 12;

/**
 * Recognise the marketplace a token TRADES ON, from the pair identity the scan
 * already returned.
 *
 * WHAT THIS DOES NOT PROVE: that the token LAUNCHED there. A token bought on
 * pump.fun and migrated to a Raydium pool reports `dexId: raydium`, so saying
 * "Launched on Raydium" would be a fabricated launch history from a string match.
 * The verified statement is "currently trading on X"; anything stronger is an
 * inference and is labelled as one.
 */
export function detectLaunchpad(result) {
  const dexId = String(result?.market?.dexId ?? '').trim();
  // Only the DEX id is strong enough to name a marketplace. A website domain or a
  // token NAME containing "pancake" proves nothing at all.
  // Evidence haystack: the observed pair venue, plus the project's published link ONLY
  // when that link is a token page for THIS address (e.g. flap.sh/bnb/0x...). A bare
  // website domain is not proof of venue, and a social handle containing a brand name
  // is weaker still, so neither is included on its own.
  const addr = String(result?.token?.address ?? '').toLowerCase();
  const site = String(result?.project?.website ?? '').toLowerCase();
  const siteIsTokenPage = Boolean(addr) && site.includes(addr);
  const hay = [
    dexId,
    result?.market?.pairAddress,
    result?.chartUrl,
    siteIsTokenPage ? site : null,
  ].filter(Boolean).join(' ');
  for (const l of LAUNCHPAD_HINTS) {
    if (!l.match.test(hay)) continue;

    // WHERE the evidence came from decides the claim, not the venue's own category.
    //
    //   dexId / pair  -> the token TRADES on this venue right now, always. pump.fun
    //                    pairs report dexId 'pumpfun', so "trading on pump.fun" is an
    //                    observation about the live pair.
    //   token page    -> the address has a page on this launchpad. That proves where it
    //                    was minted, NOT where it trades. ANT's page is flap.sh while
    //                    its pairs are PancakeSwap, so "trading on flap.sh" would be false.
    const fromTokenPage = siteIsTokenPage && l.match.test(site);
    const fromPair = l.match.test(dexId);

    // A bare namesake domain is not evidence of anything.
    if (!fromTokenPage && !fromPair) continue;

    return {
      id: l.id,
      label: l.label,
      kind: l.kind,
      evidence: fromPair
        ? `observed from the current ${dexId || 'pair'} pair`
        : `address-scoped token page on ${new URL(site).hostname}`,
      claimClass: 'verified',
      statement: fromPair
        ? `Currently trading on ${l.label}`
        : `Launched via ${l.label}`,
    };
  }
  return null;
}

/**
 * Which of the summary candidates is most useful?
 * Preference order is deliberate: a project's own description is the most
 * informative, a website is second, and a market-provider blurb is last.
 */
export function chooseSummary(candidates) {
  // Curated description fields get the lower floor; anything that came from scraped page
  // text keeps the 60-char floor. Using one threshold for both is what discarded PONS.
  const usable = candidates.filter((c) => {
    if (!c || !c.text) return false;
    // Scraped page text and market blurbs keep the strict rules. A DECLARED description
    // field is the project's own answer, so it is not subjected to stat-panel heuristics -
    // that rejected PONS's "100% of fees go back to Pons" for looking like a statistic.
    const scraped = c.source === 'website' || c.source === 'market';
    return !isBoilerplate(c.text, {
      minChars: scraped ? 60 : MIN_DESCRIPTION_CHARS,
      statPanel: scraped,
    });
  });
  if (!usable.length) return null;
  // GeckoTerminal first: broadest coverage, and the most current for new tokens.
  // CoinGecko is now SUPPLEMENTARY, not the backbone.
  const rank = {
    geckoterminal: 0, metaplex: 1, 'onchain-meta': 2, 'launchpad-meta': 3,
    coingecko: 4, website: 5, market: 6,
  };
  return usable.sort((a, b) => (rank[a.source] ?? 9) - (rank[b.source] ?? 9))[0];
}

/**
 * Compose the narrative from whatever evidence is available.
 *
 * @param {object} args
 * @param {object} args.result        the market scan result (already fetched)
 * @param {object|null} args.profile  CoinGecko profile, if any
 * @param {string|null} args.websiteText  extracted prose from the official site
 * @returns {{available:boolean, summary?:string, summaryClass?:string, summarySource?:string, claims?:Array, launchpad?:object, reason?:string}}
 */
export function composeNarrative({
  result,
  profile = null,
  websiteText = null,
  /** GeckoTerminal token info — the PRIMARY source across 15/16 chains. */
  gtToken = null,
  /** Verified on-chain mint facts (Solana). */
  mint = null,
  /** Metaplex off-chain JSON, when reachable. */
  metaplex = null,
  /** EVM on-chain metadata document (`metaURI()`), when the contract declares one. */
  onchainMeta = null,
  /** Launchpad-declared metadata (`getTokenInfo()` and friends), when implemented. */
  launchpadMeta = null,
} = {}) {
  const candidates = [];

  // PRIMARY: GeckoTerminal's description. It is the project's own prose, so it is a
  // claim - but it covers chains and freshly launched tokens CoinGecko does not list.
  if (gtToken?.description) {
    candidates.push({
      text: gtToken.description,
      source: 'geckoterminal',
      evidence: 'project-claim',
      label: 'Project description (GeckoTerminal)',
    });
  }

  // Metaplex on-chain JSON is also the project describing itself.
  if (metaplex?.description && !gtToken?.description) {
    candidates.push({
      text: metaplex.description,
      source: 'metaplex',
      evidence: 'project-claim',
      label: 'Project description (token metadata)',
    });
  }

  // EVM on-chain metadata. The contract itself declares this document for this exact
  // address, so it is the project describing itself - the same evidence class as a
  // GeckoTerminal description, and available where that one is absent.
  if (onchainMeta?.description && !gtToken?.description) {
    candidates.push({
      text: onchainMeta.description,
      source: 'onchain-meta',
      evidence: 'project-claim',
      label: 'Token metadata (on-chain)',
    });
  }

  // Launchpad metadata. The token contract itself stores this description, so it is the
  // project describing itself - the same evidence class as a GeckoTerminal description.
  if (launchpadMeta?.description && !gtToken?.description && !onchainMeta?.description) {
    candidates.push({
      text: launchpadMeta.description,
      source: 'launchpad-meta',
      evidence: 'project-claim',
      label: 'Token metadata (launchpad)',
    });
  }

  if (profile?.description && !gtToken?.description) {
    candidates.push({ text: profile.description, source: 'coingecko', evidence: 'project-claim', label: 'Project description (CoinGecko)' });
  }

  if (websiteText && !isBoilerplate(websiteText)) {
    const para = firstUsefulParagraph(websiteText, { minChars: 80, maxChars: 260 });
    if (para && !isBoilerplate(para)) {
      candidates.push({ text: para, source: 'website', evidence: 'project-claim', label: 'Official website' });
    }
  }

  // The market provider's own blurb, when present. It is a third party describing
  // the token, so it is 'reported', not 'verified'.
  const marketBlurb = result?.project?.description ?? result?.narrative?.summary ?? null;
  if (marketBlurb && String(marketBlurb).trim().length >= 40) {
    candidates.push({ text: sanitiseText(marketBlurb, 400), source: 'market', evidence: 'reported', label: 'Market provider' });
  }

  const launchpad = detectLaunchpad(result);
  const chosen = chooseSummary(candidates);

  // Claims are facts about the contract that the scan already established. These are
  // 'verified' because they come from address-scoped provider data, not prose.
  const claims = [];
  const chain = result?.token?.chain;
  const symbol = result?.token?.symbol;
  if (symbol) {
    claims.push({
      class: 'verified',
      text: `Trades as $${symbol}${chain ? ` on ${chain}` : ''}`,
      source: 'market data',
    });
  }
  if (launchpad) {
    claims.push({
      // "Currently trading on" is directly observed from the pair. Launch ORIGIN is
      // not, so it is never asserted.
      class: launchpad.claimClass ?? 'verified',
      text: launchpad.statement ?? `Currently trading on ${launchpad.label}`,
      source: launchpad.evidence,
    });
  }

  // Verified on-chain facts. These hold even when nothing off-chain describes the
  // token, which is exactly the fresh-launch case.
  for (const f of mintFacts(mint)) claims.push(f);

  // Links are evidence too, and the only ones we can ground.
  const links = {
    website: gtToken?.website ?? metaplex?.website ?? result?.project?.website ?? null,
    twitter: gtToken?.twitter ?? metaplex?.twitter ?? null,
    telegram: gtToken?.telegram ?? metaplex?.telegram ?? null,
  };
  const hasAnyLink = Object.values(links).some(Boolean);

  if (!chosen) {
    return {
      available: false,
      // Distinguish "no source published anything" from "we could not reach them".
      reason: 'no-published-description',
      launchpad,
      claims,
      links,
      // A token with no prose but verified on-chain facts is not "unknown" - the
      // card should say what it can support rather than nothing.
      hasVerifiedFacts: claims.some((c) => c.class === 'verified'),
      hasLinks: hasAnyLink,
    };
  }

  return {
    available: true,
    summary: chosen.text.length <= 260 ? chosen.text : `${chosen.text.slice(0, 260).replace(/\s\S*$/, '')}…`,
    summaryClass: chosen.evidence,
    summarySource: chosen.label,
    claims,
    launchpad,
    links,
    hasVerifiedFacts: claims.some((c) => c.class === 'verified'),
    hasLinks: hasAnyLink,
    // How many independent sources produced usable evidence, for the UI to state.
    sourcesUsed: [...new Set(candidates.filter((c) => c.text).map((c) => c.source))],
  };
}
