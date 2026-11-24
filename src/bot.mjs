/**
 * src/bot.mjs
 * Meme Checker Telegram Bot — group and DM handlers.
 *
 * Env vars (see .env.example):
 *   TELEGRAM_BOT_TOKEN    — required for live Telegram
 *   SCAN_MODE             — 'mock' (default) or 'live'
 *   CARD_VIEW             — 'standard' (default), 'short' or 'detailed'
 *   DEFAULT_EVM_CHAIN     — chain assumed for a bare 0x… address (default bsc)
 *   TOKEN_PAGE_BASE_URL   — token page origin, when the website route is confirmed
 */

import { Telegraf, Markup } from 'telegraf';
import { detectAll, parseChainHint, DEFAULT_EVM_CHAIN as DETECT_DEFAULT_EVM } from './detect-ca.mjs';
import { checkCooldown } from './cooldown.mjs';
import { scan } from './scanner.mjs';
import { formatCard } from './format-card.mjs';
import { deliverCard } from './delivery.mjs';
import { resolveTokenImage } from './media.mjs';
import { CallStore } from './store.mjs';
import { recordCall, CALL_STATUS } from './call-service.mjs';
import { renderPnlPng, cleanupPng } from './pnl-render.mjs';
import {
  handleCall, handleCalls, handleFirstCall, handlePnl, handleCallSettings, handleJustScan,
  isGroupChat, callerIdentity,
} from './call-commands.mjs';
import { getChain, chainLabel, resolveChainAlias, capabilitySummary, CHAINS } from './chains.mjs';
import {
  loadEnvTheme, previewTheme, buildEmojiTheme, buildPendingMap, buildDirectMap,
  extractCustomEmojiIds, detectPackLink, listPackStickers, CARD_EMOJI_SLOTS,
} from './emoji-theme.mjs';

const BOT_TOKEN    = process.env.TELEGRAM_BOT_TOKEN ?? '';
const WEBSITE_BASE = (process.env.TOKEN_PAGE_BASE_URL ?? '').replace(/\/$/, '');
const PREMIUM_URL  = (process.env.PREMIUM_URL ?? '').trim();
const SCAN_MODE    = process.env.SCAN_MODE ?? 'mock';
const EMOJI_THEME  = loadEnvTheme();
const DEFAULT_EVM  = resolveChainAlias(process.env.DEFAULT_EVM_CHAIN ?? '') ?? DETECT_DEFAULT_EVM;

/**
 * Bot-level card mode. STANDARD is the product default: information-rich and
 * readable. 'short' is opt-in for groups that ask for a minimal card, and
 * 'detailed' is the full technical view.
 */
function normalizeCardView(v) {
  const s = String(v ?? '').toLowerCase();
  if (s === 'detailed' || s === 'detail') return 'detailed';
  if (s === 'short' || s === 'compact') return 'short';
  return 'standard';
}
let CARD_VIEW = normalizeCardView(process.env.CARD_VIEW ?? 'standard');

// Bot username populated after launch via getMe
let BOT_USERNAME = '';

if (!BOT_TOKEN) {
  console.error('[bot] TELEGRAM_BOT_TOKEN is not set. Exiting.');
  process.exit(1);
}

const bot = new Telegraf(BOT_TOKEN);

// ---- Helpers ---------------------------------------------------------------

function buildKeyboard(buttons) {
  if (!buttons?.length) return {};
  return Markup.inlineKeyboard(
    buttons.map(row =>
      Array.isArray(row) ? row.map(b => Markup.button.url(b.text, b.url)) : [Markup.button.url(row.text, row.url)]
    )
  );
}

