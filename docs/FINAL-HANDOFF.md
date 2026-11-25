# FINAL HANDOFF — Release Candidate

**Status: TECHNICAL PASS. AWAITING OWNER TELEGRAM ACCEPTANCE.**
Nothing has been pushed, deployed, or handed off. Round 5 is the accepted final development round.

| | |
| --- | --- |
| Branch | `mc/phase7-integrated` |
| Baseline for this pass | `387a775` |
| Tests | **903 / 903** |
| Runtime dependency | Telegraf only (`^4.16.3`) |
| Pollers started by this session | **0** |
| APIs purchased | **none — $0** |

---

## Exact Windows startup command

From `E:\meme-checker-telegram`:

```bat
cd /d E:\meme-checker-telegram
npm start
```

Expands to `set SCAN_MODE=live&& node --env-file=.env src/bot.mjs`, which starts the bot and its
observer; `Ctrl+C` stops both. It also forces `SCAN_MODE=live`, so a leftover `SCAN_MODE=mock` in
`.env` cannot silently leave you in mock mode.

Requires `.env` with `TELEGRAM_BOT_TOKEN`, `OWNER_USER_IDS`, `ALLOWED_CHAT_IDS`. **One instance per
token** — two pollers make Telegram reject `getUpdates` for both (`409 Conflict`).

---

## Verification on this commit

| Check | Result |
| --- | --- |
| Regression suite | **903 / 903 passing** |
| Risk consistency (35-token sample) | **35 / 35** |
| Working tree | clean |
| Credentials in tracked files | none found |
| `.env` ever committed | **0 commits in history** |
| `data/` ignored by Git | yes |
| Pollers started | **0** |
| Pushed / deployed | **no / no** |
| Call history modified | **no** |

---

## The one thing to know before testing

**The bot reports what it measured and says `unknown` otherwise.** It does not guarantee a token
is safe, and it does not claim full coverage. `docs/KNOWN-GAPS.md` states every gap with the
mechanism behind it.

Three fields are below the Round 5 targets, each for a structural reason rather than missing
effort:

| Field | Measured (raw / applicable) | Why it stops there |
| --- | --- | --- |
| LP lock | 40% / 40% | V3/V4 positions are not enumerable — `tokenOfOwnerByIndex` reverts and a pool does not list its positions |
| narrative | 57% / 57% | 15 of 35 tokens publish no description on any keyless source; DexScreener pairs carry no `description` by schema |
| top10 | 83% / 83% | Ethereum 40% — GoPlus omits `holders[]` for some established tokens |

---

## Corrections made in this final pass

Two claims did not survive verification and are corrected rather than carried forward.

**1. A free Etherscan key does NOT unlock HyperEVM holders.** Round 5 shipped an adapter whose
comment said a free key would work. Checked against Etherscan's own endpoint metadata:
`tokenholderlist`, `tokenholdercount`, `topholders` and `tokeninfo` are all tagged **PRO** (paid
Standard plan and above). HyperEVM additionally moves to Lite-or-above on **2026-12-01**. The
adapter now returns `not-configured` / `plan-required` carrying `freeKeyWorks: false`, and a test
pins it so the wrong claim cannot return.

**2. A HyperEVM address in the acceptance checklist was mistyped.** Corrected to
`0x9b498C3c8A0b8CD8BA1D9851d40D186F1872b44E` (PURR), and every address in the checklist was then
machine-verified against `benchmark/manifest.json` — 8/8 resolve to real entries.

---

## What ships in this tree

### Added in Round 5
- `src/security/pons.mjs` — Pons V1/V2 generation, graduation position discovery, lock assessment
- `src/security/positions.mjs` — V3/V4 position assessment, EIP-1967 upgradeability checks
- `src/security/elysium.mjs` — Elysium holder source (Elyscan server-rendered token page)
- `src/security/hyperevm.mjs` — HyperEVM holder adapter, correctly gated on a paid plan
- `src/security/simulation-tax.mjs` — read-only transfer-fee measurement from a real holder
- `src/security/keccak.mjs` — dependency-free Keccak-256 (validated against published topics)
- `benchmark/` — fixed 35-token sample, coverage harness (raw vs applicable), variance classifier

