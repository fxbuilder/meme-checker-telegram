/**
 * Owner-only DM send + render verification for one live BONK card.
 * Prints the real Telegram API response: entity types, markup, and integrity checks.
 */
import fs from 'node:fs';
import { scan } from '../src/scanner.mjs';
import { formatCard } from '../src/format-card.mjs';
import { buildEmojiTheme, FULL_THEME_MAP } from '../src/emoji-theme.mjs';

const TOKEN = (process.env.TELEGRAM_BOT_TOKEN ?? '').trim();
const OWNER_CHAT = '1307106746';
const CA = 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263';
const BOT_USERNAME = 'MemeCheckerStagingBot';

if (!TOKEN) { console.error('no token'); process.exit(1); }

const api = async (method, payload) => {
  const res = await fetch(`https://api.telegram.org/bot${TOKEN}/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const body = await res.json();
  return { httpStatus: res.status, body };
};

// ---- 1. Real live scan ------------------------------------------------------
const result = await scan({ chain: 'solana', address: CA });
if (result.status !== 'ok') {
  console.error('SCAN FAILED:', result.status);
  process.exit(1);
}

// ---- 2. Render with the full 18-slot custom emoji theme ---------------------
const theme = buildEmojiTheme(FULL_THEME_MAP);
const { text, buttons } = formatCard(result, {
  mockLabel: false,
  websiteBase: '',
  premiumUrl: '',
  botUsername: BOT_USERNAME,
  emojiTheme: theme,
});

fs.writeFileSync('E:/Hermes/data/cache/scratch/bonk_card.html', text, 'utf8');

const payload = {
  chat_id: OWNER_CHAT,
  text,
  parse_mode: 'HTML',
  disable_web_page_preview: true,
};
if (buttons.length) payload.reply_markup = { inline_keyboard: buttons };

// ---- 3. Send, with a themed-then-plain fallback ----------------------------
let attempt = await api('sendMessage', payload);
let themeApplied = true;
let fallbackNote = null;

if (!attempt.body?.ok) {
  // Custom emoji can be rejected when the bot lacks a Fragment-purchased
  // username. Fall back to standard emoji so the owner still gets the card.
  fallbackNote = attempt.body?.description ?? `http ${attempt.httpStatus}`;
  themeApplied = false;
  const plain = formatCard(result, {
    mockLabel: false, websiteBase: '', premiumUrl: '', botUsername: BOT_USERNAME,
  });
  payload.text = plain.text;
  if (plain.buttons.length) payload.reply_markup = { inline_keyboard: plain.buttons };
  else delete payload.reply_markup;
  attempt = await api('sendMessage', payload);
}

const msg = attempt.body?.result;
const report = {
  delivered: Boolean(attempt.body?.ok),
  httpStatus: attempt.httpStatus,
  themeApplied,
  fallbackNote,
  message_id: msg?.message_id ?? null,
  chat: msg ? { id: msg.chat?.id, type: msg.chat?.type, username: msg.chat?.username ?? null } : null,
  entityTypes: (msg?.entities ?? []).map((e) => e.type),
  customEmojiCount: (msg?.entities ?? []).filter((e) => e.type === 'custom_emoji').length,
  buttonsEcho: msg?.reply_markup?.inline_keyboard ?? null,
  textLength: (msg?.text ?? '').length,
  cardText: msg?.text ?? null,
};

// ---- 4. Integrity checks ---------------------------------------------------
const body = report.cardText ?? '';
report.checks = {
  fullCaPresentExactlyOnce: (body.split(CA).length - 1) === 1,
  caIsCopyableCodeEntity: (msg?.entities ?? []).some((e) => e.type === 'code_block' || e.type === 'pre') ||
    // Telegram reports <code> inline as 'code'
    (msg?.entities ?? []).some((e) => e.type === 'code'),
  noMockLabel: !/\[mock\]/i.test(body),
  hasRealMarketCap: /Market Cap: \$/.test(body),
  hasRealLiquidity: /Liquidity: \$/.test(body),
  hasPrice: /Price: \$/.test(body),
  hasPairAge: /Pair Age:/.test(body),
  holdersUnavailableHonest: /Holder data unavailable/.test(body),
  narrativeUnavailableHonest: /Narrative unavailable/.test(body),
  linksRendered: (msg?.entities ?? []).filter((e) => e.type === 'text_link').length,
  boldSections: (msg?.entities ?? []).filter((e) => e.type === 'bold').length,
  noRawHtmlLeaked: !/<(b|i|code|a |tg-emoji)/.test(body),
  noPlaceholderUrls: !/\.example/.test(body),
};

console.log(JSON.stringify({
  scan: {
    status: result.status,
    name: result.token?.name,
    symbol: result.token?.symbol,
    marketCapUsd: result.market?.marketCapUsd,
    liquidityUsd: result.market?.liquidityUsd,
    priceUsd: result.market?.priceUsd,
    volume24hUsd: result.market?.volume24hUsd,
    priceChange24h: result.market?.priceChange24h,
    pairAge: result.market?.pairAge,
    project: result.project,
    holders: result.holders,
    narrative: result.narrative,
    source: result.source,
  },
  telegram: report,
}, null, 2));