async function runScan(ctx, chain, address, { view = CARD_VIEW } = {}) {
  const userId = ctx.from?.id ?? 0;
  const chatId = ctx.chat?.id ?? 0;

  const gate = checkCooldown({ userId, chatId, address });
  if (gate.blocked) {
    if (gate.reason === 'duplicate') {
      // Same CA already responded in this chat recently — silently skip.
      return;
    }
    if (gate.reason === 'cooldown') {
      await ctx.reply(`⏳ Please wait ${gate.waitSeconds}s before checking again.`);
      return;
    }
  }

  let loadingMsg;
  try {
    loadingMsg = await ctx.reply(`🔍 Scanning ${chainLabel(chain)} token…`);
  } catch (_) { /* non-fatal */ }

  const result = await scan({ chain, address });
  const { text, buttons } = formatCard(result, {
    mockLabel:   SCAN_MODE === 'mock',
    websiteBase: WEBSITE_BASE,
    premiumUrl:  PREMIUM_URL,
    botUsername: BOT_USERNAME,
    emojiTheme:  activeEmojiTheme,
    view,
  });

  // Resolve a VERIFIED project image before sending. Only a fetched, validated
  // image is used, and only for a successful scan. A miss is a text card.
  let imageUrl = null;
  if (result?.status === 'ok') {
    try {
      const img = await resolveTokenImage(result);
      imageUrl = img?.url ?? null;
      if (img) console.log(`[bot] image: ${img.kind} ${img.bytes}B for ${chain}:${address.slice(0, 10)}…`);
    } catch (err) {
      console.warn('[bot] image resolution failed:', err?.message ?? err);
    }
  }

  // ONE delivery per scan: photo-with-caption, or text. Never both.
  const sent = await deliverCard({
    telegram: {
      sendPhoto: (chat, url, opts) => ctx.telegram.sendPhoto(chat, url, opts),
      sendMessage: (chat, body, opts) => ctx.telegram.sendMessage(chat, body, opts),
    },
    chatId,
    text,
    buttons,
    imageUrl,
    replyToMessageId: ctx.message?.message_id ?? null,
  });

  if (!sent.ok) {
    console.error('[bot] delivery failed:', sent.detail);
  }
  if (sent.fellBack) {
    console.warn(`[bot] card fell back to text: ${sent.fallbackReason}`);
  }

  // The "scanning" placeholder must not survive the result — however it was sent.
  if (loadingMsg) {
    await ctx.telegram.deleteMessage(chatId, loadingMsg.message_id).catch(() => {});
  }
  return sent;
}

// ---- Commands --------------------------------------------------------------

bot.start(async ctx => {
  if (ctx.from?.is_bot) return;
  const text = [
    '👋 <b>Welcome to MEME CHECKER</b>',
    '',
    'Your quick Meme Coin research assistant.',
    '',
    '🔎 <b>What you can do:</b>',
    '• Post any Solana or BNB Chain contract address in the chat',
    '• Use <code>/check &lt;address&gt;</code> to check manually',
    '• Use <code>/help</code> to see all commands',
    '',
    'Want deeper intelligence?',
    '• Bubble Map',
    '• Dev Wallet Analysis',
    '• Bundle Wallet Tracking',
    '• KOL Intelligence',
    '• Smart Alerts',
    '',
    '👉 Open <b>Meme Checker Website</b> for the full analysis.',
  ].join('\n');

  const kb = WEBSITE_BASE
    ? Markup.inlineKeyboard([[Markup.button.url('🌐 Open Meme Checker', `${WEBSITE_BASE}?utm_source=telegram&utm_medium=dm&utm_campaign=start`)]])
    : {};

  await ctx.reply(text, { parse_mode: 'HTML', ...kb });
});

bot.help(async ctx => {
  if (ctx.from?.is_bot) return;
  const text = [
    '📖 <b>MEME CHECKER — Help</b>',
    '',
    '<b>Commands:</b>',
    '• <code>/start</code> — Introduction',
    '• <code>/help</code> — This message',
    '• <code>/check &lt;address&gt;</code> — Check a token',
    '• <code>/check &lt;chain&gt; &lt;address&gt;</code> — Check on a specific chain',
    '• <code>/chains</code> — Supported networks and what each can show',
    '• <code>/call &lt;address&gt;</code> — Record a call (groups)',
    '• <code>/calls</code> — Recent calls in this group',
    '• <code>/fc &lt;address&gt;</code> — Who called it first',
    '• <code>/pnl [n|address]</code> — Shareable PnL card',
    '• <code>/callsettings</code> — Auto-call and minimum market cap',
    '• <code>/compact</code> — Compact card (default)',
    '• <code>/detail</code> — Detailed card',
    '• <code>/about</code> — About Meme Checker',
    '• <code>/website</code> — Open the website',
    '',
    '<b>Auto-detect:</b>',
    'Paste a Solana or EVM contract address in the chat and Meme Checker will scan it.',
    'A 0x address can exist on several networks, so you will be asked to pick one.',
    '',
    '<b>Cooldowns:</b> 15 s per user. Duplicate addresses in the same chat are skipped for 60 s.',
  ].join('\n');

  await ctx.reply(text, { parse_mode: 'HTML' });
});

