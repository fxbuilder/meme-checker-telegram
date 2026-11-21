/**
 * test/detect-ca.test.mjs
 * Unit tests for contract address detection.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { detectCandidates } from '../src/detect-ca.mjs';

const SOL_ADDR = 'FiXtUrE111111111111111111111111111111111111';
const EVM_ADDR = '0xabcdef0123456789abcdef0123456789abcdef01';

test('detects Solana address alone', () => {
  const r = detectCandidates(SOL_ADDR);
  assert.equal(r.length, 1);
  assert.equal(r[0].chain, 'solana');
  assert.equal(r[0].address, SOL_ADDR);  // case preserved
});

test('detects EVM address alone and lowercases it', () => {
  const r = detectCandidates(EVM_ADDR.toUpperCase());
  assert.equal(r.length, 1);
  assert.equal(r[0].chain, 'bsc');
  assert.equal(r[0].address, EVM_ADDR.toLowerCase());
});

test('detects both when both appear in a sentence', () => {
  const r = detectCandidates(`Check ${EVM_ADDR} and ${SOL_ADDR} please`);
  assert.equal(r.length, 2);
  assert.ok(r.some(x => x.chain === 'bsc'));
  assert.ok(r.some(x => x.chain === 'solana'));
});

test('deduplicates repeated address in same message', () => {
  const r = detectCandidates(`${SOL_ADDR} ${SOL_ADDR}`);
  assert.equal(r.length, 1);
});

test('returns empty for plain text', () => {
  assert.deepEqual(detectCandidates('hello world'), []);
});

test('returns empty for null/undefined', () => {
  assert.deepEqual(detectCandidates(null), []);
  assert.deepEqual(detectCandidates(undefined), []);
});

test('short strings are not matched as Solana addresses', () => {
  // less than 32 chars
  assert.deepEqual(detectCandidates('ABC123'), []);
});

test('EVM address embedded in text is detected', () => {
  const r = detectCandidates(`token: ${EVM_ADDR}, buy now`);
  assert.equal(r.length, 1);
  assert.equal(r[0].chain, 'bsc');
});
