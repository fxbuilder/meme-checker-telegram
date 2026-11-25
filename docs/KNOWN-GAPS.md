# Known data limitations — measured, not estimated

Every entry below was established by probing the actual route or mechanism and recording the
result. Nothing here is "we assume it will not work."

**Read this before promising coverage.** The bot is honest about what it could not measure; it
is not a safety guarantee, and no field is a guarantee.

---

## 1. The headline coverage, with denominators

Fixed 35-token sample across the seven priority chains (`benchmark/manifest.json`). Addresses are
pinned and never rotate.

| Field | Raw | Applicable | n/a | Meaning of the gap |
| --- | --- | --- | --- | --- |
| narrative | 57% | 57% | 0 | 15 tokens have **no description published anywhere** |
| holders | 91% | 91% | 0 | HyperEVM only (no keyless source) |
| top10 | 83% | 83% | 0 | Ethereum 40% — GoPlus omits `holders[]` |
| tax | 74% | **87%** | 5 | 5 legacy SPL tokens genuinely have no tax |
| lp | 40% | 40% | 0 | V3/V4 positions not discoverable |
| dev | 74% | 74% | 0 | creator address known, holding unmeasured |
| dexPaid | 77% | 77% | 0 | Elysium/HyperEVM not indexed |
| consistency | 100% | 100% | — | card and `/risk` cannot disagree |

**Raw** = covered / all tokens. **Applicable** = covered / (all minus proven not-applicable).
Tax is the only field where they differ, because proving a tax does not exist is an answer.

---

## 2. LP lock — 40%, and why it is capped

This is the largest gap and it is **structural**, not a missing retry.

LP lock state is determinable only where a readable LP token or a discoverable position exists:

| Case | Determined? | Mechanism |
| --- | --- | --- |
| Solana (RugCheck) | **Yes** | `lp.lpLockedPct` / `lp.lpLocked` per market |
| Uniswap/Pancake **V2** pair | **Yes** | `balanceOf(burn)/totalSupply()` on the pair |
| Pons-graduated Robinhood (V4) | **Yes** | `PoolGraduated` event names the positionId |
| **V3 position** | **No** | needs a `tokenId`; no owner enumeration |
| **V4 position, no event** | **No** | same, and `positions()` reverts |

Verified: `PositionManager.tokenOfOwnerByIndex` **reverts** — V4 positions cannot be enumerated by
owner, and a pool does not list its positions. So a V4 pool with no graduation/mint/locker log
cannot be assessed, and renders `V3/V4` rather than a percentage.

**Never done, deliberately:** a position's liquidity is not divided by pool liquidity and called
a "locked percentage". Liquidity units are only comparable within a tick range. One position is
reported as a position-level fact, with the pool's liquidity alongside as context.

To close this gap: a paid position indexer, or per-pool log work that is too slow for an
interactive request.

---

## 3. HyperEVM holders — impossible without a paid plan

**A free Etherscan key does NOT work.** Verified against Etherscan's own endpoint metadata, which
tags `tokenholderlist`, `tokenholdercount`, `topholders` and `tokeninfo` all as **PRO** — PRO
means the paid Standard plan and above.

HyperEVM compounds it: per Etherscan's supported-chains page, HyperEVM Mainnet (999) community
endpoints are free only until **2026-11-30**, and require **Lite or above** from 2026-12-01.

An earlier internal note claimed a free key would unlock this. **That was wrong** and is corrected
here and in the code, so nobody creates a key expecting it to work.

Every keyless route was probed and failed:

| Route | Result |
| --- | --- |
| GoPlus `supported_chains` | no HyperEVM entry |
| GeckoTerminal | no holder fields on HyperEVM token records |
| `purrscan.com` | 469-byte JS shell — no data, no `/api` |
| `hyperevmscan.io` | redirects; V1 routes deprecated |
| routescan | "chain not supported" for 999 |
| public RPC `eth_getLogs` | **"query exceeds max block range 1000"** |

