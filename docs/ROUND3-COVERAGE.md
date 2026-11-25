# Round 3 — measured coverage matrix

All figures below come from live calls against real tokens on each chain. Nothing is
extrapolated. Reproduce with `node --env-file=.env _r3cov.mjs` (script kept out of the
repo; the JSON lands in the scratch dir).

## 1. Meaningful narrative

"Narrative" here means a **project description**, not contract facts. A token whose only
"story" is `24h Vol … MCAP … FDV` counts as a failure, and so does one that merely states
its ticker.

| Chain | Samples | With prose | Source |
| --- | --- | --- | --- |
| Solana | 3 | 3 | GeckoTerminal |
| Ethereum | 3 | 3 | GeckoTerminal |
| BNB Chain | 3 | 2 | GeckoTerminal |
| Base | 3 | 3 | GeckoTerminal |
| Arbitrum | 2 | 2 | GeckoTerminal |
| Optimism | 2 | 2 | GeckoTerminal |
| Polygon | 2 | 1 | GeckoTerminal |
| Avalanche | 2 | 2 | GeckoTerminal + official website |
| Unichain | 1 | 1 | GeckoTerminal |
| Berachain | 1 | 0 | — |
| HyperEVM | 1 | 0 | — |
| Monad | 1 | 0 | — |
| **Robinhood** | **1** | **1** | **launchpad metadata (`getTokenInfo`)** |
| Abstract | 1 | 1 | GeckoTerminal |
| MegaETH | 1 | 0 | — |

**Chains with prose: 11 / 15 (73%). Samples with prose: 21 / 27 (78%).**

Previously 9 / 15. The gain is Robinhood (was structurally unreachable) plus BNB and
Polygon now reaching the website fallback.

### Why the remaining four are empty, and whether that is our failure

- **Berachain, HyperEVM** — the sampled tokens were **Wrapped Bera** and **Wrapped HYPE**.
  GeckoTerminal has them, with an empty description, because a wrapped asset is not a
  project. Sampling a real memecoin there found `Bears` and `SPACEANT`, which also publish
  no description. This is a **content gap, not a pipeline gap**.
- **Monad, MegaETH** — GeckoTerminal returns no name and no description for the sampled
  addresses, and no launchpad getter is documented for either. There is no verified
  keyless prose source for these two.

**The 90% target is not met, and cannot be met from free sources for those four chains.**
Stating it as 90% would require either inventing descriptions or counting contract facts,
both of which the brief forbids.

### Sources evaluated and rejected

| Source | Result |
| --- | --- |
| **GMGN** `openapi.gmgn.ai/v1/token/info` | **401**, key required, no free tier. Its documented fields are `pool`/`dev`/`link`/`stat` — **no description field at all**, so it would not help even with a key. |
| **Pons docs** (`docs.ponsfamily.com`) | Protocol documentation, not per-token prose. Useful as the ABI reference for `getTokenInfo()`. |
| **Robinhood Blockscout** | `api/v2` returns a **Cloudflare "Just a moment"** challenge page. Unusable without a headless browser. |
| **Pons website** (ponsfamily.com) | The homepage describes the **launchpad**, not the token. Attributing it to a token would be wrong, so it is not used. |
| **four.meme** | `get?address=` returns `{"code":0}` with no data; `/trending`, `/new` 404. |
| **BscScan / Etherscan** | API key mandatory; `tokeninfo` has no description field. |
| **DexScreener `token-profiles/latest`** | Does carry descriptions, but is **feed-only** — no per-address lookup, so it cannot answer a scan. |

## 2. Security fields

`ok` = the provider answered for that token. Field columns count samples where the field
was actually measured.

| Chain | ok | Top 10 | Holders | Tax/Fee | LP lock | Creator |
| --- | --- | --- | --- | --- | --- | --- |
| Solana | 3/3 | 3 | 3 | 3 | 3 | 1 |
| Ethereum | 3/3 | 3 | 3 | 3 | 2 | 3 |
| BNB Chain | 3/3 | 3 | 3 | 2 | 0 | 3 |
| Base | 3/3 | 3 | 3 | 3 | 0 | 3 |
| Arbitrum | 2/2 | 2 | 2 | 2 | 0 | 2 |
| Optimism | 2/2 | 2 | 2 | 1 | 0 | 1 |
| Polygon | 2/2 | 2 | 2 | 2 | 0 | 2 |
| Avalanche | 2/2 | 2 | 2 | 0 | 0 | 2 |
| Unichain | 1/1 | 1 | 1 | 0 | 0 | 1 |
| Berachain | 1/1 | 1 | 1 | 0 | 0 | 0 |
| HyperEVM | 1/1 | 0 | 0 | 0 | 0 | 1 |
| Monad | 0/1 | 0 | 0 | 0 | 0 | 0 |
| Robinhood | 1/1 | 1 | 1 | 1 | 0 | 1 |
| Abstract | 1/1 | 1 | 1 | 0 | 0 | 1 |
| MegaETH | 0/1 | 0 | 0 | 0 | 0 | 0 |

**Chains with a security response: 13 / 15.** Field-level totals across 27 samples:
Top 10 **23/27**, holders **23/27**, tax/fee **17/27**, LP lock **5/27**, creator **21/27**.

**LP lock is the weak field: 5/27 (19%).** No keyless provider reports it for EVM — GoPlus
does so only for some tokens, and RugCheck is Solana-only. This is the largest honest gap
and the field most worth a paid provider.

## 3. Provider failures and unsupported fields

| Finding | Detail |
| --- | --- |
| Chains with no security provider at all | Monad, MegaETH — `unsupported`, rendered `n/a`, never green |
| Uniformly unmeasured field | LP lock on EVM (22 samples) |
| Tax not reported for the sampled token | Avalanche, Unichain, Berachain, Abstract (provider answered, field absent) |
| GeckoTerminal throttling | `429` on bursts; paced at 6 s with backoff |

## 4. Path to the 90% target (not purchased, needs approval)

| Gap | Provider | Endpoint | Cost | Credential |
| --- | --- | --- | --- | --- |
| LP lock on 10 EVM chains | GoPlus Token Security (paid tier) | `/api/v1/token_security/{chainId}` | Free tier is what we use; paid tiers are quoted per-seat | `GOPLUS_APP_KEY` |
| LP lock + richer EVM risk | Birdeye | `/defi/token_security` | Free 30K CU/mo; Lite $39/mo | `X-API-KEY` |
| Prose for Monad / MegaETH | No known keyless source | — | — | — |

## 5. What changed and why the numbers moved

| Fix | Effect |
| --- | --- |
| `/narrative` dropped the explicit chain hint | every address-based command asked for a chain it had been given |
| GeckoTerminal map omitted `robinhood` | the entire narrative pipeline short-circuited before asking any provider |
| 60-char floor + stat-panel test applied to declared descriptions | discarded real descriptions such as PONS's 28-char one |
| `getTokenInfo()` ABI decode read the length word a word early | "description" came back as the payload's own hex |
| Launchpad socials indexed from the wrong tuple base | socials silently empty |
