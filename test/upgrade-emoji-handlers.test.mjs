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
  action(re,f){ (globalThis.uhActions ||= []).push({re,f}) }
  catch(){}
  async launch(){}
}
export const Markup={
  button:{url:(text,url)=>({text,url}), callback:(text,data)=>({text,callback_data:data})},
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

// Solana fixture address — used where a test needs a scan to actually run,
// since a bare 0x… now correctly asks which chain first.
const SOL_CA = 'FiXtUrE111111111111111111111111111111111111';

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
    reply: async (t, _opts) => { out.push({ type: 'reply', text: t, opts: _opts }); return { message_id: 1 }; },
    answerCbQuery: async (t) => { out.push({ type: 'cbq', text: t }); },
    deleteMessage: async () => { out.push({ type: 'delete' }); },
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

// ---- custom_emoji DM yields a preview reply with mock card ------------------

test('DM with custom_emoji entity returns a preview reply and a mock card with the theme applied', async () => {
  const id = '5291923604487808793';
  const entities = [{ type: 'custom_emoji', custom_emoji_id: id }];
  const out = await dispatch('message', { text: '🚀', entities, chatType: 'private', chatId: 60 });
  assert.ok(out.length >= 3, `expected at least 3 replies (prompt + Solana card + BNB card), got ${out.length}`);
  const previewMsg = out.find(m => m.text?.includes('Emoji Theme Preview'));
  assert.ok(previewMsg, 'preview prompt not found');
  // Both chain cards must contain the custom_emoji_id as a tg-emoji tag
  const cardMsgs = out.filter(m => m.text?.includes('MEME CHECKER'));
  assert.equal(cardMsgs.length, 2, `expected 2 chain cards in preview, got ${cardMsgs.length}`);
  assert.ok(cardMsgs.some(m => m.text.includes(id)), `custom_emoji_id ${id} not found in any preview card`);
  // Solana card should mention Solana, BNB card should mention BNB
  assert.ok(cardMsgs.some(m => m.text.includes('Solana')), 'Solana card missing from preview');
  assert.ok(cardMsgs.some(m => m.text.includes('BNB')), 'BNB card missing from preview');
});

// ---- custom_emoji DM then approval -----------------------------------------

test('ordinary scans use standard emoji while approval is pending', async () => {
  // Set up a pending theme in chat 70
  const entities = [{ type: 'custom_emoji', custom_emoji_id: '7777777777777777777' }];
  await dispatch('message', { text: '🚀', entities, chatType: 'private', chatId: 70 });
  // Now post a CA in a different (group) chat — should use standard emoji, not the pending theme.
  // A Solana CA is used because a bare 0x… now correctly asks for a chain first.
  const out = await dispatch('message', { text: SOL_CA, chatType: 'group', chatId: 300 });
  const card = out.find(m => m.text?.includes('MEME CHECKER'));
  assert.ok(card, 'card not found');
  assert.ok(!card.text.includes('tg-emoji'), 'pending theme must not leak into scans before approval');
});

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
  // Solana CA avoids the EVM chain picker, so this test still exercises a scan.
  const out = await dispatch('message', { text: SOL_CA, chatType: 'group', chatId: 200 });
  const card = out.find(m => m.text?.includes('MEME CHECKER'));
  assert.ok(card, 'card not found');
  assert.ok(!card.text.includes('tg-emoji'), 'standard mode should not contain tg-emoji');
});
