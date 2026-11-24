/**
 * test/phase8-narrative-round2.test.mjs
 *
 * Round 2 narrative work:
 *   - the operator-precedence bug that lost the DexScreener website (ANT)
 *   - a stats panel must never become a "description"
 *   - launchpad vs DEX wording
 *   - EVM on-chain metadata (metaURI -> IPFS), including the empty-description case
 *   - Tax: N/A vs Transfer Fee vs dash
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { composeNarrative, isStatPanel, isBoilerplate, detectLaunchpad } from '../src/research/narrative-pipeline.mjs';
import { decodeAbiString, safeMetadataUrl, fetchOnchainMetadata } from '../src/research/evm-metadata.mjs';
import { normalizeRugCheck } from '../src/security/rugcheck.mjs';
import { resolveQuickCheck } from '../src/card-layout.mjs';
import { emptyRisk } from '../src/risk-intel.mjs';

const ANT = '0xb4f9d1b2cad3646d15797de462e5d773194d7777';
const SYSTEM = '11111111111111111111111111111111';
const TOKEN_PROG = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
const T22_PROG = 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb';

// ---- stats panels are not descriptions -----------------------------------

test('the ANT stats panel is rejected as narrative', () => {
  // The exact text the launchpad page produced, which was being shown as the token story.
  const panel = 'TOKEN INFO 24h Vol $755.76K LIQ $115.38K MCAP $542.3K Holders 5,986 '
    + '24h Exchange -30.99% FDV $542.3K Circulation 1B Max Supply 1B Create time 2026-11-19';
  assert.equal(isStatPanel(panel), true);
  assert.equal(isBoilerplate(panel), true, 'and therefore not usable as a summary');
});

test('real prose survives the stat-panel filter', () => {
  const prose = 'Anthropic is a community memecoin inspired by the AI research company, launched '
    + 'fairly with no presale and no team allocation. The community drives the project through memes.';
  assert.equal(isStatPanel(prose), false);
  assert.equal(isBoilerplate(prose), false);
});

test('prose mentioning one dollar figure is still prose', () => {
  // A single number must not tip a real description into "stats panel".
  const prose = 'A community-run dog token that started as a joke in 2023 and now runs a treasury '
    + 'worth over $2 million used for animal shelter donations around the world.';
  assert.equal(isStatPanel(prose), false);
});

// ---- launchpad vs DEX wording --------------------------------------------

test('a token page proves the launchpad, and says "Launched via"', () => {
  const lp = detectLaunchpad({
    token: { address: ANT },
    project: { website: `https://flap.sh/bnb/${ANT}` },
    market: { dexId: 'pancakeswap' },
  });
  assert.equal(lp.statement, 'Launched via flap.sh');
  assert.notEqual(lp.statement, 'Currently trading on flap.sh', 'flap.sh is not the venue it trades on');
});

test('an observed pair proves the venue, and says "Currently trading on"', () => {
  const lp = detectLaunchpad({ token: { address: ANT }, market: { dexId: 'pancakeswap' } });
  assert.equal(lp.statement, 'Currently trading on PancakeSwap');
});

test('a namesake domain with no token path proves nothing about launch', () => {
  const lp = detectLaunchpad({
    token: { address: ANT },
    project: { website: 'https://flap.sh/' },
    market: { dexId: 'uniswap' },
  });
  assert.equal(lp.statement, 'Currently trading on Uniswap', 'venue comes from the pair, not the domain');
});

test('nothing evidenced means no venue claim at all', () => {
  assert.equal(detectLaunchpad({ token: { address: ANT }, market: { dexId: 'some-unknown-dex' } }), null);
});

// ---- on-chain metadata ---------------------------------------------------

test('an ABI-encoded string decodes, and a malformed buffer does not', () => {
  // offset=32, len=3, "abc"
  const ok = '0x'
    + '00'.repeat(31) + '20'
    + '00'.repeat(31) + '03'
    + '616263' + '00'.repeat(29);
  assert.equal(decodeAbiString(ok), 'abc');

  assert.equal(decodeAbiString('0x'), null);
  assert.equal(decodeAbiString(null), null);
  assert.equal(decodeAbiString('0xzz'), null, 'not hex');
  // Length claims more bytes than exist: must refuse, never assemble garbage.
  const lying = '0x'
    + '00'.repeat(31) + '20'
    + '00'.repeat(31) + '40'
    + '616263';
  assert.equal(decodeAbiString(lying), null);
});

test('a bare CID is accepted, since that is what metaURI actually returns', () => {
  const cid = 'bafkreiaqefubjzydb4ocijpwnbpqdqd4tn3ef3gaic44hbjkzj6ufj37iy';
  const urls = safeMetadataUrl(cid);
  assert.ok(Array.isArray(urls) && urls.length >= 1);
  assert.ok(urls.every((u) => u.includes(cid)));
  assert.ok(urls.every((u) => /^https:\/\//.test(u)));
});

test('ipfs:// and http(s) are accepted; executable and local schemes are refused', () => {
  assert.ok(safeMetadataUrl('ipfs://bafkreiaqefubjzydb4ocijpwnbpqdqd4tn3ef3gaic44hbjkzj6ufj37iy'));
  assert.ok(safeMetadataUrl('https://example.test/meta.json'));
  for (const bad of ['javascript:alert(1)', 'file:///etc/passwd', 'data:text/html,<script>', 'ftp://x/y', '']) {
    assert.equal(safeMetadataUrl(bad), null, `must refuse ${bad}`);
  }
});

test('an empty on-chain description is reported as empty, not filled in', async () => {
  // Verified live: ANT's metadata document exists and its description is "".
  // Two different hops: the RPC returns an ABI-encoded CID, the gateway returns JSON.
  const abiCid = (() => {
    const cidHex = Buffer.from('bafkreiaqefubjzydb4ocijpwnbpqdqd4tn3ef3gaic44hbjkzj6ufj37iy', 'utf8').toString('hex');
    const len = cidHex.length / 2;
    return '0x'
      + '00'.repeat(31) + '20'
      + '00'.repeat(31) + len.toString(16).padStart(2, '0')
      + cidHex
      + '00'.repeat((32 - (len % 32)) % 32);
  })();
  const f = async (url) => {
    const u = String(url);
    if (u.includes('bsc-dataseed') || u.includes('127.0.0.1')) {
      return { ok: true, status: 200, json: async () => ({ result: abiCid }), text: async () => '' };
    }
    // Describe the empty case exactly as ANT behaves: document present, description "".
    return { ok: true, status: 200, text: async () => JSON.stringify({ name: 'ANT', symbol: 'ANT', description: '' }) };
  };
  const r = await fetchOnchainMetadata('bsc', ANT, { fetchImpl: f });
  assert.equal(r.status, 'empty');
  assert.equal(r.description, null, 'an empty string is not a description');
  assert.equal(r.name, 'ANT', 'the rest of the metadata is still read');
});

test('a real on-chain description is used, and outranks CoinGecko', () => {
  const composed = composeNarrative({
    result: { token: { chain: 'bsc', address: ANT, symbol: 'ANT' } },
    onchainMeta: { status: 'ok', description: 'ANT is a community memecoin honouring the AI lab, launched fairly on flap.sh with no presale.' },
    profile: { description: 'A generic CoinGecko blurb that is long enough to pass the length check.' },
  });
  assert.equal(composed.available, true);
  assert.equal(composed.summarySource, 'Token metadata (on-chain)');
});

test('an unavailable chain is reported as such, not as "no description"', async () => {
  const r = await fetchOnchainMetadata('monad', ANT, { fetchImpl: async () => { throw new Error('should not be called'); } });
  assert.equal(r.status, 'unsupported-chain');
});

// ---- tax semantics -------------------------------------------------------

const report = (over = {}) => ({
  tokenProgram: TOKEN_PROG,
  token: { supply: 1_000_000, decimals: 6 },
  creator: 'CreatorAddr',
  creatorBalance: 0,
  transferFee: { pct: 0 },
  markets: [],
  topHolders: [],
  ...over,
});

test('legacy SPL renders Tax: N/A, because the concept does not exist', () => {
  const n = normalizeRugCheck(report());
  assert.equal(n.tax.kind, 'not-applicable');
  const q = resolveQuickCheck('tax', { risk: { ...emptyRisk(), tax: n.tax }, riskStatus: 'ok' });
  assert.equal(q.value, 'N/A');
  assert.notEqual(q.value, '—', 'a dash would imply a measurable value is missing');
  assert.notEqual(q.value, '0%', 'zero would be a fabricated all-clear');
});

test('Token-2022 renders the real transfer fee, and 0% is a measurement', () => {
  const paid = normalizeRugCheck(report({ tokenProgram: T22_PROG, transferFee: { pct: 2.5 } }));
  const q = resolveQuickCheck('tax', { risk: { ...emptyRisk(), tax: paid.tax }, riskStatus: 'ok' });
  assert.equal(q.label, 'Transfer Fee');
  assert.match(q.value, /2\.50%/);

  const free = normalizeRugCheck(report({ tokenProgram: T22_PROG, transferFee: { pct: 0 } }));
  const q2 = resolveQuickCheck('tax', { risk: { ...emptyRisk(), tax: free.tax }, riskStatus: 'ok' });
  assert.equal(q2.value, '0%', 'a measured zero fee is not the same as not-applicable');
});

test('an unknown token standard claims neither N/A nor a fee', () => {
  const n = normalizeRugCheck(report({ tokenProgram: 'SomethingElse111' }));
  assert.equal(n.tax, null, 'without a known standard we cannot say the concept does not apply');
  const q = resolveQuickCheck('tax', { risk: { ...emptyRisk(), tax: n.tax }, riskStatus: 'ok' });
  assert.equal(q.value, '—');
});

// ---- creator vs owner ----------------------------------------------------

test('a creator role is labelled Creator Holds', () => {
  const q = resolveQuickCheck('dev', {
    risk: { ...emptyRisk(), dev: { address: 'C', role: 'creator', balancePercentage: 3 } },
    riskStatus: 'ok',
  });
  assert.equal(q.label, 'Creator Holds');
});

test('an owner-only role is labelled Owner Holds, never Creator', () => {
  // Calling a current owner the "creator" attributes a holding to the wrong party.
  const q = resolveQuickCheck('dev', {
    risk: { ...emptyRisk(), dev: { address: 'O', role: 'owner', balancePercentage: 3 } },
    riskStatus: 'ok',
  });
  assert.equal(q.label, 'Owner Holds');
});

test('a creator with no measured balance is not shown as holding zero', () => {
  const q = resolveQuickCheck('dev', {
    risk: { ...emptyRisk(), dev: { address: 'C', role: 'creator', balancePercentage: null } },
    riskStatus: 'ok',
  });
  assert.equal(q.value, 'Known');
  assert.notEqual(q.value, '0.0%');
});
