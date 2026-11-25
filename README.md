# Meme Checker — Telegram Bot

A Telegram-first token scanner and call-tracking bot for seven priority chains. Scans a
contract address, renders a risk card, tracks group calls with measured PnL, and shows a
narrative summary where a project actually published one.

**This bot reports what it measured and says `unknown` otherwise. It does not guarantee that a
token is safe.** A green field means the check passed, never that the token is safe to buy.

- Staging bot: [@MemeCheckerStagingBot](https://t.me/MemeCheckerStagingBot)
- Branch: `mc/phase7-integrated` (local only — **not pushed**)
- Release candidate: see `docs/FINAL-HANDOFF.md` for the commit hash

---

## Requirements

- **Windows** (developed and tested here), or any OS with a POSIX shell
- **Node.js 20+** (verified on v24.11.1)
- A Telegram bot token from [@BotFather](https://t.me/BotFather)

One runtime dependency: `telegraf`.

---

## Installation

```bat
git clone <repo-url> meme-checker-telegram
cd meme-checker-telegram
npm install
```

Create `.env` in the repository root. It is gitignored and must never be committed.

```bat
copy .env.example .env
```

Fill in at minimum:

```ini
SCAN_MODE=live
TELEGRAM_BOT_TOKEN=123456789:AA...your-token-here
OWNER_USER_IDS=1307106746
ALLOWED_CHAT_IDS=-5333984336
```

---

## Startup

**From Windows CMD, in the repository root:**

```bat
npm start
```

That is the exact startup command. It expands to:

```bat
set SCAN_MODE=live&& node --env-file=.env src/bot.mjs
```

`npm start` forces `SCAN_MODE=live` regardless of what `.env` contains, so a leftover
`SCAN_MODE=mock` cannot silently leave you in mock mode.

For fixtures only, with no network calls:

```bat
npm run start:mock
```

Wait for the `Connected as @...` log and confirm the username is the bot you intended. Stop with
`Ctrl+C`. **Run exactly one instance per bot token** — two pollers on one token make Telegram
reject `getUpdates` for both (`409 Conflict`).

---

## Environment variables

`.env` is the only credential store.

### Required

| Variable | Purpose |
| --- | --- |
| `TELEGRAM_BOT_TOKEN` | Bot token from @BotFather |
| `OWNER_USER_IDS` | Comma-separated Telegram user IDs with owner rights (bypass pacing) |
| `ALLOWED_CHAT_IDS` | Comma-separated chat IDs the bot serves. Empty = serves nobody |
| `SCAN_MODE` | `live` or `mock`. `npm start` overrides to `live` |

### Optional — features degrade gracefully

| Variable | Purpose | If unset |
| --- | --- | --- |
| `CALLER_LINK_SECRET` | Signs group-scoped caller links | Attribution still works; links unsigned |
| `CORE_API_BASE_URL` | External core API base | Uses built-in keyless providers |
| `CORE_API_TOKEN` | Bearer for the core API | Not sent |
| `TOKEN_PAGE_BASE_URL` | "Open token page" CTA target | CTA hidden |
| `PREMIUM_URL` | Premium teaser target | Teasers hidden |
| `EMOJI_THEME` | Default custom-emoji theme name | Standard Unicode emoji |
| `GETXAPI_KEY` / `SORSA_API_KEY` | Paid X search provider | X section reports not-configured |
| `RESEARCH_X_BUDGET` | Hard cap on paid X requests | No paid X spend occurs |
| `REFRESH_COOLDOWN_MS` | Per-chat pacing override | 3 s group / 1 s private |
| `DEFAULT_EVM_CHAIN` | Fallback when an EVM address is ambiguous | Never defaults silently — asks |
| `TELEGRAM_TEST_GROUP_ID` | Group used by `/alerttest` | `/alerttest` refuses to run |

**Ordinary scans make zero paid X requests.** X is queried only by `/x`, or served from cache.

`ETHERSCAN_API_KEY` is **not** a free path to HyperEVM holders — the holder endpoints require a
paid plan. See `docs/KNOWN-GAPS.md` before creating a key.

---

## Commands

30 `bot.command()` handlers plus `/start`. `/help` is generated from the live registry, so it
cannot drift from what is actually registered.

**Pasting a contract address is the primary flow.** `/ca` is the explicit form of the same
command; `/check` is kept only so links posted before Round 6 still work, and is not a
documented entry point.

### Token scanner
| Command | What it does |
| --- | --- |
| *(paste a CA)* | **Primary flow.** Auto-detects the chain for a bare address |
| `/ca <address>` | Scan a token explicitly |
| `/ca <chain> <address>` | Scan and force a chain |
| `/start` | Welcome; also resolves caller-profile deep links |
| `/justscan` | Card without the narrative research pass |
| `/chains` | Priority networks and per-chain capability |
| `/bundle` | Bundle / sniper-wallet grouping |
| `/dev` | Developer/creator holdings |

### Call tracking & PnL
| Command | What it does |
| --- | --- |
| `/call` | Record a call |
| `/calls` | List tracked calls for this group |
| `/callsettings` | Per-group call configuration |
| `/pnl` `/gpnl` | PnL summary and group detail |
| `/pnlbg` | Set a personal PnL background image (DM only) |
| `/pnlreset` | Reset the PnL background to the default |
| `/fc` | Followed callers |
| `/profile` | Caller profile (group-scoped, opens in private) |

### Narrative & intelligence
| Command | What it does |
| --- | --- |
| `/narrative` | Project description from published sources |
| `/x` | X/Twitter discussion — the only paid path |
| `/website` | Project website |
| `/kol` | KOL / community signals |

### Security
| Command | What it does |
| --- | --- |
| `/risk` | Full security detail |

### Community & leaderboard
| Command | What it does |
| --- | --- |
| `/lb` `/leaderboard` | Caller board, ranked by best call by default |
| `/alerts` | Alert subscriptions |
| `/alerttest` | Test alert delivery (owner only) |

### Retired commands

| Command | Now |
| --- | --- |
| `/check` | Alias for `/ca`. Still answers; not documented in `/help`. |
| `/short` `/detail` `/standard` `/compact` | Reply "Standard card is now the default view." There is one card layout. |

### Settings & general
| Command | What it does |
| --- | --- |
| `/settings` | Per-chat settings |
| `/resettheme` | Reset emoji theme |
| `/upgrade` | Premium teaser |
| `/help` `/about` | Help and version |

---

## Custom PnL background

`/pnlbg` in a **direct message** makes the next image you send the background of your PnL cards.
`/pnlreset` returns to the default gradient.

- Accepted: JPEG, PNG or WebP up to 5 MB. Anything else is rejected with the limit stated.
- Stored per user as a Telegram `file_id`, not as a downloaded file — the PnL image is
  shareable, and a background that embedded a token-bearing download URL would leak it into
  every shared card.
- The image is dimmed behind the text. That is deliberate: an undimmed photo made the
  secondary figures unreadable, and a legible card matters more than an unobstructed picture.
- A background that cannot be fetched falls back to the default gradient; it never blocks the
  card.
- Persisted to `data/pnl-backgrounds.json` (override with `PNL_BG_STORE`).

---

## Custom animated emoji setup

Custom emoji are attached by **sticker pack** or by **ID map**. Three input paths are supported.
Send the message in the bot's **DM as the bot owner**; the owner account needs Telegram Premium
so it can *send* custom emoji. Viewers do not need Premium.

**Custom emoji are OFF by default.** A bot may only send `<tg-emoji>` if it owns a Fragment
username; from an ordinary bot the tag is rejected or shown as literal text, which would break
every message rather than merely look wrong. Turn it on explicitly, after the assets are
registered:

```bat
set CUSTOM_EMOJI=1
```

With it unset, `src/icons.mjs` emits the standard glyph for every key, so the UI is complete and
readable either way. The registry is the single source of truth: changing an ID there upgrades
every surface at once, and no caller needs editing.

**Option A — from a sticker pack.** Send the pack's link or short name. The bot reads the set via
`getStickerSet`, lists every custom emoji with its numeric ID, and previews the theme:

```
[0] 🟣 → 5291923604487808793
[1] 🟡 → 5291751363414336197
```

A pack with no custom emoji is rejected with an explicit message — a normal sticker pack will not
work.

**Option B — a JSON ID map.** Send one line of JSON. IDs must be numeric strings:

```json
{"🟣":"5291923604487808793","🟡":"5291751363414336197"}
```

**Option C — individual emoji.** Send the custom emoji themselves; the bot resolves each
`custom_emoji_id` and builds the map.

Then confirm **✅** to apply or **❌** to cancel. `/resettheme` reverts to standard emoji (or to
`EMOJI_THEME` if set).

### Verified 18-icon mapping

Packs used: [CryptoIcons](https://t.me/addemoji/CryptoIcons),
[RestrictedEmoji](https://t.me/addemoji/RestrictedEmoji),
[SM Animated](https://t.me/addemoji/emojipack_sm).

```json
{"🚀":"5292284235711784694","🟣":"5291923604487808793","🟡":"5291751363414336197","🌐":"5402068075153476626","🌍":"5402068075153476626","✖️":"5195042564062865767","✈️":"5291812201626084541","⚡":"5291824180289872393","📊":"5431577498364158238","👥":"5372926953978341366","🧠":"5237799019329105246","🔎":"5188311512791393083","🔐":"5472308992514464048","❗️":"5467928559664242360","⏳":"5451732530048802485","⛓️":"5318757666800031348","➡️":"5321300317504030049","📌":"5321006159488892145"}
```

Notes:
- Keep IDs as **JSON strings** so no digits are lost.
- The 18 entries cover chain logos, website/social headers, analysis headers, pending states and
  navigation. A card only shows the icons relevant to its chain and content; 🪙 uses standard
  emoji.
- Custom emoji render only where the client supports them; everyone else sees standard emoji.
  Card content is identical either way, and nothing breaks when imagery is absent.

| Symptom | Check |
| --- | --- |
| JSON sent but no preview appears | You must be in the bot's DM, as the owner, sending one intact JSON line |
| New card still shows plain emoji | Confirm the bot replied ✅, the owner account has Premium, and you are testing the right process |
| `/ca` works but pasting a CA in a group is silent | Check Group Privacy is disabled, plus pacing and the repeat window |
| `409 Conflict` while polling | Another process is using the same token — stop the duplicate |

---

## Group behaviour

- **Pacing:** 3 s between scans per group, 1 s in private. Owners bypass it. A repeat inside the
  window is served from cache, and the wait is always stated rather than silently dropped.
- **Concurrent identical scans are coalesced** — ten people pasting the same address trigger one
  provider scan.
- **Call tracking is group-scoped.** A call in one group is invisible in another; profile links
  are signed to prevent cross-group leakage.
- **Bot Privacy must be DISABLED** in @BotFather for CA auto-detection in groups, so the bot can
  read ordinary messages. Verify with `getMe` → `can_read_all_group_messages: true`. Remove and
  re-add the bot if you change it while the bot is already in the group. **No admin rights are
  needed.**
- `/alerttest` requires an ID in `OWNER_USER_IDS`.

---

## Alerts

- **Multiplier alerts** fire when a called token crosses the configured multiple, measured from
  the recorded call price to the observed peak.
- **Dex Paid alerts** fire when a called token's listing status becomes paid on an indexed chain.
- Alerts are measured, not claimed: a multiplier alert carries the observed peak, and the bot
  never claims realised trading profit — nothing in the pipeline knows anyone's fills.

---

## Known data limitations

Full measured list in `docs/KNOWN-GAPS.md`. Short version:

- **No field is guaranteed.** `unknown` means not measured; it never means safe.
- **LP lock** is determined on Solana and on Pons-graduated Robinhood tokens. For most V3/V4
  pools the pool type is identified but the lock state is **not measurable** without a position
  indexer — those render `V3/V4`, not a percentage.
- **HyperEVM holders** have no keyless source and no free-key path (endpoints are PRO).
- **Narrative** exists only where a project actually published a description.
- **Tax** is a provider figure or a simulated transfer fee; a transfer fee is not a buy/sell tax
  and the two are labelled differently.

---

## Testing

```bat
npm test
```

903 tests, no network required.

---

## Project layout

```
src/
  bot.mjs                  entrypoint, command registry, pacing
  live-scan.mjs            market scan + enrichment orchestration
  chains.mjs               chain registry (market / goplus / dexPaid per chain)
  risk-intel.mjs           risk assembly across providers
  risk-classify.mjs        ONE threshold table, shared by card and /risk
  card-layout.mjs          card rendering
  leaderboard.mjs          /lb sections
  alerts.mjs               alert types and keys
  security/
    lp-intel.mjs           V2 burn/lock maths
    positions.mjs          V3/V4 position assessment
    pons.mjs               Robinhood Pons launchpad + graduation
    elysium.mjs            Elysium holder source
    hyperevm.mjs           HyperEVM holder adapter (gated on a paid plan)
    rugcheck.mjs           Solana security
    simulation-tax.mjs     read-only tax measurement
    keccak.mjs             dependency-free Keccak-256
  research/                narrative pipeline and providers
benchmark/
  manifest.json            fixed 35-token acceptance sample
  measure.mjs              coverage harness (raw vs applicable)
  stability.mjs            run-to-run variance classifier
docs/                      acceptance, contract, gaps, handoff
```

---

## Telegram references

- [Group Privacy and message reading](https://core.telegram.org/bots/features#privacy-mode)
- [Bot commands and menu](https://core.telegram.org/bots/features#commands)
- [Custom emoji in HTML style](https://core.telegram.org/bots/api#html-style)

---

## Status

Internal staging bot. **Not pushed to GitHub, not deployed publicly.** Round 5 is the accepted
final development round; this tree is the release candidate awaiting owner Telegram acceptance.
