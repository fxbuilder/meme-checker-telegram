/**
 * test/format-card.test.mjs
 * Unit tests for the result card formatter.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { formatCard } from '../src/format-card.mjs';

const SOL_OK = {
  mode: 'mock', status: 'ok',
  token: { chain: 'solana', address: 'FiXtUrE111111111111111111111111111111111111', name: 'Mock Token', symbol: 'MOCK' },
  market: { priceUsd: 0.000123, marketCapUsd: 1250000, fdvUsd: 1500000, liquidityUsd: 85400, volume24hUsd: 320000, priceChange24h: 18.5 },
  holders: { total: 2450, top10Percentage: 24.6, largestHolderPercentage: 5.2 },
  narrative: null,
  project: { website: null, x: null, telegram: null },
  fullAnalysisUrl: 'https://app.memechecker.io/check/solana/FiXtUrE111111111111111111111111111111111111',
  updatedAt: '2026-11-21T00:00:00Z',
};

const BSC_NULL_MCAP = {
  mode: 'mock', status: 'ok',
  token: { chain: 'bsc', address: '0xabcdef0123456789abcdef0123456789abcdef01', name: 'BNB Token', symbol: 'BTOKEN' },
  market: { priceUsd: 0.0002, marketCapUsd: null, fdvUsd: 1500000, liquidityUsd: null, volume24hUsd: 0, priceChange24h: null },
  holders: null,
  narrative: null,
  project: null,
  fullAnalysisUrl: null,
  updatedAt: null,
};

test('card contains token name and symbol', () => {
  const { text } = formatCard(SOL_OK);
  assert.ok(text.includes('Mock Token'));
  assert.ok(text.includes('$MOCK'));
});

test('card contains chain label', () => {
  const { text } = formatCard(SOL_OK);
  assert.ok(text.includes('Solana'));
});

test('mock label is shown when mockLabel=true', () => {
  const { text } = formatCard(SOL_OK, { mockLabel: true });
  assert.ok(text.toLowerCase().includes('mock'));
});

test('market data is formatted', () => {
  const { text } = formatCard(SOL_OK);
  assert.ok(text.includes('1.25M'));   // market cap
  assert.ok(text.includes('+18.50%')); // price change
});

test('FDV is shown only when different from market cap', () => {
  const { text } = formatCard(SOL_OK);
  assert.ok(text.includes('1.50M'));   // FDV shown (different from 1.25M)
});

test('null market cap is not replaced by FDV', () => {
  const { text } = formatCard(BSC_NULL_MCAP);
  assert.ok(!text.includes('Market Cap: $1'));  // mcap is null, should not appear as Market Cap
  assert.ok(text.includes('1.50M'));           // FDV still shown under its own label
});

test('holders section shown when present', () => {
  const { text } = formatCard(SOL_OK);
  assert.ok(text.includes('2,450'));
  assert.ok(text.includes('24.6%'));
});

test('holders section heading always present; unavailable note when null', () => {
  const { text } = formatCard(BSC_NULL_MCAP);
  assert.ok(text.includes('HOLDER OVERVIEW'));
  assert.ok(text.includes('unavailable'));
});

test('narrative section heading always present; unavailable note when null', () => {
  const { text } = formatCard(SOL_OK);
  assert.ok(text.includes('NARRATIVE'));
  assert.ok(text.includes('unavailable'));
});

test('project info section heading always present', () => {
  const { text } = formatCard(SOL_OK);
  assert.ok(text.includes('PROJECT INFO'));
});

test('WANT TO DYOR DEEPER section present with all brief bullets', () => {
  const { text } = formatCard(SOL_OK);
  assert.ok(text.includes('WANT TO DYOR DEEPER'));
  assert.ok(text.includes('Advanced Narrative'));
  assert.ok(text.includes('Dev Wallet Investigation'));
  assert.ok(text.includes('Bundle Wallet Analysis'));
  assert.ok(text.includes('Bubble Map'));
  assert.ok(text.includes('KOL Call History'));
  assert.ok(text.includes('Smart Money Insights'));
  assert.ok(text.includes('FULL TOKEN ANALYSIS'));
});

test('narrative shown when source is present', () => {
  const withNarrative = {
    ...SOL_OK,
    narrative: { summary: 'A dog-themed token on Solana.', source: 'project_metadata' },
  };
  const { text } = formatCard(withNarrative);
  assert.ok(text.includes('NARRATIVE'));
  assert.ok(text.includes('dog-themed'));
});

test('Full Analysis button is built from fullAnalysisUrl', () => {
  const { buttons } = formatCard(SOL_OK);
  const flat = buttons.flat();
  assert.ok(flat.some(b => b.text.includes('Full Analysis') && b.url.includes('solana')));
});

test('Full Analysis button is omitted when fullAnalysisUrl is null (no synthesized link)', () => {
  const noUrl = { ...SOL_OK, fullAnalysisUrl: null };
  const { buttons } = formatCard(noUrl, { websiteBase: 'https://test.example' });
  const flat = buttons.flat();
  assert.equal(flat.find(b => b.text.includes('Full Analysis')), undefined);
});

test('error card for not-found status', () => {
  const { text, buttons } = formatCard({ mode: 'mock', status: 'not-found' });
  assert.ok(text.includes('Token Not Found'));
  assert.equal(buttons.length, 0);
});

test('error card for api-error status', () => {
  const { text } = formatCard({ mode: 'mock', status: 'api-error' });
  assert.ok(text.includes('Unable to fetch data'));
});

test('[mock] label shown on not-found error card when mockLabel=true', () => {
  const { text } = formatCard({ mode: 'mock', status: 'not-found' }, { mockLabel: true });
  assert.ok(text.includes('[mock]'));
});

test('[mock] label shown on invalid-response error card when mockLabel=true', () => {
  const { text } = formatCard({ mode: 'mock', status: 'invalid-response' }, { mockLabel: true });
  assert.ok(text.includes('[mock]'));
});

test('XSS characters in token name are escaped', () => {
  const evil = { ...SOL_OK, token: { ...SOL_OK.token, name: '<script>alert(1)</script>', symbol: 'EVIL' } };
  const { text } = formatCard(evil);
  assert.ok(!text.includes('<script>'));
  assert.ok(text.includes('&lt;script&gt;'));
});

test('placeholder .example fullAnalysisUrl is rejected — no View Full Analysis button', () => {
  const withPlaceholder = { ...SOL_OK, fullAnalysisUrl: 'https://meme-checker.example/check/solana/ADDR' };
  const flat = formatCard(withPlaceholder).buttons.flat();
  assert.equal(flat.find(b => b.text.includes('View Full Analysis')), undefined);
});

test('credentialed fullAnalysisUrl is rejected', () => {
  const withCreds = { ...SOL_OK, fullAnalysisUrl: 'https://user:pass@legit.com/check/solana/ADDR' };
  const flat = formatCard(withCreds).buttons.flat();
  assert.equal(flat.find(b => b.text.includes('View Full Analysis')), undefined);
});

test('http (non-https) fullAnalysisUrl is rejected', () => {
  const withHttp = { ...SOL_OK, fullAnalysisUrl: 'http://legit.com/check/solana/ADDR' };
  const flat = formatCard(withHttp).buttons.flat();
  assert.equal(flat.find(b => b.text.includes('View Full Analysis')), undefined);
});

test('valid https fullAnalysisUrl is accepted', () => {
  const withReal = { ...SOL_OK, fullAnalysisUrl: 'https://app.memechecker.io/check/solana/FiXtUrE111111111111111111111111111111111111' };
  const flat = formatCard(withReal).buttons.flat();
  assert.ok(flat.some(b => b.text.includes('View Full Analysis') && b.url.includes('memechecker.io')));
});

// ---- §9 button order --------------------------------------------------------

test('§9 Row 1 is Full Analysis when fullAnalysisUrl set', () => {
  const { buttons } = formatCard(SOL_OK, {
    websiteBase: 'https://app.memechecker.io',
    premiumUrl:  'https://app.memechecker.io/pricing',
    botUsername: 'MemeCheckerBot',
  });
  assert.equal(buttons.length, 3);
  assert.ok(buttons[0][0].text.includes('Full Analysis'));
});

test('§9 Row 2 has Premium then Explore when both configured', () => {
  const { buttons } = formatCard(SOL_OK, {
    websiteBase: 'https://app.memechecker.io',
    premiumUrl:  'https://app.memechecker.io/pricing',
  });
  const row2 = buttons[1];
  assert.ok(row2[0].text.includes('Premium'));
  assert.ok(row2[1].text.includes('Explore'));
});

test('§9 Row 3 is Add Bot to Group when botUsername set', () => {
  const { buttons } = formatCard(SOL_OK, {
    websiteBase: 'https://app.memechecker.io',
    botUsername: 'MemeCheckerBot',
  });
  const last = buttons[buttons.length - 1];
  assert.ok(last[0].text.includes('Add'));
  assert.ok(last[0].url.includes('t.me/MemeCheckerBot'));
});

test('§9 Row 3 omitted when no botUsername or addBotUrl', () => {
  const { buttons } = formatCard(SOL_OK, { websiteBase: 'https://app.memechecker.io' });
  const flat = buttons.flat();
  assert.equal(flat.find(b => b.text.includes('Add')), undefined);
});

test('Premium button uses dedicated premiumUrl, not websiteBase/pricing', () => {
  const { buttons } = formatCard(SOL_OK, {
    websiteBase: 'https://app.memechecker.io',
    premiumUrl:  'https://premium.memechecker.io/vip',
  });
  const flat = buttons.flat();
  const btn = flat.find(b => b.text.includes('Premium'));
  assert.ok(btn?.url.startsWith('https://premium.memechecker.io/vip'));
  assert.ok(!btn?.url.includes('/pricing'));
});

test('Premium button omitted when premiumUrl is empty and websiteBase alone is set', () => {
  // premiumUrl independent of websiteBase — no auto-derivation
  const { buttons } = formatCard(SOL_OK, {
    websiteBase: 'https://app.memechecker.io',
    premiumUrl:  '',
  });
  const flat = buttons.flat();
  assert.equal(flat.find(b => b.text.includes('Premium')), undefined);
});

// ---- Emoji theme ------------------------------------------------------------

test('standard emoji used by default (no theme)', () => {
  const { text } = formatCard(SOL_OK);
  assert.ok(text.includes('🚀'));
  assert.ok(!text.includes('tg-emoji'));
});

test('custom emoji theme wraps standard emoji in tg-emoji tags', async () => {
  const { buildEmojiTheme } = await import('../src/emoji-theme.mjs');
  const theme = buildEmojiTheme({ '🚀': '5368324170671202286' });
  const { text } = formatCard(SOL_OK, { emojiTheme: theme });
  assert.ok(text.includes('<tg-emoji emoji-id="5368324170671202286">🚀</tg-emoji>'));
  // Unmapped emoji still renders as standard
  assert.ok(text.includes('🪙'));
  assert.ok(!text.match(/tg-emoji emoji-id.*🪙/));
});

test('invalid emoji theme falls back to standard emoji', async () => {
  const { buildEmojiTheme } = await import('../src/emoji-theme.mjs');
  const theme = buildEmojiTheme({ '🚀': 'not-a-number' }); // invalid id
  assert.equal(theme, (await import('../src/emoji-theme.mjs')).noTheme);
});

test('emoji theme with no entries falls back to noTheme', async () => {
  const { buildEmojiTheme, noTheme } = await import('../src/emoji-theme.mjs');
  assert.equal(buildEmojiTheme({}), noTheme);
  assert.equal(buildEmojiTheme(null), noTheme);
});
