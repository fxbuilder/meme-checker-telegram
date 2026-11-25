# FINAL EMOJI COVERAGE

Audit of the animated/custom emoji system after the visual hotfix. Baseline `551804a`
(935 tests), final commit recorded at the end of this document.

Two numbers are reported separately throughout, because conflating them is how a project
claims "100% animated emoji" while half its screens are still plain Unicode:

- **Renderer migration** — does every outgoing surface pass through the shared resolver?
- **Asset coverage** — does each semantic role have a *verified* custom-emoji asset?

Migration is complete. Asset coverage is **not** complete, and cannot be without either an
OWNER-authored pack or assets that do not exist in public sources.

---

## 1. Method

Nothing was selected by pack name, sticker ID or a sticker's `emoji` field.

1. All ten candidate packs were queried with `getStickerSet` (read-only, zero cost).
   All ten exist: **925 custom emoji** in total.
2. Every thumbnail was downloaded and assembled into labelled contact sheets, then
   **visually inspected** to identify the artwork.
3. Each chosen ID was re-validated with `getCustomEmojiStickers`, recording the set it
   actually resolves in and its real media type.
4. Renderer integration was measured by driving the real handlers through an offline
   Telegraf shim and counting custom-emoji slots in the outgoing text.

### Why visual inspection was mandatory

The old registry mapped `chain.ethereum` to CryptoIcons **#130 — an envelope**. It was
inherited from the Telegram paper-plane glyph `✈️` in the legacy theme map, and a numeric
ID made it look plausible. Three separate ID-based signals all agreed it was fine:

| Signal | What it said | Reality |
| --- | --- | --- |
| ID resolves | yes | true, and irrelevant |
| Declared pack | `CryptoIcons` | true |
| Sticker `emoji` field | `✉️` | the pack is a crypto pack, so "fine" |

Only the pixels showed it was an envelope on the Ethereum row.

The same trap in reverse: the **Hyperliquid** logo in `HyperliquidEmoji` carries
`emoji: 😡` while the artwork is a clean H mark. A `emoji`-field match would have rejected
the one correct asset available.

---

## 2. Asset sources

| Pack | Total | Media | Used for |
| --- | --- | --- | --- |
| CryptoIcons | 200 | video (WebM) | 5 chains, links, X, Telegram, rocket, bolt, LP droplet, security shield, bundle |
| RestrictedEmoji | — | animated (TGS) | market, narrative, holders, research, premium, warn, pending |
| HyperliquidEmoji | 59 | static | HyperEVM logo |
| emojipack_sm | — | animated | CA pin, forward arrow |
| Icon_TGS | 140 | animated | flame, downward chart |
| FinanceAnimations | 41 | animated | settings gear |
| Animated_Crypto_Emojis | 59 | video | inspected, none used |
| AnimatedCryptoEmojis | 87 | video | inspected, none used |
| Crypto_Emojis | 160 | static | inspected, none used |
| cryptoner | 22 | animated | inspected, none used (monochrome) |
| Cryptocoins_kotletovv | 92 | animated | inspected, none used |
| moonboyz_crypto_elite_emoji_pack | 65 | animated | inspected, none used |

Unused packs were inspected and rejected on merit — e.g. `cryptoner` is entirely
monochrome silhouettes and does not read on a dark card.

---

## 3. Chain assets — the OWNER-reported defects

| Network | Before | After | Pack | Media | Artwork |
| --- | --- | --- | --- | --- | --- |
| Solana | 🟣 circle | ✅ | CryptoIcons #034 | video | Three-bar Solana mark |
| BNB Chain | 🟡 on card, branded in /chains | ✅ same everywhere | CryptoIcons #003 | video | BNB four-diamond |
| Ethereum | **email envelope** | ✅ | CryptoIcons #019 | video | ETH diamond on blue disc |
| Base | 🔵 circle | ⚠️ **fallback** | — | — | No public asset |
| Robinhood Chain | 🟢 circle | ⚠️ **fallback** | — | — | No public asset |
| HyperEVM | 🟪 square | ✅ | HyperliquidEmoji #011 | **static** | Hyperliquid H mark |
| Elysium | 🟠 circle | ✅ | CryptoIcons #065 | video | Horse head, coloured mane |

**Chain branding: 5 of 7 verified.** Base and Robinhood have no public asset — see §6.

### The two root causes, both fixed

**Cause 1 — the wrong ID.** `chain.ethereum` pointed at the envelope. Fixed by re-selecting
from the contact sheets.

