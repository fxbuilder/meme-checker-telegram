/**
 * test/card-modes.test.mjs
 * Compact vs detailed rendering, and the honesty rules that must hold in BOTH.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { formatCard } from '../src/format-card.mjs';
import { emptyRisk } from '../src/risk-intel.mjs';

const CA = '0x0E09FaBB73Bd3Ade0a17ECC321fD13a19e81cE82';

function result(over = {}) {
  return {
    mode: 'live',
    status: 'ok',
    token: { chain: 'bsc', address: CA.toLowerCase(), name: 'PancakeSwap Token', symbol: 'Cake' },
    market: {
      priceUsd: 1.53, marketCapUsd: 534_000_000, fdvUsd: 534_000_000,
      liquidityUsd: 4_820_000, volume24hUsd: 650_000, priceChange24h: 1.9,
      priceChange1h: -0.34, pairAge: '3y 7mo',
    },
    holders: { total: 102545, top10Percentage: 20.2, largestHolderPercentage: 8.1 },
    narrative: null,
    project: { website: 'https://pancakeswap.finance', x: 'https://x.com/pancakeswap', telegram: null },
    updatedAt: null,
    fullAnalysisUrl: null,
    risk: {
      ...emptyRisk(),
      holders: { total: 102545, top10Percentage: 20.2, largestHolderPercentage: 8.1 },
      tax: { buy: 0, sell: 0 },
      lpLock: { lockedPercentage: 99 },
      dev: { address: '0x58e0bc787f', balancePercentage: 1.2 },
      security: { ...emptyRisk().security, honeypot: false, mintable: true, openSource: true },
    },
    riskStatus: 'ok',
    dexPaid: { status: 'not-paid', detail: 'no orders or boosts on an indexed chain' },
    source: { provider: 'dexscreener', pairs: 30 },
    ...over,
  };
}

// ---- Compact ---------------------------------------------------------------

test('compact card is materially shorter than detailed', () => {
  const c = formatCard(result(), { view: 'compact' }).text;
  const d = formatCard(result(), { view: 'detailed' }).text;
  assert.ok(c.length < d.length * 0.65,
    `compact (${c.length}) should be much shorter than detailed (${d.length})`);
});

test('compact card omits the detail-only sections', () => {
  const c = formatCard(result(), { view: 'compact' }).text;
  for (const heading of ['MARKET DATA', 'HOLDER OVERVIEW', 'NARRATIVE', 'PROJECT INFO', 'WANT TO DYOR DEEPER', 'SECURITY']) {
    assert.ok(!c.includes(heading), `compact must not include ${heading}`);
  }
});

test('compact card still carries identity, CA, price and quick checks', () => {
  const c = formatCard(result(), { view: 'compact' }).text;
  assert.ok(c.includes('PancakeSwap Token'));
  assert.ok(c.includes('$Cake'));
  assert.ok(c.includes('BNB Chain'));
  assert.ok(c.includes(CA.toLowerCase()), 'full CA must be present');
  assert.ok(c.includes('Price'));
  assert.ok(c.includes('QUICK CHECKS'));
  for (const label of ['Top 10', 'Holders', 'Dex Paid', 'Tax', 'LP Lock', 'Dev']) {
    assert.ok(c.includes(label), `missing quick check: ${label}`);
  }
});

test('the full CA appears exactly once in compact mode', () => {
  const c = formatCard(result(), { view: 'compact' }).text;
  assert.equal(c.split(CA.toLowerCase()).length - 1, 1);
});

test('quick check values reflect real data', () => {
  const c = formatCard(result(), { view: 'compact' }).text;
  assert.ok(c.includes('Top 10: 20.2%'));
  assert.ok(c.includes('Holders: 102,545'));
  assert.ok(c.includes('Dex Paid: Not Paid'));
  assert.ok(c.includes('Tax: 0.0%'));
  assert.ok(c.includes('LP Lock: 99%'));
  assert.ok(c.includes('Dev: 1.2%'));
});

// ---- Detailed --------------------------------------------------------------

test('detailed card keeps the §4.1 section headings', () => {
  const d = formatCard(result(), { view: 'detailed' }).text;
  for (const h of ['MARKET DATA', 'HOLDER OVERVIEW', 'NARRATIVE', 'PROJECT INFO', 'WANT TO DYOR DEEPER']) {
    assert.ok(d.includes(h), `detailed must include ${h}`);
  }
});

test('detailed card shows security flags only when known', () => {
  const d = formatCard(result(), { view: 'detailed' }).text;
  assert.ok(d.includes('Not honeypot'));
  assert.ok(d.includes('Mintable'));
  // openSource true must not be announced as a warning.
  assert.ok(!d.includes('Closed source'));
});

test('detailed card omits security block entirely when nothing is known', () => {
  const d = formatCard(result({ risk: emptyRisk(), riskStatus: 'unsupported' }), { view: 'detailed' }).text;
  assert.ok(!d.includes('SECURITY'));
});

// ---- Honesty in both modes -------------------------------------------------

test('unsupported chain shows n/a in both modes, never a fake zero', () => {
  for (const view of ['compact', 'detailed']) {
    const t = formatCard(result({ risk: emptyRisk(), riskStatus: 'unsupported', dexPaid: { status: 'unknown' } }), { view }).text;
    assert.ok(t.includes('n/a'), `${view} must state n/a for unsupported risk data`);
    assert.ok(!t.includes('Top 10: 0'), `${view} must not invent a 0 concentration`);
    assert.ok(!t.includes('Dex Paid: Not Paid'), `${view} must not claim unpaid when unknown`);
  }
});

test('no [mock] label appears for a live card', () => {
  for (const view of ['compact', 'detailed']) {
    const t = formatCard(result(), { view }).text;
    assert.ok(!/\[mock\]/i.test(t));
  }
});

test('chain-unsupported status has its own message, distinct from not-found', () => {
  const t = formatCard({ mode: 'live', status: 'chain-unsupported', chain: 'story' }).text;
  assert.ok(/Not Supported/i.test(t));
  assert.ok(/Story/.test(t));
  assert.ok(!/Token Not Found/i.test(t), 'a capability gap must not read as a token miss');
  assert.ok(/not a statement about the token/i.test(t), 'must not imply anything about the token');
});

test('api-error explicitly disclaims being evidence about the token', () => {
  const t = formatCard({ mode: 'live', status: 'api-error' }).text;
  assert.ok(/says nothing about the token/i.test(t));
});

test('compact card renders all chains without crashing', () => {
  const chainIds = ['solana', 'ethereum', 'bsc', 'base', 'arbitrum', 'optimism', 'polygon',
    'avalanche', 'hyperevm', 'monad', 'robinhood', 'unichain', 'berachain', 'abstract', 'megaeth'];
  for (const chain of chainIds) {
    const r = result({
      token: { chain, address: chain === 'solana' ? 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263' : CA.toLowerCase(), name: 'T', symbol: 'T' },
    });
    const { text } = formatCard(r, { view: 'compact' });
    assert.ok(text.includes('QUICK CHECKS'), `${chain} card missing quick checks`);
    assert.ok(!text.includes('undefined'), `${chain} card leaked "undefined"`);
    assert.ok(!text.includes('NaN'), `${chain} card leaked NaN`);
    assert.ok(!text.includes('null'), `${chain} card leaked "null"`);
  }
});

// ---- Telegram HTML safety -------------------------------------------------

/**
 * The card is sent with parse_mode=HTML. A value like "<1%" is a legal display
 * string but an illegal tag opener, and Telegram rejects the ENTIRE message.
 * These tests validate the tag structure rather than comparing strings.
 */
