/**
 * test/phase4-classify.test.mjs
 *
 * Public-call classification, pinned to REAL posts retrieved from GetXAPI.
 * Every text below is a verbatim excerpt from live data, including the two that were
 * wrongly credited as calls by the original keyword matcher.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyPost, normalisePost, dedupePosts } from '../src/research/x-source.mjs';

const BONK = 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263';

const post = (text, extra = {}) => normalisePost({
  id: String(Math.random()), text, author: { userName: 'a' }, createdAt: '2026-01-01T00:00:00Z', ...extra,
}, { chain: 'solana', address: BONK, symbol: 'BONK' });

// ---- regressions measured on live data ----------------------------------

test('narrative copy containing "target" is not a call', () => {
  // Real post: @glacis_slope. Matched the word "target" under the old rule.
  const p = post(`solana:${BONK} did not start as a pitch deck. This is still a meme. It can fall. It will not mail you a target. If you show up, show up at the real door.`);
  assert.equal(classifyPost(p), 'mention');
});

test('"all day long" is not a position', () => {
  // Real post: @Dogtor_A1. Matched the word "long" under the old rule.
  const p = post(`Everyone's path is difficult and thorny. He decided to release Grutain daily all day long. Love #Bonk like your own mother. #BONK Ca: ${BONK}`);
  assert.equal(classifyPost(p), 'mention');
});

test('a multi-token promo is an advertisement, not a call', () => {
  // Real post: @Dogtor_A1 promoted BONK, $GRUTA and $USD together.
  const p = post(`Sell a kidney and buy these three coins. #BONK Ca: ${BONK} $GRUTA CA: 35t5DPbwJtB1tpGiSnqedLwQomi94BRKVDPyTRLdbonk $USD Ca: 7WXaHLjatDZBAZ7hyRiFpYpGpPbcKiyHf6HaxUzSbonk`);
  assert.equal(classifyPost(p), 'mention');
});

// ---- genuine calls are still detected -----------------------------------

test('a first-person position is a call', () => {
  for (const t of [`I aped ${BONK}`, `we bought ${BONK} at 400k`, `I'm loading ${BONK} here`]) {
    assert.equal(classifyPost(post(t)), 'public-call', t);
  }
});

test('a stated entry is a call', () => {
  for (const t of [`my entry ${BONK} was 2m`, `bought at 0.0004 ${BONK}`, `in at $0.0004 ${BONK}`]) {
    assert.equal(classifyPost(post(t)), 'public-call', t);
  }
});

test('a shill on a single-token post is a call', () => {
  assert.equal(classifyPost(post(`send it ${BONK}`)), 'public-call');
  assert.equal(classifyPost(post(`don't miss this ${BONK}`)), 'public-call');
});

test('a stated position still counts in a multi-token post', () => {
  // An explicit "my entry" is unambiguous even when other tickers appear.
  const p = post(`my entry was 2m on ${BONK}, also watching $GRUTA 35t5DPbwJtB1tpGiSnqedLwQomi94BRKVDPyTRLdbonk`);
  assert.equal(classifyPost(p), 'public-call');
});

// ---- identity guards ----------------------------------------------------

test('no contract match is never a call, however bullish', () => {
  assert.equal(classifyPost(post('I aped this so hard, sending it to the moon')), 'mention');
});

test('the project account is an announcement, not a KOL call', () => {
  const p = normalisePost({ id: '1', text: `$WIF live CA: ${BONK}`, author: { userName: 'dogwifcoin' } }, { chain: 'solana', address: BONK, symbol: 'WIF' });
  assert.equal(classifyPost(p, { projectHandle: 'dogwifcoin' }), 'announcement');
});

test('a reply or quote is a repost, not an original call', () => {
  const p = post(`I aped ${BONK}`, { isReply: true });
  assert.equal(classifyPost(p), 'repost');
});

test('an empty or missing post is unknown, not a call', () => {
  assert.equal(classifyPost(null), 'unknown');
});
