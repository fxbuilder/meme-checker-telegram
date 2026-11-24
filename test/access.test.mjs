/**
 * test/access.test.mjs
 * The staging access gates: chat allowlist and settings authority.
 * These are the switches that keep the bot out of unauthorised chats and stop
 * ordinary members changing group-wide state.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  loadPolicy, isOwner, isChatAllowed, canChangeSettings, describePolicy,
} from '../src/access.mjs';

const OWNER = 1307106746;
const GROUP = -1001234567890;

function policy(over = {}) {
  return loadPolicy({
    OWNER_USER_IDS: String(OWNER),
    ALLOWED_CHAT_IDS: String(GROUP),
    ...over,
  });
}

// ---- parsing -------------------------------------------------------------

test('policy parses comma and space separated id lists', () => {
  const p = loadPolicy({ OWNER_USER_IDS: '1, 2  3', ALLOWED_CHAT_IDS: '-100a,-100b' });
  assert.deepEqual([...p.ownerIds], ['1', '2', '3']);
  assert.deepEqual([...p.allowedChatIds], ['-100a', '-100b']);
});

test('policy reads the legacy single-id env names', () => {
  const p = loadPolicy({ OWNER_USER_ID: '42', TELEGRAM_TEST_GROUP_ID: '-999' });
  assert.ok(p.ownerIds.has('42'));
  assert.ok(p.allowedChatIds.has('-999'));
});

// ---- chat allowlist ------------------------------------------------------

test('the authorised group is allowed', () => {
  assert.deepEqual(isChatAllowed(policy(), GROUP), { allowed: true, reason: null });
});

test('any other chat is refused with a reason', () => {
  const r = isChatAllowed(policy(), -1009999999999);
  assert.equal(r.allowed, false);
  assert.match(r.reason, /not in ALLOWED_CHAT_IDS/);
});

test('an unconfigured allowlist refuses everywhere rather than allowing all', () => {
  const r = isChatAllowed(loadPolicy({}), GROUP);
  assert.equal(r.allowed, false, 'fail closed, never open by accident');
  assert.match(r.reason, /no ALLOWED_CHAT_IDS/);
});

test('ALLOW_ANY_CHAT is an explicit opt-in', () => {
  const r = isChatAllowed(loadPolicy({ ALLOW_ANY_CHAT: 'true' }), -100777);
  assert.equal(r.allowed, true);
});

test('a missing chat id is refused', () => {
  assert.equal(isChatAllowed(policy(), null).allowed, false);
});

// ---- owner identity ------------------------------------------------------

test('the configured owner is recognised; others are not', () => {
  const p = policy();
  assert.equal(isOwner(p, OWNER), true);
  assert.equal(isOwner(p, 999), false);
  assert.equal(isOwner(p, null), false);
});

test('id comparison is string-safe for large numeric ids', () => {
  // Telegram ids exceed safe float precision in some contexts; compare as text.
  const p = loadPolicy({ OWNER_USER_IDS: '1307106746' });
  assert.equal(isOwner(p, 1307106746), true);
  assert.equal(isOwner(p, '1307106746'), true);
});

// ---- settings authority --------------------------------------------------

test('the owner may change group settings', () => {
  assert.equal(canChangeSettings(policy(), { userId: OWNER }).allowed, true);
});

test('an ordinary member may NOT change group settings', () => {
  const r = canChangeSettings(policy(), { userId: 55555 });
  assert.equal(r.allowed, false);
  assert.match(r.reason, /only the bot owner/);
  assert.match(r.reason, /Phase 6/, 'the reason states when this changes');
});

test('a group admin is still refused while staging', () => {
  // Admin status is not verified yet, so it must not be treated as authority.
  const r = canChangeSettings(policy(), { userId: 12345, isAdmin: true });
  assert.equal(r.allowed, false);
});

// ---- reporting -----------------------------------------------------------

test('describePolicy exposes the configured values for startup logs', () => {
  const d = describePolicy(policy());
  assert.deepEqual(d.owners, [String(OWNER)]);
  assert.deepEqual(d.allowedChats, [String(GROUP)]);
  assert.equal(d.allowAnyChat, false);
});
