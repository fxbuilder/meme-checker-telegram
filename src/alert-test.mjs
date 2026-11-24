/**
 * src/alert-test.mjs
 * /alerttest — owner-only delivery check for every alert type.
 *
 * WHY THIS EXISTS
 * Waiting for a real token to hit 2x is a terrible way to test alert delivery. This
 * lets the owner fire each alert on demand and see exactly what the group receives.
 *
 * WHAT IT DELIBERATELY DOES NOT DO
 *   - It does NOT call deliverAlert(), so nothing is written to the alert map and no
 *     real dedupe state is consumed. A test cannot "use up" a genuine milestone.
 *   - It does NOT touch the CallStore at all: no call records, ROI, peak market cap
 *     or caller statistics are read for writing or modified.
 *   - The call object used for rendering is built in memory and discarded.
 *
 * So the only side effect of /alerttest is a Telegram message in the calling group.
 *
 * Every message is prefixed with a loud TEST banner and the figures are obvious
 * round numbers, so a screenshot can never be mistaken for real performance.
 */

import { getChain } from './chains.mjs';
import {
  renderMilestoneAlert, renderDexPaidAlert, renderMigrationAlert, renderMovementAlert,
} from './alerts.mjs';
import { isOwner } from './access.mjs';

/** Which targets this command supports, and what each one renders. */
export const TEST_TARGETS = ['2x', '5x', '10x', '20x', '50x', '100x', 'dexpaid', 'migration', 'pump', 'dump', 'drawdown'];

export const USAGE = [
  '🧪 <b>ALERT TEST</b>',
  '',
  '<i>Owner-only. Sends one simulated alert to this group using the real formatting ' +
  'and delivery path. No call record, statistic or alert state is affected.</i>',
  '',
  'Usage: <code>/alerttest &lt;target&gt;</code>',
  '',
  `Targets: ${TEST_TARGETS.map((t) => `<code>${t}</code>`).join(' ')}`,
].join('\n');

/** The banner prepended to every simulated alert. */
export const TEST_BANNER = '🧪 <b>TEST / SIMULATED — not real performance</b>\n';

/**
 * A throwaway call object for rendering. Values are round and obviously fake; the
 * symbol says SIM so a screenshot is unambiguous.
 */
export function makeTestCall({ chain = 'solana', now = Date.now() } = {}) {
  const entry = 100_000; // $100K entry, matching the documented example layout
  return {
    id: 'alerttest',
    chatId: null,
    chain,
    address: 'TESTsimulatedAddress1111111111111111111111',
    symbol: 'SIM',
    name: 'Simulated Token',
    callerKey: 'u:test',
    callerName: 'Test Caller',
    callerUsername: 'testcaller',
    entryMarketCapUsd: entry,
    peakMarketCapUsd: entry * 2,
    lastMarketCapUsd: entry * 1.1,
    calledAt: now - (3 * 24 + 8) * 3600_000, // 3d 8h, as in the documented example
    status: 'active',
    source: 'synthetic',
  };
}

/**
 * Render the requested simulation.
 * @returns {{text:string}|{error:string}}
 */
