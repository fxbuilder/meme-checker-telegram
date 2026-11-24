# OWNER ACCEPTANCE — Meme Checker Telegram

**This is the only manual gate.** Nothing here is marked accepted until you test it.

- **Bot:** `@MemeCheckerStagingBot`
- **Test group:** `sissooo1` (`-5333984336`)
- **Branch:** `mc/phase7-integrated` (see `docs/FINAL-HANDOFF.md` for the exact commit)

---

## Start

```cmd
cd /d E:\meme-checker-telegram
npm start
```

`npm start` runs the live bot **and** its background observer. Ctrl+C shuts both down
cleanly. Do not run a second copy — two pollers on one token cause a 409 conflict.

**Before starting:** confirm `.env` contains `TELEGRAM_BOT_TOKEN`, `OWNER_USER_IDS`,
`ALLOWED_CHAT_IDS`, `CALLER_LINK_SECRET`. Without `CALLER_LINK_SECRET`, First Caller
links will not survive a restart (the bot warns about this on startup).

---

## Checklist

Test in `sissooo1` unless stated. Record failures with the template at the end.

### 1. Scan and reply context
| # | Action | Expected |
| --- | --- | --- |
| 1.1 | Paste a Solana CA (e.g. BONK `DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263`) | Card **replies to your CA message**, not a standalone message |
| 1.2 | Paste a bare EVM CA (e.g. `0x6982508145454ce325ddbe47a25d4ec3d2311933`) | Chain picker appears |
| 1.3 | Tap a chain on the picker | Result card **replies to the original CA message**, not the picker. The picker disappears |
| 1.4 | `/check base 0x532f27101965dd16442E59d40670FaF5eBB142E4` | Card with no picker |

### 2. Card content
| # | Action | Expected |
| --- | --- | --- |
| 2.1 | Look at any card's Narrative section | Concise prose, **no** `Source: … unverified claim` footer |
| 2.2 | Read the narrative wording | Self-reported text reads "The project describes itself…" — not stated as fact |
| 2.3 | Look at the X section | `🔒 X & KOL INTELLIGENCE` / `KOL Activity: •••••• (Locked)` — no fake counts or names |
| 2.4 | Check Security → Top 10 | A percentage that is **never above 100%**. If unreconcilable, shows `—` |

### 3. Refresh
| # | Action | Expected |
| --- | --- | --- |
| 3.1 | Tap `🔄 Refresh` | Same card updates **in place**. No second card |
| 3.2 | Tap it twice quickly | Second tap says "Already refreshing" or "Please wait Ns" |
| 3.3 | Check call count before/after (`/calls`) | **Unchanged** — refresh never records a call |

### 4. Calls and Caller Profile
| # | Action | Expected |
| --- | --- | --- |
| 4.1 | Tap the First Caller name on a card | DM profile opens with **1D** selected |
| 4.2 | Close and reopen the same link | Opens on **1D** again (not the last filter used) |
| 4.3 | Tap 1W / 2W / 1M | Same message edits, correct period |
| 4.4 | `/calls` | Real recorded calls only |

### 5. PnL
| # | Action | Expected |
| --- | --- | --- |
| 5.1 | `/pnl <recorded CA>` | Exactly one **captionless image**, no buttons |
| 5.2 | `/pnl <unrecorded CA>` | `No recorded call for this token in this group.` |
| 5.3 | `/pnl` with no argument | Usage help |

### 6. Risk (Phase 5)
| # | Action | Expected |
| --- | --- | --- |
| 6.1 | `/risk 0x6982508145454ce325ddbe47a25d4ec3d2311933` | Holders, contract flags, tax, LP — Ethereum |
| 6.2 | `/risk DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263` | Solana. Tax says "no tax concept on Solana" |
| 6.3 | `/risk` on a Monad address | Says no provider covers Monad — **not** "safe" |
| 6.4 | `/dev <CA>` | Creator address + holding at snapshot |
| 6.5 | `/bundle <CA>` | Lists what is measurable **and** what is not measured. No "Bundle: No" |

### 7. Leaderboard and settings (Phase 6)
| # | Action | Expected |
| --- | --- | --- |
| 7.1 | `/lb` | Ranked callers, sample size on every line |
| 7.2 | Tap a period button | Message edits to that period |
| 7.3 | `/gpnl` | Group summary; "no performance figures" if nothing measured |
| 7.4 | `/settings` | Shows current mode and alert state |
| 7.5 | Tap a settings button as the OWNER | Setting changes and the screen updates |
| 7.6 | Tap a settings button as another member | Alert: owner-only. **Nothing changes** |

### 8. Alerts
| # | Action | Expected |
| --- | --- | --- |
| 8.1 | `/alerttest 2x` | Loud **TEST / SIMULATED** banner. No real alert consumed |
| 8.2 | `/alerttest dexpaid`, `/alerttest pump`, `/alerttest drawdown` | Same, simulated |
| 8.3 | `/alerts` | Settings screen |

### 9. Narrative coverage
| # | Action | Expected |
| --- | --- | --- |
| 9.1 | `/narrative <Solana CA>` | Prose with full source attribution |
| 9.2 | `/narrative <BNB or Base CA>` | Prose from GeckoTerminal |
| 9.3 | `/narrative` on an undescribed token | Verified contract facts, stated plainly as such |

### 10. Premium and shutdown
| # | Action | Expected |
| --- | --- | --- |
| 10.1 | `/x <CA>` | Cached preview or honest unavailable + invitation. **Never** a live paid search |
| 10.2 | `/kol dogwifcoin` | Recorded calls or "none recorded" |
| 10.3 | `/help` | Lists all commands including risk, lb, gpnl, settings |
| 10.4 | Ctrl+C in CMD | Clean shutdown, no hang |

---

## What is simulated vs real

- **Mock mode** (`SCAN_MODE=mock`) serves fixed fixtures and makes **no** market requests.
  `npm start` runs `SCAN_MODE=live`.
- **Refresh, scan, risk, narrative** make real free provider requests (DexScreener,
  GeckoTerminal, GoPlus, public Solana RPC).
- **X/KOL** is cache-only for ordinary users. **Zero billable X requests** are possible
  from scans, commands or the observer — verified by instrumentation.

## Requires a second person or admin rights

These cannot be tested alone and are **not** faked:

- Settings authorisation as a **non-owner** group member (needs a second Telegram account).
- Behaviour when the bot lacks admin rights (join as a plain member to test).
- Anonymous-admin / channel sender attribution.

## Defect template

```text
ID / Feature:
Command or action:
Chain and CA (if relevant):
Expected:
Actual:
Screenshot or sanitized CMD error:
Reproducible? Severity:
```
