/**
 * test/copyable-ca.test.mjs
 * Targeted checks: full CA on its own <code> line for both chains.
 * Verifies exact address and casing preserved; explorer link kept separate.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { formatCard } from '../src/format-card.mjs';

const SOL_ADDR = 'FiXtUrE111111111111111111111111111111111111';
const BSC_ADDR = '0xabcdef0123456789abcdef0123456789abcdef01';

function makeResult(chain, address) {
  return {
    mode: 'mock', status: 'ok',
    token: { chain, address, name: 'Test', symbol: 'TEST' },
    market: { priceUsd: 0.001, marketCapUsd: null, fdvUsd: null, liquidityUsd: null, volume24hUsd: null, priceChange24h: null },
    holders: null, narrative: null, project: null,
    fullAnalysisUrl: null, updatedAt: null,
  };
}

test('Solana card has full address in <code> tag on its own line', () => {
  const { text } = formatCard(makeResult('solana', SOL_ADDR));
  // Must contain the exact full address in a code tag
  assert.ok(text.includes(`<code>${SOL_ADDR}</code>`), 'full Solana address not in <code> tag');
});

test('BNB card has full lowercase address in <code> tag', () => {
  const { text } = formatCard(makeResult('bsc', BSC_ADDR));
  assert.ok(text.includes(`<code>${BSC_ADDR}</code>`), 'full BNB address not in <code> tag');
});

test('Solana address is case-preserved (not lowercased)', () => {
  const { text } = formatCard(makeResult('solana', SOL_ADDR));
  // Confirm the mixed-case address appears exactly, not lowercased
  assert.ok(text.includes('FiXtUrE'), 'Solana address case not preserved');
});

test('No explorer link on the card (removed per spec)', () => {
  const { text } = formatCard(makeResult('solana', SOL_ADDR));
  assert.ok(!text.includes('solscan.io'), 'Solscan explorer link should be removed');
  assert.ok(!text.includes('Explorer'), 'Explorer link text should be removed');
});

test('No shortened address on the card (full CA only)', () => {
  const { text } = formatCard(makeResult('solana', SOL_ADDR));
  assert.ok(!text.includes('FiXt...'), 'shortened Solana address should be removed');
  const bsc = formatCard(makeResult('bsc', BSC_ADDR)).text;
  assert.ok(!bsc.includes('bscscan.com'), 'BSCscan explorer link should be removed');
  assert.ok(!bsc.includes('0xabcd...'), 'shortened BNB address should be removed');
});

test('<code> tag appears on its own line (preceded by newline)', () => {
  const { text } = formatCard(makeResult('solana', SOL_ADDR));
  // The code line should be preceded by a newline
  assert.ok(text.includes(`\n<code>${SOL_ADDR}</code>`), 'code line not on its own line');
});
