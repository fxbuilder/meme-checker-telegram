/**
 * src/detect-ca.mjs
 * Detect Solana and EVM contract address candidates from a message string.
 *
 * Returns an array of { chain, address } objects.
 * Preserves Solana case; lowercases EVM.
 * Address-pattern detection does NOT verify that the address is a token.
 */

// Solana: base58, 32-44 chars, cannot start with 0 or contain l, I, O
const SOL_RE = /(?<![A-Za-z0-9])([1-9A-HJ-NP-Za-km-z]{32,44})(?![A-Za-z0-9])/g;

// EVM: 0x (or 0X) + 40 hex
const EVM_RE = /(?<![A-Za-z0-9])(0[xX][0-9a-fA-F]{40})(?![A-Za-z0-9])/g;

export function detectCandidates(text) {
  if (typeof text !== 'string') return [];
  const results = [];
  const seen = new Set();

  for (const m of text.matchAll(EVM_RE)) {
    const addr = m[1].toLowerCase();
    const key = `bsc:${addr}`;
    if (!seen.has(key)) { seen.add(key); results.push({ chain: 'bsc', address: addr }); }
  }

  for (const m of text.matchAll(SOL_RE)) {
    const addr = m[1]; // preserve case
    const key = `solana:${addr}`;
    if (!seen.has(key)) { seen.add(key); results.push({ chain: 'solana', address: addr }); }
  }

  return results;
}
