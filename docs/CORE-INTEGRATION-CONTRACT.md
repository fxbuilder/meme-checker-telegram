# Integration contract — Meme Checker ↔ Core

The boundary between this bot and the Core team. Treat this as the interface spec: everything
outside it is an internal detail and may change.

**Status:** the bot runs entirely on keyless public providers today. The Core API is an
**optional** substitution at one function, and nothing downstream is aware of which backend
answered.

---

## 1. What the bot promises Core

- **One attribution point.** `src/live-scan.mjs` → `liveScan()` is the only place market data is
  fetched. Core replaces the transport beneath it, not the shape of its result.
- **No silent defaults.** The bot never substitutes BSC or Ethereum for an ambiguous address. It
  asks, or reports ambiguity.
- **Typed failures.** A provider outage and a nonexistent token are different statuses and are
  worded differently. Core must not receive "not found" for an outage.
- **Immutable identity.** Identity is `(chainId, contractAddress)`. Name and ticker are
  attributes, never keys.
- **No paid spend without entitlement.** Ordinary scans make zero paid X requests.

---

## 2. Scan request

```js
await liveScan({ chain, address }, { fetchImpl, enrich: true })
```

| Field | Type | Required | Notes |
| --- | --- | --- | --- |
| `chain` | string | yes | Registry key: `solana`, `bsc`, `ethereum`, `robinhood`, `hyperevm`, `base`, `elysium`, + non-priority chains |
| `address` | string | yes | Base58 (Solana) or `0x` + 40 hex. Validated, never guessed |

`enrich: false` returns the market block only (no risk/narrative). Used by cheap paths.

---

## 3. Scan result

```js
{
  mode: 'live',
  status: 'ok' | 'invalid-response' | 'chain-unsupported' | 'not-found'
        | 'invalid-response' | 'provider-error' | 'rate-limited',
  token: { chain, address, symbol, name, decimals },
  market: { priceUsd, liquidityUsd, fdv, marketCap, volume24h, priceChange24h, ... },
  source: { provider, pairs, pairAddress, labels, dexId },
  risk: { holders, tax, lpLock, dev, security, sources },
  riskStatus: 'ok' | 'no-data' | 'unsupported' | 'error',
  riskDetail: string | null,
  holders: { total, top10Percentage, largestHolderPercentage },
  dexPaid: { status: 'paid' | 'not-paid' | 'unknown' | 'error', detail, types, since },
  narrative: null,   // populated by researchToken(), not by liveScan
  project: { website, socials, ... }
}
```

### Status semantics — Core must preserve these

| Status | Means | Must NOT mean |
| --- | --- | --- |
| `not-found` | the provider has no record for this subject | an outage |
| `invalid-response` | provider answered about a **different** subject (identity mismatch) | not found |
| `provider-error` | the provider failed; **not evidence about the token** | not found |
| `rate-limited` | throttled; retry later | not found |
| `chain-unsupported` | no data source covers this chain | not found |

`riskStatus` is separate from `status`: a scan can succeed while the risk block is `no-data`.

---

## 4. Risk block contract

One canonical shape, produced by `src/risk-intel.mjs` and classified by
`src/risk-classify.mjs` — the **only** threshold table. Core must not re-band these values;
the card and `/risk` share this engine precisely so they cannot disagree.

```js
risk = {
  holders: { total: number|null, top10Percentage: number|null, largestHolderPercentage: number|null },
  tax: null
     | { kind: 'transfer-fee', pct: number|null }
     | { kind: 'not-applicable' }
     | { buy: number|null, sell: number|null },
  lpLock: null | {
    kind?: 'burned' | 'not-burned' | 'locked' | 'partially-locked' | 'unlocked' | 'bonding-curve',
    burnedPercentage?: number|null,
    lockedPercentage?: number|null,
    positionType?: 'v3-v4',
    positionTypeDetail?: string,
    positions?: { status, classification, lockerName, positionId, ... },
    scope?: 'v2:0x…' | 'position' | 'pool',
    sources?: { lpLock: string }
  },
  dev: null | { address, percentage, role: 'creator'|'owner'|'developer', ... },
  security: { honeypot, mintable, freezable, canTakeBackOwnership, ... },
  sources: { holders?, tax?, lpLock?, ... }
}
```

### Invariants Core must honour

1. **`null` is not `0`.** An unmeasured field is `null`. Rendering `0` asserts a measurement that
   did not happen.
2. **`not-applicable` is a finding.** Legacy SPL has no buy/sell tax. That is an answer, not a gap.
3. **Burned ≠ locked.** A destroyed LP mint never returns; a lock expires. Summing them overclaims.
4. **A determined field must not render like an unchecked one.** A proven V3/V4 pool type gets its
   own label (`LP: V3/V4`), never a bare dash.
5. **Severity is banded on the ROUNDED value** that is displayed, so the verdict always describes
   what the user sees.
6. **Unknown never renders green.**

---

## 5. Where Core plugs in

| Concern | Current | Core substitution |
| --- | --- | --- |
| Market data | DexScreener + GeckoTerminal | `fetchMarket()` inside `live-scan.mjs` |
| Risk | GoPlus, RugCheck, GeckoTerminal, on-chain | `src/risk-intel.mjs` provider block |
| Narrative | GeckoTerminal → on-chain meta → website | `src/research/narrative-pipeline.mjs` candidates |
| Token page CTA | `TOKEN_PAGE_BASE_URL` | env only |
| Premium | `PREMIUM_URL` | env only |

Config already present and unused: `CORE_API_BASE_URL`, `CORE_API_TOKEN`. When the real contract
lands, the adapter replaces one fetch function; normalization, caching and rendering stay.

---

## 6. Caching and cost

- Keys are `(chain, address)`; failures are cached **shorter** than successes so a blip cannot
  become a sustained outage.
- A resolved chain mapping is long-lived; a negative result is minutes only, because "not indexed
  yet" is the normal cause of an empty answer.
- Concurrent identical scans are coalesced — N callers, one provider scan.
- Budget is spent only when a request will actually happen, never on a cache hit.
- Description TTL is 6 hours. A back-to-back benchmark run therefore measures cache warmth, not
  provider stability.

---

## 7. What Core must not assume

- **Coverage is not 100%.** See `docs/KNOWN-GAPS.md` for measured figures per field.
- **A green field is not a safety verdict.** The bot reports checks, not guarantees.
- **Multipliers are measured peaks**, not realised PnL. No fills are known.
- **Call history is append-only from the bot's side.** Core must never rewrite it.
- **LP lock is only determinable where an LP token or a position can be read.** A V4 pool with no
  graduation event is honestly unmeasurable, and will report the pool type instead.

---

## 8. Change discipline

- The status unions in §3 and the risk shape in §4 are the contract. Additions are backward
  compatible; renames and removals are breaking and need a version note here.
- Every threshold lives in `src/risk-classify.mjs`. A second copy anywhere is a defect: the card
  and `/risk` will drift and contradict each other.
- The regression suite (`npm test`, 903 tests) pins these invariants. A Core integration that
  breaks one fails the suite rather than shipping a contradiction.
