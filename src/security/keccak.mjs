/**
 * Keccak-256 (Ethereum variant: 0x01 domain padding), dependency-free.
 *
 * `node:crypto`'s sha3-256 is NOT Keccak-256 — it uses 0x06 padding — so it produces a
 * different digest and therefore different selectors. A selector built from SHA3 silently
 * calls a function that does not exist, which the EVM reports as a revert, indistinguishable
 * from "the contract has no such function".
 *
 * Verified against known values: transfer(address,uint256) = 0xa9059cbb,
 * metaURI() = 0x67605787, getTokenInfo() = 0xabb1dc44.
 */

const RC = [
  0x0000000000000001n, 0x0000000000008082n, 0x800000000000808an, 0x8000000080008000n,
  0x000000000000808bn, 0x0000000080000001n, 0x8000000080008081n, 0x8000000000008009n,
  0x000000000000008an, 0x0000000000000088n, 0x0000000080008009n, 0x000000008000000an,
  0x000000008000808bn, 0x800000000000008bn, 0x8000000000008089n, 0x8000000000008003n,
  0x8000000000008002n, 0x8000000000000080n, 0x000000000000800an, 0x800000008000000an,
  0x8000000080008081n, 0x8000000000008080n, 0x0000000080000001n, 0x8000000080008008n,
];
const R = [
  [0, 36, 3, 41, 18], [1, 44, 10, 45, 2], [62, 6, 43, 15, 61],
  [28, 55, 25, 21, 56], [27, 20, 39, 8, 14],
];
const MASK = (1n << 64n) - 1n;
const rotl = (x, n) => (n === 0 ? x : ((x << BigInt(n)) | (x >> BigInt(64 - n))) & MASK);

/** @param {string|Buffer} input @returns {Buffer} 32-byte digest */
export function keccak256(input) {
  const rate = 136; // 1088-bit rate
  const bytes = Buffer.from(typeof input === 'string' ? Buffer.from(input, 'utf8') : input);

  // pad10*1: append 0x01, zero-fill, set the final byte's high bit.
  const padLen = rate - (bytes.length % rate);
  const padded = Buffer.alloc(bytes.length + padLen);
  bytes.copy(padded);
  padded[bytes.length] ^= 0x01;
  padded[padded.length - 1] ^= 0x80;

  const S = new Array(25).fill(0n);
  for (let off = 0; off < padded.length; off += rate) {
    for (let i = 0; i < rate / 8; i++) {
      S[i] ^= padded.readBigUInt64LE(off + i * 8);
    }
    for (let round = 0; round < 24; round++) {
      const C = new Array(5);
      for (let x = 0; x < 5; x++) C[x] = S[x] ^ S[x + 5] ^ S[x + 10] ^ S[x + 15] ^ S[x + 20];
      for (let x = 0; x < 5; x++) {
        const D = C[(x + 4) % 5] ^ rotl(C[(x + 1) % 5], 1);
        for (let y = 0; y < 5; y++) S[x + 5 * y] ^= D;
      }
      const B = new Array(25).fill(0n);
      for (let x = 0; x < 5; x++) {
        for (let y = 0; y < 5; y++) {
          B[y + 5 * ((2 * x + 3 * y) % 5)] = rotl(S[x + 5 * y], R[x][y]);
        }
      }
      for (let x = 0; x < 5; x++) {
        for (let y = 0; y < 5; y++) {
          S[x + 5 * y] = B[x + 5 * y] ^ ((~B[(x + 1) % 5 + 5 * y] & MASK) & B[(x + 2) % 5 + 5 * y]);
        }
      }
      S[0] ^= RC[round];
    }
  }

  const out = Buffer.alloc(32);
  for (let i = 0; i < 4; i++) out.writeBigUInt64LE(S[i], i * 8);
  return out;
}

/** 4-byte function selector as 0x-prefixed hex. */
export function selectorOf(signature) {
  return '0x' + keccak256(signature).toString('hex').slice(0, 8);
}

/** 32-byte event topic0 as 0x-prefixed hex. */
export function topicOf(signature) {
  return '0x' + keccak256(signature).toString('hex');
}
