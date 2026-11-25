/**
 * Elysium holder intelligence (chain 99901).
 *
 * The owner flagged that Elysium showed nothing on every risk field. The cause was not that
 * Elysium lacks a holder source - it was that two providers we happened to consult have no
 * data for the chain, and that absence was rendered as if it were a fact about the token.
 *
 * Elyscan's token page publishes holder count and Top-10 share. These tests pin the parsing
 * AND the distinctions that matter: a figure read from a page is not a first-party API
 * contract, a paged table is not a complete list, and a pool address holding supply is not a
 * whale.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { readElysiumHolders, mergeElysiumHolders, ELYSCAN } from '../src/security/elysium.mjs';

const AGI = '0x74f811f35134d73221e5491135e4c8f963316953';

/** Build a page with the sentence structure Elyscan actually renders. */
function page({ top10 = null, holders = null, shown = null, lp = null } = {}) {
  const lines = ['AGI', 'Holders'];
  if (top10 != null) lines.push('Download CSV', 'Top 10 holders own', `${top10}%`, 'of supply');
  if (holders != null) {
    lines.push('Showing', String(shown ?? 50), 'of', String(holders), 'holders');
    if (lp != null) lines.push('Liquidity pool', `${lp}%`);
  }
  return '<html><body>' + lines.map((l) => `<div>${l}</div>`).join('') + '</body></html>';
}

function stub(html, status = 200) {
  return async () => ({ ok: status === 200, status, text: async () => html });
}

test('real AGI page values are parsed: 982 holders, 26.34% top 10', async () => {
  const r = await readElysiumHolders(AGI, { fetchImpl: stub(page({ top10: 26.34, holders: 982, shown: 50, lp: 14.49 })) });
  assert.equal(r.status, 'ok');
  assert.equal(r.holderCount, 982);
  assert.equal(r.top10Percentage, 26.34);
  assert.equal(r.liquidityPoolPercentage, 14.49);
  assert.equal(r.source, 'elyscan-page', 'provenance must not imply a first-party API');
});

test('a concentration figure is read from its LABEL, not from any percentage on the page', async () => {
  // Scanning the whole document for a percentage would pick up an unrelated figure. The
  // parser anchors on "Top 10 holders own" and takes the number that follows it.
  const html = '<html><body><div>24h change</div><div>88.8%</div>'
    + '<div>Top 10 holders own</div><div>26.34%</div><div>of supply</div></body></html>';
  const r = await readElysiumHolders(AGI, { fetchImpl: stub(html) });
  assert.equal(r.top10Percentage, 26.34, 'the 88.8% elsewhere must not be picked up');
});

test('a PAGED table is never reported as a complete holder list', async () => {
  // "Showing 50 of 982" is a genuine sample. Reporting that as complete Top-10 coverage of a
  // small population would be a false completeness claim.
  const r = await readElysiumHolders(AGI, { fetchImpl: stub(page({ holders: 982, shown: 50 })) });
  assert.equal(r.holderCount, 982);
  assert.equal(r.tablePageSize, 50);
  assert.equal(r.tableComplete, false);
});

test('a holder population smaller than 10 is not a "Top 10"', async () => {
  const r = await readElysiumHolders(AGI, { fetchImpl: stub(page({ holders: 4, shown: 4, top10: 100 })) });
  assert.equal(r.top10IsComplete, false, 'four holders summed is not a Top-10 figure');
  assert.equal(r.tableComplete, true, 'but the list itself IS complete');
});

test('a page that loads with no figures is no-data, not a zero', async () => {
  // Three different things must not collapse: the page failed, the page has no figures, and
  // the token genuinely has no holders. Only the last is a zero.
  const r = await readElysiumHolders(AGI, { fetchImpl: stub('<html><body>nothing here</body></html>') });
  assert.equal(r.status, 'no-data');
  assert.notEqual(r.holderCount, 0, 'an unread count is not zero holders');
  assert.equal(r.holderCount, null);
});

test('a 404 is not-found; a 500 is an error', async () => {
  const nf = await readElysiumHolders(AGI, { fetchImpl: stub('', 404) });
  assert.equal(nf.status, 'not-found');
  const err = await readElysiumHolders(AGI, { fetchImpl: stub('', 500) });
  assert.equal(err.status, 'error');
});

test('a network failure is an error, never a holder count of zero', async () => {
  const r = await readElysiumHolders(AGI, { fetchImpl: async () => { throw new Error('ECONNRESET'); } });
  assert.equal(r.status, 'error');
  assert.equal(r.holderCount, null);
});

test('a non-address is rejected before any request', async () => {
  let called = false;
  const r = await readElysiumHolders('not-an-address', {
    fetchImpl: async () => { called = true; return { ok: true, status: 200, text: async () => '' }; },
  });
  assert.equal(r.status, 'unsupported');
  assert.equal(called, false);
});

// ---------------------------------------------------------------------------
// Merging
// ---------------------------------------------------------------------------

test('Elysium data fills gaps but never overwrites a provider measurement', () => {
  const existing = { holders: { total: 1234, top10Percentage: null }, sources: { holders: 'goplus' } };
  const merged = mergeElysiumHolders(existing, { status: 'ok', holderCount: 982, top10Percentage: 26.34 });
  assert.equal(merged.holders.total, 1234, 'a measured provider value wins');
  assert.equal(merged.holders.top10Percentage, 26.34, 'the gap is filled');
});

test('a failed Elysium read leaves the risk block untouched', () => {
  const existing = { holders: { total: null, top10Percentage: null } };
  const merged = mergeElysiumHolders(existing, { status: 'error' });
  assert.equal(merged.holders.total, null, 'no fabricated zero');
});

test('the liquidity-pool share is carried through for the reader', () => {
  // A pool address inside the top holders is not a whale. Publishing the pool's share lets a
  // reader judge that; excluding it silently would be us making their call for them.
  const merged = mergeElysiumHolders(null, {
    status: 'ok', holderCount: 982, top10Percentage: 26.34, liquidityPoolPercentage: 14.49, tableComplete: false,
  });
  assert.equal(merged.elysium.liquidityPoolPercentage, 14.49);
  assert.equal(merged.elysium.tableComplete, false);
});

test('the measured log-range limit is recorded so callers do not attempt a full scan', () => {
  // 100 blocks on the only working public RPC means a Transfer-history scan would need
  // ~105,000 requests. That is why holder data comes from an indexer instead.
  assert.equal(ELYSCAN.maxLogSpanBlocks, 100);
  assert.equal(ELYSCAN.chainId, 99901);
});
