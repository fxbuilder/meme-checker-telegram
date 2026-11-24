/**
 * test/phase4-narrative-links.test.mjs
 *
 * Link rendering in /narrative. These values come from third-party metadata, so a
 * link is a security boundary, not just formatting.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { renderNarrative } from '../src/research/research-commands.mjs';

const BONK = 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263';

const render = (links, summaryClass = 'project-claim') => renderNarrative({
  target: { chain: 'solana', address: BONK },
  research: {
    x: { available: false, status: { available: false }, posts: [] },
    narrative: {
      available: true,
      summary: 'Bonk is a dog-themed memecoin launched on Christmas Day 2022 to revitalise the Solana community after the FTX collapse.',
      summaryClass,
      summarySource: 'Project description (GeckoTerminal)',
      claims: [],
      links,
    },
  },
  chainName: 'Solana',
});

const hrefs = (text) => text.split('\n').filter((l) => l.includes('href=')).join(' ');

// ---- no doubled URLs -----------------------------------------------------

test('an absolute X URL is not re-prefixed', () => {
  const out = hrefs(render({ twitter: 'https://x.com/bonk_inu' }));
  assert.match(out, /href="https:\/\/x\.com\/bonk_inu"/);
  assert.ok(!/x\.com\/https/.test(out), 'the handle must not be prefixed onto a URL');
  assert.match(out, /@bonk_inu/);
});

test('a bare handle still works', () => {
  const out = hrefs(render({ twitter: 'bonk_inu' }));
  assert.match(out, /href="https:\/\/x\.com\/bonk_inu"/);
});

// ---- scheme safety -------------------------------------------------------

test('dangerous URL schemes never reach an href', () => {
  for (const bad of ['javascript:alert(1)', 'data:text/html,<script>x</script>', 'ftp://evil.example/x', 'file:///etc/passwd']) {
    const out = hrefs(render({ website: bad, telegram: bad, twitter: bad }));
    assert.ok(!/javascript:|data:|ftp:|file:/.test(out), `${bad} must not render`);
  }
});

test('a javascript: website renders no links at all', () => {
  const out = render({ website: 'javascript:alert(1)' });
  assert.ok(!/href=/.test(out));
});

// ---- host checks --------------------------------------------------------

test('a twitter field pointing at a non-X host is refused', () => {
  const out = hrefs(render({ twitter: 'https://evil.example/bonk_inu' }));
  assert.ok(!/evil\.example/.test(out), 'only x.com/twitter.com hosts may be linked as X');
});

test('a valid website, X handle and telegram link all render', () => {
  const out = hrefs(render({
    website: 'https://www.bonkcoin.com',
    twitter: 'https://x.com/bonk_inu',
    telegram: 'https://t.me/bonk',
  }));
  assert.match(out, /bonkcoin\.com/);
  assert.match(out, /@bonk_inu/);
  assert.match(out, /t\.me\/bonk/);
});

test('the older homepage field still renders as Website', () => {
  const out = hrefs(render({ homepage: 'https://bonk.example' }));
  assert.match(out, /bonk\.example/);
});