bot.command('about', async ctx => {
  if (ctx.from?.is_bot) return;
  const text = [
    '🚀 <b>MEME CHECKER</b>',
    '',
    'Fast token intelligence for Telegram communities.',
    '',
    'Paste any contract address in a group or DM and get instant market data, holder overview, and project info.',
    '',
    'Deeper analysis — Bubble Map, Dev Wallet, Bundle Wallet, KOL calls — is available on the website.',
  ].join('\n');

  const kb = WEBSITE_BASE
    ? Markup.inlineKeyboard([[Markup.button.url('🌐 Explore Meme Checker', `${WEBSITE_BASE}?utm_source=telegram&utm_medium=dm&utm_campaign=about`)]])
    : {};

  await ctx.reply(text, { parse_mode: 'HTML', ...kb });
});

bot.command('website', async ctx => {
  if (ctx.from?.is_bot) return;
  if (WEBSITE_BASE) {
    await ctx.reply(
      `🌐 Open Meme Checker: ${WEBSITE_BASE}`,
      Markup.inlineKeyboard([[Markup.button.url('🌐 Open Meme Checker', `${WEBSITE_BASE}?utm_source=telegram&utm_medium=dm&utm_campaign=website`)]])
    );
  } else {
    await ctx.reply('🌐 Website URL not configured yet. Check back soon.');
  }
});

bot.command('upgrade', async ctx => {
  if (ctx.from?.is_bot) return;
  // Only use PREMIUM_URL — no auto-derivation from WEBSITE_BASE/pricing.
  if (PREMIUM_URL) {
    await ctx.reply(
      '⚡ Unlock full intelligence on Meme Checker.',
      Markup.inlineKeyboard([[Markup.button.url('⚡ Unlock Premium', PREMIUM_URL)]])
    );
  } else if (WEBSITE_BASE) {
    await ctx.reply('⚡ Premium analysis is available on the Meme Checker website.', {
      ...Markup.inlineKeyboard([[Markup.button.url('🌐 Explore Meme Checker', `${WEBSITE_BASE}?utm_source=telegram&utm_medium=dm&utm_campaign=upgrade`)]]),
    });
  } else {
    await ctx.reply('⚡ Premium info coming soon. Visit the website for details.');
  }
});

bot.command('resettheme', async ctx => {
  if (ctx.from?.is_bot) return;
  if (ctx.chat?.type !== 'private') return; // owner DM only
  pendingTheme = null;
  activeEmojiTheme = loadEnvTheme(); // revert to env-configured or standard
  await ctx.reply('↩️ Emoji theme reset to default (standard emoji or EMOJI_THEME env if set).');
});

bot.command('check', async ctx => {
  if (ctx.from?.is_bot) return;

  const raw = (ctx.message?.text ?? '').replace(/^\/check(@\w+)?\s*/i, '').trim();
  if (!raw) {
    await ctx.reply(
      'Usage:\n' +
      '<code>/check &lt;address&gt;</code>\n' +
      '<code>/check &lt;chain&gt; &lt;address&gt;</code>\n\n' +
      'Example: <code>/check base 0x4200…0006</code>\n' +
      'See <code>/chains</code> for supported networks.',
      { parse_mode: 'HTML' },
    );
    return;
  }

  // An explicit chain prefix removes EVM ambiguity.
  const hint = parseChainHint(raw);
  const det = detectAll(hint.rest, { defaultEvmChain: DEFAULT_EVM, chainHint: hint.chainId });

  if (!det.candidates.length) {
    await ctx.reply(
      '❌ <b>Invalid Contract Address</b>\n\nSupported formats:\n• Solana: base58, 32–44 characters\n• EVM: 0x + 40 hex characters',
      { parse_mode: 'HTML' },
    );
    return;
  }

  if (hint.chainId && !det.candidates.some((c) => c.chain === hint.chainId)) {
    await ctx.reply(`❌ That address is not valid on ${chainLabel(hint.chainId)}.`, { parse_mode: 'HTML' });
    return;
  }

  const { chain, address } = det.candidates[0];
  await runScan(ctx, chain, address);
});

// ---- Card view toggle ------------------------------------------------------

bot.command('standard', async ctx => {
  if (ctx.from?.is_bot) return;
  CARD_VIEW = 'standard';
  await ctx.reply('📋 Card view set to <b>standard</b> (default).', { parse_mode: 'HTML' });
});

