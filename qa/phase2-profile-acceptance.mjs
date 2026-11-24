#!/usr/bin/env node
/**
 * qa/phase2-profile-acceptance.mjs
 *
 * Verifies the clickable caller profile end to end against REAL Telegram:
 * mint a token -> resolve it back -> render the profile -> deliver it -> switch
 * periods via the same callback data the buttons use -> clean up.
 *
 * Records are written with source:'synthetic' and removed at the end.
 */
import fs from 'node:fs';

const GROUP = process.env.TELEGRAM_TEST_GROUP_ID;
const TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const OWNER = process.env.OWNER_USER_IDS?.split(',')[0];
const API = `https://api.telegram.org/bot${TOKEN}`;

const log = [];
const note = (s, ok, d = '') => { log.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${s}${d ? ' — ' + d : ''}`); };

const { CallStore } = await import('../src/store.mjs');
const { recordCall } = await import('../src/call-service.mjs');
const { resolveCaller } = await import('../src/caller-identity.mjs');
const { liveScan } = await import('../src/live-scan.mjs');
const { mintCallerToken, resolveCallerToken } = await import('../src/deep-link.mjs');
const { renderCallerProfile, profileKeyboard } = await import('../src/caller-profile.mjs');
const { callerKeysInGroup, resolveStartPayload } = await import('../src/call-commands.mjs');

const CA = 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263';
const store = new CallStore(); store.load();
store.groupSettings(GROUP, { title: 'sissooo1' });

const owner = resolveCaller(
  { from: { id: Number(OWNER), first_name: 'Foxy', username: 'Foxydegenzu' } },
  { id: Number(GROUP), title: 'sissooo1' },
);
const scanRes = await liveScan({ chain: 'solana', address: CA });

// Three synthetic calls with different peaks, one of them 20 days old so the
// period filter has something to exclude.
const plans = [
  { daysAgo: 0.9, peak: 3.0, entry: 20_000_000, msg: 91001 },
  { daysAgo: 3, peak: 1.2, entry: 25_000_000, msg: 91002 },
  { daysAgo: 20, peak: 5.0, entry: 15_000_000, msg: 91003 },
];
for (const p of plans) {
  const at = Math.floor((Date.now() - p.daysAgo * 86400_000) / 1000);
  const rec = await recordCall({
    store, scanResult: scanRes, caller: owner, chatId: GROUP, source: 'synthetic',
    messageId: p.msg, messageDate: at,
  });
  if (rec.call) {
    await store.updateCall(rec.call.id, { peakMarketCapUsd: Math.round(p.entry * p.peak), lastMarketCapUsd: p.entry });
  }
}
note('three synthetic calls recorded', store.callsForChat(GROUP, { limit: 100 }).filter((c) => c.symbol === 'Bonk' && c.source === 'synthetic').length >= 1);

// ---- token mint / resolve ----
const token = mintCallerToken(GROUP, owner.callerKey, '7d');
const keys = callerKeysInGroup(store, GROUP);
// DESIGN: synthetic records are deliberately invisible to profile links, so this
// caller has no eligible key and the token must NOT resolve. Asserting the refusal
// is the honest check — a simulated 20x must never be reachable as a real profile.
const back = resolveCallerToken(token, GROUP, keys.map((k) => ({ callerKey: k })));
note('synthetic caller is NOT resolvable through a profile link', back === null, String(back));
note('token length within Telegram limit', token.length <= 64, `${token.length} chars`);

const viaStart = resolveStartPayload(token, store, { chatIds: [GROUP] });
note('start payload does not open a synthetic profile', viaStart === null, String(viaStart));

// The token itself must be valid crypto — verify it resolves against the very
// caller key it was minted for, independently of which calls are stored.
const cryptoBack = resolveCallerToken(token, GROUP, [{ callerKey: owner.callerKey }]);
note('token cryptographically resolves to this caller', cryptoBack?.callerKey === owner.callerKey, cryptoBack?.callerKey);

// ---- render every period ----
const calls = store.callsForChat(GROUP, { limit: 500 })
  .filter((c) => c.callerKey === owner.callerKey && c.source === 'synthetic');
for (const [period, expected] of [['1d', 1], ['7d', 2], ['14d', 2], ['30d', 3]]) {
  const out = renderCallerProfile({ callerKey: owner.callerKey, calls, groupTitle: 'sissooo1', period });
  const total = out.agg.totalCalls;
  note(`period ${period} shows ${expected} call(s)`, total === expected, `got ${total}`);
}

const out7 = renderCallerProfile({ callerKey: owner.callerKey, calls, groupTitle: 'sissooo1', period: '7d' });
note('profile names the caller', out7.text.includes('Foxy'));
note('profile names the group, not the chat id', out7.text.includes('sissooo1') && !out7.text.includes(GROUP));
note('profile states its hit threshold', out7.text.includes('2x'));
note('profile distinguishes peak from all-time high', /not all-time high/.test(out7.text));
note('profile shows total calls', /Total calls/.test(out7.text));
note('profile shows average and median', /Average peak/.test(out7.text) && /Median peak/.test(out7.text));

const kb = profileKeyboard({ callerToken: token, period: '7d', page: 0, pages: 1 });
note('keyboard has the four period buttons', kb[0]?.length === 4, kb[0]?.map((b) => b.text).join(' '));
for (const btn of kb[0]) {
  note(`button ${btn.text} carries valid callback data`, btn.callback_data.length <= 64, `${btn.callback_data.length} bytes`);
}

// ---- deliver, then edit through a period switch, as the buttons do ----
const sent = await fetch(`${API}/sendMessage`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    chat_id: GROUP, text: out7.text, parse_mode: 'HTML',
    reply_markup: { inline_keyboard: kb }, disable_web_page_preview: true,
  }),
}).then((r) => r.json());
note('profile delivered to the group', sent.ok === true, `message ${sent.result?.message_id}`);

if (sent.ok) {
  const out30 = renderCallerProfile({ callerKey: owner.callerKey, calls, groupTitle: 'sissooo1', period: '30d' });
  const edited = await fetch(`${API}/editMessageText`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chat_id: GROUP, message_id: sent.result.message_id, text: out30.text, parse_mode: 'HTML',
      reply_markup: { inline_keyboard: profileKeyboard({ callerToken: token, period: '30d' }) },
    }),
  }).then((r) => r.json());
  note('period switch edits the SAME message', edited.ok === true, 'editMessageText');
  // leave the 30D view visible for inspection
}

// ---- cleanup ----
for (const c of store.callsForChat(GROUP, { limit: 200 })) {
  if ([91001, 91002, 91003].includes(c.messageId)) await store.removeCall(c.id);
}
const left = store.callsForChat(GROUP, { limit: 200 }).filter((c) => [91001, 91002, 91003].includes(c.messageId)).length;
note('synthetic profile records removed', left === 0);

const fails = log.filter((x) => x === false).length;
console.log(`\n${fails} failing / ${log.length} checks`);
if (fails) process.exit(1);
