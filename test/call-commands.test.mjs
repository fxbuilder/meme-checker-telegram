/**
 * test/call-commands.test.mjs
 * Handler-level tests for /call, /calls, /fc, /pnl, /callsettings, /justscan.
 * Uses a synthetic ctx — no Telegraf, no network.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { CallStore } from '../src/store.mjs';
import {
  handleCall, handleCalls, handleFirstCall, handlePnl, handleCallSettings,
  handleJustScan, parseCallArgs, callerIdentity, isGroupChat,
} from '../src/call-commands.mjs';
import { recordCall } from '../src/call-service.mjs';

const CHAT = -100999;
const CA = '0x0e09fabb73bd3ade0a17ecc321fd13a19e81ce82';
const SOL = 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263';

function tmpStore() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-cmd-'));
  return new CallStore(path.join(dir, 'calls.json'));
}

function okScan(over = {}) {
  return {
    mode: 'live', status: 'ok',
    token: { chain: 'bsc', address: CA, name: 'Cake', symbol: 'CAKE' },
    market: { priceUsd: 1.5, marketCapUsd: 5_000_000, fdvUsd: 5e6, liquidityUsd: 4e5, volume24hUsd: 9e4, priceChange24h: 3, priceChange1h: 0.5 },
    source: { provider: 'dexscreener', pairAddress: 'PAIR-A' },
    ...over,
  };
}

/** Synthetic Telegraf-like ctx that records replies. */
function makeCtx({ text = '', chatType = 'supergroup', userId = 42, username = 'foxy', chatId = CHAT } = {}) {
  const out = [];
  return {
    out,
    ctx: {
      from: { id: userId, first_name: 'Foxy', username, is_bot: false },
      chat: { id: chatId, type: chatType },
      message: { text, message_id: 11 },
      reply: async (t, opts) => { out.push({ text: t, opts }); return { message_id: 1 }; },
      telegram: {
        sendPhoto: async (c, photo, opts) => { out.push({ photo, opts, text: opts?.caption }); return { message_id: 2 }; },
        sendMessage: async (c, t, opts) => { out.push({ text: t, opts }); return { message_id: 3 }; },
        deleteMessage: async () => {},
      },
    },
  };
}

const scanOk = async () => okScan();

// ---- helpers -------------------------------------------------------------

test('parseCallArgs extracts chain hints and addresses', () => {
  assert.equal(parseCallArgs(`/call ${CA}`).address, CA);
  assert.equal(parseCallArgs(`/call base ${CA}`).chainHint, 'base');
  assert.equal(parseCallArgs(`/call base ${CA}`).candidates[0].chain, 'base');
  assert.equal(parseCallArgs('/call').address, null);
});

test('isGroupChat distinguishes groups from DMs', () => {
  assert.equal(isGroupChat({ chat: { type: 'supergroup' } }), true);
  assert.equal(isGroupChat({ chat: { type: 'group' } }), true);
  assert.equal(isGroupChat({ chat: { type: 'private' } }), false);
});

test('callerIdentity uses first+last name, falling back to username', () => {
  assert.equal(callerIdentity({ from: { id: 1, first_name: 'A', last_name: 'B', username: 'ab' } }).displayName, 'A B');
  assert.equal(callerIdentity({ from: { id: 1, username: 'ab' } }).displayName, 'ab');
});

// ---- /call ---------------------------------------------------------------

test('/call records a call and reports entry MC and first-call status', async () => {
  const store = tmpStore();
  const { ctx, out } = makeCtx({ text: `/call ${CA}` });
  await handleCall(ctx, { store, scan: scanOk });

  assert.equal(out.length, 1);
  assert.match(out[0].text, /Call recorded/);
  assert.match(out[0].text, /first call/);
  assert.match(out[0].text, /\$5\.00M/);
  assert.equal(store.callsForChat(CHAT).length, 1);
});

test('/call in a DM explains call tracking is group-scoped and writes nothing', async () => {
  const store = tmpStore();
  const { ctx, out } = makeCtx({ text: `/call ${CA}`, chatType: 'private' });
  await handleCall(ctx, { store, scan: scanOk });
  assert.match(out[0].text, /for groups/i);
  assert.equal(store.callsForChat(CHAT).length, 0);
});

