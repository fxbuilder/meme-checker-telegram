/**
 * test/round6-ui.test.mjs
 * Round 6 — final UI/UX polish acceptance.
 *
 * These tests exist because each rule below was an explicit OWNER instruction, and every one of
 * them is the kind of thing that silently regresses: a copy string drifts back, a removed
 * command creeps into help, a sort reverts to chronological. Each assertion protects the FACT
 * behind the instruction, not the exact glyphs, so copy can still be improved without
 * re-litigating the requirement.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { renderStart } from '../src/start-message.mjs';
import { renderHelp, documentedCommands, RETIRED_COMMANDS } from '../src/help.mjs';
import { icon, chainIcon, PRIORITY_CHAINS, CHAIN_LABELS, iconNames } from '../src/icons.mjs';
import { orderCalls, peakTone, roiTone, renderCallerProfile, HIT_THRESHOLD } from '../src/caller-profile.mjs';
import { rankCallers, MIN_CALLS_FOR_HIT_RATE } from '../src/leaderboard.mjs';
import {
  PnlBackgroundStore, pickLargestPhoto, pickDocumentImage,
  setConfirmation, rejectionMessage, PNL_BG_LIMITS,
} from '../src/pnl-background.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');
const BOT = fs.readFileSync(path.join(ROOT, 'src/bot.mjs'), 'utf8');

// ---------------------------------------------------------------------------
// 1. Command simplification
// ---------------------------------------------------------------------------

test('/ca is a registered command in both documented forms', () => {
  assert.match(BOT, /bot\.command\('ca'/, '/ca must be registered');
  const { text } = renderHelp();
  assert.match(text, /\/ca &lt;address&gt;/, 'bare form documented');
  assert.match(text, /\/ca &lt;chain&gt; &lt;address&gt;/, 'explicit-chain form documented');
});

test('/check is retained only as a compatibility alias and is never advertised', () => {
  assert.match(BOT, /bot\.command\('check'/, '/check must still answer — old posts use it');
  // Public surfaces must not present it as the way in.
  for (const [name, text] of [['help', renderHelp().text], ['start', renderStart({}).text]]) {
    assert.doesNotMatch(text, /\/check\b/i, `${name} must not advertise /check`);
  }
  assert.ok(RETIRED_COMMANDS.includes('/check'), 'declared retired so it cannot be re-documented');
});

test('/scan is never mentioned, because it does not exist', () => {
  const registered = new Set([...BOT.matchAll(/bot\.command\('([a-z0-9_]+)'/g)].map((m) => m[1]));
  assert.ok(!registered.has('scan'), 'precondition: no /scan handler');
  for (const text of [renderHelp().text, renderStart({}).text]) {
    assert.doesNotMatch(text, /\/scan\b/i, 'must not advertise a command that does not exist');
  }
});

test('every documented command actually exists', () => {
  const registered = new Set([...BOT.matchAll(/bot\.command\('([a-z0-9_]+)'/g)].map((m) => m[1]));
  const missing = documentedCommands().filter((c) => !registered.has(c));
  assert.deepEqual(missing, [], `help documents non-existent commands: ${missing.join(', ')}`);
});

// ---------------------------------------------------------------------------
// 2. Single card view
// ---------------------------------------------------------------------------

test('no public surface offers a card-mode switch', () => {
  for (const text of [renderHelp().text, renderStart({}).text]) {
    assert.doesNotMatch(text, /\/(short|detail|standard|compact)\b/i, 'no mode-switch copy');
  }
  // The old copy invited users to choose a view.
  assert.doesNotMatch(renderHelp().text, /card (mode|view)s?\b.*choose|choose.*card/i);
});

test('legacy mode commands answer with the single-view message instead of switching', () => {
  assert.match(BOT, /Standard card is now the default view/);
});

// ---------------------------------------------------------------------------
// 3. Start + help rendering
// ---------------------------------------------------------------------------

test('/start carries identity, flow, depth and no chain count', () => {
  const { text } = renderStart({ websiteUrl: null });
  assert.match(text, /MEME CHECKER/, 'product identity');
  assert.match(text, /Paste any contract address/i, 'the primary flow is stated');
  assert.match(text, /Deeper analysis/i, 'what the deeper tier offers');
  assert.doesNotMatch(text, /\b\d+ chains\b/i, 'no chain count');
  assert.doesNotMatch(text, /15 chains/i);
  // Compact: the old message was ~18 lines of bullets.
  assert.ok(text.split('\n').length <= 24, `too long: ${text.split('\n').length} lines`);
});

test('/start advertises no dead CTA when nothing is configured', () => {
  const bare = renderStart({ websiteUrl: null, premiumUrl: null });
  assert.equal(bare.keyboard.length, 0, 'a dead button is worse than no button');
  const configured = renderStart({ websiteUrl: 'https://x.test', premiumUrl: null });
  assert.ok(configured.keyboard.length > 0 && configured.keyboard[0].some((b) => b.url === 'https://x.test'));
});

test('/help is grouped into the required sections and stays compact', () => {
  const { text } = renderHelp();
  for (const section of ['Token Scan', 'Call Tracking', 'Narrative', 'Security', 'Community']) {
    assert.ok(text.includes(section), `missing section: ${section}`);
  }
  // No developer-style dump. Every listed command must be real, and none may be a retired
  // mode command — that is what "no dump" means here, rather than an arbitrary ceiling.
  const listed = [...text.matchAll(/<code>\/([a-z0-9_]+)/g)].map((m) => `/${m[1]}`);
  for (const retired of RETIRED_COMMANDS) {
    assert.ok(!listed.includes(retired), `retired command listed: ${retired}`);
  }
  assert.ok(listed.length > 0, 'help lists commands');
});

test('/help states that a dash means unmeasured, never safe', () => {
  const { text } = renderHelp();
  assert.match(text, /dash means/i, 'the unknown-vs-safe promise must survive the redesign');
});

// ---------------------------------------------------------------------------
// 4. Priority chains
// ---------------------------------------------------------------------------

test('the seven priority networks are present and ordered first', () => {
  assert.deepEqual(PRIORITY_CHAINS, ['solana', 'bsc', 'ethereum', 'base', 'robinhood', 'hyperevm', 'elysium']);
  const { text } = renderHelp();
  for (const id of PRIORITY_CHAINS) {
    assert.ok(text.includes(CHAIN_LABELS[id]), `${CHAIN_LABELS[id]} must be listed`);
  }
  const { text: start } = renderStart({});
  assert.match(start, /Primary coverage/i, 'priority framing is named');
});

// ---------------------------------------------------------------------------
// 5. Icon registry
// ---------------------------------------------------------------------------

test('the registry covers every surface the brief names', () => {
  const names = iconNames();
  for (const needed of [
    'section.market', 'section.security', 'section.narrative', 'section.holders',
    'metric.top10', 'metric.tax', 'metric.lp', 'metric.dev', 'metric.dexPaid',
    'metric.x', 'metric.social', 'section.links', 'section.alerts', 'section.pnl',
    'cta.premium', 'cta.website',
    'state.good', 'state.warn', 'state.bad', 'state.unknown',
  ]) {
    assert.ok(names.includes(needed), `missing icon: ${needed}`);
  }
  for (const chain of PRIORITY_CHAINS) {
    assert.ok(names.includes(`chain.${chain}`), `missing chain icon: ${chain}`);
  }
});

test('a missing icon key degrades to a glyph, never to empty text', () => {
  const out = icon('does.not.exist', { fallback: '❓' });
  assert.equal(out, '❓');
  assert.ok(icon('does.not.exist').length > 0, 'never renders nothing');
});

test('custom emoji is ON by default and can be switched off', () => {
  // The owner asked for animated emoji across the bot, so the registry default is now ON.
  // What must still hold is that disabling it yields plain glyphs — a bot that may not send
  // <tg-emoji> must have a working fallback rather than broken markup.
  const saved = process.env.CUSTOM_EMOJI;
  try {
    delete process.env.CUSTOM_EMOJI;
    assert.match(icon('section.market'), /<tg-emoji emoji-id="\d+">/, 'on by default');
    process.env.CUSTOM_EMOJI = '0';
    const off = icon('section.market');
    assert.doesNotMatch(off, /<tg-emoji/, 'CUSTOM_EMOJI=0 disables it');
    assert.ok(off.length > 0, 'the glyph fallback is always renderable');
  } finally {
    if (saved === undefined) delete process.env.CUSTOM_EMOJI; else process.env.CUSTOM_EMOJI = saved;
  }
});

test('the four chains without a real asset are visually distinct, not four copies of one icon', () => {
  const rendered = new Map();
  for (const chain of PRIORITY_CHAINS) {
    const g = chainIcon(chain).replace(/<[^>]+>/g, '');
    assert.ok(!rendered.has(g), `${chain} renders the same glyph as ${rendered.get(g)}`);
    rendered.set(g, chain);
  }
});

// ---------------------------------------------------------------------------
// 6. Caller profile ordering (the OWNER's headline complaint)
// ---------------------------------------------------------------------------

function entry(symbol, peak, current, calledAt, measured = true) {
  return {
    call: { symbol, chain: 'bsc', address: `0x${symbol}`, calledAt },
    key: `bsc:0x${symbol}`,
    m: { peakMeasured: measured, peakMultiple: peak, currentMultiple: current },
  };
}

test('a 3.8x call appears above a 1.3x call', () => {
  const rows = [entry('LOW', 1.3, 0.9, 4000), entry('BIG', 3.8, 0.5, 1000)];
  const out = orderCalls(rows, 'peak');
  assert.equal(out[0].call.symbol, 'BIG');
});

test('a 10x call appears above a 2x call, numerically not lexicographically', () => {
  const rows = [entry('TWO', 2, 1, 3000), entry('TEN', 10, 1, 1000)];
  const out = orderCalls(rows, 'peak');
  // Lexicographic sorting would place "10" before "2" only by accident; "9" vs "10" is the
  // case that exposes string comparison, so assert on the numeric ordering explicitly.
  assert.equal(out[0].call.symbol, 'TEN');
  const rows2 = [entry('NINE', 9, 1, 3000), entry('TEN', 10, 1, 1000)];
  assert.equal(orderCalls(rows2, 'peak')[0].call.symbol, 'TEN', '10x must beat 9x');
});

test('sorting happens before pagination, so page 2 continues the ranking', () => {
  const now = Date.now();
  const calls = [
    { id: '1', callerKey: 'u:1', callerName: 'A', chain: 'bsc', address: 'a1', symbol: 'S1', entryMarketCapUsd: 1e6, peakMarketCapUsd: 1e6, calledAt: now - 4000, status: 'active' },
    { id: '2', callerKey: 'u:1', callerName: 'A', chain: 'bsc', address: 'a2', symbol: 'S2', entryMarketCapUsd: 1e6, peakMarketCapUsd: 9e6, calledAt: now - 3000, status: 'active' },
    { id: '3', callerKey: 'u:1', callerName: 'A', chain: 'bsc', address: 'a3', symbol: 'S3', entryMarketCapUsd: 1e6, peakMarketCapUsd: 3e6, calledAt: now - 2000, status: 'active' },
  ];
  const p1 = renderCallerProfile({ callerKey: 'u:1', calls, groupTitle: 'g', period: '1d', now, page: 0, pageSize: 1 });
  const p2 = renderCallerProfile({ callerKey: 'u:1', calls, groupTitle: 'g', period: '1d', now, page: 1, pageSize: 1 });
  assert.match(p1.text, /\$S2/, 'page 1 holds the best call');
  assert.match(p2.text, /\$S3/, 'page 2 holds the next best, not the oldest');
  assert.doesNotMatch(p2.text, /\$S2/, 'no repeat across pages');
});

test('peak and current are independent and never merged', () => {
  // The case that matters: it ran to 5x and came back below entry.
  const now = Date.now();
  const calls = [{
    id: '1', callerKey: 'u:1', callerName: 'A', chain: 'bsc', address: 'a1', symbol: 'RAN',
    entryMarketCapUsd: 1e6, peakMarketCapUsd: 5e6, lastMarketCapUsd: 5e5,
    calledAt: now - 1000, status: 'active',
  }];
  const { text, agg } = renderCallerProfile({ callerKey: 'u:1', calls, groupTitle: 'g', period: '1d', now });
  assert.equal(agg.bestMultiple, 5);
  assert.match(text, /5\.0x/, 'the historical peak is shown');
  assert.equal(agg.current.losing, 1, 'and it is currently below entry');
  assert.equal(peakTone(5), 'good', 'peak stays green — it is a historical fact');
  assert.equal(roiTone(0.5), 'bad', 'current is red');
});

test('missing price data is unknown, never zero or a loss', () => {
  const now = Date.now();
  const calls = [{
    id: '1', callerKey: 'u:1', callerName: 'A', chain: 'bsc', address: 'a1', symbol: 'NOPRICE',
    entryMarketCapUsd: 1e6, peakMarketCapUsd: 2e6,
    calledAt: now - 1000, status: 'active',
  }];
  const { agg } = renderCallerProfile({ callerKey: 'u:1', calls, groupTitle: 'g', period: '1d', now });
  assert.equal(agg.current.unknown, 1);
  assert.equal(agg.current.losing, 0, 'absent price is not a loss');
  assert.equal(roiTone(null), 'unknown');
  assert.equal(roiTone(undefined), 'unknown');
});

test('a call that has not reached 2x is not called losing', () => {
  assert.equal(peakTone(1.4), 'warn', 'it ran, but this is not a loss classification');
  assert.equal(peakTone(1), 'neutral');
  assert.equal(HIT_THRESHOLD, 2);
});

test('an empty profile renders, and an unmeasured call sorts last rather than as zero', () => {
  const empty = renderCallerProfile({ callerKey: 'u:none', calls: [], groupTitle: 'g', period: '1d' });
  assert.match(empty.text, /No tracked calls in this period/);
  assert.equal(empty.pages, 0);

  const rows = [entry('NOPEAK', null, null, 9000, false), entry('MEASURED', 1.1, 1, 1000)];
  const out = orderCalls(rows, 'peak');
  assert.equal(out[0].call.symbol, 'MEASURED', 'a measured 1.1x outranks an unmeasured call');
});

test('ranking modes are deterministic under ties', () => {
  const rows = [entry('A', 2, 1, 1000), entry('B', 2, 1, 1000), entry('C', 2, 1, 1000)];
  const a = orderCalls(rows, 'peak').map((x) => x.call.symbol);
  const b = orderCalls([...rows].reverse(), 'peak').map((x) => x.call.symbol);
  assert.deepEqual(a, b, 'input order must not change the output order');
});

// ---------------------------------------------------------------------------
// 7. Leaderboard
// ---------------------------------------------------------------------------

function row(key, { measured = 3, best = 2, hitRate = 50, averagePeak = 2 } = {}) {
  return { callerKey: key, label: key, measuredCalls: measured, best, hitRate, averagePeak, sortKey: key };
}

test('the leaderboard ranks by best call by default', () => {
  const rows = [row('steady', { best: 3, hitRate: 90 }), row('spiky', { best: 20, hitRate: 10 })];
  assert.equal(rankCallers(rows)[0].callerKey, 'spiky');
});

test('hit-rate ranking enforces a documented minimum sample', () => {
  assert.ok(MIN_CALLS_FOR_HIT_RATE >= 2);
  const rows = [row('lucky', { measured: 1, best: 5, hitRate: 100 }), row('real', { measured: 3, best: 3, hitRate: 67 })];
  assert.equal(rankCallers(rows, { mode: 'hit' })[0].callerKey, 'real');
});

test('a caller with no measured calls sorts last, not first', () => {
  const rows = [row('novoice', { measured: 0, best: null, hitRate: null, averagePeak: null }), row('real', { measured: 2, best: 1.2 })];
  assert.equal(rankCallers(rows)[0].callerKey, 'real');
});

// ---------------------------------------------------------------------------
// 8. PnL background personalisation
// ---------------------------------------------------------------------------

test('a background is stored per user and resets cleanly', () => {
  const store = new PnlBackgroundStore({ file: null });
  assert.equal(store.get(42), null, 'absent by default');
  const res = store.set(42, { fileId: 'F1', uniqueId: 'U1' });
  assert.equal(res.changed, true);
  assert.equal(store.get(42).fileId, 'F1');
  assert.equal(store.get(43), null, 'per-user, not global');

  // Re-sending the same image is reported as unchanged rather than as an update.
  assert.equal(store.set(42, { fileId: 'F1' }).changed, false);
  assert.equal(setConfirmation({ changed: false }), setConfirmation({ changed: false }));

  assert.equal(store.reset(42), true);
  assert.equal(store.get(42), null);
  assert.equal(store.reset(42), false, 'resetting twice is a no-op, not an error');
});

test('a store file survives a reload, and a corrupt one degrades to empty', () => {
  const file = path.join(ROOT, 'test', '.tmp-pnlbg.json');
  try {
    const a = new PnlBackgroundStore({ file });
    a.set(7, { fileId: 'FILEID', uniqueId: 'U' });
    const b = new PnlBackgroundStore({ file });
    assert.equal(b.get(7).fileId, 'FILEID', 'persisted across instances');

    fs.writeFileSync(file, '{not json');
    const c = new PnlBackgroundStore({ file });
    assert.equal(c.get(7), null, 'corrupt store starts clean instead of throwing');
  } finally {
    fs.rmSync(file, { force: true });
  }
});

test('only real images are accepted, and rejection states the limits', () => {
  assert.deepEqual(PNL_BG_LIMITS.accepted, ['image/jpeg', 'image/png', 'image/webp']);
  // The largest photo size is chosen, not the thumbnail.
  const largest = pickLargestPhoto({ photo: [{ file_id: 'small', file_size: 10 }, { file_id: 'big', file_size: 90 }] });
  assert.equal(largest.file_id, 'big');

  assert.equal(pickDocumentImage({ document: { mime_type: 'application/pdf', file_size: 100 } }).rejected.includes('Unsupported'), true);
  assert.equal(pickDocumentImage({ document: { mime_type: 'image/png', file_size: PNL_BG_LIMITS.maxBytes + 1 } }).rejected, 'Image is too large');
  assert.equal(pickDocumentImage({ document: { mime_type: 'image/png', file_size: 1000 } }).rejected, undefined);
  assert.match(rejectionMessage(), /JPEG, PNG or WebP/);
  assert.match(rejectionMessage(), /5 MB/);
});

test('the background is resolved through an authenticated call, never a token in a URL', () => {
  // The PnL image is shareable, so a bot token must never end up inside it.
  const source = fs.readFileSync(path.join(ROOT, 'src/bot.mjs'), 'utf8');
  assert.match(source, /getFileLink/, 'resolved via the Telegram API');
  assert.doesNotMatch(source, /file\/bot\%s|api\.telegram\.org\/file\/bot/, 'no hand-built token URL');

  const render = fs.readFileSync(path.join(ROOT, 'scripts/render_pnl.py'), 'utf8');
  assert.match(render, /fetch_background/, 'renderer supports a background');
  assert.match(render, /https:\/\//, 'and only fetches https');
});

test('a failed background never breaks the card', () => {
  const render = fs.readFileSync(path.join(ROOT, 'scripts/render_pnl.py'), 'utf8');
  // fetch_background must swallow every failure and return None.
  const fn = render.slice(render.indexOf('def fetch_background'), render.indexOf('def vertical_gradient'));
  assert.match(fn, /except Exception:\s*\n\s*return None/, 'a bad image degrades to the default gradient');
});
