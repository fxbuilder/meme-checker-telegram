# OWNER Round 2 — acceptance

Branch `mc/phase7-integrated`. Start:

```cmd
cd /d E:\meme-checker-telegram
npm start
```

---

## 1. Multi-chain narrative

| # | Action | Expected |
| --- | --- | --- |
| 1.1 | `/narrative 0xb4f9d1b2cad3646d15797de462e5d773194d7777` (ANT, BSC) | Narrativa may say no description; must show **Launched via flap.sh** and the X link `x.com/anthropicai` |
| 1.2 | `/narrative DezXAZ8z7…` (BONK) | Real prose (GeckoTerminal) |
| 1.3 | `/narrative 0x532f27101965dd16442E59d40670FaF5eBB142E4` (BRETT, Base) | Real prose |
| 1.4 | Any token whose site is a launchpad stats page | **Never** shows `24h Vol … MCAP … FDV` as the narrative |

**ANT is the interesting case.** Its description is empty in every hosted source *and* in
its own on-chain metadata — verified. It now reports that honestly and adds two facts it
did not have before instead of "No reliable narrative available".

## 2. Automatic EVM chain detection

| # | Action | Expected |
| --- | --- | --- |
| 2.1 | Paste `0xb4f9d1b2cad3646d15797de462e5d773194d7777` (ANT) | Scans BNB Chain **immediately — no picker** |
| 2.2 | Paste `0x6982508145454ce325ddbe47a25d4ec3d2311933` (PEPE) | Scans Ethereum, no picker |
| 2.3 | Paste `0x532f27101965dd16442E59d40670FaF5eBB142E4` (BRETT) | Scans Base, no picker |
| 2.4 | Paste any unknown `0x…` | Picker appears, worded "normal for a very new token" — **never** silently picks BSC/Ethereum |
| 2.5 | Paste the same address twice | Second scan does not re-resolve (cached) |
| 2.6 | `/check base 0x…` on an Ethereum token | Explicit chain **always wins** over resolution |
| 2.7 | Check attribution after an auto-resolved paste | Card replies to your CA message and the call is credited to you |

Multi-chain case: if a contract is genuinely deployed on 2+ supported chains, the picker
lists **only those chains**, not all 13.

## 3. `/lb`

| # | Action | Expected |
| --- | --- | --- |
| 3.1 | `/lb` in the group | Three sections: **TOP CALLERS**, **GROUP STATS**, **TOP 10 CALLS** |
| 3.2 | Check default period | **1D** |
| 3.3 | Tap 1W / 2W / 1M | All three sections update together |
| 3.4 | Tap a caller name | Opens that caller's profile in DM, **1D** |
| 3.5 | Tap 👑 Show top 10 | Expands the caller list; period buttons keep the expansion |
| 3.6 | Tap 🔄 Refresh | Re-renders, no new records |
| 3.7 | Check a caller with no observed peak | Says "no measured peak yet", not `0%` |
| 3.8 | `/calls` before and after Refresh | Unchanged count |

## 4. `/help`

| # | Action | Expected |
| --- | --- | --- |
| 4.1 | `/help` | 7 sections: Token Scanner, Call Tracking & PnL, Narrative & Intelligence, Security, Community & Leaderboard, Settings, General |
| 4.2 | Read the chain list | **15 chains**, not Solana/BSC only |
| 4.3 | Read the chain-detection section | Explains automatic resolution + `/check <chain>` override |
| 4.4 | Read the free/premium section | States ordinary scans make no paid X request |
| 4.5 | Try every command listed | Each one exists and responds |

## 5. Security corrections

| # | Action | Expected |
| --- | --- | --- |
| 5.1 | BONK card | `Tax: N/A` — not `—`, not `0%` |
| 5.2 | PYUSD (`2b1kV6Dk…`) | `Transfer Fee: 0%` |
| 5.3 | A Token-2022 token with a real fee | `Transfer Fee: N.NN%` |
| 5.4 | BONK / any Solana token | `Creator Holds` reflects RugCheck's real balance, never a royalty share |
| 5.5 | A token where only the contract owner is known | Label reads **Owner Holds**, not Creator Holds |
| 5.6 | Unknown token program | `Tax: —` (dash), never `N/A` |

## Measured live during development

```
ANT   narrative: empty (verified) · Launched via flap.sh · x.com/anthropicai
BONK  Tax: N/A · Transfer Fee n/a · LP Burned 100% · Creator Holds 0.0%
PYUSD Transfer Fee 0% (Token-2022)
PEPE  Tax (B/S) 0.0% · Top 10 38.61%
Resolver: ANT->bsc, PEPE->ethereum, BRETT->base, unknown->not-found
```

## Known gaps — stated, not hidden

- **Monad, Robinhood, MegaETH** still have no verified keyless prose source. GMGN was
  ruled out: HTTP 401 without a key, and its `token/info` carries social links but **no
  description field at all**, so it would not have solved this.
- **DexScreener `token-profiles`** does return descriptions but has no per-address lookup
  — feed-only, unusable on demand.
- On-chain metadata covers EVM chains with a public RPC (bsc, ethereum, base) and only
  where the contract implements `metaURI()`. Most tokens do not.

## Not testable alone

- Non-owner settings attempts (needs a second account).
- Anonymous-admin attribution.

## Defect template

```text
ID / Feature:
Command or action:
Chain and CA:
Expected:
Actual:
Screenshot or sanitized CMD error:
Reproducible? Severity:
```
