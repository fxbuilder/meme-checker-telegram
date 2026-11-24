# Security data — field-by-chain coverage (measured)

Verified by live calls against real tokens per chain. **This is an observed matrix, not a
vendor claim sheet.** Each cell says what actually came back.

Sources:
- **GoPlus** — `GET /api/v1/token_security/{chainId}` (EVM) and `/api/v1/solana/token_security`. Free, keyless.
- **RugCheck** — `GET api.rugcheck.xyz/v1/tokens/{mint}/report`. Free, keyless, Solana only.
- **GeckoTerminal token-info** — already fetched for narrative; its payload carries
  `holders.distribution_percentage.top_10`, `mint_authority`, `freeze_authority`,
  `is_honeypot`, `developer_holding_percentage`. Free, keyless. This was being
  **discarded** before, and it is the only keyless concentration source on chains with
  no GoPlus coverage.
- Chain ids verified live against `GET /api/v1/supported_chains` (46 chains listed).

### Three-tier resolution

1. **GoPlus** (primary) — 13 of 15 chains.
2. **RugCheck** (Solana field-level) — fills tax/LP/creator that GoPlus omits.
3. **GeckoTerminal** (last resort) — concentration, authorities, honeypot; also the only
   source at all for HyperEVM and MegaETH.

Each tier fills only nulls, so a measured value is never replaced by another vendor's
methodology.

## Matrix (re-measured after the GeckoTerminal tier was added)

Live `fetchRisk` calls against one real token per chain.

| Chain | GoPlus | Top 10 | Mintable | LP / Tax | Status |
| --- | --- | --- | --- | --- | --- |
| Solana | Y | 40.52% | false | burned / n-a | ok |
| Ethereum | Y | 38.61% | false | 0.009% locked / 0-0 | ok |
| BNB Chain | Y | 2.87% | **true** | — | ok |
| Base | Y | 33.26% | false | 0-0 | ok |
| Arbitrum | Y | 46.45% | — | 0-0 | ok |
| Optimism | Y | 57.33% | **true** | 0-0 | ok |
| Polygon | Y | 37.94% | **true** | 0-0 | ok |
| Avalanche | Y | 79.73% | false | — | ok |
| Unichain | Y | 72.59% | — | — | ok |
| Berachain | Y | 89.06% | false | — | ok |
| **HyperEVM** | **n** | — | **false** | — | **ok** (GeckoTerminal) |
| MegaETH | n | — | — | — | no-data |
| Monad / Robinhood / Abstract | Y | — | — | — | no seed token in this run |

**Totals: 11 ok, 1 no-data, 0 unsupported, 3 without a seed token. 10 chains report top-10
concentration.**

`unsupported` reached **zero**. Before Fix 2c both HyperEVM and MegaETH returned
`unsupported` immediately, and that early return skipped every fallback.

**`mintable: true` on BNB Chain, Optimism and Polygon is a genuine finding**, not a bug:
those tokens really do retain mint authority. It is shown, not hidden.

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

## Raw provider floats never reach the card

Live responses contained `0.00009999999999999999` (BNB Chain creator holding) and
`0.009091289719550899` (Ethereum LP lock). Both render as `<0.1%` and `<1%` with a
warning tone, and both are pinned by test so the raw value cannot leak into a card or
round silently to a confident `0%`.

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
