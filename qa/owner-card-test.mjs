/**
 * qa/owner-card-test.mjs
 * OWNER-ONLY DM test. Sends real live cards via @MemeCheckerStagingBot and
 * reports what Telegram actually accepted (entities, buttons, integrity).
 *
 * Sends:
 *   1. compact card, Ethereum PEPE (rich data: tax/LP/dev/paid all real)
 *   2. detailed card, same token
 *   3. compact card, Solana (tax n/a — proves the honest unsupported state)
 *   4. compact card, Story (chain-unsupported message)
 *   5. chain picker keyboard (ambiguous EVM behaviour)
 */
const TOKEN = (process.env.TELEGRAM_BOT_TOKEN ?? '').trim();
const OWNER = '1307106746';
const CA_PEPE = '0x6982508145454ce325ddbe47a25d4ec3d2311933';
const CA_SOL = '7vfCXTUXx5WJV5JADk17DUJ4ksgau7utNKj4b963voxs';

const { liveScan } = await import('../src/live-scan.mjs');
const { formatCard } = await import('../src/format-card.mjs');
const { buildEmojiTheme, FULL_THEME_MAP } = await import('../src/emoji-theme.mjs');

const theme = buildEmojiTheme(FULL_THEME_MAP);
const BOT = 'MemeCheckerStagingBot';

async function send(payload) {
  const res = await fetch(`https://api.telegram.org/bot${TOKEN}/sendMessage`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const body = await res.json();
  const m = body.result;
  return {
    ok: Boolean(body.ok),
    err: body.ok ? null : body.description,
    id: m?.message_id ?? null,
    entities: (m?.entities ?? []).map((e) => e.type),
    custom: (m?.entities ?? []).filter((e) => e.type === 'custom_emoji').length,
    buttons: m?.reply_markup?.inline_keyboard ?? null,
    chars: (m?.text ?? '').length,
    text: m?.text ?? null,
  };
}

const out = [];

// 1 + 2: compact vs detailed on a data-rich EVM token
const pepe = await liveScan({ chain: 'ethereum', address: CA_PEPE });
for (const view of ['compact', 'detailed']) {
  const { text, buttons } = formatCard(pepe, {
    view, botUsername: BOT, emojiTheme: theme,
  });
  const r = await send({
    chat_id: OWNER, text, parse_mode: 'HTML', disable_web_page_preview: true,
    ...(buttons.length ? { reply_markup: { inline_keyboard: buttons } } : {}),
  });
  out.push({ test: `ethereum PEPE ${view}`, ...r, fullCa: (r.text ?? '').includes(CA_PEPE) });
  await new Promise((s) => setTimeout(s, 900));
}

// 3: Solana — tax must read n/a
const sol = await liveScan({ chain: 'solana', address: CA_SOL });
{
  const { text, buttons } = formatCard(sol, { view: 'compact', botUsername: BOT, emojiTheme: theme });
  const r = await send({
    chat_id: OWNER, text, parse_mode: 'HTML', disable_web_page_preview: true,
    ...(buttons.length ? { reply_markup: { inline_keyboard: buttons } } : {}),
  });
  out.push({
    test: 'solana compact', ...r, fullCa: (r.text ?? '').includes(CA_SOL),
    taxIsNa: /Tax: n\/a/.test(r.text ?? ''),
    noFakeTaxZero: !/Tax: 0/.test(r.text ?? ''),
  });
  await new Promise((s) => setTimeout(s, 900));
}

// 4: Story — capability gap must not read as token-not-found
{
  const story = await liveScan({ chain: 'story', address: CA_PEPE });
  const { text } = formatCard(story, { view: 'compact', botUsername: BOT, emojiTheme: theme });
  const r = await send({ chat_id: OWNER, text, parse_mode: 'HTML' });
  out.push({
    test: 'story unsupported', ...r,
    saysNotSupported: /Not Supported/i.test(r.text ?? ''),
    notTokenNotFound: !/Token Not Found/i.test(r.text ?? ''),
  });
  await new Promise((s) => setTimeout(s, 900));
}

// 5: chain picker
{
  const rows = [];
  const evm = ['ethereum', 'bsc', 'base', 'arbitrum', 'optimism', 'polygon',
    'avalanche', 'hyperevm', 'monad', 'robinhood', 'unichain', 'berachain', 'abstract', 'megaeth'];
  for (let i = 0; i < evm.length; i += 2) {
    rows.push(evm.slice(i, i + 2).map((c) => ({ text: c, callback_data: `c:${c}:${CA_PEPE}` })));
  }
  rows.push([{ text: '✖️ Cancel', callback_data: 'c:cancel' }]);
  // Guard Telegram's 64-byte callback_data limit.
  const tooLong = rows.flat().filter((b) => Buffer.byteLength(b.callback_data) > 64);
  const r = await send({
    chat_id: OWNER,
    text: `<b>Which chain is this address on?</b>\n\n<code>${CA_PEPE}</code>\n\n` +
          `A 0x address can exist on several networks, so I will not guess.\n` +
          `★ marks the default.`,
    parse_mode: 'HTML',
    reply_markup: { inline_keyboard: rows },
  });
  out.push({
    test: 'chain picker', ...r,
    buttonsSent: rows.length,
    callbackDataTooLong: tooLong.length,
    maxCallbackBytes: Math.max(...rows.flat().map((b) => Buffer.byteLength(b.callback_data))),
  });
}

console.log(JSON.stringify(out, null, 1));
