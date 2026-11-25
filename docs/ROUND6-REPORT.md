# ROUND 6 — FINAL UI/UX POLISH

Final presentation round before OWNER acceptance and GitHub push. No new data sources, no
provider research, no scope expansion. All Round 4/5 correctness work is preserved: every
existing data-quality fix, risk-consistency rule and no-false-safe behaviour is untouched.

Baseline: `mc/phase7-integrated` @ `af94b5d`, 904 tests. Final: **935/935 twice**.

---

## 1. Command simplification

| Was | Now |
| --- | --- |
| `/check <address>` as the documented manual scan | `/ca <address>` and `/ca <chain> <address>` |
| Pasting a CA (unchanged) | Still the **primary** flow, stated first in `/start` and `/help` |
| `/check` in `/start`, `/help`, command menu | Removed from every public surface |

`/check` was **downgraded to a compatibility alias, not broken**. Old posts and pinned messages
still contain it, and breaking them would fail silently for the user who tapped one. It routes
to the identical code path as `/ca`, plus a one-line tip that `/ca` or a direct paste is
preferred.

`/scan` does not exist and appears nowhere. A test asserts both halves: no handler, and no
mention.

## 2. Single card view

`/short`, `/detail`, `/standard` and `/compact` no longer select anything. They reply
"Standard card is now the default view." and stop.

They were kept as stubs rather than deleted because a deleted Telegram command returns no
answer at all, which reads as a broken bot; a stub reads as a changed product. The standard card
is the only public view. No copy anywhere suggests a choice of card modes remains.

## 3. `/start`

Rewritten in `src/start-message.mjs`, rendered from data rather than hand-written inline.

Structure: identity → three capability lines → how to use → priority coverage → deeper analysis
→ one help pointer. 17 lines, down from a 19-line bullet dump, with the old "15 chains
supported" claim and the `/check` instruction gone.

The CTA renders **only when a URL is configured**. A dead button is worse than no button, so
`TOKEN_PAGE_BASE_URL` / `PREMIUM_URL` being unset produces no keyboard at all.

## 4. `/help`

Rewritten in `src/help.mjs` from a section registry, so the rendered text and the
documented-command list cannot drift.

Sections: Token Scan · Call Tracking & PnL · Narrative / Research · Security · Community ·
Settings. Each line is `<code>command</code> — what it does`. No prose paragraphs, no
developer-style dump.

`RETIRED_COMMANDS` (`/check`, `/short`, `/detail`, `/standard`, `/compact`, `/scan`) is exported
and asserted against, so a retired command cannot quietly reappear in the help text.

## 5. Priority chains

`/chains`, `/start` and `/help` lead with the seven priority networks in a fixed order:
**Solana · BNB Chain · Ethereum · Base · Robinhood Chain · HyperEVM · Elysium**.

Everything else is demoted into an "Additional (reduced data)" line, and chains with no market
data (Story) are named as not scannable rather than omitted. No chain count is stated anywhere —
the old "Supported chains (15)" framing is gone from the UI, the README and the command menu.

`/chains` also stops claiming bare `0x` addresses "default to Ethereum". That has been untrue
since automatic resolution landed, and it taught the wrong behaviour; it now says addresses are
resolved automatically and that `/ca <chain> <address>` always wins.

## 6. Icon registry

`src/icons.mjs` — one registry, 72 keys:

- `chain.*` — all seven priority networks plus a fallback
- `section.*` — market, security, narrative, holders, dev, bundle, alerts, PnL, leaderboard, …
- `metric.*` — top 10, tax, LP, dex paid, peak, ROI, hit rate, calls, average, median, …
- `state.*` — good / warn / bad / neutral / unknown
- `cta.*` — website, premium

`icon(name, { theme, fallback })` never returns empty text: an unknown key falls back to a glyph.

**Custom emoji is opt-in (`CUSTOM_EMOJI=1`).** This is a correctness fix, not a preference. A bot
may only send `<tg-emoji>` if it owns a Fragment username; emitting the tag unconditionally would
have had it rejected or printed as literal text on every message. With the flag unset, the
registry emits standard glyphs and the UI is complete either way.

One defect found and fixed while wiring `/start`: Base, Robinhood Chain, HyperEVM and Elysium had
been given the same custom emoji ID, so all four rendered as the same picture in the very list
that exists to tell them apart. They now keep distinct standard glyphs until a real per-chain
asset exists.

## 7. PnL background personalisation

`/pnlbg` (DM only) — the next image sent becomes the user's PnL background.
`/pnlreset` — back to the default gradient.

- JPEG / PNG / WebP up to 5 MB; the largest Telegram photo size is chosen, never the thumbnail.
- Rejections state the limit rather than silently ignoring the upload.
- Stored per user as a `file_id` in `data/pnl-backgrounds.json` (`PNL_BG_STORE` overrides).
- Resolved at render time through an authenticated `getFileLink` call, so no bot token ever
  appears in a shared image.
