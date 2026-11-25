# ROUND 5 — PRIORITY-CHAIN DATA INTELLIGENCE

Branch `mc/phase7-integrated`. Every claim below was verified against live chain state or a
live endpoint before being encoded; nothing here is taken from a research report unverified.

## What changed, by milestone

| Milestone | Outcome | Evidence |
| --- | --- | --- |
| **A** Pons | **Lock DETERMINED** | `PoolGraduated` → position 4231454 → `ownerOf` = Pons locker |
| **B** Elysium holders | **0% → 100%** | 982 / 3,329 / 970 holders, real Top-10 |
| **C** HyperEVM holders | **blocked, measured** | no keyless source; full scan ≈ 52,189 req / 104 min |
| **D** V3/V4 positions | **field now answers** | TEXEL card: `LP Locked (perm): Yes` |
| **E** Tax | **measured by observation** | TEXEL + PONS: 0 bps, `[0x1,0x1]` |
| **F** Fixed sample | **35 tokens, 7 chains** | all addresses discovered and confirmed |

## Milestone A — Pons

**V1 and V2 are different protocols, not versions of one.** V1 gives each token its own
Uniswap V3 pool at launch; V2 runs a bonding curve that graduates into a V4 pool. Their event
signatures differ, which is why a V1 token returns fifteen zero words from the V2 factory's
`getLaunchedToken()` — it is not a member.

**`launchFactory()` on the token is the authoritative discriminator**, and it replaced an
event-log search that was actively wrong:

| Token | `launchFactory()` | Generation | Phase |
| --- | --- | --- | --- |
| TEXEL | `0x7eD598Bc…` | v2 | `pool-created` (2) |
| AI | `0x7eD598Bc…` | v2 | `pool-created` (2) |
| **PONS** | **`0x0c37a24F…`** | **v1-legacy** | `v3-pool` |

The earlier search reported PONS as `not-pons` because `eth_getLogs` from block 0 fails on this
provider ("query spans N blocks but only 1000 allowed") and that error was being read as "no
matching logs". **A refused or capped query is an outage, never a negative finding.**

**Full position chain, verified on TEXEL:**

```
PoolGraduated(token indexed, positionId, tokenAmount, pairTokenAmount)   topic0 verified against docs
  → positionId 4231454 at block 109,366,842         (found in 3 queries / 1.4s)
  → ownerOf(4231454) = 0x267444D0…                  THE PONS LAUNCH LOCKER
  → getPoolAndPositionInfo → hooks = PonsV2MemeHook, fee 0, tickSpacing 200
  → keccak256(PoolKey) → StateView.getLiquidity = 29,277 tokens
```

**"Permanent" is evidenced, not inferred from graduation:** the locker has no `unlock()`,
`withdraw(uint256)` or `release(uint256)` function, and its EIP-1967 implementation slot is
**zero** (not a proxy).

**Locked supply is not locked liquidity.** Measured: locker holds 81,632,651,172,847,780,
733,814,253 of 1e27 = **8.1633%**, exactly **4/49** as documented. That is token supply; the LP
position is a separate guarantee, kept as separate fields.

**Two search bugs found and fixed:** a strided window (45k window, 180k stride) steps over the
graduation it seeks and spent 110 queries / 32s failing; and the 45k figure was a misreading of
an error that only occurs on a from-block-0 query — the real cap is **5,000,000 blocks**.

## Milestone B — Elysium holders

Elysium rendered 0% on every risk field. The cause was **not** an absent holder source: two
providers we consult have no data there, and that absence was rendered as a fact about the token.

Probed in order, results recorded:

| Endpoint | Result |
| --- | --- |
| `elyscan.fun/api` | JSON, but every token route 404s |
| `elyscan.live/api/v2/stats` | **200** Blockscout JSON (API real, but thin) |
| `…/api/v2/tokens/<addr>`, `/holders`, `/addresses/<addr>` | 404 |
| Etherscan-v1 `/api?module=…` | 404 |
| Bitquery GraphQL | 401 — needs a key (not purchased) |
| `elysium.drpc.org` `eth_getLogs` | **"ranges over 100 blocks are not supported"** |

The last is decisive: a Transfer scan of 10.5M blocks would be ~105,000 requests, so
log-derived holder enumeration is impossible on Elysium. Recorded in `ELYSCAN.maxLogSpanBlocks`.

**What works:** Elyscan's token page is server-rendered with real holder figures.

| Token | Holders | Top 10 | Liquidity pool |
| --- | --- | --- | --- |
| AGI | 982 | 26.34% | 14.49% |
| MONTRA | 3,329 | 62.51% | 5.30% |
| POCKET | 970 | 63.65% | 4.86% |

