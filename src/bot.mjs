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
import { esc } from './card-layout.mjs';
import { deliverCard } from './delivery.mjs';
import { resolveTokenImage } from './media.mjs';
import { CallStore } from './store.mjs';
import { loadPolicy, isChatAllowed, isOwner, describePolicy } from './access.mjs';
import { verifyExtremeObservation } from './extreme-verify.mjs';
import { resolveCaller, isAttributable } from './caller-identity.mjs';
import { mintCallerToken, DEFAULT_PERIOD } from './deep-link.mjs';
import { handleAlerts, handleAlertsCallback } from './alert-commands.mjs';
import { handleAlertTest } from './alert-test.mjs';
import { handleNarrative, handleX, handleKol } from './research/research-commands.mjs';
import { handleRisk, handleDev, handleBundle } from './risk-commands.mjs';
import {
  handleLeaderboard, handleGroupPnl, handleSettings,
  handleBoardCallback, handleSettingsCallback,
} from './settings-commands.mjs';
import { callerLabel } from './caller-identity.mjs';
import { isEntitledToFullResearch, buildPreview, renderPreview } from './research/premium-preview.mjs';
import { cardXSection } from './research/research-service.mjs';
import { researchToken, cardNarrativeLines, cardXLine, cardKolLine } from './research/research-service.mjs';
import { researchCache, xBudget } from './research/research-cache.mjs';
import { startObserver } from './observer-loop.mjs';
import { recordCall, CALL_STATUS } from './call-service.mjs';
import { renderPnlPng, cleanupPng } from './pnl-render.mjs';
import {
  handleCall, handleCalls, handleFirstCall, handlePnl, handleCallSettings, handleJustScan,
  handleCallerProfile, resolveStartPayload, callerKeysInGroup, sendPnlFor, parseCallArgs,
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
// Phase 3 observer. On by default: automatic monitoring is the point of the phase.
// Every knob is env-overridable so the owner can slow it down without a code change.
const OBSERVER_ENABLED      = (process.env.OBSERVER ?? 'on').toLowerCase() !== 'off';
const OBSERVER_INTERVAL_MS  = Math.max(5_000, Number(process.env.OBSERVER_INTERVAL_MS) || 20_000);
const OBSERVER_MAX_TOKENS   = Math.max(1, Number(process.env.OBSERVER_MAX_TOKENS) || 12);
const OBSERVER_CONCURRENCY  = Math.max(1, Number(process.env.OBSERVER_CONCURRENCY) || 3);
// Phase 4 research enrichment on scan cards. On by default because the narrative
// is a headline feature; RESEARCH_ON_SCAN=off disables the extra call entirely.
const RESEARCH_ON_SCAN_FLAG = (process.env.RESEARCH_ON_SCAN ?? 'on').toLowerCase() !== 'off';
// Hard ceiling for research on a card. A scan must stay responsive even if a
// provider is slow, so the card ships without research rather than waiting.
const RESEARCH_TIMEOUT_MS = Math.max(1_000, Number(process.env.RESEARCH_TIMEOUT_MS) || 2_500);
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
 * Context for a chain picker that is waiting for a tap.
 *
 * callback_data is capped at 64 bytes, and `c:<chain>:<0xaddress>` already uses
 * ~50, so the original message context cannot travel in the button. It is stashed
 * here instead, keyed by chat+address, and consumed when the chain is chosen.
 *
 * This exists so the chain choice RESUMES the original action with the ORIGINAL
 * author: the person who taps the button is often not the person who pasted the
 * contract, and attributing the call to the tapper would be wrong.
 */
const pendingScans = new Map();
const PENDING_TTL_MS = 10 * 60_000;

function stashPendingScan(autoCallBlock) {
  const { chatId, address } = autoCallBlock;
  const key = `${chatId}:${String(address).toLowerCase()}`;
  pendingScans.set(key, { ...autoCallBlock, at: Date.now() });
  // Bound the map: this is short-lived interaction state, not storage.
  for (const [k, v] of pendingScans) {
    if (Date.now() - v.at > PENDING_TTL_MS) pendingScans.delete(k);
  }
  return key;
}

function takePendingScan(chatId, address) {
  const key = `${chatId}:${String(address).toLowerCase()}`;
  const hit = pendingScans.get(key) ?? null;
  if (hit) pendingScans.delete(key);
  if (hit && Date.now() - hit.at > PENDING_TTL_MS) return null;
  return hit;
}

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
/** Phase 3 observer controller, stopped on shutdown. */
let observer = null;

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

async function runScan(ctx, chain, address, {
  view = CARD_VIEW,
  /**
   * The message the card must reply to.
   *
   * On a chain-picker callback, `ctx.message` is the PICKER, not the user's original
   * contract paste. Replying to the picker strands the result away from the CA and
   * answers the wrong message. The original id is therefore threaded through the
   * pending-scan state and passed in explicitly.
   */
  replyToMessageId = undefined,
  /** Group id the scan belongs to; a callback may carry a different chat object. */
  chatId: chatIdOverride = undefined,
} = {}) {
  const userId = ctx.from?.id ?? 0;
  const chatId = chatIdOverride ?? ctx.chat?.id ?? 0;

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
        callerToken = mintCallerToken(ctx.chat.id, firstCall.callerKey, DEFAULT_PERIOD);
      }
    } catch (err) {
      console.warn('[bot] first-call lookup failed (card continues):', err?.message ?? err);
    }
  }

  // ---- Optional research (Phase 4) ---------------------------------------
  // Fetched with a hard timeout and cached; a miss or a failure leaves the card's
  // existing narrative line untouched. Research NEVER blocks or breaks a scan:
  // the market card is already complete before this runs.
  let researchLines = null;
  if (result?.status === 'ok' && SCAN_MODE === 'live' && RESEARCH_ON_SCAN_FLAG) {
    try {
      const research = await Promise.race([
        researchToken({
          chain,
          address,
          symbol: result?.token?.symbol ?? null,
          cache: researchCache,
          budget: xBudget,
          // No X search on a card. Discovery costs one billed request and needs a 5s
          // pacing gap, while this scan has a 2.5s ceiling - so a scan would be
          // charged, wait, and abandon the request. The card shows only posts that
          // are ALREADY cached; /x does the real paced fetch.
          includePosts: true,
          xCacheOnly: true,
        }),
        new Promise((resolve) => setTimeout(() => resolve(null), RESEARCH_TIMEOUT_MS)),
      ]);
      if (research) {
        // Prefer the researched narrative over the market provider's absent one.
        if (research.narrative?.available && (!result.narrative?.summary)) {
          result.narrative = {
            summary: cardNarrativeLines(research.narrative),
            source: research.narrative.summarySource,
            // Labelled a project claim so the card does not present it as verified.
            evidence: research.narrative.summaryClass,
          };
        }
        // 4A/C: the standard card shows a LOCKED premium teaser, not a technical
        // status line. Detail remains available to the OWNER during staging for
        // verification, so `premiumTeaser` is suppressed for an entitled caller who
        // actually has cached research to look at.
        const entitled = isEntitledToFullResearch(accessPolicy, ctx.from?.id);
        const section = cardXSection(research, { entitled, premiumUrl: PREMIUM_URL });
        const hasDetailed = entitled && (research.x?.available && (research.x.posts?.length ?? 0) > 0);
        researchLines = {
          // The teaser is the default for everyone else, cached evidence or not: it is
          // a product surface, not a data readout.
          premiumTeaser: !hasDetailed,
          premiumUrl: PREMIUM_URL || null,
          previewLines: entitled ? renderPreview(section.preview, { esc }) : null,
          // Only populated for an entitled caller. Null means "teaser".
          xLine: hasDetailed ? cardXLine(research.x) : null,
          kolLine: hasDetailed ? cardKolLine(research.x) : null,
        };

        // Persist genuine public-call evidence so /kol can retrieve it later.
        // Separate from group calls, and idempotent per (handle, post id).
        try {
          if (research.x?.available && (research.x.posts?.length ?? 0) > 0) {
            callStore.recordXCallsFromResearch(research, {
              chain,
              address,
              symbol: result?.token?.symbol ?? null,
            });
          }
        } catch (err) {
          // Evidence persistence must never break a scan.
          console.warn('[bot] x-call persistence skipped:', err?.message ?? err);
        }
      }
    } catch (err) {
      console.warn('[bot] research enrichment skipped:', err?.message ?? err);
    }
  }

  // The Refresh button needs a callback that identifies the token. Attached here
  // rather than inside format-card so the renderer stays free of routing concerns.
  // 4A/D: "r:<chain>:<address>" - well inside Telegram's 64-byte callback limit.
  if (result?.status === 'ok' && chain && address) {
    result.refreshData = `r:${chain}:${address}`;
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
    research: researchLines,
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
    replyToMessageId: replyToMessageId !== undefined ? replyToMessageId : (ctx.message?.message_id ?? null),
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
    // Load FIRST. CallStore starts empty, so enumerating groups before any query
    // runs sees nothing and a perfectly valid link is reported as expired.
    callStore.load();
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
        // The ORIGINATING GROUP, resolved from the signed payload — not ctx.chat,
        // which here is the DM and holds no calls.
        chatId: hit.chatId,
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

bot.on('message', async (ctx, next) => {
  // WHY THIS HANDLER TAKES `next`:
  // Telegraf runs middlewares in registration order. This listener is registered
  // BEFORE bot.command('pnl'|'call'|'calls'|'fc'|...), and a handler that returns
  // without calling next() stops the chain — so those commands never ran and
  // appeared to do nothing. Every path this listener does not itself answer must
  // hand control on with `return next()`.
  //
  // Skip other bots (loop guard)
  if (ctx.from?.is_bot) return next();

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
  // Nothing to scan: let later handlers see a message we do not understand.
  if (!msgText) return next();

  // COMMANDS ARE NOT CONTRACTS.
  // Telegraf runs `on('message')` for command messages too, and this listener is
  // registered before several bot.command() handlers. Without this guard a command
  // that carries an address argument — `/pnl 0x…`, `/call <CA>`, `/justscan <CA>` —
  // is consumed here as a pasted contract and replaced with a scan or chain picker,
  // so the real command handler never runs. Verified: an owner `/pnl 0x…` returned
  // the chain picker and then a token card.
  if (/^\/\w/.test(msgText.trim())) return next();

  const det = detectAll(msgText, { defaultEvmChain: DEFAULT_EVM });
  if (!det.candidates.length) return next();

  // An EVM address is valid on 13 chains. Scanning the wrong one wastes a
  // request and shows the wrong token, so offer the chains instead of guessing.
  // The default is still one tap away and is first in the list.
  if (det.kind === 'evm' && det.ambiguous && det.hasOwnProperty('evmChains')) {
    // Carry the ORIGINAL author and message through the picker, so that:
    //   - the eventual call is attributed to whoever pasted the contract, not the
    //     person who tapped a chain, and
    //   - the result card replies to the CA message rather than to the prompt.
    //
    // The message reference is stashed UNCONDITIONALLY. An earlier version only
    // stashed it when auto-call was enabled, so in manual mode the final card had no
    // origin to reply to and fell back to answering the picker.
    const pending = {
      identity: null,
      messageId: ctx.message?.message_id ?? null,
      messageDate: ctx.message?.date ?? null,
      autoCall: false,
    };
    if (isGroupChat(ctx)) {
      try {
        const settings = callStore.groupSettings(ctx.chat.id, { title: ctx.chat.title ?? null });
        if (settings.autoCall === 'auto' && !justScanRequested.has(String(ctx.chat.id))) {
          const identity = resolveCaller(ctx.message, ctx.chat);
          if (isAttributable(identity)) {
            pending.identity = identity;
            pending.autoCall = true;
          }
        }
      } catch (_) { /* picker still works without call recording */ }
    }
    await sendChainPicker(ctx, det.candidates[0].address, pending);
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
      const settings = callStore.groupSettings(ctx.chat.id, { title: ctx.chat.title ?? null });
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
/**
 * Research is OPTIONAL and additive: it is fetched with a short budget and any
 * failure simply leaves the card's existing narrative line alone. It must never
 * slow or break a market scan.
 */
function researchDeps() {
  return {
    cache: researchCache,
    budget: xBudget,
    defaultEvmChain: DEFAULT_EVM,
    /**
     * /kol reads recorded public X call evidence.
     *
     * This was NEVER WIRED, so /kol could only ever answer "no calls recorded" no
     * matter what had actually been discovered - an inert command pretending to be
     * a working one. It now reads the store's xCalls map, which is separate from
     * group calls so a KOL's post can never appear as a group member's call.
     */
    recordedCallsForHandle: (handle) => callStore.recordedXCallsForHandle(handle),
    kolCoverage: 'Recorded from public X posts this bot has observed; not the account\'s full trading record.',
    // Entitlement + destination for the premium website CTA. PREMIUM_URL is empty
    // until the website confirms a route, so the preview degrades to an invitation
    // rather than a broken link.
    policy: accessPolicy,
    premiumUrl: PREMIUM_URL || null,
  };
}

/**
 * Phase 6 deps. `isGroup` is injected rather than imported so the handler module stays
 * free of Telegraf context shape assumptions.
 */
function boardDeps(ctx) {
  return {
    store: callStore,
    policy: accessPolicy,
    isGroup: (c) => isGroupChat(c),
    period: null,
  };
}

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

${escHtml(call.symbol ? '$' + call.symbol : (call.name ?? 'token'))} by ` +
    `<b>${escHtml(call.callerName ?? 'unknown')}</b> is no longer counted.
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
    // Inside a group, ctx.chat.id IS the group; make that explicit.
    chatId: ctx.chat.id,
    groupTitle: callStore.doc.groups?.[String(ctx.chat.id)]?.title ?? ctx.chat.title ?? 'this group',
    period: DEFAULT_PERIOD,
    policy: accessPolicy,
    isOwnerCheck: (id) => isOwner(accessPolicy, id),
  });
  if (out) {
    await ctx.reply(out.text, { parse_mode: 'HTML', reply_markup: { inline_keyboard: out.keyboard } });
  }
});

