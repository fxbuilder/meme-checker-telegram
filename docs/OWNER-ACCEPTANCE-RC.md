# OWNER ACCEPTANCE — Release Candidate

Release candidate for owner testing in Telegram. Baseline `mc/phase7-integrated`.

**This is a checklist, not a claim.** Every row is something you verify yourself. Items marked
⚠️ are known-imperfect and should be expected to fail the "perfect" version — their current
behaviour is documented so you can judge whether it is acceptable for release.

---

## 0. Before you start

```bat
cd E:\meme-checker-telegram
npm start
```

Wait for `Connected as @MemeCheckerStagingBot`. Run only ONE instance.

Expected startup: the bot logs the connected username, no `409 Conflict`, no unhandled rejection.

---

## 1. Seven priority chains — paste each of these

Paste as a **plain message** in the group, and again in DM. Expect a card with market data and a
Quick Check block.

| # | Chain | Test token | What a good result looks like |
| --- | --- | --- | --- |
| 1 | **Solana** | `DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263` (BONK) | Holders measured, `Tax: N/A`, `LP Burned 100%`, RugCheck score shown |
| 2 | **BNB Chain** | `0x0E09FaBB73Bd3Ade0a17ECC321fD13a19e81cE82` (CAKE) | Holders + Top 10, tax 0/0, `LP: Unlocked` |
| 3 | **Ethereum** | `0x6982508145454ce325ddbe47a25d4ec3d2311933` (PEPE) | Holders, tax, Dex Paid **paid** |
| 4 | **Robinhood** | `0x0ddcab9ae04bda0c87ecc1640636fa11e8e613e8` (TEXEL) | `LP Locked (perm): Yes`, tax 0/0 |
| 5 | **HyperEVM** | `0x9b498C3c8A0b8CD8BA1D9851d40D186F1872b44E` (PURR) | Market data + narrative; holders `—` |
| 6 | **Base** | `0x532f27101965dd16442E59d40670FaF5eBB142E4` (BRETT) | Holders + Top 10; `LP: V3/V4` |
| 7 | **Elysium** | `0x74f811f35134d73221e5491135e4c8f963316953` (AGI) | **982 holders, Top 10 26.34%**, narrative present |

### Chain expectations to check honestly

| Chain | Holders | Top 10 | Tax | LP | Narrative |
| --- | --- | --- | --- | --- | --- |
| Solana | ✅ measured | ✅ | ✅ `N/A` | ✅ burned 100% | ⚠️ often absent |
| BNB | ✅ | ✅ | ✅ | ✅ `Unlocked` | ✅ |
| Ethereum | ✅ | ⚠️ sometimes `—` | ✅ | ⚠️ `V3/V4` | ⚠️ often absent |
| Robinhood | ✅ | ✅ | ✅ | ✅ **`perm`** | ✅ |
| HyperEVM | ❌ `—` expected | ❌ `—` | ❌ `—` | `V3/V4` | ✅ |
| Base | ✅ | ✅ | ✅ | ⚠️ `V3/V4` | ✅ |
| Elysium | ✅ **982** | ✅ **26.34%** | ❌ `—` | ❌ `—` | ✅ 100% |

**⚠️ HyperEVM holders are expected to be `—`.** No keyless source exists and the free-key path
does not work (endpoints are PRO). This is documented, not a bug — confirm it shows `—` and the
card does **not** claim 0 holders.

**⚠️ Elysium tax and LP are expected to be `—`.** No tax provider covers it and the RPC cannot
enumerate holders to simulate from.

---

## 2. Chain auto-detection

| Test | Expected |
| --- | --- |
| Paste **only** the TEXEL address (no command) | Scans Robinhood directly, **no chain menu** |
| Paste **only** the PEPE address | Scans Ethereum directly |
| Paste `/check bsc 0xb4f9d1b2cad3646d15797de462e5d773194d7777` | Honours the explicit `bsc` |
| Paste an address that exists on 2+ chains | Offers **only** those chains |

**The bot must never silently default to BSC or Ethereum.**

---

## 3. Commands

Run each in DM. `✅` = expected to work now.

### Scanner
| Command | Expected | |
| --- | --- | --- |
| `/help` | Generated list of all 32 commands, grouped | ✅ |
| `/start` | Welcome message; caller-profile deep links resolve here | ✅ |
| `/chains` | 7 priority chains + others, per-chain capability | ✅ |
| `/check <CA>` | Card | ✅ |
| `/justscan <CA>` | Card without narrative pass | ✅ |
| `/standard` `/short` `/detail` `/compact` | Card density changes | ✅ |
| `/about` | Version info | ✅ |
| `/bundle <CA>` | Bundle/sniper grouping | ✅ |
| `/dev <CA>` | Developer/creator holdings | ✅ |

### Risk
| Command | Expected | |
| --- | --- | --- |
| `/risk <CA>` | Full security detail | ✅ |
| `/risk` on TEXEL | Shows `permanently locked`, position evidence | ✅ |
| `/risk` on BONK | RugCheck score 🟢 7/100, honeypot `UNKNOWN` | ✅ |

**Consistency test:** for any token, the card's Quick Check values must match `/risk`. They share
one threshold engine. A mismatch is a release blocker.