Parsing is anchored to the **labels** the page renders, not to "any percentage on the page".

## Milestone C — HyperEVM holders

**No keyless holder source exists, and that is measured rather than assumed:**

| Route | Result |
| --- | --- |
| GoPlus `supported_chains` | no HyperEVM entry |
| GeckoTerminal | no holder fields |
| `purrscan.com` | 469-byte JS shell — no data, no `/api` |
| `hyperevmscan.io` | redirects; V1 routes deprecated |
| routescan | "chain not supported" for 999 |
| Etherscan V2 | answers, but `Missing/Invalid API Key` |
| public RPC logs | **"query exceeds max block range 1000"** |

Costed: 1,000-block windows at ~120 ms with 9/10 windows erroring → a genesis scan is
**52,189 requests / ~104 minutes**. Not viable interactively.

Ships an **optional Etherscan-V2 adapter** (free key) that returns `not-configured` *carrying
the exact setup requirement* — never a holder count of 0 — plus a bounded Transfer indexer that
marks every result `scope:'window'`, `complete:false`.

## Milestone D — V3/V4 positions

**TEXEL's LP lock is now determined**: card reads **`LP Locked (perm): Yes`** (tone `none`)
instead of `V3/V4`.

`positions()` reverts on V4 (liquidity lives in the PoolManager), while V3 returns it directly —
so the two need different ABIs, and detection is by which answers, not by configuration.

**Three overclaims refused, each pinned by a test:**

1. A position's liquidity is **never** divided by pool liquidity and called a locked percentage.
2. "Permanently" needs three facts: known locker, no standard withdrawal, **and not a proxy**.
3. V4 reports `positionLiquidity: null` — it stores none.

**A revert is not proof of contract shape.** Probing `upgradeTo()` and reading its revert as
"upgradeable" made the immutable Pons locker look upgradeable, blocking its legitimate
permanent-lock claim. Upgradeability now comes from the EIP-1967 slot.

## Milestone E — Tax

Verified capability:

| Chain | `eth_simulateV1` | `debug_traceCall` |
| --- | --- | --- |
| Robinhood | ✅ | ❌ |
| Elysium | ✅ | ✅ |
| HyperEVM | ❌ | ❌ |

**The first approach would have fabricated 100% tax.** A transfer from a balance-overridden
synthetic sender reverts on the token's own balance check (TEXEL: status `0x0`, gasUsed
`0x5e9c`) because `balance` overrides grant native currency, not ERC-20 tokens.

**The working method passes a REAL HOLDER as `from`** — no storage slot, no balance override:

```
TEXEL  statuses [0x1, 0x1]  sent 1e18  received 1e18  => transfer fee 0 bps
PONS   statuses [0x1, 0x1]  sent 1e18  received 1e18  => transfer fee 0 bps
```

Four ways a figure is refused: a reverted transfer yields `null` (never 0 or 100); a holder with
too little balance is `unmeasurable`; no holder and no slot is `unmeasurable` with the reason;
receiving more than sent is refused.

## Milestone F — Fixed sample

35 tokens across all seven priority chains, every address discovered and confirmed to resolve to
a token whose `baseToken.address` matches exactly. SHADE pinned to
`12bTtDLSegj1rw2oxXWYm63Rxw5QxkVSXDHCErs…` from recorded call history, not guessed between
five same-ticker candidates.

## Measured coverage

Baseline vs after, **same 35 pinned addresses**, both runs on this branch. The "after" run is
the one with the corrected narrative harness.

| Field | Baseline | After | Δ |
| --- | --- | --- | --- |
| narrative | **0%** (harness artifact) | **57%** (20/35 measured) | +57 |
| holders | 77% | **91%** | +14 |
| top10 | 74% | **83%** | +9 |
| tax | 69% | **74%** | +5 |
| lp | 40% | 40% | 0 |
| dev | 60% | **71%** | +11 |
| dexPaid | 0% | 0% | 0 |
| consistency | 100% | **100%** | — |

### By chain (after)

| Chain | n | nar | holders | top10 | tax | lp | dev |
| --- | --- | --- | --- | --- | --- | --- | --- |
| solana | 5 | 20% | 100% | 100% | 100% | 100% | 100% |
| bsc | 6 | 50% | 100% | 100% | 83% | 83% | 100% |
| robinhood | 6 | **83%** | 100% | 100% | 100% | 17% | 100% |
| base | 5 | 40% | 100% | 100% | 100% | 20% | 80% |
| ethereum | 5 | 20% | 100% | **40%** | 100% | 20% | 100% |
| elysium | 5 | **100%** | **100%** | **100%** | 0% | 0% | 0% |
| hyperevm | 3 | **100%** | 0% | 0% | 0% | 33% | 0% |

