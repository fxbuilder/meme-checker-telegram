import test from 'node:test';
import assert from 'node:assert/strict';
const sol = {chain: 'solana', address: 'FiXtUrE111111111111111111111111111111111111'};
const bsc = {chain: 'bsc', address: '0xabcdef0123456789abcdef0123456789abcdef01'};

async function api() {
  try { return await import('../src/mock-scan.mjs'); }
  catch (error) {
    if (error.code !== 'ERR_MODULE_NOT_FOUND' || !error.url?.endsWith('/src/mock-scan.mjs')) throw error;
    assert.fail('Offline scan module has not been implemented');
  }
}

test('Solana fixture returns a labeled mock and an exact-token link', async () => {
  const {mockScan} = await api();
  const result = await mockScan(sol);
  assert.equal(result.mode, 'mock');
  assert.equal(result.status, 'ok');
  assert.equal(result.token.address, sol.address);
  assert.equal(result.fullAnalysisUrl, `https://meme-checker.example/check/solana/${sol.address}`);
  assert.equal(result.market.marketCapUsd, 1250000);
});

test('BNB uses case-insensitive identity; unknown market cap is not replaced by FDV', async () => {
  const {mockScan} = await api();
  const result = await mockScan({...bsc, address: '0x' + bsc.address.slice(2).toUpperCase()});
  assert.equal(result.status, 'ok');
  assert.equal(result.fullAnalysisUrl, `https://meme-checker.example/check/bsc/${bsc.address}`);
  assert.equal(result.market.marketCapUsd, null);
  assert.equal(result.market.fdvUsd, 1500000);
  assert.equal(result.market.volume24hUsd, 0);
  assert.equal(result.holders.total, null);
});

test('unverified narrative is not shown', async () => {
  const {mockScan} = await api();
  assert.equal((await mockScan(sol)).narrative, null);
});

test('missing fixtures do not return a fallback token or link', async () => {
  const {mockScan} = await api();
  assert.deepEqual(await mockScan({...sol, address: sol.address.toLowerCase()}), {mode: 'mock', status: 'not-found'});
});

test('mismatched identity or unsupported response shape is rejected', async () => {
  const {normalizeMock} = await api();
  assert.deepEqual(normalizeMock(sol, {success: true, data: {...bsc, token: {name: 'Different', symbol: 'OTHER'}}}), {mode: 'mock', status: 'invalid-response'});
  assert.deepEqual(normalizeMock(sol, {success: true, data: sol}), {mode: 'mock', status: 'invalid-response'});
  assert.deepEqual(normalizeMock(sol, {success: false, data: {...sol, token: {name: 'Example', symbol: 'EX'}}}), {mode: 'mock', status: 'invalid-response'});
});