/** Period buttons + pagination on a caller profile. */
bot.action(/^c[pg]:cp_/, async ctx => {
  // Read the WHOLE callback payload. Matching only the token prefix meant the
  // period and page suffixes were never parsed, so every period button re-rendered
  // the original period and Next kept showing page one.
  const data = String(ctx.callbackQuery?.data ?? ctx.match?.[0] ?? '');
  const [, token, period, pageRaw] = data.split(':');
  const owner = isOwner(accessPolicy, ctx.from?.id);
  if (!owner) {
    await ctx.answerCbQuery('Owner-only during staging');
    return;
  }
  callStore.load();
  const groups = Object.keys(callStore.doc.groups ?? {});
  const resolved = resolveStartPayload(token, callStore, { chatIds: groups });
  if (!resolved) {
    await ctx.answerCbQuery('Link expired');
    return;
  }
  const out = await handleCallerProfile(ctx, {
    store: callStore,
    callerKey: resolved.callerKey,
    chatId: resolved.chatId,
    groupTitle: callStore.doc.groups?.[resolved.chatId]?.title ?? resolved.chatId,
    period: period ?? resolved.period,
    page: Number(pageRaw ?? 0) || 0,
    policy: accessPolicy,
    isOwnerCheck: (id) => isOwner(accessPolicy, id),
  });
  await ctx.answerCbQuery();
  if (out) {
    try {
      await ctx.editMessageText(out.text, {
        parse_mode: 'HTML',
        reply_markup: { inline_keyboard: out.keyboard },
      });
    } catch (err) {
      // Tapping the period that is already selected produces identical content and
      // Telegram rejects the edit with 400 "message is not modified". That is a
      // no-op, not an error: without this the bot.catch handler posted
      // "An unexpected error occurred" into the DM.
      const desc = String(err?.description ?? err?.message ?? '');
      if (!/message is not modified/i.test(desc)) throw err;
    }
  }
});

