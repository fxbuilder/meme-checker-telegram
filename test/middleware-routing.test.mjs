/**
 * test/middleware-routing.test.mjs
 *
 * Drives REAL Telegraf updates through the bot's registered middleware chain and
 * asserts which handler answered.
 *
 * This is the test that was missing. The previous suite called handlers directly,
 * so it could not see that `bot.on('message')` returned without calling next() and
 * therefore swallowed every command registered after it. /pnl, /call, /calls and
 * /fc appeared to do nothing in the owner's group while 370 unit tests passed.
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
process.env.CALLS_DB_PATH = path.join(
  fs.mkdtempSync(path.join(os.tmpdir(), 'mc-mw-')), 'calls.json',
);

const { bot } = await import('../src/bot.mjs');
const { installTelegramStub, textUpdate } = await import('./helpers/telegram-stub.mjs');

const OWNER = 1307106746;
const SOL_CA = 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263';
const PEPE = '0x6982508145454ce325ddbe47a25d4ec3d2311933';

let stub;
test.beforeEach(() => { stub = installTelegramStub(); });
test.afterEach(() => { stub?.restore(); });

const texts = () => stub.sent
  .filter((s) => s.method === 'sendMessage' || s.method === 'editMessageText')
  .map((s) => String(s.payload.text ?? ''));

test('/pnl reaches ITS handler, not the CA auto-detector', async () => {
  await bot.handleUpdate(textUpdate(`/pnl ${PEPE}`));
  const joined = texts().join(' | ');

  assert.ok(joined.length > 0, 'the command must answer');
  assert.ok(!/Which chain is this address on/i.test(joined), `chain picker leaked: ${joined}`);
  assert.ok(/No recorded call for this token in this group\./.test(joined), `got: ${joined}`);
  assert.ok(!/MARKET OVERVIEW|TOKEN ANALYSIS/.test(joined), 'no scanner card for a /pnl command');
});

test('/pnl in a DM explains instead of failing silently', async () => {
  await bot.handleUpdate(textUpdate(`/pnl ${SOL_CA}`, { chatId: OWNER, chatType: 'private' }));
  const joined = texts().join(' | ');
  assert.ok(joined.length > 0, 'must answer');
  assert.ok(/per group/i.test(joined), `got: ${joined}`);
});

test('/calls answers in the group rather than being swallowed', async () => {
  await bot.handleUpdate(textUpdate('/calls'));
  assert.ok(texts().length >= 1, '/calls must produce a reply');
});

test('/fc answers in the group rather than being swallowed', async () => {
  await bot.handleUpdate(textUpdate(`/fc ${SOL_CA}`));
  assert.ok(texts().length >= 1, '/fc must produce a reply');
});

test('/call answers in the group rather than being swallowed', async () => {
  await bot.handleUpdate(textUpdate(`/call ${SOL_CA}`));
  assert.ok(texts().length >= 1, '/call must produce a reply');
});

test('a bare CA in a group still reaches the scanner (auto-detect is not broken)', async () => {
  await bot.handleUpdate(textUpdate(SOL_CA));
  const methods = stub.sent.map((s) => s.method);
  assert.ok(methods.includes('sendMessage'), `expected a scan response, saw: ${methods.join(',')}`);
});
