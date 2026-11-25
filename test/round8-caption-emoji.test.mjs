/**
 * test/round8-caption-emoji.test.mjs
 * THE RELEASE-BLOCKING DEFECT: custom emoji never reached the Standard token card.
 *
 * Root cause: the outgoing-emoji interceptor wrapped every Telegram method as
 * `(chatId, text, extra)` and upgraded argument 2. Only `sendMessage` matches that shape.
 * The real signatures are:
 *
 *   sendMessage(chatId, text, extra)
 *   sendPhoto(chatId, PHOTO, extra)                        caption lives in extra.caption
 *   editMessageText(chatId, messageId, inlineMessageId, TEXT, extra)
 *   editMessageCaption(chatId, messageId, inlineMessageId, CAPTION, extra)
 *
 * So the card — which ships as a photo CAPTION — was never upgraded, while /chains, which
 * replies with text, was. These tests assert the actual payload shape, not that a function
 * was called.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

const { upgradeOutgoing, makeEmojiResolver } = await import('../src/emoji-resolve.mjs');
const { deliverCard } = await import('../src/delivery.mjs');
const { formatCard } = await import('../src/format-card.mjs');
const { CUSTOM_IDS, GLYPHS } = await import('../src/icons.mjs');

const TG = /<tg-emoji emoji-id="(\d+)">([^<]*)<\/tg-emoji>/g;
const idsIn = (t) => [...t.matchAll(TG)].map((m) => m[1]);

/** A telegram object patched exactly as bot.mjs patches the real one. */
function patchedTelegram() {
  const seen = [];
  const obj = {
    sendMessage: async (chatId, text, extra) => {
      seen.push({ m: 'sendMessage', chatId, text, extra });
      return { message_id: 1, text, entities: [] };
    },
    sendPhoto: async (chatId, photo, extra) => {
      seen.push({ m: 'sendPhoto', chatId, photo, extra });
      return { message_id: 2, caption: extra?.caption, caption_entities: [] };
    },
    editMessageText: async (chatId, messageId, inlineMessageId, text, extra) => {
      seen.push({ m: 'editMessageText', chatId, messageId, inlineMessageId, text, extra });
      return { message_id: messageId };
    },
    editMessageCaption: async (chatId, messageId, inlineMessageId, caption, extra) => {
      seen.push({ m: 'editMessageCaption', chatId, messageId, inlineMessageId, caption, extra });
      return { message_id: messageId };
    },
  };

  const up = (v) => (typeof v === 'string' ? upgradeOutgoing(v) : v);
  const wrap = (o, method, apply) => {
    const original = o[method].bind(o);
    o[method] = (...args) => original(...apply(args));
  };
  wrap(obj, 'sendMessage', ([c, t, e, ...r]) => [c, up(t), e, ...r]);
  wrap(obj, 'sendPhoto', ([c, p, e, ...r]) => [c, p, e?.caption ? { ...e, caption: up(e.caption) } : e, ...r]);
  wrap(obj, 'editMessageText', ([c, m, i, t, e, ...r]) => [c, m, i, up(t), e, ...r]);
  wrap(obj, 'editMessageCaption', ([c, m, i, cap, e, ...r]) => [c, m, i, up(cap), e, ...r]);
  return { obj, seen };
}

// ---------------------------------------------------------------------------
// The four signatures
// ---------------------------------------------------------------------------

test('sendPhoto upgrades the CAPTION and leaves the photo untouched', async () => {
  const { obj, seen } = patchedTelegram();
  await obj.sendPhoto(1, 'https://img/x.png', { caption: '📊 <b>MARKET</b>', parse_mode: 'HTML' });
  const call = seen[0];
  assert.equal(call.photo, 'https://img/x.png', 'the media argument must not be replaced');
  assert.match(call.extra.caption, /<tg-emoji emoji-id="\d+">📊<\/tg-emoji>/);
  assert.equal(call.extra.parse_mode, 'HTML', 'other options survive');
});

test('editMessageText upgrades argument 4, not the message id', async () => {
  // The old wrapper ugraded argument 2 — a messageId — which would have corrupted the call if
  // it had ever matched a glyph.
  const { obj, seen } = patchedTelegram();
  await obj.editMessageText(1, 999, undefined, '🛡️ <b>SECURITY</b>', { parse_mode: 'HTML' });
  const call = seen[0];
  assert.equal(call.messageId, 999, 'message id preserved');
  assert.match(call.text, /<tg-emoji emoji-id="\d+">🛡️<\/tg-emoji>/);
});

test('editMessageCaption upgrades argument 4', async () => {
  const { obj, seen } = patchedTelegram();
  await obj.editMessageCaption(1, 999, undefined, '🧠 <b>NARRATIVE</b>', { parse_mode: 'HTML' });
  assert.match(seen[0].caption, /<tg-emoji emoji-id="\d+">🧠<\/tg-emoji>/);
});

test('sendMessage still upgrades argument 2', async () => {
  const { obj, seen } = patchedTelegram();
  await obj.sendMessage(1, '🔗 <b>LINKS</b>', { parse_mode: 'HTML' });
  assert.match(seen[0].text, /<tg-emoji emoji-id="\d+">🔗<\/tg-emoji>/);
});

// ---------------------------------------------------------------------------
// deliverCard — the exact path the Standard card takes
// ---------------------------------------------------------------------------

