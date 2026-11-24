/**
 * src/research/research-service.mjs
 * One place that answers "what do we know about this token, and how do we know it".
 *
 * Used by both the scan card (compact) and /narrative + /x (detailed), so the two
 * cannot disagree — the failure mode that produced a card saying one thing and a
 * report saying another in the previous project.
 *
 * DEPENDENCY DIRECTION
 * Market scanning must never depend on this. Research is additive: every function
 * here returns a status object and never throws, so a provider outage degrades the
 * card to its previous state rather than breaking a scan.
 */

import { getChain } from '../chains.mjs';
import { fetchContractProfile, buildNarrative } from './narrative-source.mjs';
import { composeNarrative, htmlToText, isBoilerplate } from './narrative-pipeline.mjs';
import { fetchTokenInfo, gtSupportsChain } from './geckoterminal.mjs';
import { readSolanaMint } from './onchain-metadata.mjs';
import { fetchWebsiteText } from './website-fetch.mjs';
import {
  searchTokenPosts, summariseKols, xDiscoveryStatus, coverageNote,
} from './x-source.mjs';
import { researchCache, cacheKey, TTL_MS, xBudget } from './research-cache.mjs';
import * as premiumPreview from './premium-preview.mjs';

/**
 * Everything known about a token's narrative and X presence.
 *
 * @returns {Promise<{
 *   narrative: object,
 *   x: object,
 *   requests: number,
 *   fromCache: boolean,
 * }>}
 */
