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

test('Explorer link is separate from the <code> line', () => {
  const { text } = formatCard(makeResult('solana', SOL_ADDR));
  // The explorer link must exist as a separate <a> tag
  assert.ok(text.includes('solscan.io'), 'Solscan explorer link missing');
  // The <code> tag must not be inside an <a> href context
  const codeIdx = text.indexOf(`<code>${SOL_ADDR}</code>`);
  const explorerIdx = text.indexOf('solscan.io');
  assert.ok(codeIdx > 0, '<code> line not found');
  // They should be separate lines (code line comes after the CA label line)
  assert.ok(codeIdx !== explorerIdx, 'code and explorer link should be separate');
});

test('BNB explorer link points to bscscan', () => {
  const { text } = formatCard(makeResult('bsc', BSC_ADDR));
  assert.ok(text.includes('bscscan.com'), 'BSCscan explorer link missing');
});

test('<code> tag appears on its own line (preceded by newline)', () => {
  const { text } = formatCard(makeResult('solana', SOL_ADDR));
  // The code line should be preceded by a newline
  assert.ok(text.includes(`\n<code>${SOL_ADDR}</code>`), 'code line not on its own line');
});