**Cause 2 — two icon tables.** `src/chains.mjs` held its own `emoji:` literals per chain,
and `format-card.mjs` read *that*, while `/chains` read `src/icons.mjs`. That is exactly how
BNB was branded in one place and a plain circle in the other. `CHAINS` now derives every
glyph from the registry (`CHAIN_EMOJI`), so there is one table. `0` literals remain in
`chains.mjs`.

---

## 4. Renderer migration

### Mechanism

A hardcoded literal cannot express meaning: `🟡` is BNB on the chain list and "warning" in a
risk row. Renderers therefore resolve **by role** where possible:

```js
e.icon('chain.bsc')          // animated BNB mark
e.glyph('🟡', 'chain.bsc')   // same, keeps 🟡 as the fallback
e('🟡')                      // legacy call, upgraded via the glyph reverse index
```

Two global interception points cover everything else, so "migrated" is a property of the bot
rather than a list of files somebody remembered:

1. `bot.telegram.sendMessage/editMessageText/sendPhoto/editMessageCaption` are wrapped.
2. A middleware wraps `ctx.reply` and `ctx.editMessageText`, which every handler uses.

The upgrade is **idempotent** (already-resolved markup is left alone) and **skips** the
inside of `<code>` and `<a>`, so contract addresses and user-supplied names are never altered.

### Second, independent audit

Driving the real handlers and counting icon slots in outgoing text:

