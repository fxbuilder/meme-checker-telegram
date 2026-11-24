/**
 * src/alerts.mjs
 * Alert identities, thresholds and Telegram message text.
 *
 * SEPARATION OF CONCERNS
 *   alerts.mjs        — what an alert IS and how it reads (pure, no I/O)
 *   alert-service.mjs — whether it may be sent (dedupe via store) and sending it
 *   observer-loop.mjs — when observation happens (scheduling)
 *
 * Keeping the text pure means the whole alert surface is testable without a
 * provider, a clock or Telegram.
 *
 * EVENT IDS ARE THE DEDUPE KEY
 * An alert is identified by (call, kind, value) — never by "the latest whatever".
 * Two observers racing, or a restart mid-delivery, therefore converge on the same
 * id and the store's claim() decides the winner once.
 */

import { fmtUsd } from './card-layout.mjs';
import { timeAgo } from './calls.mjs';
import { getChain } from './chains.mjs';
import { callerLabel } from './caller-identity.mjs';

/** Every milestone the product supports. Groups enable a subset. */
export const ALL_MILESTONES = [2, 2.5, 3, 5, 10, 20, 30, 50, 100, 250, 500, 1000];

/** The subset a group gets before it configures anything. */
export const DEFAULT_MILESTONES = [2, 5, 10, 20, 50, 100];

/** The highest configured milestone a multiple has reached, or null. */
export function highestReachedMilestone(multiple, enabled = DEFAULT_MILESTONES) {
  if (!Number.isFinite(multiple) || multiple < 2) return null;
  let best = null;
  for (const m of enabled) {
    if (Number.isFinite(m) && multiple >= m && (best == null || m > best)) best = m;
  }
  return best;
}

/** Format a milestone for display: 2 -> "2", 2.5 -> "2.5". */
export function milestoneLabel(m) {
  return Number.isInteger(m) ? String(m) : String(m);
}

// ---- event ids ------------------------------------------------------------

export const eventId = {
  milestone: (callId, m) => `${callId}:milestone:${m}`,
  dexPaid: (callId) => `${callId}:dex-paid`,
  migration: (callId) => `${callId}:migration`,
  pump: (callId, bucket) => `${callId}:pump:${bucket}`,
  dump: (callId, bucket) => `${callId}:dump:${bucket}`,
  drawdown: (callId, level) => `${callId}:drawdown:${level}`,
};

// ---- text helpers ---------------------------------------------------------

