# OWNER Round 1 — acceptance steps

Branch `mc/phase7-integrated`. Start:

```cmd
cd /d E:\meme-checker-telegram
npm start
```

Test in `sissooo1` with `@MemeCheckerStagingBot`. Ctrl+C stops bot and observer.

---

## 1. Clickable caller in alerts

Trigger any multiplier alert (`/alerttest 2x` sends a clearly-marked SIMULATED one; a real
alert fires when a tracked token crosses a milestone).

**Expected** — the caller name is a link, not plain text:

```
🚀 $FIONA JUST HIT 2X!

Entry MC: $2.04M
Current MC: $4.99M
Return: 2.45x

Called by Foxy · 3h 8m ago
```

| # | Action | Expected |
| --- | --- | --- |
| 1.1 | Tap the caller name | Opens the bot DM → Caller Profile for **that group** |
| 1.2 | Check the period | **1D** selected |
| 1.3 | Tap 1W / 2W / 1M | Same message edits |
| 1.4 | Check the alert replies to the original call message | Still threaded to the call |
| 1.5 | Same check on a Dex Paid, migration or pump/dump alert | Caller name is a link in all of them |

## 2. Security data

Send each of these and read the SECURITY block:

| # | Command | Expected |
| --- | --- | --- |
| 2.1 | `DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263` (BONK) | `LP Locked: Burned 100%`, `Creator Holds: 0.0%`, `Top 10: 40.5%`, `Tax: —` |
| 2.2 | `2b1kV6DkPAnxd5ixfnxCpjxmKwqjjaYmCZfHsFu24GXo` (PYUSD, Token-2022) | `Transfer Fee: 0%` — labelled **Transfer Fee**, not Tax |
| 2.3 | `/check ethereum 0x8fd15c6d44747f7f2e1300577f9dcd1c3fa22ed5` (FIONA) | `Tax (B/S): 0.0%`, `LP Locked: 100%`, `Creator Holds: 0.0%` |
| 2.4 | `/check bsc 0xb4f9d1b2cad3646d15797de462e5d773194d7777` (ANT) | `Top 10: 20.6%`, `Creator Holds: 0.0%` |
| 2.5 | Any HyperEVM or MegaETH token | Fields show `n/a` (no provider) — never green ticks |
| 2.6 | Any token where the provider has no record | Shows `—`, not `0%` |

**BONK showing `Tax: —` is correct.** It is a legacy SPL token; Solana has no buy/sell
tax and BONK has no transfer-fee extension. A dash is the truthful answer.

## 3. Live performance line

| # | Action | Expected |
| --- | --- | --- |
| 3.1 | Record a call (`/call <CA>` in the group) | That card shows **First Call** — it is the recording card |
| 3.2 | Scan the same CA again | **No "First Call"**. Instead: `🔥 Foxy @ $2.04M [+144.6%] (3h 8m)` |
| 3.3 | Tap 🔄 Refresh | Same performance line, updated numbers, **no new card** |
| 3.4 | Tap the caller name on that line | Opens the Caller Profile, 1D |
| 3.5 | Find a token that is down | `📉 Foxy @ $2.04M [-25.0%] (4h)` |
| 3.6 | Check `/calls` count before and after Refresh | Unchanged — refresh records nothing |
| 3.7 | Entry market cap | Never changes between cards |

## Known-good live readings (measured during development)

```
BONK   Top 10 40.5%  Holders 1,019,748  LP Burned 100%  Creator 0.0%
PYUSD  Top 10 87.7%  Holders 59,252     Transfer Fee 0%  Creator 0.0%
FIONA  Top 10 11.1%  Holders 957        LP 100%  Tax 0.0%  Creator 0.0%
ANT    Top 10 20.6%  Holders 6,080      Creator 0.0%
```

Concentration, holder counts and market caps move with the market, so treat these as
sanity anchors, not fixed values.

## Not testable alone

- A settings change attempted by a **non-owner** member (needs a second account).
- Anonymous-admin / channel sender attribution.

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