Elysium went **0% → 100%** on holders, top10 AND narrative. HyperEVM narrative is 100% while
holders remain 0% — the narrative pipeline reaches it, the holder source does not exist.

### Targets: where they stand

| Target | Measured | Status |
| --- | --- | --- |
| Narrative ≥95% where evidence exists | 57% | **not met** |
| Holders ≥90% | 91% | **met** |
| Top 10 ≥90% | 83% | **not met** |
| Applicable tax ≥90% | 74% | **not met** |
| Determined LP ≥90% | 40% | **not met** |
| Risk consistency 100% | 100% | **met** |
| No false-safe indicators | 100% | **met** |

### Why the misses are misses

**Narrative 57%**: 20 measured, 15 `unavailable` — the provider published no description.
Ethereum is 20% and Solana 20%: those samples include large, well-known tokens whose providers
carry no `description` field at all (DexScreener pairs have none by design; GeckoTerminal serves
one only where the project filled it). The gap is source coverage, not extraction.

**Top 10 83%**: ethereum is 40%. GoPlus omits `holders[]` for some established tokens, and a
concentration figure cannot be computed from absence. Three tokens classify `partial` because
fewer than 10 holders exist — that is a correct classification, not a miss.

**Tax 74%**: 5 tokens are `not-applicable` (legacy SPL has no buy/sell tax — a real finding),
11 `unavailable`. Elysium and HyperEVM are 0% because neither has a provider tax source and the
simulation needs a verified holder (which Elysium's RPC cannot enumerate).

**LP 40%**: unchanged, and correctly so. 14 measured, 21 `unknown`. Every `unknown` is a V3/V4
pool with no discoverable position: V4's PositionManager is not enumerable by owner, and a pool
does not list its positions, so discovery needs a graduation/mint/locker event. This is the
honest ceiling without a paid position indexer.

### `dexPaid` was never 0% — the harness was blind to it

Reported as **0% in every run**, and the stability tool duly classified it
`capability-limit (never covered in any run)`. That conclusion was **wrong, twice over**:

- the adapter `fetchDexPaid` reports `status` (`'paid' | 'not-paid' | 'unknown'`), not a boolean
  `paid` — the harness read a field that is never set, so every token classified `unknown`
- the feature works. Verified live: **PEPE → `paid`** (`active tokenProfile`), **CAKE →
  `not-paid`**, **BONK → `not-paid`**

Corrected, it measures **77%** (27 measured, 8 unknown on chains the provider does not index).
This is the second time in this round that a 0% described my measurement rather than the
product — the same error as reading a provider's silence as a fact about the token. A field that
never varies across runs is *usually* a capability limit and *occasionally* an instrument fault;
the `never-covered` verdict now carries that caveat.

### Two apparent regressions investigated, neither a regression

**LP** held at 40% across both corrected runs. An earlier run showed 37% from ONE token — base
PEPE `0x52b492a3…` flipping `measured` → `unknown`. Probed directly: it has **2 pairs, 0 of them
V2**, so `v3` is the correct answer and the baseline had caught a transient.

**Tax** moved 69% → 74%. Within that, four tokens flipped in both directions. Re-ran each twice:
MEME and AI return `{"buy":0,"sell":0}` again, so those were provider throttling; ethereum TRUMP
and MEME gained tax. The harness now stores `scanStatus`/`riskStatus` per row so a flipping field
can be recognised as a throttle from stored data rather than requiring a re-run.

## Costs

**$0.** No paid subscription, no key used, nothing purchased. Keyless endpoints only.

## Remaining blockers

1. **`ETHERSCAN_API_KEY` unset** — free, owner-created, unlocks HyperEVM holders. Non-blocking.
2. **Narrative** — measured properly only in the corrected run; the first harness reported 0%
   because it called `liveScan` (which does not produce narrative) instead of `researchToken`.
3. **V4 position discovery needs an event edge.** The V4 PositionManager is not enumerable by
   owner (`tokenOfOwnerByIndex` reverts, verified) and a pool does not list its positions, so
   discovery requires a graduation/mint/locker log. Without one the honest answer stays "pool
   type known, lock state not measurable" — which PONS correctly falls back to.
4. **Berachain / Monad / MegaETH** deliberately untouched per scope.
5. **Tax on base/ethereum** relies on GoPlus; the simulation path covers only the three
   priority chains where it was verified.
