# Card redesign — STANDARD / SHORT / DETAILED

**Why this revision exists:** the previous build treated "compact" as "fewer
characters" and shipped a 303-character card for a request that asked for a
*readable, professional* card. Character count was the wrong metric. This
revision optimises for scanability, keeps every meaningful field, and makes the
rich card the default.

## Modes

| Mode | Chars (PEPE/BONK) | Purpose |
| --- | --- | --- |
| **STANDARD** (bot default) | 781 / 649 | Balanced premium card: header, MARKET OVERVIEW, SECURITY OVERVIEW, NARRATIVE, PROJECT LINKS, actions |
| SHORT (opt-in) | 331 / 172 | Minimal summary for groups that explicitly ask |
| DETAILED | 1,358 / 1,081 | Full technical: adds RISK FLAGS, HOLDER DETAIL, SOURCES, DYOR block |

Commands: `/standard` (default), `/short`, `/detail`. Legacy `/compact` still
works and maps to SHORT, so saved workflows do not break.

## Layout rules that were applied

1. **Aligned label/value rows.** Values start in the same column because the
   label is padded *after* the colon (`Price:      $1.53`), not before it. The
   previous `Price     :` form read as a typo.
2. **No stacked horizontal rules.** Sections are separated by one blank line.
   The standard card contains at most one rule; the old card had five.
3. **No dense statistics line.** `MC $1.5B · Liq $24M · 24H +8%` was removed
   from the default because it cannot be scanned. SHORT may still pair short
   metrics, by design.
4. **Security rows carry a tone dot.** 🟢 healthy / 🟡 caution / 🔴 risk /
   ⚪ neutral-or-unknown, one marker per row so the label column never shifts.
5. **Short meaningful labels**: `MC`, `Liq`, `Vol 24H`, `1H`, `24H`, `Top 10`,
   `Tax (B/S)`, `LP Locked`, `Creator Holds`.
6. **"Creator Holds", never "Dev".** The value is the creator's *current*
   balance from GoPlus. Labelling it a dev verdict would assert history the
   source does not provide.
7. **DYOR marketing list removed from the default.** It remains in DETAILED
   only, and the "coming soon" text is a plain sentence, not a promo block.

## Fixed during visual acceptance

Rendering the cards revealed four defects that unit tests had not caught:

| Defect | Impact | Fix |
| --- | --- | --- |
| `primaryPair` used deepest-liquidity alone | BONK showed **$874B market cap** and $17K volume, from one Meteora pool quoting a different asset, against a true ~$200M | Rank by depth *within the median-market-cap cluster* (3x band); outlier pools rejected |
| `pairAge` mixed 30-day and 365-day months | "Pair Age: **3y 12mo**", and "0y 11mo" at the boundary | Single 30.4375-day month basis, rounded for >=365d |
| A GoPlus fetch failure rendered five dashes | Indistinguishable from "provider reported nothing" — read as a near-clean card | Explicit `Risk data could not be fetched … incomplete, not clear` line |
| A bare 🖼 glyph for the logo | Looked like a broken image | Removed; a real thumbnail needs `sendPhoto`, noted in code |

## Data safety preserved

- **Escaping**: every interpolated value is escaped at the point of assembly.
  `<1%` and `<-100%` are legal display strings and illegal HTML tag openers;
  unescaped they fail the whole send with *"Unclosed start tag"*.
- **Three unavailable states**, never interchangeable: a value, `—` (source
  covers the chain, reported nothing), `n/a` (chain has no such source).
- **Material warnings are never dropped for brevity.** A 92% concentration or a
  25% tax appears in all three modes.
- **Unsupported chains** state "Chain Not Supported Yet… not a statement about
  the token", distinct from "Token Not Found".
- **No dead buttons.** Chart requires a real pair URL; Analysis requires a real
  token page; placeholder, credentialed and non-HTTPS URLs never become buttons.
- **Inconsistent market data** is disclosed inline, and the figure is still
  shown rather than silently suppressed.

## Verification

- 194/194 tests, including a Telegram-HTML structural validator run across
  every mode × unavailable state × hostile token name.
- 12 real owner-DM sends (4 token cases × 3 modes), all accepted by the API,
  CA present exactly once, no `[mock]` leak, no raw HTML, custom emoji parsed.
- Two STANDARD variants rendered side by side for owner comparison before the
  default was fixed.