bot.command('short', async ctx => {
  if (ctx.from?.is_bot) return;
  CARD_VIEW = 'short';
  await ctx.reply('⚡ Card view set to <b>short</b>.', { parse_mode: 'HTML' });
});

// 'compact' is kept as an alias so any existing saved workflow still works.
bot.command('compact', async ctx => {
  if (ctx.from?.is_bot) return;
  CARD_VIEW = 'short';
  await ctx.reply('⚡ Card view set to <b>short</b>.', { parse_mode: 'HTML' });
});

bot.command('detail', async ctx => {
  if (ctx.from?.is_bot) return;
  CARD_VIEW = 'detailed';
  await ctx.reply('📄 Card view set to <b>detailed</b>.', { parse_mode: 'HTML' });
});

// ---- Chain support reference ----------------------------------------------

bot.command('chains', async ctx => {
  if (ctx.from?.is_bot) return;
  const rows = capabilitySummary();
  const lines = ['🌐 <b>Supported Chains</b>', ''];
  for (const r of rows) {
    if (!r.market) {
      lines.push(`${getChain(r.id).emoji} <b>${r.name}</b> — scan unavailable`);
      continue;
    }
    const bits = [];
    // Only claim a capability the data source actually provides.
    bits.push(r.holders ? 'holders' : null);
    bits.push(r.tax ? 'tax' : null);
    bits.push(r.lpLock ? 'LP lock' : null);
    bits.push(r.dexPaid ? 'dex paid' : null);
    lines.push(`${getChain(r.id).emoji} <b>${r.name}</b> — ${bits.filter(Boolean).join(', ')}`);
  }
  lines.push('');
  lines.push('<i>Bare 0x addresses default to ' + chainLabel(DEFAULT_EVM) + '. Prefix another chain to switch, e.g.</i>');
  lines.push('<code>/check base 0x…</code>');
  await ctx.reply(lines.join('\n'), { parse_mode: 'HTML', disable_web_page_preview: true });
});

// ---- Auto-detect in messages -----------------------------------------------

// Pending emoji theme: set while awaiting owner approval of a preview.
// { map: {std: id, ...}, approvalChatId: number }
let pendingTheme = null;
// Runtime-mutable active theme (starts from env, can be updated by owner DM).
let activeEmojiTheme = EMOJI_THEME;

/** Send a preview card and ask the owner to approve. Only works in private DMs. */
async function sendEmojiPreview(ctx, map) {
  const theme = buildEmojiTheme(map);
  if (theme === (await import('./emoji-theme.mjs')).noTheme) {
    await ctx.reply('⚠️ None of those emoji IDs could be mapped — no valid numeric IDs found. Try sending individual custom emoji or a pack link.');
    return;
  }

  pendingTheme = { map, approvalChatId: ctx.chat.id };

  const mappedCount = Object.keys(map).length;
  const totalSlots = CARD_EMOJI_SLOTS.length;

  // ---- Render labeled mock cards (Solana + BNB) with the theme applied ----
  // Both chains shown so the owner can verify chain-specific icons before approving.
  const { mockScan } = await import('./mock-scan.mjs');
  const [solResult, bnbResult] = await Promise.all([
    mockScan({ chain: 'solana', address: 'FiXtUrE111111111111111111111111111111111111' }),
    mockScan({ chain: 'bsc',    address: '0xabcdef0123456789abcdef0123456789abcdef01' }),
  ]);
  const cardOpts = { mockLabel: true, websiteBase: WEBSITE_BASE, premiumUrl: PREMIUM_URL, botUsername: BOT_USERNAME, emojiTheme: theme };
  const { text: solCardText } = formatCard(solResult, cardOpts);
  const { text: bnbCardText } = formatCard(bnbResult, cardOpts);

  await ctx.reply(
    `🎨 <b>Emoji Theme Preview</b> — ${mappedCount} of ${totalSlots} card slots themed\n\n` +
    `<b>Note:</b> Custom emoji render only when the bot owner has Telegram Premium. Standard emoji always shows as fallback.\n\n` +
    `Approve this theme? Reply <b>✅ yes</b> or <b>❌ no</b>.`,
    { parse_mode: 'HTML' }
  );

  // Send both chain cards so the owner sees all themed icons in context
  await ctx.reply(solCardText, { parse_mode: 'HTML', disable_web_page_preview: true });
  await ctx.reply(bnbCardText, { parse_mode: 'HTML', disable_web_page_preview: true });
}

