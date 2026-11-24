/**
 * src/alert-service.mjs
 * Decide whether an alert may be sent, send it, record the outcome.
 *
 * DELIVERY GUARANTEE (stated honestly)
 * Telegram's API has no exactly-once primitive. The model here is:
 *
 *   1. CLAIM the event id synchronously before sending. Only one claim wins.
 *   2. Send.
 *   3. Record 'delivered' with the message id, or 'failed' / 'ambiguous'.
 *
 * That gives AT-MOST-ONCE delivery: a crash between 2 and 3 leaves the row
 * 'pending', and it is never retried automatically. We accept a possible missed
 * alert over a possible duplicate alert, because a duplicate "JUST HIT 5X" in a
 * group is visibly wrong and a missed one is invisible.
 *
 * A Telegram error we can classify as "never sent" (400/403, bot blocked, chat
 * not found) is recorded 'failed' and MAY be retried later. A network error after
 * the request was written is 'ambiguous' and is not retried.
 */

import { mintCallerToken, DEFAULT_PERIOD } from './deep-link.mjs';
import { isSynthetic } from './store.mjs';
import {
  eventId, renderMilestoneAlert, renderDexPaidAlert, renderMigrationAlert,
  renderMovementAlert, highestReachedMilestone, DEFAULT_MILESTONES, retryAfterMs,
} from './alerts.mjs';

/** Errors that prove the message was NOT delivered. */
function isDefiniteFailure(err) {
  const code = Number(err?.response?.error_code ?? err?.code ?? 0);
  if (code >= 400 && code < 500 && code !== 429) return true;
  const desc = String(err?.description ?? err?.message ?? '').toLowerCase();
  return /chat not found|bot was blocked|not enough rights|chat_write_forbidden|message is too long/.test(desc);
}

/** Telegram rate limiting, worth waiting out. */
export function isRateLimited(err) {
  const code = Number(err?.response?.error_code ?? err?.code ?? 0);
  return code === 429;
}

/**
 * Send one alert, with claim/dedupe.
 *
 * @returns {{sent:boolean, reason?:string, messageId?:number}}
 */
export async function deliverAlert({
  store,
  call,
  id,
  text,
  send,
  groupTitle = null,
  replyToMessageId = null,
  now = Date.now(),
}) {
  if (!text) return { sent: false, reason: 'empty text' };

  // Re-read eligibility from the store immediately before sending. A call may have
  // been cancelled while this cycle was working through other tokens; the captured
  // object would otherwise still look active and we would alert on a withdrawn call.
  if (call?.id) {
    store.load();
    const fresh = store.doc.calls.find((c) => c?.id === call.id);
    if (fresh && (fresh.status !== 'active' || isSynthetic(fresh))) {
      return { sent: false, reason: `call is ${fresh.status}` };
    }
  }

  const claim = await store.claimAlert(id, {
    type: id.split(':')[1] ?? 'alert',
    callId: call?.id ?? null,
    chatId: String(call?.chatId ?? ''),
    chain: call?.chain ?? null,
    address: call?.address ?? null,
  });
  if (!claim.claimed) {
    return { sent: false, reason: `already ${claim.existing?.state ?? 'claimed'}` };
  }

  try {
    const msg = await send({
      chatId: call.chatId,
      text,
      replyToMessageId,
    });
    const messageId = msg?.message_id ?? null;
    await store.markAlertDelivered(id, { messageId, at: now });
    return { sent: true, messageId };
  } catch (err) {
    if (isRateLimited(err)) {
      // Nothing was delivered and we know why. Safe to retry later.
      const waitMs = retryAfterMs(err);
      await store.markAlertFailed(id, { reason: `429 retry_after=${waitMs}ms` });
      // Persist the deadline so a later claim respects it instead of retrying at once.
      await store.setAlertState(id, { retryAt: Date.now() + waitMs });
      return { sent: false, reason: 'rate-limited', retryAfterMs: waitMs };
    }
    if (isDefiniteFailure(err)) {
      await store.markAlertFailed(id, { reason: String(err?.description ?? err?.message ?? 'send failed').slice(0, 200) });
      return { sent: false, reason: 'delivery-rejected' };
    }
    // Unknown outcome. Do NOT retry: a duplicate is worse than a gap.
    await store.markAlertFailed(id, {
      reason: `ambiguous: ${String(err?.message ?? err).slice(0, 160)}`,
      ambiguous: true,
    });
    return { sent: false, reason: 'ambiguous' };
  }
}