/**
 * /pnl chain disambiguation.
 *
 * When a contract is genuinely recorded on more than one chain, the picker from
 * handlePnl carries `pnl:<chain>:<address>`. This handler CONTINUES the PnL
 * action — it must never fall through to a token scan, which is what the generic
 * `c:<chain>:<address>` callback does.
 */
bot.action(/^pnl:(.+)$/, async ctx => {
  const data = ctx.match[1];
  if (data === 'cancel') {
    await ctx.answerCbQuery('Cancelled');
    await ctx.deleteMessage().catch(() => {});
    return;
  }
  const sep = data.indexOf(':');
  const chain = data.slice(0, sep);
  const address = data.slice(sep + 1);
  if (!chain || !address) {
    await ctx.answerCbQuery('Bad request');
    return;
  }

  if (!isGroupChat(ctx)) {
    await ctx.answerCbQuery('Run /pnl in the group');
    return;
  }

  const call = callStore.firstCall(ctx.chat.id, chain, address);
  if (!call) {
    // The record vanished (cancelled between taps). Answer honestly, scan nothing.
    await ctx.answerCbQuery();
    await ctx.deleteMessage().catch(() => {});
    await ctx.reply('No recorded call for this token in this group.');
    return;
  }

  await ctx.answerCbQuery('Rendering…');
  await ctx.deleteMessage().catch(() => {});

  const deps = callDeps();
  deps.sendPhoto = async (chatId, filePath, opts) => {
    try {
      return await ctx.telegram.sendPhoto(chatId, { source: filePath }, opts);
    } finally {
      cleanupPng(filePath);
    }
  };
  deps.groupTitle = callStore.doc.groups?.[String(ctx.chat.id)]?.title ?? ctx.chat.title ?? null;
  await sendPnlFor(ctx, { call, ...deps });
});

