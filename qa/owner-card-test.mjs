/**
 * qa/owner-card-test.mjs
 * OWNER-ONLY DM visual acceptance for the three card modes.
 *
 * Cases:
 *   1. PEPE on Ethereum      — full security data, Dex Paid
 *   2. BONK on Solana        — no tax concept (n/a), real holders
 *   3. HyperEVM token        — chain with NO risk source (all n/a)
 *   4. Solana WETH replica   — inconsistent provider market data
 *
 * Sends each case in standard/short/detailed and reports the send echo so the
 * result is checkable rather than asserted.
 *
 * Usage: SCAN_MODE=live node --env-file=.env qa/owner-card-test.mjs [caseFilter]
 */
import { liveScan, clearLiveCache } from '../src/live-scan.mjs';
import { clearRiskCache } from '../src/risk-intel.mjs';
import { clearDexPaidCache } from '../src/dex-paid.mjs';
import { formatCard } from '../src/format-card.mjs';
import { buildEmojiTheme, FULL_THEME_MAP } from '../src/emoji-theme.mjs';

const TOKEN = (process.env.TELEGRAM_BOT_TOKEN ?? '').trim();
const OWNER = '1307106746';
const BOT = 'MemeCheckerStagingBot';
const filter = (process.argv[2] ?? '').toLowerCase();

const theme = buildEmojiTheme(FULL_THEME_MAP);

const CASES = [
  { key: 'pepe', label: 'Ethereum PEPE (full data)', chain: 'ethereum', address: '0x6982508145454ce325ddbe47a25d4ec3d2311933' },
  { key: 'bonk', label: 'Solana BONK (no tax concept)', chain: 'solana', address: 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263' },
  { key: 'norf', label: 'HyperEVM (no risk source)', chain: 'hyperevm', address: '0xb88339CB7199b77E23DB6E890353E22632Ba630f' },
  { key: 'weird', label: 'Solana WETH replica (bad market data)', chain: 'solana', address: '7vfCXTUXx5WJV5JADk17DUJ4ksgau7utNKj4b963voxs' },
];

async function send(payload) {
  const res = await fetch(`https://api.telegram.org/bot${TOKEN}/sendMessage`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const body = await res.json();
  const m = body.result;
  const text = m?.text ?? '';
  return {
    ok: Boolean(body.ok),
    err: body.ok ? null : body.description,
    id: m?.message_id ?? null,
    chars: text.length,
    lines: text ? text.split('\n').length : 0,
    entities: (m?.entities ?? []).map((e) => e.type),
    custom: (m?.entities ?? []).filter((e) => e.type === 'custom_emoji').length,
    buttons: m?.reply_markup?.inline_keyboard ?? null,
    text,
  };
}

// Node's default test discovery includes *-test.mjs under qa too. This is a
// manual LIVE sender, never an automated test: do not contact providers or post
// to the owner's DM from a test worker, even when credentials are inherited.
if (!process.env.NODE_TEST_CONTEXT) {
clearLiveCache(); clearRiskCache(); clearDexPaidCache();

const report = [];
for (const c of CASES) {
  if (filter && !c.key.includes(filter)) continue;

  const r = await liveScan({ chain: c.chain, address: c.address });

  for (const view of ['standard', 'short', 'detailed']) {
    const { text, buttons } = formatCard(r, {
      view, botUsername: BOT, emojiTheme: theme,
    });
    const sent = await send({
      chat_id: OWNER,
      text,
      parse_mode: 'HTML',
      disable_web_page_preview: true,
      ...(buttons.length ? { reply_markup: { inline_keyboard: buttons } } : {}),
    });
    const ca = r.token?.address ?? '';
    report.push({
      case: c.key,
      view,
      ok: sent.ok,
      err: sent.err,
      id: sent.id,
      chars: sent.chars,
      lines: sent.lines,
      custom: sent.custom,
      bold: sent.entities.filter((t) => t === 'bold').length,
      code: sent.entities.filter((t) => t === 'code').length,
      links: sent.entities.filter((t) => t === 'text_link').length,
      buttons: (sent.buttons ?? []).flat().map((b) => b.text),
      caIntact: ca ? (sent.text.split(ca).length - 1) === 1 : null,
      noMock: !/\[mock\]/i.test(sent.text),
      noRawHtml: !/<(b|i|code|a |tg-emoji)/.test(sent.text),
      sample: view === 'standard' ? sent.text : null,
    });
    await new Promise((s) => setTimeout(s, 900));
  }
}

for (const row of report) {
  const flags = [
    row.ok ? 'SENT' : `FAIL(${row.err})`,
    `${row.chars}c/${row.lines}L`,
    `emoji=${row.custom}`,
    `bold=${row.bold}`,
    `code=${row.code}`,
    `links=${row.links}`,
    row.buttons.length ? `btn=[${row.buttons.join('|')}]` : 'btn=[]',
    row.caIntact === null ? '' : `ca=${row.caIntact ? 'once' : 'BAD'}`,
    row.noMock ? '' : 'MOCK-LEAK',
    row.noRawHtml ? '' : 'RAW-HTML',
  ].filter(Boolean).join('  ');
  console.log(`${row.case.padEnd(6)} ${row.view.padEnd(9)} ${flags}`);
}

console.log('\n===== STANDARD CARD TEXTS (for visual review) =====');
for (const row of report.filter((x) => x.sample)) {
  console.log(`\n----- ${row.case} -----`);
  console.log(row.sample);
}
}