/**
 * Process the milestone events an observation produced.
 *
 * Consolidation rule: for one call in one observation, send only the HIGHEST
 * newly reached enabled milestone. The others are recorded as delivered so they
 * can never fire later — the group already knows the token passed them.
 */
/**
 * Mint the signed Caller Profile token for this call's caller, scoped to the call's own
 * group. Returns null when the call has no usable caller identity, so the alert renders
 * a plain name instead of a link that would open the wrong profile.
 *
 * The period is the shared DEFAULT_PERIOD (1D), so an alert link behaves exactly like a
 * First Caller link: same scope, same default window, same authorisation.
 */
export function callerTokenFor(store, call) {
  try {
    if (!call?.callerKey) return null;
    return mintCallerToken(String(call.chatId), call.callerKey, DEFAULT_PERIOD);
  } catch {
    return null;
  }
}

export async function processMilestoneEvents({
  store,
  call,
  currentMarketCapUsd,
  groupTitle,
  send,
  replyToMessageId,
  now = Date.now(),
  enabled = DEFAULT_MILESTONES,
  /** Bot username needed to build a t.me deep link. Empty disables linking. */
  botUsername = '',
}) {
  const entry = call.entryMarketCapUsd;
  if (!Number.isFinite(entry) || entry <= 0) return [];
  if (!Number.isFinite(currentMarketCapUsd)) return [];

  // NEVER ANNOUNCE AN UNCONFIRMED RETURN.
  // When the latest observation is an extreme jump that is still awaiting
  // corroboration, observeCall() deliberately leaves peakMarketCapUsd alone and
  // records a pendingPeak instead. Alerting on the raw lastMarketCapUsd would
  // announce a number we have explicitly not trusted yet.
  if (call.pendingPeak && Number.isFinite(call.pendingPeak.marketCapUsd)
      && currentMarketCapUsd >= call.pendingPeak.marketCapUsd * 0.99) {
    return [{ milestone: null, announced: false, reason: 'observation awaiting confirmation' }];
  }

  const multiple = currentMarketCapUsd / entry;
  const reached = highestReachedMilestone(multiple, enabled);
  if (reached == null) return [];

  // Every enabled milestone at or below `reached` counts as crossed now.
  const list = Array.isArray(enabled) ? enabled.filter((m) => Number.isFinite(m)) : [];
  const newlyCrossed = list
    .filter((m) => Number.isFinite(m) && m <= reached)
    .sort((a, b) => a - b);

  const outcomes = [];

  // ORDER MATTERS. The highest milestone is attempted FIRST, and the lower ones are
  // only suppressed once it has actually been delivered. Suppressing them first meant
  // a rejected announcement left 2x/5x marked delivered while the group received
  // nothing at all — every milestone silently lost.
  const topId = eventId.milestone(call.id, reached);
  const topText = renderMilestoneAlert({
    call, milestone: reached, currentMarketCapUsd, groupTitle, now,
    botUsername, callerToken: callerTokenFor(store, call),
  });
  const top = await deliverAlert({ store, call, id: topId, text: topText, send, groupTitle, replyToMessageId, now });
  outcomes.push({ milestone: reached, announced: top.sent, reason: top.reason });

  if (!top.sent) {
    // Leave the lower milestones untouched: a later observation can still alert them,
    // so the group is not left with a pure gap.
    for (const m of newlyCrossed) {
      if (m !== reached) outcomes.push({ milestone: m, announced: false, reason: 'held: higher milestone not delivered' });
    }
    return outcomes;
  }

  for (const m of newlyCrossed) {
    if (m === reached) continue;
    const id = eventId.milestone(call.id, m);
    const claimed = await store.claimAlert(id, {
      type: 'milestone', callId: call.id, chatId: String(call.chatId),
      chain: call.chain, address: call.address,
    });
    if (claimed.claimed) {
      await store.setAlertState(id, {
        state: 'delivered',
        suppressedBy: topId,
        deliveredAt: now,
        messageId: null,
      });
    }
    outcomes.push({ milestone: m, announced: false, reason: 'consolidated into higher milestone' });
  }
  return outcomes;
}