const CARD_RESULT = {
  status: 'ok',
  token: {
    name: 'TEXEL', symbol: 'TEXEL', chain: 'bsc',
    address: '0x0ddcab9ae04bda0c87ecc1640636fa11e8e613e8',
    priceUsd: 0.0012, mcapUsd: 1_200_000, liquidityUsd: 85_000, priceChange24h: 14.2,
  },
  risk: {
    holders: { total: 4210, top10Percentage: 31.2 },
    tax: { buy: 0, sell: 0 },
  },
  narrative: { summary: 'A project description.' },
  project: { website: 'https://texel.run', x: 'https://x.com/texelrun' },
};

test('the PHOTO card carries custom emoji in its caption', async () => {
  const { text } = formatCard(CARD_RESULT, { view: 'standard' });
  const { obj, seen } = patchedTelegram();
  const out = await deliverCard({ telegram: obj, chatId: 1, text, imageUrl: 'https://img/x.png' });

  assert.equal(out.ok, true);
  assert.equal(out.kind, 'photo', 'the card must actually go out as a photo');
  const caption = seen.find((s) => s.m === 'sendPhoto')?.extra?.caption ?? '';
  const ids = idsIn(caption);
  assert.ok(ids.length >= 5, `expected several custom emoji in the caption, got ${ids.length}`);
  for (const id of ids) assert.match(id, /^\d{15,}$/, `malformed id: ${id}`);
});

test('the TEXT card carries the same emoji when there is no image', async () => {
  const { text } = formatCard(CARD_RESULT, { view: 'standard' });
  const { obj, seen } = patchedTelegram();
  const out = await deliverCard({ telegram: obj, chatId: 1, text, imageUrl: null });

  assert.equal(out.kind, 'text');
  const sent = seen.find((s) => s.m === 'sendMessage')?.text ?? '';
  assert.ok(idsIn(sent).length >= 5, 'text card must match the photo card');
});

test('photo and text cards use the SAME icon mappings', async () => {
  const { text } = formatCard(CARD_RESULT, { view: 'standard' });

  const a = patchedTelegram();
  await deliverCard({ telegram: a.obj, chatId: 1, text, imageUrl: 'https://img/x.png' });
  const photoIds = idsIn(a.seen.find((s) => s.m === 'sendPhoto').extra.caption);

  const b = patchedTelegram();
  await deliverCard({ telegram: b.obj, chatId: 1, text, imageUrl: null });
  const textIds = idsIn(b.seen.find((s) => s.m === 'sendMessage').text);

  assert.deepEqual(photoIds, textIds, 'one semantic mapping for both delivery paths');
});

test('a caption with very long text still keeps its emoji on the fallback', async () => {
  // The photo path falls back to text when the caption exceeds Telegram's limit. The fallback
  // must not lose the icons.
  const base = formatCard(CARD_RESULT, { view: 'standard' }).text;
  const long = `${base}\n<i>${'padding '.repeat(200)}</i>`;
  const { obj, seen } = patchedTelegram();
  const out = await deliverCard({ telegram: obj, chatId: 1, text: long, imageUrl: 'https://img/x.png' });
  assert.equal(out.kind, 'text');
  assert.ok(idsIn(seen.find((s) => s.m === 'sendMessage').text).length >= 5);
});

// ---------------------------------------------------------------------------
// Card icon positions
// ---------------------------------------------------------------------------

test('every card section heading resolves through an explicit role', () => {
  const { text } = formatCard(CARD_RESULT, { view: 'standard' });
  const withIds = idsIn(text);
  const byId = new Map(Object.entries(CUSTOM_IDS).map(([role, e]) => [String(e.id), role]));

  // Roles must SATISFY these; several legitimate roles share one asset (section.market and
  // metric.market are the same chart, section.links and cta.website the same globe), so the
  // reverse map reports whichever was registered first. Assert the ASSET is present.
  const required = ['brand.rocket', 'section.market', 'section.security', 'section.narrative', 'cta.website'];
  const presentIds = new Set(withIds);
  for (const role of required) {
    assert.ok(presentIds.has(String(CUSTOM_IDS[role].id)),
      `card is missing the ${role} asset; got ${[...new Set(withIds.map((i) => byId.get(i)))].join(', ')}`);
  }
});

test('the chain badge on the card is the branded chain asset, not a colour circle', () => {
  const { text } = formatCard(CARD_RESULT, { view: 'standard' });
  const bnb = CUSTOM_IDS['chain.bsc'];
  assert.ok(text.includes(`emoji-id="${bnb.id}"`), 'BNB must use the registry chain asset');
});

test('verdict tones are never upgraded into an exclamation mark', () => {
  // tone.* roles carry no asset on purpose: a severity dot is a colour measurement, and
  // state.warn's artwork is an exclamation. Mixing them made three adjacent verdicts render in
  // two visual languages.
  for (const role of ['tone.good', 'tone.warn', 'tone.bad', 'tone.unknown']) {
    assert.equal(CUSTOM_IDS[role], undefined, `${role} must have no custom asset`);
    assert.ok(GLYPHS[role], `${role} must still have a glyph`);
  }
});

test('a disabled switch yields a readable card with no markup', () => {
  const saved = process.env.CUSTOM_EMOJI;
  try {
    process.env.CUSTOM_EMOJI = '0';
    const { text } = formatCard(CARD_RESULT, { view: 'standard' });
    assert.ok(!text.includes('tg-emoji'), 'no markup when disabled');
    assert.match(text, /MEME CHECKER/, 'content intact');
    assert.match(text, /MARKET/, 'sections intact');
  } finally {
    if (saved === undefined) delete process.env.CUSTOM_EMOJI; else process.env.CUSTOM_EMOJI = saved;
  }
});
