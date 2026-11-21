/**
 * test/emoji-theme-flow.test.mjs
 * Unit tests for emoji-theme helper functions: pack/entity extraction,
 * pending map building, and preview rendering.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  extractCustomEmojiIds,
  detectPackLink,
  buildPendingMap,
  buildEmojiTheme,
  previewTheme,
  noTheme,
  CARD_EMOJI_SLOTS,
} from '../src/emoji-theme.mjs';

// ---- extractCustomEmojiIds --------------------------------------------------

test('extracts custom_emoji IDs from entities', () => {
  const entities = [
    { type: 'custom_emoji', custom_emoji_id: '1111111111111111111' },
    { type: 'bold' },
    { type: 'custom_emoji', custom_emoji_id: '2222222222222222222' },
    { type: 'custom_emoji', custom_emoji_id: '1111111111111111111' }, // duplicate
  ];
  const ids = extractCustomEmojiIds(entities);
  assert.deepEqual(ids, ['1111111111111111111', '2222222222222222222']);
});

test('returns empty array for no custom_emoji entities', () => {
  assert.deepEqual(extractCustomEmojiIds([{ type: 'bold' }]), []);
  assert.deepEqual(extractCustomEmojiIds([]), []);
  assert.deepEqual(extractCustomEmojiIds(null), []);
});

// ---- detectPackLink ---------------------------------------------------------

test('detects https t.me/addemoji link', () => {
  assert.equal(detectPackLink('https://t.me/addemoji/MyCoolPack'), 'MyCoolPack');
});

test('detects bare t.me/addemoji link', () => {
  assert.equal(detectPackLink('Check this out: t.me/addemoji/Pack_Name123'), 'Pack_Name123');
});

test('returns null for non-pack URLs', () => {
  assert.equal(detectPackLink('https://t.me/MemeCheckerBot'), null);
  assert.equal(detectPackLink('hello world'), null);
  assert.equal(detectPackLink(null), null);
});

// ---- buildPendingMap --------------------------------------------------------

test('builds map from sticker objects', () => {
  const stickers = [
    { emoji: '🚀', custom_emoji_id: '1111111111111111111' },
    { emoji: '🪙', custom_emoji_id: '2222222222222222222' },
  ];
  const map = buildPendingMap(stickers);
  assert.equal(map['🚀'], '1111111111111111111');
  assert.equal(map['🪙'], '2222222222222222222');
});

test('skips stickers without custom_emoji_id', () => {
  const stickers = [
    { emoji: '🚀', custom_emoji_id: null },
    { emoji: '🪙', custom_emoji_id: '2222222222222222222' },
  ];
  const map = buildPendingMap(stickers);
  assert.equal(map['🚀'], undefined);
  assert.equal(map['🪙'], '2222222222222222222');
});

test('returns empty object for empty input', () => {
  assert.deepEqual(buildPendingMap([]), {});
  assert.deepEqual(buildPendingMap(null), {});
});

// ---- previewTheme -----------------------------------------------------------

test('previewTheme returns a line for each CARD_EMOJI_SLOTS entry', () => {
  const preview = previewTheme(noTheme);
  const lines = preview.split('\n');
  assert.equal(lines.length, CARD_EMOJI_SLOTS.length);
});

test('previewTheme with custom theme shows tg-emoji for mapped slots', () => {
  const theme = buildEmojiTheme({ '🚀': '5368324170671202286' });
  const preview = previewTheme(theme);
  assert.ok(preview.includes('tg-emoji emoji-id="5368324170671202286"'));
  assert.ok(preview.includes('🪙 → 🪙')); // unmapped slot passes through
});

// ---- CARD_EMOJI_SLOTS -------------------------------------------------------

test('CARD_EMOJI_SLOTS is an array of strings with at least 10 entries', () => {
  assert.ok(Array.isArray(CARD_EMOJI_SLOTS));
  assert.ok(CARD_EMOJI_SLOTS.length >= 10);
  assert.ok(CARD_EMOJI_SLOTS.every(s => typeof s === 'string'));
});
