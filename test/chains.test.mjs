/**
 * test/chains.test.mjs
 * Chain registry + multi-chain detection.
 * The capability flags are claims about data availability, so the shape and the
 * EVM-ambiguity rules are tested rather than assumed.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  CHAINS, ALL_CHAIN_IDS, SCANNABLE_CHAINS, getChain, resolveChainAlias,
  detectKind, capabilitySummary, ADDRESS_KIND,
} from '../src/chains.mjs';
import { detectAll, detectCandidates, parseChainHint, EVM_SCANNABLE, isValidForChain } from '../src/detect-ca.mjs';

const SOL = 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263';
const EVM = '0x0E09FaBB73Bd3Ade0a17ECC321fD13a19e81cE82';

test('all 16 requested chains are registered', () => {
  const wanted = ['solana', 'ethereum', 'bsc', 'base', 'arbitrum', 'optimism', 'polygon',
    'avalanche', 'hyperevm', 'monad', 'robinhood', 'unichain', 'berachain', 'abstract',
    'story', 'megaeth'];
  for (const id of wanted) {
    assert.ok(CHAINS[id], `missing chain: ${id}`);
  }
  assert.equal(ALL_CHAIN_IDS.length, wanted.length);
});

test('story is registered but not market-scannable (verified zero coverage)', () => {
  const story = getChain('story');
  assert.equal(story.market, false);
  assert.ok(!SCANNABLE_CHAINS.includes('story'));
  // The other 15 must be scannable.
  assert.equal(SCANNABLE_CHAINS.length, 15);
});

test('every scannable chain has a DexScreener slug and an address kind', () => {
  for (const id of SCANNABLE_CHAINS) {
    const c = CHAINS[id];
    assert.ok(c.ds, `${id} missing ds slug`);
    assert.ok(['solana', 'evm'].includes(c.kind), `${id} has bad kind`);
    assert.ok(c.name && c.short && c.emoji, `${id} missing display fields`);
  }
});

test('GoPlus coverage matches the live supported-chains list', () => {
  // Verified against GET /api/v1/supported_chains (46 chains). Monad, Robinhood,
  // Unichain, Berachain and Abstract were previously marked null in this registry,
  // which made their security fields render "n/a" and made the chains look unsupported.
  const withGoplus = ALL_CHAIN_IDS.filter((id) => CHAINS[id].goplus);
  assert.deepEqual(withGoplus.sort(), [
    'abstract', 'arbitrum', 'avalanche', 'base', 'berachain', 'bsc',
    'ethereum', 'monad', 'optimism', 'polygon', 'robinhood', 'solana', 'unichain',
  ].sort());

  // Every goplus:'evm' chain must carry a chain id.
  for (const id of ALL_CHAIN_IDS) {
    if (CHAINS[id].goplus === 'evm') assert.ok(CHAINS[id].goplusId, `${id} needs goplusId`);
  }

  // These are genuinely absent from GoPlus and must stay null rather than guessed.
  for (const id of ['hyperevm', 'megaeth', 'story']) {
    assert.equal(CHAINS[id].goplus, null, `${id} has no GoPlus coverage`);
  }
});

test('dexPaid is only enabled where orders/v1 was proven indexed', () => {
  const withPaid = ALL_CHAIN_IDS.filter((id) => CHAINS[id].dexPaid);
  assert.deepEqual(withPaid.sort(),
    ['base', 'berachain', 'bsc', 'ethereum', 'optimism', 'robinhood', 'solana'].sort());
  // A chain with no proven indexing must not claim paid status at all.
  for (const id of ['arbitrum', 'polygon', 'avalanche', 'hyperevm', 'monad', 'unichain', 'abstract', 'megaeth', 'story']) {
    assert.equal(CHAINS[id].dexPaid, false, `${id} must not claim dexPaid`);
  }
});

test('chain aliases resolve for user input', () => {
  assert.equal(resolveChainAlias('sol'), 'solana');
  assert.equal(resolveChainAlias('BNB'), 'bsc');
  assert.equal(resolveChainAlias('Arb'), 'arbitrum');
  assert.equal(resolveChainAlias('OP'), 'optimism');
  assert.equal(resolveChainAlias('hyper'), 'hyperevm');
  assert.equal(resolveChainAlias('bera'), 'berachain');
  assert.equal(resolveChainAlias('mega'), 'megaeth');
  assert.equal(resolveChainAlias('nonsense'), null);
});

test('detectKind separates solana and evm shapes', () => {
  assert.equal(detectKind(SOL), 'solana');
  assert.equal(detectKind(EVM), 'evm');
  assert.equal(detectKind('nope'), null);
  assert.equal(ADDRESS_KIND.solana.test(SOL), true);
});

test('a bare EVM address is ambiguous across EVM chains', () => {
  const det = detectAll(EVM);
  assert.equal(det.kind, 'evm');
  assert.equal(det.ambiguous, true, 'must flag ambiguity rather than silently pick a chain');
  assert.equal(det.candidates.length, 1);
  assert.equal(det.candidates[0].chain, 'bsc', 'falls back to the default chain');
  assert.equal(EVM_SCANNABLE.length, 14, 'all EVM scannable chains are offered');
  assert.ok(!EVM_SCANNABLE.includes('story'), 'story is not scannable');
});

test('a chain hint resolves EVM ambiguity', () => {
  const det = detectAll(EVM, { chainHint: 'base' });
  assert.equal(det.ambiguous, false);
  assert.equal(det.candidates[0].chain, 'base');
});

test('a group default chain is honoured', () => {
  const det = detectAll(EVM, { defaultEvmChain: 'polygon' });
  assert.equal(det.candidates[0].chain, 'polygon');
});

test('a Solana address is never ambiguous', () => {
  const det = detectAll(SOL);
  assert.equal(det.kind, 'solana');
  assert.equal(det.ambiguous, false);
  assert.equal(det.candidates[0].chain, 'solana');
  assert.equal(det.candidates[0].address, SOL, 'case preserved');
});

test('parseChainHint understands "/check base 0x…" forms', () => {
  assert.deepEqual(parseChainHint(`base ${EVM}`), { chainId: 'base', rest: EVM });
  assert.deepEqual(parseChainHint(`bnb ${EVM}`), { chainId: 'bsc', rest: EVM });
  assert.deepEqual(parseChainHint('hello world'), { chainId: null, rest: 'hello world' });
  assert.deepEqual(parseChainHint(EVM), { chainId: null, rest: EVM });
});

test('legacy detectCandidates keeps returning every candidate', () => {
  const both = detectCandidates(`check ${EVM} and ${SOL}`);
  assert.equal(both.length, 2);
  assert.ok(both.some((c) => c.chain === 'bsc'));
  assert.ok(both.some((c) => c.chain === 'solana'));
});

test('isValidForChain rejects cross-kind input', () => {
  assert.equal(isValidForChain('solana', SOL), true);
  assert.equal(isValidForChain('solana', EVM), false);
  assert.equal(isValidForChain('base', EVM), true);
  assert.equal(isValidForChain('base', SOL), false);
  assert.equal(isValidForChain('nope', EVM), false);
});

test('capabilitySummary never claims a feature a chain lacks', () => {
  const rows = capabilitySummary();
  const story = rows.find((r) => r.id === 'story');
  assert.equal(story.market, false);
  const hyper = rows.find((r) => r.id === 'hyperevm');
  assert.equal(hyper.holders, false, 'no GoPlus coverage on hyperevm');
  assert.equal(hyper.tax, false);
  const sol = rows.find((r) => r.id === 'solana');
  assert.equal(sol.holders, true);
  assert.equal(sol.tax, false, 'solana has no buy/sell tax concept');
});
