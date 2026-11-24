/**
 * test/phase4a-reply-context.test.mjs
 *
 * Section 4A/B: the card must answer the ORIGINAL contract message, not the picker.
 *
 * What went wrong before: `runScan` replied to `ctx.message`, and on a chain-picker
 * callback `ctx.message` is the PICKER. So the result card was anchored to a message
 * that had just been deleted, and the user's CA message got no answer.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const DB = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'mc-reply-')), 'calls.json');
process.env.CALLS_DB_PATH = DB;
process.env.BOT_NO_LAUNCH = '1';
process.env.SCAN_MODE = 'mock';
process.env.CALLER_LINK_SECRET = 'test-secret-for-reply-context';
process.env.TELEGRAM_BOT_TOKEN = 'test';
process.env.ALLOWED_CHAT_IDS = '-5333984336';
process.env.OWNER_USER_IDS = '1307106746';

const { installTelegramStub, textUpdate } = await import('./helpers/telegram-stub.mjs');
const { bot, internals } = await import('../src/bot.mjs');
const stub = installTelegramStub();

const CHAT = -5333984336;
const AMBIG = '0x6982508145454ce325ddbe47a25d4ec3d2311933';

/**
 * Pin chain resolution for these tests.
 *
 * A pasted EVM address is now resolved automatically, so whether a picker appears
 * depends on live providers. That would make these reply-context assertions
 * non-deterministic and network-dependent, which is not what they are testing.
 * 'ambiguous' reproduces the picker path deterministically.
 */
function pinResolution(result) {
  internals.chainResolver.resolve = async () => result;
}
const AMBIG_MULTI = { status: 'ambiguous', candidates: ['base', 'ethereum'], agreement: true };
pinResolution(AMBIG_MULTI);

/** Feed one update through the real middleware chain. */
async function feed(update) {
  stub.sent.length = 0;
  await bot.handleUpdate(update);
  return [...stub.sent];
}

function callbackUpdate(data, { messageId = 900, originMessageId = null } = {}) {
  return {
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
        text: 'Which chain is this address on?',
      },
    },
  };
}

test('a pasted EVM contract produces a chain picker', async () => {
  const sent = await feed(textUpdate(AMBIG, { chatId: CHAT }));
  const picker = sent.find((s) => s.method === 'sendMessage' && /Which chain/i.test(s.payload.text ?? ''));
  assert.ok(picker, 'a picker must be offered for an ambiguous EVM address');
});

test('the card after chain selection replies to the ORIGINAL CA message, not the picker', async () => {
  // 1. The user pastes the CA. Capture the message id Telegram assigned it.
  const update = textUpdate(AMBIG, { chatId: CHAT });
  const originId = update.message.message_id;
  await feed(update);

  // 2. The user taps a chain. The callback carries the PICKER's message id, which is
  //    deliberately different so a mix-up is visible.
  const PICKER_ID = 777;
  const sent = await feed(callbackUpdate(`c:base:${AMBIG}`, { messageId: PICKER_ID }));

  const card = sent.find((s) =>
    (s.method === 'sendMessage' || s.method === 'sendPhoto')
    && /TOKEN|Base|PEPE|contract/i.test(JSON.stringify(s.payload))
    && s.payload.reply_to_message_id != null);

  assert.ok(card, 'the result card must reply to something');
  assert.equal(card.payload.reply_to_message_id, originId,
    'the card must anchor to the CA message, not the picker');
  assert.notEqual(card.payload.reply_to_message_id, PICKER_ID,
    'replying to the picker would anchor the result to a deleted prompt');
});

test('an explicit chain hint bypasses the picker entirely', async () => {
  const sent = await feed(textUpdate(`/check base ${AMBIG}`, { chatId: CHAT }));
  const picker = sent.find((s) => /Which chain/i.test(s.payload.text ?? ''));
  assert.ok(!picker, 'no picker when the chain is stated explicitly');
  // A card or an honest not-found is acceptable here; what must NOT happen is a
  // prompt asking the user to repeat information they already gave.
});