export async function researchToken({
  chain,
  address,
  symbol = null,
  name = null,
  fetchImpl = globalThis.fetch,
  includePosts = true,
  cache = researchCache,
  budget = xBudget,
  now = Date.now(),
  /**
   * The market scan result, when the caller already has one. Passing it lets the
   * narrative pipeline use evidence that has ALREADY been fetched (project links,
   * provider blurb, pair identity) instead of repeating those requests.
   */
  scanResult = null,
  /** Disable the website fetch (used by cheap card enrichment and by tests). */
  includeWebsite = true,
  /**
   * Card enrichment mode: use X posts ONLY if they are already cached.
   *
   * WHY. A scan card wants the "17 posts / 11 accounts" line, but making a scan pay
   * for an X search is wrong twice over: it costs $0.001 per scan, and the scan has a
   * hard 2.5s timeout while provider pacing needs 5s - so the request would be
   * charged, awaited, abandoned at the timeout, and the money spent for nothing.
   * /x does the real, paced fetch; the card shows what is already known.
   */
  xCacheOnly = false,
} = {}) {
  const out = {
    narrative: { available: false, reason: 'not-attempted' },
    x: { available: false, status: xDiscoveryStatus() },
    requests: 0,
    fromCache: false,
  };
  if (!chain || !address) return out;

  // ---- narrative (keyless) ------------------------------------------------
  // PRIMARY: GeckoTerminal. It covers 15 of our 16 chains and describes newly
  // launched tokens that CoinGecko has not listed, which is the whole point of a
  // memecoin scanner's narrative. CoinGecko is kept as a SUPPLEMENTARY source.
  const gtKey = cacheKey('gt-info', chain, address);
  const gtBefore = cache.stats();
  const gt = gtSupportsChain(chain)
    ? await cache.cached(gtKey, TTL_MS.description, () => fetchTokenInfo(chain, address, { fetchImpl }))
    : { status: 'unsupported-chain' };
  const gtFromCache = cache.stats().misses === gtBefore.misses;
  if (!gtFromCache) out.requests += 1;

  // SUPPLEMENTARY: CoinGecko, only when GeckoTerminal did not already describe it.
  // Skipping it is not just cheaper - it avoids a second paid-adjacent dependency on
  // the critical path for the common case.
  let prof = null;
  let profFromCache = true;
  if (!(gt?.status === 'ok' && gt.token?.description)) {
    const profKey = cacheKey('cg-profile', chain, address);
    const before = cache.stats();
    prof = await cache.cached(profKey, TTL_MS.description, () => fetchContractProfile(chain, address, { fetchImpl }));
    profFromCache = cache.stats().misses === before.misses;
    if (!profFromCache) out.requests += 1;
  } else {
    // Still learn the CoinGecko id when available, without a request.
    prof = { status: 'skipped', detail: 'geckoterminal described this token' };
  }
  out.fromCache = gtFromCache && profFromCache;

  // Verified on-chain facts. Solana only, and only when nothing off-chain described
  // the token - otherwise the mint read is an extra request for no benefit.
  let mint = null;
  if (chain === 'solana' && !(gt?.status === 'ok' && gt.token?.description)) {
    const mKey = cacheKey('sol-mint', chain, address);
    const mBefore = cache.stats();
    const mRes = await cache.cached(mKey, TTL_MS.description, () => readSolanaMint(address, { fetchImpl }));
    if (cache.stats().misses !== mBefore.misses) out.requests += 1;
    if (mRes?.status === 'ok') mint = mRes.mint;
  }

  // A chain with no metadata source at all AND no website to read has no prose
  // source. Say that plainly rather than the generic state: one is a coverage gap,
  // the other is an empty project.
  const hasWebsiteFromScan = Boolean(scanResult?.project?.website);
  const gtMissing = !gtSupportsChain(chain);
  if (gtMissing && prof?.status === 'unsupported-chain' && !hasWebsiteFromScan && !mint) {
    out.narrative = {
      available: false,
      reason: 'unsupported-chain',
      detail: 'No narrative source covers this chain yet.',
      claimable: false,
      coverage: { primary: null, geckoterminal: false },
    };
    return out;
  }

  // ---- website prose (only when the scan did not already supply a description) --
  // A CoinGecko description is the highest-value source, so a successful one skips
  // the website fetch entirely. For a fresh memecoin with no listing, the website is
  // usually the only prose that exists, so it is worth one bounded request.
  let websiteText = null;
  const websiteUrl = gt?.status === 'ok' ? (gt.token?.website ?? null) : null
    ?? scanResult?.project?.website
    ?? (prof?.status === 'ok' ? prof.data?.homepage : null)
    ?? null;

  const needsWebsite = includeWebsite
    && websiteUrl
    && !(prof?.status === 'ok' && (prof.data?.description ?? '').trim().length >= 80);

  if (needsWebsite) {
    const wKey = cacheKey('site-text', chain, websiteUrl);
    const siteRes = await cache.cached(
      wKey,
      TTL_MS.description,
      () => fetchWebsiteText(websiteUrl, { fetchImpl }),
      { ttlOnFailure: TTL_MS.failure },
    );
    if (siteRes?.status === 'ok') {
      const text = htmlToText(siteRes.text);
      if (!isBoilerplate(text)) websiteText = text;
      if (!out.fromCache) out.requests += 1;
    }
  }

  // ---- compose from every source that actually produced something ----------
  const composed = composeNarrative({
    result: scanResult
      ? { token: { chain, address, symbol, name }, ...scanResult }
      : { token: { chain, address, symbol, name } },
    profile: prof?.status === 'ok' ? prof.data : null,
    websiteText,
    gtToken: gt?.status === 'ok' ? gt.token : null,
    mint,
  });

  out.narrative = {
    ...composed,
    chain,
    address,
    chainName: getChain(chain)?.name ?? chain,
    // Provider status is kept separately so the UI can distinguish "no description
    // was published" from "the provider failed".
    providerStatus: gt?.status === 'ok' ? 'ok' : (prof?.status ?? 'provider-error'),
    providerDetail: gt?.detail ?? prof?.detail ?? null,
    // Which providers were consulted, so the UI can be precise about coverage.
    coverage: {
      geckoterminal: gt?.status ?? 'not-consulted',
      coingecko: prof?.status ?? 'not-consulted',
      onchain: mint ? 'ok' : (chain === 'solana' ? 'not-read' : 'unsupported-chain'),
    },
  };

  // Keep the CoinGecko-declared links available for the X section's project handle.
  if (!out.narrative.links && prof?.status === 'ok') {
    out.narrative.links = { twitter: prof.data?.twitter, homepage: prof.data?.homepage };
  }

  // ---- X discovery (credentialed; honestly unavailable without a key) -----
  if (!includePosts) {
    out.x = { available: false, status: xDiscoveryStatus(), skipped: true };
    return out;
  }

  const discovery = xDiscoveryStatus();
  if (!discovery.available) {
    out.x = { available: false, status: discovery, posts: [] };
    return out;
  }

  const postsKey = cacheKey('x-posts', chain, address);

  // Spend budget only when a request will actually happen. Checking the cache
  // first matters: a cached hit was consuming allowance while making no request,
  // so a busy group could burn the daily X budget on data it already had.
  //
  // reserve() both charges the request AND waits for the provider's spacing floor.
  // Charging without pacing is what let two back-to-back searches return 200 then
  // 429 - the 429 was billed and returned nothing.
  const cachedPosts = cache.has(postsKey);

  // Card enrichment never pays for a search it cannot wait for.
  if (xCacheOnly && !cachedPosts) {
    out.x = {
      available: false,
      status: { available: false, reason: 'not-fetched', detail: 'X posts are fetched by /x, not by a scan.' },
      posts: [],
    };
    return out;
  }

  const willRequest = !cachedPosts && !cache.inflight.has(postsKey);
  if (willRequest && !(await budget.reserve())) {
    out.x = {
      available: false,
      status: { available: false, reason: 'budget-exhausted', detail: 'The X request allowance for this window is used up.' },
      posts: [],
    };
    return out;
  }

  // An already-in-flight request for this token must not pay a second time, so its
  // waiter is answered from the shared promise rather than a fresh spend.
  const postsRes = await cache.cached(
    postsKey,
    TTL_MS.posts,
    () => searchTokenPosts({ chain, address, symbol, fetchImpl }),
  );

  const posts = postsRes?.posts ?? [];
  const projectHandle = out.narrative?.links?.twitter
    ?? (prof?.status === 'ok' ? prof.data?.twitter : null)
    ?? null;
  const kols = summariseKols(posts, { projectHandle });
  const uniqueAccounts = new Set(posts.map((p) => p.authorHandle).filter(Boolean)).size;

  out.x = {
    available: postsRes?.status === 'ok',
    status: postsRes?.status === 'ok'
      ? { available: true, reason: 'ok' }
      : { available: false, reason: postsRes?.status ?? 'provider-error' },
    posts,
    kols,
    // Strong evidence (post text carries the exact contract) vs weak (ticker only).
    contractMatches: posts.filter((p) => p.containsContract).length,
    uniqueAccounts,
    coverage: coverageNote({
      posts: posts.length,
      uniqueAccounts,
      requests: postsRes?.requests ?? 0,
      configured: true,
    }),
    projectHandle,
  };
  if (!out.fromCache) out.requests += postsRes?.requests ?? 0;

  return out;
}

