/**
 * src/research/launchpad-metadata.mjs
 *
 * Generic on-chain launchpad metadata discovery for EVM tokens.
 *
 * WHY THIS EXISTS
 * Launchpad tokens routinely publish NO description to any hosted index: GeckoTerminal
 * returns `description: ""`, CoinGecko has no listing, DexScreener carries only
 * websites/socials. But the launchpad's own token contract often DOES store a
 * description, readable with one `eth_call`.
 *
 * Verified on PONS (Robinhood Chain, 0x39dbed3a…): GeckoTerminal's description is empty,
 * while the token contract's `getTokenInfo()` returns
 *   `"100% of fees go back to Pons"`
 * with a logo CID and a website. That string exists nowhere on any indexer.
 *
 * HOW IT GENERALISES
 * This is not a PONS special case. It is a TABLE of known launchpad metadata getters,
 * each verified against a live token before being added. A getter that is not in the
 * table is never called, so an arbitrary contract is not spammed with guessed selectors,
 * and a revert is a normal "no metadata" answer rather than an error.
 *
 * WHAT IT DOES NOT DO
 * - It never invents a description. An empty string stays empty.
 * - It never treats a revert or an unknown selector as "the token has no project".
 * - It does not touch a token's `name()`/`symbol()`; those are already available from
 *   every provider, and a description is the missing piece.
 */

const TIMEOUT_MS = 8_000;

/** Public RPC per chain. Only chains with a verified endpoint are listed. */
export const EVM_RPC = {
  ethereum: 'https://ethereum-rpc.publicnode.com',
  bsc: 'https://bsc-dataseed.binance.org',
  base: 'https://mainnet.base.org',
  arbitrum: 'https://arb1.arbitrum.io/rpc',
  optimism: 'https://mainnet.optimism.io',
  polygon: 'https://polygon-rpc.com',
  avalanche: 'https://api.avax.network/ext/bc/C/rpc',
  unichain: 'https://mainnet.unichain.org',
  berachain: 'https://rpc.berachain.com',
  hyperevm: 'https://rpc.hyperliquid.xyz/evm',
  // Verified from docs.ponsfamily.com/developers/overview.md.
  robinhood: 'https://rpc.mainnet.chain.robinhood.com',
  // monad / abstract / megaeth: no endpoint verified here, so they are absent rather
  // than guessed. An absent entry yields 'unsupported-chain', never a false negative.
};

/**
 * Known launchpad metadata getters.
 *
 * Each entry declares the selector, the return layout, and which tuple slot holds the
 * description. Selectors were computed with Keccak-256 and cross-checked against
 * `transfer(address,uint256)` = 0xa9059cbb before use.
 */
export const LAUNCHPAD_GETTERS = [
  {
    id: 'pons-v2',
    // function getTokenInfo() view returns (address tokenDeployer, string tokenLogo,
    //   string tokenDescription, Socials tokenSocials)
    // Verified live on Robinhood Chain against PONS.
    selector: '0xabb1dc44',
    chains: ['robinhood'],
    kind: 'tuple',
    // Word index -> role. Word 0 is the deployer address.
    descriptionWord: 2,
    logoWord: 1,
    socialsWord: 3,
    // Socials struct order per the documented ABI.
    socialOrder: ['twitter', 'telegram', 'discord', 'website', 'farcaster'],
  },
];

/** Read one 32-byte word as an integer. */
function word(h, i) {
  const slice = h.slice(i * 64, i * 64 + 64);
  if (slice.length !== 64) return null;
  const n = parseInt(slice, 16);
  return Number.isFinite(n) ? n : null;
}

/**
 * Read an ABI `string` whose length word sits at `lenHexIdx` (a hex-character index).
 *
 * The offset in an ABI tuple points at the LENGTH word, and the bytes follow it. Passing
 * a base plus an offset and then reading a length there produced a length read one word
 * early, so the "string" came back as the hex of the payload itself. The index is
 * computed once by the caller instead.
 *
 * Returns null on any inconsistency rather than assembling a string from garbage.
 */
function readStringAt(h, lenHexIdx) {
  if (!Number.isFinite(lenHexIdx) || lenHexIdx < 0 || lenHexIdx + 64 > h.length) return null;
  const len = parseInt(h.slice(lenHexIdx, lenHexIdx + 64), 16);
  if (!Number.isFinite(len) || len < 0 || len > 4_096) return null;
  if (len === 0) return '';
  const data = h.slice(lenHexIdx + 64, lenHexIdx + 64 + len * 2);
  if (data.length !== len * 2) return null;
  try {
    // Reject anything that is not plausible UTF-8 text; a binary blob is not a
    // description and must not be rendered as mojibake.
    const text = Buffer.from(data, 'hex');
    const decoded = text.toString('utf8');
    if (decoded.includes('\uFFFD')) return null;
    return decoded;
  } catch {
    return null;
  }
}

