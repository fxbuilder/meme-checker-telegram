/**
 * src/research/onchain-metadata.mjs
 * On-chain token metadata — the last honest resort when nothing off-chain exists.
 *
 * WHY IT MATTERS FOR NEW TOKENS
 * A freshly launched memecoin often has no GeckoTerminal description yet. Its on-chain
 * metadata still proves what it IS: name, symbol, supply, decimals, mint authority,
 * freeze authority, and whether it uses Token-2022. That is not a story, but it is
 * verified fact, and stating it beats an empty card.
 *
 * WHAT IT DOES NOT DO
 * Metaplex's off-chain JSON (the `uri` field) is fetched only when it is a well-formed
 * https URL, because that document is attacker-controlled. Its `description` is a
 * project claim. Nothing here is invented: an unreadable account yields null, not a
 * placeholder.
 *
 * Solana only. EVM `name()`/`symbol()` reads would need contract eth_call plumbing for
 * values DexScreener already returns, so they are deliberately not repeated here.
 */

const SOLANA_RPC = 'https://api.mainnet-beta.solana.com';
const TIMEOUT_MS = 9_000;

/** Known token programs, so we can state the standard truthfully. */
const TOKEN_PROGRAM = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
const TOKEN_2022_PROGRAM = 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb';
const METAPLEX_PROGRAM = 'metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s';

