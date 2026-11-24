/**
 * src/call-observer.mjs
 * Periodic observation of open calls, so "current" and "peak" stay real without
 * requiring someone to run /pnl.
 *
 * Designed for reuse: Phase 3 (Smart Alerts) needs exactly this stream — an event
 * whenever a call crosses a multiplier milestone. The observer therefore emits
 * structured events and does not send anything itself; a caller decides what to do
 * with them. That keeps alert policy out of the polling loop.
 *
 * COST CONTROL
 * - only ACTIVE calls inside MAX_PEAK_AGE_MS are observed
 * - a per-run cap bounds provider calls (default 8)
 * - a per-call cooldown stops one hot token being re-fetched every tick
 * - one observation per (chain, address) per run, even if several calls share it
 */

import { observeCall } from './call-service.mjs';
import { MAX_PEAK_AGE_MS, callMetrics } from './calls.mjs';
import { normaliseAddress, isSynthetic } from './store.mjs';

export const MILESTONES = [2, 3, 5, 10, 25, 50, 100];

/**
 * Highest milestone a multiple has crossed. Used for alert thresholds.
 * Returns null below 2x so a flat or losing call never reports a "milestone".
 */
export function crossedMilestone(multiple) {
  if (!Number.isFinite(multiple) || multiple < 2) return null;
  let best = null;
  for (const m of MILESTONES) if (multiple >= m) best = m;
  return best;
}

/**
 * One observation pass.
 *
 * @returns {{observed:number, skipped:number, failed:number, events:Array}}
 *   events: [{ type:'milestone'|'peak', call, multiple, milestone, previousMultiple }]
 */
export async function observePass({
  store,
  scan,
  now = Date.now(),
  maxCalls = 8,
  perCallCooldownMs = 5 * 60_000,
  maxAgeMs = MAX_PEAK_AGE_MS,
}) {
  const open = store.openCalls({ maxAgeMs, now }).filter((c) => !isSynthetic(c));

  // Respect a per-call cooldown so a busy group cannot cause a fetch storm.
  const due = open.filter((c) => !c.lastObservedAt || (now - c.lastObservedAt) >= perCallCooldownMs);

  // One provider call per distinct token per run.
  const seen = new Set();
  const targets = [];
  for (const c of due) {
    const key = `${c.chain}:${normaliseAddress(c.chain, c.address)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    targets.push({ key, calls: store.callsForToken(c.chatId, c.chain, c.address).filter((x) => x.status === 'active') });
    if (targets.length >= maxCalls) break;
  }

  let observed = 0;
  let failed = 0;
  let skipped = open.length - due.length;
  const events = [];

  for (const t of targets) {
    const lead = t.calls[0];
    if (!lead) continue;
    const before = new Map(t.calls.map((c) => [c.id, callMetrics(c, now).currentMultiple]));

    let result;
    try {
      result = await scan({ chain: lead.chain, address: lead.address });
    } catch (err) {
      failed += 1;
      console.warn(`[observer] scan failed for ${t.key}:`, err?.message ?? err);
      continue;
    }
    if (result?.status !== 'ok') {
      // A failed observation is not a price. Nothing is written.
      failed += 1;
      continue;
    }

    for (const call of t.calls) {
      const obs = await observeCall({ store, call, scanResult: result, now });
      if (!obs.updated) { failed += 1; continue; }
      observed += 1;

      const after = callMetrics(obs.call, now);
      const prevMultiple = before.get(call.id);
      const prevMilestone = crossedMilestone(prevMultiple);
      const nextMilestone = crossedMilestone(after.currentMultiple);

      if (obs.peakChanged && after.peakIsObserved) {
        events.push({
          type: 'peak',
          call: obs.call,
          multiple: after.currentMultiple,
          peakMultiple: after.peakMultiple,
          milestone: null,
          previousMultiple: prevMultiple,
        });
      }
      if (nextMilestone && nextMilestone !== prevMilestone) {
        events.push({
          type: 'milestone',
          call: obs.call,
          multiple: after.currentMultiple,
          peakMultiple: after.peakMultiple,
          milestone: nextMilestone,
          previousMultiple: prevMultiple,
        });
      }
    }
  }

  return { observed, skipped, failed, events };
}

/** Remaining open calls that this pass did not touch, for reporting. */
export function observationBacklog(store, { now = Date.now(), maxAgeMs = MAX_PEAK_AGE_MS } = {}) {
  return store.openCalls({ maxAgeMs, now }).filter((c) => !isSynthetic(c)).length;
}
