/**
 * src/scanner.mjs
 * Thin scan dispatcher: routes to mock or live backend based on SCAN_MODE env.
 * Live adapter is a stub that throws until @mc-integration wires the real endpoint.
 */
import { mockScan } from './mock-scan.mjs';

const SCAN_MODE = process.env.SCAN_MODE ?? 'mock';

async function liveScan(_request) {
  // Placeholder — @mc-integration will replace with real HTTP client once
  // the Core API contract is confirmed. Never call guessed live paths.
  throw new Error('Live backend not configured. Set SCAN_MODE=mock or provide the real adapter.');
}

/**
 * scan({ chain, address }) → normalized result object
 * Always returns a result (never throws to caller); errors become status objects.
 */
export async function scan(request) {
  try {
    if (SCAN_MODE === 'live') {
      return await liveScan(request);
    }
    return await mockScan(request);
  } catch (err) {
    console.error('[scanner] error:', err?.message ?? err);
    return { mode: SCAN_MODE, status: 'api-error' };
  }
}
