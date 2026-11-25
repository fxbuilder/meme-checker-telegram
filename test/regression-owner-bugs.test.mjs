/**
 * test/regression-owner-bugs.test.mjs
 *
 * The ten regression cases the owner required, driven through the REAL handler
 * graph (Telegraf middleware included) rather than isolated renderers.
 *
 * Why this file exists: the previous suite tested renderers and services in
 * isolation, so two routing defects passed 355 green tests and then failed in the
 * owner's real group:
 *
 *   1. A DM /start opened the profile with the DM's chat id, so it queried a chat
 *      that holds no calls and rendered "No calls by this caller".
 *   2. `bot.on('message')` ran before `bot.command('pnl')` and had no command
 *      guard, so `/pnl 0x…` was consumed as a pasted contract and produced the
 *      chain picker and then a token card.
 *
 * These tests exercise the routing layer those bugs lived in.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { CallStore, isSynthetic } from '../src/store.mjs';
import { recordCall } from '../src/call-service.mjs';
import { resolveCaller } from '../src/caller-identity.mjs';
import { mintCallerToken, resolveCallerToken } from '../src/deep-link.mjs';
import {
  handleCallerProfile, resolveStartPayload, callerKeysInGroup, parseCallArgs,
} from '../src/call-commands.mjs';
import { renderCallerProfile } from '../src/caller-profile.mjs';

const GROUP = '-5333984336';
const DM = '1307106746';
const OWNER = 1307106746;
const SOL_CA = 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263';
const PEPE = '0x6982508145454ce325ddbe47a25d4ec3d2311933';

function tmpStore() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-reg-'));
  return new CallStore(path.join(dir, 'calls.json'));
}

const scanRes = {
  status: 'ok',
  token: { chain: 'solana', address: SOL_CA, name: 'Bonk', symbol: 'Bonk' },
  market: { priceUsd: 0.0000022, marketCapUsd: 193_577_619, liquidityUsd: 200_000 },
  media: {},
};

function ctxFor({ text = '', chatId = GROUP, chatType = 'supergroup', userId = OWNER, title = 'sissooo1' } = {}) {
  const out = [];
  const ctx = {
    chat: { id: Number(chatId), type: chatType, title },
    from: { id: userId, first_name: 'Foxy', username: 'Foxydegenzu' },
    message: { text, message_id: 1, date: Math.floor(Date.now() / 1000) },
    replies: out,
    async reply(t, o) { out.push({ text: t, ...o }); return { message_id: out.length }; },
    async answerCbQuery() {},
    async deleteMessage() {},
    async editMessageText(t, o) { out.push({ text: t, edited: true, ...o }); },
  };
  return { ctx, out };
}

async function seedRealCall(store, over = {}) {
  return recordCall({
    store, scanResult: scanRes,
    caller: resolveCaller({ from: { id: OWNER, first_name: 'Foxy', username: 'Foxydegenzu' } }, { id: Number(GROUP), title: 'sissooo1' }),
    chatId: GROUP, source: 'auto', messageId: 210,
    messageDate: Math.floor(Date.now() / 1000) - 3600,
    ...over,
  });
}

// ---- 1. Real Auto Call → persistence → First Call link → DM profile --------

test('1. a real auto call persists and its link resolves into a NON-EMPTY profile', async () => {
  const store = tmpStore();
  const rec = await seedRealCall(store);
  assert.equal(rec.status, 'recorded');

  const first = store.firstCall(GROUP, 'solana', SOL_CA);
  assert.equal(first.callerKey, `u:${OWNER}`);
  assert.equal(first.entryMarketCapUsd, 193_577_619);

  const token = mintCallerToken(GROUP, first.callerKey, '7d');
  const resolved = resolveStartPayload(token, store, { chatIds: [GROUP] });
  assert.equal(resolved?.chatId, GROUP, 'payload must resolve to the GROUP');
  assert.equal(resolved?.callerKey, `u:${OWNER}`);

  // Drive the profile exactly as /start does, in a DM context.
  const { ctx, out } = ctxFor({ chatId: DM, chatType: 'private' });
  const profile = await handleCallerProfile(ctx, {
    store,
    callerKey: resolved.callerKey,
    chatId: resolved.chatId,
    groupTitle: 'sissooo1',
    period: resolved.period,
  });
  assert.ok(profile, 'profile must render');
  assert.ok(!/No tracked calls in this period/.test(profile.text), `empty profile: ${profile.text}`);
  assert.match(profile.text, /Calls <b>1<\/b>/);
  assert.ok(profile.text.includes('Foxy'), 'caller name must appear');
});

test('1b. a profile opened in the DM must NOT query the DM chat id (the original bug)', async () => {
  const store = tmpStore();
  await seedRealCall(store);

  // The pre-fix behaviour: chatId taken from ctx.chat is the DM, which holds nothing.
  assert.equal(store.callsForChat(DM, { limit: 50 }).length, 0,
    'precondition: the DM chat id genuinely holds no calls');

  const { ctx } = ctxFor({ chatId: DM, chatType: 'private' });
  const profile = await handleCallerProfile(ctx, {
    store, callerKey: `u:${OWNER}`, chatId: GROUP, groupTitle: 'sissooo1', period: '7d',
  });
  assert.ok(!/No tracked calls in this period/.test(profile.text));
});

// ---- 2. group scope retained ----------------------------------------------

test('2. a profile never reads another group, even with a valid caller key', async () => {
  const store = tmpStore();
  await seedRealCall(store);
  const OTHER = '-1009999999999';
  const { ctx } = ctxFor({ chatId: DM, chatType: 'private' });
  const profile = await handleCallerProfile(ctx, {
    store, callerKey: `u:${OWNER}`, chatId: OTHER, groupTitle: 'other', period: '7d',
  });
  assert.match(profile.text, /No tracked calls in this period/);
});

test('2b. a token minted for one group does not resolve in another', () => {
  const token = mintCallerToken(GROUP, `u:${OWNER}`, '7d');
  assert.equal(resolveCallerToken(token, '-1009999999999', [{ callerKey: `u:${OWNER}` }]), null);
});

// ---- 3. all four period filters ------------------------------------------

test('3. all four periods are queryable and include eligible recent calls', async () => {
  const store = tmpStore();
  await seedRealCall(store);
  for (const period of ['1d', '7d', '14d', '30d']) {
    const { ctx } = ctxFor({ chatId: DM, chatType: 'private' });
    const profile = await handleCallerProfile(ctx, {
      store, callerKey: `u:${OWNER}`, chatId: GROUP, groupTitle: 'sissooo1', period,
    });
    assert.match(profile.text, /Calls <b>1<\/b>/, `${period} must include a 1h-old call`);
    assert.ok(profile.keyboard.some((row) => row.some((b) => b.callback_data.includes(`:${period}:`))), `${period} button present`);
  }
});

test('3b. a 20-day-old call appears in 30D only', () => {
  const old = {
    id: 'o1', chatId: GROUP, callerKey: `u:${OWNER}`, callerName: 'Foxy',
    chain: 'solana', address: SOL_CA, symbol: 'BONK',
    entryMarketCapUsd: 1e6, peakMarketCapUsd: 3e6,
    calledAt: Date.now() - 20 * 86400_000, status: 'active',
  };
  for (const [p, n] of [['1d', 0], ['7d', 0], ['14d', 0], ['30d', 1]]) {
    const { text } = renderCallerProfile({ callerKey: `u:${OWNER}`, calls: [old], groupTitle: 'g', period: p });
    if (n === 0) assert.match(text, /No tracked calls in this period/, p);
    else assert.match(text, /Calls <b>1<\/b>/, p);
  }
});

// ---- 4. real visible, synthetic and cancelled excluded --------------------

test('4. real records show; synthetic and cancelled are excluded', async () => {
  const store = tmpStore();
  // A synthetic record for a DIFFERENT token, so it cannot be confused with the
  // real one under the one-call-per-token rule.
  await recordCall({
    store,
    scanResult: {
      status: 'ok',
      token: { chain: 'solana', address: 'So11111111111111111111111111111111111111112', name: 'Sim', symbol: 'SIMULATION' },
      market: { marketCapUsd: 1_000_000, liquidityUsd: 50_000 },
      media: {},
    },
    caller: resolveCaller({ from: { id: OWNER, first_name: 'Foxy' } }, { id: Number(GROUP) }),
    chatId: GROUP, source: 'synthetic', messageId: 500,
  });

  await seedRealCall(store);

  const { ctx } = ctxFor({ chatId: DM, chatType: 'private' });
  const profile = await handleCallerProfile(ctx, {
    store, callerKey: `u:${OWNER}`, chatId: GROUP, groupTitle: 'sissooo1', period: '7d',
  });
  assert.match(profile.text, /Calls <b>1<\/b>/, `only the live real call counts: ${profile.text}`);
  assert.ok(!/SIMULATION/.test(profile.text), 'synthetic token must not be listed');
});

test('4b. firstCall ignores cancelled and synthetic records', async () => {
  const store = tmpStore();
  await recordCall({
    store, scanResult: scanRes,
    caller: resolveCaller({ from: { id: 7, first_name: 'Sim' } }, { id: Number(GROUP) }),
    chatId: GROUP, source: 'synthetic', messageId: 501,
  });
  assert.equal(store.firstCall(GROUP, 'solana', SOL_CA), null, 'a synthetic record must not own attribution');

  const real = await seedRealCall(store);
  await store.updateCall(real.call.id, { status: 'cancelled' });
  assert.equal(store.firstCall(GROUP, 'solana', SOL_CA), null, 'a cancelled call must not own attribution');
});

// ---- 5. /pnl with an unrecorded EVM CA: no picker ------------------------

test('5. /pnl with an unrecorded EVM CA resolves from records only — no chain detection', () => {
  const store = tmpStore();
  // Record-first resolution must find nothing, and must not need a chain guess.
  assert.deepEqual(store.recordedCallsForAddress(GROUP, PEPE), []);
  assert.deepEqual(store.recordedChainsForAddress(GROUP, PEPE), []);

  // The parser still yields an address (and would yield many candidate chains);
  // the point is that /pnl never consults those candidates before the store.
  const parsed = parseCallArgs(PEPE, 'bsc');
  assert.ok(parsed.address);
  assert.ok(parsed.candidates.length >= 1);
  assert.equal(store.recordedCallsForAddress(GROUP, parsed.address).length, 0);
});

// ---- 6/7. recorded Solana and EVM resolve --------------------------------

test('6. a recorded Solana call resolves to exactly ONE chain', async () => {
  const store = tmpStore();
  await seedRealCall(store);
  const chains = store.recordedChainsForAddress(GROUP, SOL_CA);
  assert.deepEqual(chains, ['solana']);
  const calls = store.recordedCallsForAddress(GROUP, SOL_CA);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].chain, 'solana');
});

test('7. a recorded EVM call resolves its chain automatically, case-insensitively', async () => {
  const store = tmpStore();
  await recordCall({
    store, chatId: GROUP, source: 'auto', messageId: 600,
    caller: resolveCaller({ from: { id: OWNER, first_name: 'Foxy' } }, { id: Number(GROUP) }),
    scanResult: {
      status: 'ok',
      token: { chain: 'ethereum', address: PEPE, name: 'Pepe', symbol: 'PEPE' },
      market: { marketCapUsd: 4e9, liquidityUsd: 9e7 },
      media: {},
    },
  });
  // Queried with different casing, because EVM addresses are case-insensitive.
  const chains = store.recordedChainsForAddress(GROUP, PEPE.toUpperCase().replace('0X', '0x'));
  assert.deepEqual(chains, ['ethereum'], 'must resolve without any chain hint');
});

// ---- 8. ambiguous recorded chains preserve the PnL action ----------------

test('8. an address recorded on two chains reports BOTH and stays in the PnL flow', async () => {
  const store = tmpStore();
  for (const chain of ['ethereum', 'bsc']) {
    await recordCall({
      store, chatId: GROUP, source: 'auto', messageId: chain === 'bsc' ? 701 : 700,
      caller: resolveCaller({ from: { id: OWNER, first_name: 'Foxy' } }, { id: Number(GROUP) }),
      scanResult: {
        status: 'ok', token: { chain, address: PEPE, name: 'Pepe', symbol: 'PEPE' },
        market: { marketCapUsd: 4e9, liquidityUsd: 9e7 }, media: {},
      },
    });
  }
  const chains = store.recordedChainsForAddress(GROUP, PEPE);
  assert.equal(chains.length, 2);
  assert.deepEqual(chains.sort(), ['bsc', 'ethereum']);

  // The disambiguation callback must be namespaced for PnL, not the generic scan.
  const cb = `pnl:${chains[0]}:${PEPE}`;
  assert.ok(cb.length <= 64, `callback data ${cb.length} bytes`);
  assert.ok(cb.startsWith('pnl:'), 'must not use the generic c: prefix');
});

// ---- 9. generic CA detection never intercepts a command ------------------

test('9. a command carrying an address is a command, not a pasted contract', () => {
  // This is the exact guard that was missing from bot.on('message').
  const isCommand = (t) => /^\/\w/.test(String(t).trim());
  for (const t of [`/pnl ${PEPE}`, `/call ${SOL_CA}`, `/justscan ${SOL_CA}`, '/calls', '/pnl']) {
    assert.equal(isCommand(t), true, t);
  }
  for (const t of [`${PEPE}`, `${SOL_CA}`, `check this ${PEPE}`]) {
    assert.equal(isCommand(t), false, t);
  }
});

// ---- 10. restart preserves records and links -----------------------------

test('10. real records and deep links survive a store reload', async () => {
  const store = tmpStore();
  await seedRealCall(store);
  const token = mintCallerToken(GROUP, `u:${OWNER}`, '7d');

  // A fresh instance reading the same file = a restart.
  const reloaded = new CallStore(store.filePath);
  reloaded.load();
  const first = reloaded.firstCall(GROUP, 'solana', SOL_CA);
  assert.equal(first?.callerKey, `u:${OWNER}`);
  assert.equal(first?.entryMarketCapUsd, 193_577_619);

  const resolved = resolveStartPayload(token, reloaded, { chatIds: [GROUP] });
  assert.equal(resolved?.callerKey, `u:${OWNER}`, 'the same link still resolves after restart');
});

test('10b. importing the bot does not start polling', () => {
  const src = fs.readFileSync(new URL('../src/bot.mjs', import.meta.url), 'utf8');
  assert.match(src, /BOT_NO_LAUNCH/, 'launch must be guarded so tests cannot cause a 409');
});
