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
import { loadPolicy, isChatAllowed, isOwner, describePolicy } from './access.mjs';
import { verifyExtremeObservation } from './extreme-verify.mjs';
import { resolveCaller, isAttributable } from './caller-identity.mjs';
import { mintCallerToken } from './deep-link.mjs';
import { recordCall, CALL_STATUS } from './call-service.mjs';
import { renderPnlPng, cleanupPng } from './pnl-render.mjs';
import {
  handleCall, handleCalls, handleFirstCall, handlePnl, handleCallSettings, handleJustScan,
  handleCallerProfile, resolveStartPayload, callerKeysInGroup,
  isGroupChat,
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
 * Durable call history. Created once at startup; the file path comes from
 * CALLS_DB_PATH so tests and future deployments can point it elsewhere.
 */
export const callStore = new CallStore();

/**
 * Staging access policy: which chats the bot may act in, and who may change
 * group settings. Configured by env; refuses by default rather than acting
 * everywhere when unset.
 */
export const accessPolicy = loadPolicy();

/**
 * Chats where the NEXT pasted contract should be scanned but NOT recorded.
 * Set by /justscan (no address) and consumed by the next CA message in that chat.
 * Time-boxed so a stale flag cannot silently suppress a later legitimate call.
 */
const justScanRequested = new Set();

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

  // ---- First-call attribution inside the card (groups only) --------------
  // Shown whenever a call already exists for this token in this group, in BOTH
  // auto and manual modes. A normal scan in manual mode does not create a call.
  let firstCall = null;
  let callerToken = null;
  if (isGroupChat(ctx) && result?.status === 'ok') {
    try {
      firstCall = callStore.firstCall(ctx.chat.id, chain, address);
      if (firstCall?.callerKey) {
        callerToken = mintCallerToken(ctx.chat.id, firstCall.callerKey, '7d');
      }
    } catch (err) {
      console.warn('[bot] first-call lookup failed (card continues):', err?.message ?? err);
    }
  }

  const { text, buttons } = formatCard(result, {
    mockLabel:   SCAN_MODE === 'mock',
    websiteBase: WEBSITE_BASE,
    premiumUrl:  PREMIUM_URL,
    botUsername: BOT_USERNAME,
    emojiTheme:  activeEmojiTheme,
    view,
    firstCall,
    callerToken,
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

/**
 * /start [payload]
 * A caller-profile deep link lands here. The payload is resolved against the
 * groups the bot knows, and only for the owner during staging.
 */
bot.start(async ctx => {
  const payload = (ctx.startPayload ?? '').trim();
  if (payload) {
    const hit = resolveStartPayload(payload, callStore, { chatIds: Object.keys(callStore.doc.groups ?? {}) });
    if (hit) {
      if (!isOwner(accessPolicy, ctx.from?.id)) {
        await ctx.reply(
          '🔒 Caller profiles are owner-only during staging.',
          { parse_mode: 'HTML' },
        );
        return;
      }
      const chat = callStore.doc.groups[hit.chatId];
      const out = await handleCallerProfile(ctx, {
        store: callStore,
        callerKey: hit.callerKey,
        groupTitle: chat?.title ?? hit.chatId,
        period: hit.period,
        policy: accessPolicy,
        isOwnerCheck: (id) => isOwner(accessPolicy, id),
      });
      if (out) await ctx.reply(out.text, { parse_mode: 'HTML', reply_markup: { inline_keyboard: out.keyboard } });
      return;
    }
    // Unknown/expired payload: do not reveal whether it ever existed.
    await ctx.reply('That link is no longer valid.', { parse_mode: 'HTML' });
    return;
  }

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

  // STAGING ALLOWLIST: the bot only acts in explicitly allowed chats. Any other
  // group is ignored completely — no scan, no reply, no call record.
  if (!isOwner(accessPolicy, ctx.from?.id)) {
    const gate = isChatAllowed(accessPolicy, ctx.chat?.id);
    if (!gate.allowed) {
      console.warn(`[bot] ignoring message: ${gate.reason}`);
      return;
    }
  }

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

  // A pending /justscan in this chat suppresses recording for exactly one CA.
  const skipRecording = justScanRequested.delete(String(ctx.chat?.id));

  // ---- Auto-call (Phase 2) ------------------------------------------------
  // In auto mode the PASTED contract is the call: the sender of this message owns
  // it, recorded BEFORE the card is built so the card can show the attribution in
  // the same message. one scan, one call, one card — no separate confirmation
  // message, and no second provider request.
  let callOutcome = null;
  if (isGroupChat(ctx)) {
    try {
      const settings = callStore.groupSettings(ctx.chat.id);
      if (settings.autoCall === 'auto' && !skipRecording) {
        const identity = resolveCaller(ctx.message, ctx.chat);
        if (isAttributable(identity)) {
          const result = await scan({ chain, address });
          callOutcome = await recordCall({
            store: callStore,
            scanResult: result,
            caller: identity,
            chatId: ctx.chat.id,
            source: 'auto',
            messageId: ctx.message?.message_id ?? null,
            messageDate: ctx.message?.date ?? null,
          });
        } else {
          console.log(`[bot] auto-call skipped: ${identity.attributionNote}`);
        }
      }
    } catch (err) {
      console.warn('[bot] auto-call failed (card continues):', err?.message ?? err);
    }
  }

  // The card reads attribution from the store, so a call recorded just above is
  // reflected in this same card. No separate message is sent.
  await runScan(ctx, chain, address, { justRecorded: callOutcome });
});

// ---- Phase 2: call tracking commands --------------------------------------

/** Shared dependency bundle for the call commands. */
function callDeps() {
  return {
    store: callStore,
    scan,
    policy: accessPolicy,
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
/**
 * /justscan — cancel an accidental auto-call.
 *
 * Two distinct jobs, both supported:
 *   1. `/justscan` sent BEFORE or WITH a CA in the same message: that CA is
 *      scanned but not recorded (handled by the flag in the message handler).
 *   2. `/justscan <address>` sent AFTER an accidental call: the call is marked
 *      cancelled so it stops counting, and the group is told. History is not
 *      deleted — the record is retained but excluded from metrics.
 */
bot.command('justscan', async ctx => {
  if (ctx.from?.is_bot) return;
  if (!isGroupChat(ctx)) {
    await ctx.reply('ℹ️ Just Scan applies in groups.');
    return;
  }

  const parsed = parseCallArgs(ctx.message?.text, DEFAULT_EVM);
  if (!parsed.address) {
    // No address: explain the behaviour for the NEXT message.
    justScanRequested.add(String(ctx.chat.id));
    setTimeout(() => justScanRequested.delete(String(ctx.chat.id)), 15_000).unref?.();
    await handleJustScan(ctx);
    return;
  }

  const chain = parsed.candidates[0].chain;
  const call = callStore.firstCall(ctx.chat.id, chain, parsed.address);
  if (!call) {
    await ctx.reply('📭 No recorded call for that token in this group — nothing to cancel.', { parse_mode: 'HTML' });
    return;
  }
  if (call.status === 'cancelled') {
    await ctx.reply('✅ That call is already cancelled.', { parse_mode: 'HTML' });
    return;
  }

  await callStore.updateCall(call.id, {
    status: 'cancelled',
    cancelledAt: Date.now(),
    cancelledBy: String(ctx.from?.id ?? ''),
    notes: [call.notes, 'cancelled via /justscan'].filter(Boolean).join('; '),
  });

  await ctx.reply(
    `🗑 <b>Call cancelled</b>

${esc(call.symbol ? '$' + call.symbol : (call.name ?? 'token'))} by ` +
    `<b>${esc(call.callerName ?? 'unknown')}</b> is no longer counted.
` +
    '<i>The record is kept for history but excluded from caller stats and alerts.</i>',
    { parse_mode: 'HTML' },
  );
});

/**
 * /profile [@username|userId] — caller history in THIS group.
 * Also reachable by clicking the First Call name on a card, which deep-links into
 * the DM with a signed payload.
 */
bot.command('profile', async ctx => {
  if (ctx.from?.is_bot) return;
  if (!isGroupChat(ctx)) {
    await ctx.reply('ℹ️ Caller profiles are per group. Use /profile inside the group.');
    return;
  }
  const arg = String(ctx.message?.text ?? '').replace(/^\/\w+(@\w+)?\s*/i, '').trim();
  const keys = callerKeysInGroup(callStore, ctx.chat.id);
  let callerKey = null;

  if (arg) {
    const bare = arg.replace(/^@/, '').toLowerCase();
    const calls = callStore.callsForChat(ctx.chat.id, { limit: 1000 });
    const match = calls.find((c) =>
      String(c.callerUsername ?? '').toLowerCase() === bare ||
      String(c.callerId ?? '') === bare ||
      String(c.callerKey ?? '') === arg);
    if (match) callerKey = match.callerKey ?? `u:${match.callerId}`;
  } else {
    // No argument: the caller's own profile.
    callerKey = resolveCaller(ctx.message, ctx.chat).callerKey;
  }

  if (!callerKey || !keys.includes(callerKey)) {
    await ctx.reply('No recorded calls by that caller in this group.', { parse_mode: 'HTML' });
    return;
  }

  if (!isOwner(accessPolicy, ctx.from?.id)) {
    await ctx.reply(
      '🔒 Caller profiles are restricted to the bot owner during staging.\n' +
      '<i>Group membership verification arrives in Phase 6.</i>',
      { parse_mode: 'HTML' },
    );
    return;
  }

  const out = await handleCallerProfile(ctx, {
    store: callStore,
    callerKey,
    groupTitle: callStore.doc.groups?.[String(ctx.chat.id)]?.title ?? ctx.chat.title ?? 'this group',
    period: '7d',
    policy: accessPolicy,
    isOwnerCheck: (id) => isOwner(accessPolicy, id),
  });
  if (out) {
    await ctx.reply(out.text, { parse_mode: 'HTML', reply_markup: { inline_keyboard: out.keyboard } });
  }
});

/** Period buttons + pagination on a caller profile. */
bot.action(/^c[pg]:cp_[A-Za-z0-9_-]+/, async ctx => {
  const data = ctx.match?.[0] ?? '';
  const [, token, period, pageRaw] = data.split(':');
  const owner = isOwner(accessPolicy, ctx.from?.id);
  if (!owner) {
    await ctx.answerCbQuery('Owner-only during staging');
    return;
  }
  const groups = Object.keys(callStore.doc.groups ?? {});
  const resolved = resolveStartPayload(token, callStore, { chatIds: groups });
  if (!resolved) {
    await ctx.answerCbQuery('Link expired');
    return;
  }
  const out = await handleCallerProfile(
    { ...ctx, chat: { id: resolved.chatId, title: callStore.doc.groups?.[resolved.chatId]?.title ?? '' } },
    {
      store: callStore,
      callerKey: resolved.callerKey,
      groupTitle: callStore.doc.groups?.[resolved.chatId]?.title ?? resolved.chatId,
      period: period ?? resolved.period,
      page: Number(pageRaw ?? 0) || 0,
      policy: accessPolicy,
      isOwnerCheck: (id) => isOwner(accessPolicy, id),
    },
  );
  await ctx.answerCbQuery();
  if (out) {
    await ctx.editMessageText(out.text, {
      parse_mode: 'HTML',
      reply_markup: { inline_keyboard: out.keyboard },
    });
  }
});

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
    const pol = describePolicy(accessPolicy);
    console.log(`[bot] Staging allowlist: chats=[${pol.allowedChats.join(', ') || 'none'}] owners=[${pol.owners.join(', ') || 'none'}] allowAny=${pol.allowAnyChat}`);
    console.log('[bot] Polling for updates. (Ctrl+C to stop)');
    return bot.launch();
  })
  .catch(err => {
    console.error('[bot] Failed to start:', err?.message ?? err);
    process.exit(1);
  });

process.once('SIGINT',  () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