/** Dex Paid transition. Only a transition INTO 'paid' is announced. */
export async function processDexPaid({ store, call, status, detail, send, now = Date.now(), botUsername = '' }) {
  const id = eventId.dexPaid(call.id);
  const prev = store.alertState(id);
  const confirmedStatus = prev?.lastStatus ?? null;

  await store.setAlertState(id, { lastCheckedAt: now, detail: detail ?? null });

  // An outage is NOT a status change. Overwriting the last confirmed status with
  // 'unknown' made 'paid -> unknown(503) -> paid' look like a fresh payment and
  // produced a false announcement. Only a real observation updates the baseline.
  if (status === 'unknown') {
    return { announced: false, reason: 'provider unavailable (status unchanged)' };
  }

  const isBetter = status === 'paid';
  if (!isBetter) {
    await store.setAlertState(id, { lastStatus: status });
    return { announced: false, reason: `status ${status}` };
  }
  if (confirmedStatus === 'paid') return { announced: false, reason: 'already paid' };
  // First ever observation already paid: record silently rather than claim a
  // payment event that may predate the call.
  if (confirmedStatus == null) {
    await store.setAlertState(id, { lastStatus: 'paid' });
    return { announced: false, reason: 'already paid at first observation' };
  }

  // A stable event id per transition so a rejected delivery can be retried without
  // re-detecting the transition (which would return 'already paid' and never retry).
  const eventKey = `${id}:transition:${confirmedStatus}->paid`;
  const text = renderDexPaidAlert({ call, status, detail, now });
  const res = await deliverAlert({ store, call, id: eventKey, text, send, now });
  if (res.sent) await store.setAlertState(id, { lastStatus: 'paid' });
  return { announced: res.sent, reason: res.reason };
}

/**
 * Retry any Dex Paid transition that was detected but not delivered.
 * Runs each cycle so an alert rejected by a transient error is not lost.
 */
export async function retryPendingDexPaid({ store, calls, send, now = Date.now() }) {
  let sent = 0;
  for (const call of calls) {
    const id = eventId.dexPaid(call.id);
    const st = store.alertState(id);
    if (!st) continue;
    const key = Object.keys(store.doc.alerts).find((k) => k.startsWith(`${id}:transition:`) && store.doc.alerts[k].state === 'failed');
    if (!key) continue;
    await store.setAlertState(id, { lastStatus: st.confirmedBefore ?? st.lastStatus });
    const text = renderDexPaidAlert({ call, status: 'paid', detail: st.detail, now });
    const res = await deliverAlert({ store, call, id: key, text, send, now });
    if (res.sent) { sent += 1; await store.setAlertState(id, { lastStatus: 'paid' }); }
  }
  return { retried: sent };
}

/** Migration. Only verified evidence is announced, once per call. */
export async function processMigration({ store, call, evidence, send, now = Date.now(), botUsername = '' }) {
  const id = eventId.migration(call.id);
  const prev = store.alertState(id);
  if (prev?.state === 'delivered') return { announced: false, reason: 'already announced' };
  if (!evidence?.verified) {
    await store.setAlertState(id, { lastCheckedAt: now, unverified: evidence?.note ?? null });
    return { announced: false, reason: 'no verified evidence' };
  }
  const text = renderMigrationAlert({ call, evidence, now });
  const res = await deliverAlert({ store, call, id, text, send, now });
  return { announced: res.sent, reason: res.reason };
}

/** Price movement / drawdown, with a per-window bucket id so re-arms are bounded. */
export async function processMovement({
  store, call, kind, changePercent, windowLabel, currentMarketCapUsd,
  peakMarketCapUsd, send, now = Date.now(), bucketMs = 15 * 60_000, botUsername = '',
}) {
  const bucket = Math.floor(now / bucketMs);
  const id = kind === 'drawdown'
    ? eventId.drawdown(call.id, Math.round(changePercent))
    : (kind === 'pump' ? eventId.pump(call.id, bucket) : eventId.dump(call.id, bucket));

  const text = renderMovementAlert({
    call, kind, changePercent, windowLabel, currentMarketCapUsd, peakMarketCapUsd, now,
    botUsername, callerToken: callerTokenFor(store, call),
  });
  const res = await deliverAlert({ store, call, id, text, send, now });
  return { announced: res.sent, reason: res.reason };
}