/**
 * Decode a launchpad metadata tuple.
 * Exported for testing: offset arithmetic is the part that silently produces garbage.
 */
export function decodeLaunchpadTuple(getter, hexResult) {
  if (typeof hexResult !== 'string' || !hexResult.startsWith('0x')) return null;
  const h = hexResult.slice(2);
  if (h.length < 128) return null;

  const out = { id: getter.id, description: null, logo: null, socials: {} };

  // An offset is in BYTES from the start of the tuple; the hex index is offset * 2.
  if (getter.descriptionWord != null) {
    const off = word(h, getter.descriptionWord);
    if (off !== null) out.description = readStringAt(h, off * 2);
  }
  if (getter.logoWord != null) {
    const off = word(h, getter.logoWord);
    if (off !== null) out.logo = readStringAt(h, off * 2);
  }
  if (getter.socialsWord != null && getter.socialOrder) {
    // The Socials struct is its own tuple starting at BYTE offset `socOff`, which is
    // word index socOff/32. Its five offsets are relative to ITS start, so each absolute
    // index is (socOff + rel) * 2. Indexing from word[getter.socialsWord + 1] read the
    // logo region instead, which silently produced an empty socials object.
    const socOff = word(h, getter.socialsWord);
    if (socOff !== null) {
      const socBaseWord = Math.floor(socOff / 32);
      for (let i = 0; i < getter.socialOrder.length; i++) {
        const rel = word(h, socBaseWord + i);
        if (rel === null) continue;
        const val = readStringAt(h, (socOff + rel) * 2);
        if (val) out.socials[getter.socialOrder[i]] = val;
      }
    }
  }

  // A decoded tuple with no description AND no socials is not worth reporting.
  if (!out.description && !Object.keys(out.socials).length) return null;
  return out;
}

/** One `eth_call`, returning the raw hex or null. */
async function ethCall(rpc, to, data, { fetchImpl, timeoutMs }) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const res = await fetchImpl(rpc, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      signal: ac.signal,
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_call', params: [{ to, data }, 'latest'] }),
    }).finally(() => clearTimeout(timer));
    if (!res.ok) return null;
    const body = await res.json();
    // A revert is a normal answer: this token simply does not implement the getter.
    if (!body?.result || body.error) return null;
    return body.result;
  } catch {
    return null;
  }
}

/**
 * Try every known launchpad getter for this chain.
 *
 * @returns {Promise<{status:'ok'|'empty'|'no-getter'|'unsupported-chain'|'error',
 *                    description?:string|null, socials?:object, getter?:string}>}
 */
export async function fetchLaunchpadMetadata(chain, address, {
  fetchImpl = globalThis.fetch, timeoutMs = TIMEOUT_MS,
} = {}) {
  const key = String(chain ?? '').toLowerCase();
  const rpc = EVM_RPC[key];
  if (!rpc) return { status: 'unsupported-chain' };
  if (!/^0x[0-9a-fA-F]{40}$/.test(String(address ?? ''))) return { status: 'empty' };

  const candidates = LAUNCHPAD_GETTERS.filter((g) => !g.chains || g.chains.includes(key));
  if (!candidates.length) return { status: 'no-getter' };

  for (const getter of candidates) {
    // ONE retry. This getter is often the ONLY prose source for a launchpad token, and
    // measured live it intermittently failed under a tight probe loop (the Robinhood RPC
    // throttles bursts). A single retry costs one extra read on failure and prevents a
    // throttled blip from being cached as "this token has no description".
    let raw = await ethCall(rpc, address, getter.selector, { fetchImpl, timeoutMs });
    if (!raw) {
      await new Promise((r2) => setTimeout(r2, 400));
      raw = await ethCall(rpc, address, getter.selector, { fetchImpl, timeoutMs });
    }
    if (!raw) continue; // not this launchpad's token
    const decoded = decodeLaunchpadTuple(getter, raw);
    if (!decoded) continue;

    const description = typeof decoded.description === 'string' && decoded.description.trim()
      ? decoded.description.trim().slice(0, 900)
      : null;

    return {
      // 'empty' is a real answer: the contract implements the getter and stores no
      // description. It must not be upgraded to a summary by inventing text.
      status: description ? 'ok' : 'empty',
      description,
      logo: decoded.logo ?? null,
      socials: decoded.socials ?? {},
      getter: getter.id,
    };
  }

  return { status: 'no-getter' };
}
