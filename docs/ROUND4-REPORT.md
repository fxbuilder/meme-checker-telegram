# Round 4 — data intelligence report

Branch `mc/phase7-integrated`. **803/803 tests.** Live data measured on the seven priority
chains.

---

## 1. What each OWNER-reported defect actually was

| Reported | Root cause | Fix |
| --- | --- | --- |
| Top 10 = 20% green on card, yellow in `/risk` | **Two threshold tables** (card `>=25 warn`; `/risk` `'low'` which rendered **yellow**), **and** severity banded on the raw value while the display rounded (`19.98` printed as `20.0%`) | One engine (`risk-classify.mjs`), banded on the rounded value |
| TEXEL narrative mechanically written / truncated | A description opening with its own subject was prefixed `"The project describes itself in these terms."` | Provenance moved to a trailing `(project description)` tag |
| TEXEL LP Lock unavailable | No keyless aggregator reports EVM LP state; the scanner never read the chain | On-chain `balanceOf`/`totalSupply` read from the pair contract |
| Tax provenance unverified | Tax and transfer fee shared one code path; a one-sided value was copied into the other side | Separate classifiers; one-sided stays one-sided |
| Freezable / LP ambiguous dashes | A null LP block rendered as `0% (unlocked)` in one branch (`Number(null) === 0`) | Explicit null guard; unknown is `—`, never `0%` |
| Market warning did not identify the inconsistency | A flat boolean | `marketImplausibilities()` names the field and reason |
| Burned shown under "LP Locked" | One label for two different guarantees | `LP Burned` vs `LP Locked`, plus `Partial N%`, `Unlocked`, `Bonding curve` |

**A fabrication found while fixing the above:** `classifyTax({buy: null, sell: 4})`
returned `{buy: 4, sell: 4}` — inventing a symmetric tax the provider never reported. It
now renders `Sell 4.0%`.

---

## 2. Newly integrated sources

| Source | Endpoint | Keyless | What it actually provides |
| --- | --- | --- | --- |
| **GeckoTerminal `elysium`** | `/networks/elysium/tokens/{addr}/info` | yes | Elysium IS indexed (verified: AGI/HYPE, USDC/WHYPE pools). Added as chain 17 |
| **Elysium RPC** | `https://elysium.drpc.org` | yes | `eth_chainId` → `0x1863d` (99901) |
| **HyperEVM RPC** | `https://rpc.hyperliquid.xyz/evm` | yes | `eth_chainId` → `0x3e7` (999), `eth_call` works |
| **Pons `getTokenInfo()`** | selector `0xabb1dc44` on the token | yes | Returns `(deployer, logo, description, Socials)`. PONS → `"100% of fees go back to Pons"` — on no indexer |
| **EVM V2 pair state** | `balanceOf` / `totalSupply` on the pair | yes | Burn detection, verified against a live PancakeSwap V2 pair |
| **Robinhood RPC** | `https://rpc.mainnet.chain.robinhood.com` | yes | Verified from Pons docs; `eth_call` works |

All selectors computed with Keccak-256 and cross-checked against
`transfer(address,uint256) = 0xa9059cbb`.

---

## 3. Sources evaluated and REJECTED

| Source | Why rejected |
| --- | --- |
| **GMGN** `openapi.gmgn.ai/v1/token/info` | **401**, key required, no free tier — and its documented fields (`pool`, `dev`, `link`, `stat`) contain **no description field**, so it would not help even with a key |
| **Robinhood Blockscout** | `api/v2` serves a **Cloudflare "Just a moment"** challenge. Unusable without a headless browser |
| **Pons website** (ponsfamily.com) | Describes the **launchpad**, not the token. Attributing it to a token would be wrong |
| **Pons docs** | Protocol documentation, not per-token prose — but useful as the `getTokenInfo` ABI source |
| **four.meme** | `get?address=` returns `{"code":0}` with no data; `/trending` and `/new` 404 |
| **BscScan / Etherscan** | API key mandatory; `tokeninfo` has no description field |
| **DexScreener `token-profiles/latest`** | Carries descriptions but is **feed-only** — no per-address lookup, unusable on demand |
| **Verified lockers (UNCX etc.)** | `VERIFIED_LOCKERS` is **deliberately empty**: no deployment was verified live this round. Listing an unverified address would report an arbitrary LP holder as a lock |