function telegramHtmlErrors(html) {
  const errors = [];
  const stack = [];
  const re = /<(\/?)([a-zA-Z-]+)([^>]*)>|<|>/g;
  let m;
  while ((m = re.exec(html))) {
    if (!m[2]) { errors.push(`bare angle bracket at ${m.index}`); continue; }
    const closing = m[1] === '/';
    const tag = m[2].toLowerCase();
    if (!['b', 'i', 'code', 'a', 'tg-emoji'].includes(tag)) {
      errors.push(`unsupported tag <${tag}> at ${m.index}`);
      continue;
    }
    if (!closing) stack.push(tag);
    else if (stack.pop() !== tag) errors.push(`mismatched close </${tag}> at ${m.index}`);
  }
  if (stack.length) errors.push(`unclosed: ${stack.join(',')}`);
  return errors;
}

test('every quick-check value is HTML-escaped so Telegram can parse the card', () => {
  // Sub-1% renders as "<1%" — the exact value that broke a real send.
  const r = result({
    risk: { ...emptyRisk(), lpLock: { lockedPercentage: 0.09 }, dev: { address: '0xabc', balancePercentage: 0.04 } },
  });
  const { text } = formatCard(r, { view: 'compact' });
  assert.ok(text.includes('&lt;1%'), 'sub-1% must be escaped');
  assert.ok(!/<1%/.test(text), 'raw "<1%" must never appear — it breaks Telegram parsing');
  assert.deepEqual(telegramHtmlErrors(text), []);
});

