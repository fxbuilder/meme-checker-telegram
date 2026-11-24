/**
 * qa/final-acceptance.mjs
 * FINAL UI ACCEPTANCE — OWNER-only, real Telegram.
 *
 * Exercises the six required cases through the REAL delivery path
 * (resolveTokenImage → deliverCard → sendPhoto/sendMessage), not by calling
 * formatCard directly, so a photo/caption regression cannot hide.
 *
 * A. PEPE / Ethereum      — expects a photo (banner) + single button
 * B. BONK / Solana        — expects a photo (banner) + no fabricated tax
 * C. banner-available tok — reports the verified banner source
 * D. token without image  — expects the clean text fallback, no duplicate
 * E. missing risk data    — expects no false safety indicators
 * F. hostile long name    — expects caption safety + escaping, no parse error
 *
 * Usage: SCAN_MODE=live node --env-file=.env qa/final-acceptance.mjs
 */
import { liveScan, clearLiveCache } from '../src/live-scan.mjs';
import { clearRiskCache } from '../src/risk-intel.mjs';
import { clearDexPaidCache } from '../src/dex-paid.mjs';
import { formatCard } from '../src/format-card.mjs';
import { deliverCard, visibleLength, CAPTION_LIMIT } from '../src/delivery.mjs';
import { resolveTokenImage } from '../src/media.mjs';
import { buildEmojiTheme, FULL_THEME_MAP } from '../src/emoji-theme.mjs';

const TOKEN = (process.env.TELEGRAM_BOT_TOKEN ?? '').trim();
const OWNER = '1307106746';
const BOT = 'MemeCheckerStagingBot';
const theme = buildEmojiTheme(FULL_THEME_MAP);

