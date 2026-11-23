# Live scan adapter — real vs mock

**Status:** implemented and verified against the live provider on 2026-11-23.
**Not the Core Backend API.** The Core contract is still unconfirmed
([backend checklist](backend-contract-checklist.md)), and the project rule is to
never call a guessed live path. This adapter uses a real, keyless, address-scoped
provider instead so the CA scanning flow is genuinely functional now.

## Why not Core API

`CORE_API_BASE_URL` and `CORE_API_TOKEN` are empty in local config. There is no
versioned spec, no confirmed chain-ID mapping, no confirmed field units, and no
confirmed error-code table. Wiring a guessed `POST /api/v1/check` would produce
integration "success" against invented behaviour. DexScreener
`/token-pairs/v1/{chain}/{address}` was chosen because it is real, requires no
credential, and is scoped to the exact contract address.

When Core is confirmed, replace `fetchTokenPairs` and keep `normalizePairs`. The
normalized shape is already [the scanner-to-card contract](scan-result-contract.md),
so nothing downstream changes.

## Field-by-field: real or null

| Card field | Live source | Reality |
| --- | --- | --- |
| token name, symbol | provider `baseToken` | **real** |
| price, market cap, FDV, liquidity, volume 24h | deepest pool | **real** |
| price change 1h / 24h | provider `priceChange` | **real** |
| pair age | `pairCreatedAt` | **real**, derived |
| website / X / Telegram | `info.websites`, `info.socials` | **real when listed**, else "Not Available" |
| holders (total, top10, largest) | — | **null.** See below. |
| narrative | — | **null.** Provider publishes no description field. |
| updatedAt | — | **null.** No observation timestamp; freshness is never synthesized. |
| Full Analysis button | `TOKEN_PAGE_BASE_URL` | omitted, with an availability note, until the website route is confirmed |

### Why holders are null

Verified during implementation, not assumed:

- `getTokenLargestAccounts` on `api.mainnet-beta.solana.com` returns
  `429 Too many requests for a specific RPC call` **for every token**, including
  a freshly created one. It is blocked on the public endpoint, not throttled by
  volume.
- `getProgramAccounts` with a mint filter works but returns **600 MB** for a large
  mint (measured: BONK, 40.8 s, 600,636,093 bytes). Not viable per scan.
- Public alternatives refused: `solana.drpc.org` (paid plan only),
  `rpc.ankr.com` (403), `rpc.solanatracker.io` (key required),
  `publicnode.com` ("Request blocked"). `solana.leap`/omniatech returned 5xx.

So `holders` is `null` and the card prints "Holder data unavailable". Reporting
`0` would assert "measured, no holders", which is false. A paid RPC
(Helius/QuickNode) or the Core API is required to populate this section.

### Why market cap is not averaged across pairs

A token's pairs **disagree** on market cap, because each pair has its own last
price. Measured on BONK: 30 pairs, **30 distinct (marketCap, fdv) values**.
The adapter takes the **deepest pool by liquidity** as the primary read, which is
the most reliable single estimate. It does not average or sum, because a shallow
pool's stale price should not drag the headline figure.

Liquidity is used to *rank* pools only. Identity is fixed first, by
`baseToken.address` — a same-ticker contract can never be selected.

## Failure states

Typed, and never collapsed into "not found":

| Provider result | Scan status | Card |
| --- | --- | --- |
| `200` + pairs | `ok` | full card |
| `200` + `[]` | `not-found` | Token Not Found |
| `200` + pairs, none matching this contract | `invalid-response` | Scan Error |
| `429` | `rate-limited` | Rate Limited |
| `5xx` / transport / timeout (8 s) | `api-error` | Unable to fetch data |
| non-JSON body | `invalid-response` | Scan Error |

A live failure never falls back to mock data. There is a test for that.

## Caching

`(chain, address)` key, in-process:

- success: 30 s — these are live prices, so the window is short
- failure (`rate-limited` / `api-error`): 10 s — sheds a throttle without
  keeping a transient blip alive

Failure TTL is deliberately shorter than success TTL. A 60 s duplicate-suppression
window in `cooldown.mjs` still applies on top, per chat.

## Verified live runs

Both chains, real tokens, through `scan()` with `SCAN_MODE=live`:

- **Solana BONK** `DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263` → `ok`,
  30 matching pairs, deepest pool `5zpyutJu9ee6jFymDGoK7F6S5Kczqtc9FomP3ueKuyA9`,
  market cap $199.8M, liquidity $225.3K, pair age 3y 11mo, all three project links.
- **BSC CAKE** `0x0E09FaBB73Bd3Ade0a17ECC321fD13a19e81cE82` → `ok`,
  30 matching pairs, market cap $534.9M, liquidity $4.82M, pair age 3y 7mo,
  no project links listed by the provider.
- **Unused BSC address** `0x1111…1111` → `not-found` (real negative, not an error).

## Known limitations

1. **EVM chain detection is BSC-only.** `detect-ca.mjs` maps every `0x…40hex` to
   `bsc`. Extensible-EVM support needs a chain hint (per-group default or an
   explicit `/check` argument), not a guess.
2. **Group auto-detect needs Group Privacy off or admin.** Verified via `getMe`:
   `can_read_all_group_messages: false` on the staging bot, so in groups the bot
   currently receives only commands and replies. See README §3.
3. **Provider is not the product backend.** No narrative, no holders, no risk
   signals, no dev/bundle history. Those need Core API or paid data.
4. **In-process cache only.** Multiple bot processes would each hold their own.
   Fine for a single staging poller; needs a shared store before scaling out.
