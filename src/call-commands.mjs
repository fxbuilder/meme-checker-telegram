/**
 * src/call-commands.mjs
 * Phase 2 Telegram commands: /call, /calls, /fc, /pnl.
 *
 * Registered from src/bot.mjs so this file stays free of Telegraf imports and is
 * directly unit-testable with a synthetic ctx.
 *
 * Behaviour is deliberately explicit about the scan-vs-call distinction:
 *   scanning a contract is free and happens on any pasted CA
 *   RECORDING a call is a separate, attributable act
 * Auto-call mode narrows that gap for groups that want it, and /justscan turns a
 * pasted CA back into a pure scan for the rest of that message's handling.
 */

import { Markup } from 'telegraf';
import { parseChainHint, detectAll, DEFAULT_EVM_CHAIN } from './detect-ca.mjs';
import { recordCall, observeCall, resolveCall, pnlText, CALL_STATUS } from './call-service.mjs';
import { callMetrics, fmtMultiple, fmtSignedPercent } from './calls.mjs';
import { fmtUsd } from './card-layout.mjs';
import { timeSince } from './calls.mjs';
import { isSynthetic } from './store.mjs';
import { getChain } from './chains.mjs';
import { renderPnlPng } from './pnl-render.mjs';
import { canChangeSettings } from './access.mjs';
import { verifyExtremeObservation } from './extreme-verify.mjs';
import { renderCallerProfile, profileKeyboard } from './caller-profile.mjs';
import { mintCallerToken, resolveCallerToken } from './deep-link.mjs';

/** Age labels read naturally: "just now", not "just now ago". */
function ageLabel(label) {
  if (!label) return '—';
  return /just now/i.test(label) ? 'just now' : `${label} ago`;
}

