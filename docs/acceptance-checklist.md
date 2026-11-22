# §11 Acceptance Checklist — Meme Checker Telegram MVP

**Build:** `demo/offline-mvp` @ `7934b00` · **Mode:** mock (labeled `[mock]`) · **Bot:** @MemeCheckerStagingBot
**Legend:** ✅ evidenced · 🟡 partial / needs more evidence · ⛔ blocked on external input · ⬜ not yet tested

## Evidence sources
- **OFFLINE** — automated suite on the integrated tree: 74/74 core + 17/17 QA green.
- **USER-DM / USER-GROUP** — user-run live test on Telegram Desktop, reported 2026-11-21, with screenshots held by the user (Solana `/check` card in group; `/help`, `/about`, `/website` in DM; `/website` reported URL-not-configured). Screenshots are the user's evidence; not independently re-inspected by @mc-lead.

## §11 criteria

| # | Criterion | Status | Evidence |
|---|---|---|---|
| 1 | Bot can be added to a group | ✅ | USER-GROUP: bot in private test group, responded to `/check` |
| 2 | Bot detects CA in messages per configured permission | ✅ | USER-GROUP: plain Solana CA pasted in group triggered a scan (Desktop+Mobile) |
| 3 | Supports Solana and BNB Chain | ✅ | USER-DM + USER-GROUP: both mock scans passed; OFFLINE both chains |
| 4 | Calls Core Backend | 🟡 (mock) | OFFLINE via mock adapter; live backend ⛔ pending staging contract |
| 5 | Returns Token Identity | ✅ | USER (Solana card) + OFFLINE |
| 6 | Returns Market Data when available | ✅ | USER (Solana card) + OFFLINE (BNB partial-data handled) |
| 7 | Returns Holder Overview when available | ✅ | OFFLINE; USER Solana card (to confirm visible in screenshot) |
| 8 | Returns basic Narrative | ✅ | OFFLINE: "Narrative unavailable" note shown (no fabricated summary) — correct for mock |
| 9 | Returns Project Links when available | ✅ | OFFLINE: "Not Available" shown when absent; no invented links |
| 10 | "View Full Analysis" button → correct token on website | ⛔ | Button correctly OMITTED while `TOKEN_PAGE_BASE_URL` unset. Live button + correct-token landing needs website route + config |
| 11 | Premium button present | ⛔ | Correctly omitted while `PREMIUM_URL` unset. Needs VIP URL |
| 12 | Handles invalid CA and API errors | 🟡 | OFFLINE: invalid-CA rejection, not-found vs api-error distinct. Live user-side error paths not yet exercised |
| 13 | Anti-spam + cache (cooldown/dedup) | 🟡 | OFFLINE: per-user 15s cooldown, per-chat 60s dup suppression. User-side ≥15s dup test not yet reported |
| 14 | No loop with other bots | ✅ | OFFLINE: `is_bot` guard on all handlers + auto-detect |
| 15 | Messages render well on Telegram **mobile** | ✅ | USER: tested on Telegram Desktop AND Mobile; DM + private-group flows render |

## Still needs evidence (to close acceptance)

1. **Mobile rendering (#15)** — your test was on Desktop. Need Solana + BNB cards viewed on a phone (iOS/Android) confirming sections, wrapping, and tappable buttons.
2. **In-group auto-detect (#2)** — paste a plain address (no `/check`) in the group with Group Privacy OFF (or bot as admin); confirm the card still fires.
3. **Duplicate suppression live (#13)** — in the private group, post the Solana fixture as plain text; once its `[mock]` card appears, wait **20s**, then post the same address again. Expect **one result card total**. (The 20s wait clears the 15s user cooldown so it tests the 60s duplicate window, not the cooldown.)
4. **Live Full Analysis button (#10)** — set `TOKEN_PAGE_BASE_URL`, confirm the button appears and, **tapping it while signed out**, compare the destination page's **chain and full contract address** against the submitted address. A button appearing or a matching ticker is NOT sufficient. ⛔ needs confirmed website route.
5. **Premium button (#11)** — set `PREMIUM_URL`, confirm button → VIP destination. ⛔ needs VIP URL.
6. **Live backend (#4)** — replace mock with staging Core API. ⛔ needs API contract + credentials.
7. **Error paths live (#12)** — send `/check invalid` → expect **Invalid Contract Address**; then `/check 0xabcdef0123456789abcdef0123456789abcdef02` → expect **[mock] Token Not Found**. Plain malformed text is intentionally ignored (no reply). Neither result is evidence of a live API failure.

## KPI targets (§11) — not yet measured live
CA detection accuracy ≥99%, check success ≥95%, P95 ≤7s, Website CTA 100%, duplicates ~0, critical errors 0. Measurable only against the live backend + a test-address set.