bot.on('message', async ctx => {
  // Skip other bots (loop guard)
  if (ctx.from?.is_bot) return;

  const msg = ctx.message;
  const msgText = msg?.text ?? msg?.caption ?? '';
  const isPrivate = ctx.chat?.type === 'private';

  // ---- Owner emoji-selection flow (private DM only) -----------------------
  if (isPrivate) {
    // Approval response for a pending preview
    if (pendingTheme && pendingTheme.approvalChatId === ctx.chat.id) {
      const reply = msgText.trim().toLowerCase();
      if (/^(yes|✅|y|ok|apply)/.test(reply)) {
        activeEmojiTheme = buildEmojiTheme(pendingTheme.map);
        pendingTheme = null;
        await ctx.reply('✅ Theme applied. New scans will use the custom emoji. Send <b>❌ no</b> or /resettheme to revert.', { parse_mode: 'HTML' });
        return;
      }
      if (/^(no|❌|n|cancel|reject)/.test(reply)) {
        pendingTheme = null;
        await ctx.reply('❌ Theme discarded. Standard emoji will be used.');
        return;
      }
    }

    // Pack link detection (t.me/addemoji/PACKNAME)
    const packName = detectPackLink(msgText);
    if (packName) {
      await ctx.reply(`🔍 Fetching emoji pack <code>${packName}</code>…`, { parse_mode: 'HTML' });
      try {
        const stickerSet = await ctx.telegram.getStickerSet(packName);
        const stickers = stickerSet?.stickers ?? [];
        const customStickers = stickers.filter(s => s.custom_emoji_id);
        if (!customStickers.length) {
          await ctx.reply(`⚠️ Pack <code>${packName}</code> has no custom emoji stickers.`, { parse_mode: 'HTML' });
          return;
        }
        // List by index — alt-emoji in packs like CryptoIcons are unreliable labels.
        const listing = listPackStickers(stickers);
        const listLines = listing.slice(0, 50).map(s => `[${s.index}] ${s.emoji} → <code>${s.custom_emoji_id}</code>`);
        await ctx.reply(
          `📦 <b>${packName}</b> — ${listing.length} custom emoji.\n\n` +
          `Alt-emoji labels may be misleading. Identify logos by index:\n\n` +
          listLines.join('\n') +
          (listing.length > 50 ? `\n… and ${listing.length - 50} more.` : '') +
          `\n\n<b>To apply:</b> Send a JSON map of card-slot emoji → ID:\n` +
          `<code>{"🟣":"ID_FOR_SOLANA","🌍":"ID_FOR_WEBSITE","✖️":"ID_FOR_X","✈️":"ID_FOR_TELEGRAM"}</code>`,
          { parse_mode: 'HTML' }
        );
      } catch (err) {
        await ctx.reply(`⚠️ Could not fetch pack <code>${packName}</code>: ${err?.message ?? 'unknown error'}.`, { parse_mode: 'HTML' });
      }
      return;
    }

    // Direct JSON map input: {"🟣":"5291923604487808793", ...}
    if (msgText.trim().startsWith('{')) {
      try {
        const parsed = JSON.parse(msgText.trim());
        const map = buildDirectMap(parsed);
        if (!Object.keys(map).length) {
          await ctx.reply('⚠️ No valid emoji ID entries found. IDs must be numeric strings.\nExample: <code>{"🟣":"5291923604487808793"}</code>', { parse_mode: 'HTML' });
          return;
        }
        await sendEmojiPreview(ctx, map);
        return;
      } catch {
        // Not valid JSON — fall through to normal CA detection
      }
    }

    // Individual custom_emoji entity detection
    const entities = msg?.entities ?? msg?.caption_entities ?? [];
    const customIds = extractCustomEmojiIds(entities);
    if (customIds.length) {
      try {
        const stickers = await ctx.telegram.getCustomEmojiStickers(customIds);
        const map = buildPendingMap(stickers);
        await sendEmojiPreview(ctx, map);
      } catch (err) {
        await ctx.reply(`⚠️ Could not resolve custom emoji: ${err?.message ?? 'unknown error'}.`);
      }
      return;
    }
  }

  // ---- CA auto-detection (groups and DMs) ---------------------------------
  if (!msgText) return;

  const det = detectAll(msgText, { defaultEvmChain: DEFAULT_EVM });
  if (!det.candidates.length) return;

  // An EVM address is valid on 13 chains. Scanning the wrong one wastes a
  // request and shows the wrong token, so offer the chains instead of guessing.
  // The default is still one tap away and is first in the list.
  if (det.kind === 'evm' && det.ambiguous && det.hasOwnProperty('evmChains')) {
    await sendChainPicker(ctx, det.candidates[0].address);
    return;
  }

  // Process first detected candidate only (brief: one reply per message)
  const { chain, address } = det.candidates[0];

  // ---- Auto-call (Phase 2) ------------------------------------------------
  // Recorded BEFORE the card is sent so the call is persisted even if delivery
  // fails, and only in groups with auto-call explicitly switched on. Scanning and
  // calling stay distinct acts everywhere else.
  let callOutcome = null;
  if (isGroupChat(ctx)) {
    try {
      const settings = callStore.groupSettings(ctx.chat.id);
      if (settings.autoCall === 'auto') {
        const result = await scan({ chain, address });
        callOutcome = await recordCall({
          store: callStore,
          scanResult: result,
          caller: callerIdentity(ctx),
          chatId: ctx.chat.id,
          source: 'auto',
          messageId: ctx.message?.message_id ?? null,
        });
      }
    } catch (err) {
      console.warn('[bot] auto-call failed (card continues):', err?.message ?? err);
    }
  }

  await runScan(ctx, chain, address);

  // Confirm a recorded call so the group can see attribution happened.
  if (callOutcome?.status === CALL_STATUS.RECORDED) {
    const who = ctx.from?.username ? `@${ctx.from.username}` : (ctx.from?.first_name ?? 'caller');
    const mcap = callOutcome.entryMarketCapUsd;
    await ctx.reply(
      `📌 Call recorded by <b>${who}</b>${callOutcome.isFirstCall ? ' · 🥇 first call' : ''} at <b>$${(mcap / 1e6).toFixed(2)}M</b>`,
      { parse_mode: 'HTML', reply_to_message_id: ctx.message?.message_id ?? undefined },
    ).catch(() => {});
  }
});

