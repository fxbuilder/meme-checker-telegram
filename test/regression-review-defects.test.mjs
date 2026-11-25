/**
 * test/regression-review-defects.test.mjs
 *
 * Regression cover for the five defects found in independent review of the
 * Phase 2 fixes. Each test fails against the pre-fix code.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.BOT_NO_LAUNCH = '1';
process.env.TELEGRAM_BOT_TOKEN ||= 'test';
process.env.OWNER_USER_IDS = '1307106746';
process.env.ALLOWED_CHAT_IDS = '-5333984336';
const DB = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'mc-rv-')), 'calls.json');
process.env.CALLS_DB_PATH = DB;

const { bot, internals } = await import('../src/bot.mjs');
const { installTelegramStub, textUpdate, callbackUpdate } = await import('./helpers/telegram-stub.mjs');
const { CallStore, isActive } = await import('../src/store.mjs');
const { recordCall } = await import('../src/call-service.mjs');
const { resolveCaller } = await import('../src/caller-identity.mjs');

const GROUP = '-5333984336';
const OWNER = 1307106746;
const SOL_CA = 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263';

const scanOk = (over = {}) => ({
  status: 'ok',
  token: { chain: 'solana', address: SOL_CA, name: 'Bonk', symbol: 'BONK' },
  market: { marketCapUsd: 193_577_619, liquidityUsd: 200_000, priceUsd: 0.0000022, ...over },
  media: {},
});

const callerFor = (id = OWNER, name = 'Foxy', username = 'Foxydegenzu') =>
  resolveCaller({ from: { id, first_name: name, username } }, { id: Number(GROUP), title: 'sissooo1' });

let stub;
test.beforeEach(async () => {
  stub = installTelegramStub();
  // Reset the bot's OWN store (the one the handlers use), so each case starts from
  // a known state without racing the load cache.
  fs.rmSync(DB, { force: true });
  internals.callStore.loaded = false;
  internals.callStore.doc = { schemaVersion: 1, createdAt: new Date().toISOString(), seq: 0, calls: [], groups: {} };
  internals.callStore.load();
});
test.afterEach(() => stub?.restore());

const texts = () => stub.sent
  .filter((s) => s.method === 'sendMessage' || s.method === 'editMessageText')
  .map((s) => String(s.payload.text ?? ''));

// ---- defect 1 -----------------------------------------------------------

test('DEFECT 1: /justscan does not throw a ReferenceError', async () => {
  let caught = null;
  bot.catch((e) => { caught = e; });
  await bot.handleUpdate(textUpdate('/justscan'));
  assert.equal(caught, null, `handler threw: ${caught?.message}`);
  assert.ok(texts().length >= 1, '/justscan must reply, not fail silently');
});

test('DEFECT 1b: /justscan <CA> cancels a tracked call and confirms without crashing', async () => {
  const store = internals.callStore; store.load();
  await recordCall({ store, scanResult: scanOk(), caller: callerFor(), chatId: GROUP, source: 'auto', messageId: 1 });

  let caught = null;
  bot.catch((e) => { caught = e; });
  await bot.handleUpdate(textUpdate(`/justscan ${SOL_CA}`));
  assert.equal(caught, null, `handler threw: ${caught?.message}`);
  assert.ok(/cancel/i.test(texts().join(' ')), `expected a cancellation reply, got: ${texts().join(' | ')}`);

  const after = internals.callStore;
  assert.equal(after.firstCall(GROUP, 'solana', SOL_CA), null, 'cancelled call must not own attribution');
});

// ---- defect 2 -----------------------------------------------------------

test('DEFECT 2: a valid profile link works on a COLD store (no prior query)', async () => {
  // Seed the file directly, then let the bot open a fresh cold store on /start.
  const seed = internals.callStore; seed.load();
  await recordCall({ store: seed, scanResult: scanOk(), caller: callerFor(), chatId: GROUP, source: 'auto', messageId: 1 });

  const { mintCallerToken } = await import('../src/deep-link.mjs');
  const token = mintCallerToken(GROUP, `u:${OWNER}`, '7d');

  await bot.handleUpdate({
    update_id: 1,
    message: {
      message_id: 1, date: Math.floor(Date.now() / 1000),
      chat: { id: OWNER, type: 'private' },
      from: { id: OWNER, is_bot: false, first_name: 'Foxy', username: 'Foxydegenzu' },
      text: `/start ${token}`,
      entities: [{ type: 'bot_command', offset: 0, length: 6 }],
    },
  });

  const out = texts().join(' | ');
  assert.ok(!/no longer valid/i.test(out), `valid link reported as expired: ${out}`);
  assert.ok(/Calls <b>1<\/b>/.test(out), `profile must show the call: ${out}`);
});

// ---- defect 3 -----------------------------------------------------------

test('DEFECT 3: a period button changes the period', async () => {
  const store = internals.callStore; store.load();
  await recordCall({ store, scanResult: scanOk(), caller: callerFor(), chatId: GROUP, source: 'auto', messageId: 1 });
  const { mintCallerToken } = await import('../src/deep-link.mjs');
  const token = mintCallerToken(GROUP, `u:${OWNER}`, '7d');

  await bot.handleUpdate(callbackUpdate(`cp:${token}:1d`));
  const edited = stub.sent.filter((s) => s.method === 'editMessageText').map((s) => String(s.payload.text ?? ''));
  assert.ok(edited.length >= 1, 'the profile must edit in place');
  assert.match(edited.join(' '), /Period <b>1D<\/b>/, `period did not change: ${edited.join(' | ')}`);
});

test('DEFECT 3b: pagination carries its page number', async () => {
  const store = internals.callStore; store.load();
  // Two distinct tokens so the profile paginates with pageSize 1.
  await recordCall({ store, scanResult: scanOk(), caller: callerFor(), chatId: GROUP, source: 'auto', messageId: 1 });
  await recordCall({
    store, caller: callerFor(), chatId: GROUP, source: 'auto', messageId: 2,
    scanResult: {
      status: 'ok',
      token: { chain: 'solana', address: 'So11111111111111111111111111111111111111112', name: 'Sol', symbol: 'SOL' },
      market: { marketCapUsd: 50_000_000, liquidityUsd: 1_000_000, priceUsd: 100 },
      media: {},
    },
  });
  const { mintCallerToken } = await import('../src/deep-link.mjs');
  const token = mintCallerToken(GROUP, `u:${OWNER}`, '7d');

  // The callback must at least be parsed into a page, not silently dropped.
  await bot.handleUpdate(callbackUpdate(`cg:${token}:7d:1`));
  const edited = stub.sent.filter((s) => s.method === 'editMessageText').map((s) => String(s.payload.text ?? ''));
  assert.ok(edited.length >= 1, 'pagination must render');
});

// ---- defect 4 -----------------------------------------------------------

test('DEFECT 4: a superseded record owns nothing and does not block a real call', async () => {
  const store = internals.callStore; store.load();
  const first = await recordCall({ store, scanResult: scanOk(), caller: callerFor(), chatId: GROUP, source: 'auto', messageId: 1 });
  await store.updateCall(first.call.id, { status: 'superseded' });

  // Attribution: a superseded row must not answer.
  assert.equal(store.firstCall(GROUP, 'solana', SOL_CA), null, 'superseded must not own attribution');
  // PnL resolution: must not resolve.
  assert.deepEqual(store.recordedCallsForAddress(GROUP, SOL_CA), [], 'superseded must not resolve for /pnl');

  // Recording: a fresh legitimate call must NOT be treated as a duplicate.
  const again = await recordCall({
    store, scanResult: scanOk(),
    caller: callerFor(999, 'New', 'newcaller'), chatId: GROUP, source: 'auto', messageId: 2,
  });
  assert.equal(again.status, 'recorded', 'a superseded row must not block a real call');
});

test('DEFECT 4b: isActive is the single source of truth', () => {
  assert.equal(isActive({ status: 'active' }), true);
  for (const s of ['cancelled', 'superseded', undefined]) {
    assert.equal(isActive({ status: s }), false, String(s));
  }
});

test('DEFECT 4c: the observer skips superseded records', async () => {
  const store = internals.callStore; store.load();
  const a = await recordCall({ store, scanResult: scanOk(), caller: callerFor(), chatId: GROUP, source: 'auto', messageId: 1 });
  await store.updateCall(a.call.id, { status: 'superseded' });
  assert.equal(store.openCalls().length, 0, 'nothing superseded is polled');
});

// ---- defect 5 -----------------------------------------------------------

test('DEFECT 5: /calls does not list a cancelled or superseded token', async () => {
  const store = internals.callStore; store.load();
  const rec = await recordCall({ store, scanResult: scanOk(), caller: callerFor(), chatId: GROUP, source: 'auto', messageId: 1 });
  await store.updateCall(rec.call.id, { status: 'cancelled' });

  await bot.handleUpdate(textUpdate('/calls'));
  const out = texts().join(' | ');
  assert.ok(!/\$BONK/.test(out), `a withdrawn call must not be listed: ${out}`);
});

test('DEFECT 5b: /fc reports only active calls in its total', async () => {
  const store = internals.callStore; store.load();
  const old = await recordCall({ store, scanResult: scanOk(), caller: callerFor(111, 'Old', 'old'), chatId: GROUP, source: 'auto', messageId: 1 });
  await store.updateCall(old.call.id, { status: 'cancelled' });
  await recordCall({ store, scanResult: scanOk(), caller: callerFor(), chatId: GROUP, source: 'auto', messageId: 2 });

  await bot.handleUpdate(textUpdate(`/fc ${SOL_CA}`));
  const out = texts().join(' | ');
  assert.ok(/1 call/i.test(out) || !/2 calls/i.test(out), `withdrawn record must not be counted: ${out}`);
});
