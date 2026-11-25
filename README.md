# Meme Checker — Telegram Bot

A Telegram-first token intelligence bot: paste a contract address, get a Standard card with
market data, security signals, narrative context and call-tracking history. It is built around one
rule that shapes every field it renders: **a value is either measured or explicitly unknown —
never fabricated, never defaulted, never shown as a confident answer when the instrument was
blind.**

---

## Table of contents

1. [Product Overview](#1-product-overview)
2. [Installation & Quick Start](#2-installation--quick-start)
3. [Complete Environment Configuration](#3-complete-environment-configuration)
4. [Complete Command Reference](#4-complete-command-reference)
5. [Animated Custom Emoji — Complete Guide](#5-animated-custom-emoji--complete-guide)
6. [Token Scanner & Security](#6-token-scanner--security)
7. [Call Tracking & Performance](#7-call-tracking--performance)
8. [Smart Alerts](#8-smart-alerts)
9. [Core & Website Integration](#9-core--website-integration)
10. [Project Structure](#10-project-structure)
11. [Testing & Troubleshooting](#11-testing--troubleshooting)
12. [Security & Privacy](#12-security--privacy)
13. [Known Limitations](#13-known-limitations)
14. [Documentation Index](#14-documentation-index)

---

## 1. Product Overview

### What it is

Meme Checker turns a contract address into a research card. It answers the questions a trader
asks before acting: what is this token, is the market real, are holders concentrated, is the LP
locked, what does the project claim, and how have previous calls on it performed.

### Current capabilities

- **Token scan** from a pasted contract address, `/ca`, or `/check` (compatibility alias).
- **Market data**: price, market cap, FDV, liquidity, volume, 24h change.
- **Security signals**: holder count, Top-10 concentration, transfer tax, LP burn/lock status,
  creator holding, Dex Paid status, honeypot/mint/freeze flags where a provider covers them.
- **Narrative**: what the project itself published, with provenance, or an explicit
  "unavailable" — never an invented summary.
- **Call tracking**: automatic and manual calls per group, with first-caller attribution, peak
  multiplier and current mark-to-market.
- **Caller profiles and leaderboards**, ranked deterministically, group-isolated.
- **PnL images**, with per-user custom backgrounds.
- **Smart alerts**: multiplier milestones and Dex Paid transitions.
- **X / KOL research**: cached previews only; ordinary scans make zero paid X requests.

### Telegram bot responsibilities

The bot is the **presentation and interaction layer**. It:

- resolves a contract address to a chain without silently guessing;
- fetches market data and on-chain risk signals from free providers;
- classifies risk against a single threshold source and renders the card;
- records and scores calls inside a group, and generates PnL images;
- delivers alerts and manages per-group settings;
- links out to the website for anything requiring deeper (paid) analysis.

### Website and Core backend responsibilities

The website and Core backend own what a Telegram bot should not:

- full token pages and deep analytics;
- paid X/KOL intelligence;
- historical series and charting;
- wallet-level analysis (bubble maps, bundle tracing at scale);
- any feature requiring a database larger than one group's call history.

The bot never fabricates a website URL. If `TOKEN_PAGE_BASE_URL` is not configured, no CTA is
rendered at all — a dead button is worse than no button.

### Architecture overview

```
Telegram  ──▶  src/bot.mjs  (Telegraf, command registry, middleware)
                     │
                     ├─▶ scanner / live-scan        → market data (DexScreener)
                     ├─▶ risk-intel                 → GoPlus, RugCheck, Elyscan, listed RPCs
                     ├─▶ research/*                 → narrative, X previews (cached)
                     ├─▶ format-card / card-layout  → the Standard card
                     ├─▶ delivery                   → photo caption or text, with fallback
                     ├─▶ calls / call-service       → group call history
                     ├─▶ leaderboard                → deterministic ranking
                     └─▶ pnl-render / render_pnl.py → PNG cards
```

Every outgoing message passes through one emoji resolver and one delivery path, so a surface
cannot quietly diverge from the rest.

### Seven priority blockchains

| Network | Notes |
| --- | --- |
| Solana | Full holder and LP coverage via RugCheck |
| BNB Chain (56) | GoPlus-covered EVM chain |
| Ethereum (1) | GoPlus-covered; Top-10 can be partial for some established tokens |
| Base (8453) | GoPlus-covered |
| Robinhood Chain (4663) | Pons launchpad intelligence |
| HyperEVM (999) | Market data only — **no keyless holder source exists** |
| Elysium (99901) | Dedicated Elyscan holder adapter |

### Additional networks and reduced data coverage

Additional EVM chains remain market-scannable but are never headlined: Arbitrum, Optimism,
Polygon, Avalanche, Unichain, Berachain, Monad, Abstract, MegaETH. Story is recognised but has no
market data source. `/chains` lists the priority networks first and labels everything else as
reduced coverage.

**The bot never claims a capability the data source does not provide for that specific chain.**

---

## 2. Installation & Quick Start

### System requirements

| Requirement | Version | Notes |
| --- | --- | --- |
| Node.js | **20 LTS or newer** (tested on 24.11.1) | Uses native `--env-file`, `fetch`, `node:test` |
| npm | 9 or newer (tested on 11.6.2) | |
| Python | 3.9+ **with Pillow** | Only for PnL PNG generation; the card falls back to text without it |
| OS | Windows, Linux, or macOS | Verified on Windows 11 |

`node --env-file` requires Node 20.6+. The test runner uses `node:test`, stable from Node 20.

### Clone and install

```bash
git clone <repository-url> meme-checker-telegram
cd meme-checker-telegram
npm install
```

The only runtime dependency is `telegraf`.

### Environment configuration

Copy the example file and fill it in.

**Windows CMD**
```bat
copy .env.example .env
notepad .env
```

**PowerShell**
```powershell
Copy-Item .env.example .env
notepad .env
```

**Linux / VPS**
```bash
cp .env.example .env
nano .env
chmod 600 .env
```

At minimum set `TELEGRAM_BOT_TOKEN`, `OWNER_USER_IDS` and `ALLOWED_CHAT_IDS`.

### BotFather configuration

1. Message **@BotFather** → `/newbot`, choose a name and a username ending in `bot`.
2. Copy the token into `TELEGRAM_BOT_TOKEN`.
3. `/setcommands` → paste the command list from [§4](#4-complete-command-reference) if you want
   the Telegram menu populated (the bot also sets it on startup).
4. `/setprivacy` → **Disable** if you want the bot to see every group message (required for
   automatic call tracking on pasted addresses). With privacy mode **on**, the bot only receives
   commands and replies addressed to it.
5. `/setjoingroups` → Enable if you want the bot added to groups.

### Private chat setup

Direct messages work without extra configuration. The bot answers scans in DM, but call history
and PnL are **per group** — those commands explain this rather than failing silently.

### Group setup

1. Add the bot to the group.
2. Add the group's chat id (a negative number, e.g. `-5333984336`) to `ALLOWED_CHAT_IDS`. Without
   it the bot ignores the group entirely — no scan, no reply, no call record.
3. Grant **Delete messages** if you want the bot to clean up pickers, and **Send photos** for PnL
   and photo cards.

The allowlist is deliberate: an unlisted group is ignored completely rather than partially served.

### Startup and shutdown

**Windows CMD**
```bat
npm start
```

**PowerShell / Linux**
```bash
npm start                 # live mode (sets SCAN_MODE=live)
npm run start:mock        # fixture mode, no network calls
```

`npm start` overrides `SCAN_MODE` to `live` regardless of what `.env` says — intentional, so a
stale `SCAN_MODE=mock` cannot make a production bot serve fixtures.

Stop with `Ctrl+C`; a clean shutdown flushes the call store.

### Single-poller requirement

**Run exactly one instance per bot token.** Two pollers cause `409 Conflict` and both behave
erratically because each consumes a random subset of updates. If you see `409`, something else is
already polling that token.

---

## 3. Complete Environment Configuration

Every variable below is actually read by the implementation. Placeholders only — never commit real
values.

### Telegram

| Name | Purpose | Req | Default | Example | Where to obtain |
| --- | --- | --- | --- | --- | --- |
| `TELEGRAM_BOT_TOKEN` | Bot API credential. Without it the process exits. | **Yes** | — | `123456789:AA...` | @BotFather → `/newbot` or `/token` |

### Access control

| Name | Purpose | Req | Default | Example | Where to obtain |
| --- | --- | --- | --- | --- | --- |
| `OWNER_USER_IDS` | Comma-separated user ids allowed to run OWNER-only commands. | **Yes** | empty | `1307106746` | Your id from @userinfobot |
| `OWNER_USER_ID` | Singular alias for the above. | No | — | `1307106746` | As above |
| `ALLOWED_CHAT_IDS` | Comma-separated chat ids the bot will answer in. An unlisted chat is ignored. | **Yes** | empty | `-5333984336` | Group info bot, or the startup log |
| `TELEGRAM_TEST_GROUP_ID` | Fallback for `ALLOWED_CHAT_IDS`. | No | — | `-5333984336` | As above |
| `CALLER_LINK_SECRET` | Signing secret for First-Caller deep links. Without it links do not survive a restart; the bot warns at startup. | No (warned) | empty | any long random string | `openssl rand -hex 32` |

### Scan behaviour

| Name | Purpose | Req | Default | Example |
| --- | --- | --- | --- | --- |
| `SCAN_MODE` | `mock` (fixtures, no network) or `live`. | No | `mock` in example; `npm start` forces `live` | `live` |
| `CARD_VIEW` | Library default card density. Only the Standard view is public. | No | `compact` | `compact` |
| `DEFAULT_EVM_CHAIN` | Chain assumed for a bare `0x…` address when resolution is ambiguous. | No | `bsc` | `bsc` |
| `RESEARCH_ON_SCAN` | `on`/`off` — narrative enrichment during a scan. | No | `on` | `on` |
| `RESEARCH_TIMEOUT_MS` | Research ceiling per scan; never blocks the market card. | No | `2500` | `2500` |
| `REFRESH_COOLDOWN_MS` | Minimum gap between Refresh taps on one card. | No | `8000` | `8000` |
| `GROUP_COOLDOWN_MS` | Per-group scan cooldown. | No | internal | `5000` |
| `PRIVATE_COOLDOWN_MS` | Per-user DM cooldown. | No | internal | `3000` |

### Call tracking / observer

| Name | Purpose | Req | Default | Example |
| --- | --- | --- | --- | --- |
| `CALLS_DB_PATH` | Durable call history file. | No | `./data/calls.json` | `./data/calls.json` |
| `OBSERVER` | Enable the background price observer. | No | on | `on` |
| `OBSERVER_INTERVAL_MS` | Observer cycle interval. | No | `20000` | `20000` |
| `OBSERVER_MAX_TOKENS` | Tokens refreshed per cycle. | No | `12` | `12` |
| `OBSERVER_CONCURRENCY` | Parallel price lookups per cycle. | No | `3` | `3` |

### PnL images

| Name | Purpose | Req | Default | Example | Where to obtain |
| --- | --- | --- | --- | --- | --- |
| `PNL_PYTHON` | Interpreter for the PNG renderer. | No | `python`, then `python3` | `C:\Python312\python.exe` | `where python` |
| `PNL_BG_STORE` | Per-user PnL background store. | No | `data/pnl-backgrounds.json` | `./data/pnl-backgrounds.json` | — |

Python must have **Pillow** installed (`pip install Pillow`). Without it, `/pnl` explains the
missing dependency instead of failing silently.

### Custom emoji

| Name | Purpose | Req | Default | Example | Where to obtain |
| --- | --- | --- | --- | --- | --- |
| `CUSTOM_EMOJI` | Enable animated custom emoji. `0` forces plain Unicode glyphs. | No | **on** | `1` | Set `0` only if the bot may not send `<tg-emoji>` |
| `EMOJI_THEME` | JSON map of `{ "glyph": "custom_emoji_id" }` applied on top of the registry. | No | empty | `{"🚀":"5292284235711784694"}` | See [§5](#5-animated-custom-emoji--complete-guide) |

### Website / premium integration

| Name | Purpose | Req | Default | Example | Where to obtain |
| --- | --- | --- | --- | --- | --- |
| `TOKEN_PAGE_BASE_URL` | Token page origin. No CTA is rendered when unset. | No | empty | `https://memechecker.example` | Core team |
| `PREMIUM_URL` | Premium/VIP destination. Button hidden when unset. | No | empty | `https://memechecker.example/premium` | Core team |
| `CORE_API_BASE_URL` | Core backend base URL (reserved; see §9). | No | empty | `https://api.example` | Core team |
| `CORE_API_TOKEN` | Core backend credential (reserved). | No | empty | — | Core team |

### Optional X / research keys

| Name | Purpose | Req | Default | Example | Where to obtain |
| --- | --- | --- | --- | --- | --- |
| `GETXAPI_KEY` | GetXAPI key for OWNER research only. Never printed or logged. | No | empty | — | GetXAPI |
| `SORSA_API_KEY` | Alternative X provider. | No | empty | — | Sorsa |
| `X_PROVIDER` | `getxapi` or `sorsa`. | No | `getxapi` | `sorsa` | — |
| `RESEARCH_X_BUDGET` | Persistent daily cap on billable X searches. | No | `20` | `20` | — |
| `RESEARCH_BUDGET_PATH` | Where the budget window is persisted. | No | `./data/research-budget.json` | — | — |
| `ETHERSCAN_API_KEY` | Enables HyperEVM holder data via Etherscan V2. Without it, HyperEVM holders read `not-configured` with the setup requirement. | No | empty | — | etherscan.io (free tier) |

**Ordinary scans, commands and the observer make zero billable X requests.** The bot shows cached
previews only.

### Optional RPC

| Name | Purpose | Req | Default | Example | Where to obtain |
| --- | --- | --- | --- | --- | --- |
| `SOLANA_RPC_URL` | Solana RPC override. | No | public mainnet-beta | `https://...` | Helius/QuickNode free tier |

### Internal / test-only

| Name | Purpose | Req | Default | Example |
| --- | --- | --- | --- | --- |
| `BOT_NO_LAUNCH` | Register handlers without starting the poller (used by tests). | No | unset | `1` |
| `NODE_ENV` | Standard Node environment flag. | No | — | `production` |
| `NODE_TEST_CONTEXT` | Set by the test runner. | No | — | — |

---

## 4. Complete Command Reference

**Two flows are primary: paste a contract address, or use `/ca`.**

`/check` remains a **compatibility alias** for `/ca` so links posted before the redesign keep
working. It is deliberately not advertised in `/help` or the Telegram menu.

### Public commands

#### Token scanning

| Command | Syntax | Description | Scope | Dependencies |
| --- | --- | --- | --- | --- |
| *(paste CA)* | `0x…` or a Solana address | Primary flow. Resolves the chain, then scans. | DM + group | Market provider |
| `/ca` | `/ca <address>` · `/ca <chain> <address>` | Explicit scan; the second form forces a chain. | DM + group | Market provider |
| `/justscan` | `/justscan <address>` | Card without the narrative research pass. | DM + group | Market provider |
| `/chains` | `/chains` | Priority networks and per-chain coverage. | DM + group | — |
| `/about` | `/about` | Version and identity. | DM + group | — |
| `/website` | `/website` | Website link, if configured. | DM + group | `TOKEN_PAGE_BASE_URL` |
| `/upgrade` | `/upgrade` | Premium teaser. | DM + group | `PREMIUM_URL` |

`/ca` example: `/ca bsc 0x0E09FaBB73Bd3Ade0a17ECC321fD13a19e81cE82`

Response: the Standard card — a photo caption with the token logo when one exists, otherwise text.

#### Narrative & research

| Command | Syntax | Description | Scope | Dependencies |
| --- | --- | --- | --- | --- |
| `/narrative` | `/narrative <address>` | What the project itself published, with provenance. | DM + group | Free providers |
| `/x` | `/x <address>` | Cached X discussion preview. | DM + group | **None** (no paid call) |
| `/kol` | `/kol <handle>` | Recorded public calls by an X account. | DM + group | Cache only |

#### Security

| Command | Syntax | Description | Scope | Dependencies |
| --- | --- | --- | --- | --- |
| `/risk` | `/risk <address>` | Full security and holder detail. | DM + group | GoPlus / RugCheck / Elyscan |
| `/dev` | `/dev <address>` | Creator address and holding. | DM + group | GoPlus |
| `/bundle` | `/bundle <address>` | What can and cannot be measured about bundling. | DM + group | GoPlus |

#### Call tracking

| Command | Syntax | Description | Scope | Dependencies |
| --- | --- | --- | --- | --- |
| `/call` | `/call <address>` | Record a call manually. | **Group only** | — |
| `/calls` | `/calls` | Recent calls in this group. | **Group only** | — |
| `/fc` | `/fc <address>` | Who called a token first. | **Group only** | — |
| `/callsettings` | `/callsettings [autocall on\|off] [minmc <usd>]` | Auto-call and minimum market cap. | **Group, admin** | — |
| `/pnl` | `/pnl [address]` | Shareable PnL image for this group. | **Group only** | Python + Pillow |
| `/gpnl` | `/gpnl` | Group performance summary. | **Group only** | — |
| `/profile` | `/profile` | Your caller profile, or via a deep link. | Group + DM link | — |
| `/lb` · `/leaderboard` | `/lb [period]` | Caller leaderboard for this group. | **Group only** | — |

#### PnL personalisation

| Command | Syntax | Description | Scope | Dependencies |
| --- | --- | --- | --- | --- |
| `/pnlbg` | `/pnlbg` then send an image | Set a personal PnL background. | **DM only** | — |
| `/pnlreset` | `/pnlreset` | Restore the default background. | **DM only** | — |

#### Alerts & settings

| Command | Syntax | Description | Scope | Dependencies |
| --- | --- | --- | --- | --- |
| `/alerts` | `/alerts` | Alert subscriptions for this chat. | DM + group | — |
| `/settings` | `/settings` | Per-chat scan and alert settings. | DM + group; admin in groups | — |
| `/resettheme` | `/resettheme` | Reset the emoji theme to the standard set. | DM + group | — |
| `/help` | `/help` | Grouped command list. | DM + group | — |

### OWNER-only commands

| Command | Syntax | Description | Notes |
| --- | --- | --- | --- |
| `/alerttest` | `/alerttest` | Test alert delivery. | Silently ignored for non-owners |
| `/emojipreview` | `/emojipreview` | Visual preview of every icon role, with media type and source pack. | Silent for non-owners; not in the menu |

`/emojipreview` is paginated. The final page reports coverage and names missing brand assets.

### Legacy compatibility aliases

| Command | Behaviour |
| --- | --- |
| `/check <address>` | Identical to `/ca`, plus a one-line tip. Kept because old pinned messages reference it. |
| `/short` · `/detail` · `/standard` · `/compact` | Do not switch views. Each replies "Standard card is now the default view." There is one card layout. |

**Not present anywhere:** card modes as a feature. Only the commands listed above are
registered; the Telegram menu contains nothing else.

---

## 5. Animated Custom Emoji — Complete Guide

### Architecture

Two modules, one responsibility each:

- **`src/icons.mjs`** — the registry. Every role, its Unicode glyph, its verified custom-emoji ID,
  the pack it actually resolves in, its media type, and a description of the artwork.
- **`src/emoji-resolve.mjs`** — the renderer. Turns a role or a legacy glyph into the right output,
  and upgrades outgoing text.

Renderers ask for a **role**, never a raw ID:

```js
e.icon('chain.bsc')          // animated BNB mark
e.icon('section.market')     // animated bar chart
e('🟡')                      // legacy literal, upgraded via the glyph reverse index
```

### How custom emoji work in Telegram

A `<tg-emoji emoji-id="...">🟡</tg-emoji>` tag asks the client to substitute artwork for the
fallback glyph. Requirements:

- The **bot** must be permitted to send custom emoji. A bot without a Fragment username or
  sufficient rights has the tag rejected — which is why the registry always embeds a plain glyph
  inside the tag.
- The **viewer** needs no Premium to see them.
- IDs are decimal strings, 15+ digits. They exceed `Number.MAX_SAFE_INTEGER`, so **they are stored
  as strings everywhere** — storing one as a number silently corrupts the last digits.

### `CUSTOM_EMOJI`

On by default. `CUSTOM_EMOJI=0` forces plain Unicode glyphs, which is the correct setting if the
deployed bot may not send custom emoji. The card remains complete and readable either way, because
every glyph is inside the tag as the fallback.

### `EMOJI_THEME`

An optional JSON map layered on top of the registry, keyed by the standard glyph:

```json
{ "🚀": "5292284235711784694", "🟡": "5289735748147226132" }
```

It exists for the OWNER approval flow (preview → confirm → apply). When absent the registry is
authoritative. A bare theme function is normalised automatically, so a caller cannot break the
renderer by passing the wrong shape.

### The renderer and where it applies

One interceptor upgrades outgoing text. The Telegraf signatures differ per method, and each is
patched at its own position:

| Method | Text lives in |
| --- | --- |
| `sendMessage(chatId, text, extra)` | arg 2 |
| `sendPhoto(chatId, photo, extra)` | `extra.caption` |
| `editMessageText(chatId, msgId, inlineMsgId, text, extra)` | arg 4 |
| `editMessageCaption(chatId, msgId, inlineMsgId, caption, extra)` | arg 4 |

A middleware also wraps `ctx.reply`. Together these cover text messages, **photo captions** and
**callback-edited messages**. The upgrade is idempotent and skips the inside of `<code>` and `<a>`,
so contract addresses and user text are never altered.

### Verified mappings (current registry)

81 roles · 35 verified assets · 34 animated · 1 static · 46 Unicode fallback.

**Chains**

| Role | ID | Pack | Media | Artwork |
| --- | --- | --- | --- | --- |
| `chain.solana` | `5291923604487808793` | CryptoIcons | video | Solana three-bar mark |
| `chain.bsc` | `5289735748147226132` | CryptoIcons | video | BNB four-diamond |
| `chain.ethereum` | `5291927564447655889` | CryptoIcons | video | ETH diamond on blue disc |
| `chain.elysium` | `5292225356005122511` | CryptoIcons | video | Horse head |
| `chain.hyperevm` | `5801110591816866195` | HyperliquidEmoji | **static** | Hyperliquid H mark |

`chain.base` and `chain.robinhood` have **no public asset** — see §13.

**Sections**

| Role | ID | Pack | Media | Artwork |
| --- | --- | --- | --- | --- |
| `section.market` | `5431577498364158238` | RestrictedEmoji | animated | Bar chart |
| `section.security` | `5291893844659414429` | CryptoIcons | video | Shield with check |
| `section.narrative` | `5237799019329105246` | RestrictedEmoji | animated | Brain |
| `section.holders` | `5372926953978341366` | RestrictedEmoji | animated | Two people |
| `section.research` | `5188311512791393083` | RestrictedEmoji | animated | Magnifier |
| `section.premium` | `5472308992514464048` | RestrictedEmoji | animated | Padlock |
| `section.links` | `5402068075153476626` | CryptoIcons | video | Globe |
| `section.settings` | `5300999682133089708` | FinanceAnimations | animated | Gear |
| `section.pnl` | `5269460053651366623` | CryptachEmoji4 | video | Ascending candlestick |
| `section.bundle` | `5289753254433924065` | CryptoIcons | video | Segmented grid |

**Metrics, states and brand**

| Role | ID | Pack | Media | Artwork |
| --- | --- | --- | --- | --- |
| `metric.x` | `5195042564062865767` | CryptoIcons | video | X logo |
| `metric.social` | `5291812201626084541` | CryptoIcons | video | Envelope |
| `metric.website` | `5402068075153476626` | CryptoIcons | video | Globe |
| `metric.ca` | `5321006159488892145` | emojipack_sm | animated | Pin |
| `metric.dexPaid` | `5321300317504030049` | emojipack_sm | animated | Forward arrow |
| `metric.lp` / `metric.liquidity` | `5292043245096806578` | CryptoIcons | video | Droplet |
| `metric.roi` | `5269460053651366623` | CryptachEmoji4 | video | Ascending candlestick |
| `state.warn` / `misc.warning` | `5467928559664242360` | RestrictedEmoji | animated | Warning exclamation |
| `state.pending` | `5451732530048802485` | RestrictedEmoji | animated | Hourglass |
| `brand.rocket` | `5292284235711784694` | CryptoIcons | video | Rocket |
| `misc.fire` | `5440848567524677660` | Icon_TGS | animated | Flame |
| `misc.down` | `5271811599785534382` | CryptachEmoji4 | video | Descending candlestick |
| `misc.bolt` | `5291824180289872393` | CryptoIcons | video | Lightning bolt |
| `cta.open` | `5443160329376778407` | Icon_TGS | animated | Forward chevrons |
| `cta.premium` | `5472308992514464048` | RestrictedEmoji | animated | Padlock |
| `cta.website` | `5402068075153476626` | CryptoIcons | video | Globe |

### Deliberate Unicode fallbacks

**Severity dots** (`tone.good` `🟢`, `tone.warn` `🟡`, `tone.bad` `🔴`, `tone.unknown` `⚪`) have
**no custom asset, on purpose.** A dot is a colour measurement. The only status-like artwork found
across 1,725 inspected assets was `state.warn`'s exclamation mark, and using it turned one verdict
into a warning symbol while adjacent rows stayed dots — three verdicts in two visual languages.

**`brand.token` (`🪙`)** is also Unicode: every "coin" asset in those packs is a specific branded
token, and borrowing one would misrepresent the token being scanned.

### Source packs

| Pack | Assets | Media | Used for |
| --- | --- | --- | --- |
| CryptoIcons | 200 | video | chains, links, X, rocket, bolt, droplets, shield |
| RestrictedEmoji | — | animated | market, narrative, holders, research, premium, warn, pending |
| HyperliquidEmoji | 59 | static | HyperEVM |
| emojipack_sm | — | animated | pin, forward arrow |
| Icon_TGS | 140 | animated | flame, forward chevrons |
| FinanceAnimations | 41 | animated | gear |
| CryptachEmoji4 | 200 | video | candlestick charts |

Inspected but not used: Animated_Crypto_Emojis, AnimatedCryptoEmojis, Crypto_Emojis, cryptoner,
Cryptocoins_kotletovv, moonboyz_crypto_elite_emoji_pack, CryptachEmoji2/6/7.

### TGS and WebM

Telegram custom emoji are either **WebM/VP9** (video) or **TGS** (gzipped Lottie JSON). Both
animate. A **static** WebP or PNG is also valid and renders without motion — which is why HyperEVM
is reported as static rather than animated.

### Retrieving IDs

```bash
# All stickers in a pack, with their custom_emoji_id
curl -s "https://api.telegram.org/bot<TOKEN>/getStickerSet?name=CryptoIcons"

# Details for specific IDs (authoritative media type and set)
curl -s "https://api.telegram.org/bot<TOKEN>/getCustomEmojiStickers?custom_emoji_ids=%5B%225291923604487808793%22%5D"
```

`getStickerSet` is read-only and costs nothing. **Always inspect the artwork itself.** An ID that
resolves proves nothing about what it looks like — in this project a perfectly valid ID pointed at
an envelope that had been used as the Ethereum logo for several rounds, and the correct Hyperliquid
logo carries `emoji: 😡` on the sticker record.

### Replacing an icon

1. Find the asset and confirm the artwork visually.
2. Edit `CUSTOM_IDS` in `src/icons.mjs`: replace `id`, and update `pack`, `idx`, `media`,
   `depicts`.
3. Run `npm test` and `/emojipreview`.

No renderer changes are needed — every surface reads the registry.

### Adding a new asset

1. Add a glyph to `GLYPHS` and a role to any renderer that should use it.
2. Add a verified entry to `CUSTOM_IDS`.
3. The glyph reverse index picks it up automatically for legacy literals.

### Creating and publishing a pack

1. Prepare 100×100 WebM/VP9 with alpha (≤ 64 KB, ≤ 3 s, no audio) or TGS.
2. In Telegram, message **@Stickers** → `/newemojipack`.
3. Add each file with its fallback emoji.
4. Publish, then read the IDs with `getStickerSet`.

This must be done from a Telegram account, so it is an OWNER action. **Never invent an ID** — an
unpublished ID is not a valid custom emoji.

### Testing with `/emojipreview`

OWNER-only, silent for everyone else. It pages through every role, showing the rendered icon, its
role key, glyph, media type and source pack. The last page reports coverage and the missing brand
assets. This is the acceptance surface: an icon that looks wrong is visible immediately.

### Troubleshooting icons not appearing

| Symptom | Cause | Fix |
| --- | --- | --- |
| No custom emoji anywhere | `CUSTOM_EMOJI=0` | Set to `1` |
| Card plain but `/chains` animated | Stale process | Restart after deploying |
| Some icons plain, some animated | Those roles have no asset | Expected — documented gap |
| Message rejected by Telegram | Bot may not send custom emoji | Set `CUSTOM_EMOJI=0` |
| Icon inside a link renders plain | **Platform limitation** — Telegram does not emit `custom_emoji` entities within `<a>` text | Move the icon outside the link |
| Everything plain after an edit | Syntax error swallowed at load | `node --check src/icons.mjs` |

### Known platform limitations

- **Hyperlinks**: custom emoji inside `<a>` tags are stripped by Telegram. Verified live — a card
  with 9 expected entities returned 7, the 2 missing being inside anchors.
- **Bot rights**: animated coverage depends on the deployed bot's permissions, which the renderer
  cannot check at runtime.
- **No 100% animation coverage.** 34 of 81 roles are animated; the rest are static or Unicode.

---

## 6. Token Scanner & Security

### The Standard card

One layout, no modes. Sections: identity, market, security, narrative, project links, footer.
Delivered as a **photo caption** when a token logo exists, otherwise as text. If the caption
exceeds Telegram's 1024-character limit it is delivered as a text message rather than truncated — a
contract address or risk warning is never cut.

### Market metrics

Price, market cap, FDV (shown only when different from market cap), liquidity, 24h volume, 24h
change. A missing metric renders as `—`, never `0`.

### Holder concentration

Holder count and Top-10 percentage. Three outcomes are distinguished: **measured**, **partial**
(fewer than 10 holders exist, so full coverage is impossible), and **unknown**.

### Tax and transfer fees

Buy/sell tax from GoPlus where the chain is covered. A provider failure is reported as unavailable
— never as 0%, which would read as "no tax".

### LP burn and lock

- **V2 pairs**: liquidity read directly, burn-address balance checked.
- **V3/V4**: liquidity lives on a position NFT, not the pair, so it cannot be read the same way.
  Where the position cannot be discovered, the card says so instead of claiming a lock.
- A detected pool type is **not** proof of a lock.
- Graduation is **not** proof of permanent locking.

### Bonding curves

Launchpad tokens (Pons on Robinhood Chain) are identified by their factory, and the launch phase is
decoded from the factory record — requiring the token address to echo at word 0, because a factory
that does not know a token returns zeros rather than reverting.

### V2 / V3 / V4 limitations

V3 stores liquidity on the position; V4 stores it in the PoolManager keyed by poolId. One ABI
cannot serve both, and a position's liquidity is **not** a share of the pool — the bot never divides
and calls it a locked percentage.

### Risk classification

All thresholds live in a single module (`src/risk-classify.mjs`) so the same token cannot be
classified differently on two screens. Incomplete holder counts are never presented as complete
coverage.

### Unknown and unavailable data

The distinction is preserved throughout:

- **unknown** — no source exists for this field;
- **unavailable** — a source exists but failed this time;
- **not applicable** — the chain has no such concept (Solana has no ERC-20 transfer tax).

A dash means unmeasured. It never means safe.

### Narrative provenance

Narrative is what the project itself published, with the source recorded. Where a project's own
pages contradict each other, the disagreement is reported with each page attributed rather than one
being silently chosen.

### Chain-specific limitations

| Chain | Limitation |
| --- | --- |
| HyperEVM | No keyless holder source exists; holders and Top-10 are unknown |
| Elysium | Holders via Elyscan; no tax or LP feed |
| Ethereum | GoPlus omits `holders[]` for some established tokens |
| Solana | No transfer-tax concept (reported as not applicable) |
| Robinhood Chain | Latent graduation discovery can be slow; reports incomplete, never a negative |

---

## 7. Call Tracking & Performance

### Automatic and manual calls

`/callsettings autocall on` records a call when someone pastes a contract in the group. `/call`
records one explicitly. Calls are **per group** and never merged across groups.

### First caller

`/fc` reports who called a token first. Attribution is preserved through duplicates: a `superseded`
record owns nothing.

### Call history

`/calls` lists recent calls. Synthetic, cancelled and superseded records are excluded everywhere —
they cannot inflate a hit rate or appear in a leaderboard.

### Peak multiplier

The highest multiple the token reached **after** the call. A historical observation: a call that
touched 5x and fell back still shows 5x.

### Current ROI

Mark-to-market against the call's entry price. This is **not realized profit** and the card says so
explicitly.

### Hit rate

Calls whose peak reached ≥2x, divided by calls with a usable peak. Calls with no observed peak are
excluded from the rate rather than counted as misses.

### Caller profiles

Calls are sorted by **peak multiplier descending** by default, over the whole period dataset
**before** pagination, with deterministic tiebreaks (multiple → time → token key). Inline buttons
switch between *Best Calls* and *Current ROI*, and between 1D / 1W / 2W / 1M; changing either resets
to page 1.

Peak tone: ≥2x green, >1x and <2x yellow, =1x neutral, unknown. Current ROI: positive green,
negative red, breakeven neutral, no price unknown.

A multiple that rounds to 1.0x is displayed with more precision (or a signed percentage) so a real
gain or loss is never shown as flat.

### Leaderboard ranking

Default ranking is **Best Call**. Alternatives: Hit Rate and Average Peak. Medal icons mark the top
three. Hit-rate ranking requires a minimum sample of **2** measured calls so a single lucky call
cannot lead the board. A caller with no measured calls sorts last.

### Group isolation

Every query is scoped to one group. A profile link opened in DM re-derives the group from a signed
token; it never reads the DM's own (empty) history.

### Period filters and pagination

1D, 1W, 2W, 1M. Pagination state is part of the callback payload, so a button tap is
self-describing.

### PnL image generation

`/pnl` renders a PNG via Python + Pillow. Without Python or Pillow the bot explains the missing
dependency rather than going silent.

### PnL background customization

`/pnlbg` in **DM** — the next image you send becomes your background (JPEG/PNG/WebP, ≤5 MB).
`/pnlreset` restores the default. The image is stored as a Telegram `file_id`, never as a downloaded
file and never as a URL containing the bot token, because the PnL card is shareable. It is dimmed
behind the text: legibility outranks showing every pixel.

### Peak vs current vs realized

| Term | Meaning |
| --- | --- |
| Peak | Highest price observed after the call — historical |
| Current | Present price vs entry — mark-to-market |
| Realized | Requires an actual closing trade. **This bot does not track positions**, so it never claims realized profit. |

---

## 8. Smart Alerts

| Alert | Trigger | Configuration |
| --- | --- | --- |
| Multiplier milestone | A tracked call reaches a multiple milestone | `/alerts` |
| Dex Paid | A token's DexScreener paid status changes | `/alerts` |

- **Cooldowns** prevent repeat firing for the same milestone on the same call.
- **Duplicate prevention**: a milestone already notified is not re-sent.
- **`/alerttest`** (OWNER-only) verifies delivery end-to-end without waiting for a real trigger.
- Alerts respect group isolation and the allowlist.
- An alert never claims a value that was not measured; a failed observation produces no alert rather
  than a zero-valued one.

---

## 9. Core & Website Integration

### Current boundaries

The bot is self-contained for scanning and call tracking. Website integration is **link-out only**
and entirely optional: if no URL is configured, no button appears.

### Request and response contracts

The scan result shape consumed by the card is documented in
[`docs/scan-result-contract.md`](docs/scan-result-contract.md). The full backend contract is in
[`docs/CORE-INTEGRATION-CONTRACT.md`](docs/CORE-INTEGRATION-CONTRACT.md).

### Required data fields

For a complete card: token identity (name, symbol, chain, address), market metrics, risk/holder
data, and optional narrative and project links. Every field is nullable — absence is rendered as
unknown, never defaulted.

### Status semantics

| Status | Meaning |
| --- | --- |
| `ok` | Data returned |
| `error` | Provider failed — this says nothing about the token |
| `unsupported` | No source covers this chain |
| `rate-limited` | Throttled; retry later |

### `TOKEN_PAGE_BASE_URL` / `PREMIUM_URL`

`TOKEN_PAGE_BASE_URL` builds the "Full Analysis" CTA. `PREMIUM_URL` adds a premium button. Both
render only when set — a dead button is worse than no button.

### Premium feature boundaries

Free in Telegram: scans, risk, narrative, call tracking, leaderboards, PnL images. Premium on the
website: deep X/KOL intelligence, historical series, wallet-level analysis. **Ordinary scans never
make a paid X request.**

### Provider replacement

Providers sit behind adapters (`src/live-scan.mjs`, `src/security/*`). Replacing one means
implementing the same shape; the card and classifiers are unaffected. A configured-missing
credential is reported as `not-configured` with the exact setup requirement, never as "no data".

### Error handling and caching

Transient failures are reported, not swallowed; caches are keyed by `(chain, address)` so a cached
verdict cannot leak between tokens. GeckoTerminal is paced and 429-aware.

---

## 10. Project Structure

```
meme-checker-telegram/
├── src/
│   ├── bot.mjs                  # Telegraf setup, command registry, middleware, delivery hooks
│   ├── icons.mjs                # THE emoji registry (roles → glyphs + verified IDs)
│   ├── emoji-resolve.mjs        # Emoji renderer; upgrades outgoing text
│   ├── emoji-preview.mjs        # OWNER preview renderer
│   ├── emoji-theme.mjs          # Legacy glyph→ID map + theme builder
│   ├── start-message.mjs        # /start renderer
│   ├── help.mjs                 # /help renderer + documented-command list
│   ├── format-card.mjs          # The Standard card
│   ├── card-layout.mjs          # Rows, alignment, tone roles, section titles
│   ├── delivery.mjs             # Photo caption / text delivery with fallback
│   ├── chains.mjs               # Chain registry + capability summary
│   ├── scanner.mjs              # Scan orchestration
│   ├── live-scan.mjs            # Live market adapter
│   ├── mock-scan.mjs            # Fixture adapter
│   ├── risk-intel.mjs           # Risk aggregation across providers
│   ├── risk-classify.mjs        # THE threshold source
│   ├── calls.mjs                # Call store + metrics
│   ├── call-service.mjs         # Call recording
│   ├── caller-profile.mjs       # Profile aggregation + rendering
│   ├── leaderboard.mjs          # Deterministic ranking
│   ├── call-commands.mjs        # /call /calls /fc /pnl /profile handlers
│   ├── pnl-card.mjs             # PnL SVG
│   ├── pnl-render.mjs           # PNG pipeline
│   ├── pnl-background.mjs       # Per-user backgrounds
│   ├── alerts.mjs               # Alert rendering
│   ├── alert-service.mjs        # Alert evaluation
│   ├── settings-commands.mjs    # /settings
│   ├── access.mjs               # Owner/chat allowlist policy
│   ├── deep-link.mjs            # Signed caller links
│   ├── observer-loop.mjs        # Background price observer
│   ├── research/                # Narrative, X cache, launchpad metadata
│   └── security/                # goplus, rugcheck, elysium, hyperevm, lp-intel, positions, pons
├── scripts/render_pnl.py        # Pillow PNG renderer
├── test/                        # node:test suites
├── benchmark/                   # Coverage measurement harness + recorded runs
├── docs/                        # See §14
├── .env.example                 # Every variable, placeholders only
├── package.json
└── README.md
```

---

## 11. Testing & Troubleshooting

### Commands

```bash
npm test                                          # full suite (node:test)
node --test test/round8-caption-emoji.test.mjs    # a single suite
```

Expected: **964 passing, 0 failing.**

### What the suite covers

Regression suites for correctness fixes, risk consistency, no-false-safe behaviour, group call
tracking, PnL generation, alerts, leaderboard determinism, emoji registry integrity, renderer
migration (asserting actual payload shape, not call counts), and the photo-caption path
specifically.

### OWNER acceptance

1. `npm start`, then send `/emojipreview` — page through and confirm each icon looks correct.
2. Paste a contract address; confirm the card renders with a branded chain icon and section icons.
3. `/chains` — priority networks first, no chain count.
4. `/profile` in the group — best calls on top, peak and current shown separately.
5. `/pnlbg` in DM, send an image, then `/pnl` in the group.

### Common problems

| Symptom | Cause | Fix |
| --- | --- | --- |
| `409 Conflict` | Two pollers on one token | Stop the duplicate |
| Bot silent in a group | Chat id not in `ALLOWED_CHAT_IDS` | Add it |
| Bot ignores pasted CAs in a group | BotFather privacy mode is ON | `/setprivacy` → Disable |
| `TELEGRAM_BOT_TOKEN is not set` | Missing `.env` | Create it from `.env.example` |
| PnL says image unavailable | Python or Pillow missing | `pip install Pillow`, or set `PNL_PYTHON` |
| Icons mostly plain | `CUSTOM_EMOJI=0` | Set to `1` |
| Data missing for one chain | Documented coverage gap | See §13 |
| Provider errors | Throttling | Wait; pacing and backoff are automatic |
| `node --env-file` unsupported | Node < 20.6 | Upgrade Node |

---

## 12. Security & Privacy

- **`.env` is gitignored** and must never be committed. `.env.example` contains placeholders only.
- **No credentials in code.** Keys are read from the environment and never printed or logged.
- **`data/` is gitignored** — it holds durable call history and per-user PnL backgrounds. This is
  live group data, not source.
- **PnL backgrounds** are stored as opaque Telegram `file_id`s, resolved at render time through an
  authenticated API call. No token-bearing URL ever enters a shareable image.
- **Allowlist first.** A chat not in `ALLOWED_CHAT_IDS` is ignored completely — no scan, no reply,
  no record.
- **OWNER-only commands are silent** for everyone else, revealing nothing about their existence.
- **Operational hygiene**: run one poller, keep `.env` at `chmod 600` on a VPS, and rotate the bot
  token through @BotFather if it is ever exposed.

---

## 13. Known Limitations

Measured on a 35-token sample across all seven priority chains (see
[`docs/ROUND5-REPORT.md`](docs/ROUND5-REPORT.md)).

| Field | Coverage | Note |
| --- | --- | --- |
| Holders | **91%** (32/35) | 3 unknown |
| Top 10 | **83%** (29/35) | 1 partial (fewer than 10 holders) |
| Dex Paid | **77%** (27/35) | 8 unknown |
| Tax | **74%** (26/35) | 5 not applicable (Solana) |
| Dev | **74%** (26/35) | mostly partial |
| Narrative | **57%** (20/35) | 15 tokens publish no description anywhere |
| LP lock | **40%** (14/35) | V3/V4 positions not discoverable without a paid indexer |
| Risk consistency | **100%** (35/35) | same token, same verdict |

Additional, by design:

- **HyperEVM holders: 0%.** No keyless holder source exists; an OWNER-created free
  `ETHERSCAN_API_KEY` is required. Reported as `not-configured` with the setup requirement rather
  than "no holders".
- **Base and Robinhood logos** have no verified custom-emoji asset. Both keep distinct glyphs and
  labels; the artwork spec is in `docs/FINAL-EMOJI-COVERAGE.md` §6.
- **34 of 81** icon roles are animated. Static and Unicode fallbacks remain and are listed in §5.
- **Custom emoji inside `<a>` links** are stripped by Telegram.
- **Not a safety oracle.** A clean card is not a guarantee. Data can be incomplete, providers can be
  wrong, and nothing here is financial advice.
- **Not complete chain coverage.** Non-priority chains are market-only.

---

## 14. Documentation Index

| Document | Contents |
| --- | --- |
| [`docs/CORE-INTEGRATION-CONTRACT.md`](docs/CORE-INTEGRATION-CONTRACT.md) | Backend contract for the Core team |
| [`docs/scan-result-contract.md`](docs/scan-result-contract.md) | Scan result shape consumed by the card |
| [`docs/KNOWN-GAPS.md`](docs/KNOWN-GAPS.md) | Honest gap list |
| [`docs/FINAL-EMOJI-COVERAGE.md`](docs/FINAL-EMOJI-COVERAGE.md) | Emoji audit, missing assets, pack spec |
| [`docs/ROUND8-CARD-EMOJI-FIX.md`](docs/ROUND8-CARD-EMOJI-FIX.md) | Caption-path defect and live verification |
| [`docs/ROUND6-REPORT.md`](docs/ROUND6-REPORT.md) | Final UI/UX round |
| [`docs/ROUND5-REPORT.md`](docs/ROUND5-REPORT.md) | Priority-chain data intelligence + benchmark |
| [`docs/ROUND4-REPORT.md`](docs/ROUND4-REPORT.md) | Correctness round |
| [`docs/security-coverage.md`](docs/security-coverage.md) | Per-chain security source matrix |
| [`docs/card-ui-and-chains.md`](docs/card-ui-and-chains.md) | Card layout and chain behaviour |
| [`docs/running-locally.md`](docs/running-locally.md) | Local run notes |
| `docs/OWNER-*.md` | Acceptance records from earlier rounds |

**Stale documents:** `docs/FINAL-HANDOFF.md` and `docs/handoff.md` predate the current
implementation and are retained for history only. Where they disagree with this README or the code,
the code wins.

---

## License

Proprietary. All rights reserved unless a separate licence is provided by the OWNER.
