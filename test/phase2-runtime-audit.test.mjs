import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { Telegram } from 'telegraf';

const dir = fs.mkdtempSync(path.join(process.env.TMPDIR ?? os.tmpdir(), 'mc-runtime-'));
process.env.BOT_NO_LAUNCH = '1';
process.env.TELEGRAM_BOT_TOKEN = 'test';
process.env.OWNER_USER_IDS = '1307106746';
process.env.ALLOWED_CHAT_IDS = '-5333984336';
process.env.CALLS_DB_PATH = path.join(dir, 'calls.json');
process.env.CALLER_LINK_SECRET = 'local-runtime-audit-only';
process.env.SCAN_MODE = 'mock';
const { bot, callStore } = await import('../src/bot.mjs');
const { recordCall } = await import('../src/call-service.mjs');
const { mintCallerToken, resolveCallerToken } = await import('../src/deep-link.mjs');
const { formatCard } = await import('../src/format-card.mjs');
const { installTelegramStub, textUpdate, callbackUpdate } = await import('./helpers/telegram-stub.mjs');
const GROUP = '-5333984336';
const OWNER = 1307106746;
const scanFor = (i) => ({
  mode: 'live', status: 'ok',
  token: { chain: 'bsc', address: i === 1 ? '0xabcdef0123456789abcdef0123456789abcdef01' : `0x${i.toString(16).padStart(40, '0')}`, name: `Audit ${i}`, symbol: `AUDIT_${String(i).padStart(2, '0')}` },
  market: { marketCapUsd: 100_000, priceUsd: 1, liquidityUsd: 50_000 },
  media: {}, project: {},
});
let stub;
let records = [];
test.before(async () => {
  for (let i = 1; i <= 12; i++) {
    const result = await recordCall({
      store: callStore, scanResult: scanFor(i), chatId: GROUP, source: 'manual',
      caller: { id: OWNER, displayName: 'Runtime Caller', username: 'runtime_caller' },
      now: Date.now() - (i === 12 ? 2 * 86400_000 : i * 3600_000),
    });
    assert.equal(result.status, 'recorded');
    assert.equal(result.call.source, 'manual');
    records.push(result.call);
  }
  await callStore.setGroupSetting(GROUP, { title: 'Runtime Audit Group' });
});
test.beforeEach(() => { stub = installTelegramStub(); });
test.afterEach(() => { stub.restore(); });
test.after(() => { fs.rmSync(dir, { recursive: true, force: true }); });
const texts = () => stub.sent.filter((s) => /^(sendMessage|editMessageText)$/.test(s.method)).map((s) => s.payload.text);
const dmCallback = (data) => {
  const update = callbackUpdate(data, { chatId: OWNER });
  update.callback_query.message.chat = { id: OWNER, type: 'private' };
  return update;
};

test('real /start and profile callbacks keep group scope, switch period and really advance page', async () => {
  assert.equal(callStore.callsForChat(OWNER).length, 0);
  const token = mintCallerToken(GROUP, `u:${OWNER}`, '7d');
  await bot.handleUpdate(textUpdate(`/start ${token}`, { chatId: OWNER, chatType: 'private' }));
  assert.match(texts().at(-1), /Calls: <b>12<\/b>/);
  stub.sent.length = 0;
  await bot.handleUpdate(dmCallback(`cp:${token}:1d`));
  const oneDay = texts().at(-1);
  assert.match(oneDay, /Period: <b>1D<\/b>/);
  assert.match(oneDay, /Calls: <b>11<\/b>/);
  assert.match(oneDay, /Runtime Audit Group/);
  const keyboard = stub.sent.find((s) => s.method === 'editMessageText').payload.reply_markup.inline_keyboard;
  const switchedToken = keyboard.flat()[0].callback_data.split(':')[1];
  assert.deepEqual(resolveCallerToken(switchedToken, GROUP, [{ callerKey: `u:${OWNER}` }]), { callerKey: `u:${OWNER}`, period: '1d' });
  assert.equal(resolveCallerToken(switchedToken, OWNER, [{ callerKey: `u:${OWNER}` }]), null);
  stub.sent.length = 0;
  await bot.handleUpdate(dmCallback(`cg:${token}:7d:1`));
  const pageTwo = texts().at(-1);
  assert.match(pageTwo, /Period: <b>1W<\/b>/);
  assert.match(pageTwo, /\$AUDIT_11/);
  assert.match(pageTwo, /\$AUDIT_12/);
  assert.doesNotMatch(pageTwo, /\$AUDIT_01/);
  assert.equal(stub.sent.filter((s) => s.method === 'answerCallbackQuery').length, 1);
  console.log('PROFILE', JSON.stringify({ oneDay: oneDay.match(/Period:.*\nCalls:.*/)[0], pageTwoRows: pageTwo.split('\n').filter((line) => line.includes('AUDIT_')), groupScope: true }));
});