test('/call with no address shows usage, no record', async () => {
  const store = tmpStore();
  const { ctx, out } = makeCtx({ text: '/call' });
  await handleCall(ctx, { store, scan: scanOk });
  assert.match(out[0].text, /Usage/);
  assert.equal(store.callsForChat(CHAT).length, 0);
});

test('/call on a token-not-found scan reports it and saves nothing', async () => {
  const store = tmpStore();
  const { ctx, out } = makeCtx({ text: `/call ${CA}` });
  await handleCall(ctx, { store, scan: async () => ({ status: 'not-found' }) });
  assert.match(out[0].text, /Token not found/);
  assert.equal(store.callsForChat(CHAT).length, 0);
});

test('/call for an already-tracked token reports the existing call, never a second one', async () => {
  // Product rule: one canonical tracked call per group + chain + contract. A later
  // caller cannot add a second record or take attribution from the first caller.
  const store = tmpStore();
  const first = await recordCall({
    store, scanResult: okScan(),
    caller: { id: 1, displayName: 'First', username: 'first' },
    chatId: CHAT, now: Date.now() - 60_000,
  });

  const { ctx, out } = makeCtx({ text: `/call ${CA}`, userId: 2, username: 'second' });
  await handleCall(ctx, { store, scan: scanOk });

  assert.equal(store.callsForChat(CHAT, { limit: 50 }).length, 1, 'still exactly one record');
  // The message may legitimately say "first call by <someone>"; what must NOT
  // happen is the second member being presented as the caller.
  assert.ok(!/@second/.test(out[0].text), 'the second caller must not be presented as owner');
  assert.match(out[0].text, /First/, 'the original caller is named');
  // Attribution and entry are untouched. okScan() is BSC, so query that chain.
  const kept = store.callsForToken(CHAT, 'bsc', CA)[0];
  assert.equal(kept.id, first.call.id);
  assert.equal(kept.callerKey, 'u:1');
});

// ---- /calls --------------------------------------------------------------

test('/calls on an empty group explains how to start', async () => {
  const store = tmpStore();
  const { ctx, out } = makeCtx({ text: '/calls' });
  await handleCalls(ctx, { store });
  assert.match(out[0].text, /No calls yet/);
});

test('/calls lists records with ROI and caller', async () => {
  const store = tmpStore();
  await recordCall({ store, scanResult: okScan(), caller: { id: 1, displayName: 'F', username: 'foxy' }, chatId: CHAT });
  const { ctx, out } = makeCtx({ text: '/calls' });
  await handleCalls(ctx, { store });
  assert.match(out[0].text, /Recent calls/);
  assert.match(out[0].text, /\$CAKE/, 'ticker is shown');
  assert.match(out[0].text, /@foxy/);
  assert.match(out[0].text, /entry \$5\.00M/);
});

test('/calls never lists synthetic records', async () => {
  const store = tmpStore();
  await store.addCall({
    chatId: String(CHAT), callerId: 'sim', chain: 'bsc', address: `0x${'d'.repeat(40)}`,
    entryMarketCapUsd: 1, status: 'active', source: 'synthetic', calledAt: Date.now(),
  });
  const { ctx, out } = makeCtx({ text: '/calls' });
  await handleCalls(ctx, { store });
  assert.match(out[0].text, /No calls yet/, 'synthetic records must not appear as real calls');
});

// ---- /fc -----------------------------------------------------------------

test('/fc reports the first caller and entry', async () => {
  const store = tmpStore();
  await recordCall({
    store, scanResult: okScan(),
    caller: { id: 5, displayName: 'Early', username: 'early' },
    chatId: CHAT, now: Date.now() - 3600_000,
  });
  const { ctx, out } = makeCtx({ text: `/fc ${CA}` });
  await handleFirstCall(ctx, { store });
  assert.match(out[0].text, /First call/);
  assert.match(out[0].text, /@early/);
  assert.match(out[0].text, /\$5\.00M/);
});

test('/fc for an uncalled token says so', async () => {
  const store = tmpStore();
  const { ctx, out } = makeCtx({ text: `/fc ${CA}` });
  await handleFirstCall(ctx, { store });
  assert.match(out[0].text, /No call recorded/);
});

// ---- /pnl ----------------------------------------------------------------

