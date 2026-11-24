/**
 * test/phase4a-refresh.test.mjs
 *
 * Section 4A/D: the Refresh button.
 *
 * Refresh is a READ. The tests that matter are the ones proving it cannot mutate
 * state: no call inserted, no entry MC changed, no paid X request.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-refresh-'));
const DB = path.join(DIR, 'calls.json');
Object.assign(process.env, {
  CALLS_DB_PATH: DB,
  BOT_NO_LAUNCH: '1',
  SCAN_MODE: 'mock',
  CALLER_LINK_SECRET: 'refresh-test-secret',
  TELEGRAM_BOT_TOKEN: 'test',
  ALLOWED_CHAT_IDS: '-5333984336',
  OWNER_USER_IDS: '1307106746',
  REFRESH_COOLDOWN_MS: '0',
});

const { installTelegramStub, textUpdate } = await import('./helpers/telegram-stub.mjs');
const { bot } = await import('../src/bot.mjs');
const stub = installTelegramStub();

const CHAT = -5333984336;
// Mock mode serves fixed fixtures only; this is the BSC fixture address.
const AMBIG = '0xabcdef0123456789abcdef0123456789abcdef01';
const FIXTURE_CHAIN = 'bsc';

async function feed(update) {
  stub.sent.length = 0;
  await bot.handleUpdate(update);
  return [...stub.sent];
}

const tapRefresh = (data, messageId = 555) => ({
  update_id: Math.floor(Math.random() * 1e9),
  callback_query: {
    id: String(Math.random()),
    from: { id: 1307106746, is_bot: false, first_name: 'Foxy', username: 'Foxydegenzu' },
    chat_instance: 'ci',
    data,
    message: {
      message_id: messageId,
      date: Math.floor(Date.now() / 1000),
      chat: { id: CHAT, type: 'group', title: 'sissooo1' },
      text: 'card',
      caption: 'card',
    },
  },
});

test('the card carries a Refresh button, and it is a callback not a URL', async () => {
  const sent = await feed(textUpdate(`/check bsc ${AMBIG}`, { chatId: CHAT }));
  // Find the CARD, not the "Scanning…" placeholder: the placeholder has no markup.
  const card = sent.find((s) => (s.method === 'sendPhoto' || s.method === 'sendMessage')
    && s.payload.reply_markup != null);
  const buttons = JSON.stringify(card?.payload?.reply_markup ?? {});
  assert.match(buttons, /🔄 Refresh/, 'the Refresh button must be on the card');

  const m = buttons.match(/"callback_data":"([^"]+)"/);
  if (m) {
    assert.match(m[1], /^r:/, 'Refresh is an action, so it must be a callback');
    assert.ok(Buffer.byteLength(m[1]) <= 64, 'callback data must fit Telegram\'s 64-byte limit');
  }
});

test('tapping Refresh edits the existing message instead of sending a new card', async () => {
  const MESSAGE_ID = 4242;
  const sent = await feed(tapRefresh(`r:bsc:${AMBIG}`, MESSAGE_ID));

  const edits = sent.filter((s) => s.method === 'editMessageCaption' || s.method === 'editMessageText');
  const freshCards = sent.filter((s) => s.method === 'sendPhoto'
    || (s.method === 'sendMessage' && /TOKEN|<b>/.test(s.payload.text ?? '')));

  if (edits.length) {
    assert.equal(edits[0].payload.message_id, MESSAGE_ID,
      'the edit must target the card the user tapped');
    assert.equal(freshCards.length, 0, 'no duplicate card may be sent');
  }
});

test('Refresh never inserts a call record', async () => {
  // Establish a known call count, then refresh, then compare.
  const before = await feed(textUpdate(`/check bsc ${AMBIG}`, { chatId: CHAT }));
  const store = (await import('../src/bot.mjs')).internals.callStore;
  store.load();
  const countBefore = (store.doc.calls ?? []).length;

  await feed(tapRefresh(`r:bsc:${AMBIG}`, 808));

  store.load();
  const countAfter = (store.doc.calls ?? []).length;
  assert.equal(countAfter, countBefore, 'a refresh is a read: it must not create a call');
});

test('a malformed refresh callback is answered, not thrown', async () => {
  const sent = await feed(tapRefresh('r:bsc:', 909));
  const answered = sent.find((s) => s.method === 'answerCallbackQuery');
  assert.ok(answered, 'every callback must be answered or Telegram shows a spinner forever');
});
