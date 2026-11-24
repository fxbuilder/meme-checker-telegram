/**
 * src/observer-loop.mjs
 * The Phase 3 background scheduler.
 *
 * RUNS INSIDE THE BOT PROCESS. It is started by the normal `npm start`; there is
 * no separate worker command. Ctrl+C stops both, because the loop honours an
 * AbortSignal and the bot's shutdown signal aborts it.
 *
 * DESIGN RULES
 *   - one cycle at a time; a slow provider never leads to overlapping cycles
 *   - bounded provider concurrency, so a large book does not open 50 sockets
 *   - one fetch per canonical (chain, contract) per cycle, shared by every group
 *   - adaptive interval per call age (hot/warm/cold), never a fixed hammer
 *   - a provider failure writes NOTHING; it is not a price of zero
 *   - 429 backs off the whole cycle with the server's retry_after
 *   - every alert goes through the store's claim(), so restarts cannot re-send
 *
 * The loop is deliberately plain: a sleep, a pass, repeat. No queue library, no
 * cron parser, nothing that needs explaining at 3am.
 */

import { observePass } from './call-observer.mjs';
import { processMilestoneEvents, processDexPaid, processMovement } from './alert-service.mjs';
import { fetchDexPaid } from './dex-paid.mjs';
import { defaultGroupSettings } from './store.mjs';

/** Sleep that can be interrupted by shutdown. */
export function sleep(ms, signal) {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve('aborted');
    const t = setTimeout(() => {
      cleanup();
      resolve('timeout');
    }, Math.max(0, ms));
    const onAbort = () => {
      cleanup();
      resolve('aborted');
    };
    function cleanup() {
      clearTimeout(t);
      signal?.removeEventListener('abort', onAbort);
    }
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/**
 * Simple bounded-concurrency map. Results keep input order.
 * A rejected task yields `{ error }` rather than killing the batch.
 */
export async function mapBounded(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    for (;;) {
      const i = next;
      next += 1;
      if (i >= items.length) return;
      try {
        out[i] = { value: await fn(items[i], i) };
      } catch (err) {
        out[i] = { error: err };
      }
    }
  });
  await Promise.all(workers);
  return out;
}

/** Exponential backoff with a cap: 1s, 2s, 4s, ... max. */
export function backoffMs(attempt, { base = 1_000, max = 60_000 } = {}) {
  const exp = Math.min(max, base * 2 ** Math.max(0, attempt - 1));
  // Jitter stops a fleet of observers retrying in lockstep.
  return Math.round(exp * (0.8 + Math.random() * 0.4));
}

/** Group settings with alert defaults filled in for pre-Phase-3 rows. */
export function alertSettings(store, chatId) {
  const g = store.groupSettings(chatId);
  const d = defaultGroupSettings(chatId).alerts;
  // Merge so a group created before Phase 3 gets sane defaults without a write.
  return { ...d, ...(g.alerts ?? {}) };
}

/**
 * One full cycle: observe market, then evaluate alerts.
 *
 * @returns {Promise<object>} a summary suitable for one log line
 */
export async function runCycle({
  store,
  scan,
  send,
  now = Date.now(),
  maxCalls = 12,
  concurrency = 3,
  dexPaid = fetchDexPaid,
  fetchImpl = globalThis.fetch,
  log = console,
  force = false,
  dexPaidEveryMs = 15 * 60_000,
}) {
  // The market pass already dedupes to one fetch per (chain, address) and
  // distributes to every group's call. Alerts are evaluated per call afterwards.
  const pass = await observePass({ store, scan, now, maxCalls, force });

  let milestones = 0;
  let dexPaidAlerts = 0;
  let movementAlerts = 0;
  const failures = [];

  // Re-read the calls this pass touched.
  const touched = store.openCalls({ now }).filter((c) => c.lastObservedAt && now - c.lastObservedAt < 60_000);

  for (const call of touched) {
    const s = alertSettings(store, call.chatId);
    if (!s.multiplier) continue;
    try {
      const out = await processMilestoneEvents({
        store,
        call,
        currentMarketCapUsd: call.lastMarketCapUsd,
        groupTitle: store.doc.groups?.[String(call.chatId)]?.title ?? null,
        send,
        replyToMessageId: call.messageId ?? null,
        now,
        enabled: s.milestones ?? [],
      });
      milestones += out.filter((o) => o.announced).length;
    } catch (err) {
      failures.push({ kind: 'milestone', callId: call.id, message: String(err?.message ?? err) });
    }
  }

  // Dex Paid is a slow-moving signal: poll it far less often than price.
  const dueForPaid = store.openCalls({ now }).filter((c) => {
    const s = alertSettings(store, c.chatId);
    if (!s.dexPaid) return false;
    const prev = store.alertState(`${c.id}:dex-paid`);
    const last = prev?.lastCheckedAt ?? 0;
    return now - last >= dexPaidEveryMs;
  });

  const paidResults = await mapBounded(dueForPaid, concurrency, async (call) => {
    const res = await dexPaid(call.chain, call.address, { fetchImpl });
    const out = await processDexPaid({
      store, call, status: res?.status ?? 'unknown', detail: res?.detail, send, now,
    });
    return out.announced ? 1 : 0;
  });
  for (const r of paidResults) {
    if (r?.value) dexPaidAlerts += r.value;
    if (r?.error) failures.push({ kind: 'dex-paid', message: String(r.error?.message ?? r.error) });
  }

  // Price movement alerts, only where the group enabled them and we have two
  // real observations to compare.
  for (const call of touched) {
    const s = alertSettings(store, call.chatId);
    if (!s.priceMovement) continue;
    try {
      const mv = detectMovement(call, { now, settings: s, store });
      if (!mv) continue;
      const out = await processMovement({
        store, call,
        kind: mv.kind,
        changePercent: mv.changePercent,
        windowLabel: mv.windowLabel,
        currentMarketCapUsd: call.lastMarketCapUsd,
        peakMarketCapUsd: call.peakMarketCapUsd,
        send, now,
      });
      if (out.announced) movementAlerts += 1;
    } catch (err) {
      failures.push({ kind: 'movement', callId: call.id, message: String(err?.message ?? err) });
    }
  }

  return {
    observed: pass.observed,
    failed: pass.failed,
    skipped: pass.skipped,
    open: pass.open,
    tiers: pass.tiers,
    milestones,
    dexPaidAlerts,
    movementAlerts,
    failures,
  };
}

