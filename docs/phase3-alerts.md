# Phase 3 — Smart alerts: coverage and behaviour

What actually works, per chain. Chain support for MARKET ALERTS follows the market
data adapter (15 of 16 registered chains). Dex Paid and migration are narrower and
are stated separately, because a chain having market data says nothing about
whether a launchpad migrates there or whether DexScreener indexes its orders.

## Alert type x feature

| Alert | Coverage | Basis |
| --- | --- | --- |
| Multiplier milestones | Every chain with market data | Driven by observed market cap from the DexScreener pair |
| Peak / drawdown | Every chain with market data | Uses the stored post-call peak |
| Price movement (pump/dump) | Every chain with market data | Needs two observations inside the window |
| Dex Paid | `solana`, `ethereum`, `bsc`, `base`, `arbitrum`, `polygon`, `optimism`, `avalanche` | DexScreener `orders/v1`, gated by `dexPaid: true` in `src/chains.mjs` |
| Migration | Solana only, and only with verified evidence | See below |

Chains where market data works but Dex Paid is `unknown` (not "not paid"):
`hyperevm`, `monad`, `unichain`, `berachain`, `abstract`, `megaeth`, `robinhood`,
`story`. `story` has no market data at all, so no alerts of any kind.

**Unknown is never rendered as "not paid".** An unindexed chain or a provider
failure produces `unknown`, which neither triggers an alert nor counts as evidence
against the project.

## Migration detection — deliberately narrow

A migration alert requires evidence that the launchpad bonding process COMPLETED.
The following are explicitly NOT sufficient on their own, and the code does not
treat them as such:

- a new liquidity pool appearing
- the deepest pool changing
- liquidity increasing
- an unfamiliar DEX name

Only Solana is wired today, because that is where a verifiable signal exists from
the sources already integrated (pump.fun bonding completion surfaces as a change in
the primary pair plus the launchpad's own graduation state). Other launchpads
return `unsupported` and are recorded in the call's notes as `migrationSuspected`
rather than announced.

Adding a launchpad means: a source that reports graduation truthfully, a
chain-specific verifier, and turning it on in `chains.mjs`. Until then the honest
answer is Unsupported.

## Multiplier milestones

Supported: 2, 2.5, 3, 5, 10, 20, 30, 50, 100, 250, 500, 1000.
Default enabled subset: 2, 5, 10, 20, 50, 100.

- Calculated from the ORIGINAL entry market cap stored on the call.
- Crossing several at once sends ONE message for the highest newly reached enabled
  milestone. The lower ones are recorded as `delivered` with `suppressedBy` set to
  the announced event, so they can never fire later.
- Dropping below a milestone and recovering does not re-alert: the event id is
  already delivered.
- An observation awaiting corroboration produces NO alert. `observeCall` holds a
  suspicious jump in `pendingPeak` and leaves `peakMarketCapUsd` untouched; the
  alert layer checks for that hold before announcing.

## Delivery guarantees — what is actually promised

Telegram offers no exactly-once primitive. The model is **at most once**:

1. `claimAlert(eventId)` is written synchronously before sending. Only one caller
   can ever win a given event id, across restarts and concurrent cycles.
2. On success the row becomes `delivered` with the Telegram message id.
3. A definite failure (400/403, chat not found, bot blocked) becomes `failed` and is
   retryable, because nothing reached the group.
4. An unknown outcome (socket error, timeout after the request was written) becomes
   `ambiguous` and is **never retried**, because a duplicate alert is visibly wrong
   while a missing one is invisible.
5. A crash between claim and send leaves the row `pending`. It is not retried
   automatically; no operator command exists to reclaim yet.

So: a possible missed alert is accepted over a possible duplicate. This is a
deliberate trade, not an oversight.

## Scheduler

Runs inside the bot process, starts with `npm start`, stops with Ctrl+C.

| Call age | Interval |
| --- | --- |
| 0–1 h | 20 s |
| 1–24 h | 60 s |
| 1–7 d | 4 min |
| 7–30 d | 12 min |
| 30 d+ | 45 min |

Env overrides: `OBSERVER` (on/off), `OBSERVER_INTERVAL_MS`, `OBSERVER_MAX_TOKENS`,
`OBSERVER_CONCURRENCY`.

- One cycle at a time; a slow provider cannot cause overlap.
- One provider fetch per canonical (chain, contract) per cycle, distributed to every
  group tracking that token. Each group keeps its own entry market cap, so the same
  token can be 2x for one group and 20x for another.
- A provider failure writes nothing: no zero, no stale-as-fresh.
- 429 waits the server's `retry_after`; other errors use exponential backoff with
  jitter.
- Dex Paid is polled on its own slower cadence (default 15 min).

## Settings

`/alerts` — owner-only during staging. Toggles: multiplier, Dex Paid, migration,
price movement. Milestone picker for all 12 supported values.

Price movement thresholds (pump %, dump %, drawdown %) are stored per group and
default to +50%/-30% in 15 min and -50% from peak, but the whole price-movement
class is OFF by default.

## Known limitations

- Cross-process writers to `calls.json` are unsupported. One bot process per store.
- `pending` alert rows from a crash are not auto-reclaimed.
- Migration is Solana-only.
- Dex Paid coverage is the 8 chains DexScreener indexes for orders.
- Historical observations are capped at 12 per call, so movement alerts look at the
  recent tail only.