test('real /pnl renders an actual PNG and sends image only', async () => {
  const previous = Telegram.prototype.callApi;
  let png;
  let output;
  Telegram.prototype.callApi = async function (method, payload) {
    if (method === 'sendPhoto') {
      output = payload.photo.source;
      png = fs.readFileSync(output);
      // Preserve evidence outside the auto-cleaned render path.
      fs.writeFileSync(path.join(process.env.TMPDIR ?? os.tmpdir(), 'mc-phase2-audit.png'), png);
    }
    return previous.call(this, method, payload);
  };
  try {
    await bot.handleUpdate(textUpdate(`/pnl bsc ${records[0].address}`));
  } finally { Telegram.prototype.callApi = previous; }
  const photos = stub.sent.filter((s) => s.method === 'sendPhoto');
  assert.equal(photos.length, 1, texts().join(' | '));
  assert.equal(texts().length, 0, 'no text follow-up');
  assert.equal(Object.hasOwn(photos[0].payload, 'caption'), false);
  assert.equal(Object.hasOwn(photos[0].payload, 'reply_markup'), false);
  assert.equal(png.subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
  assert.equal(fs.existsSync(output), false, 'temporary PNG cleaned after send');
  console.log('PNL', JSON.stringify({ bytes: png.length, width: png.readUInt32BE(16), height: png.readUInt32BE(20), keys: Object.keys(photos[0].payload), cleaned: true }));
  const { renderPnlPng, cleanupPng } = await import('../src/pnl-render.mjs');
  const expectedPath = await renderPnlPng(callStore.doc.calls.find((c) => c.id === records[0].id), { groupTitle: 'Runtime Audit Group' });
  try {
    assert.ok(png.equals(fs.readFileSync(expectedPath)), 'command must pass the group title to the real renderer, just like the PnL callback');
  } finally { cleanupPng(expectedPath); }
});

for (const failure of ['missing interpreter', 'missing Pillow']) {
  test(`/pnl explains ${failure} instead of going silent`, async () => {
    const oldPath = process.env.PATH;
    const oldPython = process.env.PNL_PYTHON;
    let interpreter = path.join(dir, 'does-not-exist.exe');
    if (failure === 'missing Pillow') {
      const result = spawnSync('python', ['-m', 'venv', '--without-pip', path.join(dir, 'no-pillow')], { encoding: 'utf8' });
      assert.equal(result.status, 0, result.stderr);
      interpreter = path.join(dir, 'no-pillow', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');
      const check = spawnSync(interpreter, ['-c', 'import PIL'], { encoding: 'utf8' });
      assert.notEqual(check.status, 0);
      assert.match(check.stderr, /No module named 'PIL'/);
      console.log('PILLOW_ABSENT', check.stderr.trim().split('\n').at(-1));
    }
    try {
      process.env.PNL_PYTHON = interpreter;
      process.env.PATH = dir; // no fallback python/python3 available
      await bot.handleUpdate(textUpdate(`/pnl bsc ${records[0].address}`));
    } finally {
      process.env.PATH = oldPath;
      if (oldPython == null) delete process.env.PNL_PYTHON;
      else process.env.PNL_PYTHON = oldPython;
    }
    assert.equal(stub.sent.filter((s) => s.method === 'sendPhoto').length, 0);
    assert.deepEqual(texts(), ['⚠️ Could not generate the PnL image. Please try again shortly.']);
    console.log('PNL_FAILURE', failure, JSON.stringify(texts()));
  });
}

test('default test discovery cannot run the live owner-card sender', () => {
  const guard = path.join(dir, 'no-network.mjs');
  fs.writeFileSync(guard, "globalThis.fetch = () => { throw new Error('QA_NETWORK_FORBIDDEN'); };\n");
  const env = { ...process.env, TELEGRAM_BOT_TOKEN: '' };
  delete env.NODE_TEST_CONTEXT; // the child is an independent runner, not a nested test
  const result = spawnSync(process.execPath, ['--import', pathToFileURL(guard).href, '--test', 'qa/owner-card-test.mjs'], {
    cwd: path.resolve(import.meta.dirname, '..'), encoding: 'utf8',
    env, timeout: 20_000,
  });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.doesNotMatch(result.stdout + result.stderr, /QA_NETWORK_FORBIDDEN|FAIL\(Not Found\)|\bSENT\b/);
});

test('unhandled message paths reach later middleware; access denial intentionally stops', async () => {
  const reached = [];
  bot.use((ctx) => { reached.push(ctx.update.update_id); });
  const updates = [textUpdate('ordinary group chatter'), textUpdate('/unregistered_audit_command')];
  const service = textUpdate('');
  delete service.message.text;
  service.message.new_chat_title = 'renamed group';
  updates.push(service);
  for (const update of updates) await bot.handleUpdate(update);
  assert.deepEqual(reached, updates.map((u) => u.update_id));
  assert.equal(texts().length, 0);
  const denied = textUpdate('ordinary group chatter', { chatId: -100999999, userId: 123456 });
  await bot.handleUpdate(denied);
  assert.equal(reached.includes(denied.update_id), false);
  assert.equal(texts().length, 0);
  console.log('MIDDLEWARE', JSON.stringify({ unhandledReachedNext: reached.length, deniedStopped: true }));
});

test('card First Call text and signed token come from active group record only', async () => {
  const scan = scanFor(1);
  const first = callStore.firstCall(GROUP, 'bsc', scan.token.address);
  const token = mintCallerToken(GROUP, first.callerKey, '7d');
  // The First Call LABEL belongs to the card that records the call.
  const card = formatCard(scan, {
    view: 'standard', firstCall: first, callerToken: token, botUsername: 'RuntimeAuditBot',
    isFirstCallCard: true,
  });
  const line = card.text.split('\n').find((s) => s.includes('First Call'));
  assert.match(line, /First Call.*Runtime Caller.*\$100\.00K/);
  const payload = /start=([^"&]+)/.exec(line)[1];
  assert.ok(resolveCallerToken(payload, GROUP, [{ callerKey: first.callerKey }]));
  assert.equal(resolveCallerToken(payload, OWNER, [{ callerKey: first.callerKey }]), null);
  console.log('FIRST_CALL', line);
  for (const status of ['cancelled', 'superseded']) {
    const row = records[status === 'cancelled' ? 10 : 11];
    await callStore.updateCall(row.id, { status });
    const candidate = callStore.firstCall(GROUP, 'bsc', row.address);
    assert.equal(candidate, null);
    assert.doesNotMatch(formatCard(scan, { view: 'standard', firstCall: candidate }).text, /First Call/);
  }
  assert.doesNotMatch(formatCard(scan, { view: 'standard' }).text, /First Call/);
  // Also drive the registered message middleware, not just formatCard.
  // A later /check of an already-tracked token shows live performance, not the label.
  await bot.handleUpdate(textUpdate(`/check bsc ${records[0].address}`));
  const card2 = texts().join('\n');
  assert.doesNotMatch(card2, /First Call/, 'a repeat scan must not re-announce attribution');
  assert.match(card2, /Runtime Caller/, 'the caller still appears, on the performance line');
});