test('/pnl sends exactly ONE photo with NO caption for a recorded call', async () => {
  const store = tmpStore();
  await recordCall({ store, scanResult: okScan(), caller: { id: 1, displayName: 'F', username: 'foxy' }, chatId: CHAT });
  const { ctx, out } = makeCtx({ text: `/pnl ${CA}` });

  await handlePnl(ctx, {
    store,
    scan: scanOk,
    renderPng: async () => 'C:/tmp/card.png',
    sendPhoto: async (chatId, p, opts) => { out.push({ photo: p, opts }); },
  });

  const photos = out.filter((o) => o.photo);
  assert.equal(photos.length, 1, 'exactly one photo');
  assert.equal(photos[0].opts.caption, undefined, 'no caption attached');
  assert.equal(photos[0].opts.parse_mode, undefined, 'no parse mode for an empty caption');
  assert.equal(photos[0].opts.reply_markup, undefined, 'no buttons');
  // No separate text report.
  assert.equal(out.filter((o) => o.text && !o.photo).length, 0, 'no extra text message');
});

test('/pnl with an unrecorded CA says so exactly once and inserts nothing', async () => {
  const store = tmpStore();
  const before = store.callsForChat(CHAT, { limit: 50 }).length;
  const other = `0x${'b'.repeat(40)}`;
  const { ctx, out } = makeCtx({ text: `/pnl ${other}` });

  await handlePnl(ctx, { store, scan: scanOk, renderPng: async () => 'x', sendPhoto: async () => {} });

  assert.equal(out.length, 1, 'one response only');
  assert.equal(out[0].text, 'No recorded call for this token in this group.');
  assert.equal(store.callsForChat(CHAT, { limit: 50 }).length, before, 'no call created');
});

test('/pnl reports a render failure instead of faking a text delivery', async () => {
  const store = tmpStore();
  await recordCall({ store, scanResult: okScan(), caller: { id: 1, displayName: 'F', username: 'foxy' }, chatId: CHAT });
  const { ctx, out } = makeCtx({ text: `/pnl ${CA}` });

  await handlePnl(ctx, {
    store, scan: scanOk,
    renderPng: async () => { throw new Error('no renderer'); },
    sendPhoto: async () => { throw new Error('must not be called'); },
  });

  assert.ok(!out.some((o) => o.photo), 'no photo claimed');
  const msg = out.find((o) => o.text);
  assert.match(msg.text, /Could not generate the PnL image/);
  assert.ok(!/Entry MC|ROI:/.test(msg.text), 'must not present a text report as success');
});

test('/pnl survives a failed refresh and still sends the image', async () => {
  const store = tmpStore();
  await recordCall({ store, scanResult: okScan(), caller: { id: 1, displayName: 'F', username: 'foxy' }, chatId: CHAT });
  const { ctx, out } = makeCtx({ text: `/pnl ${CA}` });
  await handlePnl(ctx, {
    store, scan: async () => ({ status: 'api-error' }),
    renderPng: async () => 'C:/tmp/card.png',
    sendPhoto: async (chatId, p) => { out.push({ photo: p }); },
  });
  assert.equal(out.filter((o) => o.photo).length, 1);
});

test('/pnl with no argument shows usage, makes no call', async () => {
  const store = tmpStore();
  const { ctx, out } = makeCtx({ text: '/pnl' });
  await handlePnl(ctx, { store, scan: scanOk });
  assert.match(out[0].text, /Usage/);
  assert.equal(store.callsForChat(CHAT, { limit: 50 }).length, 0);
});

test('/pnl rejects a non-address argument', async () => {
  const store = tmpStore();
  const { ctx, out } = makeCtx({ text: '/pnl notanaddress' });
  await handlePnl(ctx, { store, scan: scanOk });
  assert.match(out[0].text, /does not look like a contract address/);
});

test("/pnl never falls back to another group's call history", async () => {
  const store = tmpStore();
  // A call exists in a DIFFERENT group for the same token.
  await recordCall({
    store, scanResult: okScan(),
    caller: { id: 9, displayName: 'x', username: 'x' }, chatId: '-100OTHER',
  });
  const { ctx, out } = makeCtx({ text: `/pnl ${CA}` });
  await handlePnl(ctx, { store, scan: scanOk, renderPng: async () => 'x', sendPhoto: async () => {} });
  assert.equal(out[0].text, 'No recorded call for this token in this group.');
});