/**
 * Compare the newest observation against a previous one inside the configured
 * window. Returns null when there is no trustworthy comparison.
 *
 * Requires an actual earlier observation with a timestamp inside the window —
 * a 15-minute move cannot be computed from a sample taken 3 hours ago, and
 * inventing one would produce false alerts.
 */
export function detectMovement(call, { now, settings, store }) {
  const cur = call.lastMarketCapUsd;
  if (!Number.isFinite(cur) || !Number.isFinite(call.lastObservedAt)) return null;

  // Drawdown is measured against the verified post-call peak, not the last sample.
  const peak = call.peakMarketCapUsd;
  if (settings.drawdownPercent && Number.isFinite(peak) && peak > 0) {
    const drop = ((cur - peak) / peak) * 100;
    if (drop <= -Math.abs(settings.drawdownPercent)) {
      return {
        kind: 'drawdown',
        changePercent: drop,
        windowLabel: 'from peak',
      };
    }
  }

  const hist = call.recentObservations;
  if (!Array.isArray(hist) || hist.length < 2) return null;
  const prev = hist[hist.length - 2];
  if (!Number.isFinite(prev?.marketCapUsd) || !Number.isFinite(prev?.at)) return null;
  const windowMs = Math.min(settings.pumpWindowMs ?? 0, settings.dumpWindowMs ?? 0);
  if (!windowMs) return null;
  if (now - prev.at > windowMs) return null;

  const change = ((cur - prev.marketCapUsd) / prev.marketCapUsd) * 100;
  const mins = Math.max(1, Math.round((now - prev.at) / 60_000));
  if (settings.pumpPercent && change >= Math.abs(settings.pumpPercent)) {
    return { kind: 'pump', changePercent: change, windowLabel: `${mins}m` };
  }
  if (settings.dumpPercent && change <= -Math.abs(settings.dumpPercent)) {
    return { kind: 'dump', changePercent: change, windowLabel: `${mins}m` };
  }
  return null;
}

/**
 * Start the background observer.
 *
 * Returns a controller with stop() so the bot can shut it down on Ctrl+C.
 * Never throws into the caller: a fatal cycle error is logged and the loop
 * continues after a backoff, because a monitoring hiccup must not kill the bot.
 */
export function startObserver({
  store,
  scan,
  send,
  intervalMs = 20_000,
  maxCalls = 12,
  concurrency = 3,
  dexPaid,
  fetchImpl,
  log = console,
  signal = null,
  runCycleFn = runCycle,
} = {}) {
  const controller = new AbortController();
  let stopped = false;
  let cycles = 0;
  let consecutiveFailures = 0;
  let lastSummary = null;

  const abort = () => {
    stopped = true;
    controller.abort();
  };
  signal?.addEventListener('abort', abort, { once: true });

  const loop = (async () => {
    log.log(`[observer] started · interval=${Math.round(intervalMs / 1000)}s · maxTokensPerCycle=${maxCalls} · concurrency=${concurrency}`);
    while (!stopped) {
      const startedAt = Date.now();
      cycles += 1;
      try {
        const summary = await runCycleFn({
          store, scan, send, maxCalls, concurrency, dexPaid, fetchImpl, log, now: startedAt,
        });
        lastSummary = summary;
        consecutiveFailures = 0;

        // One line per cycle, and only when something happened. A quiet cycle
        // with nothing due would otherwise spam the terminal every 20s.
        const didWork = summary.observed || summary.milestones || summary.dexPaidAlerts || summary.failures.length;
        if (didWork) {
          log.log(
            `[observer] cycle ${cycles} · open=${summary.open} `
            + `(hot=${summary.tiers.hot} warm=${summary.tiers.warm} cold=${summary.tiers.cold}) `
            + `· observed=${summary.observed} failed=${summary.failed} skipped=${summary.skipped} `
            + `· alerts: milestone=${summary.milestones} dexpaid=${summary.dexPaidAlerts} movement=${summary.movementAlerts}`,
          );
        }
        for (const f of summary.failures.slice(0, 3)) {
          log.warn(`[observer] ${f.kind} failed${f.callId ? ` (${f.callId})` : ''}: ${f.message}`);
        }
      } catch (err) {
        consecutiveFailures += 1;
        const wait = backoffMs(consecutiveFailures);
        log.error(`[observer] cycle error (attempt ${consecutiveFailures}): ${err?.message ?? err} — backing off ${wait}ms`);
        if (err?.code === 429 || /429|too many requests/i.test(String(err?.message ?? ''))) {
          await sleep(Math.max(wait, 30_000), controller.signal);
          continue;
        }
        await sleep(wait, controller.signal);
        continue;
      }

      const elapsed = Date.now() - startedAt;
      const wait = Math.max(1_000, intervalMs - elapsed);
      if ((await sleep(wait, controller.signal)) === 'aborted') break;
    }
    log.log(`[observer] stopped after ${cycles} cycle(s)`);
  })();

  return {
    stop: abort,
    get cycles() { return cycles; },
    get lastSummary() { return lastSummary; },
    done: loop,
  };
}