/**
 * The one or two lines the token card can afford.
 * Returns null when there is nothing worth saying, so the caller keeps its
 * existing honest unavailable line rather than printing filler.
 */
export function cardNarrativeLines(narrative) {
  if (!narrative?.available || !narrative.summary) return null;
  const s = narrative.summary;
  return s.length <= 220 ? s : `${s.slice(0, 220).replace(/\s\S*$/, '')}…`;
}

/**
 * Build the card's X section.
 *
 * The card shows a PREVIEW by default (post count, account count, identified public
 * callers, up to two accounts, and a short narrative) because deep X/KOL research is
 * now a premium website feature. An entitled caller (the OWNER during staging) gets
 * the fuller line set for testing.
 *
 * This function never fetches. The caller decides whether research was permitted at
 * all, so "no paid X request from an ordinary scan" is enforced by control flow.
 */
export function cardXSection(research, { entitled = false, premiumUrl = null } = {}) {
  const { buildPreview } = premiumPreview;
  const preview = buildPreview(research, { premiumUrl });
  if (entitled) {
    // Staging: the owner still sees the detailed lines the bot used to print.
    return {
      preview,
      lines: [cardXLine(research?.x), cardKolLine(research?.x)].filter(Boolean),
    };
  }
  return { preview, lines: null };
}

/** Compact X line for the card: counts only, never a fabricated claim. */
export function cardXLine(x) {
  if (!x) return null;
  if (!x.status?.available) {
    // Do not print "0 posts": that asserts we looked and found none.
    return null;
  }
  const n = x.posts?.length ?? 0;
  if (!n) return null;
  const accounts = x.uniqueAccounts ?? 0;
  return `${n} relevant post${n === 1 ? '' : 's'} · ${accounts} unique account${accounts === 1 ? '' : 's'}`;
}

/** Compact KOL line: the most active account, with what it actually did. */
export function cardKolLine(x) {
  const top = x?.kols?.[0];
  if (!top) return null;
  const role = top.role === 'public-call' ? 'Public call'
    : top.role === 'announcement' ? 'Project account'
      : top.role === 'repost' ? 'Repost' : 'Mention';
  return `@${top.handle} — ${role}`;
}
