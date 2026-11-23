/**
 * test/card-modes.test.mjs
 * STANDARD / SHORT / DETAILED rendering, plus the honesty and Telegram-HTML
 * safety rules that must hold in every mode.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { formatCard, normalizeView } from '../src/format-card.mjs';
import { emptyRisk } from '../src/risk-intel.mjs';

const CA = '0x0E09FaBB73Bd3Ade0a17ECC321fD13a19e81cE82';

function result(over = {}) {
  return {
    mode: 'live',
    status: 'ok',
    token: {
      chain: 'bsc', address: CA.toLowerCase(), name: 'PancakeSwap Token', symbol: 'Cake',
      logo: 'https://cdn.example.org/cake.png',
    },
    chartUrl: 'https://dexscreener.com/bsc/0xpair',
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

// ---- Mode normalisation ---------------------------------------------------

test('view names normalise, and legacy "compact" maps to short', () => {
  assert.equal(normalizeView('standard'), 'standard');
  assert.equal(normalizeView('default'), 'standard');
  assert.equal(normalizeView('short'), 'short');
  assert.equal(normalizeView('compact'), 'short');
  assert.equal(normalizeView('detailed'), 'detailed');
  assert.equal(normalizeView('detail'), 'detailed');
  assert.equal(normalizeView(undefined), 'standard');
  assert.equal(normalizeView('nonsense'), 'standard');
});

// ---- STANDARD is the rich default ----------------------------------------

const STD = formatCard(result(), { view: 'standard' }).text;

test('STANDARD carries every required section', () => {
  for (const heading of ['MEME CHECKER', 'MARKET OVERVIEW', 'SECURITY OVERVIEW', 'NARRATIVE', 'PROJECT LINKS']) {
    assert.ok(STD.includes(heading), `standard missing section: ${heading}`);
  }
});

test('STANDARD header has branding, name, ticker, chain and copyable CA', () => {
  assert.ok(STD.includes('MEME CHECKER'));
  assert.ok(STD.includes('PancakeSwap Token'));
  assert.ok(STD.includes('$Cake'));
  assert.ok(STD.includes('BNB Chain'));
  assert.ok(STD.includes(`<code>${CA.toLowerCase()}</code>`), 'CA must be a code entity');
  assert.equal(STD.split(CA.toLowerCase()).length - 1, 1, 'CA appears exactly once');
});

test('STANDARD market metrics are separate aligned rows, not one dense line', () => {
  for (const label of ['Price', 'Market Cap', 'Liquidity', 'Volume 24H', 'Change 1H', 'Change 24H', 'Pair Age']) {
    // Each label starts its own line and is followed by a left-aligned value.
    const rows = STD.split(String.fromCharCode(10)).filter((l) => l.startsWith(`${label}:`));
    assert.equal(rows.length, 1, `expected exactly one ${label} row`);
    assert.ok(/^.+?:\s+\S/.test(rows[0]), `expected a value after the ${label} label: ${rows[0]}`);
  }
  // The rejected dense format used a middot separator between metrics.
  assert.ok(!/MC \$[\d.]+[MK]?\s+·\s+Liq/.test(STD), 'must not regress to the dense one-line dump');
});

test('STANDARD security block shows all six signals with real values', () => {
  assert.ok(/Top 10:\s+20\.2%/.test(STD));
  assert.ok(/Holders:\s+102,545/.test(STD));
  assert.ok(/Dex Paid:\s+Not Paid/.test(STD));
  assert.ok(/Tax \(B\/S\):\s+0\.0%/.test(STD));
  assert.ok(/LP Locked:\s+99%/.test(STD));
  assert.ok(/Creator Holds:\s+1\.2%/.test(STD));
});

test('creator holding is labelled as a current balance, never dev history', () => {
  assert.ok(STD.includes('Creator Holds'));
  assert.ok(!/Dev History/i.test(STD), 'must not imply dev history');
});

test('STANDARD keeps project links and narrative section', () => {
  assert.ok(STD.includes('pancakeswap.finance'));
  assert.ok(/No verified narrative available/.test(STD));
});

test('STANDARD has no DYOR marketing block and no promotional coming-soon block', () => {
  assert.ok(!STD.includes('WANT TO DYOR DEEPER'));
  assert.ok(!STD.includes('Full analysis page coming soon'));
  assert.ok(!STD.includes('Bubble Map'));
});

test('STANDARD is substantially richer than short', () => {
  const short = formatCard(result(), { view: 'short' }).text;
  assert.ok(STD.length > short.length * 1.6,
    `standard (${STD.length}) should be clearly richer than short (${short.length})`);
});

test('STANDARD does not stack horizontal rules between sections', () => {
  const rules = (STD.match(/━/g) ?? []).length;
  assert.ok(rules <= 1, `expected at most one rule, found ${rules}`);
});

// ---- SHORT ---------------------------------------------------------------

test('SHORT is minimal but still honest and copyable', () => {
  const t = formatCard(result(), { view: 'short' }).text;
  assert.ok(t.includes('PancakeSwap Token'));
  assert.ok(t.includes(CA.toLowerCase()), 'full CA still present');
  assert.ok(t.includes('Price'));
  assert.ok(!t.includes('MARKET OVERVIEW'));
  assert.ok(!t.includes('SECURITY OVERVIEW'));
  assert.ok(!t.includes('NARRATIVE'));
});

test('SHORT omits unavailable security rows rather than printing placeholders', () => {
  const t = formatCard(result({ risk: emptyRisk(), riskStatus: 'unsupported' }), { view: 'short' }).text;
  assert.ok(!t.includes('n/a'), 'short should not carry an all-placeholder security block');
});

// ---- DETAILED ------------------------------------------------------------

test('DETAILED keeps the documented §4.1 headings', () => {
  const d = formatCard(result(), { view: 'detailed' }).text;
  for (const h of ['MARKET DATA', 'HOLDER OVERVIEW', 'NARRATIVE', 'PROJECT INFO', 'WANT TO DYOR DEEPER']) {
    assert.ok(d.includes(h), `detailed missing ${h}`);
  }
});

test('DETAILED adds risk flags, sources and holder detail', () => {
  const d = formatCard(result(), { view: 'detailed' }).text;
  assert.ok(d.includes('RISK FLAGS'));
  assert.ok(d.includes('Not honeypot'));
  assert.ok(d.includes('Mintable'));
  assert.ok(d.includes('SOURCES'));
  assert.ok(d.includes('HOLDER DETAIL'));
});

test('DETAILED does not announce a flag that was never observed', () => {
  const d = formatCard(result(), { view: 'detailed' }).text;
  assert.ok(!d.includes('Closed source'), 'openSource true must not raise a closed-source warning');
});

// ---- Honesty in every mode ------------------------------------------------

test('unsupported chain shows unavailable markers in every mode, never a fake zero', () => {
  for (const view of ['standard', 'short', 'detailed']) {
    const t = formatCard(result({ risk: emptyRisk(), riskStatus: 'unsupported', dexPaid: { status: 'unknown' } }), { view }).text;
    assert.ok(!/Top 10: 0/.test(t), `${view} must not invent a 0 concentration`);
    assert.ok(!/Dex Paid: Not Paid/.test(t), `${view} must not claim unpaid when unknown`);
  }
});

test('no data source is marked n/a, distinct from a dash', () => {
  const t = formatCard(result({ risk: emptyRisk(), riskStatus: 'unsupported' }), { view: 'standard' }).text;
  assert.ok(t.includes('n/a'), 'unsupported must read n/a');
  const t2 = formatCard(result({ risk: emptyRisk(), riskStatus: 'no-data' }), { view: 'standard' }).text;
  assert.ok(t2.includes('—'), 'covered-but-empty must read as a dash');
});

test('material risk warnings are never dropped for brevity', () => {
  const risky = result({
    risk: {
      ...emptyRisk(),
      holders: { total: 500, top10Percentage: 92, largestHolderPercentage: 70 },
      tax: { buy: 25, sell: 25 },
      lpLock: { lockedPercentage: 0 },
      dev: { address: '0xdev', balancePercentage: 40 },
      security: { ...emptyRisk().security, honeypot: true },
    },
  });
  for (const view of ['standard', 'short', 'detailed']) {
    const t = formatCard(risky, { view }).text;
    assert.ok(/92\.0%/.test(t), `${view} must keep the concentration`);
    assert.ok(/25\.0%/.test(t), `${view} must keep the tax`);
  }
});

test('no [mock] label appears on a live card in any mode', () => {
  for (const view of ['standard', 'short', 'detailed']) {
    assert.ok(!/\[mock\]/i.test(formatCard(result(), { view }).text), `${view} leaked a mock label`);
  }
});

test('chain-unsupported status is distinct from not-found', () => {
  const t = formatCard({ mode: 'live', status: 'chain-unsupported', chain: 'story' }).text;
  assert.ok(/Not Supported/i.test(t));
  assert.ok(/Story/.test(t));
  assert.ok(!/Token Not Found/i.test(t));
  assert.ok(/not a statement about the token/i.test(t));
});

test('api-error disclaims being evidence about the token', () => {
  assert.ok(/says nothing about the token/i.test(formatCard({ mode: 'live', status: 'api-error' }).text));
});

// ---- Telegram HTML safety -------------------------------------------------

function telegramHtmlErrors(html) {
  const errors = [];
  const stack = [];
  const allowed = ['b', 'i', 'code', 'pre', 'a', 's', 'u', 'tg-emoji'];
  const re = /<(\/?)([a-zA-Z-]+)([^>]*)>|<|>/g;
  let m;
  while ((m = re.exec(html))) {
    if (!m[2]) { errors.push(`bare angle bracket at ${m.index}`); continue; }
    const closing = m[1] === '/';
    const tag = m[2].toLowerCase();
    if (!allowed.includes(tag)) { errors.push(`unsupported tag <${tag}> at ${m.index}`); continue; }
    if (!closing) stack.push(tag);
    else if (stack.pop() !== tag) errors.push(`mismatched close </${tag}> at ${m.index}`);
  }
  if (stack.length) errors.push(`unclosed: ${stack.join(',')}`);
  return errors;
}

test('every mode is structurally valid Telegram HTML', () => {
  const cases = [
    result(),
    result({ risk: emptyRisk(), riskStatus: 'unsupported' }),
    result({ risk: emptyRisk(), riskStatus: 'no-data', dexPaid: { status: 'unknown', detail: 'no "quotes" & <angle>' } }),
    result({ token: { chain: 'solana', address: 'So11111111111111111111111111111111111111112', name: 'A & B <script>', symbol: 'X&Y' } }),
    result({ market: { ...result().market, priceChange24h: 5000, priceChange1h: -500 } }),
    result({ market: { ...result().market, marketCapUsd: 1_503_569_501_787, priceChange24h: 1_007_903 } }),
  ];
  for (const c of cases) {
    for (const view of ['standard', 'short', 'detailed']) {
      const { text } = formatCard(c, { view });
      assert.deepEqual(telegramHtmlErrors(text), [], `${view} produced invalid HTML:\n${text}`);
    }
  }
});

test('sub-1% values are escaped so Telegram can parse the card', () => {
  const r = result({ risk: { ...emptyRisk(), lpLock: { lockedPercentage: 0.09 }, dev: { address: '0xabc', balancePercentage: 0.04 } } });
  for (const view of ['standard', 'detailed']) {
    const t = formatCard(r, { view }).text;
    assert.ok(t.includes('&lt;1%'), `${view} must escape "<1%"`);
    assert.ok(!/<1%/.test(t), `${view} must never emit a raw "<1%"`);
    assert.deepEqual(telegramHtmlErrors(t), []);
  }
});

test('both percentage clamp directions are escaped', () => {
  const pos = formatCard(result({ market: { ...result().market, priceChange24h: 5000 } }), { view: 'standard' }).text;
  assert.ok(pos.includes('&gt;+1000%'));
  assert.deepEqual(telegramHtmlErrors(pos), []);

  const neg = formatCard(result({ market: { ...result().market, priceChange1h: -500 } }), { view: 'detailed' }).text;
  assert.ok(neg.includes('&lt;-100%'));
  assert.deepEqual(telegramHtmlErrors(neg), []);
});

test('a token name with angle brackets cannot inject tags', () => {
  const r = result({ token: { chain: 'bsc', address: CA.toLowerCase(), name: '<b>hax</b>', symbol: 'X' } });
  for (const view of ['standard', 'short', 'detailed']) {
    const t = formatCard(r, { view }).text;
    assert.ok(!t.includes('<b>hax</b>'), `${view} allowed tag injection`);
    assert.deepEqual(telegramHtmlErrors(t), []);
  }
});

// ---- Implausible market data ---------------------------------------------

test('an implausible figure is disclosed, not hidden', () => {
  const r = result({ market: { ...result().market, marketCapUsd: 1_503_569_501_787, priceChange24h: 1_007_903 } });
  const t = formatCard(r, { view: 'standard' }).text;
  assert.ok(/inconsistent/i.test(t), 'must disclose the inconsistency');
  assert.ok(t.includes('Market Cap:'), 'the figure is still shown — warn, do not hide');
});

test('normal data raises no inconsistency note', () => {
  assert.ok(!/inconsistent/i.test(formatCard(result(), { view: 'standard' }).text));
});

// ---- Actions --------------------------------------------------------------

test('STANDARD exposes chart and add-to-group, and omits dead destinations', () => {
  const { buttons } = formatCard(result(), { view: 'standard', botUsername: 'TestBot' });
  const flat = buttons.flat();
  assert.ok(flat.some((b) => b.text.includes('Chart') && b.url.includes('dexscreener')));
  assert.ok(flat.some((b) => b.text.includes('Add to Group')));
  assert.ok(!flat.some((b) => b.text.includes('Analysis')), 'must not render an inactive analysis button');
});

test('Analysis button appears only when the token URL is real', () => {
  const withUrl = result({ fullAnalysisUrl: 'https://app.memechecker.io/check/bsc/0xabc' });
  const { buttons } = formatCard(withUrl, { view: 'standard' });
  assert.ok(buttons.flat().some((b) => b.text.includes('Analysis')));
});

test('placeholder and credentialed URLs never become buttons in any mode', () => {
  for (const view of ['standard', 'short', 'detailed']) {
    for (const bad of ['https://meme-checker.example/x', 'https://u:p@real.io/x', 'http://insecure.io/x']) {
      const { buttons } = formatCard(result({ fullAnalysisUrl: bad, chartUrl: bad }), { view });
      assert.ok(!buttons.flat().some((b) => b.url === bad), `${view} used an unacceptable URL`);
      assert.ok(!buttons.flat().some((b) => b.text.includes('Chart')), `${view} used a bad chart URL`);
    }
  }
});

// ---- Provider failure is not "no data" ------------------------------------

test('a risk fetch failure says so explicitly instead of showing silent dashes', () => {
  const r = result({ risk: emptyRisk(), riskStatus: 'error', riskDetail: 'timeout' });
  const t = formatCard(r, { view: 'standard' }).text;
  assert.ok(/could not be fetched/i.test(t), 'must disclose the fetch failure');
  assert.ok(/incomplete, not clear/i.test(t), 'must not let it read as an all-clear');
});

test('a genuine no-data result does NOT claim a fetch failure', () => {
  const r = result({ risk: emptyRisk(), riskStatus: 'no-data' });
  const t = formatCard(r, { view: 'standard' }).text;
  assert.ok(!/could not be fetched/i.test(t), 'no-data is not a failure');
});

test('the standard header prints no stray image glyph', () => {
  const t = formatCard(result(), { view: 'standard' }).text;
  assert.ok(!t.includes('🖼'), 'a bare logo glyph read as a rendering bug');
});
