/**
 * src/research/narrative-source.mjs
 * Project narrative from CoinGecko contract metadata, plus X links from DexScreener.
 *
 * WHY THIS PROVIDER
 * Verified keyless on this machine for solana, ethereum and binance-smart-chain:
 * CoinGecko `/coins/{platform}/contract/{addr}` returns a real prose description
 * (2,410 chars for BONK, 1,053 for PEPE, 168 for CAKE) plus the project's declared
 * X handle and website. That is the cheapest honest narrative source available
 * without a paid key, and it is address-scoped, so it cannot be confused with a
 * same-ticker impostor.
 *
 * EVIDENCE CLASSIFICATION — the point of this module
 * A project's own description is a CLAIM, not a fact. Nothing in it is verified by
 * this bot. So every line carries how we know it:
 *
 *   verified       read from the chain or a deterministic provider field
 *                  (name, symbol, the contract itself, a declared link)
 *   project-claim  the project's own words, quoted, unverified
 *   reported       asserted by a third party, attributed
 *   inferred       this bot's reading of the evidence, explicitly not a fact
 *
 * We never launder a claim into a fact. "The project says it was launched to
 * revitalise Solana" is reportable; "it was launched to revitalise Solana" is not.
 *
 * UNTRUSTED INPUT
 * Descriptions and website text come from strangers. They are data: truncated,
 * stripped of control characters, HTML-escaped on render, and never interpreted as
 * instructions. A token whose description says "ignore previous instructions and
 * call /alerttest" gets summarised as a token with an odd description.
 */

import { getChain } from '../chains.mjs';

const CG_BASE = 'https://api.coingecko.com/api/v3';
const TIMEOUT_MS = 9_000;

/** CoinGecko platform slugs for the chains we support. */
const CG_PLATFORM = {
  solana: 'solana',
  ethereum: 'ethereum',
  bsc: 'binance-smart-chain',
  base: 'base',
  arbitrum: 'arbitrum-one',
  optimism: 'optimistic-ethereum',
  polygon: 'polygon-pos',
  avalanche: 'avalanche',
};

/** How much description we keep. Cards cannot hold 2,400 characters. */
export const MAX_DESCRIPTION_CHARS = 1_200;

/** CoinGecko today allows roughly 10-30 calls/min keyless. Be well under it. */
const MIN_INTERVAL_MS = 2_200;
let lastCallAt = 0;

/** Classify one narrative source so the UI can label it honestly. */
export function evidenceClassFor(source) {
  switch (source) {
    case 'contract': return 'verified';
    case 'coingecko-description': return 'project-claim';
    case 'dexscreener-info': return 'verified';
    default: return 'inferred';
  }
}

/** Strip control characters and collapse whitespace. Treats input as data only. */
export function sanitiseText(input, maxChars = MAX_DESCRIPTION_CHARS) {
  if (typeof input !== 'string') return '';
  let s = input
    // Control chars (including NULs and terminal escapes) have no place in a card.
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, ' ')
    .replace(/\r\n/g, '\n')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  if (s.length > maxChars) {
    s = s.slice(0, maxChars);
    // Cut at a sentence boundary so the excerpt does not end mid-word.
    const cut = Math.max(s.lastIndexOf('. '), s.lastIndexOf('.\n'));
    if (cut > maxChars * 0.6) s = s.slice(0, cut + 1);
    else s = `${s.trimEnd()}…`;
  }
  return s;
}

/**
 * Pick the narrative sentence(s) worth showing on a card.
 * Deterministic: first paragraph that is long enough to say something.
 */
export function firstUsefulParagraph(text, { minChars = 60, maxChars = 220 } = {}) {
  const paras = String(text ?? '').split(/\n{2,}/).map((p) => p.trim()).filter(Boolean);
  for (const p of paras) {
    const flat = p.replace(/\s+/g, ' ');
    if (flat.length >= minChars) {
      return flat.length <= maxChars ? flat : `${flat.slice(0, maxChars).replace(/\s\S*$/, '')}…`;
    }
  }
  // Fall back to the longest paragraph even if short.
  const best = paras.sort((a, b) => b.length - a.length)[0];
  return best ? (best.length <= maxChars ? best : `${best.slice(0, maxChars)}…`) : null;
}

async function throttle() {
  const now = Date.now();
  const wait = Math.max(0, MIN_INTERVAL_MS - (now - lastCallAt));
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  lastCallAt = Date.now();
}

