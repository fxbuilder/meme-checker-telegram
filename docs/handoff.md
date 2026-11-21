# MVP kickoff — 23 November 2026, Vietnam time

The [product brief](Meme_Checker_Telegram_Bot_Brief_VI.md) and room notes define scope. Assignment coordination and demo handoff belong to @mc-lead.

| Owner | First parallel task | Acceptance / brief reference |
| --- | --- | --- |
| @mc-telegram | Use `.worktrees/telegram` (`mc/telegram`) to build group and DM handlers, `/start`, `/help`, `/check`, automatic candidate detection, and English cards against the offline interface. | Preserve case for Solana, ignore other bots, don't treat address syntax as token verification, guard duplicates and use user/group cooldowns; no daily quota. Wire primary CTA from normalized output. §§3, 4, 5.4, 6, 7.4–7.5, 8 |
| @mc-integration | Use `.worktrees/integration` (`mc/integration`) for the shared backend client, normalization and exact-token links. Starter normalizer and schema-derived fixtures are on the common baseline; don't wire a guessed live path. | Confirm request, auth, chain IDs, response/errors, units, source provenance, token routes and rate limits. Keep unknown values null, FDV distinct from market cap, and mock/live separate. §§4, 5.4, 7.2–7.3, 8 |
| @mc-qa | Use `.worktrees/qa` (`mc/qa`) to design and run independent acceptance tests, then verify the integrated build in the test group and DM. | Exercise both chains, wrong identity, missing data, not-found vs failures, duplicates/cooldown, bot loop prevention, English mobile rendering and the exact clicked token page. Record build, steps, expected/actual and evidence; report mock and live separately. §§8, 10–11 |

Worktrees are local checkouts; do not edit another owner's checkout. Branch/commit, files changed, test results and blockers belong in every handoff. Daily quotas are out; deep analysis and upgrades belong on the website. The brief's example URLs and payload are not an approved production contract.

## Inputs needed for live verification

- Staging Core API base URL and confirmed scan method/request/response (including examples for both chains, nullability, units, rate limits, error codes, auth scheme, and narrative provenance). Provision any credential privately in local configuration, not in the room.
- Confirm website staging token routes for Solana and BNB Chain, the Premium/VIP destination and whether token pages open anonymously with Free data. Provide one known-good demo contract per chain.
- Test bot and test group access, with permission to receive ordinary group messages. Provision the bot token privately.

## Local tooling

Node 24 is sufficient for the dependency-free fixture and test runner. Python is not needed; on the kickoff Windows shell `python` and `python3` resolved to different versions. Project scaffolding, document task extraction, provider integration and TDD were covered by installed skills; no downloads needed for this slice.
