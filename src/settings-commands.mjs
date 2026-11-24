/**
 * src/settings-commands.mjs
 * Phase 6 — `/lb`, `/leaderboard`, `/gpnl`, `/settings`.
 *
 * AUTHORISATION is the security-critical part. During staging only the OWNER may change
 * group settings. The check fails CLOSED: an unparsable policy, a missing id or a
 * non-Set owner set all deny. A settings screen that any group member can drive would
 * let a stranger disable alerts or switch the group to auto-call.
 */

import { canChangeSettings, isOwner } from './access.mjs';
import { buildLeaderboard, buildGroupSummary, buildTopCalls, renderLeaderboard, renderGroupPnl, LB_PERIODS } from './leaderboard.mjs';

function esc(v) {
  return String(v ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** Group-scoped, eligibility-filtered calls. Never another group's records. */
function scopedCalls(store, chatId) {
  store.load();
  // `callsForChat` already limits to the chat; eligibility is re-checked by the
  // leaderboard so a synthetic or superseded record cannot inflate a ranking.
  return store.callsForChat(chatId, { limit: 10_000 });
}

// ---- /lb ----------------------------------------------------------------

export async function handleLeaderboard(ctx, deps) {
  if (ctx.from?.is_bot) return;
  if (!deps.isGroup(ctx)) {
    await ctx.reply('Run this in a group.');
    return;
  }
  const chatId = ctx.chat.id;
  const period = deps.period ?? '7d';

  const calls = scopedCalls(deps.store, chatId);
  const groupTitle = deps.store.doc.groups?.[String(chatId)]?.title ?? ctx.chat.title ?? null;

  // All three sections are built from the SAME period and the SAME eligible sample, so
  // the header, the stats block and the call list can never disagree with each other.
  const board = buildLeaderboard(calls, { period });
  const summary = buildGroupSummary(calls, { period });
  const topCalls = buildTopCalls(calls, { period });

  const out = renderLeaderboard({
    groupTitle,
    board,
    summary,
    topCalls,
    chatId,
    botUsername: deps.botUsername ?? null,
  });
  await ctx.reply(out.text, {
    parse_mode: 'HTML',
    disable_web_page_preview: true,
    ...(out.keyboard.length ? { reply_markup: { inline_keyboard: out.keyboard } } : {}),
  });
}

// ---- /gpnl --------------------------------------------------------------

export async function handleGroupPnl(ctx, deps) {
  if (ctx.from?.is_bot) return;
  if (!deps.isGroup(ctx)) {
    await ctx.reply('Run this in a group.');
    return;
  }
  const chatId = ctx.chat.id;
  const panel = deps.period ?? '7d';

  const calls = scopedCalls(deps.store, chatId);
  const summary = buildGroupSummary(calls, { period: panel });
  const groupTitle = deps.store.doc.groups?.[String(chatId)]?.title ?? ctx.chat.title ?? null;

  const out = renderGroupPnl({ groupTitle, summary });
  await ctx.reply(out.text, {
    parse_mode: 'HTML',
    disable_web_page_preview: true,
    ...(out.keyboard.length ? { reply_markup: { inline_keyboard: out.keyboard } } : {}),
  });
}

// ---- /settings ----------------------------------------------------------

/**
 * The settings screen.
 *
 * Rendered for ANY member so people can see how their group is configured, but the
 * buttons are only wired for someone authorised to change them. Showing the state and
 * allowing the change are separate concerns.
 */
export function renderSettings({ groupTitle, settings, canEdit, reason }) {
  const L = [];
  L.push('⚙️ <b>GROUP SETTINGS</b>');
  L.push('');
  L.push(`📁 ${esc(groupTitle ?? 'This group')}`);
  L.push('');

  L.push(`Call mode: <b>${esc(settings.autoCall === 'auto' ? 'Auto' : 'Manual')}</b>`);
  L.push(`Alerts: <b>${settings.alertsEnabled === false ? 'Off' : 'On'}</b>`);
  if (Array.isArray(settings.milestones) && settings.milestones.length) {
    L.push(`Milestones: ${esc(settings.milestones.map((m) => `${m}x`).join(' · '))}`);
  }
  L.push('');

  if (!canEdit) {
    L.push(`<i>${esc(reason ?? 'Only the group owner can change these settings.')}</i>`);
  } else {
    L.push('<i>Tap a button to change a setting.</i>');
  }

  const rows = [];
  if (canEdit) {
    rows.push([
      { text: settings.autoCall === 'auto' ? '✅ Auto call' : 'Auto call', callback_data: 'st:mode:auto' },
      { text: settings.autoCall === 'auto' ? 'Manual' : '✅ Manual', callback_data: 'st:mode:manual' },
    ]);
    rows.push([
      { text: settings.alertsEnabled === false ? 'Enable alerts' : 'Disable alerts', callback_data: 'st:alerts:toggle' },
    ]);
  }
  return { text: L.join('\n'), keyboard: rows };
}

export async function handleSettings(ctx, deps) {
  if (ctx.from?.is_bot) return;
  if (!deps.isGroup(ctx)) {
    await ctx.reply('Run this in a group.');
    return;
  }
  const chatId = ctx.chat.id;
  const groupTitle = ctx.chat.title ?? deps.store.doc.groups?.[String(chatId)]?.title ?? null;
  const settings = deps.store.groupSettings(chatId, { title: groupTitle });

  // Fail closed: the object form of canChangeSettings is checked explicitly. A
  // truthiness test on it would always pass, which was a real defect in Phase 3.
  const verdict = canChangeSettings(deps.policy, { userId: ctx.from?.id });

  const out = renderSettings({
    groupTitle,
    settings,
    canEdit: verdict?.allowed === true,
    reason: verdict?.reason ?? null,
  });
  await ctx.reply(out.text, {
    parse_mode: 'HTML',
    disable_web_page_preview: true,
    ...(out.keyboard.length ? { reply_markup: { inline_keyboard: out.keyboard } } : {}),
  });
}

// ---- callbacks ----------------------------------------------------------

/**
 * `lb:<period>:<page>` and `gp:<period>` — re-render in place.
 * A callback is scoped to the chat it was pressed in, so one group can never fetch
 * another group's board by replaying a callback payload.
 */
export async function handleBoardCallback(ctx, deps) {
  const data = String(ctx.callbackQuery?.data ?? '');
  const parts = data.split(':');
  const kind = parts[0];

  const chatId = ctx.chat?.id;
  if (!chatId) {
    await ctx.answerCbQuery('Unavailable here');
    return;
  }

  const periodId = parts[1] && LB_PERIODS.some((p) => p.id === parts[1]) ? parts[1] : '7d';
  // `lb:<period>:<expanded>` — the third field is now the Top-10 expansion flag, not a
  // page number. Accepting either keeps an older message's buttons working.
  const expanded = kind === 'lb' && String(parts[2] ?? '0') === '1';

  const calls = scopedCalls(deps.store, chatId);
  const groupTitle = deps.store.doc.groups?.[String(chatId)]?.title ?? ctx.chat.title ?? null;

  // Rebuild every section from the newly selected period so the three blocks always
  // agree. Rendering only the caller list would leave stale stats above a fresh list.
  const out = kind === 'gp'
    ? renderGroupPnl({ groupTitle, summary: buildGroupSummary(calls, { period: periodId }) })
    : renderLeaderboard({
      groupTitle,
      board: buildLeaderboard(calls, { period: periodId }),
      summary: buildGroupSummary(calls, { period: periodId }),
      topCalls: buildTopCalls(calls, { period: periodId }),
      chatId,
      botUsername: deps.botUsername ?? null,
      expanded,
    });

  await ctx.answerCbQuery();
  try {
    await ctx.editMessageText(out.text, {
      parse_mode: 'HTML',
      disable_web_page_preview: true,
      ...(out.keyboard.length ? { reply_markup: { inline_keyboard: out.keyboard } } : {}),
    });
  } catch (err) {
    // Tapping the period already selected produces identical content; Telegram rejects
    // that edit with 400 "message is not modified". That is a no-op, not a failure.
    const d = String(err?.description ?? err?.message ?? '');
    if (!/message is not modified/i.test(d)) throw err;
  }
}

/**
 * `st:<key>:<value>` — change one group setting.
 *
 * The authorisation check is the whole point of this handler, so it runs BEFORE any
 * mutation and fails closed.
 */
export async function handleSettingsCallback(ctx, deps) {
  const data = String(ctx.callbackQuery?.data ?? '');
  const [, key, value] = data.split(':');

  const chatId = ctx.chat?.id;
  if (!chatId) {
    await ctx.answerCbQuery('Unavailable here');
    return;
  }

  const verdict = canChangeSettings(deps.policy, { userId: ctx.from?.id });
  if (verdict?.allowed !== true) {
    // Answer honestly and change nothing.
    await ctx.answerCbQuery('Only the group owner can change settings', { show_alert: true });
    return;
  }

  if (key === 'mode') {
    const mode = value === 'auto' ? 'auto' : 'manual';
    await deps.store.setGroupSetting(chatId, { autoCall: mode });
  } else if (key === 'alerts') {
    const current = deps.store.groupSettings(chatId, {});
    await deps.store.setGroupSetting(chatId, { alertsEnabled: current.alertsEnabled === false });
  } else {
    await ctx.answerCbQuery('Unknown setting');
    return;
  }

  await ctx.answerCbQuery('Saved');

  // Re-render so the buttons reflect the new state.
  const groupTitle = ctx.chat.title ?? deps.store.doc.groups?.[String(chatId)]?.title ?? null;
  const settings = deps.store.groupSettings(chatId, { title: groupTitle });
  const out = renderSettings({ groupTitle, settings, canEdit: true, reason: null });
  try {
    await ctx.editMessageText(out.text, {
      parse_mode: 'HTML',
      ...(out.keyboard.length ? { reply_markup: { inline_keyboard: out.keyboard } } : {}),
    });
  } catch (err) {
    const d = String(err?.description ?? err?.message ?? '');
    if (!/message is not modified/i.test(d)) throw err;
  }
}
