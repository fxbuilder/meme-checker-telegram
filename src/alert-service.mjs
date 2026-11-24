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
      await store.markAlertFailed(id, { reason: `429 retry_after=${retryAfterMs(err)}ms` });
      return { sent: false, reason: 'rate-limited', retryAfterMs: retryAfterMs(err) };
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
export async function processMilestoneEvents({
  store,
  call,
  currentMarketCapUsd,
  groupTitle,
  send,
  replyToMessageId,
  now = Date.now(),
  enabled = DEFAULT_MILESTONES,
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
  const list = Array.isArray(enabled) ? enabled : [];
  const newlyCrossed = list
    .filter((m) => Number.isFinite(m) && m <= reached)
    .sort((a, b) => a - b);

  const outcomes = [];
  for (const m of newlyCrossed) {
    const id = eventId.milestone(call.id, m);
    if (m === reached) {
      // The one that actually gets announced.
      const text = renderMilestoneAlert({ call, milestone: m, currentMarketCapUsd, groupTitle, now });
      const res = await deliverAlert({ store, call, id, text, send, groupTitle, replyToMessageId, now });
      outcomes.push({ milestone: m, announced: res.sent, reason: res.reason });
    } else {
      // Suppressed, but marked so a later observation cannot resurrect it.
      const claimed = await store.claimAlert(id, {
        type: 'milestone', callId: call.id, chatId: String(call.chatId),
        chain: call.chain, address: call.address,
      });
      if (claimed.claimed) {
        await store.setAlertState(id, {
          state: 'delivered',
          suppressedBy: eventId.milestone(call.id, reached),
          deliveredAt: now,
          messageId: null,
        });
      }
      outcomes.push({ milestone: m, announced: false, reason: 'consolidated into higher milestone' });
    }
  }
  return outcomes;
}

/** Dex Paid transition. Only a transition INTO 'paid' is announced. */
export async function processDexPaid({ store, call, status, detail, send, now = Date.now() }) {
  const id = eventId.dexPaid(call.id);
  const prev = store.alertState(id);
  const previousStatus = prev?.lastStatus ?? null;

  // Record the status every time, so the next comparison is meaningful.
  await store.setAlertState(id, { lastStatus: status, lastCheckedAt: now, detail: detail ?? null });

  if (status !== 'paid') return { announced: false, reason: `status ${status}` };
  if (previousStatus === 'paid') return { announced: false, reason: 'already paid' };
  // First ever observation already paid: record silently, do not claim a payment
  // event that may predate the call.
  if (previousStatus == null) return { announced: false, reason: 'already paid at first observation' };

  const text = renderDexPaidAlert({ call, status, detail, now });
  const res = await deliverAlert({ store, call, id: `${id}:event:${now}`, text, send, now });
  return { announced: res.sent, reason: res.reason };
}

/** Migration. Only verified evidence is announced, once per call. */
export async function processMigration({ store, call, evidence, send, now = Date.now() }) {
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
export async function processMovement({ store, call, kind, changePercent, windowLabel, currentMarketCapUsd, peakMarketCapUsd, send, now = Date.now(), bucketMs = 15 * 60_000 }) {
  const bucket = Math.floor(now / bucketMs);
  const id = kind === 'drawdown'
    ? eventId.drawdown(call.id, Math.round(changePercent))
    : (kind === 'pump' ? eventId.pump(call.id, bucket) : eventId.dump(call.id, bucket));

  const text = renderMovementAlert({ call, kind, changePercent, windowLabel, currentMarketCapUsd, peakMarketCapUsd, now });
  const res = await deliverAlert({ store, call, id, text, send, now });
  return { announced: res.sent, reason: res.reason };
}