function esc(v) {
  if (v == null) return '';
  return String(v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function clip(s, n) {
  const chars = [...String(s ?? '')];
  return chars.length <= n ? chars.join('') : `${chars.slice(0, n - 1).join('')}…`;
}

function tokenLabel(call) {
  if (call?.symbol) return `$${call.symbol}`;
  if (call?.name) return call.name;
  return 'TOKEN';
}

const FOOTER = '⚡️ <i>Powered by MEME CHECKER</i>';

// ---- milestone ------------------------------------------------------------

/**
 * The multiplier alert.
 *
 * One consolidated message for the HIGHEST newly reached enabled milestone, so
 * crossing 2x/5x/10x in a single observation produces one 10x alert rather than
 * three.
 *
 * Every figure comes from stored values: entry market cap is the original call
 * entry, current is the validated observation that triggered this.
 */
export function renderMilestoneAlert({ call, milestone, currentMarketCapUsd, groupTitle = null, now = Date.now() }) {
  const entry = call.entryMarketCapUsd;
  const multiple = entry > 0 ? currentMarketCapUsd / entry : null;
  const L = [];

  L.push(`🚀 <b>${esc(clip(tokenLabel(call), 24))} JUST HIT ${esc(milestoneLabel(milestone))}X!</b>`);
  L.push('');
  L.push(`Entry MC: <b>${esc(fmtUsd(entry) ?? '—')}</b>`);
  L.push(`Current MC: <b>${esc(fmtUsd(currentMarketCapUsd) ?? '—')}</b>`);
  if (multiple != null) L.push(`Return: <b>${multiple.toFixed(2)}x</b>`);
  L.push('');
  const who = callerLabel(call);
  const age = timeAgo(call.calledAt, now);
  L.push(`Called by <b>${esc(clip(who, 24))}</b>${age ? ` · ${esc(age)}` : ''}`);
  if (groupTitle) L.push(`<i>${esc(clip(groupTitle, 32))}</i>`);
  L.push('');
  L.push(FOOTER);

  return L.join('\n');
}

// ---- dex paid -------------------------------------------------------------

const DEX_PAID_HEADLINE = {
  paid: '💎 <b>DEX PAID CONFIRMED</b>',
  processing: '⏳ <b>DEX PAID PROCESSING</b>',
  cancelled: '⚠️ <b>DEX PAID CANCELLED</b>',
  'not-paid': '📄 <b>NO PAID ORDER FOUND</b>',
};

/**
 * Dex Paid alert.
 *
 * Only a transition INTO a confirmed paid state is announced as a payment event.
 * A token that was already paid when first observed records that state silently —
 * announcing it would claim a payment that may have happened before the call.
 */
export function renderDexPaidAlert({ call, status, detail = null, now = Date.now() }) {
  const headline = DEX_PAID_HEADLINE[status] ?? '🔔 <b>DEX PAID UPDATE</b>';
  const L = [headline, ''];
  L.push(`${esc(clip(tokenLabel(call), 24))} on ${esc(getChain(call.chain)?.name ?? call.chain)}`);
  if (detail) L.push(`<i>${esc(clip(detail, 90))}</i>`);
  L.push('');
  L.push(`Called by <b>${esc(clip(callerLabel(call), 24))}</b>`);
  L.push('');
  L.push(FOOTER);
  return L.join('\n');
}

// ---- migration ------------------------------------------------------------

/**
 * Migration alert.
 *
 * Sent only on VERIFIED evidence that the bonding process completed. The detail
 * line names the evidence, so a reader can tell a verified migration from a
 * heuristic guess.
 */
export function renderMigrationAlert({ call, evidence, now = Date.now() }) {
  const L = [];
  L.push(`🔄 <b>${esc(clip(tokenLabel(call), 24))} MIGRATED</b>`);
  L.push('');
  if (evidence?.launchpad) L.push(`Launchpad: <b>${esc(evidence.launchpad)}</b>`);
  if (evidence?.pool) L.push(`Now trading on: <b>${esc(clip(evidence.pool, 28))}</b>`);
  if (evidence?.note) L.push(`<i>${esc(clip(evidence.note, 90))}</i>`);
  L.push('');
  L.push(`Entry MC: <b>${esc(fmtUsd(call.entryMarketCapUsd) ?? '—')}</b>`);
  L.push(`Called by <b>${esc(clip(callerLabel(call), 24))}</b>`);
  L.push('');
  L.push(FOOTER);
  return L.join('\n');
}

// ---- price movement -------------------------------------------------------

/**
 * Price movement / drawdown alert.
 *
 * Deliberately factual: it reports a measured move, not a cause. Calling an
 * ordinary sell-off a rug or manipulation is a claim we cannot support.
 */
export function renderMovementAlert({ call, kind, changePercent, windowLabel, currentMarketCapUsd, peakMarketCapUsd = null, now = Date.now() }) {
  const icon = kind === 'pump' ? '📈' : kind === 'dump' ? '📉' : '🔻';
  const verb = kind === 'pump' ? 'UP' : kind === 'dump' ? 'DOWN' : 'OFF PEAK';
  const L = [];

  if (kind === 'drawdown') {
    L.push(`${icon} <b>${esc(clip(tokenLabel(call), 24))} ${verb} ${Math.abs(changePercent).toFixed(0)}%</b>`);
    L.push('');
    if (peakMarketCapUsd != null) L.push(`Peak MC: <b>${esc(fmtUsd(peakMarketCapUsd) ?? '—')}</b>`);
    L.push(`Current MC: <b>${esc(fmtUsd(currentMarketCapUsd) ?? '—')}</b>`);
  } else {
    L.push(`${icon} <b>${esc(clip(tokenLabel(call), 24))} ${verb} ${Math.abs(changePercent).toFixed(0)}%</b>`);
    L.push('');
    L.push(`Window: <b>${esc(windowLabel)}</b>`);
    L.push(`Current MC: <b>${esc(fmtUsd(currentMarketCapUsd) ?? '—')}</b>`);
  }
  L.push('');
  L.push(`Called by <b>${esc(clip(callerLabel(call), 24))}</b>`);
  L.push('');
  L.push('<i>Measured price movement, not trading advice.</i>');
  L.push(FOOTER);
  return L.join('\n');
}

/** 429 / retry_after helper: how long to wait before a retry, in ms. */
export function retryAfterMs(err, fallbackMs = 5_000) {
  const secs = err?.parameters?.retry_after ?? err?.response?.parameters?.retry_after;
  if (Number.isFinite(Number(secs))) return Math.max(1000, Number(secs) * 1000);
  return fallbackMs;
}
