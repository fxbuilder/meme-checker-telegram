# FINAL UI BASELINE — Telegram token card

**STATUS: LOCKED.** This is the accepted Telegram card design. Do not redesign it.
Future work (Group Call Tracking, PnL, Leaderboards, Alerts) must build on this
card, not replace it.

- **Branch:** `mc/final-ui`
- **Default mode:** STANDARD Variant A (owner-selected)
- **Bot:** @MemeCheckerStagingBot

---

## 1. Card structure (STANDARD Variant A, the default)

```
[ project banner image, when verified ]
🚀 MEME CHECKER
🪙 <token name>  <code>$TICKER</code>
<chain emoji> <chain name>
<code>FULL CONTRACT ADDRESS</code>

📊 MARKET OVERVIEW
Price / Market Cap / FDV / Liquidity / Volume 24H / Change 1H / Change 24H / Pair Age

🛡️ SECURITY OVERVIEW
🟡 Top 10 · ⚪ Holders · 🟢 Dex Paid · 🟢 Tax (B/S) · 🔴 LP Locked · 🟢 Creator Holds

🧠 NARRATIVE
summary, or one honest unavailable line

🌐 PROJECT LINKS
Website / X / Telegram, only when verified

⚡ Powered by MEME CHECKER
[ ➕ Add to Group ]
```

Exactly **one** inline button. Chart, Full Analysis, Premium and Explore were
removed from the token card by owner instruction and must not come back.

## 2. Delivery

| Condition | Method |
| --- | --- |
| Verified image exists | `sendPhoto` with the card as caption |
| No verified image | `sendMessage` with the same card |
| `sendPhoto` rejected | ONE `sendMessage` fallback — never both |
| Caption > 1024 visible chars | text card (CA and risk warnings are never truncated) |

The caption limit is measured on **visible** characters (tags stripped, entities
collapsed to one), not on the HTML source.

## 3. Image sources, in priority order

1. DexScreener `info.header` — a real project **banner** (verified: PEPE 1080x360 JPEG)
2. DexScreener `info.imageUrl` — the token **logo** (verified: 250x250 JPEG)
3. Official website `og:image` / `twitter:image` — HTTPS only, SSRF-guarded
4. Text card

**Verified finding:** `info.header` IS retrievable from the API (contradicting the
assumption that only a logo was available). It is a separate CDN asset from the
web-UI screenshot mockup. Both header and logo come from the address-scoped pair
payload, so they are bound to the exact (chain, contract).

**Not used, by rule:** price charts, candlestick charts, generated/random memes,
stock photos, or any image selected by matching ticker.

### Media security

- absolute HTTPS only, no credentials, default port only
- public-address check: loopback, private, link-local, CGNAT, multicast and the
  169.254.169.254 metadata IP are all rejected
- redirects followed manually with a 3-hop cap, re-validated at every hop
- `content-type` must be `image/*`; body capped at 8MB, and at 5MB for the
  Telegram URL-fetch limit
- no user-supplied URL is ever fetched for imagery

## 4. Data-safety rules (unchanged and re-verified)

- every dynamic value is escaped; `<1%` and `<-100%` are legal display strings
  and illegal HTML tag openers — unescaped they fail the entire send
- three distinct unavailable states: a value / `—` (source covers the chain but
  reported nothing) / `n/a` (chain has no such source). Never 0, never "No",
  never "Not Paid" for an unknown
- a provider **failure** says so explicitly and does not read as a clean card
- "Creator Holds" is the creator's CURRENT balance, never dev history
- `[mock]` never appears in live mode
- inconsistent provider figures are disclosed inline, still shown, not hidden

## 5. Removed at owner request

- the note `Signals only, not a safety verdict. Top 10 is the provider's top accounts as returned.` — removed, and deliberately NOT replaced with another paragraph
- Chart, Full Analysis, Premium and Explore buttons — removed; exactly one button remains
- the DYOR marketing list from the default card (DETAILED retains it)

## 6. Metric alignment: a resolved design question

Space-padding label columns was tried and **removed**. Telegram renders captions
in a proportional font, so N spaces is not a fixed width: measured in a 14.5px
system font, padded prefixes came out **58 / 81 / 96 / 78 px** for rows meant to
line up, which made the block look ragged rather than aligned. True column
alignment needs `<pre>`, which cannot mix bold/link entities. Uniform single
spacing is therefore the deliberate, documented choice — not an oversight.

## 7. Acceptance status

| Case | Result |
| --- | --- |
| A. PEPE / Ethereum | PASS — photo, banner 20,047B, full CA, 1 button |
| B. BONK / Solana | PASS — photo, banner 32,103B, `Tax: —` (no fabrication) |
| C. Banner source | PASS — Monad banner 97,438B delivered as photo |
| D. No image | PASS — HyperEVM text card, no placeholder, no duplicate |
| E. Missing risk data | PASS — all `n/a`, no false safety indicators |
| F. Hostile name / escaping | PASS — `<script>` escaped, 563 visible chars, no parse error |

6/6 real sends accepted (4 photo, 2 text). 215 automated tests passing.

**Visual inspection:** structure verified through the API send echo (entity
types, media type, keyboard, message IDs) and a local render. Final visual
sign-off on a real device is **pending OWNER approval** — the Bot API cannot
re-read a sent message's media type, so a screenshot from the client is the only
remaining evidence.
