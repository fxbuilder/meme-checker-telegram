# ROUND 8 — CARD EMOJI FIX + LIVE VERIFICATION

The Round 7 claim of complete renderer migration did not match the product. This documents
what was actually wrong, what was fixed, and what was verified against the live Telegram API.

Baseline `d9ede4f` (952 tests) → this commit (**964 tests**).

---

## 1. Root cause — the Standard card never got custom emoji

The outgoing-emoji interceptor wrapped every Telegram method as `(chatId, text, extra)` and
upgraded **argument 2**. Only one method has that shape. The real Telegraf signatures are:

| Method | Signature | Where the text is |
| --- | --- | --- |
| `sendMessage` | `(chatId, text, extra)` | arg 2 ✅ |
| `sendPhoto` | `(chatId, **photo**, extra)` | `extra.caption` ❌ |
| `editMessageText` | `(chatId, messageId, inlineMessageId, **text**, extra)` | arg 4 ❌ |
| `editMessageCaption` | `(chatId, messageId, inlineMessageId, **caption**, extra)` | arg 4 ❌ |

So:

- **The Standard card**, which ships as a photo **caption**, was passed through a photo object
  where text was expected — returned untouched. Every section and indicator stayed Unicode.
- **`/chains`**, which replies with text via `sendMessage`, *was* upgraded. That is exactly the
  asymmetry the OWNER saw.
- **Callback-edited messages** were also never upgraded (arg 2 is a message id there).

Worse, if argument 2 had ever matched a glyph, `editMessageText` would have overwritten the
message id — a latent send-breaking bug.

Each method is now patched at its own correct position, and `sendPhoto` upgrades
`extra.caption` while leaving the media object untouched.

## 2. Card icon positions are explicit roles

Glyph literals were replaced with named roles so a position cannot be mis-mapped:

```js
e.icon('section.market')      // not e('📊')
e.icon('chain.' + chain)      // chain badge by role, not a lookup
```

One icon could **never** have been upgraded before: `𝕏` (U+1D54F) is a *mathematical* character,
outside every emoji range — it was invisible to any scanner. It now maps to `metric.x`.

Risk flags (`✅ ⚠️ ⛔`) and the risk-data warning on the detailed card also resolve by role.

## 3. Verdict tones stay dots — deliberately

`securityPairs` emitted raw `🟢🟡🔴⚪`. Wiring those through the registry looked correct until
reviewed: `state.warn`'s artwork is an **exclamation mark**, so a yellow severity dot became a
warning symbol while the green and grey rows on adjacent lines stayed dots. Three verdicts in
two visual languages, and the symbol said "warning" where the data said "elevated".

Verdict tones therefore use dedicated `tone.*` roles which deliberately have **no custom asset**.
A severity dot is a colour measurement; the exclamation is reserved for actual warnings. No clean
generic status icons exist in any inspected pack (see §5).

## 4. Live verification — custom emoji ARE sendable

Bounded live test: one text message plus one short probe to the OWNER's DM. No poller, no group,
nothing public.

| Check | Result |
| --- | --- |
| Bot identity | `@MemeCheckerStagingBot`, `can_join_groups: true` |
| Text card sent | `message_id 566` |
| Entity types returned | `custom_emoji, bold, code, italic, text_link` |
| **Custom emoji entities** | **7 of 9 expected** |
| Returned ids match markup | yes (in order) |
| Short probe | **2 of 2** expected |

**Custom emoji are confirmed sendable by this bot.** The two "missing" entities are inside
`<a href>` tags: Telegram does not emit `custom_emoji` entities within link text. That is a
platform behaviour, not a renderer fault — verified by checking which expected ids sit inside an
anchor.

## 5. Asset findings — the Base/Robinhood premise was wrong

The new Cryptach packs were inspected (`getStickerSet`, 800 assets, thumbnails plus
**extracted WebM frames** where the poster frame was inconclusive).