### Narrative & intelligence
| Command | Expected | |
| --- | --- | --- |
| `/narrative <CA>` | Project description where published | ✅ |
| `/narrative bsc <CA>` | Explicit chain honoured | ✅ |
| `/narrative` on AGI (Elysium) | Description present | ✅ |
| `/narrative` on TEXEL | Description from contract `getTokenInfo()` | ✅ |
| `/x <CA>` | ⚠️ requires `GETXAPI_KEY`/`SORSA_API_KEY`; otherwise says not-configured | ⚠️ |
| `/website <CA>` | Project website when known | ✅ |
| `/kol <CA>` | Community signals | ✅ |

### Calls & PnL
| Command | Expected | |
| --- | --- | --- |
| `/call <CA>` | Records the call with caller attribution | ✅ |
| `/calls` | Lists this group's calls | ✅ |
| `/callsettings` | Per-group config | ✅ |
| `/pnl` | PnL summary | ✅ |
| `/gpnl` | Group detail | ✅ |
| `/fc` | Followed callers | ✅ |
| `/profile` | Opens group-scoped profile in DM | ✅ |

**Call history is append-only.** Nothing in this release rewrote it — verify your existing calls
are intact and attributed to the right callers.

### Leaderboard
| Command | Expected | |
| --- | --- | --- |
| `/lb` | TOP CALLERS + GROUP STATS + TOP 10 CALLS | ✅ |
| Period buttons `1D 1W 2W 1M` | All three sections update together | ✅ |
| Refresh | Re-renders current period | ✅ |
| Click a caller | Opens correct group-scoped profile in DM | ✅ |

Losing calls must remain in the statistics. Ranking is hit-rate first; no invented points and no
claimed realised profit.

### Alerts
| Command | Expected | |
| --- | --- | --- |
| `/alerts` | Subscription management | ✅ |
| `/alerttest` | Test delivery — **owner only**, needs `TELEGRAM_TEST_GROUP_ID` | ⚠️ |
| Multiplier alert | Fires on called token crossing the multiple | ✅ |
| Dex Paid alert | Fires when listing status becomes paid | ✅ |

### Settings & premium
| Command | Expected | |
| --- | --- | --- |
| `/settings` | Per-chat settings | ✅ |
| `/resettheme` | Reverts emoji theme | ✅ |
| `/upgrade` | ⚠️ Premium teaser — **only renders if `PREMIUM_URL` is set** | ⚠️ |
| Token-page CTA | ⚠️ **only renders if `TOKEN_PAGE_BASE_URL` is set** | ⚠️ |

**`TOKEN_PAGE_BASE_URL` and `PREMIUM_URL` are currently unset.** The premium teaser and the token
page button therefore do **not** appear. Set them to test those paths.

---

## 4. Custom emoji

| Test | Expected |
| --- | --- |
| As owner in DM, send a sticker-pack link | Bot lists custom emoji with IDs and previews theme |
| Confirm ✅ | Theme applies; new cards show animated icons |
| Send a **non-emoji** sticker pack | Explicit rejection message, no silent nothing |
| `/resettheme` | Reverts to standard emoji |
| View a card without Premium | Standard Unicode emoji; **content identical** |

Cards must remain fully readable with no custom emoji configured.

---

## 5. Group behaviour

| Test | Expected |
| --- | --- |
| Paste a CA in the group | Card appears (Group Privacy must be OFF) |
| Paste the same CA twice within 3 s | Cached, and the bot **states** the wait |
| Two people paste the same CA at once | One provider scan, both served |
| Owner scans repeatedly | No pacing applied |
| Use a group not in `ALLOWED_CHAT_IDS` | No service |
| `/alerttest` from a non-owner | Refused |

---

## 6. Honesty tests — the important ones

These are the checks that matter most for this release.

| Test | Expected |
| --- | --- |
| Any unmeasured field | `—` or `unknown`, **never `0`**, never green |
| BONK tax | `N/A` — not `0%` (legacy SPL has no tax concept) |
| BRETT / PEPE LP | `V3/V4`, **not** a fabricated percentage |
| A pre-graduation launchpad token | `Bonding curve`, never "burned 100%" |
| HyperEVM holders | `—`, never `0` |
| `/risk` honeypot on a token with no evidence | `⚪ UNKNOWN`, never green |
| A token not indexed yet | Says it may not be indexed, not "does not exist" |

**If any unmeasured value renders as `0` or as a green indicator, stop and report it** — that is
the one class of defect this release is built to prevent.

---

## 7. Machine-checked results (already verified on this commit)

| Check | Result |
| --- | --- |
| Regression suite | **903 / 903 passing** |
| Risk consistency across 35-token sample | **35 / 35** |
| No credentials in tracked files | ✅ verified |
| `.env` ever committed | **0 commits** |
| Working tree | clean |

Measured coverage on the fixed sample (raw / applicable):

```
narrative  57% / 57%      holders  91% / 91%      top10  83% / 83%
tax        74% / 87%      lp       40% / 40%      dev    74% / 74%
dexPaid    77% / 77%      consistency 100%
```

These are **not** full coverage and the bot does not claim to be. See `docs/KNOWN-GAPS.md`.

---

## 8. Acceptance decision

Reply with one of:

- **ACCEPT** — push to GitHub and complete final handoff
- **ACCEPT WITH NOTES** — push, with the listed items for a later round
- **REJECT** — with the specific defect and the test that produced it

Nothing will be pushed, deployed, or handed off until you accept.
