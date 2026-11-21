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
  fullAnalysisUrl: 'https://meme-checker.example/check/solana/FiXtUrE111111111111111111111111111111111111',
  updatedAt: '2026-11-21T00:00:00Z',
};

const BSC_NULL_MCAP = {
  mode: 'mock', status: 'ok',
  token: { chain: 'bsc', address: '0xabcdef0123456789abcdef0123456789abcdef01', name: 'BNB Token', symbol: 'BTOKEN' },
  market: { priceUsd: 0.0002, marketCapUsd: null, fdvUsd: 1500000, liquidityUsd: null, volume24hUsd: 0, priceChange24h: null },
  holders: null,
  narrative: null,
  project: null,
  fullAnalysisUrl: 'https://meme-checker.example/check/bsc/0xabcdef0123456789abcdef0123456789abcdef01',
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

test('holders section omitted when null', () => {
  const { text } = formatCard(BSC_NULL_MCAP);
  assert.ok(!text.includes('HOLDER OVERVIEW'));
});

test('narrative omitted when null', () => {
  const { text } = formatCard(SOL_OK);
  assert.ok(!text.includes('NARRATIVE'));
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

test('Full Analysis button built from websiteBase when fullAnalysisUrl absent', () => {
  const noUrl = { ...SOL_OK, fullAnalysisUrl: null };
  const { buttons } = formatCard(noUrl, { websiteBase: 'https://test.example' });
  const flat = buttons.flat();
  assert.ok(flat.some(b => b.text.includes('Full Analysis') && b.url.includes('test.example')));
});

test('UTM params appended when websiteBase present', () => {
  const noUrl = { ...SOL_OK, fullAnalysisUrl: null };
  const { buttons } = formatCard(noUrl, { websiteBase: 'https://test.example' });
  const flat = buttons.flat();
  const btn = flat.find(b => b.text.includes('Full Analysis'));
  assert.ok(btn?.url.includes('utm_source=telegram'));
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

test('XSS characters in token name are escaped', () => {
  const evil = { ...SOL_OK, token: { ...SOL_OK.token, name: '<script>alert(1)</script>', symbol: 'EVIL' } };
  const { text } = formatCard(evil);
  assert.ok(!text.includes('<script>'));
  assert.ok(text.includes('&lt;script&gt;'));
});
