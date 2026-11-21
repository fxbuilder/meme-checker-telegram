/**
 * test/cooldown.test.mjs
 * Unit tests for per-user cooldown and duplicate protection.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

// Reload the module fresh each test via dynamic import with a cache-busting timestamp.
// Because Node caches ES modules by URL we just import once and test state management.
import { checkCooldown } from '../src/cooldown.mjs';

const BASE = { userId: 1, chatId: 100, address: 'FiXtUrE111111111111111111111111111111111111' };

test('first scan is allowed', () => {
  const r = checkCooldown({ ...BASE, userId: 10, chatId: 200 });
  assert.equal(r.blocked, false);
});

test('second scan by same user in same chat within cooldown is blocked', () => {
  const ctx = { userId: 20, chatId: 300, address: 'Sol111111111111111111111111111111111111111A' };
  const first = checkCooldown(ctx);
  assert.equal(first.blocked, false);
  const second = checkCooldown(ctx);
  assert.equal(second.blocked, true);
  assert.equal(second.reason, 'cooldown');
  assert.ok(second.waitSeconds > 0);
});

test('same CA in same chat within dedup window is blocked as duplicate', () => {
  // Different user, same address, same chat
  const addr = 'Sol222222222222222222222222222222222222222B';
  const first  = checkCooldown({ userId: 30, chatId: 400, address: addr });
  assert.equal(first.blocked, false);
  const second = checkCooldown({ userId: 31, chatId: 400, address: addr });
  assert.equal(second.blocked, true);
  assert.equal(second.reason, 'duplicate');
});

test('same CA in different chat is NOT blocked as duplicate', () => {
  const addr = 'Sol333333333333333333333333333333333333333C';
  checkCooldown({ userId: 40, chatId: 500, address: addr });
  const other = checkCooldown({ userId: 40, chatId: 501, address: addr });
  // userId 40 just scanned in chat 500, so chat 501 for same user should be a cooldown block
  // (cooldown is per user+chat pair, so different chat = no cooldown for that pair)
  // The duplicate key is per chat+address, so different chat = no dedup either
  assert.equal(other.reason !== 'duplicate', true);
});

test('dryRun does not register scan', () => {
  const addr = 'Sol444444444444444444444444444444444444444D';
  const dry = checkCooldown({ userId: 50, chatId: 600, address: addr, dryRun: true });
  assert.equal(dry.blocked, false);
  // Real check right after should still pass (dry run did not register)
  const real = checkCooldown({ userId: 50, chatId: 600, address: addr });
  assert.equal(real.blocked, false);
});
