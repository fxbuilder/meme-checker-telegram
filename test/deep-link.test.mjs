import test from 'node:test';
import assert from 'node:assert/strict';
import {
  mintCallerToken, resolveCallerToken, looksLikeCallerToken, callerDeepLink,
  MAX_PAYLOAD_LEN, scopeFor, resetSecretForTests,
} from '../src/deep-link.mjs';

const SECRET = Buffer.alloc(32, 7);
const CHAT = '-5333984336';
const CALLERS = [{ callerKey: 'u:1307106746' }, { callerKey: 'u:42' }, { callerKey: 'c:-5333984336' }];

test('a minted payload is short, url-safe and fits Telegram limits', () => {
  const p = mintCallerToken(CHAT, 'u:1307106746', '7d', { secret: SECRET });
  assert.ok(p.length <= MAX_PAYLOAD_LEN, `payload ${p.length} > ${MAX_PAYLOAD_LEN}`);
  assert.match(p, /^[A-Za-z0-9_-]+$/, 'url-safe only');
});

test('the payload does not contain the user id or the chat id in readable form', () => {
  const p = mintCallerToken(CHAT, 'u:1307106746', '7d', { secret: SECRET });
  assert.ok(!p.includes('1307106746'), 'must not leak the user id');
  assert.ok(!p.includes('5333984336'), 'must not leak the chat id');
  // Nor a trivially decodable base64 of them.
  const decoded = Buffer.from(p.slice(3), 'base64').toString('latin1');
  assert.ok(!decoded.includes('1307106746'));
});

test('a minted payload resolves back to the exact caller and period', () => {
  const p = mintCallerToken(CHAT, 'u:42', '14d', { secret: SECRET });
  const hit = resolveCallerToken(p, CHAT, CALLERS, { secret: SECRET });
  assert.deepEqual(hit, { callerKey: 'u:42', period: '14d' });
});

test('the SAME caller gets DIFFERENT tokens in different groups', () => {
  const a = mintCallerToken('-5333984336', 'u:42', '7d', { secret: SECRET });
  const b = mintCallerToken('-1009999999999', 'u:42', '7d', { secret: SECRET });
  assert.notEqual(a, b, 'a link must not be portable across groups');
});

test('a token from one group does not resolve against another group', () => {
  const p = mintCallerToken('-5333984336', 'u:42', '7d', { secret: SECRET });
  assert.equal(resolveCallerToken(p, '-1009999999999', CALLERS, { secret: SECRET }), null);
});

test('a tampered payload resolves to nothing', () => {
  const p = mintCallerToken(CHAT, 'u:42', '7d', { secret: SECRET });
  const tampered = p.slice(0, -1) + (p.endsWith('A') ? 'B' : 'A');
  assert.equal(resolveCallerToken(tampered, CHAT, CALLERS, { secret: SECRET }), null);
});

test('a token signed with a different secret does not resolve', () => {
  const other = Buffer.alloc(32, 9);
  const p = mintCallerToken(CHAT, 'u:42', '7d', { secret: other });
  assert.equal(resolveCallerToken(p, CHAT, CALLERS, { secret: SECRET }), null);
});

test('a guessed payload does not resolve', () => {
  for (const guess of ['cp_AAAAAAAAAAAAAAAA', 'cp_', 'cp_x', 'nope', '']) {
    assert.equal(resolveCallerToken(guess, CHAT, CALLERS, { secret: SECRET }), null, guess);
  }
});

test('a caller not in the group list cannot be resolved, even with a valid token', () => {
  const p = mintCallerToken(CHAT, 'u:999', '7d', { secret: SECRET });
  // u:999 has no calls in this group, so it is not a candidate.
  assert.equal(resolveCallerToken(p, CHAT, CALLERS, { secret: SECRET }), null);
});

test('every period mints a distinct token and resolves to itself', () => {
  const seen = new Set();
  for (const period of ['1d', '7d', '14d', '30d']) {
    const p = mintCallerToken(CHAT, 'u:42', period, { secret: SECRET });
    seen.add(p);
    const hit = resolveCallerToken(p, CHAT, CALLERS, { secret: SECRET });
    assert.equal(hit.period, period);
  }
  assert.equal(seen.size, 4, 'periods must not collide');
});

test('tokens are deterministic for the same scope and secret', () => {
  const a = mintCallerToken(CHAT, 'u:42', '7d', { secret: SECRET });
  const b = mintCallerToken(CHAT, 'u:42', '7d', { secret: SECRET });
  assert.equal(a, b, 'restart-safe: same inputs, same token');
});

test('scopeFor separates chat, caller and period', () => {
  assert.equal(scopeFor('-1', 'u:2', '7d'), '-1:u:2:7d');
});

test('looksLikeCallerToken rejects non-payloads', () => {
  assert.equal(looksLikeCallerToken('cp_abc'), true);
  assert.equal(looksLikeCallerToken('abc'), false);
  assert.equal(looksLikeCallerToken(null), false);
  assert.equal(looksLikeCallerToken('cp_bad space'), false);
});

test('the deep link is a t.me start link with the payload encoded', () => {
  assert.equal(
    callerDeepLink('MemeCheckerStagingBot', 'cp_abc'),
    'https://t.me/MemeCheckerStagingBot?start=cp_abc',
  );
  assert.equal(callerDeepLink('', 'cp_abc'), null);
});

test('without a configured secret, tokens still mint but warn', () => {
  resetSecretForTests();
  const p = mintCallerToken(CHAT, 'u:42', '7d');
  assert.ok(looksLikeCallerToken(p));
  assert.ok(resolveCallerToken(p, CHAT, CALLERS));
  resetSecretForTests();
});