test('compact and detailed cards are structurally valid Telegram HTML across chains', () => {
  const cases = [
    result(),
    result({ risk: emptyRisk(), riskStatus: 'unsupported' }),
    result({ risk: emptyRisk(), riskStatus: 'no-data', dexPaid: { status: 'unknown', detail: 'no "quotes" & <angle>' } }),
    result({ token: { chain: 'solana', address: 'So11111111111111111111111111111111111111112', name: 'A & B <script>', symbol: 'X&Y' } }),
  ];
  for (const c of cases) {
    for (const view of ['compact', 'detailed']) {
      const { text } = formatCard(c, { view });
      assert.deepEqual(telegramHtmlErrors(text), [], `${view} card produced invalid HTML:\n${text}`);
    }
  }
});

test('a token name containing angle brackets cannot inject tags', () => {
  const r = result({ token: { chain: 'bsc', address: CA.toLowerCase(), name: '<b>hax</b>', symbol: 'X' } });
  const { text } = formatCard(r, { view: 'compact' });
  assert.ok(!text.includes('<b>hax</b>'));
  assert.ok(text.includes('&lt;b&gt;hax&lt;/b&gt;'));
  assert.deepEqual(telegramHtmlErrors(text), []);
});

// ---- Implausible market data ----------------------------------------------

test('absurd percentage moves are clamped in the display', () => {
  const r = result({ market: { ...result().market, priceChange24h: 1_007_903 } });
  const { text } = formatCard(r, { view: 'compact' });
  assert.ok(text.includes('&gt;+1000%'), 'huge positive change must be clamped and HTML-escaped');
  assert.ok(!text.includes('1007903'), 'raw absurd value must not be printed');
});

test('a $1.5T market cap triggers an inconsistency note, value still shown', () => {
  const r = result({ market: { ...result().market, marketCapUsd: 1_503_569_501_787, priceChange24h: 1_007_903 } });
  const { text } = formatCard(r, { view: 'compact' });
  assert.ok(/look inconsistent/i.test(text), 'must disclose, not silently present');
  assert.ok(text.includes('MC $'), 'the figure is still shown — we warn, we do not hide');
});

test('normal market data gets no inconsistency note', () => {
  const { text } = formatCard(result(), { view: 'compact' });
  assert.ok(!/look inconsistent/i.test(text));
});

test('both clamp directions are escaped and produce valid HTML', () => {
  // Compact shows 24H only, so drive the positive clamp through 24H...
  const pos = formatCard(result({ market: { ...result().market, priceChange24h: 5000 } }), { view: 'compact' }).text;
  assert.deepEqual(telegramHtmlErrors(pos), []);
  assert.ok(pos.includes('&gt;+1000%'));

  // ...and the negative clamp through 24H too.
  const neg = formatCard(result({ market: { ...result().market, priceChange24h: -500 } }), { view: 'compact' }).text;
  assert.deepEqual(telegramHtmlErrors(neg), []);
  assert.ok(neg.includes('&lt;-100%'), 'negative clamp must be escaped');

  // Detailed mode renders both 1H and 24H, so verify both there as well.
  const det = formatCard(result({ market: { ...result().market, priceChange1h: -500, priceChange24h: 5000 } }), { view: 'detailed' }).text;
  assert.deepEqual(telegramHtmlErrors(det), []);
});
