/**
 * src/scanner.mjs
 * Thin scan dispatcher: routes to mock or live backend based on SCAN_MODE env.
 *
 * `live` uses src/live-scan.mjs — real, keyless market data. That is NOT the
 * Core Backend API; the Core contract is still unconfirmed and the project rule
 * is to never call a guessed live path. See src/live-scan.mjs and
 * docs/backend-contract-checklist.md.
 */
import { mockScan } from './mock-scan.mjs';
import { liveScan } from './live-scan.mjs';

const SCAN_MODE = process.env.SCAN_MODE ?? 'mock';

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
