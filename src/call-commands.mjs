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

import { parseChainHint, detectAll, DEFAULT_EVM_CHAIN } from './detect-ca.mjs';
import { recordCall, observeCall, resolveCall, pnlText, CALL_STATUS } from './call-service.mjs';
import { callMetrics, fmtMultiple, fmtSignedPercent } from './calls.mjs';
import { fmtUsd } from './card-layout.mjs';
import { timeSince } from './calls.mjs';
import { isSynthetic } from './store.mjs';
import { getChain } from './chains.mjs';
import { renderPnlPng } from './pnl-render.mjs';

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
 * /pnl [number|address]
 * Refreshes the observation, then sends a shareable image card.
 * Falls back to the text card if the renderer is unavailable — it never claims
 * an image was sent when it was not.
 */
export async function handlePnl(ctx, deps) {
  const { store, scan, defaultEvmChain = DEFAULT_EVM_CHAIN, renderPng, sendPhoto } = deps;
  if (ctx.from?.is_bot) return;
  if (!isGroupChat(ctx)) {
    await ctx.reply('ℹ️ PnL cards are per group. Run /pnl in the group that made the call.');
    return;
  }

  const raw = String(ctx.message?.text ?? '').replace(/^\/\w+(@\w+)?\s*/i, '').trim();
  let call = null;
  let chain = null;
  let address = null;

  if (/^\d+$/.test(raw)) {
    // Index into the /calls list.
    const list = store.callsForChat(ctx.chat.id, { limit: 50 }).filter((c) => !isSynthetic(c));
    call = list[Number(raw) - 1] ?? null;
  } else if (raw) {
    const parsed = parseCallArgs(ctx.message?.text, defaultEvmChain);
    chain = parsed.candidates[0]?.chain ?? null;
    address = parsed.address;
    if (chain && address) call = resolveCall(store, ctx.chat.id, { chain, address });
  } else {
    // Bare /pnl → the most recent call in this group.
    call = resolveCall(store, ctx.chat.id, {});
  }

  if (!call) {
    await ctx.reply('📭 No matching call found. Use /calls to see the list.', { parse_mode: 'HTML' });
    return;
  }

  // Refresh the observation so the card is not misleadingly stale.
  try {
    const fresh = await scan({ chain: call.chain, address: call.address });
    const obs = await observeCall({ store, call, scanResult: fresh });
    if (obs.updated) call = obs.call;
  } catch (err) {
    console.warn('[pnl] refresh failed, using stored values:', err?.message ?? err);
  }

  const text = pnlText(call);
  const m = callMetrics(call);

  // Try the image card; degrade to text rather than lie about delivery.
  let sentImage = false;
  if (typeof renderPng === 'function' && typeof sendPhoto === 'function') {
    try {
      const png = await renderPng(call, { tokenName: call.name });
      if (png) {
        await sendPhoto(ctx.chat.id, png, {
          caption: text,
          parse_mode: 'HTML',
          reply_to_message_id: ctx.message?.message_id ?? undefined,
        });
        sentImage = true;
      }
    } catch (err) {
      console.warn('[pnl] image card failed, falling back to text:', err?.description ?? err?.message ?? err);
    }
  }
  if (!sentImage) {
    await ctx.reply(text, {
      parse_mode: 'HTML',
      link_preview_options: { is_disabled: true },
      reply_to_message_id: ctx.message?.message_id ?? undefined,
    });
  }
}

/**
 * /callsettings [autocall on|off] [minmc <usd>]
 * Per-group call-tracking settings. Admin-gated when Telegram tells us who is an
 * admin; when that is unavailable we fall back to allowing any member (documented
 * limitation, not a silent privilege escalation).
 */
export async function handleCallSettings(ctx, deps) {
  const { store } = deps;
  if (ctx.from?.is_bot) return;
  if (!isGroupChat(ctx)) {
    await ctx.reply('ℹ️ Call settings apply to groups.');
    return;
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
