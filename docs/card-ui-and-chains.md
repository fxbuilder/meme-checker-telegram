# Card UI, Quick Checks and multi-chain coverage

**Baseline:** `mc/live-adapter` → branch `mc/card-ui`
**Verified:** 2026-11-23 against live providers. Every capability below was proven by a real
request, not read from documentation.

---

## 1. Three render modes

STANDARD is the bot default. SHORT is opt-in. DETAILED is the technical view.

| | STANDARD (default) | SHORT | DETAILED |
|---|---|---|
| Identity | `🚀 Name $SYM` + chain on two lines | header block with chain icon + `CA:` label |
| Market | `💰 Price` + one dense line (`MC · Liq · 24H · age`) | full block: price, mcap, FDV, liquidity, volume, change 1H/24H, pair age |
| Quick Checks | ✅ 3 lines × 2 | ✅ same block |
| Holders | covered by Quick Checks | full HOLDER OVERVIEW |
| Security flags | ✗ | ✅ only flags actually known |
| Narrative | only if verified | section always present |
| Project links | one inline row | full three-line PROJECT INFO |
| DYOR teaser | ✗ | ✅ §4.1 block + provenance notes |

Toggle with `/compact` and `/detail`, or `CARD_VIEW=compact|detailed` in env.
`formatCard()` itself defaults to `detailed` so the documented §4.1 contract and all
previous callers keep working; the **bot** passes `compact` explicitly.

Compact measured at **438 chars** vs **1,45x** for detailed on the same token.

## 2. Quick Checks

Fixed order so the position is learnable:
`Top 10 · Holders · Dex Paid · Tax · LP Lock · Dev`

Three distinct unavailable states, never interchangeable:

| State | Renders | Meaning |
|---|---|---|
| value | `38.7%` | measured |
| `—` | dash | source covers this chain, but reported nothing for this token |
| `n/a` | not available | this chain has **no** such data source |

No value is ever defaulted to `0`, `No`, or `Not Paid`. A sub-1% real value renders
`<1%` / `<0.1%` instead of rounding to a reassuring `0%`.

## 3. Dex Paid

Source: DexScreener `orders/v1/{chain}/{token}` → `{orders, boosts}`. An **approved**
order (`tokenProfile` / `tokenAd` / `communityTakeover`) is the paid product.

**The trap that shapes the design:** an invalid chain slug returns `200 {orders:[],boosts:[]}`,
byte-identical to a real chain where the token simply has no orders. So *empty is ambiguous*.

| Result | Chain proven indexed | Chain not proven |
|---|---|---|
| approved order | `Paid` | `Paid` |
| only cancelled/on-hold | `Not Paid` | `Not Paid` |
| empty | `Not Paid` | **`Unknown`** |
| provider error | `Unknown` | `Unknown` |

Chains proven indexed (a non-empty orders/boosts array was actually observed):
**ethereum, bsc, base, optimism, solana, robinhood, berachain**

Every other chain returns `Unknown` and never accuses a project of not paying.
Flipping `dexPaid: false → true` in `src/chains.mjs` after a real probe is the entire change
needed to light up a chain — that is the "alerts later" extension point, and `fetchDexPaid`
already returns a structured `{status, types, since, boosts}` payload suitable for an alert
job.

## 4. Chain coverage — 15 of 16 verified

`SCANNABLE` means `token-pairs/v1/{slug}/{address}` returned a pair whose `baseToken.address`
matched the input exactly.

