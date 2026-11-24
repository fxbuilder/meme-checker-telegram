# Phase 3 preparation — scheduled market observation

**Status:** design only. Nothing in this document is implemented yet; the
foundations it builds on (`observePass`, the call store, adaptive tiers) exist and
are tested.

Phase 3 is not started. This is the specification the next milestone will follow.

---

## 1. What already exists (from Phase 2)

| Piece | Where | State |
| --- | --- | --- |
| `observePass()` | `src/call-observer.mjs` | Working, tested, emits milestone/peak events |
| Adaptive tiers | `calls.pollIntervalFor` / `pollTierFor` | hot ≤7d, warm ≤30d, cold beyond |
| Per-run cost caps | `observePass({ maxCalls, perCallCooldownMs })` | Working |
| Extreme-value gate | `calls.nextPeak` | Holds >50x until confirmed |
| Durable store | `src/store.mjs` | Atomic writes, schema versioning |
| Event stream | `observePass().events` | `{type, call, multiple, milestone}` |

Phase 3 adds the **scheduler** and the **delivery policy**. It does not need to
change the observation or storage layers.

## 2. The scheduler

A single supervised loop, one instance per bot process, started after `launch()`.

```
tick every SCHEDULER_TICK_MS (default 60s):
  open = store.openCalls()                    # all active, incl. old
  due  = open.filter(call => now - lastObservedAt >= interval(call))
  due  = sortByPriority(due).slice(0, MAX_PER_TICK)
  pass = await observePass({ store, scan, calls: due })
  for event of pass.events: dispatch(event)
```

**Priority ordering** (highest first), so a tick with a small budget spends it
where it matters:

1. calls whose current multiple is within 20% of the next milestone (about to alert)
2. calls in the `hot` tier (age ≤ 7 days)
3. calls with a pending extreme candidate awaiting confirmation
4. `warm` tier
5. `cold` tier

**Interval by tier** (already implemented as `pollIntervalFor`):

| Tier | Age | Interval |
| --- | --- | --- |
| hot | ≤ 7 days | 5 min |
| warm | ≤ 30 days | 30 min |
| cold | older | 24 h |

**Why this is safe for cost:** a group with 200 live calls does not issue 200
requests per tick. `MAX_PER_TICK` (default 8) bounds provider spend, and the
priority sort guarantees the calls most likely to produce an alert are served
first. Older calls still get observed — just at 24h cadence, and they are never
retired.

**Single-instance guard.** Two pollers would double-spend and double-alert. The
loop takes an in-process lock and logs a refusal if started twice. A future
multi-instance deployment needs a shared lease (Redis `SET NX EX`), which the
store interface already leaves room for.

## 3. Alert definitions

Every alert is derived from an `observePass` event plus a dedup key. Dedup keys
are persisted so a restart cannot re-fire the same alert.

| Alert | Trigger | Dedup key | Notes |
| --- | --- | --- | --- |
| **Milestone** | `crossedMilestone()` returns a value not seen before for this call | `m:{callId}:{milestone}` | Fires once per milestone per call. Thresholds `[2,3,5,10,25,50,100]` |
| **New peak** | `event.type === 'peak'` | `p:{callId}:{peakAt}` | Suppressed if a milestone alert fired in the same tick |
| **Dex Paid** | `dexPaid.status` transitions to `paid` | `d:{chain}:{address}` | Reuses `src/dex-paid.mjs`; only on chains proven indexed |
| **Migration** | `detectMigration().migrated` becomes true | `mig:{callId}` | Includes pair change and liquidity collapse |
| **Price move** | `|change|` exceeds a threshold within a window | `pm:{callId}:{bucket}` | Needs a short price history; see §5 |

**Confirmation rule for extreme alerts.** A milestone at or above 50x is held
until the extreme gate in `nextPeak` confirms it (two agreeing observations, or
one corroborated by a second source). An unconfirmed 200x must never reach a
group as a headline — that is the single most damaging alert the product could
send.

## 4. Dedup and restart safety

```
alertsFireKey = `${chatId}:${dedupKey}`
store.rememberAlert(key)     # new: append to a bounded alerts log
store.hasAlertFired(key)
```

The alerts log is capped (last N per chat) so the store cannot grow without
bound, while still preventing a re-fire after a restart. Tested requirement: a
restart mid-tick must not duplicate the last alert.

## 5. Gaps Phase 3 must fill

1. **Short price history for "price movement".** The store keeps only entry /
   current / peak. A movement alert needs at least two points inside a window, so
   Phase 3 will append a bounded series (`priceHistory: [{t, mcap}]`, capped ~50
   points) per call.
2. **`getChatMember` for admin gating.** Phase 2 gates settings to the OWNER;
   Phase 6 will allow group admins. The API call belongs with Phase 6, not here.
3. **Alert delivery must reuse `deliverCard`.** A threshold crossing is worth a
   photo card when an image exists; the delivery layer already handles photo vs
   text and the never-send-twice rule.
4. **Quiet hours / per-chat mute.** Not scheduled, but the settings record has
   room; noting it so the schema is not designed into a corner.

## 6. Non-goals for Phase 3

- Leaderboard (Phase 6)
- X/KOL intelligence (Phase 4)
- Advanced risk (Phase 5)
- Website Premium (out of scope entirely)
- Replacing `observePass` or the store — both are extended, never rewritten

## 7. Acceptance sketch for Phase 3

- A scheduled tick observes due calls and writes nothing when the provider fails.
- A 2x crossing produces exactly one alert, and a restart immediately after does
  not produce a second.
- An unconfirmed 100x produces **no** headline alert.
- Cost: N live calls produce at most `MAX_PER_TICK` provider requests per tick,
  asserted from a counter rather than estimated.