function esc(v) {
  if (v == null) return '';
  return String(v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

const chainName = (c) => getChain(c)?.name ?? c ?? '?';

/** Resolve the caller's display identity for attribution. */
export function callerIdentity(ctx) {
  const from = ctx.from ?? {};
  const displayName = [from.first_name, from.last_name].filter(Boolean).join(' ') || from.username || 'unknown';
  return { id: from.id ?? 0, displayName, username: from.username ?? null };
}

/** Is this chat a group/supergroup (i.e. call tracking applies)? */
export function isGroupChat(ctx) {
  const t = ctx.chat?.type;
  return t === 'group' || t === 'supergroup';
}

/**
 * Strip a command token and return { chainHint, address }.
 * Reuses the existing detector so chain hints behave identically everywhere.
 */
export function parseCallArgs(text, defaultEvmChain = DEFAULT_EVM_CHAIN) {
  const raw = String(text ?? '').replace(/^\/\w+(@\w+)?\s*/i, '').trim();
  if (!raw) return { chainHint: null, address: null, candidates: [] };
  const hint = parseChainHint(raw);
  const det = detectAll(hint.rest, { defaultEvmChain, chainHint: hint.chainId });
  return { chainHint: hint.chainId, address: det.candidates[0]?.address ?? null, candidates: det.candidates };
}

/**
 * /call [chain] <CA>
 * Records a call for the invoking member. Works in groups; in DM it explains why
 * attribution is meaningless there.
 */
export async function handleCall(ctx, deps) {
  const { store, scan, defaultEvmChain = DEFAULT_EVM_CHAIN } = deps;
  if (ctx.from?.is_bot) return;
  if (!isGroupChat(ctx)) {
    await ctx.reply('ℹ️ Call tracking is for groups. Paste a CA there, or use /check here to scan.');
    return;
  }

  const { chainHint, address, candidates } = parseCallArgs(ctx.message?.text, defaultEvmChain);
  if (!address) {
    await ctx.reply(
      'Usage: <code>/call &lt;address&gt;</code> or <code>/call &lt;chain&gt; &lt;address&gt;</code>\n' +
      'Records your call with the current market cap as the entry.',
      { parse_mode: 'HTML' },
    );
    return;
  }

  const chain = candidates[0].chain;
  if (chainHint && chain !== chainHint) {
    await ctx.reply(`❌ That address is not valid on ${esc(chainName(chainHint))}.`, { parse_mode: 'HTML' });
    return;
  }

  const result = await scan({ chain, address });
  const outcome = await recordCall({
    store,
    scanResult: result,
    caller: callerIdentity(ctx),
    chatId: ctx.chat.id,
    source: 'manual',
    messageId: ctx.message?.message_id ?? null,
  });

  await ctx.reply(await renderCallOutcome(outcome, { chain, address, result }), { parse_mode: 'HTML' });
}

/** Shared messaging for every recordCall outcome. */
async function renderCallOutcome(outcome, { chain, address, result }) {
  switch (outcome.status) {
    case CALL_STATUS.RECORDED: {
      const m = callMetrics(outcome.call);
      const lines = [
        `✅ <b>Call recorded</b>${outcome.isFirstCall ? ' · 🥇 first call' : ''}`,
        '',
        `${esc(result?.token?.name ?? 'Token')} <code>$${esc(result?.token?.symbol ?? '?')}</code> · ${esc(chainName(chain))}`,
        `<code>${esc(result?.token?.address ?? address)}</code>`,
        '',
        `Entry MC: <b>${esc(fmtUsd(m.entryMarketCapUsd) ?? '—')}</b>`,
        `Caller: <b>${esc(outcome.call.callerUsername ? '@' + outcome.call.callerUsername : outcome.call.callerName)}</b>`,
      ];
      if (!outcome.isFirstCall && outcome.firstCall) {
        const who = outcome.firstCall.callerUsername ? `@${outcome.firstCall.callerUsername}` : outcome.firstCall.callerName;
        lines.push(`<i>First call: ${esc(who)} · ${esc(ageLabel(timeSince(outcome.firstCall.calledAt)))}</i>`);
      }
      lines.push('', '<i>Use /pnl for performance, /calls for history.</i>');
      return lines.join('\n');
    }
    case CALL_STATUS.DUPLICATE:
      return '⚠️ You already called this token recently. <i>Use /pnl to see how it is doing.</i>';
    case CALL_STATUS.LOW_MCAP:
      return `⚠️ Not recorded: ${esc(outcome.reason)}.\n<i>An admin can change this with /callsettings minmc &lt;usd&gt;.</i>`;
    case CALL_STATUS.NOT_FOUND:
      return '❗️ <b>Token not found</b> — no trading pair exists for this contract yet, so there is no entry price to record.';
    default:
      return `❗️ <b>Could not record this call</b>\n\n<i>${esc(outcome.reason ?? 'the scan was not usable')}</i>\n\nNothing was saved.`;
  }
}

/**
 * /calls
 * The last N calls in this group, newest first, with live-ish metrics from the
 * last observation (never re-scanning every token on a list command).
 */
export async function handleCalls(ctx, deps) {
  const { store } = deps;
  if (ctx.from?.is_bot) return;
  if (!isGroupChat(ctx)) {
    await ctx.reply('ℹ️ Call history is per group.');
    return;
  }
  const calls = store.callsForChat(ctx.chat.id, { limit: 15 }).filter((c) => !isSynthetic(c));
  if (!calls.length) {
    await ctx.reply(
      '📋 <b>No calls yet</b>\n\nRecord one with <code>/call &lt;address&gt;</code>, or enable auto-call with <code>/callsettings autocall on</code>.',
      { parse_mode: 'HTML' },
    );
    return;
  }

  const lines = ['📋 <b>Recent calls</b>', ''];
  calls.forEach((c, i) => {
    const m = callMetrics(c);
    const who = c.callerUsername ? `@${c.callerUsername}` : c.callerName;
    const roi = m.currentMultiple != null ? fmtMultiple(m.currentMultiple) : '—';
    const sym = c.symbol ? `$${c.symbol}` : (c.name ?? 'token');
    lines.push(
      `${i + 1}. <b>${esc(sym)}</b> · ${esc(roi)} · ${esc(m.ageLabel ?? '')}\n` +
      `    ${esc(who)} · entry ${esc(fmtUsd(m.entryMarketCapUsd) ?? '—')}`,
    );
  });
  lines.push('', '<i>Tap /pnl &lt;number&gt; or /pnl &lt;address&gt; for a shareable card.</i>');
  await ctx.reply(lines.join('\n'), { parse_mode: 'HTML' });
}

/**
 * /fc [chain] <CA>  — who called this first.
 */
export async function handleFirstCall(ctx, deps) {
  const { store, defaultEvmChain = DEFAULT_EVM_CHAIN } = deps;
  if (ctx.from?.is_bot) return;
  if (!isGroupChat(ctx)) {
    await ctx.reply('ℹ️ First-caller attribution is per group.');
    return;
  }
  const { address, candidates, chainHint } = parseCallArgs(ctx.message?.text, defaultEvmChain);
  if (!address) {
    await ctx.reply('Usage: <code>/fc &lt;address&gt;</code>', { parse_mode: 'HTML' });
    return;
  }
  const chain = candidates[0].chain;
  if (chainHint && chain !== chainHint) {
    await ctx.reply(`❌ That address is not valid on ${esc(chainName(chainHint))}.`, { parse_mode: 'HTML' });
    return;
  }

  const first = store.firstCall(ctx.chat.id, chain, address);
  if (!first) {
    await ctx.reply('📭 No call recorded for this token in this group yet.', { parse_mode: 'HTML' });
    return;
  }
  const all = store.callsForToken(ctx.chat.id, chain, address).filter((c) => !isSynthetic(c));
  const m = callMetrics(first);
  const who = first.callerUsername ? `@${first.callerUsername}` : first.callerName;
  const lines = [
    `🥇 <b>First call</b>`,
    '',
    `${esc(first.name ?? 'Token')} <code>$${esc(first.symbol ?? '?')}</code> · ${esc(chainName(first.chain))}`,
    `<code>${esc(first.displayAddress ?? first.address)}</code>`,
    '',
    `First caller: <b>${esc(who)}</b>`,
    `Called: ${esc(ageLabel(m.ageLabel))}`,
    `Entry MC: <b>${esc(fmtUsd(m.entryMarketCapUsd) ?? '—')}</b>`,
  ];
  if (m.currentMultiple != null) lines.push(`Current: <b>${esc(fmtMultiple(m.currentMultiple))}</b> since call`);
  if (all.length > 1) lines.push('', `<i>${all.length} calls total in this group.</i>`);
  await ctx.reply(lines.join('\n'), { parse_mode: 'HTML' });
}

/**
 * /pnl <contract_address>
 *
 * IMAGE ONLY. On success this sends exactly one photo with NO caption, no text
 * report and no buttons — the image carries every figure. A separate text card
 * would be a second message saying the same thing.
 *
 * Order of operations:
 *   1. resolve the CA against THIS group's recorded calls (never another group)
 *   2. no call → one clean sentence, and no insert
 *   3. ambiguous EVM address → ask, never guess
 *   4. refresh the observation, render, send the photo
 *   5. if rendering fails → say so plainly, do NOT present a text report as if the
 *      image had been delivered
 */
export async function handlePnl(ctx, deps) {
  const { store, scan, defaultEvmChain = DEFAULT_EVM_CHAIN, renderPng, sendPhoto, groupTitle = null } = deps;
  if (ctx.from?.is_bot) return;
  if (!isGroupChat(ctx)) {
    await ctx.reply('ℹ️ PnL cards are per group. Run /pnl in the group that made the call.');
    return;
  }

  const raw = String(ctx.message?.text ?? '').replace(/^\/\w+(@\w+)?\s*/i, '').trim();

  // ---- argument handling ------------------------------------------------
  if (!raw) {
    await ctx.reply(
      'Usage: <code>/pnl &lt;contract_address&gt;</code>\n' +
      '<i>Shows the recorded call for that token in this group.</i>',
      { parse_mode: 'HTML' },
    );
    return;
  }

  // Parse the ADDRESS only. No network call, no chain detection that could reach
  // a market provider: an unrecorded token must be answered from our own records.
  const parsed = parseCallArgs(raw, defaultEvmChain);

  // ---- RECORD-FIRST RESOLUTION -------------------------------------------
  // The address is resolved against this group's own recorded calls BEFORE
  // anything else happens. A 0x address that was never called must produce the
  // no-call sentence, not a chain picker and not a scan.
  if (!parsed.address) {
    await ctx.reply('❌ That does not look like a contract address.', { parse_mode: 'HTML' });
    return;
  }

  const recorded = store.recordedCallsForAddress(ctx.chat.id, parsed.address);
  // A chain hint narrows the records; it never widens the search.
  const scoped = parsed.chainHint
    ? recorded.filter((c) => c.chain === parsed.chainHint)
    : recorded;

  if (!scoped.length) {
    // Exactly one sentence. Nothing is created, nothing is scanned.
    await ctx.reply('No recorded call for this token in this group.');
    return;
  }

  const chains = [...new Set(scoped.map((c) => c.chain))];

  if (chains.length > 1) {
    // Genuinely recorded on more than one chain: offer ONLY those chains, and
    // carry the PnL action in the callback so choosing a chain continues /pnl
    // rather than falling through to a scan.
    const rows = chains.map((ch) => [
      Markup.button.callback(getChain(ch)?.name ?? ch, `pnl:${ch}:${parsed.address}`),
    ]);
    rows.push([Markup.button.callback('✖️ Cancel', 'pnl:cancel')]);
    await ctx.reply(
      '<b>This token was called on more than one chain here.</b>\n\n' +
      '<i>Pick the chain to show PnL for.</i>',
      { parse_mode: 'HTML', ...Markup.inlineKeyboard(rows) },
    );
    return;
  }

  await sendPnlFor(ctx, { call: scoped[0], store, scan, renderPng, sendPhoto, groupTitle });
}

/**
 * Render and send the PnL card for one already-resolved call.
 * Image only: no caption, no keyboard, no follow-up text.
 */
export async function sendPnlFor(ctx, { call, store, scan, renderPng, sendPhoto, groupTitle = null }) {
  // Refresh the observation so current/peak are as fresh as the data allows. A
  // failed refresh keeps the stored values; it never blocks the card.
  let logoUrl = null;
  try {
    const fresh = await scan({ chain: call.chain, address: call.address });
    // Scan results are nested: identity in `token`, art in `media`. The logo is
    // only ever taken from the identity-matched pair, never re-guessed here.
    if (fresh?.media?.logo && /^https:\/\//i.test(fresh.media.logo)) logoUrl = fresh.media.logo;
    const obs = await observeCall({
      store, call, scanResult: fresh, verifyExtreme: verifyExtremeObservation,
    });
    if (obs.updated) call = obs.call;
  } catch (err) {
    console.warn('[pnl] refresh failed, using stored values:', err?.message ?? err);
  }

  let png = null;
  try {
    png = await renderPng(call, { tokenName: call.name, groupTitle, logoUrl });
  } catch (err) {
    console.warn('[pnl] render failed:', err?.message ?? err);
    png = null;
  }

  if (!png) {
    await ctx.reply('⚠️ Could not generate the PnL image. Please try again shortly.');
    return;
  }

  try {
    await sendPhoto(ctx.chat.id, png, {
      reply_to_message_id: ctx.message?.message_id ?? undefined,
    });
  } catch (err) {
    console.warn('[pnl] photo send failed:', err?.description ?? err?.message ?? err);
    await ctx.reply('⚠️ Could not send the PnL image. Please try again shortly.');
  }
}

export async function handleCallSettings(ctx, deps) {
  const { store, policy } = deps;
  if (ctx.from?.is_bot) return;
  if (!isGroupChat(ctx)) {
    await ctx.reply('ℹ️ Call settings apply to groups.');
    return;
  }

  // Reading the settings is harmless; CHANGING them is owner-only during staging.
  const wantsChange = String(ctx.message?.text ?? '')
    .replace(/^\/\w+(@\w+)?\s*/i, '').trim().length > 0;
  if (wantsChange && policy) {
    const gate = canChangeSettings(policy, { userId: ctx.from?.id });
    if (!gate.allowed) {
      await ctx.reply(`🔒 ${esc(gate.reason)}`, { parse_mode: 'HTML' });
      return;
    }
  }

  const args = String(ctx.message?.text ?? '').replace(/^\/\w+(@\w+)?\s*/i, '').trim().split(/\s+/).filter(Boolean);
  const settings = store.groupSettings(ctx.chat.id);

  if (!args.length) {
    const mode = settings.autoCall === 'auto' ? 'ON' : 'OFF';
    await ctx.reply([
      '⚙️ <b>Call settings</b>',
      '',
      `Auto call: <b>${mode}</b>`,
      `Minimum MC to record: <b>${esc(fmtUsd(settings.minMarketCapUsd) ?? 'none')}</b>`,
      '',
      '<code>/callsettings autocall on|off</code>',
      '<code>/callsettings minmc 5000</code>',
      '',
      '<i>Auto call: a pasted contract is recorded as a call by whoever pasted it. Off by default — scanning and calling are different acts.</i>',
    ].join('\n'), { parse_mode: 'HTML' });
    return;
  }

  const [key, value] = args;
  if (key === 'autocall') {
    if (!['on', 'off'].includes(value)) {
      await ctx.reply('Usage: <code>/callsettings autocall on|off</code>', { parse_mode: 'HTML' });
      return;
    }
    const next = await store.setGroupSetting(ctx.chat.id, { autoCall: value === 'on' ? 'auto' : 'manual' });
    await ctx.reply(
      next.autoCall === 'auto'
        ? '✅ <b>Auto call ON</b> — a contract pasted in this group will be recorded as a call by the poster.'
        : '✅ <b>Auto call OFF</b> — pasted contracts are scanned only. Use /call to record a call.',
      { parse_mode: 'HTML' },
    );
    return;
  }
  if (key === 'minmc') {
    const usd = Number(String(value).replace(/[$,]/g, ''));
    if (!Number.isFinite(usd) || usd < 0) {
      await ctx.reply('Usage: <code>/callsettings minmc 5000</code>', { parse_mode: 'HTML' });
      return;
    }
    await store.setGroupSetting(ctx.chat.id, { minMarketCapUsd: usd });
    await ctx.reply(`✅ Minimum market cap set to <b>${esc(fmtUsd(usd) ?? usd)}</b>.`, { parse_mode: 'HTML' });
    return;
  }

  await ctx.reply('Unknown setting. Try <code>/callsettings</code> for the list.', { parse_mode: 'HTML' });
}

/**
 * /justscan — the next pasted CA in this message is scanned, not recorded.
 * Cancels auto-call for a single post so a group can discuss a token without
 * polluting its call record.
 */
export async function handleJustScan(ctx) {
  if (ctx.from?.is_bot) return;
  await ctx.reply(
    '🔍 <b>Scan only</b>\n\nThat contract was scanned, not recorded as a call.\n' +
    '<i>Auto call stays on for future contracts; use /callsettings autocall off to change it.</i>',
    { parse_mode: 'HTML' },
  );
}

export { renderPnlPng };

// ---- Caller profile (Phase 2, NOT the leaderboard) -----------------------

// ---- Caller profile (Phase 2, NOT the leaderboard) -----------------------

/**
 * Show a caller's history within ONE group.
 *
 * Access: during staging this is OWNER-only. The requirement is to not leak group
 * records through a forwarded or guessed link, and membership verification is a
 * Phase 6 concern (documented in docs/phase2-caller-profile.md).
 */
export async function handleCallerProfile(ctx, deps) {
  // `chatId` is the ORIGINATING GROUP the profile is about — never ctx.chat.id.
  // A profile link is opened in the bot DM, so ctx.chat.id there is the owner's
  // private chat. Querying it returned zero calls and produced an empty profile.
  const { store, callerKey, chatId, groupTitle, period = '7d', page = 0, policy, isOwnerCheck } = deps;
  if (!callerKey) {
    await ctx.reply('No caller specified.');
    return;
  }
  const scopeId = String(chatId ?? '');
  if (!scopeId) {
    await ctx.reply('That link is missing its group. Ask for a fresh First Call link.');
    return;
  }
  const owner = isOwnerCheck ? isOwnerCheck(ctx.from?.id) : true;
  if (policy && !owner) {
    await ctx.reply(
      '🔒 Caller profiles are restricted to the bot owner during staging.\n' +
      '<i>Group membership verification arrives in Phase 6.</i>',
      { parse_mode: 'HTML' },
    );
    return;
  }

  // Records are keyed by the group, and a caller may appear under either the
  // canonical callerKey ("u:42") or a legacy numeric callerId ("42").
  const bare = String(callerKey).replace(/^u:/, '');
  const all = store.callsForChat(scopeId, { limit: 1000 })
    .filter((c) => c.callerKey === callerKey || String(c.callerId) === bare
      || String(c.callerId) === callerKey);

  const visible = all.filter((c) => c.status !== 'cancelled' && !isSynthetic(c));
  const { text, page: safePage, pages } = renderCallerProfile({
    callerKey, calls: visible, groupTitle, period, page,
  });

  // The token is minted for the GROUP scope, so the period buttons keep working
  // from the DM without ever touching another group's records.
  const token = mintCallerToken(scopeId, callerKey, period);
  const keyboard = profileKeyboard({ callerToken: token, period, page: safePage, pages });
  return { text, keyboard, callerKey, period, chatId: scopeId };
}

/** Resolve a start payload to { chatId, callerKey, period } for the DM profile. */
export function resolveStartPayload(payload, store, { chatIds = [], periods = ['1d', '7d', '14d', '30d'] } = {}) {
  for (const chatId of chatIds) {
    const candidates = callerKeysInGroup(store, chatId).map((k) => ({ callerKey: k }));
    const hit = resolveCallerToken(payload, chatId, candidates, { periods });
    if (hit) return { chatId, callerKey: hit.callerKey, period: hit.period };
  }
  return null;
}

/** Every distinct caller key with at least one call in a group. */
export function callerKeysInGroup(store, chatId) {
  const calls = store.callsForChat(chatId, { limit: 1000 }).filter((c) => !isSynthetic(c));
  const keys = new Set();
  for (const c of calls) {
    if (c.callerKey) keys.add(c.callerKey);
    else if (c.callerId) keys.add(`u:${c.callerId}`);
  }
  return [...keys];
}