/** A bounded JSON-RPC call. Never throws. */
async function rpc(method, params, { fetchImpl = globalThis.fetch, rpcUrl = process.env.SOLANA_RPC_URL || SOLANA_RPC, timeoutMs = TIMEOUT_MS } = {}) {
  if (typeof fetchImpl !== 'function') return { status: 'provider-error', detail: 'no fetch' };
  let res;
  try {
    res = await fetchImpl(rpcUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    const timedOut = err?.name === 'TimeoutError' || err?.name === 'AbortError';
    return { status: timedOut ? 'timeout' : 'provider-error', detail: String(err?.message ?? err) };
  }
  if (res.status === 429) return { status: 'rate-limited' };
  if (!res.ok) return { status: 'provider-error', detail: `http ${res.status}` };
  let j;
  try {
    j = await res.json();
  } catch {
    return { status: 'provider-error', detail: 'non-JSON' };
  }
  if (j?.error) return { status: 'provider-error', detail: String(j.error?.message ?? 'rpc error') };
  return { status: 'ok', result: j?.result };
}

/**
 * Read a Solana mint account.
 *
 * @returns {Promise<{status:string, mint?:object}>}
 */
export async function readSolanaMint(mintAddress, opts = {}) {
  const mint = String(mintAddress ?? '').trim();
  if (!mint) return { status: 'provider-error', detail: 'empty address' };

  const r = await rpc('getAccountInfo', [mint, { encoding: 'jsonParsed' }], opts);
  if (r.status !== 'ok') return r;

  const value = r.result?.value;
  if (!value) return { status: 'not-found' };

  const program = value.owner ?? null;
  const parsed = value.data?.parsed;
  // A non-mint account (a pool, a wallet) is not an error, it is simply not a mint.
  if (!parsed || parsed.type !== 'mint') {
    return { status: 'not-a-mint', program };
  }

  const info = parsed.info ?? {};
  return {
    status: 'ok',
    mint: {
      source: 'solana-rpc',
      address: mint,
      program,
      // The standard is a verified fact about the account, not a guess.
      standard: program === TOKEN_2022_PROGRAM ? 'token-2022'
        : program === TOKEN_PROGRAM ? 'spl-token' : 'unknown',
      decimals: Number.isFinite(Number(info.decimals)) ? Number(info.decimals) : null,
      supply: typeof info.supply === 'string' && /^\d+$/.test(info.supply) ? info.supply : null,
      // Authority facts are genuinely useful risk signals and are verifiable.
      mintAuthority: info.mintAuthority ?? null,
      freezeAuthority: info.freezeAuthority ?? null,
      isInitialized: info.isInitialized === true,
    },
  };
}

/**
 * Fetch a Metaplex off-chain metadata JSON, only when the URI is safe.
 * The document is attacker-controlled: it is treated as data and its prose is a claim.
 */
export async function readMetaplexJson(uri, { fetchImpl = globalThis.fetch, timeoutMs = TIMEOUT_MS, isSafeUrl } = {}) {
  if (typeof uri !== 'string' || !/^https:\/\//i.test(uri)) {
    // Deliberately HTTPS-only: an http or data: URI here is a downgrade, not a source.
    return { status: 'unsafe-uri' };
  }
  // Reuse the project's SSRF guard when the caller supplies it.
  if (typeof isSafeUrl === 'function' && !isSafeUrl(uri)) return { status: 'unsafe-uri' };
  if (typeof fetchImpl !== 'function') return { status: 'provider-error', detail: 'no fetch' };

  let res;
  try {
    res = await fetchImpl(uri, {
      headers: { accept: 'application/json' },
      redirect: 'manual',
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    const timedOut = err?.name === 'TimeoutError' || err?.name === 'AbortError';
    return { status: timedOut ? 'timeout' : 'provider-error', detail: String(err?.message ?? err) };
  }
  // A redirect is not followed: the destination would bypass the SSRF check above.
  if (res.status >= 300 && res.status < 400) return { status: 'unsafe-uri', detail: 'redirect' };
  if (!res.ok) return { status: 'provider-error', detail: `http ${res.status}` };

  let j;
  try {
    j = await res.json();
  } catch {
    return { status: 'provider-error', detail: 'non-JSON' };
  }
  if (!j || typeof j !== 'object') return { status: 'provider-error', detail: 'not an object' };

  return {
    status: 'ok',
    metadata: {
      name: typeof j.name === 'string' ? j.name.trim() : null,
      symbol: typeof j.symbol === 'string' ? j.symbol.trim() : null,
      description: typeof j.description === 'string' && j.description.trim() ? j.description.trim() : null,
      image: typeof j.image === 'string' && /^https:\/\//i.test(j.image) ? j.image : null,
      // Metaplex puts links in `extensions` or `properties`.
      twitter: pickHandle(j, 'twitter'),
      website: pickSite(j),
      telegram: pickHandle(j, 'telegram'),
    },
  };
}

function pickHandle(j, key) {
  const cands = [
    j?.extensions?.[key],
    j?.properties?.[key],
    j?.[key],
  ];
  for (const c of cands) {
    if (typeof c === 'string' && c.trim()) {
      const v = c.trim();
      if (/^https?:\/\//i.test(v)) return v;
      const h = v.replace(/^@/, '');
      if (/^[A-Za-z0-9_]{1,64}$/.test(h)) {
        return key === 'twitter' ? `https://x.com/${h}` : `https://t.me/${h}`;
      }
    }
  }
  return null;
}

function pickSite(j) {
  const cands = [j?.extensions?.website, j?.properties?.website, j?.external_url, j?.website];
  for (const c of cands) {
    if (typeof c === 'string' && /^https?:\/\//i.test(c.trim())) {
      try {
        const u = new URL(c.trim());
        if (u.protocol === 'http:' || u.protocol === 'https:') return u.toString();
      } catch { /* ignore */ }
    }
  }
  return null;
}


/**
 * Derive the Metaplex metadata account address for a mint.
 *
 * Program Derived Addresses need Ed25519 curve maths, and Node has no built-in for
 * it. Rather than pull in a chain SDK for one lookup, `getProgramAccounts` is used
 * with a memcmp filter on the mint field: the RPC does the derivation work server
 * side and returns the account. It is a heavier call, so it is only made when nothing
 * else described the token.
 *
 * The offset is 1 + 32 = 33: Metaplex metadata accounts begin with a 1-byte key
 * discriminator, followed by the 32-byte mint address.
 */
const METAPLEX_MINT_OFFSET = 33;

/**
 * Fetch the on-chain Metaplex metadata for a Solana mint.
 *
 * @returns {Promise<{status:string, metadata?:object}>}
 */
export async function readMetaplexMetadata(mintAddress, opts = {}) {
  const mint = String(mintAddress ?? '').trim();
  if (!mint) return { status: 'provider-error', detail: 'empty address' };

  const r = await rpc('getProgramAccounts', [
    METAPLEX_PROGRAM,
    {
      // base64, because the public RPC does NOT decode Metaplex accounts for us -
      // jsonParsed returned raw base64 and the lookup silently produced nothing.
      encoding: 'base64',
      filters: [{ memcmp: { offset: METAPLEX_MINT_OFFSET, bytes: mint } }],
      // Name/symbol/uri live early in the account; 500 bytes covers them without
      // pulling a multi-kilobyte blob.
      dataSlice: { offset: 0, length: 500 },
    },
  ], opts);

  if (r.status !== 'ok') return r;
  const accounts = Array.isArray(r.result) ? r.result : [];
  if (!accounts.length) return { status: 'not-found' };

  const b64 = accounts[0]?.account?.data?.[0];
  if (typeof b64 !== 'string') return { status: 'not-decoded' };

  const decoded = decodeMetaplexAccount(b64);
  if (!decoded) return { status: 'not-decoded' };

  return {
    status: 'ok',
    metadata: { source: 'metaplex', ...decoded },
  };
}

/**
 * Decode the leading fields of a Metaplex Metadata account.
 *
 * LAYOUT (Borsh, after the 1-byte key discriminator):
 *   update_authority  32 bytes
 *   mint              32 bytes
 *   name              u32 length + bytes (null-padded, usually 32)
 *   symbol            u32 length + bytes (usually 10)
 *   uri               u32 length + bytes (usually 200)
 *   seller_fee_bps    u16
 *   ...
 *
 * This is a hand-rolled reader rather than a dependency: the fields needed are all
 * leading, fixed-layout, and a chain SDK would be a large addition for four strings.
 * Anything unexpected returns null, so a malformed account is reported as undecodable
 * instead of producing garbage text.
 */
export function decodeMetaplexAccount(base64) {
  let buf;
  try {
    buf = Buffer.from(base64, 'base64');
  } catch { return null; }
  if (!buf || buf.length < 70) return null;

  let off = 1; // key discriminator
  if (buf.length < off + 64) return null;
  const updateAuthority = bs58(buf.subarray(off, off + 32));
  off += 32;
  off += 32; // mint (we already know it)

  const readString = () => {
    if (off + 4 > buf.length) return null;
    const len = buf.readUInt32LE(off);
    off += 4;
    // A length beyond the buffer means the layout assumption is wrong.
    if (len < 0 || len > 2_000 || off + len > buf.length) return null;
    const raw = buf.subarray(off, off + len);
    off += len;
    // Null-padded UTF-8.
    return raw.toString('utf8').replace(/\0+$/g, '').trim();
  };

  const name = readString();
  if (name === null) return null;
  const symbol = readString();
  if (symbol === null) return null;
  const uri = readString();
  if (uri === null) return null;

  let isMutable = null;
  if (off < buf.length) isMutable = buf[off] === 1;
  else if (off === buf.length) isMutable = null;

  return {
    name: name || null,
    symbol: symbol || null,
    uri: /^https:\/\//i.test(uri) ? uri : null,
    updateAuthority: updateAuthority && updateAuthority.length > 30 ? updateAuthority : null,
    isMutable,
  };
}

/** Minimal base58 encoder — Solana public keys are base58, and Buffer has no helper. */
const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
function bs58(bytes) {
  if (!bytes || !bytes.length) return null;
  let zeros = 0;
  while (zeros < bytes.length && bytes[zeros] === 0) zeros += 1;
  const digits = [0];
  for (let i = zeros; i < bytes.length; i += 1) {
    let carry = bytes[i];
    for (let j = 0; j < digits.length; j += 1) {
      carry += digits[j] << 8;
      digits[j] = carry % 58;
      carry = (carry / 58) | 0;
    }
    while (carry > 0) { digits.push(carry % 58); carry = (carry / 58) | 0; }
  }
  let out = '1'.repeat(zeros);
  for (let i = digits.length - 1; i >= 0; i -= 1) out += B58[digits[i]];
  return out;
}

/**
 * Turn verified on-chain facts into narrative CLAIMS (not prose).
 * These are statements about the contract that no source can dispute.
 */
export function mintFacts(mint) {
  if (!mint) return [];
  const out = [];
  if (mint.standard && mint.standard !== 'unknown') {
    out.push({
      class: 'verified',
      text: mint.standard === 'token-2022' ? 'Uses the Token-2022 program' : 'Standard SPL token',
      source: 'on-chain mint account',
    });
  }
  if (mint.mintAuthority === null && mint.standard) {
    out.push({
      class: 'verified',
      text: 'Mint authority renounced — supply is fixed',
      source: 'on-chain mint account',
    });
  } else if (mint.mintAuthority) {
    out.push({
      class: 'verified',
      text: 'Mint authority still active — supply can be increased',
      source: 'on-chain mint account',
    });
  }
  if (mint.freezeAuthority === null && mint.standard) {
    out.push({
      class: 'verified',
      text: 'Freeze authority renounced — tokens cannot be frozen',
      source: 'on-chain mint account',
    });
  } else if (mint.freezeAuthority) {
    out.push({
      class: 'verified',
      text: 'Freeze authority active — holdings can be frozen',
      source: 'on-chain mint account',
    });
  }
  return out;
}
