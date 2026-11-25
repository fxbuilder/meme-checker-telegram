/**
 * Elysium holder and narrative intelligence (chain 99901).
 *
 * WHY THIS EXISTS: GoPlus has no Elysium entry and GeckoTerminal returns no holder data for
 * it, which made Elysium render 0% on every risk field. The owner rightly pointed out that
 * two providers having no data does not establish that the chain has no holder source.
 *
 * WHAT ACTUALLY WORKS, established by probing rather than assumption:
 *
 *   - The public RPC (elysium.drpc.org) caps eth_getLogs at **100 blocks**. A full
 *     Transfer-history scan would be ~105,000 requests, so log-derived holder enumeration is
 *     NOT viable here and is not attempted. It also means the free RPC cannot support
 *     incremental Transfer indexing, whatever the budget.
 *   - Elyscan's REST API serves only /api/v2/stats; its token routes return 404.
 *   - Elyscan's TOKEN PAGE, however, is server-rendered and carries real holder data:
 *     holder count, a Top-10 share, and a paginated holder table.
 *
 * So the source is the page's own rendered payload. That is a legitimate documented
 * presentation of the indexer's data, and every figure is read as text the page itself
 * publishes - nothing is inferred. Provenance is recorded as `elyscan-page` so a reader knows
 * this is not a first-party API contract and could change without notice.
 */

const TIMEOUT_MS = 20_000;

export const ELYSCAN = {
  chainId: 99901,
  baseUrl: 'https://elyscan.live',
  // The REST surface that actually answers; token routes 404 and are not used.
  statsPath: '/api/v2/stats',
  tokenPath: (address) => `/token/${address}`,
  /** eth_getLogs range limit measured on the only working public RPC. */
  maxLogSpanBlocks: 100,
};

/** Strip tags and collapse to text lines, dropping script/style so JS does not pollute prose. */
function textLines(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, '\n')
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * Read holder figures from an Elyscan token page.
 *
 * The page renders a sentence pair for concentration - "Top 10 holders own" / "26.34%" /
 * "of supply" - and a pagination line "Showing" / "50" / "of" / "982" / "holders". Both are
 * parsed POSITIONALLY against their label rather than by scanning the whole page for numbers,
 * because a bare percentage elsewhere on the page would otherwise be picked up as
 * concentration.
 *
 * @returns {Promise<{status:'ok'|'not-found'|'unsupported'|'error', ...}>}
 */
