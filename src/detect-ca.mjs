/**
 * src/detect-ca.mjs
 * Detect contract address candidates in a message, for every supported chain.
 *
 * detectCandidates() keeps the original array-of-{chain,address} shape so
 * existing callers and tests are unaffected. detectAll() adds the information
 * needed for multi-chain EVM input.
 *
 * Solana base58 is case-sensitive and preserved exactly; EVM is canonicalized
 * to lowercase. An EVM address is ONE string valid on 13 different chains, so a
 * bare 0x… is NOT a chain decision. Without a hint we fall back to the caller's
 * default chain and report `ambiguous: true`, so the bot can offer a chain
 * picker instead of silently guessing the wrong network.
 *
 * Address-pattern detection does NOT verify that the address is a token.
 */
import { ADDRESS_KIND, getChain, resolveChainAlias, CHAINS } from './chains.mjs';

// Solana: base58, 32-44 chars, cannot start with 0 or contain l, I, O
const SOL_RE = /(?<![A-Za-z0-9])([1-9A-HJ-NP-Za-km-z]{32,44})(?![A-Za-z0-9])/g;
// EVM: 0x (or 0X) + 40 hex
const EVM_RE = /(?<![A-Za-z0-9])(0[xX][0-9a-fA-F]{40})(?![A-Za-z0-9])/g;

/** Chain used when an EVM address arrives with no hint. */
export const DEFAULT_EVM_CHAIN = 'bsc';

/** EVM chains that can actually be scanned — used for the chain picker. */
export const EVM_SCANNABLE = Object.values(CHAINS)
  .filter((c) => c.kind === 'evm' && c.market)
  .map((c) => c.id);

/**
 * Extract a leading chain hint from text such as
 *   "base 0xabc…"  "solana 4Nd…"  "hyperevm 0x…"
 * Returns { chainId, rest }.
 */
export function parseChainHint(text) {
  if (typeof text !== 'string') return { chainId: null, rest: text };
  const trimmed = text.trim();
  const m = trimmed.match(/^(\S+)\s+([\s\S]+)$/);
  if (!m) return { chainId: null, rest: trimmed };
  const chainId = resolveChainAlias(m[1]);
  if (!chainId) return { chainId: null, rest: trimmed };
  return { chainId, rest: m[2] };
}

/**
 * Detect candidates plus the context needed to resolve EVM ambiguity.
 */
export function detectAll(text, { defaultEvmChain = DEFAULT_EVM_CHAIN, chainHint = null } = {}) {
  const empty = { candidates: [], kind: null, hint: null, ambiguous: false, evmChains: [] };
  if (typeof text !== 'string') return empty;

  const evmMatches = [];
  const seenEvm = new Set();
  for (const m of text.matchAll(EVM_RE)) {
    const addr = m[1].toLowerCase();
    if (!seenEvm.has(addr)) { seenEvm.add(addr); evmMatches.push(addr); }
  }

  const solMatches = [];
  const seenSol = new Set();
  for (const m of text.matchAll(SOL_RE)) {
    const addr = m[1]; // preserve case
    if (!seenSol.has(addr)) { seenSol.add(addr); solMatches.push(addr); }
  }

  // Both kinds can legitimately appear in one message (e.g. a comparison post).
  // The legacy detectCandidates() contract returns every candidate, so build the
  // list first and only then describe the ambiguity.
  if (evmMatches.length && solMatches.length) {
    const hintedEvm = chainHint && getChain(chainHint)?.kind === 'evm' ? chainHint : null;
    const chosen = hintedEvm ?? (getChain(defaultEvmChain)?.kind === 'evm' ? defaultEvmChain : DEFAULT_EVM_CHAIN);
    return {
      candidates: [
        ...evmMatches.map((address) => ({ chain: chosen, address })),
        ...solMatches.map((address) => ({ chain: 'solana', address })),
      ],
      kind: 'mixed',
      hint: chainHint,
      ambiguous: !hintedEvm,
      evmChains: EVM_SCANNABLE,
    };
  }

  if (evmMatches.length) {
    const hinted = chainHint && getChain(chainHint)?.kind === 'evm' ? chainHint : null;
    const chosen = hinted ?? (getChain(defaultEvmChain)?.kind === 'evm' ? defaultEvmChain : DEFAULT_EVM_CHAIN);
    return {
      candidates: evmMatches.map((address) => ({ chain: chosen, address })),
      kind: 'evm',
      hint: hinted,
      // True when nothing told us the chain and more than one EVM chain exists.
      ambiguous: !hinted && EVM_SCANNABLE.length > 1,
      evmChains: EVM_SCANNABLE,
    };
  }

  if (solMatches.length) {
    return {
      candidates: solMatches.map((address) => ({ chain: 'solana', address })),
      kind: 'solana',
      hint: chainHint && getChain(chainHint)?.kind === 'solana' ? chainHint : null,
      ambiguous: false,
      evmChains: [],
    };
  }

  return empty;
}

/** Legacy shape: array of { chain, address }. */
export function detectCandidates(text, opts) {
  return detectAll(text, opts).candidates;
}

/** Validate a bare address against an explicitly named chain. */
export function isValidForChain(chain, address) {
  const def = getChain(chain);
  if (!def || typeof address !== 'string') return false;
  return def.kind === 'solana'
    ? ADDRESS_KIND.solana.test(address)
    : ADDRESS_KIND.evm.test(address);
}