| Claim | Verified result |
| --- | --- |
| pack 7, position 2 = Base | **No.** Blue circle with a white horizontal bar — reads as a "minus" glyph. |
| pack 7, position 3 = Base | **No.** Blue circle split white-over-blue. Confirmed across extracted frames. |
| pack 2, position 18 = Robinhood | **No.** Blockchain.com's blue isometric cube. |
| pack 4 = generic UI (charts) | **Yes, partly.** #002/#003 are clean green/red candlestick charts — **adopted**. |

Catalogue positions do **not** map to sticker indices, so each stated position was rendered and
looked at rather than trusted.

**Total inspected: 1,725 assets across 14 packs.** No Base mark and no Robinhood feather exists
in any of them. Rejected lookalikes: a generic minus, Blockchain.com's cube, OKX's checkerboard,
Coinbase's "C", Ravencoin's bird. Using any would tell a reader they are looking at a brand they
can trust.

Base and Robinhood remain **documented asset blockers** and keep distinct glyphs plus labels.
Their artwork specification is in `docs/FINAL-EMOJI-COVERAGE.md` §6.

## 6. Also found and fixed

A real regression introduced by the role conversion: several helpers defaulted `e` to an identity
function (`e = (x) => x`), and `buildEmojiTheme()` returns a **bare function with no `.icon`
method**. Renderers calling `e.icon(...)` threw `e.icon is not a function`, which silently broke
the card refresh path. `asEmojiResolver()` now normalises any caller-supplied theme into a full
resolver.

## 7. Asset inventory after this round

| Metric | Count |
| --- | --- |
| Registered roles | 81 |
| Verified custom assets | 35 |
| Animated (video/TGS) | 34 |
| Static | 1 (HyperEVM — no animation exists) |
| Unicode fallback | 46 |

Newly verified this round: `metric.roi`, `section.pnl` (green candlestick),
`misc.down` (red candlestick).

## 8. Card render, actual output

```
«🚀» MEME CHECKER
🪙 TEXEL  $TEXEL
«🟡» BNB Chain                        ← branded chain asset
0x0ddcab9ae04bda0c87ecc1640636fa11e8e613e8
«📊» MARKET OVERVIEW
«🛡️» SECURITY OVERVIEW
🟡 Top 10: 31.2%                       ← severity dots stay dots (deliberate)
⚪ Holders: 4,210
⚪ Dex Paid: Unknown
🟢 Tax (B/S): 0.0%
«🧠» NARRATIVE
«🌐» PROJECT LINKS
«🌍» Website
«✖️» X
«⚡» Powered by MEME CHECKER
```

`«»` = custom emoji entity confirmed by the live API. The token badge (`🪙`) has no verified
generic asset — every "coin" in 1,725 assets is a specific branded token, and borrowing one would
misrepresent the scanned token.

## 9. Remaining limitations — stated plainly

- **Base and Robinhood logos**: no public asset exists. OWNER-published pack required.
- **Token identity badge** (`🪙`): no generic coin asset; all candidates are branded tokens.
- **Severity dots**: intentionally Unicode — they are a colour scale, and no clean status icons
  exist in any inspected pack.
- **Custom emoji inside `<a>` links**: Telegram strips the entity. Icons inside link text will
  render as plain glyphs regardless of the registry.
- **HyperEVM**: static asset only.
- 46 roles remain on Unicode fallback, mostly non-priority chains and generic UI icons.

## 10. Tests

**964 passing**, run twice. 12 new in `test/round8-caption-emoji.test.mjs`, asserting the actual
payload shape rather than that a function was called:

- `sendPhoto` upgrades the caption and leaves the media untouched;
- `editMessageText` / `editMessageCaption` upgrade argument 4, preserving the message id;
- the photo card and the text card carry the same icon mappings;
- the caption-too-long fallback keeps its emoji;
- a disabled switch produces a readable card with no markup;
- verdict tones never acquire an exclamation asset.
