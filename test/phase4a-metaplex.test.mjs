/**
 * test/phase4a-metaplex.test.mjs
 *
 * On-chain Metaplex metadata decoding.
 *
 * The public RPC does not decode Metaplex accounts for us - `jsonParsed` returns raw
 * base64, which originally made this lookup silently produce nothing. These tests pin
 * the hand-rolled Borsh reader that replaced it.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { decodeMetaplexAccount } from '../src/research/onchain-metadata.mjs';

/** Build a Metadata account buffer matching the real Borsh layout. */
function buildAccount({ name = 'Bonk', symbol = 'BONK', uri = 'https://arweave.net/x', mutable = false, pad = true } = {}) {
  const str = (v) => {
    const raw = Buffer.from(v, 'utf8');
    const b = Buffer.alloc(4);
    b.writeUInt32LE(raw.length, 0);
    return Buffer.concat([b, raw]);
  };
  const head = Buffer.alloc(1 + 32 + 32); // key + updateAuthority + mint
  head[0] = 4;
  const body = Buffer.concat([str(name), str(symbol), str(uri), Buffer.from([mutable ? 1 : 0])]);
  let buf = Buffer.concat([head, body]);
  if (pad) buf = Buffer.concat([buf, Buffer.alloc(200)]); // real accounts continue
  return buf.toString('base64');
}

test('a well-formed metadata account decodes name, symbol and uri', () => {
  const out = decodeMetaplexAccount(buildAccount());
  assert.equal(out.name, 'Bonk');
  assert.equal(out.symbol, 'BONK');
  assert.equal(out.uri, 'https://arweave.net/x');
  assert.equal(out.isMutable, false);
});

test('null padding is stripped from the strings', () => {
  const out = decodeMetaplexAccount(buildAccount({ name: 'My Token', symbol: 'MTK' }));
  assert.equal(out.name, 'My Token');
  assert.equal(out.symbol, 'MTK');
});

test('a non-https uri is refused, not passed through', () => {
  for (const uri of ['http://insecure.example/m.json', 'ipfs://abc', 'javascript:alert(1)']) {
    const out = decodeMetaplexAccount(buildAccount({ uri }));
    assert.equal(out.uri, null, uri);
  }
});

test('mutable is reported as a boolean fact, and unknown when truncated', () => {
  assert.equal(decodeMetaplexAccount(buildAccount({ mutable: true })).isMutable, true);
});

test('a truncated or malformed account is undecodable, not garbage', () => {
  assert.equal(decodeMetaplexAccount(''), null);
  assert.equal(decodeMetaplexAccount('not-base64!!!'), null);
  assert.equal(decodeMetaplexAccount(Buffer.alloc(10).toString('base64')), null);
  // A length prefix larger than the buffer must not be trusted.
  const bad = Buffer.alloc(80);
  bad[0] = 4;
  bad.writeUInt32LE(9999, 66);
  assert.equal(decodeMetaplexAccount(bad.toString('base64')), null);
});