export function renderTestAlert(target, { groupTitle = null, now = Date.now() } = {}) {
  const key = String(target ?? '').trim().toLowerCase();
  const call = makeTestCall({ now });
  const entry = call.entryMarketCapUsd;

  // A multiplier target like "10x" or bare "10".
  const multMatch = /^(\d+(?:\.\d+)?)x?$/.exec(key);
  if (multMatch) {
    const m = Number(multMatch[1]);
    if (!Number.isFinite(m) || m < 2) {
      return { error: 'A milestone must be at least 2x.' };
    }
    const body = renderMilestoneAlert({
      call,
      milestone: m,
      currentMarketCapUsd: Math.round(entry * m),
      groupTitle,
      now,
    });
    return { text: TEST_BANNER + '\n' + body };
  }

  switch (key) {
    case 'dexpaid': {
      const body = renderDexPaidAlert({
        call, status: 'paid', detail: 'active tokenProfile (simulated)', now,
      });
      return { text: TEST_BANNER + '\n' + body };
    }
    case 'migration': {
      const body = renderMigrationAlert({
        call,
        evidence: { verified: true, launchpad: 'pump.fun', pool: 'Raydium', note: 'bonding curve completed (simulated)' },
        now,
      });
      return { text: TEST_BANNER + '\n' + body };
    }
    case 'pump': {
      const body = renderMovementAlert({
        call, kind: 'pump', changePercent: 52, windowLabel: '12m',
        currentMarketCapUsd: Math.round(entry * 1.52), now,
      });
      return { text: TEST_BANNER + '\n' + body };
    }
    case 'dump': {
      const body = renderMovementAlert({
        call, kind: 'dump', changePercent: -34, windowLabel: '9m',
        currentMarketCapUsd: Math.round(entry * 0.66), now,
      });
      return { text: TEST_BANNER + '\n' + body };
    }
    case 'drawdown': {
      const body = renderMovementAlert({
        call, kind: 'drawdown', changePercent: -58, windowLabel: 'from peak',
        currentMarketCapUsd: Math.round(entry * 0.84),
        peakMarketCapUsd: Math.round(entry * 2), now,
      });
      return { text: TEST_BANNER + '\n' + body };
    }
    default:
      return { error: `Unknown target <code>${key.replace(/[<>&]/g, '')}</code>.` };
  }
}

/**
 * /alerttest handler.
 *
 * Authorization is checked in this order and each failure has its own message, so a
 * refusal is never ambiguous:
 *   1. not a group            -> explain
 *   2. not the owner          -> refuse (checked before anything else costly)
 *   3. group not allowlisted  -> refuse
 *   4. bad/missing target     -> usage
 */
export async function handleAlertTest(ctx, deps) {
  const { policy, testGroupId = null } = deps;
  if (ctx.from?.is_bot) return;

  const chatId = ctx.chat?.id;
  const type = ctx.chat?.type;
  if (type !== 'group' && type !== 'supergroup') {
    await ctx.reply('ℹ️ Alert tests run in the authorized test group.');
    return;
  }

  // A policy that failed to parse must fail CLOSED here: these commands send
  // messages, so "we could not tell who you are" is not permission.
  const ownerOk = policy?.ownerIds instanceof Set
    ? isOwner(policy, ctx.from?.id)
    : false;
  if (!ownerOk) {
    await ctx.reply('🔒 <code>/alerttest</code> is owner-only.', { parse_mode: 'HTML' });
    return;
  }

  // Extra guard: staging keeps these simulations inside one known group.
  const allowed = Array.isArray(policy?.allowedChatIds) || policy?.allowedChatIds instanceof Set
    ? [...policy.allowedChatIds].map(String)
    : [];
  if (testGroupId != null && String(chatId) !== String(testGroupId)) {
    await ctx.reply('🔒 Alert tests only run in the authorized test group.', { parse_mode: 'HTML' });
    return;
  }
  if (allowed.length && !allowed.includes(String(chatId))) {
    await ctx.reply('🔒 This group is not authorized for alert tests.', { parse_mode: 'HTML' });
    return;
  }

  const arg = String(ctx.message?.text ?? '').replace(/^\/\w+(@\w+)?\s*/i, '').trim();
  if (!arg) {
    await ctx.reply(USAGE, { parse_mode: 'HTML', disable_web_page_preview: true });
    return;
  }

  const out = renderTestAlert(arg, { groupTitle: ctx.chat?.title ?? null });
  if (out.error) {
    await ctx.reply(`${out.error}\n\n${USAGE}`, { parse_mode: 'HTML', disable_web_page_preview: true });
    return;
  }

  // Deliberately NOT deliverAlert(): no claim, no store write, no dedupe side effect.
  try {
    const msg = await ctx.telegram.sendMessage(chatId, out.text, {
      parse_mode: 'HTML',
      disable_web_page_preview: true,
    });
    console.log(`[alerttest] simulated "${arg}" delivered to ${chatId} (message ${msg?.message_id})`);
  } catch (err) {
    console.error('[alerttest] delivery failed:', err?.description ?? err?.message ?? err);
    await ctx.reply(`⚠️ Could not deliver the test alert: ${String(err?.description ?? err?.message ?? err).slice(0, 120)}`)
      .catch(() => {});
  }
}
