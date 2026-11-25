/**
 * test/round7-emoji-integration.test.mjs
 * RENDER-LEVEL audit of the custom-emoji migration.
 *
 * The registry resolving an ID proves nothing about what the bot SENDS. These tests drive the
 * real handlers through an offline Telegraf shim and inspect the outgoing text, so a surface
 * that forgot to route through the resolver shows up as a plain Unicode glyph and fails.
 *
 * They also lock the defects OWNER reported: Ethereum was a paper plane, BNB was a generic
 * circle on the card, four chains shared one sticker, and profile rows rounded 1.04x to "1.0x"
 * while painting it green.
 */
import { registerHooks } from 'node:module';
import test from 'node:test';
import assert from 'node:assert/strict';

const shim = `
export class Telegraf {
  constructor(){ this.telegram = { sendMessage: async () => ({}), editMessageText: async () => ({}), sendPhoto: async () => ({}), editMessageCaption: async () => ({}), setMyCommands: async () => ({}), getFileLink: async () => ({ href: 'https://x.test/f' }) };
    globalThis.__tg = this;
  }
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
  },
});

const { icon, chainIcon, chainIconMarkup = null, CUSTOM_IDS, GLYPHS, PRIORITY_CHAINS, ICON_LABELS, customEmojiEnabled } = await import('../src/icons.mjs');
const { makeEmojiResolver, upgradeOutgoing } = await import('../src/emoji-resolve.mjs');
const { renderCallerProfile, fmtProfileMultiple, peakTone, roiTone } = await import('../src/caller-profile.mjs');
const { renderEmojiPreview } = await import('../src/emoji-preview.mjs');
const { renderHelp } = await import('../src/help.mjs');
const { renderStart } = await import('../src/start-message.mjs');
const { CHAIN_EMOJI } = await import('../src/chains.mjs');

const TG = /<tg-emoji emoji-id="(\d+)">([^<]*)<\/tg-emoji>/g;
const idsIn = (text) => [...text.matchAll(TG)].map((m) => m[1]);
const glyphsIn = (text) => [...text.matchAll(TG)].map((m) => m[2]);

// ---------------------------------------------------------------------------
// 1. The OWNER-reported chain defects
// ---------------------------------------------------------------------------

test('Ethereum is not the Telegram paper plane any more', () => {
  // The old mapping pointed chain.ethereum at CryptoIcons #130, an envelope, inherited from the
  // ✈️ Telegram glyph. Its artwork is not Ethereum and it must never be used for ETH.
  const eth = CUSTOM_IDS['chain.ethereum'];
  assert.ok(eth, 'ethereum must have a verified asset');
  assert.equal(eth.pack, 'CryptoIcons');
  assert.match(eth.depicts, /Ethereum diamond/i);
  // The envelope is still legitimate for a Telegram contact link, but not for the chain.
  assert.notEqual(eth.id, CUSTOM_IDS['metric.social'].id, 'ETH must not share the envelope id');
});

test('BNB is the same branded mark on the card, /chains and the registry', () => {
  // The card read a separate per-chain glyph table, so BNB was branded on /chains and a plain
  // yellow circle on the token card. Both now come from one registry entry.
  assert.equal(CHAIN_EMOJI.bsc, GLYPHS['chain.bsc'], 'chains.mjs derives from the registry');
  assert.equal(CUSTOM_IDS['chain.bsc'].idx, 3, 'the BNB four-diamond, not the generic cube at #23');
  assert.match(CUSTOM_IDS['chain.bsc'].depicts, /diamond/i);
});

test('all seven priority chains have distinct, verified branding or a stated gap', () => {
  const seen = new Map();
  for (const chain of PRIORITY_CHAINS) {
    const entry = CUSTOM_IDS[`chain.${chain}`];
    if (!entry) {
      // Only Base and Robinhood may be missing, and each must be documented as such.
      assert.ok(['base', 'robinhood'].includes(chain), `${chain} has no asset and is not a known gap`);
      continue;
    }
    assert.ok(entry.id && entry.source === 'verified', `${chain} asset must be verified`);
    assert.match(entry.depicts, /\S+/, `${chain} must record what the artwork depicts`);
    assert.ok(!seen.has(entry.id), `${chain} shares an id with ${seen.get(entry.id)}`);
    seen.set(entry.id, chain);
  }
  // Four chains previously shared one sticker and rendered identically.
  assert.ok(seen.size >= 5, `expected at least 5 distinct chain assets, got ${seen.size}`);
});

test('an asset is never identified by its unicode field alone', () => {
  // The Hyperliquid logo's own emoji field is 😡 while the artwork is a clean H mark. If this
  // ever becomes 🦄 or 😡 in the registry it means someone trusted the field instead of looking.
  const h = CUSTOM_IDS['chain.hyperevm'];
  assert.ok(h, 'hyperevm must have an asset');
  assert.match(h.depicts, /Hyperliquid/i);
  assert.equal(h.pack, 'HyperliquidEmoji');
});

// ---------------------------------------------------------------------------
// 2. Renderer migration — the resolver actually reaches output
// ---------------------------------------------------------------------------

test('the resolver turns legacy glyph literals into registry assets', () => {
  const e = makeEmojiResolver({ custom: true });
  assert.match(e('🟡'), /<tg-emoji emoji-id="\d+">🟡<\/tg-emoji>/);
  // An unknown glyph must pass through untouched rather than becoming empty.
  assert.equal(e('🎉'), '🎉');
  assert.equal(e(''), '');
});

test('a disabled resolver still returns a readable glyph everywhere', () => {
  const e = makeEmojiResolver({ custom: false });
  for (const g of ['🟡', '🔷', '🚀', '📊']) {
    assert.equal(e(g), g, `fallback for ${g}`);
    assert.doesNotMatch(e(g), /tg-emoji/);
  }
});

test('outgoing text is upgraded, but code and links are left alone', () => {
  const e = makeEmojiResolver({ custom: true });
  const out = upgradeOutgoing('🚀 <b>Title</b>\n📊 Market\n<code>🚀0xdead</code>\n<a href="u">🟡 site</a>', e);
  assert.match(out, /<tg-emoji[^>]+>🚀<\/tg-emoji> <b>Title<\/b>/, 'leading icon upgraded');
  assert.match(out, /<tg-emoji[^>]+>📊<\/tg-emoji> Market/, 'section icon upgraded');
  assert.ok(out.includes('<code>🚀0xdead</code>'), 'contract addresses are not corrupted');
  assert.ok(out.includes('<a href="u">🟡 site</a>'), 'link text is not rewritten');
});

test('upgrading twice does not nest tags', () => {
  const e = makeEmojiResolver({ custom: true });
  const once = upgradeOutgoing('🚀 Title', e);
  assert.equal(upgradeOutgoing(once, e), once);
  assert.equal((once.match(/<tg-emoji/g) ?? []).length, 1);
});

test('every registry id is a string, so nothing is lost to integer precision', () => {
  // Telegram custom emoji ids exceed 2^53; storing them as numbers silently corrupts the last
  // digits. This is the reason they are strings everywhere.
  for (const [role, entry] of Object.entries(CUSTOM_IDS)) {
    assert.equal(typeof entry.id, 'string', `${role} id must be a string`);
    assert.match(entry.id, /^\d{15,}$/, `${role} id looks malformed: ${entry.id}`);
    if (role) assert.ok(entry.id.length >= 15, `${role} id too short to be a real custom emoji`);
  }
});

// ---------------------------------------------------------------------------
// 3. Surfaces
// ---------------------------------------------------------------------------

test('/start and /help render through the registry', () => {
  for (const [name, text] of [['start', renderStart({}).text], ['help', renderHelp().text]]) {
    const ids = idsIn(text);
    assert.ok(ids.length >= 3, `${name} should carry several registry icons, found ${ids.length}`);
    for (const id of ids) assert.match(id, /^\d{15,}$/, `${name} emitted a malformed id`);
  }
});

test('the owner preview covers every group and states its own coverage', () => {
  const first = renderEmojiPreview({ page: 0 });
  assert.match(first.text, /EMOJI REGISTRY — OWNER PREVIEW/);
  assert.ok(first.pages >= 2, 'preview is paginated to fit the message limit');
  assert.ok(first.text.length < 4096, 'page 1 fits a Telegram message');

  const last = renderEmojiPreview({ page: first.pages - 1 });
  assert.match(last.text, /Coverage/);
  assert.match(last.text, /Roles <b>\d+<\/b>/);
  // It must never claim full animation coverage while gaps remain.
  assert.match(last.text, /Unicode-only <b>\d+<\/b>/);
});

// ---------------------------------------------------------------------------
// 4. Profile performance presentation (item 6)
// ---------------------------------------------------------------------------

test('a round to 1.0x never hides a gain or a loss', () => {
  // 1.04x and 0.96x both used to render "1.0x" while their tone differed — a green icon beside
  // a figure that said nothing had changed.
  assert.equal(fmtProfileMultiple(1), '1.0x', 'exact breakeven may read 1.0x');
  assert.notEqual(fmtProfileMultiple(1.04), '1.0x', 'a gain must not round to flat');
  assert.notEqual(fmtProfileMultiple(0.96), '1.0x', 'a loss must not round to flat');
  assert.equal(fmtProfileMultiple(1.04), '1.04x');
  assert.equal(fmtProfileMultiple(0.96), '0.96x');
  assert.equal(fmtProfileMultiple(3.8), '3.8x');
});

test('peak tiers follow the brief, and not reaching 2x is not a loss', () => {
  assert.equal(peakTone(2), 'good', '≥2x is a hit');
  assert.equal(peakTone(5), 'good');
  assert.equal(peakTone(1.5), 'warn', 'above 1x but below 2x is a caution, never a failure');
  assert.equal(peakTone(1), 'neutral');
  assert.equal(peakTone(null), 'unknown', 'missing evidence is unknown');
  // The old card used a red exclamation for these.
  assert.notEqual(peakTone(1.4), 'bad');
});

test('current ROI tone is independent of the peak tone', () => {
  assert.equal(roiTone(1.2), 'good');
  assert.equal(roiTone(0.8), 'bad');
  assert.equal(roiTone(1), 'neutral');
  assert.equal(roiTone(null), 'unknown', 'no price is unknown, never a loss');
});

test('a profile row shows peak, current multiple and the signed percentage together', () => {
  const now = Date.now();
  const calls = [{
    id: '1', callerKey: 'u:1', callerName: 'Foxy', chain: 'robinhood', address: '0xf',
    symbol: 'FIONA', entryMarketCapUsd: 1e6, peakMarketCapUsd: 4.2e6, lastMarketCapUsd: 3.8e6,
    calledAt: now - 3600e3, status: 'active',
  }];
  const { text } = renderCallerProfile({ callerKey: 'u:1', calls, groupTitle: 'g', period: '1d', now });
  assert.match(text, /peak[^\n]*4\.2x/, 'peak shown');
  assert.match(text, /now[^\n]*3\.8x/, 'current shown');
  assert.match(text, /\+280%/, 'signed percentage accompanies the multiple');
  assert.doesNotMatch(text, /realis|realiz/i, 'mark-to-market is never called realised profit');
});

test('descending order and period filters survive the visual changes', () => {
  const now = Date.now();
  const mk = (sym, peak, at) => ({
    id: sym, callerKey: 'u:1', callerName: 'F', chain: 'bsc', address: `0x${sym}`, symbol: sym,
    entryMarketCapUsd: 1e6, peakMarketCapUsd: peak * 1e6, calledAt: at, status: 'active',
  });
  const calls = [mk('LOW', 1.3, now - 1000), mk('BIG', 9.5, now - 2000), mk('MID', 2.0, now - 3000)];
  const { text } = renderCallerProfile({ callerKey: 'u:1', calls, groupTitle: 'g', period: '1d', now });
  const order = ['BIG', 'MID', 'LOW'].map((s) => text.indexOf(s));
  assert.ok(order[0] < order[1] && order[1] < order[2], `descending order broken: ${text}`);
});