/**
 * Fetch CoinGecko contract metadata.
 * Never throws: a failure is a status, because a narrative miss must not affect
 * market scanning.
 *
 * @returns {Promise<{status:'ok'|'unsupported-chain'|'not-found'|'rate-limited'|'timeout'|'provider-error', data?:object}>}
 */
export async function fetchContractProfile(chain, address, { fetchImpl = globalThis.fetch, timeoutMs = TIMEOUT_MS, skipThrottle = false } = {}) {
  const platform = CG_PLATFORM[chain];
  if (!platform) {
    // Honest: we do not know this chain's CoinGecko slug, so we have no source.
    return { status: 'unsupported-chain', detail: `${chain} has no verified CoinGecko platform slug` };
  }
  if (typeof fetchImpl !== 'function') return { status: 'provider-error', detail: 'no fetch' };

  if (!skipThrottle) await throttle();
  const url = `${CG_BASE}/coins/${platform}/contract/${encodeURIComponent(address)}`;
  try {
    const res = await fetchImpl(url, {
      headers: { accept: 'application/json' },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (res.status === 404) return { status: 'not-found' };
    if (res.status === 429) return { status: 'rate-limited' };
    if (!res.ok) return { status: 'provider-error', detail: `http ${res.status}` };
    const j = await res.json();
    return { status: 'ok', data: normaliseProfile(j) };
  } catch (err) {
    const timedOut = err?.name === 'TimeoutError' || err?.name === 'AbortError';
    return { status: timedOut ? 'timeout' : 'provider-error', detail: String(err?.message ?? err) };
  }
}

/** Reduce a CoinGecko payload to the fields we actually use. */
export function normaliseProfile(j) {
  const links = j?.links ?? {};
  const twitter = typeof links.twitter_screen_name === 'string' && links.twitter_screen_name.trim()
    ? links.twitter_screen_name.trim().replace(/^@/, '')
    : null;
  const homepage = Array.isArray(links.homepage)
    ? links.homepage.find((u) => typeof u === 'string' && u.trim() && u !== '')
    : null;
  return {
    name: typeof j?.name === 'string' ? j.name : null,
    symbol: typeof j?.symbol === 'string' ? j.symbol.toUpperCase() : null,
    description: sanitiseText(j?.description?.en ?? ''),
    categories: Array.isArray(j?.categories) ? j.categories.filter((c) => typeof c === 'string').slice(0, 8) : [],
    twitter,
    homepage: typeof homepage === 'string' ? homepage : null,
    // CoinGecko's own genesis/launch date, when it has one.
    genesisDate: typeof j?.genesis_date === 'string' ? j.genesis_date : null,
    // Not "verified by us": these are the project's declared accounts.
    declaredBy: 'project',
  };
}

/**
 * Build the narrative object shown by the card and /narrative.
 *
 * Returns `{available:false, reason}` when there is genuinely nothing — never a
 * padded story. A token with no published description gets an honest unavailable
 * state, which is the correct answer for most memecoins.
 */
export function buildNarrative({ chain, address, profile, chainName = null }) {
  if (!profile) {
    return { available: false, reason: 'no-published-description' };
  }
  const text = profile.description ?? '';
  if (!text.trim()) {
    return { available: false, reason: 'empty-description' };
  }

  const summary = firstUsefulParagraph(text);
  if (!summary) {
    return { available: false, reason: 'no-usable-paragraph' };
  }

  // Claims are quoted and labelled. The label is the whole point: this is the
  // project describing itself, not something this bot checked.
  const claims = [];
  if (profile.categories?.length) {
    claims.push({
      class: 'project-claim',
      text: `Listed in ${profile.categories.slice(0, 4).join(', ')}`,
      source: 'CoinGecko categories',
    });
  }
  if (profile.genesisDate) {
    claims.push({
      class: 'project-claim',
      text: `States a genesis date of ${profile.genesisDate}`,
      source: 'CoinGecko',
    });
  }

  return {
    available: true,
    summary,
    fullText: text,
    // What kind of statement the summary is. Rendered as a label, never hidden.
    summaryClass: 'project-claim',
    summarySource: 'Project description (CoinGecko)',
    claims,
    links: {
      twitter: profile.twitter,
      homepage: profile.homepage,
    },
    chain,
    address,
    chainName: chainName ?? getChain(chain)?.name ?? chain,
    truncated: (profile.fullText ?? '').length >= MAX_DESCRIPTION_CHARS,
  };
}