- Composited with a dark scrim. **Verified by eye:** at 0.55 the primary figures were legible but
  the secondary labels and footnote were not; at 0.78 everything reads while the image stays
  clearly visible.
- Any failure — missing entry, dead URL, unfetchable image — falls back to the default gradient.

## 8. Caller profile (OWNER's headline complaint)

Calls were sorted **chronologically, newest first**, which pushed the best-performing tokens to
the bottom. Now:

- **Peak multiplier descending by default**, sorted over the **whole period dataset before
  pagination** — page 2 continues the ranking instead of showing an unrelated slice.
- Total-order tiebreaks (multiple → calledAt → token key), so identical rows cannot swap between
  renders.
- Inline buttons: **Best Calls** / **Current ROI**, 1D / 1W / 2W / 1M, Prev / Next. Changing
  period or mode resets to page 0, because page 4 of a differently-ordered list is meaningless.
- Summary block: Calls, Hit Rate (≥2x), Best, Avg, Median, and currently up/down/no-price.

**Peak and current are two separate facts and are never merged.** A call can have a 5x peak and
be below entry now. Peak is a historical observation; current is mark-to-market and is never
described as realised profit. Peak tone: ≥2x green, 1–2x yellow, 1x neutral, unmeasured unknown.
Current tone: above entry green, below red, breakeven neutral, **no price unknown — never a
loss**.

A call that has not reached 2x is not "losing". Missing price data is not zero and not a loss.

## 9. Leaderboard

Default ranking changed from hit-rate-first to **Best Call first**; **Hit Rate** and **Average
Peak** are selectable. Medal icons for the top three; each row shows rank, name, best call, total
calls, hit rate and average peak.

`MIN_CALLS_FOR_HIT_RATE = 2` prevents a single lucky call from topping the rate board. A caller
below the floor still appears with their figures — they are simply not ranked on a rate that is
not yet meaningful. A caller with no measured calls sorts last rather than first. Group isolation
is unchanged.

## Defects found during this round

| Defect | Impact | Fix |
| --- | --- | --- |
| Four chains shared one custom emoji ID | Base/Robinhood/HyperEVM/Elysium looked identical | Distinct glyphs; no shared asset |
| `<tg-emoji>` emitted unconditionally | Would break every message on a bot without a Fragment username | Opt-in via `CUSTOM_EMOJI` |
| Callback payload gained a `rank` field | Page number would have been read as a ranking mode | Parser accepts both 4- and 5-field shapes |
| `callMetrics` read only `lastMarketCapUsd` | A caller passing `currentMarketCapUsd` got "unknown" instead of a real ROI | Accepts either name; absent stays null |
| PnL scrim at 0.55 | Secondary text illegible over a photo | 0.78, verified visually |
| `/chains` claimed a default chain | Contradicted the resolver; taught wrong behaviour | Rewritten |
| Retired-mode reply wording | Its own copy referred to a view that no longer exists | Kept as specified by the brief |

## Tests

**935/935, run twice.** 31 new tests in `test/round6-ui.test.mjs`, covering every acceptance
point in the brief:

- sorting: 3.8x above 1.3x, 10x above 2x, **10x above 9x** (the case lexicographic sorting
  fails), deterministic under ties, sorting before pagination;
- peak vs current never confused; a 5x-then-below-entry call renders both correctly;
- missing price is unknown, never zero or a loss;
- empty profile and empty leaderboard render;
- `/ca` registered in both forms, `/check` alias-only and unadvertised, `/scan` absent;
- card-mode commands answer and do not switch;
- `/start` and `/help` content, compactness, no chain count, no dead CTA;
- icon registry completeness, graceful fallback, opt-in custom emoji, seven distinct chain icons;
- PnL background: per-user storage, reset, corrupt-file recovery, format/size rejection,
  authenticated resolution, failure degrades to default.

Sixteen pre-existing tests encoded the superseded behaviour (chronological profile format,
`/check` in help, hit-rate default, card-mode switching, a chain count). Each was updated to
assert the **fact** behind the new requirement, not merely to match new punctuation.

## Not changed

- No data-quality fix was relaxed. Risk consistency, no-false-safe behaviour, holder completeness
  rules, LP-lock distinctions and the provider adapters are untouched.
- Call history, group call tracking, PnL generation, alerts and leaderboard data are unchanged.
- `E:\Projects\Onchain-Intelligence-Scanner` was not modified.
- Nothing pushed, nothing deployed, no poller started, no paid API used. Cost: **$0**.

## Known limitations

Unchanged from Round 5 and still true:

- HyperEVM holders 0% — no keyless source; needs an OWNER-created `ETHERSCAN_API_KEY`.
- Narrative 57%, Top 10 83%, tax 74%, LP 40% — source coverage limits, documented in
  `docs/ROUND5-REPORT.md`.
- Latent graduation-position discovery on Robinhood can exceed an interactive budget; it reports
  `incomplete` rather than a negative finding.