// ---- Phase 2: call tracking commands --------------------------------------

/** Shared dependency bundle for the call commands. */
function callDeps() {
  return {
    store: callStore,
    scan,
    defaultEvmChain: DEFAULT_EVM,
    renderPng: renderPnlPng,
    sendPhoto: async (chatId, filePath, opts) => {
      try {
        // Telegraf accepts a path plus options; { source } is the documented form.
        return await ctx_sendPhoto(chatId, filePath, opts);
      } finally {
        cleanupPng(filePath);
      }
    },
  };
}

// Telegraf's sendPhoto is called through an indirection so the generated PNG is
// always cleaned up, including on failure.
let ctx_sendPhoto = async () => { throw new Error('sendPhoto not initialised'); };

bot.command('call',    ctx => handleCall(ctx, callDeps()));
bot.command('calls',   ctx => handleCalls(ctx, callDeps()));
bot.command('fc',      ctx => handleFirstCall(ctx, callDeps()));
bot.command('callsettings', ctx => handleCallSettings(ctx, callDeps()));
bot.command('justscan', ctx => handleJustScan(ctx));

bot.command('pnl', async ctx => {
  // sendPhoto needs the ctx-scoped telegram client, so bind it per invocation.
  const deps = callDeps();
  deps.sendPhoto = async (chatId, filePath, opts) => {
    try {
      return await ctx.telegram.sendPhoto(chatId, { source: filePath }, opts);
    } finally {
      cleanupPng(filePath);
    }
  };
  return handlePnl(ctx, deps);
});

// ---- Chain picker for ambiguous EVM addresses ------------------------------

/**
 * Ask which chain a bare 0x… address belongs to.
 * Callback data stays well under Telegram's 64-byte limit: "c:<chain>:<addr>".
 */
