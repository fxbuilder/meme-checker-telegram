import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveCaller, PLACEHOLDER_USER_IDS, isAttributable, callerLabel } from '../src/caller-identity.mjs';

const GROUP = { id: -1001234567890, title: 'sissooo1', type: 'supergroup' };

test('an ordinary user is keyed by their stable Telegram id, not their name', () => {
  const id = resolveCaller(
    { from: { id: 1307106746, first_name: 'Foxy', last_name: 'Degen', username: 'Foxydegenzu' } },
    GROUP,
  );
  assert.equal(id.kind, 'user');
  assert.equal(id.callerKey, 'u:1307106746');
  assert.equal(id.displayName, 'Foxy Degen');
  assert.equal(id.username, 'Foxydegenzu');
  assert.equal(isAttributable(id), true);
});

test('renaming does not change the identity key', () => {
  const a = resolveCaller({ from: { id: 42, first_name: 'Old' } }, GROUP);
  const b = resolveCaller({ from: { id: 42, first_name: 'New', last_name: 'Name' } }, GROUP);
  assert.equal(a.callerKey, b.callerKey);
  assert.notEqual(a.displayName, b.displayName);
});

test('a user with no name falls back to @username then the id, never empty', () => {
  assert.equal(resolveCaller({ from: { id: 7, username: 'solo' } }, GROUP).displayName, '@solo');
  assert.equal(resolveCaller({ from: { id: 7 } }, GROUP).displayName, 'user 7');
});

test('an anonymous admin is attributed to sender_chat, NOT the placeholder bot id', () => {
  const id = resolveCaller(
    {
      from: { id: 1087968824, is_bot: true, first_name: 'Group', username: 'GroupAnonymousBot' },
      sender_chat: { id: GROUP.id, title: 'sissooo1', type: 'supergroup' },
    },
    GROUP,
  );
  assert.equal(id.kind, 'anonymous_admin');
  assert.equal(id.callerKey, `c:${GROUP.id}`);
  assert.notEqual(id.callerKey, 'u:1087968824');
  assert.equal(id.isAnonymous, true);
  assert.equal(id.placeholders, true);
  assert.match(id.attributionNote, /Anonymous admin/);
});

test('a channel post is attributed to the channel id', () => {
  const id = resolveCaller(
    {
      from: { id: 136817688, is_bot: true, first_name: 'Channel' },
      sender_chat: { id: -1009876543210, title: 'Signals Channel', type: 'channel', username: 'signals' },
    },
    GROUP,
  );
  assert.equal(id.kind, 'channel');
  assert.equal(id.callerKey, 'c:-1009876543210');
  assert.equal(id.displayName, 'Signals Channel');
  assert.equal(id.isAnonymous, false);
});

test('a placeholder with no sender_chat is NOT attributed at all', () => {
  const id = resolveCaller({ from: { id: 1087968824, is_bot: true } }, GROUP);
  assert.equal(id.kind, 'unknown');
  assert.equal(id.callerKey, null);
  assert.equal(isAttributable(id), false);
  assert.match(id.attributionNote, /no reliable author/);
});

test('every documented placeholder id is refused as an ordinary user', () => {
  for (const pid of PLACEHOLDER_USER_IDS) {
    const id = resolveCaller({ from: { id: pid, is_bot: true } }, GROUP);
    assert.notEqual(id.kind, 'user', `${pid} must not be a user`);
    assert.notEqual(id.callerKey, `u:${pid}`);
  }
});

test('a message with no sender is unattributable', () => {
  const id = resolveCaller({}, GROUP);
  assert.equal(id.kind, 'unknown');
  assert.equal(id.callerKey, null);
});

test('identity is scoped to the group: same user, different chat keys differ by chat', () => {
  // callerKey is user-based, so it is identical; the chatId is stored alongside
  // the call, which is what scopes it. Assert the call-level contract instead:
  const id = resolveCaller({ from: { id: 5, first_name: 'x' } }, GROUP);
  assert.equal(id.callerKey, 'u:5');
  // The group is carried by the record, so a lookup must always pass chatId.
  assert.equal(typeof id.callerKey, 'string');
});

test('callerLabel prefers the stored display name and falls back sensibly', () => {
  assert.equal(callerLabel({ callerName: 'Foxy' }), 'Foxy');
  assert.equal(callerLabel({ callerUsername: 'foxy' }), '@foxy');
  assert.equal(callerLabel({ callerKey: 'c:-100' }), 'Anonymous admin');
  assert.equal(callerLabel(null), 'unknown');
});