---

## 4. LP lock and tax implementation

**LP (`src/security/lp-intel.mjs`)**

Reads the pair contract directly — two `balanceOf` calls plus `totalSupply`:

- `BURNED` — LP held at `0x0` / `0xdEaD`; unredeemable, permanent. Verified live.
- `PARTIALLY-LOCKED` — a real share burned, exact percentage reported.
- `LOCKED` — only when a **verified** locker holds it (none listed; see above).
- `UNKNOWN` — nothing conclusive. A dash, never "unlocked".

**Pool-type guard.** V2 LP-supply maths is invalid for a V3 NFT position or a V4 position
id. Measured: the deepest CAKE pairs on BSC are **all v3**, and `totalSupply()` reverts on
them — which previously looked like an unreadable contract. DexScreener labels pairs
`v2`/`v3`, so the label short-circuits the read and the card states *"V2 lp-supply maths
does not apply"* instead of an unexplained dash.

**Tax.** Buy and sell are classified independently. A one-sided measurement stays one-sided.
`N/A` is reserved for a **verified** legacy SPL token (the concept cannot exist); an unknown
token standard is `—`. A Token-2022 transfer fee is labelled **Transfer Fee**, not tax.

---

## 5. Coverage matrix (live, current code)

Per-chain, per-field. `·` = unavailable.

**Solana** — n=10, narrative 70%, Top 10 100%, holders 100%, tax 90%, LP 80%, creator 80%
**BNB Chain** — n=10, Top 10 and holders strong on tokens GoPlus indexes; weak on brand-new
launches (see §7)
**Ethereum** — n=6, narrative 67%, Top 10 83%
**Robinhood** — n=10, Top 10 100%, holders 100%, creator 100%; **tax 0%** (GoPlus reports
none for Pons tokens), **narrative from launchpad metadata only**
**HyperEVM** — n=5, narrative 60%, **Top 10/holders/tax 0%**
**Base** — no seeds collected this run (GeckoTerminal throttling)
**Elysium** — n=10, narrative 50%, **Top 10/holders/tax 0%**

### METHODOLOGY CAVEAT — read before comparing to Round 3

GeckoTerminal's "top pools" list **rotates**, so two runs sample different tokens. The
Round 3 → Round 4 comparison is therefore **not** like-for-like, and I am not claiming a
percentage improvement from it. BSC in particular went from mid-cap tokens (which GoPlus
partially indexes) to a set including very fresh launches. Where a number moved, the cause
is the sample, not the code.

What **is** like-for-like and independently verified: the same input now produces the same
severity on both surfaces (TEXEL at 19.36% → green on card **and** `/risk`; at 20.0% →
yellow on **both**).

---

## 6. OWNER's named tokens, current code

```
TEXEL   scan ok · top10 19.36% · narrative YES (GeckoTerminal)
PONS    scan ok · top10 21.55% · narrative YES (launchpad metadata — the contract's own text)
SHADE   scan ok · top10 48.25% · narrative YES (official website)
```

All three previously failed at least one of these.

---

## 7. Remaining blockers — real, with evidence

| Blocker | Evidence | Alternative |
| --- | --- | --- |
| **HyperEVM + Elysium have no holder/concentration/tax data** | GoPlus `/supported_chains` (46 chains) excludes both; GeckoTerminal returns `holders: null` | A paid holder indexer. None free verified |
| **GoPlus returns at most 10 holder rows**, often including the burn address | Live response shows `holders` length exactly 10 with `0x…dEaD` at slot 1 | No free alternative found |
| **Robinhood tax** | GoPlus reports none for Pons tokens | Needs a sell simulation (see below) |
| **LP lock on V3/V4 pools** | `totalSupply()` reverts on V3; V4 has no fungible LP token | Position-manager NFT read; research subagent did not report back |
| **Verified locker detection** | No locker deployment verified live on any priority chain | Would need per-locker ABI reads; not attempted without a verified address |

