# Phase 2 — Group Call Tracking & PnL

**Status:** implemented, automated tests green, group acceptance pending an
OWNER-created group.
**Baseline:** `mc/phase2-calls`, built on the locked UI at `2fdba30`.

---

## 1. What a "call" is

A call is a **social observation with an attributable author and a market-cap
snapshot**, not a trade. The card and every command say so, because conflating
the two is the easiest way to mislead a reader.

| Concept | Stored as | Never confused with |
| --- | --- | --- |
| Entry market cap | snapshot at call time | a later observation |
| Current market cap | last successful observation | realised proceeds |
| Peak market cap | highest observed **since the call** | the token's all-time high |
| ROI | current ÷ entry (a price ratio) | realised profit |

## 2. Commands

| Command | Scope | Behaviour |
| --- | --- | --- |
| `/call [chain] <CA>` | group | Records a call by the sender with the current MC as entry |
| `/calls` | group | Last 15 calls, newest first, with ROI and entry |
| `/fc [chain] <CA>` | group | Who called it first, and when |
| `/pnl [n\|<CA>]` | group | Refreshes, then sends a shareable image card |
| `/callsettings` | group | Auto-call on/off, minimum market cap |
| `/justscan` | group | Explains a scan that was not recorded |

Auto-call is **OFF by default**. Pasting a contract scans it; recording a call is
a deliberate act. `/callsettings autocall on` opts a group in, and even then the
confirmation is posted so attribution is visible.

## 3. Correctness rules (each has a test)

**Entry validation.** A call is only recorded from a successful scan with a real,
finite, positive market cap. Rejected: `not-found`, `api-error`, `rate-limited`,
`invalid-response`, `chain-unsupported`, missing market cap, market cap over $5T,
price change over 1000%, and volume exceeding market cap by 100x. FDV is never
substituted for a missing market cap.

**Peak is not ATH.** `peakMarketCapUsd` is initialised to the entry market cap and
only moves forward on observations taken after the call. A pre-call high cannot
enter it, because nothing before `calledAt` is ever read. A single reading more
than 50x the entry is rejected as an implausible jump rather than celebrated as a
peak — that shape is nearly always a wrong-pair or post-migration unit error.

**Failed observation is not a zero.** If a scan fails, nothing is written and the
last good value stands. A card shows `not observed yet` rather than `1.00x`, which
would read as "flat" instead of "unknown".

**Attribution is decided before insert.** `firstCall()` reads persisted history,
so the first caller keeps attribution when others call the same token later. A
second caller is recorded, never labelled first, and is shown who was first.

**Duplicate protection.** The same member re-calling the same token inside a
10-minute window is refused as `duplicate`. A genuine re-call after the window is
recorded but is not the first call.

**Identity.** EVM addresses compare case-insensitively; Solana base58 compares
exactly. A token is `(chain, address)`, never a ticker.

**Group isolation.** Calls are keyed by chat id; one group cannot see another's.

**Migration/abnormal detection.** A changed primary pool, or liquidity falling
below 15% of entry, sets a `migrationSuspected` note. It is recorded as a caveat,
not silently rewritten to a new baseline.

## 4. Persistence

`data/calls.json` (override with `CALLS_DB_PATH`).

- **Atomic writes**: serialise to `.tmp`, then `rename`. A crash mid-write cannot
  destroy the live file.
- **Serialized queue**: concurrent handlers cannot interleave two renames and lose
  an update. Tested with 10 parallel records.
- **Schema versioning**: every document carries `schemaVersion`; `migrate()` has an
  explicit per-version branch. A file written by a *newer* build is refused rather
  than downgraded, so data is never silently mangled.
- **Corruption handling**: an unparsable file is copied to `.corrupt-<ts>` and the
  store starts empty. The original bytes are preserved for recovery.
- Survives restart: verified by writing through one instance and reading through a
  fresh one.

**Production path:** the store is a class with a narrow surface
(`groupSettings`, `setGroupSetting`, `callsForChat`, `firstCall`, `callsForToken`,
`addCall`, `updateCall`, `openCalls`). Moving to Postgres/Redis means implementing
that interface and bumping `SCHEMA_VERSION`; nothing above the store changes.

## 5. PnL card

Two surfaces from **one** `callMetrics()` call, so they cannot disagree:

- `renderPnlText()` — Telegram HTML, always available, usable as a photo caption.
- `scripts/render_pnl.py` → PNG via Pillow, sent with `sendPhoto`. No chart
  library, no headless browser, no new Node dependency (`sharp`/`resvg`/`canvas`
  are all absent here, and adding a native dependency to a one-dependency bot is a
  poor trade).

If the renderer is unavailable the command **sends the text card and says nothing
about an image** — it never claims delivery it did not achieve.

Both surfaces carry the same disclaimer: *"Price ratio since the call, not
realized profit. Peak = highest observed since this call, not all-time high."*

## 6. Alert substrate (Phase 3 hook)

`src/call-observer.mjs` runs observation passes and returns structured events:

```
{ type: 'milestone'|'peak', call, multiple, peakMultiple, milestone, previousMultiple }
```

with `crossedMilestone()` over `[2,3,5,10,25,50,100]`. It deliberately sends
nothing — Phase 3 decides delivery and policy. Cost is bounded: active calls only,
7-day horizon, max 8 provider calls per pass, 5-minute per-call cooldown, and one
request per shared token.

## 7. Verified

- **302 automated tests** pass (84 new for Phase 2).
- Real live lifecycle against Ethereum PEPE: scan → record → second caller cannot
  steal attribution → PnL PNG rendered (34 KB).
- Restart persistence: 2 calls and 1 group settings record read back from disk
  with the correct first caller.
- `/pnl` image path, text fallback path, and failed-refresh path all exercised.

## 8. Known limitations

1. **Group acceptance is pending.** The Telegram Bot API cannot create a group, so
   an OWNER-created group with the bot added is required to test real paste
   detection and command delivery.
2. **`/callsettings` is not admin-gated.** Telegram does not tell a bot the
   invoker's admin status without an explicit `getChatMember` call, which is not
   wired yet. Any member can currently change the group's settings. This is a
   documented gap, listed for Phase 6 (Group Settings), not a hidden behaviour.
3. **No scheduled observer loop yet.** `observePass` exists and is tested but is
   invoked by `/pnl`, not by a timer; the timer belongs with Phase 3 alerts so
   nothing polls without a consumer.
4. **Peak horizon is 7 days.** Beyond that a call is no longer observed, by design.
5. **Historical ATH is not tracked at all.** Nothing in this phase reads
   pre-call history, so a card cannot accidentally imply it.
