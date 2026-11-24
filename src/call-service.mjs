/**
 * src/call-service.mjs
 * Orchestration for call tracking: record, observe, render.
 *
 * Kept separate from src/bot.mjs so the logic is testable without Telegraf and so
 * Phase 3 (alerts) and Phase 6 (leaderboard) can reuse it without importing the
 * bot. This module owns every write to the call store.
 *
 * INVARIANTS
 *  - a call is recorded only from a validated entry (see calls.validateEntry)
 *  - the first call for (chat, chain, address) owns attribution; later calls by
 *    other members are recorded but never steal "first caller"
 *  - observations never lower the peak, and an implausible jump is rejected
 *  - nothing writes when the scan failed
 */

import { validateEntry, buildCallRecord, nextPeak, callMetrics, detectMigration } from './calls.mjs';
import { renderPnlText } from './pnl-card.mjs';

/** Outcome vocabulary, so callers branch instead of guessing. */
export const CALL_STATUS = {
  RECORDED: 'recorded',
  DUPLICATE: 'duplicate',        // same user, same token, inside the dedup window
  INVALID: 'invalid',            // scan unusable
  LOW_MCAP: 'low-mcap',          // below the group's minimum
  NOT_FOUND: 'not-found',        // token not found on chain
  ERROR: 'error',
};

/**
 * Attempt to record a call.
 * @param {object} args
 * @param {import('./store.mjs').CallStore} args.store
 * @param {object} args.scanResult  a completed scan result
 * @param {object} args.caller      { id, displayName, username }
 * @param {string|number} args.chatId
 * @param {'manual'|'auto'} args.source
 * @param {number} [args.now]
 * @param {number} [args.duplicateWindowMs]
 */
export async function recordCall({
  store,
  scanResult,
  caller,
  chatId,
  source = 'manual',
  now = Date.now(),
  duplicateWindowMs = 10 * 60_000,
  messageId = null,
}) {
  const check = validateEntry(scanResult);
  if (!check.ok) {
    const status = scanResult?.status === 'not-found' ? CALL_STATUS.NOT_FOUND : CALL_STATUS.INVALID;
    return { status, reason: check.reason };
  }
  const { entry } = check;

  const settings = store.groupSettings(chatId);
  if (Number.isFinite(settings.minMarketCapUsd) && entry.entryMarketCapUsd < settings.minMarketCapUsd) {
    return {
      status: CALL_STATUS.LOW_MCAP,
      reason: `market cap ${entry.entryMarketCapUsd} is below this group's $${settings.minMarketCapUsd} minimum`,
      entryMarketCapUsd: entry.entryMarketCapUsd,
    };
  }

  // Duplicate protection: the same member re-calling the same token in a short
  // window is almost always a double-tap or a re-paste, not a new call.
  const dup = store.recentCallByUser(chatId, entry.chain, entry.address, caller.id, duplicateWindowMs, now);
  if (dup) {
    return { status: CALL_STATUS.DUPLICATE, reason: 'this caller already called this token recently', call: dup };
  }

  const record = buildCallRecord({
    chatId,
    userId: caller.id,
    displayName: caller.displayName,
    username: caller.username,
    entry,
    source,
    messageId,
    now,
  });

  // First-caller attribution is decided BEFORE insert, from persisted history.
  const prior = store.firstCall(chatId, entry.chain, entry.address);
  const saved = await store.addCall(record);

  return {
    status: CALL_STATUS.RECORDED,
    call: saved,
    isFirstCall: prior == null,
    firstCall: prior ?? saved,
    entryMarketCapUsd: entry.entryMarketCapUsd,
  };
}

/**
 * Apply a fresh observation to one call.
 * Used by /pnl (refresh) and by the periodic observer.
 */
export async function observeCall({ store, call, scanResult, now = Date.now(), extremeMultiple = 50, verifyExtreme = null }) {
  if (!call) return { updated: false, reason: 'no call' };
  if (scanResult?.status !== 'ok') {
    // A failed scan is not a price of zero; record nothing.
    return { updated: false, reason: `scan ${scanResult?.status ?? 'failed'}` };
  }
  const mcap = scanResult.market?.marketCapUsd;
  if (!Number.isFinite(mcap)) return { updated: false, reason: 'no market cap in observation' };

  const migration = detectMigration(call, scanResult);

  // Independent-evidence check for an extreme observation. A single provider
  // reporting a 200x jump could be a wrong pair or a unit error; a second
  // source agreeing on the same order of magnitude is what makes it real.
  let corroboration = null;
  if (typeof verifyExtreme === 'function') {
    const mult = mcap / call.entryMarketCapUsd;
    if (mult > extremeMultiple) {
      corroboration = await verifyExtreme({ chain: call.chain, address: call.address, observedMcap: mcap }).catch(() => null);
    }
  }

  const peak = nextPeak(call, mcap, { now, extremeMultiple, ...(corroboration?.confirm ? { requiredConfirmations: 1 } : {}) });

  const patch = {
    lastMarketCapUsd: mcap,
    lastObservedAt: now,
    peakMarketCapUsd: peak.peakMarketCapUsd,
    peakAt: peak.peakAt,
  };

  // Persist or clear the pending extreme candidate so confirmation survives a
  // restart and cannot be re-earned by the same single reading.
  if (peak.pending) {
    patch.pendingPeak = {
      marketCapUsd: peak.candidate,
      firstSeenAt: call.pendingPeak?.firstSeenAt ?? now,
      confirmations: peak.confirmations,
      required: peak.required,
      lastSeenAt: now,
    };
  } else if (peak.changed) {
    patch.pendingPeak = null;
  }
  if (corroboration) patch.extremeCorroboration = corroboration;
  if (migration.migrated) {
    patch.notes = [call.notes, migration.liquidityCollapsed ? 'liquidity collapsed' : null,
      migration.pairChanged ? 'primary pool changed' : null].filter(Boolean).join('; ');
    patch.migrationSuspected = true;
  }

  const updated = await store.updateCall(call.id, patch);
  return {
    updated: true,
    call: updated,
    peakChanged: peak.changed,
    peakRejected: peak.rejected ?? null,
    migration,
  };
}

/** Render the text PnL card for a stored call. */
export function pnlText(call, { now = Date.now() } = {}) {
  return renderPnlText(call, { now });
}

/** Resolve which call a /pnl or /fc argument refers to. */
export function resolveCall(store, chatId, { chain = null, address = null, index = null, list = null } = {}) {
  const calls = list ?? store.callsForChat(chatId, { limit: 50 });
  if (!calls.length) return null;
  if (chain && address) {
    return calls.find((c) => c.chain === chain && c.address === address) ?? store.firstCall(chatId, chain, address);
  }
  if (Number.isInteger(index)) {
    // 1-based, newest first, matching how /calls numbers the list.
    return calls[index - 1] ?? null;
  }
  return calls[0] ?? null;
}

export { callMetrics };
