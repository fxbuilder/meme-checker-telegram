# OWNER Round 3 — acceptance

Branch `mc/phase7-integrated` @ `8bdd5cf`. Start:

```cmd
cd /d E:\meme-checker-telegram
npm start
```

---

## 1. Narrative routing (your exact failure)

| # | Command | Expected |
| --- | --- | --- |
| 1.1 | `/narrative bsc 0xb4f9d1b2cad3646d15797de462e5d773194d7777` | **Narrative card. No chain question.** |
| 1.2 | `/narrative 0xb4f9d1b2cad3646d15797de462e5d773194d7777` | Narrative card, auto-resolved to BNB Chain |
| 1.3 | `/narrative@MemeCheckerStagingBot bsc 0xb4f9d1b2…7777` | Same as 1.1 |
| 1.4 | `/narrative 0x6982508145454ce325ddbe47a25d4ec3d2311933` (PEPE) | Ethereum, no prompt |
| 1.5 | `/narrative 0x532f27101965dd16442E59d40670FaF5eBB142E4` (BRETT) | Base, no prompt |
| 1.6 | `/narrative 0x39dbed3a2bd333467115de45665cc57f813c4571` (PONS) | Robinhood Chain, no prompt |
| 1.7 | `/narrative 0xdead00000000000000000000000000000000beef` | **Asks**, and says "normal for a brand-new token" |

Same parsing applies to `/risk`, `/dev`, `/bundle`, `/x` — test at least `/risk bsc <CA>`.

## 2. PONS narrative

| # | Command | Expected |
| --- | --- | --- |
| 2.1 | `/narrative 0x39dbed3a2bd333467115de45665cc57f813c4571` | Shows **"100% of fees go back to Pons"** — read from the token contract itself |
| 2.2 | Check the source line | `Token metadata (launchpad)` |
| 2.3 | `/narrative DezXAZ8z7…` (BONK) | GeckoTerminal prose |
| 2.4 | `/narrative bsc 0xb4f9d1b2…7777` (ANT) | States no description exists; shows **Launched via flap.sh** |

## 3. Risk and security

| # | Command | Expected |
| --- | --- | --- |
| 3.1 | `/risk DezXAZ8z7…` (BONK) | `Honeypot Risk: ⚪ UNKNOWN`, `RugCheck Score: 🟢 7/100 (LOW risk)` |
| 3.2 | `/risk 0x6982508145454ce325ddbe47a25d4ec3d2311933` (PEPE) | `Honeypot Risk: 🟢 LOW`, Top 10 ~38.5% |
| 3.3 | Any token with no RugCheck score | **No RugCheck line at all** — never `0/100` |
| 3.4 | Check BONK's tax | `Tax: N/A` (legacy SPL, non-applicable) |
| 3.5 | Check PYUSD `2b1kV6Dk…` | `Transfer Fee: 0%` |
| 3.6 | A chain with no provider (Monad / MegaETH) | Fields show `n/a`, never a green tick |

**A green `Honeypot Risk: LOW` only appears when a provider actually simulated the token.**
`UNKNOWN` is deliberately grey.

## 4. Cooldowns (the SHADE three-times failure)

| # | Action | Expected |
| --- | --- | --- |
| 4.1 | Paste the same CA three times, ~1 s apart | **Every paste produces a card.** No silence. |
| 4.2 | Paste two different tokens quickly | Second is paced for ~3 s, with a message saying so |
| 4.3 | As OWNER, paste repeatedly | Never paced |
| 4.4 | Paste the same CA twice at once | One scan, both get the card |
| 4.5 | Check `/calls` after repeats | **One** tracked call, not three |

`GROUP_COOLDOWN_MS` (default 3000) and `PRIVATE_COOLDOWN_MS` (default 1000) are
env-configurable.

## 5. Card consistency (item 4 check)

| # | Action | Expected |
| --- | --- | --- |
| 5.1 | Scan a token, then `/risk` on the same CA | Top 10, Tax/Fee, LP and Creator agree between card and `/risk` |
| 5.2 | Check the field order on the card | Top 10 · Holders · Dex Paid · Tax/Transfer Fee · LP Locked/Burned · Creator Holds |
| 5.3 | A proved non-applicability | `N/A` |
| 5.4 | Unavailable evidence | `UNKNOWN` / `—` — never green |

## Measured coverage (live, this build)

```
Narrative  11/15 chains, 21/27 samples (was 9/15)
Security   13/15 chains answering; Top 10 23/27, holders 23/27,
           tax 17/27, creator 21/27, LP lock 5/27
```

**The 90% narrative target is NOT met.** Monad, MegaETH, Berachain and HyperEVM have no
verified keyless prose source; the Berachain/HyperEVM samples are wrapped assets that are
not projects. Full breakdown, rejected sources and the paid option with pricing:
`docs/ROUND3-COVERAGE.md`.

`LP lock` at 5/27 is the weakest security field — no keyless provider reports it for EVM.

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
