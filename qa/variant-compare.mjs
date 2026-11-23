/**
 * qa/variant-compare.mjs
 * Renders TWO readable STANDARD variants for owner comparison, so the final
 * default is chosen from something seen on a phone rather than described.
 *
 * A — current: absolute label/value rows under their own section headers.
 * B — grouped pairs: short two-across metric pairs (Price/MC, Liq/Vol,
 *     1H/24H, Age) under one "Overview" heading, security as compact pairs.
 *     Same information, ~30% fewer lines, wider rows.
 */
import { liveScan, clearLiveCache } from '../src/live-scan.mjs';
import { clearRiskCache } from '../src/risk-intel.mjs';
import { clearDexPaidCache } from '../src/dex-paid.mjs';
import { formatCard } from '../src/format-card.mjs';
import { buildEmojiTheme, FULL_THEME_MAP } from '../src/emoji-theme.mjs';
import {
  esc, fmtUsd, fmtPct, fmtInt, fmtPp, marketLooksImplausible,
  resolveQuickCheck, QUICK_CHECK_KEYS,
} from '../src/card-layout.mjs';
import { getChain } from '../src/chains.mjs';

const TOKEN = (process.env.TELEGRAM_BOT_TOKEN ?? '').trim();
const OWNER = '1307106746';
const theme = buildEmojiTheme(FULL_THEME_MAP);

/** Variant B: paired, grouped layout. */
export function renderVariantB(result, e = (x) => x) {
  const t = result.token ?? {};
  const m = result.market ?? {};
  const p = result.project ?? {};
  const chainName = getChain(t.chain)?.name ?? t.chain ?? 'Unknown';
  const chainEmoji = getChain(t.chain)?.emoji ?? '⛓️';

  const lines = [];
  lines.push(`${e('🚀')} <b>MEME CHECKER</b>`);
  lines.push(`${e('🪙')} <b>${esc(t.name ?? 'Unknown')}</b> <code>$${esc(t.symbol ?? '?')}</code>`);
  lines.push(`${chainEmoji} ${esc(chainName)}`);
  lines.push(`<code>${esc(t.address ?? '')}</code>`);

  // ---- Overview: paired two-across -------------------------------------
  lines.push('');
  lines.push(`${e('📊')} <b>OVERVIEW</b>`);
  lines.push('');
  const price = fmtUsd(m.priceUsd, 8);
  const mc = fmtUsd(m.marketCapUsd);
  const liq = fmtUsd(m.liquidityUsd);
  const vol = m.volume24hUsd === 0 ? '$0' : fmtUsd(m.volume24hUsd, 2);
  const h1 = fmtPct(m.priceChange1h);
  const h24 = fmtPct(m.priceChange24h);
  const fdv = fmtUsd(m.fdvUsd);

  const pairRows = [];
  if (price) pairRows.push(`Price ${esc(price)}`);
  if (mc) pairRows.push(`MC ${esc(mc)}`);
  if (liq) pairRows.push(`Liq ${esc(liq)}`);
  if (vol) pairRows.push(`Vol 24H ${esc(vol)}`);
  if (h1) pairRows.push(`1H ${esc(h1)}`);
  if (h24) pairRows.push(`24H ${esc(h24)}`);
  // Two per line, tab-like spacing.
  for (let i = 0; i < pairRows.length; i += 2) {
    const a = pairRows[i];
    const b = pairRows[i + 1] ?? '';
    lines.push(b ? `${a}   ${b}` : a);
  }
  const age = m.pairAge ? `Pair age ${m.pairAge}` : null;
  const fdvRow = fdv && fdv !== mc ? `FDV ${esc(fdv)}` : null;
  const tail = [fdvRow, age ? esc(age) : null].filter(Boolean);
  if (tail.length) lines.push(tail.join('   '));

  if (marketLooksImplausible(m)) {
    lines.push('');
    lines.push('<i>⚠️ Some figures look inconsistent for this pair — verify before acting.</i>');
  }

  // ---- Security as compact pairs ---------------------------------------
  lines.push('');
  lines.push(`${e('🛡️')} <b>SECURITY</b>`);
  lines.push('');
  const items = QUICK_CHECK_KEYS.map((k) => resolveQuickCheck(k, result));
  const secRows = items.map((it) => `${it.label} ${esc(it.value)}`);
  for (let i = 0; i < secRows.length; i += 2) {
    const a = secRows[i];
    const b = secRows[i + 1] ?? '';
    lines.push(b ? `${a}   ${b}` : a);
  }

  // ---- Narrative -------------------------------------------------------
  lines.push('');
  lines.push(`${e('🧠')} <b>NARRATIVE</b>`);
  lines.push('');
  if (result.narrative?.summary && result.narrative?.source) {
    lines.push(esc(result.narrative.summary));
  } else {
    lines.push('<i>No verified narrative available.</i>');
  }

  // ---- Links -----------------------------------------------------------
  const links = [];
  if (p.website) links.push(`<a href="${esc(p.website)}">${e('🌍')} Website</a>`);
  if (p.x) links.push(`<a href="${esc(p.x)}">${e('✖️')} X</a>`);
  if (p.telegram) links.push(`<a href="${esc(p.telegram)}">${e('✈️')} Telegram</a>`);
  lines.push('');
  lines.push(`${e('🌐')} <b>LINKS</b>`);
  lines.push('');
  lines.push(links.length ? links.join('\n') : '<i>No verified project links available.</i>');

  lines.push('');
  lines.push(`${e('⚡')} <i>Powered by MEME CHECKER</i>`);
  return lines.join('\n');
}

async function send(payload) {
  const res = await fetch(`https://api.telegram.org/bot${TOKEN}/sendMessage`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const body = await res.json();
  return { ok: Boolean(body.ok), err: body.ok ? null : body.description, m: body.result };
}

const CASES = [
  ['Ethereum PEPE', 'ethereum', '0x6982508145454ce325ddbe47a25d4ec3d2311933'],
  ['Solana BONK', 'solana', 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263'],
];

clearLiveCache(); clearRiskCache(); clearDexPaidCache();

for (const [label, chain, address] of CASES) {
  const r = await liveScan({ chain, address });

  const a = formatCard(r, { view: 'standard', botUsername: 'MemeCheckerStagingBot', emojiTheme: theme });
  const bText = renderVariantB(r, theme);

  for (const [tag, text, buttons] of [
    ['VARIANT A (current standard)', a.text, a.buttons],
    ['VARIANT B (grouped pairs)', bText, a.buttons],
  ]) {
    const head = await send({
      chat_id: OWNER,
      text: `<b>${label} — ${tag}</b>\n<i>${text.length} chars · ${text.split('\n').length} lines</i>`,
      parse_mode: 'HTML',
    });
    const sent = await send({
      chat_id: OWNER,
      text,
      parse_mode: 'HTML',
      disable_web_page_preview: true,
      ...(buttons.length ? { reply_markup: { inline_keyboard: buttons } } : {}),
    });
    console.log(`${label.padEnd(16)} ${tag.padEnd(30)} ok=${sent.ok} ${text.length}c/${text.split('\n').length}L${sent.err ? ` ERR=${sent.err}` : ''}`);
    await new Promise((s) => setTimeout(s, 800));
  }
}