| Chain | Market | Holders | Tax | LP Lock | Dev | Dex Paid |
|---|---|---|---|---|---|---|
| Solana | ✅ | ✅ | n/a (no such concept) | ✅ | ✅ | ✅ |
| Ethereum | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| BNB Chain | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| Base | ✅ | ✅ | ⚠️ often absent | ✅ | ✅ | ✅ |
| Arbitrum | ✅ | ✅ | ✅ | ✅ | ✅ | Unknown |
| Optimism | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| Polygon | ✅ | ✅ | ✅ | ✅ | ✅ | Unknown |
| Avalanche | ✅ | ✅ | ✅ | ✅ | ✅ | Unknown |
| HyperEVM | ✅ | ✗ | ✗ | ✗ | ✗ | Unknown |
| Monad | ✅ | ✗ | ✗ | ✗ | ✗ | Unknown |
| Robinhood Chain | ✅ | ✗ | ✗ | ✗ | ✗ | ✅ |
| Unichain | ✅ | ✗ | ✗ | ✗ | ✗ | Unknown |
| Berachain | ✅ | ✗ | ✗ | ✗ | ✗ | ✅ |
| Abstract | ✅ | ✗ | ✗ | ✗ | ✗ | Unknown |
| MegaETH | ✅ | ✗ | ✗ | ✗ | ✗ | Unknown |
| **Story** | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ |

**Story is registered but unsupported.** Probed with `STORY`, `IP`, `WIP`, `IPX`,
`Story Protocol`, `SPG` and the token profile/boost feeds: **zero pairs** exist on that chain
in DexScreener. Scanning it renders `Chain Not Supported Yet` — explicitly *not* "Token Not
Found", because a coverage gap is not a statement about a token.

### Why the 8 GoPlus chains, and not more

GoPlus is keyless and returns real `buy_tax`, `sell_tax`, `is_honeypot`, `holder_count`,
`holders[]`, `lp_holders[]`, `creator_*` for chain ids 1/56/137/43114/42161/10/8453 and a
separate Solana endpoint. There is no documented public chain id for HyperEVM, Monad,
Robinhood, Unichain, Berachain, Abstract, MegaETH or Story, so those render `n/a` rather than
guessing an id and getting a silent empty result.

### Solana specifics

The Solana payload has **no** `buy_tax`/`sell_tax`/`is_honeypot` fields. Tax is therefore `null`
with `n/a` on the card, and the honeypot flag stays `null` — deliberately *not* `false`, because
"not checked" and "checked, clean" are different claims.

## 5. EVM address ambiguity

One `0x…` string is valid on 13 different chains. A bare address therefore returns
`ambiguous: true` and the bot shows a **chain picker** with the default starred, instead of
silently scanning the wrong network. Resolve it up front with
`/check base 0x…`, or pin a group default with `DEFAULT_EVM_CHAIN`.

The aggregate endpoint `/latest/dex/tokens/{addr}` was **rejected** for this purpose: it is
capped at 30 pairs and dominated by one chain (measured on USDC: 25 pulsechain vs 5 ethereum),
so it would silently hide chains. Per-chain lookups are used instead.

## 6. Admin permissions

Verified via `getMe` on the staging bot:

- `can_join_groups: true`
- `can_read_all_group_messages: **true**` → **privacy mode is OFF**; the bot receives ordinary
  group messages and auto-detection works with **no admin rights**.
- `can_manage_topics: null`, `supports_inline_queries: false`

**No admin permission is required** for any current feature. Reading messages is a BotFather
privacy setting, not a group permission. Admin would only be needed for optional extras:
deleting its own message on the chain-picker selection (currently fails silently and is
non-fatal), pinning cards, or purging spam. `/resettheme`, `/compact`, `/detail` are
owner-DM/any-chat commands and need no admin either.

## 7. Known limitations

1. **Narrative is still null everywhere.** Neither DexScreener nor GoPlus publishes a
   description; the card shows it only when a source provides one.
2. **Dev = current creator holding, not dev history.** A clean 0.0% says nothing about
   whether this dev has rugged before. Dev-history needs a different source.
3. **Dex Paid reflects the DexScreener order ledger only.** A project that paid someone else,
   or paid and lapsed, is `Not Paid` / `Unknown` accordingly — not a quality verdict.
4. **Top-10 concentration excludes nothing.** It is the provider's top accounts as returned;
   locked/burn addresses are not filtered out, so a token that burned supply can look
   concentrated.
5. **In-process caches only** (market 30 s, risk 60 s, paid 120 s, failures shorter). Correct
   for one poller; needs a shared store before running multiple instances.