A genesis-to-head Transfer scan is **52,189 requests / ~104 minutes** at measured throughput
(~120 ms/window, 9 of 10 windows erroring under load). Not viable interactively.

The adapter exists, is correct, and reports `not-configured` or `plan-required` — never zero
holders.

---

## 4. Elysium — holders solved, tax and LP not

Holders are solved via Elyscan's server-rendered token page (982 / 3,329 / 970 holders on the
sample). But:

- **`eth_getLogs` is capped at 100 blocks** on the only working public RPC. A Transfer scan would
  be ~105,000 requests. Log-derived holder enumeration is impossible here.
- **No tax source.** GoPlus has no Elysium entry; the simulation needs a holder to send from, and
  the RPC cannot enumerate holders. Reports `not-applicable`/`unavailable`, never 0%.
- **LP is 0%.** No position manager configured; pools are v4 with no discoverable position.
- **Dev holdings 0%.** No provider carries a creator balance for this chain.

---

## 5. Narrative — 57%, source-bound not extraction-bound

15 of 35 tokens have **no description published anywhere** that any keyless source exposes:

- **DexScreener pairs carry no `description` field at all** — by schema, not by omission.
- GeckoTerminal serves one only where the project filled it in.
- Launchpad metadata helps only where the launchpad documents a getter (flap.sh `metaURI()`,
  Pons `getTokenInfo()`).
- An empty published description stays empty. It is not replaced with invented prose.

Reaching 95% would require a paid data provider or scraping, and scraping was not approved.

---

## 6. Tax — 87% applicable

- **GoPlus** covers 13 of the 15 market chains.
- **Simulated transfer fee** works on Robinhood and Elysium (`eth_simulateV1`) **when a real
  holder can be used as sender**. HyperEVM has no post-state method at all.
- A simulated transfer from a synthetic sender **reverts** (it has no token balance), and reading
  a tax from that revert would fabricate 100%. The code refuses.
- **A transfer fee is labelled a transfer fee**, never a buy/sell tax: a swap also crosses a pool,
  so price impact and DEX fees would otherwise be attributed to the token.

---

## 7. Top 10 — 83%

Ethereum is 40%: GoPlus omits `holders[]` for some established tokens, and concentration cannot be
computed from absence. Where fewer than 10 holders exist the field is `partial`, because a sum
over 4 holders is not a "Top 10".

Concentration excludes nothing — burn, locked and treasury addresses are included, so a token that
burned most of its supply looks concentrated. That is stated as raw concentration.

---

## 8. Fields that are always `unknown` by design

- **`dexPaid` on Elysium and HyperEVM** — DexScreener `orders/v1` does not index them. Rendered
  `unknown`, never "not paid", because an unindexed chain is not evidence of non-payment.
- **Creator holding on chains with no creator-balance source.**
- **Holder count where the method is blocked** — for example Solana `getTokenLargestAccounts`
  returns a hard `429` for every mint (a method block, not a throttle), so enumeration is never
  used on a per-scan path.

---

## 9. Configuration-dependent features

Not gaps, but they are absent until configured:

| Feature | Needs | Without it |
| --- | --- | --- |
| Token page CTA | `TOKEN_PAGE_BASE_URL` | Button hidden |
| Premium teaser | `PREMIUM_URL` | Blocks hidden |
| `/alerttest` | `TELEGRAM_TEST_GROUP_ID` | Command refuses |
| X discussion | `GETXAPI_KEY` or `SORSA_API_KEY` | Section reports not-configured |
| Signed caller links | `CALLER_LINK_SECRET` | Links unsigned |

---

## 10. What this bot never claims

- It does not claim a token is safe, ever. Fields are checks, not guarantees.
- It does not claim realised trading profit — nothing in the pipeline knows anyone's fills.
  Multipliers are measured peaks.
- It does not claim full chain coverage.
- It does not claim a lock is permanent unless three things are proven: a known locker owns the
  position, it exposes no standard withdrawal, **and** it is not an upgradeable proxy.
- It does not treat a provider's silence as a fact about the token.
