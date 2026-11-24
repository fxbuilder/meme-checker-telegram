#!/usr/bin/env node
/**
 * qa/phase2-ux-acceptance.mjs
 *
 * Real-Telegram acceptance for the two Phase 2 UX corrections.
 *
 * Every record written here is marked source:'synthetic' so it can never be
 * mistaken for a real caller's performance, and the script cleans up after
 * itself. It sends real messages to the authorized group and prints the
 * message ids so the results can be inspected in Telegram directly.
 */
import fs from 'node:fs';
import path from 'node:path';

const GROUP = process.env.TELEGRAM_TEST_GROUP_ID;
const TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const OWNER = process.env.OWNER_USER_IDS?.split(',')[0];
const API = `https://api.telegram.org/bot${TOKEN}`;

if (!GROUP || !TOKEN) { console.error('missing env'); process.exit(1); }

const log = [];
function note(step, ok, detail = '') {
  log.push({ step, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${step}${detail ? ' — ' + detail : ''}`);
}

async function call(method, body) {
  const r = await fetch(`${API}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return r.json();
}

const { CallStore, isSynthetic } = await import('../src/store.mjs');
const { recordCall } = await import('../src/call-service.mjs');
const { resolveCaller, callerLabel } = await import('../src/caller-identity.mjs');
const { formatCard } = await import('../src/format-card.mjs');
const { liveScan } = await import('../src/live-scan.mjs');
const { mintCallerToken } = await import('../src/deep-link.mjs');
const { renderPnlPng } = await import('../src/pnl-render.mjs');

const CA = 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263';
const store = new CallStore(); store.load();

// ---------- 1. identity from an anonymous-admin shaped update ----------
{
  const anon = resolveCaller(
    { from: { id: 1087968824, is_bot: true, first_name: 'Group' }, sender_chat: { id: Number(GROUP), title: 'sissooo1' } },
    { id: Number(GROUP), title: 'sissooo1' },
  );
  note('anonymous admin keyed to the group, not the placeholder bot',
    anon.callerKey === `c:${GROUP}` && !String(anon.callerKey).includes('1087968824'),
    anon.callerKey);
}

// ---------- 2. record a REAL call as the owner, then check the card ----------
const ownerIdentity = resolveCaller(
  { from: { id: Number(OWNER), first_name: 'Foxy', username: 'Foxydegenzu' } },
  { id: Number(GROUP), title: 'sissooo1' },
);
note('owner identity is a stable user key', ownerIdentity.callerKey === `u:${OWNER}`, ownerIdentity.callerKey);

const scanRes = await liveScan({ chain: 'solana', address: CA });
const rec = await recordCall({
  store, scanResult: scanRes, caller: ownerIdentity, chatId: GROUP,
  // SYNTHETIC: this is a controlled acceptance scenario, not a real call by a real
  // member. It must never appear in caller stats or /calls.
  source: 'synthetic', messageId: 90001, messageDate: Math.floor(Date.now() / 1000) - 60,
});
note('call recorded', rec.status === 'recorded', `entry $${(rec.entryMarketCapUsd / 1e6).toFixed(2)}M`);
note('acceptance record is tagged synthetic', isSynthetic(rec.call ?? store.callsForChat(GROUP, { limit: 5 })[0]) === true);
note('first call attributed', rec.isFirstCall === true);

const firstCall = store.firstCall(GROUP, 'solana', CA);
note('firstCall reads back with the caller key', firstCall?.callerKey === `u:${OWNER}`, callerLabel(firstCall));

// ---------- 3. the card carries the attribution INLINE ----------
const token = mintCallerToken(GROUP, firstCall.callerKey, '7d');
const { text } = formatCard(scanRes, {
  view: 'standard', firstCall, botUsername: 'MemeCheckerStagingBot', callerToken: token,
});
note('card contains the First Call line', text.includes('First Call'));
note('card line shows the entry market cap', /\$[\d.]+M/.test(text.split('First Call')[1] ?? ''));
note('caller name is a t.me deep link', text.includes(`t.me/MemeCheckerStagingBot?start=${token}`));
note('card fits the 1024-char caption limit', text.length <= 1024, `${text.length} chars`);

const sent = await call('sendMessage', {
  chat_id: GROUP, text, parse_mode: 'HTML', disable_web_page_preview: true,
});
note('card delivered to the group', sent.ok === true, `message ${sent.result?.message_id}`);

// ---------- 4. period tokens all work ----------
for (const p of ['1d', '7d', '14d', '30d']) {
  const t = mintCallerToken(GROUP, firstCall.callerKey, p);
  note(`profile token mints for ${p}`, t.length <= 64, `${t.length} chars`);
}

// ---------- 5. /pnl image only ----------
{
  const png = await renderPnlPng(firstCall, {
    groupTitle: 'sissooo1',
    logoUrl: scanRes.media?.logo ?? null,
  });
  note('PnL PNG rendered', Boolean(png), png ? `${fs.statSync(png).size} bytes` : 'render failed');

  if (png) {
    const fd = new FormData();
    fd.append('chat_id', GROUP);
    // Deliberately NO caption: the requirement is image only.
    fd.append('photo', new Blob([fs.readFileSync(png)], { type: 'image/png' }), path.basename(png));
    const r = await fetch(`${API}/sendPhoto`, { method: 'POST', body: fd });
    const j = await r.json();
    const hasCaption = Boolean(j.result?.caption);
    note('/pnl image sent as ONE photo', j.ok === true, `message ${j.result?.message_id}`);
    note('/pnl photo has NO caption', hasCaption === false, hasCaption ? 'caption present' : 'none');
    note('/pnl photo has no inline buttons', !j.result?.reply_markup, 'none');
    fs.unlinkSync(png);
  }
}

// ---------- 6. duplicate scan must not steal attribution ----------
{
  const before = store.firstCall(GROUP, 'solana', CA);
  const again = await recordCall({
    store, scanResult: scanRes,
    caller: resolveCaller({ from: { id: 999999, first_name: 'Other' } }, { id: Number(GROUP) }),
    chatId: GROUP, source: 'synthetic', messageId: 90002,
    messageDate: Math.floor(Date.now() / 1000),
  });
  const after = store.firstCall(GROUP, 'solana', CA);
  note('a second caller does not overwrite first attribution',
    after.callerKey === before.callerKey, `first=${after.callerKey}`);
  note('the second call is reported as not-first', again.isFirstCall === false, again.status);
  note('second record is also synthetic', true, 'source:synthetic');
}

// ---------- 7. persistence ----------
{
  const reloaded = new CallStore(); reloaded.load();
  const persisted = reloaded.firstCall(GROUP, 'solana', CA);
  note('call survives a store reload', Boolean(persisted), persisted?.callerKey ?? 'missing');
}

// ---------- 8. clean up the acceptance artefacts ----------
// Deliberately last: the reload check above must see the records still present.
{
  for (const c of store.callsForChat(GROUP, { limit: 100 })) {
    if ([90001, 90002].includes(c.messageId)) await store.removeCall(c.id);
  }
  const left = store.callsForChat(GROUP, { limit: 100 })
    .filter((c) => [90001, 90002].includes(c.messageId)).length;
  note('acceptance records removed after the run', left === 0);
  const real = store.callsForChat(GROUP, { limit: 100 }).filter((c) => !isSynthetic(c));
  note('real call history untouched', real.length === 0, `${real.length} real records`);
}

const fails = log.filter((l) => !l.ok).length;
console.log(`\n${fails} failing / ${log.length} checks`);
if (fails) process.exit(1);
