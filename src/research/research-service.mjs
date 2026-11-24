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
import {
  searchTokenPosts, summariseKols, xDiscoveryStatus, coverageNote,
} from './x-source.mjs';
import { researchCache, cacheKey, TTL_MS, xBudget } from './research-cache.mjs';

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
} = {}) {
  const out = {
    narrative: { available: false, reason: 'not-attempted' },
    x: { available: false, status: xDiscoveryStatus() },
    requests: 0,
    fromCache: false,
  };
  if (!chain || !address) return out;

  // ---- narrative (keyless) ------------------------------------------------
  const profKey = cacheKey('cg-profile', chain, address);
  const before = cache.stats();
  const prof = await cache.cached(profKey, TTL_MS.description, () => fetchContractProfile(chain, address, { fetchImpl }));
  out.fromCache = cache.stats().misses === before.misses;

  if (prof?.status === 'ok') {
    out.narrative = buildNarrative({
      chain, address, profile: prof.data, chainName: getChain(chain)?.name,
    });
    out.requests += out.fromCache ? 0 : 1;
  } else {
    out.narrative = {
      available: false,
      reason: prof?.status ?? 'provider-error',
      detail: prof?.detail ?? null,
    };
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
  if (!cache.has(postsKey) && !cache.inflight.has(postsKey) && !budget.spend(1)) {
    out.x = {
      available: false,
      status: { available: false, reason: 'budget-exhausted', detail: 'The X request allowance for this window is used up.' },
      posts: [],
    };
    return out;
  }

  const postsRes = await cache.cached(
    postsKey,
    TTL_MS.posts,
    () => searchTokenPosts({ chain, address, symbol, fetchImpl }),
  );

  const posts = postsRes?.posts ?? [];
  const projectHandle = out.narrative?.links?.twitter ?? null;
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