/** Minimal Bot API client, mirroring src/bot.mjs wiring. */
function makeTelegram() {
  const post = async (method, payload) => {
    const res = await fetch(`https://api.telegram.org/bot${TOKEN}/${method}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const body = await res.json();
    if (!body.ok) {
      const e = new Error(body.description ?? `http ${res.status}`);
      e.description = body.description;
      throw e;
    }
    return body.result;
  };
  return {
    sendPhoto: (chat, url, opts) => post('sendPhoto', { chat_id: chat, photo: url, ...opts }),
    sendMessage: (chat, text, opts) => post('sendMessage', { chat_id: chat, text, ...opts }),
  };
}

const CASES = [
  { key: 'A', label: 'PEPE / Ethereum', chain: 'ethereum', address: '0x6982508145454ce325ddbe47a25d4ec3d2311933', expect: 'photo' },
  { key: 'B', label: 'BONK / Solana', chain: 'solana', address: 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263', expect: 'photo' },
  { key: 'C', label: 'Monad (banner source)', chain: 'monad', address: '0x3bd359C1119dA7Da1D913D1C4D2B7c461115433A', expect: 'any' },
  { key: 'D', label: 'HyperEVM (no image)', chain: 'hyperevm', address: '0xb88339CB7199b77E23DB6E890353E22632Ba630f', expect: 'text' },
  { key: 'E', label: 'No risk source chain', chain: 'unichain', address: '0xe64dF0C18c010BDfba5093a3Fed7Bb6ceabec22C', expect: 'any' },
  // F: hostile rendering. A real token whose display name we override with
  // difficult HTML/Unicode to exercise escaping and caption length.
  { key: 'F', label: 'Hostile name / escaping', chain: 'ethereum', address: '0x6982508145454ce325ddbe47a25d4ec3d2311933', expect: 'any', hostile: true },
];

clearLiveCache(); clearRiskCache(); clearDexPaidCache();

const rows = [];
for (const c of CASES) {
  let r = await liveScan({ chain: c.chain, address: c.address });

  if (c.hostile && r.status === 'ok') {
    // SIMULATION ONLY. This name is invented here, at runtime, on a shallow copy
    // of the scan result. It is never written to the scan cache, never persisted,
    // and cannot reach a real user card — a regression test asserts both.
    r = {
      ...r,
      token: {
        ...r.token,
        name: 'PEPE & <b>Rug</b> "Test" <script>alert(1)</script> テ⁣スト 🐸 超長い名前のトークンですよろしくお願いします',
        symbol: 'A&B<1%',
      },
    };
  }

  const image = r.status === 'ok' ? await resolveTokenImage(r) : null;
  const { text, buttons } = formatCard(r, {
    view: 'standard', botUsername: BOT, emojiTheme: theme,
    mockLabel: false,
  });

  const sent = await deliverCard({
    telegram: makeTelegram(),
    chatId: OWNER,
    text,
    buttons,
    imageUrl: image?.url ?? null,
  });

  const body = sent.text ?? '';
  rows.push({
    key: c.key,
    label: c.label,
    scan: r.status,
    imageKind: image?.kind ?? 'none',
    imageBytes: image?.bytes ?? null,
    delivery: sent.kind,
    ok: sent.ok,
    msgId: sent.messageId,
    fellBack: sent.fellBack,
    fallbackReason: sent.fallbackReason,
    detail: sent.detail,
    visible: visibleLength(text),
    rawChars: text.length,
    entities: sent.entities,
    custom: sent.customEmoji,
    buttonCount: sent.buttons,
    caIntact: r.token?.address ? (body.split(r.token.address).length - 1) === 1 : null,
    noNote: !/Signals only/.test(body),
    noChart: !/Chart/.test(body),
    noMock: !/\[mock\]/i.test(body),
    // Escaping proof, checked on the SOURCE we sent. Telegram's echo returns the
    // rendered text with entities resolved, so the returned caption legitimately
    // contains the literal characters — that is proof the escape worked, not a
    // leak. Assert on `text` (pre-send), not `body` (post-render).
    noRawHtml: !/<script/i.test(text) && (c.hostile
      ? text.includes('&lt;script&gt;') && !/Rug<\/b>/.test(text)
      : true),
    taxFabricated: /Tax.*: 0\.0%/.test(body) && r.risk?.tax == null,
    expectMet: c.expect === 'any' ? true : sent.kind === c.expect,
  });

  await new Promise((s) => setTimeout(s, 1200));
}

console.log('key  case                       scan img(kind/B)      delivery ok  id    vis/raw  ent cm  btn ca  note chart mock raw  expect');
for (const x of rows) {
  console.log(
    `${x.key}    ${x.label.padEnd(26)} ${x.scan.padEnd(4)} ${(x.imageKind + (x.imageBytes ? '/' + x.imageBytes : '')).padEnd(16)} ` +
    `${x.delivery.padEnd(8)} ${String(x.ok).padEnd(5)} ${String(x.msgId).padEnd(5)} ` +
    `${(x.visible + '/' + x.rawChars).padEnd(9)} ${String(x.entities.length).padEnd(3)} ${String(x.custom).padEnd(3)} ${String(x.buttonCount).padEnd(4)} ` +
    `${(x.caIntact ? 'once' : 'BAD').padEnd(5)} ${x.noNote ? 'ok' : 'NO'}  ${x.noChart ? 'ok' : 'CHART'} ${x.noMock ? 'ok' : 'MOCK'} ${x.noRawHtml ? 'ok' : 'RAW'}  ${x.expectMet ? 'PASS' : 'FAIL'}`,
  );
}

console.log('\n=== DETAILED FLAGS ===');
for (const x of rows) {
  const flags = [];
  if (x.fellBack) flags.push(`fallback=${x.fallbackReason}`);
  if (x.detail) flags.push(`detail=${x.detail}`);
  if (x.taxFabricated) flags.push('FABRICATED-TAX');
  if (x.visible > CAPTION_LIMIT) flags.push('OVER-CAPTION');
  if (flags.length) console.log(`${x.key}: ${flags.join(' | ')}`);
}
const sent = rows.filter((x) => x.ok).length;
const photos = rows.filter((x) => x.ok && x.delivery === 'photo').length;
const texts = rows.filter((x) => x.ok && x.delivery === 'text').length;
console.log(`\nsent=${sent}/${rows.length}  photo=${photos}  text=${texts}  expectationsMet=${rows.filter((x) => x.expectMet).length}/${rows.length}`);
