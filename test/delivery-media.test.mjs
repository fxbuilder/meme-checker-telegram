/**
 * test/delivery-media.test.mjs
 * Delivery rules (photo vs text, single send, caption limit) and image-source
 * safety. No network: every fetch is stubbed.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  deliverCard, visibleLength, captionFits, CAPTION_LIMIT,
} from '../src/delivery.mjs';
import {
  isSafeImageUrl, fetchImage, extractOgImage, resolveTokenImage, findWebsiteImage,
} from '../src/media.mjs';
import { formatCard } from '../src/format-card.mjs';
import { emptyRisk } from '../src/risk-intel.mjs';

const IMG = 'https://cdn.example.org/banner.jpg';
const CA = '0x0e09fabb73bd3ade0a17ecc321fd13a19e81ce82';

function result(over = {}) {
  return {
    mode: 'live', status: 'ok',
    token: { chain: 'bsc', address: CA, name: 'Cake', symbol: 'CAKE' },
    market: { priceUsd: 1.5, marketCapUsd: 5e8, liquidityUsd: 4e6, volume24hUsd: 6e5, priceChange24h: 1.9, priceChange1h: -0.3, pairAge: '3y 7mo' },
    holders: null, narrative: null,
    project: { website: 'https://pancakeswap.finance', x: null, telegram: null },
    updatedAt: null, fullAnalysisUrl: null,
    risk: { ...emptyRisk(), holders: { total: 1000, top10Percentage: 20, largestHolderPercentage: 8 } },
    riskStatus: 'ok',
    dexPaid: { status: 'not-paid' },
    ...over,
  };
}

/** Recording telegram double. */
function fakeTelegram({ photoFails = false, textFails = false } = {}) {
  const calls = [];
  return {
    calls,
    sendPhoto: async (chat, url, opts) => {
      calls.push({ kind: 'photo', chat, url, opts });
      if (photoFails) {
        const e = new Error('Bad Request: wrong file identifier/HTTP URL specified');
        e.description = 'Bad Request: wrong file identifier/HTTP URL specified';
        throw e;
      }
      return {
        message_id: 101, caption: opts.caption, caption_entities: [{ type: 'bold' }, { type: 'custom_emoji' }],
        reply_markup: opts.reply_markup,
      };
    },
    sendMessage: async (chat, text, opts) => {
      calls.push({ kind: 'text', chat, text, opts });
      if (textFails) {
        const e = new Error('Bad Request: chat not found');
        e.description = 'Bad Request: chat not found';
        throw e;
      }
      return { message_id: 202, text, entities: [{ type: 'bold' }], reply_markup: opts?.reply_markup };
    },
  };
}

const BUTTONS = [[{ text: '➕ Add to Group', url: 'https://t.me/Bot?startgroup=true' }]];

// ---- Visible-length accounting -------------------------------------------

test('visibleLength ignores tags and collapses entities to one character', () => {
  assert.equal(visibleLength('<b>abc</b>'), 3);
  assert.equal(visibleLength('a &amp; b'), 5);          // "a & b"
  assert.equal(visibleLength('x &lt;1%'), 5);           // "x <1%"
  assert.equal(visibleLength('<i></i>'), 0);
  // A long HTML source with short visible text must measure short.
  const src = '<b>' + 'A'.repeat(50) + '</b>';
  assert.equal(visibleLength(src), 50);
});

test('captionFits respects the 1024 visible-character limit', () => {
  assert.equal(CAPTION_LIMIT, 1024);
  assert.equal(captionFits('A'.repeat(1024)), true);
  assert.equal(captionFits('A'.repeat(1025)), false);
  // Heavy markup must not consume the budget.
  const markup = `<b>${'A'.repeat(600)}</b>`;
  assert.equal(captionFits(markup), true);
});

// ---- Delivery paths ------------------------------------------------------

test('a verified image is delivered as a photo with the card as caption', async () => {
  const tg = fakeTelegram();
  const { text, buttons } = formatCard(result(), { view: 'standard', botUsername: 'Bot' });
  const r = await deliverCard({ telegram: tg, chatId: 1, text, buttons, imageUrl: IMG });

  assert.equal(r.ok, true);
  assert.equal(r.kind, 'photo');
  assert.equal(r.messageId, 101);
  assert.equal(r.fellBack, false);
  assert.equal(tg.calls.length, 1, 'exactly one send');
  assert.equal(tg.calls[0].kind, 'photo');
  assert.equal(tg.calls[0].url, IMG);
  assert.equal(tg.calls[0].opts.caption, text);
  assert.equal(tg.calls[0].opts.parse_mode, 'HTML');
  assert.deepEqual(tg.calls[0].opts.reply_markup.inline_keyboard, BUTTONS);
  assert.equal(r.buttons, 1);
});

test('no image → a single text card, no photo attempt', async () => {
  const tg = fakeTelegram();
  const { text, buttons } = formatCard(result(), { view: 'standard', botUsername: 'Bot' });
  const r = await deliverCard({ telegram: tg, chatId: 1, text, buttons, imageUrl: null });

  assert.equal(r.ok, true);
  assert.equal(r.kind, 'text');
  assert.equal(tg.calls.length, 1);
  assert.equal(tg.calls[0].kind, 'text');
  assert.equal(tg.calls[0].opts.reply_markup.inline_keyboard.length, 1);
});