test('/pnl does not create a call for an unrecorded token', async () => {
  const store = tmpStore();
  const { ctx } = makeCtx({ text: `/pnl ${CA}` });
  await handlePnl(ctx, { store, scan: scanOk, renderPng: async () => 'x', sendPhoto: async () => {} });
  assert.equal(store.callsForChat(CHAT, { limit: 50 }).length, 0);
});

// ---- /callsettings -------------------------------------------------------

test('/callsettings shows defaults with auto-call OFF', async () => {
  const store = tmpStore();
  const { ctx, out } = makeCtx({ text: '/callsettings' });
  await handleCallSettings(ctx, { store });
  assert.match(out[0].text, /Auto call: <b>OFF<\/b>/);
});

test('/callsettings toggles auto-call and persists', async () => {
  const store = tmpStore();
  const { ctx, out } = makeCtx({ text: '/callsettings autocall on' });
  await handleCallSettings(ctx, { store });
  assert.match(out[0].text, /Auto call ON/);
  assert.equal(store.groupSettings(CHAT).autoCall, 'auto');

  const { ctx: ctx2, out: out2 } = makeCtx({ text: '/callsettings autocall off' });
  await handleCallSettings(ctx2, { store });
  assert.match(out2[0].text, /Auto call OFF/);
  assert.equal(store.groupSettings(CHAT).autoCall, 'manual');
});

test('/callsettings minmc validates and persists', async () => {
  const store = tmpStore();
  const { ctx, out } = makeCtx({ text: '/callsettings minmc 25000' });
  await handleCallSettings(ctx, { store });
  assert.match(out[0].text, /Minimum market cap set/);
  assert.equal(store.groupSettings(CHAT).minMarketCapUsd, 25_000);

  const { ctx: bad, out: badOut } = makeCtx({ text: '/callsettings minmc abc' });
  await handleCallSettings(bad, { store });
  assert.match(badOut[0].text, /Usage/);
});

test('/callsettings rejects an unknown key', async () => {
  const store = tmpStore();
  const { ctx, out } = makeCtx({ text: '/callsettings nonsense 1' });
  await handleCallSettings(ctx, { store });
  assert.match(out[0].text, /Unknown setting/);
});

// ---- /justscan -----------------------------------------------------------

test('/justscan confirms a scan-only post', async () => {
  const { ctx, out } = makeCtx({ text: '/justscan' });
  await handleJustScan(ctx);
  assert.match(out[0].text, /not recorded as a call/);
});

// ---- Settings authority is owner-only during staging ---------------------

test('an ordinary member cannot change call settings', async () => {
  const store = tmpStore();
  const { loadPolicy } = await import('../src/access.mjs');
  const policy = loadPolicy({ OWNER_USER_IDS: '42', ALLOWED_CHAT_IDS: String(CHAT) });

  const { ctx, out } = makeCtx({ text: '/callsettings autocall on', userId: 777 });
  await handleCallSettings(ctx, { store, policy });

  assert.match(out[0].text, /only the bot owner/);
  assert.equal(store.groupSettings(CHAT).autoCall, 'manual', 'setting must not change');
});

test('the owner can change call settings', async () => {
  const store = tmpStore();
  const { loadPolicy } = await import('../src/access.mjs');
  const policy = loadPolicy({ OWNER_USER_IDS: '42', ALLOWED_CHAT_IDS: String(CHAT) });

  const { ctx, out } = makeCtx({ text: '/callsettings autocall on', userId: 42 });
  await handleCallSettings(ctx, { store, policy });

  assert.match(out[0].text, /Auto call ON/);
  assert.equal(store.groupSettings(CHAT).autoCall, 'auto');
});

test('reading settings is allowed for everyone', async () => {
  const store = tmpStore();
  const { loadPolicy } = await import('../src/access.mjs');
  const policy = loadPolicy({ OWNER_USER_IDS: '42', ALLOWED_CHAT_IDS: String(CHAT) });

  const { ctx, out } = makeCtx({ text: '/callsettings', userId: 777 });
  await handleCallSettings(ctx, { store, policy });
  assert.match(out[0].text, /Call settings/, 'read-only view is not gated');
});
