/**
 * src/bot.mjs
 * Meme Checker Telegram Bot — group and DM handlers.
 *
 * Env vars (see .env.example):
 *   TELEGRAM_BOT_TOKEN    — required for live Telegram
 *   SCAN_MODE             — 'mock' (default) or 'live'
 *   TOKEN_PAGE_BASE_URL   — e.g. https://meme-checker.example  (placeholder until confirmed)
 */

import { Telegraf, Markup } from 'telegraf';
import { detectCandidates } from './detect-ca.mjs';
import { checkCooldown } from './cooldown.mjs';
import { scan } from './scanner.mjs';
import { formatCard } from './format-card.mjs';
import { loadEnvTheme, previewTheme } from './emoji-theme.mjs';

const BOT_TOKEN    = process.env.TELEGRAM_BOT_TOKEN ?? '';
const WEBSITE_BASE = (process.env.TOKEN_PAGE_BASE_URL ?? '').replace(/\/$/, '');
const PREMIUM_URL  = (process.env.PREMIUM_URL ?? '').trim();
const SCAN_MODE    = process.env.SCAN_MODE ?? 'mock';
const EMOJI_THEME  = loadEnvTheme();

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

async function runScan(ctx, chain, address) {
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
    loadingMsg = await ctx.reply(`🔍 Scanning ${chain === 'solana' ? 'Solana' : 'BNB Chain'} token…`);
  } catch (_) { /* non-fatal */ }

  const result = await scan({ chain, address });
  const { text, buttons } = formatCard(result, {
    mockLabel:   SCAN_MODE === 'mock',
    websiteBase: WEBSITE_BASE,
    premiumUrl:  PREMIUM_URL,
    botUsername: BOT_USERNAME,
    emojiTheme:  EMOJI_THEME,
  });

  const keyboard = buildKeyboard(buttons);

  try {
    if (loadingMsg) {
      await ctx.telegram.editMessageText(
        chatId, loadingMsg.message_id, undefined,
        text,
        { parse_mode: 'HTML', disable_web_page_preview: true, ...keyboard }
      );
    } else {
      await ctx.reply(text, { parse_mode: 'HTML', disable_web_page_preview: true, ...keyboard });
    }
  } catch (err) {
    // editMessageText can fail if the message was deleted; fall back to new reply
    console.error('[bot] edit failed, sending fresh reply:', err?.message);
    await ctx.reply(text, { parse_mode: 'HTML', disable_web_page_preview: true, ...keyboard });
  }
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
    '• <code>/check &lt;address&gt;</code> — Manually check a token',
    '• <code>/about</code> — About Meme Checker',
    '• <code>/website</code> — Open the website',
    '',
    '<b>Auto-detect:</b>',
    'Paste a Solana or BNB Chain contract address anywhere in this chat and Meme Checker will scan it automatically.',
    '',
    '<b>Supported chains:</b> Solana, BNB Chain (BSC)',
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
  const url = PREMIUM_URL || (WEBSITE_BASE ? `${WEBSITE_BASE}/pricing?utm_source=telegram&utm_medium=dm&utm_campaign=upgrade` : null);
  if (url) {
    await ctx.reply(
      '⚡ Unlock full intelligence on Meme Checker.',
      Markup.inlineKeyboard([[Markup.button.url('⚡ Unlock Premium', url)]])
    );
  } else {
    await ctx.reply('⚡ Premium info coming soon. Visit the website for details.');
  }
});

bot.command('check', async ctx => {
  // Guard: ignore other bots
  if (ctx.from?.is_bot) return;

  const args = ctx.message?.text?.split(/\s+/).slice(1) ?? [];
  if (!args.length) {
    await ctx.reply('Usage: <code>/check &lt;contract_address&gt;</code>', { parse_mode: 'HTML' });
    return;
  }

  const raw = args[0].trim();
  const candidates = detectCandidates(raw);

  if (!candidates.length) {
    await ctx.reply(
      '❌ <b>Invalid Contract Address</b>\n\nSupported formats:\n• Solana: base58, 32–44 chars\n• BNB Chain: 0x + 40 hex chars',
      { parse_mode: 'HTML' }
    );
    return;
  }

  // /check processes the first valid candidate only
  const { chain, address } = candidates[0];
  await runScan(ctx, chain, address);
});

// ---- Auto-detect in messages -----------------------------------------------

bot.on('message', async ctx => {
  // Skip other bots (loop guard)
  if (ctx.from?.is_bot) return;

  const text = ctx.message?.text ?? ctx.message?.caption ?? '';
  if (!text) return;

  const candidates = detectCandidates(text);
  if (!candidates.length) return;

  // Process first detected candidate only (brief: one reply per message)
  const { chain, address } = candidates[0];
  await runScan(ctx, chain, address);
});

// ---- Error handler ---------------------------------------------------------

bot.catch((err, ctx) => {
  console.error('[bot] unhandled error:', err?.message ?? err);
  ctx?.reply?.('⚠️ An unexpected error occurred. Please try again.').catch(() => {});
});

// ---- Launch ----------------------------------------------------------------

console.log(`[bot] Starting Meme Checker bot (SCAN_MODE=${SCAN_MODE})…`);
bot.launch().then(async () => {
  try {
    const me = await bot.telegram.getMe();
    BOT_USERNAME = me.username ?? '';
    console.log(`[bot] Connected as @${BOT_USERNAME}. Polling for updates. (Ctrl+C to stop)`);
  } catch {
    console.log('[bot] Bot is running (could not resolve username).');
  }
}).catch(err => {
  console.error('[bot] Failed to start:', err?.message ?? err);
  process.exit(1);
});

process.once('SIGINT',  () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
