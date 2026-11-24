/**
 * src/alert-commands.mjs
 * /alerts — the minimum owner-facing control for Phase 3.
 *
 * Authorization uses the same access module as /callsettings: reading is fine for
 * anyone in an allowed chat, CHANGING requires an owner. A group admin is still
 * refused, because admin rights are not verified yet (Phase 6).
 *
 * Settings live in the group row, so they survive restarts and are per-group.
 */

import { Markup } from 'telegraf';
import { canChangeSettings } from './access.mjs';
import { ALL_MILESTONES } from './alerts.mjs';

const esc = (v) => String(v ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

function onOff(v) {
  return v ? '✅ On' : '⚪ Off';
}

/** Default alert settings, merged with whatever the group has stored. */
export function effectiveAlertSettings(store, chatId) {
  const stored = store.groupSettings(chatId).alerts ?? {};
  return {
    multiplier: true,
    dexPaid: true,
    migration: true,
    priceMovement: false,
    milestones: [2, 5, 10, 20, 50, 100],
    pumpPercent: 50,
    pumpWindowMs: 15 * 60_000,
    dumpPercent: 30,
    dumpWindowMs: 15 * 60_000,
    drawdownPercent: 50,
    ...stored,
  };
}

export function renderAlertsPanel(settings, { groupTitle = null, canEdit = false } = {}) {
  const L = [];
  L.push('🔔 <b>ALERTS</b>');
  if (groupTitle) L.push(`📁 ${esc(groupTitle)}`);
  L.push('');
  L.push(`Multiplier alerts: ${onOff(settings.multiplier)}`);
  L.push(`Dex Paid alerts: ${onOff(settings.dexPaid)}`);
  L.push(`Migration alerts: ${onOff(settings.migration)}`);
  L.push(`Price movement alerts: ${onOff(settings.priceMovement)}`);
  L.push('');
  L.push(`Milestones: <b>${settings.milestones.map((m) => `${m}x`).join(', ') || 'none'}</b>`);
  if (settings.priceMovement) {
    L.push(`Pump: +${settings.pumpPercent}% / ${Math.round(settings.pumpWindowMs / 60_000)}m`);
    L.push(`Dump: -${settings.dumpPercent}% / ${Math.round(settings.dumpWindowMs / 60_000)}m`);
    L.push(`Drawdown from peak: -${settings.drawdownPercent}%`);
  }
  L.push('');
  if (canEdit) {
    L.push('<i>Tap a switch to toggle it. Changes apply immediately and persist.</i>');
  } else {
    L.push('<i>Only the bot owner can change alert settings during staging.</i>');
  }
  return L.join('\n');
}

export function alertsKeyboard(settings, { canEdit = false } = {}) {
  if (!canEdit) return [];
  const id = (k) => `al:${k}`;
  return [
    [
      Markup.button.callback(`Multiplier ${settings.multiplier ? '✅' : '⚪'}`, id('multiplier')),
      Markup.button.callback(`Dex Paid ${settings.dexPaid ? '✅' : '⚪'}`, id('dexPaid')),
    ],
    [
      Markup.button.callback(`Migration ${settings.migration ? '✅' : '⚪'}`, id('migration')),
      Markup.button.callback(`Movement ${settings.priceMovement ? '✅' : '⚪'}`, id('priceMovement')),
    ],
    [
      Markup.button.callback('Milestones ▸', id('milestones')),
    ],
  ];
}

export function milestonesKeyboard(settings) {
  const enabled = new Set(settings.milestones ?? []);
  const rows = [];
  let row = [];
  for (const m of ALL_MILESTONES) {
    row.push(Markup.button.callback(`${m}x ${enabled.has(m) ? '✅' : '⚪'}`, `al:m:${m}`));
    if (row.length === 3) { rows.push(row); row = []; }
  }
  if (row.length) rows.push(row);
  rows.push([Markup.button.callback('‹ Back', 'al:back')]);
  return rows;
}

/** /alerts handler. */
export async function handleAlerts(ctx, deps) {
  const { store, policy } = deps;
  if (ctx.from?.is_bot) return;
  if (ctx.chat?.type !== 'group' && ctx.chat?.type !== 'supergroup') {
    await ctx.reply('ℹ️ Alert settings apply to groups. Add me to a group first.');
    return;
  }
  const settings = effectiveAlertSettings(store, ctx.chat.id);
  const canEdit = canChangeSettings(policy, { userId: ctx.from?.id }).allowed;
  await ctx.reply(renderAlertsPanel(settings, { groupTitle: ctx.chat.title, canEdit }), {
    parse_mode: 'HTML',
    ...Markup.inlineKeyboard(alertsKeyboard(settings, { canEdit })),
  });
}

/** Callback for the panel. */
export async function handleAlertsCallback(ctx, deps) {
  const { store, policy } = deps;
  const data = String(ctx.callbackQuery?.data ?? '');
  const key = data.slice(3); // strip "al:"

  // canChangeSettings returns {allowed, reason} — a plain truthiness test on the
  // object would always pass, which is how a stranger briefly toggled settings.
  const gate = canChangeSettings(policy, { userId: ctx.from?.id });
  if (!gate.allowed) {
    await ctx.answerCbQuery(gate.reason ?? 'Owner only during staging');
    return;
  }
  const chatId = ctx.chat?.id;
  if (chatId == null) { await ctx.answerCbQuery('No group'); return; }

  const settings = effectiveAlertSettings(store, chatId);

  if (key === 'back') {
    await ctx.answerCbQuery();
    await ctx.editMessageText(renderAlertsPanel(settings, { groupTitle: ctx.chat.title, canEdit: true }), {
      parse_mode: 'HTML',
      reply_markup: { inline_keyboard: alertsKeyboard(settings, { canEdit: true }) },
    }).catch(() => {});
    return;
  }

  if (key === 'milestones') {
    await ctx.answerCbQuery();
    await ctx.editMessageText(
      '🔔 <b>MULTIPLIER MILESTONES</b>\n\n<i>Only enabled milestones trigger an alert. The highest newly reached one is announced.</i>',
      { parse_mode: 'HTML', reply_markup: { inline_keyboard: milestonesKeyboard(settings) } },
    ).catch(() => {});
    return;
  }

  if (key.startsWith('m:')) {
    const m = Number(key.slice(2));
    if (!Number.isFinite(m) || m < 2) { await ctx.answerCbQuery('Bad milestone'); return; }
    const cur = new Set(settings.milestones ?? []);
    if (cur.has(m)) cur.delete(m); else cur.add(m);
    const next = [...cur].sort((a, b) => a - b);
    await store.setGroupSetting(chatId, { alerts: { ...settings, milestones: next } });
    const fresh = effectiveAlertSettings(store, chatId);
    await ctx.answerCbQuery(next.includes(m) ? `${m}x enabled` : `${m}x disabled`);
    await ctx.editMessageText(
      '🔔 <b>MULTIPLIER MILESTONES</b>\n\n<i>Only enabled milestones trigger an alert. The highest newly reached one is announced.</i>',
      { parse_mode: 'HTML', reply_markup: { inline_keyboard: milestonesKeyboard(fresh) } },
    ).catch(() => {});
    return;
  }

  const toggles = ['multiplier', 'dexPaid', 'migration', 'priceMovement'];
  if (toggles.includes(key)) {
    const next = { ...settings, [key]: !settings[key] };
    await store.setGroupSetting(chatId, { alerts: next });
    const fresh = effectiveAlertSettings(store, chatId);
    await ctx.answerCbQuery(`${key} ${fresh[key] ? 'on' : 'off'}`);
    await ctx.editMessageText(renderAlertsPanel(fresh, { groupTitle: ctx.chat.title, canEdit: true }), {
      parse_mode: 'HTML',
      reply_markup: { inline_keyboard: alertsKeyboard(fresh, { canEdit: true }) },
    }).catch(() => {});
    return;
  }

  await ctx.answerCbQuery('Unknown option');
}
