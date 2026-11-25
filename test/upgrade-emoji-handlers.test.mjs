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
  use(f){ (globalThis.uhMiddleware ||= []).push(f) }
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
// The staging allowlist is active in bot.mjs. These handler tests exercise the
// owner path, so identify as the owner; the allowlist itself is covered by
// test/access.test.mjs.
process.env.OWNER_USER_IDS = '99';
process.env.ALLOWED_CHAT_IDS = '1,50,51,60,70,99,200,300,401,402,403,404,405,406,407,408';
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
    // Delivery layer surface. sendPhoto is stubbed to FAIL so the offline suite
    // exercises the text path deterministically (no network in unit tests).
    sendPhoto: async () => { const e = new Error('offline: photo disabled'); e.description = 'offline: photo disabled'; throw e; },
    sendMessage: async (chat, text, opts) => {
      out.push({ type: 'reply', text, opts });
      return { message_id: 4242, text, entities: [], reply_markup: opts?.reply_markup };
    },
    deleteMessage: async () => out.push({ type: 'delete' }),
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

// ---- chain picker + view callbacks ----------------------------------------

/** Fire a registered bot.action handler with a synthetic ctx. */
async function fireAction(pattern, data, opts = {}) {
  const { chatId = 401, viaBot = false } = opts;
  const entry = (globalThis.uhActions ?? []).find((a) => a.re.test(data));
  assert.ok(entry, `no action handler matched: ${data}`);
  const out = [];
  const ctx = {
    match: entry.re.exec(data),
    chat: { id: chatId, type: 'group' },
    from: { id: 99, is_bot: viaBot },
    answerCbQuery: async (t) => out.push({ type: 'cbq', text: t }),
    deleteMessage: async () => out.push({ type: 'delete' }),
    reply: async (t) => { out.push({ type: 'reply', text: t }); return { message_id: 9 }; },
    telegram: {
      editMessageText: async (a, b, c, t) => out.push({ type: 'edit', text: t }),
      getMe: async () => ({ username: 'TestBot' }),
    },
  };
  await entry.f(ctx);
  return out;
}

test('a bare EVM address triggers the chain picker instead of guessing', async () => {
  const out = await dispatch('message', {
    text: '0xabcdef0123456789abcdef0123456789abcdef01',
    chatType: 'group', chatId: 402,
  });
  const picker = out.find((m) => m.text?.includes('Which chain'));
  assert.ok(picker, 'expected a chain picker prompt');
  // It must not have scanned blind.
  assert.ok(!out.find((m) => m.text?.includes('MEME CHECKER') && m.text?.includes('QUICK CHECKS')),
    'must not scan before the chain is chosen');
  // Every callback stays inside Telegram's 64-byte limit.
  const cbs = (picker.opts?.reply_markup?.inline_keyboard ?? []).flat();
  assert.ok(cbs.length >= 14, 'all EVM chains offered');
  for (const b of cbs) {
    assert.ok(Buffer.byteLength(b.callback_data) <= 64, `callback_data too long: ${b.callback_data}`);
  }
});

test('chain picker callback answered and cleaned up', async () => {
  const out = await fireAction(/^c:(.+)$/, 'c:cancel');
  assert.ok(out.some((o) => o.type === 'delete'), 'picker message should be removed');
  assert.ok(out.some((o) => o.type === 'cbq'));
});

test('an unknown chain in callback data is rejected without scanning', async () => {
  const out = await fireAction(/^c:(.+)$/, 'c:notachain:0xabcdef0123456789abcdef0123456789abcdef01');
  assert.ok(out.some((o) => o.type === 'cbq' && /Unknown chain/.test(o.text ?? '')));
  assert.ok(!out.some((o) => o.text?.includes('QUICK CHECKS')));
});

test('/short, /detail and /standard no longer switch a view', async () => {
  // OWNER removed multi-view cards. These commands are now compatibility stubs: they must
  // answer clearly instead of silently doing nothing, and none of them may re-introduce a
  // second card layout.
  const MESSAGE = /Standard card is now the default view/i;
  for (const cmd of ['short', 'detail', 'standard', 'compact']) {
    const out = await dispatch(cmd, { chatType: 'private', chatId: 403 });
    assert.match(out[0].text, MESSAGE, `/${cmd} must explain the single view, got: ${out[0].text}`);
  }
});

test('/chains lists capabilities without overclaiming', async () => {
  const out = await dispatch('chains', { chatType: 'private', chatId: 408 });
  const t = out[0].text;
  assert.ok(t.includes('Story'), 'story listed');
  assert.ok(/Story/i.test(t), 'story named even though it is not scannable');
  assert.match(t, /not scannable|unavailable/i, 'a chain without market data is marked unavailable');
  // Solana has no tax concept and must not be advertised as having one. The redesigned line
  // lists only the capabilities the chain actually has.
  const solanaLine = t.split('\n').find((l) => l.includes('Solana')) ?? '';
  assert.ok(solanaLine, 'solana line present');
  assert.doesNotMatch(solanaLine, /tax/i, `solana must not claim tax: ${solanaLine}`);
  // The seven priority networks lead; the rest are demoted.
  assert.ok(t.indexOf('Primary') < t.indexOf('Additional'), 'priority networks come first');
});
