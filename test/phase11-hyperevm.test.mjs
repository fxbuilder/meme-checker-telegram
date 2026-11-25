/**
 * HyperEVM (999) holder intelligence.
 *
 * The point of this file is the DISTINCTION between "this token has no holders" and "we have
 * no way to count them here". HyperEVM has no keyless holder source - established by probing
 * every documented route, not assumed - and the code must say so rather than render a zero.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  readHyperEvmExplorer, mergeHyperEvmHolders, scanTransfersBounded,
  HYPEREVM, HYPEREVM_KEY_ENV,
} from '../src/security/hyperevm.mjs';

const PURR = '0x9b498C3c8A0b8CD8BA1D9851d40D186F1872b44E';

// ---------------------------------------------------------------------------
// Missing credential is a configuration gap
// ---------------------------------------------------------------------------

test('no API key reports not-configured WITH the exact setup requirement', async () => {
  // This is the single most important behaviour in the module. Rendering "no holders" when a
  // key is simply unset would be a false claim about the token.
  const r = await readHyperEvmExplorer(PURR, { apiKey: null });
  assert.equal(r.status, 'not-configured');
  assert.equal(r.requirement.envVar, HYPEREVM_KEY_ENV);
  assert.match(r.requirement.howToGet, /etherscan\.io\/myapikey/);
  assert.equal(r.holderCount, undefined, 'a config gap yields no count at all');
  assert.match(r.detail, /NOT|unset/, 'the wording must not read as an empty result');
});

test('an empty-string key is treated as unset, not sent', async () => {
  let called = false;
  const r = await readHyperEvmExplorer(PURR, {
    apiKey: '   ',
    fetchImpl: async () => { called = true; return { ok: true, status: 200, json: async () => ({}) }; },
  });
  assert.equal(r.status, 'not-configured');
  assert.equal(called, false, 'no request is made without a credential');
});

// ---------------------------------------------------------------------------
// Envelope handling: Etherscan answers 200 for failures
// ---------------------------------------------------------------------------

function stub(body, status = 200) {
  return async () => ({ ok: status === 200, status, json: async () => body });
}

test('an invalid key is unauthorized, not no-data', async () => {
  const r = await readHyperEvmExplorer(PURR, { apiKey: 'x', fetchImpl: stub({ status: '0', result: 'Missing/Invalid API Key' }) });
  assert.equal(r.status, 'unauthorized');
});

test('a 429 is rate-limited, distinct from every other failure', async () => {
  const r = await readHyperEvmExplorer(PURR, { apiKey: 'x', fetchImpl: stub({}, 429) });
  assert.equal(r.status, 'rate-limited');
});

test('a genuine empty answer is no-data', async () => {
  const r = await readHyperEvmExplorer(PURR, { apiKey: 'x', fetchImpl: stub({ status: '0', result: 'No transactions found' }) });
  assert.equal(r.status, 'no-data');
});

test('a short page proves completeness; a full page does not', async () => {
  // This is the difference between "7 holders total" and "the first 100 of many". Claiming a
  // total from a full page would understate a large holder base.
  const full = Array.from({ length: 100 }, (_, i) => ({
    TokenHolderAddress: '0x' + String(i).padStart(40, '0'),
    TokenHolderQuantity: '1000',
  }));
  const rFull = await readHyperEvmExplorer(PURR, { apiKey: 'x', fetchImpl: stub({ status: '1', result: full }) });
  assert.equal(rFull.pageComplete, false, 'a full page means there is likely more');

  const short = full.slice(0, 7);
  const rShort = await readHyperEvmExplorer(PURR, { apiKey: 'x', fetchImpl: stub({ status: '1', result: short }) });
  assert.equal(rShort.pageComplete, true, 'a short page proves there is no more');
  assert.equal(rShort.holderCount, 7);
});

test('raw balances are preserved, never rescaled by a guessed exponent', async () => {
  const r = await readHyperEvmExplorer(PURR, {
    apiKey: 'x',
    fetchImpl: stub({ status: '1', result: [{ TokenHolderAddress: '0xabc', TokenHolderQuantity: '123456789012345678901234' }] }),
  });
  assert.equal(r.holders[0].rawBalance, '123456789012345678901234',
    'dividing by a guessed decimals count would misreport by orders of magnitude');
});

// ---------------------------------------------------------------------------
// Merging
// ---------------------------------------------------------------------------

test('a page total is only claimed when the page proved completeness', () => {
  const full = mergeHyperEvmHolders(null, { status: 'ok', holderCount: 100, pageComplete: false });
  assert.equal(full.holders.total, null, '100 returned does not mean 100 exist');

  const short = mergeHyperEvmHolders(null, { status: 'ok', holderCount: 7, pageComplete: true });
  assert.equal(short.holders.total, 7);
});

test('a not-configured explorer leaves the block untouched', () => {
  const merged = mergeHyperEvmHolders({ holders: { total: null } }, { status: 'not-configured' });
  assert.equal(merged.holders.total, null, 'never a zero');
});

// ---------------------------------------------------------------------------
// Bounded Transfer scanning must declare itself partial
// ---------------------------------------------------------------------------

test('a bounded scan is always marked incomplete and window-scoped', async () => {
  // A partial tally dressed as a distribution is the failure this guards: tokens acquired
  // before the window are invisible, so holders would be undercounted silently.
  const f = async (url, opts) => {
    const body = JSON.parse(opts.body);
    if (body.method === 'eth_blockNumber') {
      return { ok: true, status: 200, json: async () => ({ jsonrpc: '2.0', id: 1, result: '0x' + (50000).toString(16) }) };
    }
    return { ok: true, status: 200, json: async () => ({ jsonrpc: '2.0', id: 1, result: [] }) };
  };
  const r = await scanTransfersBounded(PURR, { fetchImpl: f, maxWindows: 2 });
  assert.equal(r.scope, 'window');
  assert.equal(r.complete, false);
  assert.match(r.coverageNote, /NOT a holder distribution/);
});

test('the measured RPC log limit is recorded, blocking a genesis scan by construction', () => {
  // 999 blocks/window on a 52.2M-block chain is 52,189 requests; measured at ~120 ms each
  // with a ~90% error rate under load, that is ~104 minutes. The constant is here so the
  // arithmetic is inspectable rather than folklore.
  assert.equal(HYPEREVM.maxLogSpanBlocks, 1_000);
  assert.equal(HYPEREVM.chainId, 999);
  const windows = Math.ceil(52_200_000 / HYPEREVM.maxLogSpanBlocks);
  assert.ok(windows > 50_000, `a full scan needs ${windows} requests`);
});

test('zero-address transfers do not create a phantom holder', async () => {
  const ZERO = '0x' + '0'.repeat(40);
  const from = '0x' + '1'.repeat(40);
  const log = {
    topics: [
      '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef',
      '0x' + '0'.repeat(24) + ZERO.slice(2),
      '0x' + '0'.repeat(24) + from.slice(2),
    ],
    data: '0x' + (1000).toString(16).padStart(64, '0'),
  };
  const f = async (url, opts) => {
    const body = JSON.parse(opts.body);
    if (body.method === 'eth_blockNumber') {
      return { ok: true, status: 200, json: async () => ({ jsonrpc: '2.0', id: 1, result: '0x' + (5000).toString(16) }) };
    }
    return { ok: true, status: 200, json: async () => ({ jsonrpc: '2.0', id: 1, result: [log] }) };
  };
  const r = await scanTransfersBounded(PURR, { fetchImpl: f, maxWindows: 1 });
  assert.equal(r.netPositive, 1, 'only the real recipient counts; the mint source is not a holder');
});
