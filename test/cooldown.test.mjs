/**
 * test/cooldown.test.mjs
 * Per-user pacing (Round 3: the 60 s silent duplicate suppression was removed).
 *
 * The behaviour under test is about ANSWERS, not just limits: a user who is paced must be
 * told, and a user who repeats a scan must get a card rather than silence.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  checkCooldown, coalesceScan, isPacingExempt, cooldownMessage, _reset,
} from '../src/cooldown.mjs';

const BASE = { userId: 1, chatId: 100, address: 'FiXtUrE111111111111111111111111111111111111' };

test('first scan is allowed', () => {
  _reset();
  const r = checkCooldown({ ...BASE });
  assert.equal(r.blocked, false);
});

test('a second scan inside the group window is paced, and says how long', () => {
  _reset();
  checkCooldown({ ...BASE });
  const r = checkCooldown({ ...BASE });
  assert.equal(r.blocked, true);
  assert.equal(r.reason, 'cooldown');
  assert.ok(Number.isFinite(r.waitSeconds) && r.waitSeconds >= 1, 'the wait is stated');
  assert.match(cooldownMessage(r.waitSeconds), /scan again in [0-9]+s/);
});

test('a repeat CA by ANOTHER user is never blocked', () => {
  // The failure the OWNER hit: one member's paste must not silence another's, and a
  // repeat by the same member must still produce a card.
  _reset();
  checkCooldown({ userId: 7, chatId: 1, address: 'X' });
  const again = checkCooldown({ userId: 8, chatId: 1, address: 'X' });
  assert.equal(again.blocked, false);
});

test('the OWNER is never paced', () => {
  _reset();
  const owner = ['1307106746'];
  const a = checkCooldown({ userId: 1307106746, chatId: 1, address: 'A', ownerIds: owner });
  const b = checkCooldown({ userId: 1307106746, chatId: 1, address: 'B', ownerIds: owner });
  assert.equal(a.blocked, false);
  assert.equal(b.blocked, false, 'the owner bypasses the community floor');
  assert.equal(isPacingExempt({ userId: 1307106746, ownerIds: owner }), true);
  assert.equal(isPacingExempt({ userId: 1, ownerIds: owner }), false);
});

test('private chat is paced more leniently than a group', () => {
  _reset();
  checkCooldown({ userId: 5, chatId: 2, address: 'P', isPrivate: true });
  const r = checkCooldown({ userId: 5, chatId: 2, address: 'Q', isPrivate: true });
  assert.equal(r.blocked, true);
  assert.equal(r.waitSeconds, 1, 'a 1 s window reports a 1 s wait');
});

test('concurrent identical scans coalesce into one execution', async () => {
  _reset();
  let runs = 0;
  const fn = async () => {
    runs += 1;
    await new Promise((r) => setTimeout(r, 20));
    return { status: 'ok', n: 1 };
  };
  const key = { chatId: 1, chain: 'base', address: '0xsame' };
  const results = await Promise.all([
    coalesceScan(key, fn), coalesceScan(key, fn), coalesceScan(key, fn),
  ]);
  assert.equal(runs, 1, 'three pastes, one provider round trip');
  assert.ok(results.every((x) => x.n === 1));
  assert.ok(results.some((x) => x.coalesced), 'followers are marked');
});

test('different addresses are NOT coalesced', async () => {
  _reset();
  let runs = 0;
  const fn = async () => { runs += 1; return { status: 'ok' }; };
  await Promise.all([
    coalesceScan({ chatId: 1, chain: 'base', address: '0xa' }, fn),
    coalesceScan({ chatId: 1, chain: 'base', address: '0xb' }, fn),
  ]);
  assert.equal(runs, 2);
});

test('a failed leader does not poison the next attempt', async () => {
  _reset();
  const key = { chatId: 1, chain: 'base', address: '0xboom' };
  await assert.rejects(coalesceScan(key, async () => { throw new Error('boom'); }));
  // The in-flight entry must be cleared, or this address is dead forever.
  const retry = await coalesceScan(key, async () => ({ status: 'ok' }));
  assert.equal(retry.status, 'ok');
});
