# FINAL HANDOFF — Meme Checker Telegram

**Status: TECHNICAL PASS. NOT OWNER ACCEPTED.** Manual Telegram testing is pending and
is the only thing that can change that.

- **Integrated branch:** `mc/phase7-integrated`
- **Commit:** `9610ff6`
- **Tests:** 680/680 (`npm test`)
- **Runtime dependency:** Telegraf only (`^4.16.3`)

---

## Phase checkpoints

| Phase | Status | Commit |
| --- | --- | --- |
| 1–3 | OWNER accepted (Phase 3 at MVP level) | `368843f`, `4c57544` |
| 4 + 4A corrections | TECHNICAL PASS | `e4ce37c`, `c8c6d7e`, `4eb4b32`, `5d61141` |
| 5 — Risk intelligence | TECHNICAL PASS | `f28ef86` |
| 6 — Community/leaderboard/settings | TECHNICAL PASS | `713ef99` |
| 7 — Integration | TECHNICAL PASS | `9610ff6` |

Earlier checkpoints preserved: `mc/phase2-calls` @ `368843f`, `mc/phase3-alerts` @
`574162c`, `demo/offline-mvp` @ `d61585d`. No worktree was reset or discarded.

---

## Implemented

**Scanning** — 15 chains via DexScreener, canonical CA detection, EVM chain picker that
replies to the ORIGINAL contract message, in-place 🔄 Refresh.

**Narrative** — GeckoTerminal primary (15 chains), CoinGecko supplementary, Solana
on-chain Metaplex decoding, project websites (SSRF-guarded). Claims are attributed in
prose; full sources live in `/narrative`.

**X/KOL** — GetXAPI adapter with persisted budget and serialised pacing. Cached previews
only for ordinary users; the card shows a locked premium teaser. **Zero billable X
requests** from scans, commands or the observer (verified by host-level instrumentation).

**Risk** — `/risk`, `/dev`, `/bundle` on GoPlus (8 chains). Three states kept strictly
apart: measured, unknown, not-supported.

**Calls/PnL/Alerts** — one canonical call per group+chain+contract, First Caller deep
links defaulting to 1D, image-only `/pnl`, adaptive observer with durable alert dedupe.

**Community** — `/lb`, `/leaderboard`, `/gpnl`, `/settings` with deterministic ranking
and fail-closed authorisation.

---

## Verified by execution

- All 14 commands respond through the real Telegraf middleware chain.
- **0 paid X requests** across every command plus a Refresh tap.
- Top 10 concentration: the reported 111.1% reproduced and fixed; inconsistent rows now
  yield `null`, never a clamped 100%. Live values: PEPE 38.6%, BONK 40.5%.
- Card replies to the CA message id, never the picker id.
- Refresh edits in place and inserts no call.
- Cache: 3 identical research calls → 1 provider fetch.
- Metaplex decode against the real BONK account (name, symbol, arweave URI, immutable).

## NOT verified — honest gaps

- **No live EVM X or organic public-call discovery.** No billable X requests were made
  under this plan. GetXAPI field mapping is proven against real captured payloads and
  mocked transports, not a live end-to-end EVM search.
- **Robinhood Chain has no narrative source.** Coverage gap, reported as such.
- **`/bundle` measures nothing about bundles.** Free sources do not expose same-slot
  buyer grouping, so it reports concentration and names the missing analyses rather than
  printing an all-clear.
- **Settings authorisation as a non-owner** needs a second Telegram account.
- **Migration alerts remain Solana-only.**
- **No OWNER acceptance of any phase beyond 1–3.**

---

## Providers and budgets

| Provider | Key | Cost | Chains |
| --- | --- | --- | --- |
| DexScreener | none | free | 15 |
| GeckoTerminal | none | free (6s pacing) | 15 |
| GoPlus | none | free | 8 |
| CoinGecko | none | free (2.2s, 6h cache) | 8 |
| Solana RPC | none | free | Solana |
| GetXAPI | `GETXAPI_KEY` | $0.001/request | cached only |

X budget: `RESEARCH_X_BUDGET` (default 20/day), persisted to
`data/research-budget.json`, serialised pacing with 429 retry.

---

## Data safety

- Owner's real records preserved (`c16` Bonk, `c18` pippin). No synthetic contamination.
- No poller was started by the agent; `getUpdates` was never consumed.
- No secret is tracked in Git. `.env` is untracked; `.env.example` documents every
  variable with empty values.
- Nothing was pushed, deployed or migrated.

---

## Start

```cmd
cd /d E:\meme-checker-telegram
npm start
```

`npm start` = `set SCAN_MODE=live&& node --env-file=.env src/bot.mjs`, which starts the
bot and its observer; Ctrl+C stops both.

**Acceptance checklist:** `docs/OWNER-ACCEPTANCE.md`
**Progress log:** `docs/MASTER-PROGRESS.md`

---

## What GitHub handoff will require (NOT done)

- A push authorisation from the OWNER.
- Confirmation that `data/` stays ignored (it is).
- CI running `npm test` with `TELEGRAM_BOT_TOKEN=test`, `BOT_NO_LAUNCH=1` and an
  isolated `CALLS_DB_PATH`; the suite already works this way.
- A decision on whether `docs/` phase logs ship publicly.