test('a rejected photo falls back to ONE text card — never both', async () => {
  const tg = fakeTelegram({ photoFails: true });
  const { text, buttons } = formatCard(result(), { view: 'standard', botUsername: 'Bot' });
  const r = await deliverCard({ telegram: tg, chatId: 1, text, buttons, imageUrl: IMG });

  assert.equal(r.ok, true);
  assert.equal(r.kind, 'text');
  assert.equal(r.fellBack, true);
  assert.match(r.fallbackReason, /wrong file identifier|HTTP URL/);
  // One photo attempt + one text send. Exactly one card lands.
  assert.equal(tg.calls.length, 2);
  assert.equal(tg.calls.filter((c) => c.kind === 'text').length, 1);
  assert.equal(r.messageId, 202);
});

test('a caption over the limit uses the text card instead of truncating', async () => {
  const tg = fakeTelegram();
  const huge = `<b>${'A'.repeat(CAPTION_LIMIT + 50)}</b>`;
  const r = await deliverCard({ telegram: tg, chatId: 1, text: huge, buttons: BUTTONS, imageUrl: IMG });

  assert.equal(r.kind, 'text');
  assert.equal(r.fellBack, true);
  assert.match(r.fallbackReason, /caption too long/);
  assert.equal(tg.calls.filter((c) => c.kind === 'photo').length, 0, 'must not attempt a doomed caption');
  assert.equal(tg.calls.length, 1);
});

test('a full failure is reported, not silently swallowed', async () => {
  const tg = fakeTelegram({ photoFails: true, textFails: true });
  const r = await deliverCard({ telegram: tg, chatId: 1, text: 'x', buttons: [], imageUrl: IMG });
  assert.equal(r.ok, false);
  assert.match(r.detail, /chat not found/);
});

test('delivery never sends twice for one scan on the happy paths', async () => {
  for (const [imageUrl, photoFails] of [[IMG, false], [null, false], [IMG, true]]) {
    const tg = fakeTelegram({ photoFails });
    await deliverCard({ telegram: tg, chatId: 1, text: '<b>card</b>', buttons: BUTTONS, imageUrl });
    const landed = tg.calls.filter((c) => c.kind === (photoFails ? 'text' : imageUrl ? 'photo' : 'text'));
    assert.equal(landed.length, 1, `expected exactly one landed card (image=${imageUrl}, fail=${photoFails})`);
  }
});

// ---- SSRF / URL safety ---------------------------------------------------

test('private, loopback, metadata and non-HTTPS hosts are rejected', () => {
  const bad = [
    'http://cdn.example.org/a.jpg',
    'https://localhost/a.jpg',
    'https://127.0.0.1/a.jpg',
    'https://10.1.2.3/a.jpg',
    'https://192.168.1.5/a.jpg',
    'https://172.16.0.9/a.jpg',
    'https://169.254.169.254/latest/meta-data/',
    'https://100.64.0.1/a.jpg',
    'https://[::1]/a.jpg',
    'https://user:pass@cdn.example.org/a.jpg',
    'https://cdn.example.org:8080/a.jpg',
    'https://meme-checker.example/a.jpg',
    'https://thing.internal/a.jpg',
  ];
  for (const u of bad) assert.equal(isSafeImageUrl(u), false, `should reject ${u}`);
});

test('ordinary public HTTPS image URLs are accepted', () => {
  for (const u of [IMG, 'https://cdn.dexscreener.com/x.jpg']) {
    assert.equal(isSafeImageUrl(u), true, `should accept ${u}`);
  }
});

test('fetchImage rejects a redirect into a private network', async () => {
  // First hop: public 302 → 169.254.169.254 (cloud metadata).
  const fetchImpl = async (url) => ({
    status: 302,
    ok: false,
    headers: { get: (h) => (h === 'location' ? 'https://169.254.169.254/secret' : null) },
  });
  const r = await fetchImage(IMG, { fetchImpl });
  assert.equal(r.ok, false);
  assert.match(r.detail, /unsafe|inacceptable/);
});

test('fetchImage rejects a non-image content type', async () => {
  const fetchImpl = async () => ({
    status: 200, ok: true,
    headers: { get: (h) => (h === 'content-type' ? 'text/html' : h === 'content-length' ? '10' : null) },
    arrayBuffer: async () => Buffer.from('<html></html>'),
  });
  const r = await fetchImage(IMG, { fetchImpl });
  assert.equal(r.ok, false);
  assert.match(r.detail, /not an image/);
});

test('fetchImage rejects an oversized body', async () => {
  const fetchImpl = async () => ({
    status: 200, ok: true,
    headers: { get: (h) => (h === 'content-type' ? 'image/jpeg' : h === 'content-length' ? String(20 * 1024 * 1024) : null) },
    arrayBuffer: async () => Buffer.alloc(10),
  });
  const r = await fetchImage(IMG, { fetchImpl });
  assert.equal(r.ok, false);
  assert.match(r.detail, /too large/);
});

