/**
 * test/phase4a-card-clean.test.mjs
 *
 * Section 4A/C: clean narrative and the locked premium teaser.
 *
 * Two competing requirements: remove technical noise from the card, but do not let a
 * project's claim read as an independently verified fact.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { formatCard, clipWords, narrativeProse } from '../src/format-card.mjs';

const CHAIN = 'solana';
const ADDR = 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263';

function scanWith(narrative, research) {
  const base = {
    status: 'ok',
    chain: CHAIN,
    token: { address: ADDR, name: 'Bonk', symbol: 'BONK', decimals: 5 },
    market: { priceUsd: 0.00002, marketCapUsd: 190_000_000, liquidityUsd: 5_000_000, volume24hUsd: 900_000, priceChange24h: 2.5, dexId: 'raydium' },
    risk: { holders: { total: 700_000, top10Percentage: 22 }, tax: { buy: 0, sell: 0 } },
    narrative,
  };
  // The BOT passes view:'standard'; the library default is 'detailed'. Tests must
  // exercise the user-facing path, not the library default.
  const card = formatCard(base, { research, view: 'standard' });
  return typeof card === 'string' ? card : (card.text ?? '');
}

const LONG = "Bonk is a dog-themed memecoin on the Solana blockchain, launched on Christmas Day 2022 to revitalize the Solana community following the FTX collapse. Created by an anonymous team of 22 Solana developers and builders, Bonk distributed 50% of its total 100 trillion token supply via airdrop to community members including NFT collectors.";

// ---- no technical footer -------------------------------------------------

test('the standard card carries no technical source footer', () => {
  const card = scanWith({ summary: LONG, source: 'Project description (GeckoTerminal)', evidence: 'project-claim' });
  assert.ok(!/Source: .*unverified claim/i.test(card), 'the long source line must be gone');
  assert.ok(!/GeckoTerminal/.test(card), 'the provider name must not appear on the card');
});

test('attribution moves into the prose, so a claim is still a claim', () => {
  const out = narrativeProse({ summary: 'Bonk is a dog-themed memecoin on Solana.', evidence: 'project-claim' });
  assert.match(out, /describes itself/i, 'a self-description must be attributed to the project');
});

test('a third-party description is not passed off as the project speaking', () => {
  const out = narrativeProse({ summary: LONG, evidence: 'reported' });
  assert.match(out, /third-party/i);
});

// ---- length --------------------------------------------------------------

test('prose is trimmed to roughly 25-45 words without cutting mid-sentence', () => {
  const out = clipWords(LONG);
  const n = out.split(' ').length;
  assert.ok(n <= 46, `too long: ${n} words`);
  assert.ok(/[.!?]$/.test(out), 'must end on a sentence boundary, not mid-clause');
});

test('a genuinely short description is kept, not discarded', () => {
  const out = clipWords('A community-driven token for dog lovers everywhere.');
  assert.match(out, /community-driven/);
});

test('stub text too short to mean anything yields no narrative line', () => {
  const card = scanWith({ summary: 'A token.', source: 'x', evidence: 'project-claim' });
  assert.match(card, /No reliable narrative available/i);
});

test('no narrative at all says so plainly', () => {
  const card = scanWith(null, null);
  assert.match(card, /No reliable narrative available/i);
});

// ---- locked premium teaser ----------------------------------------------

test('an ordinary card shows the locked teaser, not technical status text', () => {
  const card = scanWith({ summary: LONG, source: 'gt', evidence: 'project-claim' }, { premiumTeaser: true });
  assert.match(card, /KOL Activity: •••••• \(Locked\)/);
  assert.match(card, /X & KOL INTELLIGENCE/i);
  assert.ok(!/No X research cached/i.test(card), 'technical status text must be gone');
  assert.ok(!/No public X posts matched/i.test(card));
});

test('the teaser makes no claim about actual KOL results', () => {
  const card = scanWith({ summary: LONG, source: 'gt', evidence: 'project-claim' }, { premiumTeaser: true });
  // No fabricated names, counts or returns may accompany the lock.
  assert.ok(!/@\w+/.test(card.slice(card.indexOf('X & KOL'))), 'no account names in the teaser');
  assert.ok(!/\d+\s*(calls?|posts?|accounts?)/i.test(card.slice(card.indexOf('X & KOL'))), 'no counts in the teaser');
});

test('a configured premium URL becomes a link; an absent one stays plain text', () => {
  const withUrl = scanWith({ summary: LONG, source: 'gt', evidence: 'project-claim' },
    { premiumTeaser: true, premiumUrl: 'https://example.com/premium' });
  assert.match(withUrl, /href="https:\/\/example\.com\/premium"/);

  const withoutUrl = scanWith({ summary: LONG, source: 'gt', evidence: 'project-claim' },
    { premiumTeaser: true, premiumUrl: null });
  assert.ok(!/href="[^"]*premium/i.test(withoutUrl), 'no invented destination');
  assert.match(withoutUrl, /Meme Checker Premium/);
});
