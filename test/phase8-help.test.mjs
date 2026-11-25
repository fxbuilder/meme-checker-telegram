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

import { renderStart } from '../src/start-message.mjs';
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

test('the chain list leads with the seven priority networks and never states a count', () => {
  const { text } = renderHelp();
  // Every priority network must be named.
  for (const name of ['Solana', 'BNB Chain', 'Ethereum', 'Base', 'Robinhood Chain', 'HyperEVM', 'Elysium']) {
    assert.ok(text.includes(name), `${name} must be listed`);
  }
  // OWNER forbade a headline chain count, so no "15 chains" / "Supported chains (N)" claim.
  assert.doesNotMatch(text, /\b15 chains\b/i, 'must not advertise 15 chains');
  assert.doesNotMatch(text, /supported chains \\(\d+\\)/i, 'must not state a chain count');
  // Non-priority networks are demoted, not headlined.
  assert.match(text, /reduced data|additional/i, 'non-priority networks are described as reduced');
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
  assert.match(text, /only those (chains|choices)/i);
  assert.match(text, /\/ca &lt;chain&gt; &lt;address&gt;/i, 'the explicit override is documented');
  assert.doesNotMatch(text, /\/check/i, '/check is no longer a public command');
  assert.match(text, /Solana.{0,80}(detected|no chain needed|directly)/i);
});

test('the help does not promise a picker for every EVM address', () => {
  const { text } = renderHelp();
  // The old wording: "A 0x address can exist on several networks, so you will be asked
  // to pick one." Resolution now prevents that in the common case.
  assert.doesNotMatch(text, /you will be asked to pick one/i);
});

test('free vs premium is stated, including that scans make no paid X request', () => {
  const { text } = renderHelp();
  // The redesigned /help is compact, so the promise is made where it is actionable: a scan
  // never spends money, and deeper X work belongs to the website.
  assert.match(text, /unmeasured|dash means/i, 'the unknown-vs-safe promise is stated');
  const { text: startText } = renderStart({ websiteUrl: null, premiumUrl: null });
  assert.match(startText, /Deeper analysis/i, 'the deeper-analysis tier is described');
  // Neither surface may imply a per-scan paid X call.
  assert.doesNotMatch(text, /paid X request per scan/i);
});

test('every required section is present', () => {
  const { text } = renderHelp();
  for (const needed of ['Token Scan', 'Call Tracking', 'Narrative', 'Security', 'Community', 'Settings']) {
    assert.ok(text.includes(needed), `missing section: ${needed}`);
  }
});

test('help is English and carries no raw HTML', () => {
  const { text } = renderHelp();
  // Only the tags Telegram accepts.
  // With custom emoji DISABLED (the default), only the plain Telegram tags may appear. This is
  // the state an ordinary bot runs in, and it is what makes the output safe to send.
  const tags = text.match(/<\/?([a-z-]+)[^>]*>/g) ?? [];
  for (const t of tags) {
    assert.match(t, /^<\/?(b|i|code|a)(\s[^>]*)?>$/i, `unexpected tag: ${t}`);
    assert.doesNotMatch(t, /^<tg-emoji/i, 'custom emoji must be opt-in only');
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
