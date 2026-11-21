/**
 * test/mock-scan-url.test.mjs
 * Regression: fullAnalysisUrl behaviour from mockScan under empty vs configured TOKEN_PAGE_BASE_URL.
 * Covers the QA-reported placeholder-link defect.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

const SOL = { chain: 'solana', address: 'FiXtUrE111111111111111111111111111111111111' };
const BSC = { chain: 'bsc',    address: '0xabcdef0123456789abcdef0123456789abcdef01' };

async function loadMockScan() {
  // Clear module cache between env-change scenarios by using a cache-bust query param.
  // Node ESM caches by resolved URL, so we append a dummy param to force a fresh load.
  const { pathToFileURL } = await import('node:url');
  const { resolve } = await import('node:path');
  const base = pathToFileURL(resolve('src/mock-scan.mjs')).toString();
  return import(base + '?bust=' + Date.now());
}

test('Solana: fullAnalysisUrl is null when TOKEN_PAGE_BASE_URL is empty', async () => {
  delete process.env.TOKEN_PAGE_BASE_URL;
  const { mockScan } = await loadMockScan();
  const r = await mockScan(SOL);
  assert.equal(r.status, 'ok');
  assert.equal(r.fullAnalysisUrl, null, 'must not emit placeholder URL when env is unset');
});

test('BNB: fullAnalysisUrl is null when TOKEN_PAGE_BASE_URL is empty', async () => {
  process.env.TOKEN_PAGE_BASE_URL = '';
  const { mockScan } = await loadMockScan();
  const r = await mockScan(BSC);
  assert.equal(r.status, 'ok');
  assert.equal(r.fullAnalysisUrl, null, 'must not emit placeholder URL when env is empty string');
});

test('Solana: fullAnalysisUrl set when TOKEN_PAGE_BASE_URL is a real host', async () => {
  process.env.TOKEN_PAGE_BASE_URL = 'https://app.memechecker.io';
  const { mockScan } = await loadMockScan();
  const r = await mockScan(SOL);
  assert.equal(r.status, 'ok');
  assert.ok(r.fullAnalysisUrl, 'must emit URL when env is configured');
  assert.ok(r.fullAnalysisUrl.startsWith('https://app.memechecker.io/check/solana/'), `unexpected URL: ${r.fullAnalysisUrl}`);
  assert.ok(!r.fullAnalysisUrl.includes('.example'), 'must not contain placeholder host');
});

test('BNB: fullAnalysisUrl set when TOKEN_PAGE_BASE_URL is a real host', async () => {
  process.env.TOKEN_PAGE_BASE_URL = 'https://app.memechecker.io';
  const { mockScan } = await loadMockScan();
  const r = await mockScan(BSC);
  assert.equal(r.status, 'ok');
  assert.ok(r.fullAnalysisUrl?.startsWith('https://app.memechecker.io/check/bsc/'), `unexpected URL: ${r.fullAnalysisUrl}`);
});

test('Placeholder .example TOKEN_PAGE_BASE_URL is rejected — fullAnalysisUrl null', async () => {
  process.env.TOKEN_PAGE_BASE_URL = 'https://meme-checker.example';
  const { mockScan } = await loadMockScan();
  const r = await mockScan(SOL);
  assert.equal(r.fullAnalysisUrl, null, '.example base must be rejected');
});

test('Malformed TOKEN_PAGE_BASE_URL is rejected — fullAnalysisUrl null', async () => {
  process.env.TOKEN_PAGE_BASE_URL = 'not-a-url';
  const { mockScan } = await loadMockScan();
  const r = await mockScan(SOL);
  assert.equal(r.fullAnalysisUrl, null, 'malformed base must be rejected');
});
