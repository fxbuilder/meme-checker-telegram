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
import { MAX_PEAK_AGE_MS, callMetrics, pollIntervalFor, pollTierFor } from './calls.mjs';
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
  force = false,
}) {
  // maxAgeMs defaults to Infinity: old calls stay tracked, just less often.
  const open = store.openCalls({ maxAgeMs, now }).filter((c) => !isSynthetic(c));

  // Adaptive cadence: each call is due when its age-based interval has elapsed.
  // A hot call polls every few minutes; a month-old call polls daily. This is the
  // Phase 3 scheduler's cost model, expressed here so it can be tested now.
  const due = force ? open : open.filter((c) => {
    // A call that has NEVER been observed is always due: waiting a full interval
    // after creation would leave a brand-new call with no current price, and no
    // alert could fire until the second interval.
    if (!Number.isFinite(c.lastObservedAt)) return true;
    const age = now - c.calledAt;
    const interval = pollIntervalFor(age);
    // The cooldown guards against re-polling the same token too often; it must not
    // delay the FIRST observation, hence the branch above.
    return (now - c.lastObservedAt) >= Math.max(interval, 0);
  });

  // One provider call per distinct token per run.
  const seen = new Set();
  const targets = [];
  for (const c of due) {
    const key = `${c.chain}:${normaliseAddress(c.chain, c.address)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    // One provider request, but EVERY group tracking this contract gets the
    // observation: the dedupe above is about avoiding duplicate API calls, not
    // about updating only the first group that happened to be seen.
    const sameToken = store.doc.calls.filter((c) => c.status === 'active'
      && !isSynthetic(c)
      && c.chain === c.chain
      && normaliseAddress(c.chain, c.address) === normaliseAddress(c.chain, c.address)
      && `${c.chain}:${normaliseAddress(c.chain, c.address)}` === key);
    targets.push({ key, calls: sameToken });
    if (targets.length >= maxCalls) break;
  }

  let observed = 0;
  let failed = 0;
  let skipped = open.length - due.length;
  const events = [];
  /** The exact records this pass wrote, so callers never infer it from timestamps. */
  const updatedCalls = [];

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
      updatedCalls.push(obs.call);

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

  const tiers = { hot: 0, warm: 0, cold: 0 };
  for (const c of open) tiers[pollTierFor(now - c.calledAt)] += 1;

  return { observed, skipped, failed, events, open: open.length, tiers, updatedCalls };
}

/** Remaining open calls that this pass did not touch, for reporting. */
export function observationBacklog(store, { now = Date.now(), maxAgeMs = MAX_PEAK_AGE_MS } = {}) {
  return store.openCalls({ maxAgeMs, now }).filter((c) => !isSynthetic(c)).length;
}