async function sendChainPicker(ctx, address) {
  const chains = Object.values(CHAINS).filter((c) => c.kind === 'evm' && c.market);
  // 2 per row keeps labels readable on mobile.
  const rows = [];
  for (let i = 0; i < chains.length; i += 2) {
    rows.push(chains.slice(i, i + 2).map((c) => {
      const mark = c.id === DEFAULT_EVM ? '★ ' : '';
      return Markup.button.callback(`${mark}${c.name}`, `c:${c.id}:${address}`);
    }));
  }
  rows.push([Markup.button.callback('✖️ Cancel', 'c:cancel')]);

  await ctx.reply(
    `<b>Which chain is this address on?</b>\n\n<code>${escHtml(address)}</code>\n\n` +
    `A 0x address can exist on several networks, so I will not guess.\n` +
    `★ marks the default. You can also type <code>/check base ${escHtml(address.slice(0, 10))}…</code>`,
    { parse_mode: 'HTML', ...Markup.inlineKeyboard(rows) },
  );
}

function escHtml(v) {
  return String(v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

bot.action(/^c:(.+)$/, async ctx => {
  const data = ctx.match[1];
  if (data === 'cancel') {
    await ctx.answerCbQuery('Cancelled');
    await ctx.deleteMessage().catch(() => {});
    return;
  }
  // "chain:address"
  const sep = data.indexOf(':');
  const chain = data.slice(0, sep);
  const address = data.slice(sep + 1);
  const def = getChain(chain);
  if (!def || def.kind !== 'evm') {
    await ctx.answerCbQuery('Unknown chain');
    return;
  }
  await ctx.answerCbQuery(`Scanning ${def.name}…`);
  // Remove the picker so the chat is not left with a dead keyboard.
  await ctx.deleteMessage().catch(() => {});
  await runScan(ctx, chain, address.toLowerCase());
});

// ---- Card view toggle via inline button ------------------------------------

bot.action(/^v:(compact|detailed)(?::(.+))?$/, async ctx => {
  const view = ctx.match[1];
  const address = ctx.match[2] ?? null;
  CARD_VIEW = view;
  await ctx.answerCbQuery(view === 'detailed' ? 'Detailed view' : 'Compact view');
  if (!address) return;
  // Re-render the same token immediately in the new mode.
  await runScan(ctx, DEFAULT_EVM, address.toLowerCase(), { view });
});

// ---- Error handler ---------------------------------------------------------

bot.catch((err, ctx) => {
  console.error('[bot] unhandled error:', err?.message ?? err);
  ctx?.reply?.('⚠️ An unexpected error occurred. Please try again.').catch(() => {});
});

// ---- Launch ----------------------------------------------------------------

console.log(`[bot] Starting Meme Checker bot (SCAN_MODE=${SCAN_MODE})…`);
// Startup order (all before polling begins):
//  1) getMe → set BOT_USERNAME so the Add-to-Group button is populated on the first card
//  2) setMyCommands → command menu live from the first update (not after polling stops)
//  3) launch() → Telegraf v4 launch() resolves on stop, so it stays last
// /upgrade is always registered; PREMIUM_URL only controls the card button, not the command.
Promise.resolve(bot.telegram?.getMe?.())
  .then(async me => {
    BOT_USERNAME = me?.username ?? '';
    const who = BOT_USERNAME ? `@${BOT_USERNAME}` : 'Telegram';
    console.log(`[bot] Connected as ${who}.`);
    try {
      await bot.telegram.setMyCommands([
        { command: 'start',   description: 'Welcome and introduction' },
        { command: 'help',    description: 'Show all commands' },
        { command: 'check',   description: 'Check a token: /check <address>' },
        { command: 'standard', description: 'Standard card view (default)' },
        { command: 'short',   description: 'Short summary card' },
        { command: 'detail',  description: 'Detailed card view' },
        { command: 'chains',  description: 'Supported chains and data coverage' },
        { command: 'call',    description: 'Record a call: /call <address>' },
        { command: 'calls',   description: 'Recent calls in this group' },
        { command: 'fc',      description: 'Who called a token first' },
        { command: 'pnl',     description: 'Shareable PnL card' },
        { command: 'callsettings', description: 'Auto-call and minimum MC' },
        { command: 'about',   description: 'About Meme Checker' },
        { command: 'website', description: 'Open the Meme Checker website' },
        { command: 'upgrade', description: 'Unlock Premium analysis' },
      ]);
      console.log('[bot] Command menu registered.');
    } catch (err) {
      console.warn('[bot] Could not register command menu:', err?.message ?? err);
    }
    console.log('[bot] Polling for updates. (Ctrl+C to stop)');
    return bot.launch();
  })
  .catch(err => {
    console.error('[bot] Failed to start:', err?.message ?? err);
    process.exit(1);
  });

process.once('SIGINT',  () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