bot.command('narrative', ctx => handleNarrative(ctx, researchDeps()));
bot.command('x', ctx => handleX(ctx, researchDeps()));
bot.command('kol', ctx => handleKol(ctx, researchDeps()));
// Phase 5 risk commands. They share the research deps (cache + default chain) but hit
// the risk provider, not X — so they can never spend a billable X request.
bot.command('risk', ctx => handleRisk(ctx, { ...researchDeps(), fetchImpl: undefined }));
bot.command('dev', ctx => handleDev(ctx, { ...researchDeps(), fetchImpl: undefined }));
bot.command('bundle', ctx => handleBundle(ctx, { ...researchDeps(), fetchImpl: undefined }));

// ---- Phase 6: community, leaderboard, settings -----------------------------
bot.command('lb', ctx => handleLeaderboard(ctx, boardDeps(ctx)));
bot.command('leaderboard', ctx => handleLeaderboard(ctx, boardDeps(ctx)));
bot.command('gpnl', ctx => handleGroupPnl(ctx, boardDeps(ctx)));
bot.command('settings', ctx => handleSettings(ctx, boardDeps(ctx)));

bot.action(/^l[bp]:/, async ctx => {
  try {
    await handleBoardCallback(ctx, boardDeps(ctx));
  } catch (err) {
    console.error('[bot] leaderboard callback failed:', err?.message ?? err);
    await ctx.answerCbQuery('Something went wrong').catch(() => {});
  }
});