### Documents for this handoff
| File | Purpose |
| --- | --- |
| `docs/OWNER-ACCEPTANCE-RC.md` | **Your test checklist** — 7 chains, all commands, honesty tests |
| `docs/KNOWN-GAPS.md` | Every gap, measured, with the mechanism |
| `docs/CORE-INTEGRATION-CONTRACT.md` | The boundary spec for the Core team |
| `docs/ROUND5-REPORT.md` | Round 5 findings and per-milestone evidence |
| `README.md` | Install, env vars, emoji setup, commands, limitations |

---

## Prior phase checkpoints (preserved, not discarded)

| Phase | Status | Commit |
| --- | --- | --- |
| 1–3 | OWNER accepted (Phase 3 at MVP level) | `368843f`, `4c57544` |
| 4 + 4A | TECHNICAL PASS | `e4ce37c`, `c8c6d7e`, `4eb4b32`, `5d61141` |
| 5 — Risk intelligence | TECHNICAL PASS | `f28ef86` |
| 6 — Community/leaderboard/settings | TECHNICAL PASS | `713ef99` |
| 7 — Integration | TECHNICAL PASS | `9610ff6` |
| Round 4–5 (data intelligence) | OWNER accepted Round 5 as final dev round | through `387a775` |

Earlier checkpoints preserved: `mc/phase2-calls` @ `368843f`, `mc/phase3-alerts` @ `574162c`,
`demo/offline-mvp` @ `d61585d`. No worktree was reset or discarded.

---

## Providers and cost

| Provider | Key | Cost | Notes |
| --- | --- | --- | --- |
| DexScreener | none | free | market data, 7 priority chains + others |
| GeckoTerminal | none | free (6 s pacing) | market, narrative, some security |
| GoPlus | none | free | risk, 13 of 15 market chains |
| RugCheck | none | free | Solana security, LP and creator balance |
| CoinGecko | none | free (2.2 s, 6 h cache) | supplementary profile |
| Solana / EVM RPCs | none | free | on-chain reads |
| Elyscan token page | none | free | Elysium holders |
| GetXAPI / Sorsa | `GETXAPI_KEY` / `SORSA_API_KEY` | ~$0.001/request | **cached only on scans** |

**Zero paid X requests** from ordinary scans. X budget (`RESEARCH_X_BUDGET`) is persisted and
paced; `/x` is the only billable path.

---

## Owner testing instructions

1. **Start the bot** — `npm start` from the repo root.
2. **Open `docs/OWNER-ACCEPTANCE-RC.md`** and work through it. Section 6 (Honesty tests) is the
   most important part of this release.
3. **Paste the seven chain addresses** from §1 into your group and DM.
4. **Expect these and do not treat them as new bugs:**
   - HyperEVM holders `—` (no keyless source; a free key cannot unlock it)
   - Elysium tax and LP `—` (no provider; the RPC cannot enumerate holders to simulate from)
   - LP showing `V3/V4` rather than a percentage on Base/Ethereum (positions not enumerable)
   - `/x`, `/upgrade` and the token-page CTA absent until keys/URLs are configured
5. **Stop and report immediately** if any unmeasured value renders as `0` or as a green
   indicator. That is the single class of defect this release exists to prevent.
6. **Reply ACCEPT / ACCEPT WITH NOTES / REJECT.**

---

## Configuration still required from you

Values only you can supply — no code change needed:

| Variable | Unlocks | Notes |
| --- | --- | --- |
| `TOKEN_PAGE_BASE_URL` | Token-page CTA on cards | Website route |
| `PREMIUM_URL` | Premium teaser blocks | Pricing page |
| `TELEGRAM_TEST_GROUP_ID` | `/alerttest` | A group the bot can post to |
| `GETXAPI_KEY` / `SORSA_API_KEY` | `/x` discussion | **Paid per request** — needs your approval |
| `CALLER_LINK_SECRET` | Signed caller links | Any random string |
| `CORE_API_BASE_URL` / `CORE_API_TOKEN` | Core API substitution | Awaiting the Core contract |

**`ETHERSCAN_API_KEY` will not help.** Holder endpoints need a paid plan; do not buy one for this
release.

---

## On acceptance

Only then: push `mc/phase7-integrated` to GitHub and complete the final handoff. No further
development round will be started.

GitHub handoff will additionally require: push authorisation, confirmation that `data/` stays
ignored (it is), and CI running `npm test` with `TELEGRAM_BOT_TOKEN=test`, `BOT_NO_LAUNCH=1` and
an isolated `CALLS_DB_PATH` — the suite already works this way.

## Not done, by instruction

No functionality expansion, no broad provider research, no API purchases, no GitHub push, no
deployment, no poller launch, no call-history modification.
