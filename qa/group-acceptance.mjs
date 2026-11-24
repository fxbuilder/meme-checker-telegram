/**
 * qa/group-acceptance.mjs
 * Real group acceptance in the OWNER-only group.
 *
 * Sends a PnL card for a record explicitly marked `synthetic`, so nothing here
 * can be mistaken for real market performance. The caption says so in the first
 * line — a simulated 4x must never read as a real 4x.
 *
 * Usage: SCAN_MODE=live node --env-file=.env qa/group-acceptance.mjs
 */
import { CallStore, SYNTHETIC_FLAG } from '../src/store.mjs';
import { renderPnlText } from '../src/pnl-card.mjs';
import { renderPnlPng } from '../src/pnl-render.mjs';
import { fmtUsd } from '../src/card-layout.mjs';
import { callMetrics } from '../src/calls.mjs';

const TOKEN = (process.env.TELEGRAM_BOT_TOKEN ?? '').trim();
const CHAT = process.env.ACCEPTANCE_CHAT ?? '-5333984336';

async function api(method, payload) {
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
}

const store = new CallStore();
store.load();

// A record that is unambiguously simulated.
const now = Date.now();
const synthetic = await store.addCall({
  chatId: CHAT,
  callerId: 'synthetic-acceptance',
  callerName: 'SIMULATION',
  callerUsername: null,
  chain: 'solana',
  address: 'So11111111111111111111111111111111111111112',
  displayAddress: 'So11111111111111111111111111111111111111112',
  name: 'SIMULATED TOKEN',
  symbol: 'SIM',
  entryMarketCapUsd: 1_000_000,
  lastMarketCapUsd: 4_000_000,
  peakMarketCapUsd: 6_000_000,
  entryPriceUsd: 0.001,
  entryLiquidityUsd: 100_000,
  entryPairAddress: 'SYNTHETIC-PAIR',
  calledAt: now - 3 * 3600_000,
  peakAt: now - 900_000,
  lastObservedAt: now - 60_000,
  status: 'active',
  source: SYNTHETIC_FLAG,
});

const m = callMetrics(synthetic);
const body = renderPnlText(synthetic, {});

// The caption is explicitly labelled so it cannot be misread as real data.
const caption = [
  '🧪 <b>ACCEPTANCE TEST — SIMULATED DATA</b>',
  '<i>Not a real call and not real market performance.</i>',
  '',
  body,
].join('\n');

const png = await renderPnlPng(synthetic, { tokenName: synthetic.name });

const results = {};

// ---- 1. Photo delivery with the labelled caption -------------------------
// Multipart upload, because the PNG is a local file rather than a URL.
import fs from 'node:fs';
if (png) {
  const form = new FormData();
  form.append('chat_id', CHAT);
  form.append('photo', new Blob([fs.readFileSync(png)], { type: 'image/png' }), 'pnl.png');
  form.append('caption', caption);
  form.append('parse_mode', 'HTML');
  const res = await fetch(`https://api.telegram.org/bot${TOKEN}/sendPhoto`, { method: 'POST', body: form });
  const j = await res.json();
  results.photo = {
    ok: Boolean(j.ok),
    error: j.ok ? null : j.description,
    messageId: j.result?.message_id ?? null,
    hasPhoto: Boolean(j.result?.photo),
    captionEntities: (j.result?.caption_entities ?? []).map((e) => e.type),
    captionLength: (j.result?.caption ?? '').length,
  };
}

// ---- 2. Text card delivery ----------------------------------------------
try {
  const msg = await api('sendMessage', {
    chat_id: CHAT,
    text: ['🧪 <b>ACCEPTANCE TEST — SIMULATED DATA (text card)</b>', '', body].join('\n'),
    parse_mode: 'HTML',
    link_preview_options: { is_disabled: true },
  });
  results.text = { ok: true, messageId: msg.message_id, hasText: Boolean(msg.text) };
} catch (err) {
  results.text = { ok: false, error: err.description ?? err.message };
}

// ---- 3. Group isolation: a different chat must not see these ------------
const otherChatCalls = store.callsForChat('-1009999999999', { limit: 5 }).length;
results.isolation = { otherChatCallCount: otherChatCalls, expected: 0 };

console.log(JSON.stringify({
  syntheticId: synthetic.id,
  source: synthetic.source,
  metrics: { entry: fmtUsd(m.entryMarketCapUsd), current: fmtUsd(m.currentMarketCapUsd), multiple: m.currentMultiple },
  results,
}, null, 1));
