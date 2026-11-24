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
const LAUNCHPAD_HINTS = [
  { id: 'pumpfun', label: 'pump.fun', match: /pump(\.fun)?/i },
  { id: 'raydium', label: 'Raydium', match: /raydium/i },
  { id: 'meteora', label: 'Meteora', match: /meteora/i },
  { id: 'fourmeme', label: 'four.meme', match: /four\.?meme/i },
  { id: 'pancakeswap', label: 'PancakeSwap', match: /pancake/i },
  { id: 'uniswap', label: 'Uniswap', match: /uniswap/i },
  { id: 'aerodrome', label: 'Aerodrome', match: /aerodrome/i },
];

/** Phrases that make website prose useless as a summary. */
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
export function isBoilerplate(text) {
  if (!text || text.length < 60) return true;
  return BOILERPLATE.some((re) => re.test(text));
}

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
  const hay = [dexId, result?.market?.pairAddress, result?.chartUrl].filter(Boolean).join(' ');
  for (const l of LAUNCHPAD_HINTS) {
    if (l.match.test(hay)) {
      return {
        id: l.id,
        label: l.label,
        // Provenance is deliberate: observed venue, not launch origin.
        evidence: `observed from the current ${dexId || 'pair'} pair`,
        claimClass: 'verified',
        statement: `Currently trading on ${l.label}`,
      };
    }
  }
  return null;
}

/**
 * Which of the summary candidates is most useful?
 * Preference order is deliberate: a project's own description is the most
 * informative, a website is second, and a market-provider blurb is last.
 */
export function chooseSummary(candidates) {
  const usable = candidates.filter((c) => c && c.text && !isBoilerplate(c.text));
  if (!usable.length) return null;
  // GeckoTerminal first: broadest coverage, and the most current for new tokens.
  // CoinGecko is now SUPPLEMENTARY, not the backbone.
  const rank = { geckoterminal: 0, metaplex: 1, coingecko: 2, website: 3, market: 4 };
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
