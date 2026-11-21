# Independent acceptance — offline only
Targets: Telegram `dcd1c12`; integration `1540c50`. Run from `.worktrees/qa`: `node --test qa/acceptance.mjs qa/handlers.mjs`. Node 24; no install, credential or network required. Source roots default to the two sibling worktrees; for a merged build set QA_TELEGRAM and QA_INTEGRATION to that build. Handler harness invokes registered callbacks with fake Telegram transport; it does not test Telegram delivery or Telegraf routing.

## Mock evidence (brief §§8, 10–11)
Observed: 13 checks, 8 pass, 5 fail. Each named assertion is independently reproducible with the command above.

|Input / step|Expected|Observed|
|---|---|---|
|Two users in one group send case-distinct Solana candidates|Both proceed independently|Second is blocked as duplicate|
|Render mock miss and invalid-response with mockLabel enabled|Both visibly marked mock|Neither card marked (two failures)|
|Remove fullAnalysisUrl but configure website origin|No guessed analysis button|Renderer builds /check/solana/...|
|Invoke /help callback with is_bot=true|No reply|Help text returned; no actual Telegram loop observed|
|Detect each fixture, scan, inspect first button|Normalized chain/address retained|Pass on both chains; exact mock URL paths only|
|BNB zero volume, missing cap, known FDV; unverified narrative|Show zero and FDV, no invented cap or story|Pass|
|Wrong chain / case-altered Solana identity, and unknown fixture vs malformed payload|Reject mismatch; distinguish miss and error|Pass|
|Repeat same CA across group users; same user changes CA; change chat|Suppress duplicate, throttle user, permit independent chat|Pass|
|Human text and /check, bot-authored text and /check|Marked result for human, no reply for bot|Pass in callback harness|

## Release checks not signed off
- Core staging: use checklist and matched known-good CAs; compare fields, units, holder data and provenance; distinguish no pair, miss, rate limit and outage. Never substitute a mock result. Record redacted inputs, status and timing.
- Telegram test group and DM: /start, /help, /check, plain group post, invalid input, retries, duplicate/cooldown expiry, group-wide burst and no daily quota. Capture message counts and edit behavior. Check English text, keyboard and wrapping on an actual phone.
- Website: tap the actual button for each chain signed out; record final URL and compare displayed chain and full CA, confirm Free data and VIP entry without purchasing. A matching button string is not a clicked-page pass.
- No claims for live latency, reliability or detection-accuracy KPIs from these fixtures.