bot.action(/^st:/, async ctx => {
  try {
    await handleSettingsCallback(ctx, boardDeps(ctx));
  } catch (err) {
    console.error('[bot] settings callback failed:', err?.message ?? err);
    await ctx.answerCbQuery('Something went wrong').catch(() => {});
  }
});
bot.command('alerts', ctx => handleAlerts(ctx, callDeps()));
/**
 * /alerttest — owner-only delivery check. Registered AFTER the generic message
 * listener, which passes commands through via next(), so it is reachable.
 */
bot.command('alerttest', ctx => handleAlertTest(ctx, {
  policy: accessPolicy,
  testGroupId: process.env.TELEGRAM_TEST_GROUP_ID ?? null,
}));
bot.action(/^al:/, async ctx => {
  try {
    await handleAlertsCallback(ctx, callDeps());
  } catch (err) {
    console.error('[bot] alerts callback failed:', err?.message ?? err);
    await ctx.answerCbQuery('Something went wrong').catch(() => {});
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
async function sendChainPicker(ctx, address, pending = null) {
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
  if (pending) stashPendingScan({ ...pending, chatId: ctx.chat.id, address });

  // The picker itself is deliberately NOT a reply to the CA: it is an interactive
  // prompt, and replying to the user's message with it would visually bury the CA.
  // The ORIGINAL message id travels in the stash so the final card can answer it.

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
  // Resume the ORIGINAL message's intent, if one was stashed for this address.
  const pending = isGroupChat(ctx) ? takePendingScan(ctx.chat.id, address) : null;

  await ctx.answerCbQuery(`Scanning ${def.name}…`);
  // Remove the picker so the chat is not left with a dead keyboard.
  await ctx.deleteMessage().catch(() => {});

  if (pending?.autoCall && isAttributable(pending.identity)) {
    // Record against the ORIGINAL author and message — the tapper only chose a
    // chain, so crediting them would misattribute the call.
    try {
      const result = await scan({ chain, address: address.toLowerCase() });
      await recordCall({
        store: callStore,
        scanResult: result,
        caller: pending.identity,
        chatId: ctx.chat.id,
        source: 'auto',
        messageId: pending.messageId,
        messageDate: pending.messageDate,
      });
    } catch (err) {
      console.warn('[bot] auto-call after chain pick failed (scan continues):', err?.message ?? err);
    }
  }

  // The card answers the ORIGINAL contract message, which is the conversation the
  // user actually started. The picker was deleted above, so replying to it would
  // target a message that no longer exists.
  await runScan(ctx, chain, address.toLowerCase(), {
    replyToMessageId: pending?.messageId ?? null,
  });
});

// ---- Refresh: re-read market data and edit the card in place (4A/D) --------

/**
 * In-flight refresh guard, keyed by chat+token.
 *
 * A user can tap Refresh repeatedly. Without this, each tap would fire its own
 * provider fetch and its own edit; overlapping edits on one message produce a
 * "message is not modified" storm and multiply provider load.
 */
const refreshInFlight = new Set();

/** Per-chat+token cooldown so Refresh cannot become a polling loop. */
const REFRESH_COOLDOWN_MS = Math.max(0, Number(process.env.REFRESH_COOLDOWN_MS) || 8_000);
const lastRefreshAt = new Map();

function refreshKey(chatId, chain, address) {
  return `${chatId}:${chain}:${String(address).toLowerCase()}`;
}

/**
 * `r:<chain>:<address>` — re-scan and EDIT the existing card.
 *
 * Rules from the plan, and why each is here:
 *  - Edit in place, never send a new card: duplicate cards in a group are noise and
 *    make the First Caller attribution ambiguous.
 *  - Never insert a call or touch entry MC / caller: Refresh is a read, not an action.
 *    A refresh that recorded a call would let anyone "call" a token by tapping.
 *  - Keep the last valid values on failure, never zeros: a provider hiccup must not
 *    make a token look dead.
 *  - Zero paid X requests: research uses the cache-only path.
 */
bot.action(/^r:(.+)$/, async ctx => {
  const data = ctx.match[1];
  const sep = data.indexOf(':');
  const chain = data.slice(0, sep);
  const address = data.slice(sep + 1);

  if (!chain || !address) {
    await ctx.answerCbQuery('Bad request');
    return;
  }

  const chatId = ctx.chat?.id ?? ctx.callbackQuery?.message?.chat?.id;
  const messageId = ctx.callbackQuery?.message?.message_id ?? null;
  if (!chatId || !messageId) {
    await ctx.answerCbQuery('Cannot refresh here');
    return;
  }

  const key = refreshKey(chatId, chain, address);

  // One refresh at a time per token per chat.
  if (refreshInFlight.has(key)) {
    await ctx.answerCbQuery('Already refreshing');
    return;
  }

  const now = Date.now();
  const since = now - (lastRefreshAt.get(key) ?? 0);
  if (since < REFRESH_COOLDOWN_MS) {
    const wait = Math.ceil((REFRESH_COOLDOWN_MS - since) / 1000);
    await ctx.answerCbQuery(`Please wait ${wait}s`);
    return;
  }

  refreshInFlight.add(key);
  try {
    await ctx.answerCbQuery('Refreshing…');

    const result = await scan({ chain, address });

    // A failed provider fetch must not blank the card. Answer honestly and stop.
    if (!result || result.status !== 'ok') {
      await ctx.answerCbQuery('Could not refresh — keeping current values', { show_alert: false }).catch(() => {});
      return;
    }

    // Re-attach the group's own First Call so the refreshed card keeps attribution.
    let firstCall = null;
    let callerToken = null;
    if (isGroupChat(ctx)) {
      try {
        firstCall = callStore.firstCall(chatId, chain, address);
        if (firstCall?.callerKey) {
          callerToken = mintCallerToken(chatId, firstCall.callerKey, DEFAULT_PERIOD);
        }
      } catch { /* attribution is optional; the card still refreshes */ }
    }

    // Reuse cached narrative/research only. `xCacheOnly` guarantees no paid X call.
    let researchLines = null;
    try {
      const research = await researchToken({
        chain,
        address,
        symbol: result?.token?.symbol ?? null,
        cache: researchCache,
        budget: xBudget,
        includePosts: true,
        xCacheOnly: true,
      });
      if (research?.narrative?.available && !result.narrative?.summary) {
        result.narrative = {
          summary: cardNarrativeLines(research.narrative),
          source: research.narrative.summarySource,
          evidence: research.narrative.summaryClass,
        };
      }
      researchLines = { premiumTeaser: true, premiumUrl: PREMIUM_URL || null };
    } catch { /* narrative is optional enrichment */ }

    if (result?.status === 'ok' && chain && address) {
      result.refreshData = `r:${chain}:${address}`;
    }

    const { text, buttons } = formatCard(result, {
      mockLabel: SCAN_MODE === 'mock',
      websiteBase: WEBSITE_BASE,
      premiumUrl: PREMIUM_URL,
      botUsername: BOT_USERNAME,
      emojiTheme: activeEmojiTheme,
      view: CARD_VIEW,
      firstCall,
      callerToken,
      research: researchLines,
    });

    // Edit the existing card. A photo caption and a text card are edited through
    // different Telegram methods, and we try both rather than guessing the current
    // kind: the card may have fallen back to text when the image was unavailable.
    const keyboard = buttons?.length ? { inline_keyboard: buttons } : undefined;
    let edited = false;
    try {
      await ctx.telegram.editMessageCaption(chatId, messageId, undefined, text, {
        parse_mode: 'HTML',
        ...(keyboard ? { reply_markup: keyboard } : {}),
      });
      edited = true;
    } catch (err) {
      const desc = String(err?.description ?? err?.message ?? '');
      // Not a caption (text card), or nothing changed. Both are handled below.
      if (!/message is not modified/i.test(desc)) {
        try {
          await ctx.telegram.editMessageText(chatId, messageId, undefined, text, {
            parse_mode: 'HTML',
            link_preview_options: { is_disabled: true },
            ...(keyboard ? { reply_markup: keyboard } : {}),
          });
          edited = true;
        } catch (err2) {
          const d2 = String(err2?.description ?? err2?.message ?? '');
          if (/message is not modified/i.test(d2)) {
            edited = true; // values genuinely unchanged — the card is already correct
          } else {
            console.warn('[bot] refresh edit failed:', d2);
          }
        }
      } else {
        edited = true;
      }
    }

    if (!edited) {
      // Exactly one concise fallback, in the same chat. Never a duplicate card.
      await ctx.reply('Could not update this card. Tap Refresh again in a moment.').catch(() => {});
    }
  } catch (err) {
    console.warn('[bot] refresh failed:', err?.message ?? err);
    await ctx.answerCbQuery('Refresh failed').catch(() => {});
  } finally {
    lastRefreshAt.set(key, Date.now());
    refreshInFlight.delete(key);
  }
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

// ---- Command tracing -------------------------------------------------------
// One concise line per incoming command so the owner's terminal shows what the bot
// actually received. This is the cheapest way to tell "update never arrived" apart
// from "handler failed". Message text and secrets are never printed.
bot.use(async (ctx, next) => {
  const text = ctx.message?.text ?? ctx.callbackQuery?.data;
  if (!text) return next();
  const kind = ctx.callbackQuery ? 'CB' : 'CMD';
  const who = ctx.from?.id ?? '?';
  const where = ctx.chat?.type === 'private' ? 'DM' : `chat=${ctx.chat?.id}`;
  // Only surface commands and callbacks; ordinary group chatter stays silent.
  if (kind === 'CMD' && !/^\/\w/.test(String(text).trim())) return next();
  const shown = String(text).split(/\r?\n/)[0].slice(0, 72);
  console.log(`[cmd] ${kind} ${shown} (from=${who} ${where})`);
  return next();
});

// ---- Exports for tests ------------------------------------------------------
// The handler graph is exported so regression tests can drive the REAL routing
// (middleware order included) with a fake context instead of calling renderers in
// isolation, which is what let two routing bugs reach the owner.
export { bot };
export const internals = {
  pendingScans, takePendingScan, stashPendingScan, justScanRequested,
  detectAll, runScan, sendChainPicker,
  // The exact store instance the handlers use, so tests seed and assert against
  // the same object instead of a second instance that races the load cache.
  callStore, accessPolicy,
};

// ---- Launch ----------------------------------------------------------------

/**
 * Importing this module must not start polling.
 *
 * Without this guard, `node -e "await import('./src/bot.mjs')"` (or any test that
 * imports the handler graph) launches a second poller and Telegram terminates the
 * running instance with 409 Conflict. That is exactly what happened once during
 * development. Set BOT_NO_LAUNCH=1 to import the handlers without side effects.
 */
// `NODE_TEST_CONTEXT` is what `node --test` actually sets; NODE_ENV=test is only a
// convention. Missing it meant a test that imported the bot also started the
// background observer, which then held the process open until the runner timed out.
const SHOULD_LAUNCH = process.env.BOT_NO_LAUNCH !== '1'
  && process.env.NODE_ENV !== 'test'
  && !process.env.NODE_TEST_CONTEXT;

if (!SHOULD_LAUNCH) {
  console.log('[bot] BOT_NO_LAUNCH set — handlers registered, polling NOT started.');
}

console.log(`[bot] Starting Meme Checker bot (SCAN_MODE=${SCAN_MODE})…`);
if (SCAN_MODE !== 'live') {
  console.warn('[bot] ⚠ SCAN_MODE is not "live" — cards will show MOCK data. Set SCAN_MODE=live for real tokens.');
}
console.log(`[bot] Store: ${callStore.filePath}`);
// Startup order (all before polling begins):
//  1) getMe → set BOT_USERNAME so the Add-to-Group button is populated on the first card
//  2) setMyCommands → command menu live from the first update (not after polling stops)
//  3) launch() → Telegraf v4 launch() resolves on stop, so it stays last
// /upgrade is always registered; PREMIUM_URL only controls the card button, not the command.
if (SHOULD_LAUNCH) Promise.resolve(bot.telegram?.getMe?.())
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
        { command: 'alerts', description: 'Smart alert settings' },
        { command: 'narrative', description: 'Evidence-based token narrative' },
        { command: 'x', description: 'Public X posts about a token' },
        { command: 'kol', description: 'Recorded public calls by an X account' },
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

    // ---- Phase 3 background observer -------------------------------------
    // Started here so `npm start` is still the only command. It shares this
    // process, so one Ctrl+C stops polling and observation together.
    if (OBSERVER_ENABLED) {
      const send = async ({ chatId, text, replyToMessageId }) => {
        const opts = { parse_mode: 'HTML', disable_web_page_preview: true };
        try {
          // Replying to the original call message keeps the alert attached to the
          // call. If that message is gone Telegram rejects the reply, so fall back
          // to a plain message in the same group rather than losing the alert.
          if (replyToMessageId) return await bot.telegram.sendMessage(chatId, text, { ...opts, reply_to_message_id: replyToMessageId });
        } catch (err) {
          const desc = String(err?.description ?? err?.message ?? '');
          if (!/message to be replied not found|message_id_invalid|replied message not found/i.test(desc)) throw err;
          console.warn('[observer] original call message unavailable, sending unreplied alert');
        }
        return bot.telegram.sendMessage(chatId, text, opts);
      };

      observer = startObserver({
        store: callStore,
        scan,
        send,
        intervalMs: OBSERVER_INTERVAL_MS,
        maxCalls: OBSERVER_MAX_TOKENS,
        concurrency: OBSERVER_CONCURRENCY,
      });
    } else {
      console.log('[observer] disabled (OBSERVER=off)');
    }

    console.log('[bot] Polling for updates. (Ctrl+C to stop)');
    return bot.launch();
  })
  .catch(err => {
    console.error('[bot] Failed to start:', err?.message ?? err);
    process.exit(1);
  });

/**
 * Shutdown: stop observation first (so no new alerts are claimed), then polling.
 * A second Ctrl+C is left to the OS.
 */
function shutdown(signal) {
  try { observer?.stop(); } catch (err) { console.warn('[bot] observer stop failed:', err?.message ?? err); }
  bot.stop(signal);
}
process.once('SIGINT',  () => shutdown('SIGINT'));
process.once('SIGTERM', () => shutdown('SIGTERM'));