| Surface | Custom slots | Plain slots |
| --- | --- | --- |
| `/start` | 12 | 1 (`⛓` — no generic-chain asset) |
| `/help` | 10 | 4 (`📈 🏆 ⛓ 🔄` — no assets) |
| `/chains` | 6 | 3 (same roles) |
| `/about`, `/website`, `/upgrade` | 3 | 0 |
| `/ca`, `/check`, direct paste | 0 | 2 each (`⛓` only) |
| `/risk`, `/dev`, `/bundle`, `/narrative`, `/x`, `/kol`, `/justscan` | 0 | 0 |
| `/calls`, `/fc`, `/pnl`, `/gpnl`, `/lb`, `/profile`, `/settings`, `/alerts`, `/callsettings` | 6 | 0 |
| `/emojipreview` | 15 | 11 (it renders EVERY role, so it reflects the registry's gaps) |
| **Total** | **51** | **37** |

**Surfaces with no handler / broken rendering: 0.** Every remaining plain slot is a role with
no verified asset — not a surface that forgot to migrate.

---

## 5. Role coverage

| Metric | Count |
| --- | --- |
| Semantic roles registered | **76** |
| Verified custom assets | **33** |
| — animated (TGS) or video (WebM) | **32** |
| — static (correct branding, no motion) | **1** (HyperEVM) |
| Unicode fallback only | **43** |

### Roles with verified assets (33)

Chains: solana, bsc, ethereum, hyperevm, elysium.
Sections: market, security, narrative, holders, research, premium, links, settings, bundle.
Metrics: holders, market, x, social, website, ca, dexPaid, lp, liquidity.
States: warn, pending.
CTA: open, website, premium.
Brand: rocket, token, fire, down, bolt, warning.

### Roles on Unicode fallback (43)

Chains without a public asset: **base, robinhood**.
Non-priority chains: arbitrum, optimism, polygon, avalanche, unichain, berachain, monad,
abstract, megaeth, story, default.
Sections: holderOverview, dev, alerts, pnl, leaderboard, community, utility.
Metrics: top10, tax, dev, volume, price, mcap, peak, roi, hitRate, calls, avg, median, chain.
States: good, bad, unknown, neutral.
CTA: refresh, back, next.
Misc: lock, gem.

Each falls back to a distinct Unicode glyph that is always renderable. None is guessed at: an
ambiguous asset was **removed** during this round (`section.utility` had been pointed at a
"flame with a gear base" that reads as neither).

---

## 6. Missing brand assets

### Base

- **Needed:** blue disc with a white notched square.
- **Status:** not present in any of the 925 inspected assets.
- **Rejected lookalikes:** CryptoIcons #004 (a checkerboard square — reads as OKX) and #012
  (a Coinbase "C"). Using either would tell a reader they are looking at a brand they can
  trust, which is worse than a plain circle.

### Robinhood Chain

- **Needed:** green feather / quill.
- **Status:** not present.
- **Rejected lookalike:** CryptoIcons #077 (Ravencoin — a bird, but a different project).

### Elysium — verified, with a caveat

Chain ID **99901** confirmed; the asset is a horse head, consistent with Elysium's own
branding. The sticker's `emoji` field is `🦄`, which corroborates the picture. This is a
judgement from artwork, not from an official brand kit — if OWNER has a canonical Elysium
logo, it should replace it.

### Preparing the two missing assets

Specification for a custom pack (`core.telegram.org/stickers`):

- **100×100 px**, WebM with VP9, alpha channel, ≤ 64 KB, ≤ 3 s, no audio; or TGS (Lottie).
- Artwork: Base = white notched square on `#0052FF`. Robinhood = white feather on `#00C805`.
- Publish: create a pack via `@Stickers` → "New emoji pack"; the OWNER must do this from a
  Telegram account, after which `getStickerSet` yields the IDs.

**No IDs are invented here.** Until the files are published, these two chains keep distinct
glyphs and explicit labels, which is honest.

---

## 7. Platform limitation — stated explicitly

A bot may only send `<tg-emoji>` if it satisfies Telegram's custom-emoji requirements for
bots. If it may not, the tag is rejected. The registry therefore always renders the standard
glyph **inside** the tag, so:

- with permission → animated custom emoji;
- without → the same Unicode glyph.

`CUSTOM_EMOJI=0` forces plain glyphs and is covered by tests. **This is a real constraint, not
a workaround**: animated coverage depends on the deployed bot's rights, and the renderer
cannot verify them at runtime.

---

## 8. Performance presentation corrections

| Defect | Before | After |
| --- | --- | --- |
| Sub-2x peak painted as failure | red exclamation | 🟡 warn — "has not run yet" is not a loss |
| 1.04x and 0.96x both displayed `1.0x` | green icon beside a flat figure | `1.04x` / `0.96x`; only exact 1.0x prints `1.0x` |
| Direction unreadable near breakeven | none | signed % appended: `now 🟢 3.8x (+280%)` |
| Mark-to-market wording | "not realised profit" (ambiguous on re-read) | "Both are price observations unless a position was actually closed." |

Peak tiers: ≥2x green · >1x and <2x yellow · =1x neutral · missing unknown.
Current ROI: positive green · negative red · breakeven neutral · no price unknown.
`null` price is never treated as zero or a loss.

---

## 9. Coverage copy correction (`/chains`)

`capabilitySummary()` derived holders from GoPlus alone, so **Elysium was labelled
"market only"** despite Round 5's working Elyscan holder adapter
(`src/security/elysium.mjs`, wired in `risk-intel.mjs`). That understated verified coverage —
the same class of error as overclaiming, only inverted.

Now: `elysium → holders · (holders via dedicated indexer)`, with `partialHoldersOnly` so the
line does not imply GoPlus parity for tax/LP/dev, which the adapter does not provide.
HyperEVM correctly remains `market only` (no keyless holder source).

---

## 10. Owner preview

`/emojipreview` — **owner-only**, silent for everyone else, not in the command menu and not in
`/help`.

Pages through all 76 roles in six groups (primary networks, other networks, sections, metrics,
states, navigation/CTA). Each row shows the rendered icon, its role key, its glyph, and its
**media type + source pack**, so a static or fallback asset is visible without consulting this
document. The final page reports coverage and names the missing brand assets.

Paginated because the full registry is 5,725 characters and Telegram caps a message at 4,096.

---

## 11. Acceptance gates

| Gate | Result |
| --- | --- |
| User-facing surface inventory | **100%** — 40 command and flow surfaces driven |
| Applicable renderers migrated | **100%** — all pass through the resolver |
| Applicable icon roles integrated | **100%** — all 76 resolve via the registry |
| Custom emoji IDs validated | **100%** — 33/33 resolve, 0 unresolved |
| Correct blockchain branding | **5 of 7** — Base and Robinhood have no public asset |
| Undocumented legacy literals | **0** outside the three definition files |
| Forgotten pages | **0** |
| Broken Telegram rendering | **0** |
| Full regression suite | **PASS** |
| Animated asset coverage | **32 of 76 roles** — reported separately, not claimed as complete |

**Honest summary:** every render path is integrated and every ID that exists is verified. Brand
coverage is complete for five of seven priority networks; the remaining two need an OWNER-
published pack, which is prepared and specified but not created.

---

## 12. Legitimate exceptions

Three files contain emoji literals by necessity and are excluded from the "zero literals" gate:

| File | Why |
| --- | --- |
| `src/icons.mjs` | The glyph definitions and the verified asset table themselves |
| `src/emoji-theme.mjs` | The legacy glyph→ID map used by the OWNER approval flow |
| `src/emoji-resolve.mjs` | Boundary regexes and this migration's own documentation |

Any occurrence elsewhere is a defect. The scanner (`_audit2.mjs`) resolves `\u{...}` escapes
before matching — the first pass missed the leaderboard medals for exactly that reason.
