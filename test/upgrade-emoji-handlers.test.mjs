/**
 * test/upgrade-emoji-handlers.test.mjs
 * Handler regressions:
 * - /upgrade omits Premium button when PREMIUM_URL is empty
 * - A DM carrying custom_emoji entities returns a preview reply
 * Uses the same offline Telegraf shim as qa/handlers.mjs
 */
import { registerHooks } from 'node:module';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';
import assert from 'node:assert/strict';

const shim = `
export class Telegraf {
  start(f){globalThis.uh.start=f}
  help(f){globalThis.uh.help=f}
  command(k,f){globalThis.uh[k]=f}
  on(k,f){globalThis.uh[k]=f}
  catch(){}
  async launch(){}
}
export const Markup={
  button:{url:(text,url)=>({text,url})},
  inlineKeyboard:rows=>({reply_markup:{inline_keyboard:rows}})
};
`;

registerHooks({
  resolve(s, c, next) {
    return s === 'telegraf'
      ? { url: 'data:text/javascript,' + encodeURIComponent(shim), shortCircuit: true }
      : next(s, c);
  }
});

// Fake getCustomEmojiStickers that returns a sticker for each ID
const fakeStickers = id => ({ emoji: '🚀', custom_emoji_id: id });

process.env.SCAN_MODE = 'mock';
process.env.TELEGRAM_BOT_TOKEN = 'offline-only';
process.env.TOKEN_PAGE_BASE_URL = '';
process.env.PREMIUM_URL = '';
process.env.EMOJI_THEME = '';
globalThis.uh = {};

await import(pathToFileURL(resolve(import.meta.dirname, '../src/bot.mjs')));

/** Dispatch a handler key with a synthetic context. */
async function dispatch(key, opts = {}) {
  const {
    text = '',
    isBot = false,
    chatId = 1,
    chatType = 'private',
    entities = [],
  } = opts;
  const out = [];
  const telegram = {
    editMessageText: async (a, b, c, t) => out.push({ type: 'edit', text: t }),
    getCustomEmojiStickers: async (ids) => ids.map(fakeStickers),
    getStickerSet: async () => ({ stickers: [{ emoji: '🚀', custom_emoji_id: '9999999999999999999' }] }),
    getMe: async () => ({ username: 'TestBot' }),
  };
  const ctx = {
    message: { text, entities },
    chat: { id: chatId, type: chatType },
    from: { id: 99, is_bot: isBot },
    telegram,
    reply: async (t, _opts) => { out.push({ type: 'reply', text: t }); return { message_id: 1 }; },
  };
  if (globalThis.uh[key]) await globalThis.uh[key](ctx);
  return out;
}

// ---- /upgrade with no PREMIUM_URL ------------------------------------------

test('/upgrade with empty PREMIUM_URL sends no Unlock Premium button', async () => {
  const out = await dispatch('upgrade', { chatType: 'private' });
  assert.ok(out.length > 0, 'should reply');
  for (const msg of out) {
    assert.ok(!msg.text?.includes('Unlock Premium'), `unexpected Premium button in: ${msg.text}`);
  }
});

// ---- custom_emoji DM yields a preview reply --------------------------------

test('DM with custom_emoji entity returns a preview reply', async () => {
  const entities = [{ type: 'custom_emoji', custom_emoji_id: '1234567890123456789' }];
  const out = await dispatch('message', { text: '🚀', entities, chatType: 'private' });
  assert.ok(out.length > 0, 'should reply with a preview');
  const previewMsg = out.find(m => m.text?.includes('Emoji Theme Preview') || m.text?.includes('preview'));
  assert.ok(previewMsg, 'preview message not found');
});

// ---- custom_emoji DM then approval -----------------------------------------

test('DM approval ✅ yes applies the theme', async () => {
  // First send the emoji to build a pending theme
  const entities = [{ type: 'custom_emoji', custom_emoji_id: '9876543210987654321' }];
  await dispatch('message', { text: '🚀', entities, chatType: 'private', chatId: 50 });
  // Then approve
  const out = await dispatch('message', { text: 'yes', chatType: 'private', chatId: 50 });
  const applied = out.find(m => m.text?.includes('applied') || m.text?.includes('✅'));
  assert.ok(applied, `expected 'applied' confirmation, got: ${JSON.stringify(out)}`);
});

test('DM approval ❌ no discards the theme', async () => {
  const entities = [{ type: 'custom_emoji', custom_emoji_id: '1111000011110000111' }];
  await dispatch('message', { text: '🚀', entities, chatType: 'private', chatId: 51 });
  const out = await dispatch('message', { text: 'no', chatType: 'private', chatId: 51 });
  const discarded = out.find(m => m.text?.includes('discarded') || m.text?.includes('❌'));
  assert.ok(discarded, `expected 'discarded' confirmation, got: ${JSON.stringify(out)}`);
});

// ---- standard emoji when no theme ------------------------------------------

test('no theme set → card uses standard emoji (no tg-emoji tags)', async () => {
  // Reset theme to default before this test (prior approval tests may have set one)
  await dispatch('resettheme', { chatType: 'private', chatId: 99 });
  const address = '0xabcdef0123456789abcdef0123456789abcdef01';
  const out = await dispatch('message', { text: address, chatType: 'group', chatId: 200 });
  const card = out.find(m => m.text?.includes('MEME CHECKER'));
  assert.ok(card, 'card not found');
  assert.ok(!card.text.includes('tg-emoji'), 'standard mode should not contain tg-emoji');
});
