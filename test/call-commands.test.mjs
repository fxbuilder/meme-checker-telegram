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

test('/call reports the existing first caller instead of stealing it', async () => {
  const store = tmpStore();
  await recordCall({
    store, scanResult: okScan(),
    caller: { id: 1, displayName: 'First', username: 'first' },
    chatId: CHAT, now: Date.now() - 60_000,
  });
  const { ctx, out } = makeCtx({ text: `/call ${CA}`, userId: 2, username: 'second' });
  await handleCall(ctx, { store, scan: scanOk });
  assert.ok(!/first call/.test(out[0].text), 'second caller must not be labelled first');
  assert.match(out[0].text, /First call: @first/);
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

test('/pnl sends an image card when a renderer is available', async () => {
  const store = tmpStore();
  await recordCall({ store, scanResult: okScan(), caller: { id: 1, displayName: 'F', username: 'foxy' }, chatId: CHAT });
  const { ctx, out } = makeCtx({ text: '/pnl' });

  await handlePnl(ctx, {
    store,
    scan: async () => okScan({ market: { ...okScan().market, marketCapUsd: 10_000_000 } }),
    renderPng: async () => 'C:/tmp/card.png',
    sendPhoto: async (chatId, p, opts) => { out.push({ photo: p, text: opts.caption }); },
  });

  const photoMsg = out.find((o) => o.photo);
  assert.ok(photoMsg, 'expected a photo card');
  assert.match(photoMsg.text, /PnL/);
  assert.match(photoMsg.text, /2\.00x/, 'refreshed to 10M against a 5M entry');
  assert.match(photoMsg.text, /not realized profit/);
});

test('/pnl falls back to a text card when rendering fails', async () => {
  const store = tmpStore();
  await recordCall({ store, scanResult: okScan(), caller: { id: 1, displayName: 'F', username: 'foxy' }, chatId: CHAT });
  const { ctx, out } = makeCtx({ text: '/pnl' });

  await handlePnl(ctx, {
    store, scan: scanOk,
    renderPng: async () => { throw new Error('no renderer'); },
    sendPhoto: async () => { throw new Error('should not be called'); },
  });

  assert.ok(!out.some((o) => o.photo), 'must not claim a photo');
  const textMsg = out.find((o) => o.text && /PnL/.test(o.text));
  assert.ok(textMsg, 'text fallback must be sent');
});

test('/pnl with no calls explains instead of erroring', async () => {
  const store = tmpStore();
  const { ctx, out } = makeCtx({ text: '/pnl' });
  await handlePnl(ctx, { store, scan: scanOk });
  assert.match(out[0].text, /No matching call/);
});

test('/pnl survives a failed refresh and still shows stored values', async () => {
  const store = tmpStore();
  await recordCall({ store, scanResult: okScan(), caller: { id: 1, displayName: 'F', username: 'foxy' }, chatId: CHAT });
  const { ctx, out } = makeCtx({ text: '/pnl' });
  await handlePnl(ctx, { store, scan: async () => ({ status: 'api-error' }) });
  const msg = out.find((o) => o.text && /PnL/.test(o.text));
  assert.ok(msg);
  assert.match(msg.text, /\$5\.00M/, 'entry preserved from storage');
});

test('/pnl accepts a 1-based index into /calls', async () => {
  const store = tmpStore();
  await recordCall({ store, scanResult: okScan(), caller: { id: 1, displayName: 'F', username: 'foxy' }, chatId: CHAT, now: 1000 });
  const { ctx, out } = makeCtx({ text: '/pnl 1' });
  await handlePnl(ctx, { store, scan: scanOk });
  assert.ok(out.some((o) => o.text && /Cake/.test(o.text)));
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