export async function readElysiumHolders(address, { fetchImpl = globalThis.fetch, timeoutMs = TIMEOUT_MS } = {}) {
  // Every return path carries the same field set, with null for "not read". An early return
  // that omits a field leaves it `undefined`, which a caller cannot distinguish from a null
  // it should render as a dash - and `undefined` silently becomes 0 under some arithmetic.
  const empty = {
    holderCount: null, top10Percentage: null, liquidityPoolPercentage: null,
    tablePageSize: null, tableComplete: null, top10IsComplete: null,
  };

  if (!/^0x[0-9a-fA-F]{40}$/.test(String(address ?? ''))) {
    return { ...empty, status: 'unsupported', detail: 'not an EVM address' };
  }

  const url = ELYSCAN.baseUrl + ELYSCAN.tokenPath(address);
  let html;
  try {
    const res = await fetchImpl(url, {
      headers: { accept: 'text/html', 'user-agent': 'Mozilla/5.0' },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (res.status === 404) return { ...empty, status: 'not-found', detail: 'elyscan has no page for this token' };
    if (!res.ok) return { ...empty, status: 'error', detail: `http ${res.status}` };
    html = await res.text();
  } catch (err) {
    return { ...empty, status: 'error', detail: String(err?.message ?? err) };
  }

  const lines = textLines(html);

  // ---- Top 10 concentration: find the label, then the percentage that follows it.
  let top10Percentage = null;
  const top10Label = lines.findIndex((l) => /Top\s*10\s*holders?\s*own/i.test(l));
  if (top10Label >= 0) {
    for (let i = top10Label + 1; i < Math.min(lines.length, top10Label + 4); i += 1) {
      const m = lines[i].match(/^(\d{1,3}(?:\.\d+)?)%$/);
      if (m) { top10Percentage = Number(m[1]); break; }
    }
  }

  // ---- Holder count: "Showing / 50 / of / 982 / holders". Read the number BEFORE "holders"
  //      from the "Showing … of N" phrase, never a count of table rows (the table is paged).
  let holderCount = null;
  let tablePageSize = null;
  for (let i = 0; i < lines.length; i += 1) {
    if (!/^Showing$/i.test(lines[i])) continue;
    const shown = lines[i + 1]?.match(/^([\d,]+)$/);
    if (shown) tablePageSize = Number(shown[1].replace(/,/g, ''));
    if (/^of$/i.test(lines[i + 2] ?? '')) {
      const total = lines[i + 3]?.match(/^([\d,]+)$/);
      if (total) holderCount = Number(total[1].replace(/,/g, ''));
    }
    break;
  }

  // ---- Liquidity-pool share is a real figure the page states separately. It matters because
  //      a pool address inside the top holders is not a whale, and excluding it is a
  //      judgement the READER should be able to make rather than one we make silently.
  let liquidityPoolPercentage = null;
  const lpLabel = lines.findIndex((l) => /Liquidity pool/i.test(l));
  if (lpLabel >= 0) {
    const m = lines[lpLabel + 1]?.match(/^(\d{1,3}(?:\.\d+)?)%$/);
    if (m) liquidityPoolPercentage = Number(m[1]);
  }

  // ---- Whether the table is COMPLETE. A paged table showing 50 of 982 is a genuine sample
  //      and must never be reported as complete Top-10 coverage of a small population.
  const tableComplete = holderCount != null && tablePageSize != null && tablePageSize >= holderCount;

  const gotAnything = top10Percentage != null || holderCount != null;
  if (!gotAnything) {
    // The page loaded but published no figures we can read. That is a different finding from
    // "the page did not load", and from "this token has no holders".
    return {
      ...empty,
      status: 'no-data',
      detail: 'page loaded but no holder figures were present',
      source: 'elyscan-page',
    };
  }

  return {
    status: 'ok',
    source: 'elyscan-page',
    provenance: { url, chainId: ELYSCAN.chainId },
    holderCount,
    top10Percentage,
    liquidityPoolPercentage,
    tablePageSize,
    // Completeness is about the HOLDER LIST, not about the concentration figure. The
    // concentration is computed by the indexer over the whole population, so it is complete
    // even when the visible table is paged.
    tableComplete,
    // A concentration figure over a population smaller than 10 is not a "Top 10".
    top10IsComplete: holderCount == null ? null : holderCount >= 10,
  };
}

/**
 * Merge Elysium holder data into a risk block, filling only what is missing.
 *
 * Never overwrites a provider measurement with page-scraped data, and never writes a zero
 * for an absent figure.
 */
export function mergeElysiumHolders(risk, elysium) {
  const base = risk ?? {
    holders: { total: null, top10Percentage: null, largestHolderPercentage: null },
    tax: null,
    lpLock: null,
    dev: null,
    security: {},
  };
  if (!elysium || elysium.status !== 'ok') return base;

  const holders = { ...(base.holders ?? {}) };
  if (holders.total == null && elysium.holderCount != null) holders.total = elysium.holderCount;
  if (holders.top10Percentage == null && elysium.top10Percentage != null) {
    holders.top10Percentage = elysium.top10Percentage;
  }

  return {
    ...base,
    holders,
    sources: {
      ...(base.sources ?? {}),
      holders: holders.total !== (risk?.holders?.total ?? null) || holders.top10Percentage !== (risk?.holders?.top10Percentage ?? null)
        ? 'elyscan-page'
        : base.sources?.holders,
    },
    // Carried through so the renderer can show the pool share beside the concentration
    // rather than leaving the reader to guess why a token looks concentrated.
    elysium: {
      liquidityPoolPercentage: elysium.liquidityPoolPercentage ?? null,
      tableComplete: elysium.tableComplete ?? null,
      top10IsComplete: elysium.top10IsComplete ?? null,
    },
  };
}