**Deliberately not done:** no read-only buy/sell simulation was implemented. Doing it
safely needs a state-override `eth_call` or a local fork, and I could not verify that the
public RPCs for Robinhood/HyperEVM/Elysium support state overrides. Shipping an unverified
simulation would risk reporting a fabricated tax figure, which is worse than `—`.

---

## 8. Latency and cost

- **No paid API was added.** Everything above is free and keyless.
- Per-scan provider calls added: **1–3 RPC reads** (LP intel) plus **1 RPC read + 1 IPFS
  GET** (launchpad metadata), each cached 6h. No new aggregator calls.
- The launchpad read retries **once** on failure (Robinhood RPC throttles bursts).

---

## 9. Files changed

```
src/risk-classify.mjs               NEW  shared severity engine (single source of thresholds)
src/security/lp-intel.mjs           NEW  on-chain LP read + V2/V3 guard
src/research/launchpad-metadata.mjs NEW  getTokenInfo() decoding + socials
src/chains.mjs                           Elysium chain, RPCs for 6 priority chains
src/card-layout.mjs                      shared classifier, LP labels, named inconsistency
src/risk-commands.mjs                    delegates to shared engine
src/risk-intel.mjs                       LP intel wiring, minRows guard, reordered checks
src/format-card.mjs                      natural prose, named warning
src/live-scan.mjs                        pair labels threaded to risk
src/research/geckoterminal.mjs           elysium slug
test/phase10-consistency.test.mjs   NEW  19 tests
test/phase10-lp-intel.test.mjs      NEW  12 tests
test/phase10-matrix-fixes.test.mjs  NEW   7 tests
```

Commits: `f4d3ab8`, `7edfcad`, `2aee60d`, `f7a0f1a`.

---

## 10. OWNER acceptance checklist

| # | Action | Expected |
| --- | --- | --- |
| 1 | `/risk 0x0ddcab9ae04bda0c87ecc1640636fa11e8e613e8` (TEXEL) | Top 10 ~19.4% and **green**, matching the card exactly |
| 2 | Scan a token at 20–49% Top 10 | **Yellow on both** card and `/risk` |
| 3 | `/narrative 0x39dbed3a2bd333467115de45665cc57f813c4571` (PONS) | `100% of fees go back to Pons`, source **launchpad metadata** |
| 4 | Scan TEXEL | No `"The project describes itself in these terms."` preamble |
| 5 | BONK card | `LP Burned 100%` under **LP Burned**, not "LP Locked" |
| 6 | A V3-pool token | LP shows the V3 reason, not a bare dash |
| 7 | Any token with implausible volume | Warning **names** "Volume 24H" |
| 8 | `/narrative bsc 0xb4f9d1b2…7777` | Card, no chain prompt |
| 9 | Paste SHADE three times | Three cards |
| 10 | A Monad/MegaETH token | Fields `n/a`, never green |

---

## 11. Targets: measured against, not claimed met

| Target | Status |
| --- | --- |
| Priority-chain routing 100% | **met** — all 7 scan |
| Identity and market ≥95% | **met** on Solana/BSC/Robinhood; Base seeds failed |
| Narrative ≥95% where evidence exists | **not met** — 50–70% by chain |
| Tax ≥90% applicable | **not met** — Robinhood 0% |
| LP ≥90% applicable | **not met** — most deep pools are V3/V4 |
| Holder + concentration ≥90% | **met on 3 of 7 chains**, 0% on HyperEVM/Elysium |
| **Risk severity consistency 100%** | **met**, by construction |
| No silent responses / no false-safe / no fabrication | **met** — three false-safe paths found and closed |

The three false-safe paths closed this round: one-holder sample → green `Top 10: 0%`;
null LP → `0% (unlocked)`; one-sided tax → symmetric fabrication.
