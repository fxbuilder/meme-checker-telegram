/**
 * src/research/evm-metadata.mjs
 *
 * On-chain token metadata URI, read directly from the token contract.
 *
 * WHY THIS EXISTS
 * On BNB Chain, launchpad tokens (flap.sh, four.meme, and similar) frequently publish NO
 * description anywhere: GeckoTerminal returns no `description` key at all, CoinGecko has
 * no listing, and DexScreener's `info` carries websites/socials but no prose. Verified on
 * ANT (0xb4f9d1b2…), where every hosted source came back empty.
 *
 * But these tokens DO declare a metadata URI on-chain. `metaURI()` is a plain view
 * function on the token contract, and the JSON behind the CID has a `description` field.
 * That makes this the only keyless, ADDRESS-SCOPED prose source for these tokens.
 *
 * WHAT THIS PROVES AND WHAT IT DOES NOT
 * The URI is returned BY THE CONTRACT ADDRESS THAT WAS ASKED, so the metadata belongs to
 * that exact token — this is identity-safe in a way a name search is not. What it does
 * NOT prove is that the description is non-empty: verified live, ANT's own metadata has
 * `"description": ""`. An empty description is a real finding and stays null, never
 * filled with a placeholder.
 *
 * SECURITY: this fetches a URI the contract supplies, so the destination is
 * attacker-controlled. Only http(s) and ipfs schemes are accepted, the response must be
 * JSON, and only a small set of scalar fields is read. Nothing is executed, and the body
 * is size-capped before parsing.
 */

const META_URI_SELECTOR = '0x67605787'; // metaURI()
const TIMEOUT_MS = 8_000;
const MAX_BODY_BYTES = 200_000;
/** Gateways tried in order. Pinata is flap.sh's own; ipfs.io is the general fallback. */
const IPFS_GATEWAYS = [
  'https://flap.mypinata.cloud/ipfs/',
  'https://ipfs.io/ipfs/',
];

/** Public RPC per chain, for chains where we have a verified endpoint. */
const RPC = {
  bsc: 'https://bsc-dataseed.binance.org',
  ethereum: 'https://ethereum-rpc.publicnode.com',
  base: 'https://mainnet.base.org',
};

/**
 * Decode a `string` return value from an eth_call ABI payload.
 *
 * Layout: 32-byte offset, then 32-byte length, then the UTF-8 bytes. Returns null rather
 * than a half-decoded string when the buffer does not match the expected shape — a
 * URI assembled from garbage would be a fabricated source.
 */
export function decodeAbiString(hex) {
  if (typeof hex !== 'string') return null;
  const h = hex.startsWith('0x') ? hex.slice(2) : hex;
  if (!/^[0-9a-fA-F]*$/.test(h) || h.length < 128) return null;

  const offset = parseInt(h.slice(0, 64), 16);
  if (!Number.isFinite(offset) || offset < 32 || offset * 2 + 64 > h.length) return null;

  const lenHex = h.slice(offset * 2, offset * 2 + 64);
  const len = parseInt(lenHex, 16);
  if (!Number.isFinite(len) || len <= 0 || len > 4_096) return null;

  const dataHex = h.slice(offset * 2 + 64, offset * 2 + 64 + len * 2);
  if (dataHex.length !== len * 2) return null;

  try {
    return Buffer.from(dataHex, 'hex').toString('utf8');
  } catch {
    return null;
  }
}

/** Accept only schemes that cannot execute or read the local filesystem. */
export function safeMetadataUrl(uri) {
  if (typeof uri !== 'string') return null;
  const raw = uri.trim();
  if (!raw) return null;

  const toGateways = (cid) => {
    // A CID is base32/base58; anything with a scheme, slash or whitespace is not one.
    if (!/^[A-Za-z0-9]{20,}$/.test(cid)) return null;
    return IPFS_GATEWAYS.map((g) => `${g}${cid}`);
  };

  if (raw.startsWith('ipfs://')) {
    return toGateways(raw.slice('ipfs://'.length).replace(/^ipfs\//, '').trim());
  }
  if (/^https?:\/\//i.test(raw)) return [raw];

  // A BARE CID is the common case: verified live on flap.sh tokens, `metaURI()` returns
  // `bafkrei…` with no scheme at all. Rejecting it was why ANT reported no metadata even
  // though its contract returned a perfectly good CID.
  return toGateways(raw);
}

/**
 * Read name/symbol/description/links from a token's on-chain metadata.
 *
 * @returns {Promise<{status:'ok'|'no-metadata'|'empty'|'unsupported-chain'|'error',
 *                    description?:string|null, name?:string|null, symbol?:string|null,
 *                    twitter?:string|null, website?:string|null, uri?:string}>}
 */
export async function fetchOnchainMetadata(chain, address, {
  fetchImpl = globalThis.fetch,
  timeoutMs = TIMEOUT_MS,
} = {}) {
  const rpc = RPC[String(chain).toLowerCase()];
  if (!rpc) return { status: 'unsupported-chain' };
  if (!/^0x[0-9a-fA-F]{40}$/.test(String(address ?? ''))) return { status: 'no-metadata' };

  // ---- 1. ask the contract for its metadata URI ---------------------------
  const data = META_URI_SELECTOR + String(address).slice(2).toLowerCase().padStart(64, '0');
  let uri = null;
  try {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), timeoutMs);
    const res = await fetchImpl(rpc, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      signal: ac.signal,
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_call', params: [{ to: address, data }, 'latest'] }),
    }).finally(() => clearTimeout(timer));

    if (!res.ok) return { status: 'error', detail: `rpc http ${res.status}` };
    const body = await res.json();
    // A revert or missing function is a normal answer here: most tokens have no metaURI.
    if (!body?.result || body.error) return { status: 'no-metadata' };
    uri = decodeAbiString(body.result);
  } catch (err) {
    return { status: 'error', detail: String(err?.name ?? err) };
  }

  if (!uri) return { status: 'no-metadata' };

  // ---- 2. fetch the metadata document ------------------------------------
  const candidates = safeMetadataUrl(uri);
  if (!candidates) return { status: 'no-metadata', uri };

  let meta = null;
  for (const url of candidates) {
    try {
      const ac = new AbortController();
      const timer = setTimeout(() => ac.abort(), timeoutMs);
      const res = await fetchImpl(url, { signal: ac.signal, headers: { accept: 'application/json' } })
        .finally(() => clearTimeout(timer));
      if (!res.ok) continue;

      const text = await res.text();
      if (text.length > MAX_BODY_BYTES) continue;
      const parsed = JSON.parse(text);
      if (parsed && typeof parsed === 'object') { meta = parsed; break; }
    } catch {
      // Try the next gateway. A gateway outage is not evidence about the token.
    }
  }

  if (!meta) return { status: 'error', uri, detail: 'metadata unreachable' };

  // ---- 3. read only the scalar fields we use ----------------------------
  const str = (v, max = 900) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : null);
  const description = str(meta.description);

  const out = {
    status: description ? 'ok' : 'empty',
    uri,
    name: str(meta.name, 80),
    symbol: str(meta.symbol, 20),
    description,
    twitter: str(meta.twitter ?? meta.x, 200),
    website: str(meta.website ?? meta.external_url ?? meta.site, 200),
  };

  // "empty" means the schema was reachable but the project published no prose. That is
  // a genuine answer and must not be upgraded to a summary by inventing text.
  return out;
}
