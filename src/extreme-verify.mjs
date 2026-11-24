/**
 * src/extreme-verify.mjs
 * Independent confirmation for an extreme market observation.
 *
 * WHY THIS EXISTS
 * A memecoin can legitimately do 50x, 100x, 1000x. Rejecting those makes the
 * tracker wrong about its best calls. Accepting them blindly makes it publish
 * fiction whenever a provider mis-reports a wrong pair or a post-migration unit.
 * The only honest middle is: hold the value, then VERIFY it independently.
 *
 * WHAT COUNTS AS CORROBORATION
 * A second source is asked about the same (chain, contract). It confirms only if:
 *   - it resolves the SAME contract (identity first)
 *   - its market cap is within `tolerance` of the observed value (default 2x)
 *   - its liquidity is not near-zero (a "market cap" on a dead pool is noise)
 *
 * Sources are tried in order and the first decisive answer wins. A source that
 * errors, times out, or does not know the token is NOT a refutation — it simply
 * contributes nothing, so availability never masquerades as disagreement.
 */

import { isAcceptableUrl } from './format-card.mjs';
import { getChain } from './chains.mjs';

const GEcko_BASE = 'https://api.geckoterminal.com/api/v2/networks';

/** GeckoTerminal network slugs for the chains where we can corroborate. */
const GT_SLUG = {
  solana: 'solana', ethereum: 'eth', bsc: 'bsc', base: 'base', arbitrum: 'arbitrum',
  optimism: 'optimism-ethereum', polygon: 'polygon_pos', avalanche: 'avax',
};

/** Below this liquidity a reported market cap is not meaningful corroboration. */
const MIN_LIQUIDITY_USD = 1_000;

function num(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/**
 * Ask GeckoTerminal about a token.
 * Returns { ok, marketCapUsd, liquidityUsd, name, symbol, detail }.
 * Distinguishes "no record" from "request failed".
 */
export async function geckoTerminalToken(chain, address, { fetchImpl = globalThis.fetch, timeoutMs = 7000 } = {}) {
  const slug = GT_SLUG[chain];
  if (!slug) return { ok: false, detail: `no corroboration source for ${chain}` };
  const url = `${GEcko_BASE}/${slug}/tokens/${encodeURIComponent(address)}`;
  try {
    const res = await fetchImpl(url, {
      headers: { accept: 'application/json' },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (res.status === 404) return { ok: false, detail: 'not indexed by corroboration source' };
    if (!res.ok) return { ok: false, detail: `http ${res.status}` };
    const body = await res.json();
    const a = body?.data?.attributes;
    if (!a) return { ok: false, detail: 'unexpected payload' };

    // Identity check: the payload must be about the address we asked for.
    const returned = String(a.address ?? '');
    const same = chain === 'solana' ? returned === address : returned.toLowerCase() === address.toLowerCase();
    if (!same) return { ok: false, detail: 'identity mismatch in corroboration payload' };

    return {
      ok: true,
      marketCapUsd: num(a.market_cap_usd) ?? num(a.fdv_usd),
      liquidityUsd: num(a.total_reserve_in_usd),
      name: a.name ?? null,
      symbol: a.symbol ?? null,
      detail: null,
    };
  } catch (err) {
    const timedOut = err?.name === 'TimeoutError' || err?.name === 'AbortError';
    return { ok: false, detail: timedOut ? 'timeout' : `transport: ${err?.message ?? err}` };
  }
}

/**
 * Verify an extreme observation.
 *
 * @returns {{
 *   confirm: boolean, source: string|null, reason: string,
 *   observedMarketCapUsd: number, corroboratedMarketCapUsd?: number
 * }}
 */
export async function verifyExtremeObservation(
  { chain, address, observedMcap },
  { fetchImpl = globalThis.fetch, tolerance = 2, sources = null } = {},
) {
  const base = { observedMarketCapUsd: observedMcap, confirm: false, source: null };
  if (!Number.isFinite(observedMcap) || observedMcap <= 0) {
    return { ...base, reason: 'observed market cap is not usable' };
  }
  const def = getChain(chain);
  if (!def) return { ...base, reason: `unknown chain ${chain}` };

  const providers = sources ?? [
    { name: 'geckoterminal', fn: (c, a, o) => geckoTerminalToken(c, a, o) },
  ];

  const notes = [];
  for (const p of providers) {
    const r = await p.fn(chain, address, { fetchImpl });
    if (!r?.ok) { notes.push(`${p.name}: ${r?.detail ?? 'unavailable'}`); continue; }

    if (!Number.isFinite(r.marketCapUsd) || r.marketCapUsd <= 0) {
      notes.push(`${p.name}: no market cap`); continue;
    }
    if (Number.isFinite(r.liquidityUsd) && r.liquidityUsd < MIN_LIQUIDITY_USD) {
      // A market cap on a thin pool is not evidence of a real valuation.
      notes.push(`${p.name}: liquidity ${r.liquidityUsd} too thin to corroborate`); continue;
    }
    const ratio = r.marketCapUsd / observedMcap;
    if (ratio >= 1 / tolerance && ratio <= tolerance) {
      return {
        ...base,
        confirm: true,
        source: p.name,
        corroboratedMarketCapUsd: r.marketCapUsd,
        reason: `${p.name} agrees within ${tolerance}x (${Math.round(ratio * 100) / 100}x of observed)`,
      };
    }
    notes.push(`${p.name}: disagrees (${Math.round(ratio * 100) / 100}x of observed)`);
  }

  return { ...base, reason: notes.join('; ') || 'no corroboration source answered' };
}

export { MIN_LIQUIDITY_USD, GT_SLUG };