test('fetchImage accepts a real image and reports its size', async () => {
  const fetchImpl = async () => ({
    status: 200, ok: true,
    headers: { get: (h) => (h === 'content-type' ? 'image/jpeg' : h === 'content-length' ? '1234' : null) },
    arrayBuffer: async () => Buffer.alloc(1234),
  });
  const r = await fetchImage(IMG, { fetchImpl });
  assert.equal(r.ok, true);
  assert.equal(r.bytes, 1234);
  assert.equal(r.contentType, 'image/jpeg');
});

// ---- Image source priority ----------------------------------------------

test('a verified banner is preferred over the logo', async () => {
  const fetchImpl = async () => ({
    status: 200, ok: true,
    headers: { get: (h) => (h === 'content-type' ? 'image/jpeg' : null) },
    arrayBuffer: async () => Buffer.alloc(500),
  });
  const r = await resolveTokenImage(
    result({ media: { header: 'https://cdn.example.org/header.jpg', logo: 'https://cdn.example.org/logo.jpg' } }),
    { fetchImpl },
  );
  assert.equal(r.kind, 'banner');
  assert.equal(r.url, 'https://cdn.example.org/header.jpg');
});

test('the logo is used when no banner is available', async () => {
  const fetchImpl = async () => ({
    status: 200, ok: true,
    headers: { get: (h) => (h === 'content-type' ? 'image/png' : null) },
    arrayBuffer: async () => Buffer.alloc(400),
  });
  const r = await resolveTokenImage(
    result({ media: { header: null, logo: 'https://cdn.example.org/logo.png' } }),
    { fetchImpl },
  );
  assert.equal(r.kind, 'logo');
});

test('an unusable image anywhere in the chain yields null, never a guess', async () => {
  const fetchImpl = async () => ({ status: 404, ok: false, headers: { get: () => null }, arrayBuffer: async () => Buffer.alloc(0) });
  const r = await resolveTokenImage(
    result({ media: { header: 'https://cdn.example.org/h.jpg', logo: 'https://cdn.example.org/l.jpg' } }),
    { fetchImpl },
  );
  assert.equal(r, null);
});

test('image resolution never uses a URL from somewhere other than the scan payload', () => {
  // There is no code path that reads an image URL from user input; the resolver
  // only consults result.media and result.project.website. Assert the shape.
  const r = result({ media: { header: null, logo: null }, project: { website: null } });
  return resolveTokenImage(r, { fetchImpl: async () => { throw new Error('must not fetch'); } })
    .then((v) => assert.equal(v, null));
});

// ---- og:image extraction -------------------------------------------------

test('og:image and twitter:image are extracted in either attribute order', () => {
  const a = '<meta property="og:image" content="https://x.io/a.png">';
  const b = '<meta content="https://x.io/b.png" property="og:image">';
  const c = '<meta name="twitter:image" content="/c.png">';
  assert.equal(extractOgImage(a, 'https://x.io/'), 'https://x.io/a.png');
  assert.equal(extractOgImage(b, 'https://x.io/'), 'https://x.io/b.png');
  assert.equal(extractOgImage(c, 'https://x.io/page'), 'https://x.io/c.png', 'relative resolves');
  assert.equal(extractOgImage('<html>no meta</html>', 'https://x.io/'), null);
});

test('an og:image pointing at a private host is not used', async () => {
  const fetchImpl = async (url) => {
    if (url === 'https://x.io/') {
      return {
        ok: true, status: 200,
        headers: { get: (h) => (h === 'content-type' ? 'text/html' : null) },
        text: async () => '<meta property="og:image" content="https://192.168.0.1/a.png">',
      };
    }
    return { ok: false, status: 500, headers: { get: () => null }, arrayBuffer: async () => Buffer.alloc(0) };
  };
  const r = await findWebsiteImage('https://x.io/', { fetchImpl });
  assert.equal(r, null);
});

// ---- Caption safety on the real card ------------------------------------

test('the real standard card fits a photo caption with room to spare', () => {
  const { text } = formatCard(result(), { view: 'standard', botUsername: 'Bot' });
  assert.equal(captionFits(text), true, `card is ${visibleLength(text)} visible chars`);
  assert.ok(visibleLength(text) < 900, 'should leave headroom for longer tokens');
});

test('a hostile token name still produces a sendable, escaped caption', () => {
  const r = result({ token: { chain: 'bsc', address: CA, name: '<script>&"Rug"</script>', symbol: 'A&B' } });
  const { text } = formatCard(r, { view: 'standard', botUsername: 'Bot' });
  assert.ok(!text.includes('<script>'));
  assert.ok(captionFits(text));
  // Structural check: no unsupported tags introduced by the hostile name.
  const allowed = ['b', 'i', 'code', 'pre', 'a', 's', 'u', 'tg-emoji'];
  const tags = [...text.matchAll(/<(\/?)([a-zA-Z-]+)/g)].map((m) => m[2].toLowerCase());
  for (const t of tags) assert.ok(allowed.includes(t), `unexpected tag <${t}>`);
});
