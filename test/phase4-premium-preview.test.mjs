/**
 * test/phase4-premium-preview.test.mjs
 *
 * The free-tier preview and the premium gating.
 *
 * Product rule: deep X/KOL research is a premium WEBSITE feature; the Telegram card
 * shows only a preview of already-cached evidence and must never state a number the
 * evidence does not support.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildPreview, renderPreview, isEntitledToFullResearch, PREVIEW_MAX_ACCOUNTS,
} from '../src/research/premium-preview.mjs';

const post = (h, id, contract = true) => ({
  id, authorHandle: h, containsContract: contract, text: 'x', metrics: {},
});

const evidence = (posts, kols) => ({
  x: {
    available: true,
    status: { available: true },
    posts,
    kols,
    uniqueAccounts: new Set(posts.map((p) => p.authorHandle)).size,
  },
  narrative: {
    available: true,
    summary: 'A dog-themed memecoin airdropped after an exchange collapse, with half the supply given to existing holders.',
    summaryClass: 'project-claim',
    summarySource: 'Official website',
  },
});

// ---- never fabricate -----------------------------------------------------

test('no cached research states no counts at all', () => {
  const p = buildPreview({ x: { available: false, status: { available: false }, posts: [] } });
  assert.equal(p.hasEvidence, false);
  assert.equal(p.postCount, null);
  assert.equal(p.accountCount, null);
  assert.equal(p.callerCount, null);
  assert.deepEqual(p.accounts, []);
  assert.equal(p.state, 'not-cached');
});

test('"searched and found nothing" is not the same as "never searched"', () => {
  const never = buildPreview({ x: { available: false, status: { available: false }, posts: [] } });
  const empty = buildPreview({ x: { available: true, status: { available: true }, posts: [], kols: [] } });
  assert.equal(never.state, 'not-cached');
  assert.equal(empty.state, 'searched-empty');

  const a = renderPreview(never).join(' ');
  const b = renderPreview(empty).join(' ');
  assert.match(a, /No X research cached/i);
  assert.match(b, /No public X posts matched/i);
  assert.notEqual(a, b, 'the two states must read differently');
});

test('counts come from evidence, and a genuine zero caller count is stated as zero', () => {
  const p = buildPreview(evidence([post('a', '1'), post('b', '2')], [
    { handle: 'a', role: 'mention', posts: 1, hasContractMatch: true },
    { handle: 'b', role: 'mention', posts: 1, hasContractMatch: true },
  ]));
  assert.equal(p.postCount, 2);
  assert.equal(p.accountCount, 2);
  assert.equal(p.callerCount, 0);
  const text = renderPreview(p).join(' ');
  assert.match(text, /no public calls identified/i);
});

test('a real public caller is counted and labelled as a call', () => {
  const p = buildPreview(evidence([post('kol', '1')], [
    { handle: 'kol', role: 'public-call', posts: 1, hasContractMatch: true },
  ]));
  assert.equal(p.callerCount, 1);
  assert.equal(p.accounts[0].roleLabel, 'Public call');
  assert.match(renderPreview(p).join(' '), /1<\/b> public caller/);
});

// ---- account preview limits ---------------------------------------------

test('at most two accounts are named, callers first', () => {
  const p = buildPreview(evidence(
    [post('m1', '1'), post('m2', '2'), post('c1', '3')],
    [
      { handle: 'm1', role: 'mention', posts: 5, hasContractMatch: true },
      { handle: 'm2', role: 'mention', posts: 4, hasContractMatch: true },
      { handle: 'c1', role: 'public-call', posts: 1, hasContractMatch: true },
    ],
  ));
  assert.equal(p.accounts.length, PREVIEW_MAX_ACCOUNTS);
  assert.equal(p.accounts[0].handle, 'c1', 'a real caller outranks mentions');
});

test('a ticker-only account is marked as weak evidence', () => {
  const p = buildPreview(evidence([post('t', '1', false)], [
    { handle: 't', role: 'mention', posts: 1, hasContractMatch: false },
  ]));
  assert.match(renderPreview(p).join(' '), /ticker only/i);
});

// ---- premium CTA ---------------------------------------------------------

test('a missing or malformed premium URL produces no link, ever', () => {
  for (const bad of ['', 'not-a-url', 'javascript:alert(1)', 'ftp://x', null, undefined]) {
    assert.equal(buildPreview(evidence([post('a', '1')], []), { premiumUrl: bad }).premiumUrl, null, String(bad));
  }
});

test('a valid premium URL becomes the CTA, and an absent one degrades to an invitation', () => {
  const withUrl = renderPreview(
    buildPreview(evidence([post('a', '1')], []), { premiumUrl: 'https://example.com/token/x' }),
  ).join(' ');
  assert.match(withUrl, /href="https:\/\/example\.com\/token\/x"/);

  const withoutUrl = renderPreview(buildPreview(evidence([post('a', '1')], []))).join(' ');
  assert.ok(!/href=/.test(withoutUrl), 'no link when no destination is configured');
  assert.match(withoutUrl, /available on the website/i);
});

// ---- entitlement ---------------------------------------------------------

test('only a configured owner is entitled to full research; anything else fails closed', () => {
  const policy = { ownerIds: new Set(['1307106746']) };
  assert.equal(isEntitledToFullResearch(policy, '1307106746'), true);
  assert.equal(isEntitledToFullResearch(policy, 1307106746), true, 'numeric ids match');
  assert.equal(isEntitledToFullResearch(policy, '999'), false);
  assert.equal(isEntitledToFullResearch(policy, undefined), false);
  assert.equal(isEntitledToFullResearch(null, '1307106746'), false, 'missing policy is closed');
  assert.equal(isEntitledToFullResearch({ ownerIds: ['1307106746'] }, '1307106746'), false,
    'an array is not a Set, so an unparsable policy must not grant access');
});

test('the narrative preview is labelled with its evidence class', () => {
  const p = buildPreview(evidence([post('a', '1')], []));
  assert.equal(p.narrativeClass, 'project-claim');
  assert.equal(p.narrativeSource, 'Official website');
  assert.ok(p.narrativePreview.length <= 201);
});
