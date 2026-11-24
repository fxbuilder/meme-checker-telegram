/**
 * src/pnl-render.mjs
 * Bridge to the PNG renderer.
 *
 * The renderer is a small Pillow script (scripts/render_pnl.py) invoked as a
 * child process. Reasons for that shape:
 *   - no rasteriser is installed for Node (sharp/resvg/canvas all absent) and
 *     adding a native dependency to a bot that otherwise has ONE dependency is a
 *     poor trade
 *   - Pillow is already present in this environment and emits a real PNG that
 *     Telegram displays inline
 *   - the payload is JSON over stdin, so the image can never disagree with the
 *     numbers the bot computed: one source of truth (callMetrics)
 *
 * FAILURE IS EXPLICIT
 * If python or Pillow is missing, this returns null and the caller sends the text
 * card. It never returns a path to a file that was not written.
 */

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { callMetrics, fmtMultiple, fmtSignedPercent } from './calls.mjs';
import { fmtUsd } from './card-layout.mjs';

const SCRIPT = path.resolve(import.meta.dirname, '../scripts/render_pnl.py');

/** Interpreters to try, in order. Configured one wins. */
function interpreters() {
  const custom = process.env.PNL_PYTHON;
  return [custom, 'python', 'python3'].filter(Boolean);
}

/**
 * Build the payload the renderer consumes. Derived from the SAME callMetrics the
 * text card uses, so the two surfaces cannot disagree.
 */
export function buildPnlPayload(call, { now = Date.now(), tokenName = null, groupTitle = null, logoUrl = null } = {}) {
  const m = callMetrics(call, now);
  return {
    name: tokenName ?? call.name ?? call.symbol ?? 'Token',
    symbol: call.symbol ? `$${call.symbol}` : '',
    chain: call.chain ?? '',
    caller: call.callerUsername ? `@${call.callerUsername}` : (call.callerName ?? 'unknown caller'),
    ageLabel: m.ageLabel ?? '',
    entryMarketCap: fmtUsd(m.entryMarketCapUsd) ?? '—',
    currentMarketCap: m.currentMarketCapUsd != null ? fmtUsd(m.currentMarketCapUsd) : 'not observed yet',
    peakMarketCap: m.peakIsObserved
      ? (fmtUsd(m.peakMarketCapUsd) ?? '—')
      : 'no higher observation',
    multiple: m.currentMultiple,
    multipleLabel: fmtMultiple(m.currentMultiple) ?? 'n/a',
    percent: fmtSignedPercent(m.currentPercent) ?? '',
    peakMultiple: m.peakIsObserved ? (fmtMultiple(m.peakMultiple) ?? null) : null,
    peakIsObserved: m.peakIsObserved,
    // Phase 2 image quality: group identity, labelled peak ROI, and project art.
    groupTitle: groupTitle ?? null,
    peakPercent: m.peakIsObserved ? (fmtSignedPercent(m.peakPercent) ?? null) : null,
    // Only an image we have already validated for THIS chain+contract is passed
    // here; the renderer re-checks it rather than trusting the URL blindly.
    logoUrl: logoUrl ?? null,
    calledAtLabel: call.calledAt ? new Date(call.calledAt).toISOString().slice(0, 10) : null,
  };
}

function runOnce(interp, outPath, payload) {
  return new Promise((resolve, reject) => {
    const child = spawn(interp, [SCRIPT, outPath], {
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
    let stderr = '';
    child.stderr.on('data', (d) => { stderr += d.toString(); });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code !== 0) return reject(new Error(`${interp} exited ${code}: ${stderr.slice(0, 300)}`));
      try {
        const st = fs.statSync(outPath);
        if (!st.size) return reject(new Error('renderer produced an empty file'));
      } catch {
        return reject(new Error('renderer did not write the output file'));
      }
      resolve(outPath);
    });
    child.stdin.on('error', () => { /* handled via close */ });
    child.stdin.end(JSON.stringify(payload));
  });
}

/**
 * Render a call to a PNG file.
 * @returns {Promise<string|null>} absolute path, or null when unavailable.
 */
export async function renderPnlPng(call, { now = Date.now(), tokenName = null, groupTitle = null, logoUrl = null } = {}) {
  if (!call) return null;
  if (!fs.existsSync(SCRIPT)) {
    console.warn('[pnl-render] renderer script missing:', SCRIPT);
    return null;
  }
  const payload = buildPnlPayload(call, { now, tokenName, groupTitle, logoUrl });
  const outPath = path.join(os.tmpdir(), `mc-pnl-${call.id}-${Date.now()}.png`);

  let lastErr = null;
  for (const interp of interpreters()) {
    try {
      const out = await runOnce(interp, outPath, payload);
      return out;
    } catch (err) {
      lastErr = err;
    }
  }
  console.warn('[pnl-render] PNG unavailable, caller should fall back to text:', lastErr?.message);
  return null;
}

/** Remove a rendered card once it has been sent. */
export function cleanupPng(filePath) {
  if (!filePath) return;
  try { fs.unlinkSync(filePath); } catch { /* best effort */ }
}
