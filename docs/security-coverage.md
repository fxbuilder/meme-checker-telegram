# Security data — field-by-chain coverage (measured)

Verified by live calls against real tokens per chain. **This is an observed matrix, not a
vendor claim sheet.** Each cell says what actually came back.

Sources:
- **GoPlus** — `GET /api/v1/token_security/{chainId}` (EVM) and `/api/v1/solana/token_security`. Free, keyless.
- **RugCheck** — `GET api.rugcheck.xyz/v1/tokens/{mint}/report`. Free, keyless, Solana only.
- Chain ids verified live against `GET /api/v1/supported_chains` (46 chains listed).

## Matrix

| Chain | GoPlus id | Tax / Fee | LP lock | Creator holds | Top 10 | Status |
| --- | --- | --- | --- | --- | --- | --- |
| Solana | `solana` | **fee n/a on legacy SPL** (Token-2022 → transfer fee) | ✅ burned 99.99% | ✅ 0.0% | ✅ 40.5% | ✅ verified |
| Ethereum | `1` | ✅ 0/0% | partial (0.009%) | ✅ 0% | ✅ 38.6% | ✅ verified |
| BNB Chain | `56` | — (not reported) | — | ✅ 0% | ✅ 2.9% | ✅ verified |
| Base | `8453` | ✅ 0/0% | — | ✅ 0% | ✅ 33.3% | ✅ verified |
| Arbitrum | `42161` | ✅ 0/0% | — | ✅ 0% | ✅ 46.5% | ✅ verified |
| Optimism | `10` | ✅ 0/0% | — | ✅ 0% | ✅ 57.3% | ✅ verified |
| Polygon | `137` | ✅ 0/0% | — | ✅ 0% | ✅ 37.9% | ✅ verified |
| Avalanche | `43114` | — (not reported) | — | ✅ 0% | ✅ 79.7% | ✅ verified |
| **Monad** | **`143`** | — | — | — | — | ⚠️ endpoint live, token had no record |
| **Robinhood Chain** | **`4663`** | ✅ 0/0% | — | ✅ 0% | ✅ 27.5% | ✅ **verified** |
| **Unichain** | **`130`** | — | — | ✅ 0% | ✅ 72.6% | ✅ **verified** |
| **Berachain** | **`80094`** | — | — | — | ✅ 89.1% | ✅ **verified (partial)** |
| **Abstract** | **`2741`** | — | — | — | — | ⚠️ endpoint live, token had no record |
| HyperEVM | — | — | — | — | — | ❌ unsupported |
| MegaETH | — | — | — | — | — | ❌ unsupported |

**10 of 15 chains verified with real data.** 13 of 15 have a working provider endpoint.

## What changed and why it was wrong

The chain registry had `goplus: null` for Monad, Robinhood, Unichain, Berachain and
Abstract — so every security field on those chains rendered `n/a` and the chains were
believed unsupported. GoPlus **does** cover all five; the ids were simply never entered.
Robinhood Chain, previously "no source at all", now returns tax, creator holding and
concentration.

## Field semantics that were wrong before

**Burned ≠ locked.** A destroyed LP mint (`lpMint == 1111…1111`) can never be withdrawn; a
locked one expires. BONK reports burned 99.99%, and the card now says `Burned 100%`
rather than `0% locked`. Provider `lockedPercentage` and `burnedPercentage` are kept as
separate fields and only summed for the `securedPct` summary.

**Solana has no buy/sell tax.** A Token-2022 token may carry a per-transfer fee, which is
a different instrument. Verified both paths:
- BONK → `tokenProgram: Tokenkeg…` (legacy SPL) → **no tax field at all**. The card shows
  `Tax: —`, which is truthful: there is no fee concept, not an unmeasured fee.
- PYUSD (`2b1kV6Dk…`) → `token-2022` with `transferFeeConfig` → a `transfer-fee` tax
  block is produced and labelled `Transfer Fee`, not `Tax`.

**Known creator ≠ creator holding.** RugCheck returns `creator` plus `creatorBalance` in
**raw token units**. Dividing by `10^decimals` before comparing to supply is the
difference between a correct 0% and a wildly wrong figure. Contract owner and metadata
authority are separate fields and are not conflated with the original creator.

## A fabrication bug found while testing

`Number(null)` is `0`, so `Number.isFinite(Number(lp.lockedPercentage))` turned an
**unknown** locking state into a confident `0% / unlocked` verdict. Null now renders `—`;
a genuine zero still renders `0%`. Five states are covered by test: null → `—`,
zero → `0%`, 0.09 → `<1%`, burned ≥50% → `Burned N%`, undefined → `—`.

## Gaps and what they cost

- **HyperEVM, MegaETH** — no provider. GoPlus does not list them (checked against the live
  supported-chains list), and no free alternative was found. Rendered `n/a`, never as safe.
- **LP lock on EVM** — GoPlus reports it for some tokens only; when absent the card shows
  `—`, never "unlocked".
- **Tax on BNB/Avalanche/Unichain/Berachain samples** — GoPlus did not report it for those
  specific tokens. Absent, not zero.
- **Monad / Abstract** — the endpoints answer, but the tokens tested had no record. That is
  "provider has no data", which is different from "chain unsupported".

## Cost

Every source used is **free and keyless**. No paid API was purchased or required. If paid
depth is ever wanted, Birdeye's security endpoint returns 401 without a key on every
attempt — provider, endpoint and missing credential are recorded in the research notes,
and nothing was signed up for.
