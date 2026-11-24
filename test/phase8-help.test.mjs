/**
 * test/phase8-help.test.mjs
 *
 * /help must describe the bot that exists, not the one it used to be.
 *
 * The failure this guards against is documented-drift: the previous help text called
 * Meme Checker a "Solana or BNB Chain" bot after 15 chains shipped, promised a chain
 * picker for every EVM paste after automatic resolution replaced it, and told users to
 * run /help — which was not a registered command at all.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { renderHelp, renderHelpShort, documentedCommands, marketChains, HELP_SECTIONS } from '../src/help.mjs';

const BOT = fs.readFileSync(path.join(process.cwd(), 'src', 'bot.mjs'), 'utf8');

/** Command names actually registered on the bot. */
function registeredCommands() {
  const names = new Set();
  for (const m of BOT.matchAll(/bot\.command\('([^']+)'/g)) names.add(m[1]);
  // bot.help() registers /help implicitly in Telegram's command list.
  if (/bot\.help\(/.test(BOT)) names.add('help');
  // bot.start() registers /start; it is not written as bot.command('start').
  if (/bot\.start\(/.test(BOT)) names.add('start');
  return names;
}

test('every command in the help text is actually registered', () => {
  const registered = registeredCommands();
  const missing = documentedCommands().filter((c) => !registered.has(c));
  assert.deepEqual(missing, [], `help documents commands that do not exist: ${missing.join(', ')}`);
});

test('/help is a registered command, not just an advertisement', () => {
  // It used to be mentioned in /start and in the help body while no handler existed.
  assert.ok(/bot\.command\('help'/.test(BOT), '/help must be registered');
});

test('the chain list comes from the registry and is complete', () => {
  const chains = marketChains();
  assert.ok(chains.length >= 15, 'at least 15 market chains');
  const { text } = renderHelp();
  for (const c of chains) {
    assert.ok(text.includes(c.name), `${c.name} must be listed`);
  }
  // It must state the COUNT, so a reader can see it is not a two-chain bot.
  assert.match(text, new RegExp(`Supported chains \\(${chains.length}\\)`));
});

test('the bot is never described as Solana/BSC only', () => {
  const { text } = renderHelp();
  assert.doesNotMatch(text, /solana or bnb/i);
  assert.doesNotMatch(text, /solana and bnb only/i);
  assert.doesNotMatch(text, /only solana/i);
  // /start must not claim it either.
  assert.doesNotMatch(BOT, /Post any Solana or BNB Chain contract address/);
});

test('automatic EVM chain detection is explained, and so is the override', () => {
  const { text } = renderHelp();
  assert.match(text, /resolved automatically/i);
  assert.match(text, /only those chains|short list/i);
  assert.match(text, /\/check base 0x/i, 'the explicit override is documented');
  assert.match(text, /Solana addresses.*detected directly/i);
});

test('the help does not promise a picker for every EVM address', () => {
  const { text } = renderHelp();
  // The old wording: "A 0x address can exist on several networks, so you will be asked
  // to pick one." Resolution now prevents that in the common case.
  assert.doesNotMatch(text, /you will be asked to pick one/i);
});

test('free vs premium is stated, including that scans make no paid X request', () => {
  const { text } = renderHelp();
  assert.match(text, /Free in Telegram/i);
  assert.match(text, /Premium preview/i);
  assert.match(text, /never make a paid X request/i);
});

test('every required section is present', () => {
  const { text } = renderHelp();
  for (const needed of ['Token Scanner', 'Call Tracking', 'Narrative & Intelligence', 'Security', 'Community & Leaderboard', 'Settings', 'General']) {
    assert.ok(text.includes(needed), `missing section: ${needed}`);
  }
});

test('help is English and carries no raw HTML', () => {
  const { text } = renderHelp();
  // Only the tags Telegram accepts.
  const tags = text.match(/<\/?([a-z]+)[^>]*>/g) ?? [];
  for (const t of tags) {
    assert.match(t, /^<\/?(b|i|code|a)(\s[^>]*)?>$/i, `unexpected tag: ${t}`);
  }
});

test('links are only rendered when configured, never invented', () => {
  const bare = renderHelp();
  assert.equal(bare.links.length, 0, 'no destination configured means no link');
  assert.doesNotMatch(bare.text, /https?:\/\//, 'no URL is fabricated into the body');

  const withSite = renderHelp({ websiteBase: 'https://example.test', premiumUrl: 'https://premium.test' });
  assert.equal(withSite.links.length, 2);
});

test('commands are escaped so a < in usage cannot break the parse', () => {
  const { text } = renderHelp();
  // Generic usage placeholders are escaped entities.
  assert.match(text, /&lt;address&gt;/);
  assert.doesNotMatch(text, /<address>/);
});

test('the short version names only real commands', () => {
  const registered = registeredCommands();
  for (const m of renderHelpShort().matchAll(/<code>\/([a-z]+)/g)) {
    assert.ok(registered.has(m[1]), `short help references unregistered /${m[1]}`);
  }
});

test('no section is empty and no usage is blank', () => {
  for (const s of HELP_SECTIONS) {
    assert.ok(s.commands.length > 0, `${s.title} has no commands`);
    for (const c of s.commands) {
      assert.ok(String(c.usage ?? '').trim().length > 0, `blank usage in ${s.title}`);
    }
  }
});
