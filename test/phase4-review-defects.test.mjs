/**
 * test/phase4-review-defects.test.mjs
 *
 * The four defects from the independent review that survived its stop-edit order.
 * Each test pins the exact failure the reviewer described.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { normalisePost, verifyPostUrl } from '../src/research/x-source.mjs';
import { composeNarrative, detectLaunchpad } from '../src/research/narrative-pipeline.mjs';
import { renderNarrative } from '../src/research/research-commands.mjs';

const CA = '0x6982508145454ce325ddbe47a25d4ec3d2311933';
const BONK = 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263';
const base = { text: 'x', author: { userName: 'alice' } };

// ---- #3: malformed ids must not become plausible URLs ---------------------

test('a non-numeric post id is dropped, not turned into a URL', () => {
  for (const id of ['abc', 'v2-1', '12.5', '1e5', '', null, undefined, {}, []]) {
    assert.equal(normalisePost({ ...base, id }, {}), null, `id=${JSON.stringify(id)} must not produce a post`);
  }
});

test('a numeric id still produces a grounded URL', () => {
  for (const id of ['123', 123, '1900000000000000000']) {
    const p = normalisePost({ ...base, id }, {});
    assert.ok(p, `id=${id} should be accepted`);
    assert.match(p.url, /^https:\/\/x\.com\/alice\/status\/\d+$/);
  }
});

// ---- #4: verifyPostUrl must be end-anchored ------------------------------

test('a suffix after a numeric status id is refused before any fetch', async () => {
  let fetched = false;
  const r = await verifyPostUrl('https://x.com/alice/status/123.evil', {
    fetchImpl: async () => { fetched = true; return { ok: true, status: 200 }; },
  });
  assert.equal(r.reason, 'not-a-post-url');
  assert.equal(fetched, false, 'a malformed URL must not reach the provider');
});

test('a well-formed post URL still passes the shape check', async () => {
  const r = await verifyPostUrl('https://x.com/alice/status/123', {
    fetchImpl: async () => ({ ok: false, status: 418 }),
  });
  assert.equal(r.reason, 'http 418', 'it got past validation and reached the fetch');
});

// ---- #1: provenance label must match the real source ---------------------

const narrativeWith = (summaryClass, summarySource) => ({
  available: true,
  summary: 'Some description of the token that is long enough to render.',
  summaryClass,
  summarySource,
});

test('a market-provider description is NOT labelled as the project describing itself', () => {
  const text = renderNarrative({
    target: { chain: 'ethereum', address: CA },
    research: { x: { available: false, status: { available: false }, posts: [] }, narrative: narrativeWith('reported', 'Market provider') },
    chainName: 'Ethereum',
  });
  assert.match(text, /Third-party market description/i);
  assert.ok(!/Project's own description/i.test(text),
    'third-party text must never be presented as the project\'s own claim');
});

test('a project description IS labelled as an unverified claim', () => {
  const text = renderNarrative({
    target: { chain: 'solana', address: BONK },
    research: { x: { available: false, status: { available: false }, posts: [] }, narrative: narrativeWith('project-claim', 'Official website') },
    chainName: 'Solana',
  });
  assert.match(text, /Project's own description/i);
  assert.match(text, /unverified/i);
});

test('an unknown evidence class is labelled unknown, not assumed to be the project', () => {
  const text = renderNarrative({
    target: { chain: 'solana', address: BONK },
    research: { x: { available: false, status: { available: false }, posts: [] }, narrative: narrativeWith('mystery-class', 'something') },
    chainName: 'Solana',
  });
  assert.match(text, /Unverified description/i);
  assert.ok(!/Project's own description/i.test(text));
});

// ---- #2: launchpad must not claim launch origin -------------------------

test('the verified claim is the observed venue, never a launch history', () => {
  const c = composeNarrative({
    result: { token: { chain: 'solana', address: 'X', symbol: 'NEWT' }, market: { dexId: 'pumpfun' } },
    profile: null,
    websiteText: 'Newt is a community memecoin built around a cartoon newt and a weekly art contest.',
  });
  const claim = c.claims.find((x) => /trading on/.test(x.text));
  assert.ok(claim, 'the venue claim should exist');
  assert.match(claim.text, /Currently trading on pump\.fun/);
  assert.ok(!c.claims.some((x) => /Launched on/.test(x.text)),
    'a current pair does not prove where the token launched');
});

test('a token NAME containing a launchpad string proves nothing', () => {
  // Previously the name/website were searched, so "Pancake Dog" trading on Raydium
  // could be described as a PancakeSwap launch.
  const lp = detectLaunchpad({
    market: { dexId: 'raydium' },
    token: { name: 'Pancake Dog' },
    name: 'Pancake Dog',
    project: { website: 'https://pancakedog.example' },
  });
  assert.equal(lp?.label, 'Raydium', 'only the observed pair decides the venue');
});

test('an unknown venue yields no launchpad claim at all', () => {
  assert.equal(detectLaunchpad({ market: { dexId: 'mystery-dex' } }), null);
  const c = composeNarrative({ result: { token: { chain: 'base', address: '0x', symbol: 'X' } }, profile: null, websiteText: null });
  assert.ok(!c.claims.some((x) => /trading on|Launched on/.test(x.text)));
});
