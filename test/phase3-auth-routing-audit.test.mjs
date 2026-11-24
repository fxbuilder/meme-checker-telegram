/** Real Telegraf routing + fail-closed authorization; no external I/O. */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadPolicy } from '../src/access.mjs';
import { handleAlerts, handleAlertsCallback } from '../src/alert-commands.mjs';
import { handleAlertTest, TEST_TARGETS } from '../src/alert-test.mjs';
import { installTelegramStub, textUpdate, callbackUpdate } from './helpers/telegram-stub.mjs';

process.env.BOT_NO_LAUNCH = '1';
process.env.SCAN_MODE = 'mock';
process.env.TELEGRAM_BOT_TOKEN = 'audit-stub-only';
process.env.OWNER_USER_IDS = '1307106746';
process.env.ALLOWED_CHAT_IDS = '-5333984336';
process.env.CALLS_DB_PATH = path.join(fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'mc-auth-audit-')), 'calls.json');
const { bot, callStore } = await import('../src/bot.mjs');
const OWNER = 1307106746;
const GROUP = -5333984336;
const CA = `0x${'a'.repeat(40)}`;
let stub;
let originalFetch;
test.before(async () => {
  stub = installTelegramStub();
  originalFetch = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error('AUDIT: external fetch forbidden'); };
  callStore.groupSettings(GROUP);
  await callStore.persist();
});
test.after(() => { stub.restore(); globalThis.fetch = originalFetch; });
const messages = () => stub.sent.filter((x) => /sendMessage|editMessageText/.test(x.method)).map((x) => String(x.payload.text ?? ''));

test('audit: non-owner cannot read /alerts or mutate al:* through real middleware', async () => {
  const before = JSON.stringify(callStore.doc);
  stub.sent.length = 0;
  await bot.handleUpdate(textUpdate('/alerts', { userId: 999 }));
  const text = messages().join(' | ');
  console.log(`AUDIT non-owner /alerts: ${text}`);
  assert.match(text, /owner.only|only the bot owner/i);
  assert.doesNotMatch(text, /Multiplier alerts:/, 'settings panel itself is owner-only');
  for (const data of ['al:dexPaid', 'al:m:2', 'al:priceMovement', 'al:milestones', 'al:back']) {
    await bot.handleUpdate(callbackUpdate(data, { userId: 999 }));
  }
  assert.equal(JSON.stringify(callStore.doc), before);
  assert.ok(stub.sent.filter((x) => x.method === 'answerCallbackQuery').every((x) => /owner/i.test(x.payload.text)));
});

test('audit: malformed and empty owner policies deny panel, callbacks and test delivery', async () => {
  for (const policy of [
    loadPolicy({ OWNER_USER_IDS: '' }), loadPolicy({ OWNER_USER_IDS: 'garbage , NaN' }),
    {}, null, { ownerIds: [] }, { ownerIds: '1307106746' },
  ]) {
    const replies = [];
    let touched = 0;
    const ctx = {
      from: { id: OWNER }, chat: { id: GROUP, type: 'group' },
      message: { text: '/alerttest 2x' }, callbackQuery: { data: 'al:dexPaid' },
      reply: async (text) => { replies.push(text); },
      answerCbQuery: async (text) => { replies.push(text); },
      telegram: { sendMessage: async () => { touched += 1; } },
    };
    const store = new Proxy({}, { get() { touched += 1; throw new Error('authorization must precede store access'); } });
    await handleAlerts(ctx, { policy, store });
    await handleAlertsCallback(ctx, { policy, store });
    await handleAlertTest(ctx, { policy, store });
    assert.equal(touched, 0);
    assert.equal(replies.length, 3);
  }
});

test('audit: all six late commands reach their real handlers', async () => {
  for (const [text, expected] of [
    ['/alerttest 2x', /TEST \/ SIMULATED/], ['/alerts', /Multiplier alerts:/],
    [`/pnl ${CA}`, /No recorded call for this token/], ['/call', /Usage:/],
    ['/calls', /No calls|No recorded|CALLS/i], [`/fc ${CA}`, /No recorded|No call/i],
  ]) {
    stub.sent.length = 0;
    await bot.handleUpdate(textUpdate(text));
    const response = messages().join(' | ');
    console.log(`AUDIT route ${text.split(' ')[0]}: ${response.split('\n')[0]}`);
    assert.match(response, expected, text);
    assert.doesNotMatch(response, /unexpected error|Which chain/i, text);
  }
});

test('audit: every alerttest target is isolated from store bytes, stats and claims', async () => {
  const beforeBytes = fs.readFileSync(callStore.filePath, 'utf8');
  const beforeDoc = JSON.stringify(callStore.doc);
  const beforeStats = JSON.stringify(callStore.stats());
  stub.sent.length = 0;
  for (const target of TEST_TARGETS) await bot.handleUpdate(textUpdate(`/alerttest ${target}`));
  assert.equal(messages().length, TEST_TARGETS.length);
  assert.ok(messages().every((x) => x.includes('TEST / SIMULATED')));
  assert.equal(JSON.stringify(callStore.doc), beforeDoc);
  assert.equal(JSON.stringify(callStore.stats()), beforeStats);
  assert.equal(fs.readFileSync(callStore.filePath, 'utf8'), beforeBytes);
  console.log(`AUDIT alerttest: targets=${TEST_TARGETS.length}, file/doc/stats byte-identical`);
  stub.sent.length = 0;
  await bot.handleUpdate(textUpdate('/alerttest 2x', { userId: 999 }));
  assert.match(messages().join(' | '), /owner-only/i);
  assert.ok(!messages().some((x) => x.includes('TEST / SIMULATED')));
  assert.equal(JSON.stringify(callStore.doc), beforeDoc);
});
