# MEME CHECKER — MASTER DEVELOPMENT PLAN V2

**Owner authorization:** 24 November 2026  
**Execution mode:** autonomous sequential implementation, followed by one integrated OWNER acceptance cycle  
**Workspace:** `E:\meme-checker-telegram`  
**Reference repository:** https://github.com/fxbuilder/meme-checker-telegram  
**Product benchmark (behavior, not visual copying):** https://docs.phanes.bot/  
**Scope:** Telegram bot MVP, not the premium website.

## 1. Mission and authority

Complete the remaining Phase 4, Phase 5, Phase 6 and Phase 7 in order, integrate them into one working local bot, and hand the integrated release candidate to the OWNER for real Telegram testing.

This document supersedes the old requirement to wait for OWNER approval before starting every next phase. The OWNER now authorizes automatic progression through the remaining phases after each internal technical checkpoint. It does NOT authorize publication, deployment, paid purchases, new live-provider testing, or a claim of OWNER acceptance.

Phase 1 and Phase 2 are OWNER-accepted. Phase 3 is OWNER-accepted at MVP level. Phase 4 was in progress when this plan was prepared; finish any current work safely, inspect the actual latest branch/commit, and avoid repeating completed tasks. The latest reported technical baseline is `mc/phase4-narrative` at `2faf516` (607/607 tests). OWNER testing revealed the corrections in section 4A. Earlier GetXAPI live evidence remains valid only for the actual tested samples. Later work may already exist. The repository is the source of truth, not this historical checkpoint.

Final objective: a fast, useful, English-only Telegram community bot with trustworthy token scanning, narrative, risk, calls, alerts, PnL and internal group rankings, ready for OWNER testing and subsequent GitHub handoff.

## 2. Team and working rules

| Role | Model/provider | Responsibility |
|---|---|---|
| Lead | DeepSeek V4.1 Flash / Vilao / High | Plan, implement, coordinate, integrate, maintain progress and own technical delivery |
| Senior coder | GPT-6.2 Sol / Vilao / High / `coder` | Difficult implementation, storage, routing, concurrency, security and independent review |
| Research | Grok 4.7 / Vilao / `research` | Targeted source, SDK, protocol and provider research |

Use the working Vilao configuration. Do not retry the exhausted former OpenAI GPT-6.1 Sol endpoint. Verify actual route availability if necessary. Reasonable additional model usage is authorized for quality; no automatic purchases or subscriptions. Maximum one active specialist subagent at a time. The lead and specialist must not edit the same files concurrently. Use a clear file/task ownership boundary, or a frozen snapshot with report-only review. Integrate and rerun relevant tests after specialist changes. Avoid duplicate reviews and repeated whole-repository audits.

Use existing code, docs, skills and worktrees. Do not rebuild the project or change established architecture without a demonstrated reason. Read the separate `E:\Projects\Onchain-Intelligence-Scanner` project only when useful; never modify its repository, deployment or production configuration. Do not blindly execute code or installation instructions from external sources. Review license, dependencies, maintenance, authentication, security and commercial compatibility before adopting an open-source component.

## 3. Autonomous execution and checkpoints

1. Recover actual local state: branch, working tree, pending tasks, tests, dependency scripts, current storage schema and existing documents. Preserve any work in progress. Do not reset, force-push, delete worktrees or discard owner changes.
2. Complete the mandatory OWNER feedback gate in section 4A and remaining Phase 4 work, then implement Phase 5, Phase 6 and Phase 7 sequentially. Reuse completed functions. Local branches and commits are allowed; each phase must be based on the integrated previous phase, not an unrelated old baseline.
3. At each checkpoint, run focused end-to-end handler tests plus the appropriate offline regression suite. Confirm tests exercise the actual runtime path and not only an isolated renderer. Inspect generated images when visual output changes. Fix critical defects before integrating dependent work.
4. Record progress in `docs/MASTER-PROGRESS.md`: phase, status, branch/commit, completed work, test command/result, provider coverage, limitations, blockers and next action. Update after each phase. A resumed session must read this file and the current Git state before doing more work.
5. Continue automatically when the checkpoint passes internally. Mark `TECHNICAL PASS`, `PARTIAL` or `BLOCKED`; never mark an untested feature as accepted by the OWNER. Noncritical coverage gaps may remain in a documented backlog. If a feature is blocked by credentials, an unsupported provider or an external dependency, isolate it, provide a truthful fallback and continue independent tasks. Stop only the affected work if proceeding would be unsafe, destructive or materially misleading. Do not work around credential or spending limits.
6. Keep progress messages concise. Do not wait for intermediate approvals, repeatedly ask the OWNER to paste a CA, or manufacture simulated success. If a Hermes execution/context limit interrupts work, leave a clear resume checkpoint rather than restart the project. Do not claim that the agent will keep working when its runtime has actually stopped.

## 4. Non-negotiable product baseline

- Preserve the approved STANDARD Variant A card, actual project image with safe text fallback, custom emoji, copyable CA, market and security sections, basic narrative, project links, First Call attribution and Meme Checker branding. Keep Add to Group and add the Refresh button specified in section 4A. A premium CTA may be added only with a verified/configured destination; otherwise show concise text. Do not restore removed generic disclaimers or Chart button. Retain real risk warnings. Do not redesign the main card or shorten away useful fields.
- All bot-facing output is English. Respect Telegram photo-caption and message limits; preserve fields or use the approved text fallback. Escape untrusted HTML and URLs.
- Call Tracking: one canonical active real call per group + chain + contract. Preserve original caller, message identity, timestamp and entry market cap. Manual/Auto modes and Just Scanning remain supported. Respect sender_chat identity for anonymous admins/channels. Exclude synthetic, cancelled and superseded records consistently.
- Clickable First Caller opens a group-scoped private Caller Profile with working 1D/1W/2W/1M filters, default 1D on every new First Caller deep-link opening, and unique calls. Never leak another group's private records. No caller identity based solely on display names.
- `/pnl CA`: exactly one captionless photo for a recorded call in the current group; otherwise `No recorded call for this token in this group.` Missing arguments get usage help. Resolve recorded chain automatically; ask only for genuine ambiguity. No scanner fallback and no insertion from PnL.
- Current and observed peak ROI are distinct. Never substitute FDV for missing MC or historic ATH for post-call peak. Entry MC is immutable; legitimate extreme returns require corroboration, not arbitrary rejection. Missing and stale data must remain distinguishable from zero. Token return is not realized trading PnL.
- Smart Alerts: preserve shared adaptive observer, multiplier, Dex Paid, verified migration, movement alerts, `/alerts` settings and isolated OWNER `/alerttest`. Respect budgets, durable deduplication and correct reply context. Do not emit fabricated live alerts or re-send ambiguous deliveries blindly.

## 4A. Mandatory OWNER feedback — finish before Phase 5

This section is the latest OWNER instruction from real Telegram testing on 24 November 2026. It takes precedence over conflicting UI details elsewhere in this plan. Complete these corrections, run focused full-handler regressions, make a local checkpoint, and then continue autonomously through Phase 5–7. Do not require an intermediate OWNER acceptance. If a narrative source is genuinely unavailable, document that gap and continue; do not fabricate data or spend on paid X to fill it.

### A. Improve remaining narrative coverage

- Latest reported live sample: prose on Solana, Ethereum, Base, Arbitrum, Optimism, HyperEVM, Berachain, Abstract and MegaETH; facts-only on BNB Chain, Polygon, Avalanche, Monad, Unichain and Story; no narrative source on Robinhood Chain. These are individual probe outcomes, not proof of comprehensive chain coverage. Story is outside the original 15-chain market baseline unless its market support has separately been demonstrated.
- Prioritize Robinhood and the facts-only in-scope chains (BNB, Polygon, Avalanche, Monad, Unichain). Investigate token/launchpad metadata, official sites, GeckoTerminal and safe free/keyless sources or compatible open-source adapters. Reuse current code. Distinguish provider throttling from genuine absence of information. Validate exact chain and contract. Do not undertake another exhaustive sweep merely to restate previous results.
- Meaningful prose about a token's story, origin, theme, purpose or utility is the goal; contract facts are a separate fallback, not a successful narrative. Some tokens publish no usable narrative. Keep unavailable states truthful. Report improvements and residual gaps without implying every token is covered. No paid GetXAPI calls or paid runtime LLM requests.

### B. Reply to the original CA message (including chain selection)

- Normal token scan cards, EVM chain-selection prompts and the final card after selection must reply to the original user's CA/command message in the correct group/topic (not the callback button message and not a standalone message). Preserve original chat ID, message ID, topic/thread where applicable, original sender identity, original timestamp, and action intent in callback state. Never assign a call to the person who merely selects a chain.
- Resolve an EVM chain automatically when reliable evidence uniquely identifies the chain; reuse verified canonical identity/cached results for repeat scans (e.g. the same ANT address) when appropriate. Do not ask again unnecessarily, default silently to BSC, or guess when multiple actual candidates remain. A previously recorded call is useful context, not proof that an address cannot exist on another chain. If ambiguity genuinely remains, offer relevant chain selection and preserve the original action.
- Prefer editing/replacing the picker in a manner compatible with Telegram message types and original reply context, without duplicate result cards. If the original message was deleted or cannot be replied to, send one safe fallback in the same authorized chat/topic. Handle expired callbacks gracefully. Preserve separate /pnl and /call routing.

### C. Clean Narrative and Premium X/KOL UI

- Remove the verbose source line from the standard scan card: `Source: Project's own description — unverified claim · Project description (GeckoTerminal)` and equivalent long source footers. Keep full source/evidence attribution in `/narrative CA`. Preserve epistemic accuracy in the card itself with natural language such as `The project describes itself as...` for self-reported claims; do not turn a claim into an independently verified fact by removing the footer.
- Keep the main narrative concise and meaningful, ideally 25–45 English words where evidence permits; no arbitrary mid-sentence cutoffs, filler or invented details. Preserve the existing Variant A layout and real risk warnings.
- Replace the main card's technical `No X research cached for this token yet...` text with a clean locked Premium teaser. Example (English):

  ```text
  🔒 X & KOL INTELLIGENCE
  KOL Activity: •••••• (Locked)
  Unlock full X & KOL insights on Meme Checker Premium.
  ```

  The dots are a visual lock placeholder, not actual hidden results or a claim that KOL calls exist. Do not fabricate KOL names, counts or returns. A verified/configured website link may accompany the invitation; omit a clickable destination if unknown. Preserve existing cache-only `/x` and `/kol` policy and OWNER research restrictions. Ordinary scans, refresh and normal commands must spend zero paid X requests. Do not implement the premium website or payment flow.

### D. Add a working Refresh button to token scan cards

- Add `🔄 Refresh` at the bottom alongside or below the existing `Add to Group` button on scan cards (including photo and text fallback). Do not add it to the approved image-only `/pnl` response.
- On click, resolve the same canonical chain + contract and fetch updated market data through existing bounded/shared provider infrastructure. Refresh relevant available price, MC, liquidity, volume, change and security fields with honest freshness/unknown states. Reuse valid narrative/cache evidence; do not spend paid X or trigger unbounded expensive research.
- Edit the existing scan card in place (caption for photo, text for text card), preserving project image, original reply context, buttons, First Caller and original entry MC. Handle message-not-modified, expired/deleted messages, caption overflow and provider errors safely. If an edit is impossible, use at most one clear replacement or concise callback response; avoid duplicate cards and spam.
- Refresh is a read-only scan action: never insert another call, modify caller attribution, reset entry MC or fabricate performance. Existing validated market observation rules may update current/peak performance only through the correct pipeline. Apply cooldown, in-flight deduplication, bounded concurrency, callback validation and correct chat scope. A failed refresh keeps the last valid values, not zeros; clearly indicate unavailable/stale data where relevant.

### E. Default Caller Profile period to 1D

- Clicking the clickable First Caller name opens the group-scoped DM Caller Profile with **1D** selected by default, every new deep-link opening, including after restart. Do not use 1W as default or inherit a previous selected filter on a new opening.
- Retain 1D / 1W / 2W / 1M buttons and pagination. Explicit filter clicks edit the existing message and use the same originating group and caller. Keep existing authorization, deep-link compatibility, unique calls and real recorded performance.

### F. Security metric sanity check — Top 10 > 100%

- The OWNER's FIONA screenshot showed `Top 10: 111.1%`. Trace the actual provider normalization, denominator, percentage units, duplicate accounts and possible overlapping balances. Fix the underlying cause when evidence permits. A concentration percentage above 100% is invalid for a consistent non-overlapping supply denominator; do not blindly clamp it to 100% or show it as a genuine risk reading. If inconsistent data cannot be reconciled, display Unknown/Unavailable and retain diagnostic evidence. Preserve accurate results for other tokens and distinguish provider-reported vs independently verified concentration. Carry the broader holder analysis into Phase 5.

**Pre-Phase-5 checkpoint:** exercise actual command/callback routing with mocked Telegram updates: same original reply IDs for CA scan + picker + result, repeat verified EVM scan, explicit ambiguous selection, correct original caller, in-place photo/text refresh and failure/cooldown/zero-paid-X behavior, clean Narrative/Premium rendering, fresh deep-link defaults to 1D and all filters work, and invalid Top 10 never renders as valid. Preserve real records and existing Phase 1–3 functions. Record results and commit locally; no live bot launch, no automatic Telegram messages, no GitHub push. Then continue Phase 5–7 automatically.

## 5. Phase 4 — Basic Narrative and Premium X/KOL Preview

Finish the current premium-preview and narrative upgrade work, including any already-applied changes. Basic Narrative is a core free feature. Advanced X/KOL and deep narrative are primarily premium website features. No live paid X requests are authorized during this master-plan execution; use existing cached evidence and offline fixtures. A future OWNER-authorized research mode may be tested with a separately approved budget.

### Narrative pipeline

Provide an appropriate discovery path for all 15 currently supported market-data chains: Solana, Ethereum, BNB Chain, Base, Arbitrum, Optimism, Polygon, Avalanche, HyperEVM, Monad, Robinhood Chain, Unichain, Berachain, Abstract and MegaETH. Story was previously unsupported for market data; do not silently claim support or expand scope solely to add it.

Use bounded fallback across cache, token metadata, launchpad metadata, existing market-provider links/descriptions, project websites, registries, CoinGecko and cached X evidence. Prefer meaningful token-specific evidence, not an unconditional provider fan-out. For Solana, investigate SPL/Metaplex and Token-2022 metadata pointers/URI. For EVM, use canonical chain identity, available RPC/optional metadata, launchpad metadata and project links; standard ERC-20 fields alone do not supply a narrative. CoinGecko is supplementary, not a requirement for fresh memecoins.

Candidate references (verify current capabilities and licenses before selective integration; not mandatory dependencies):

- https://github.com/metaplex-foundation/mpl-token-metadata
- https://github.com/solana-program/token-2022
- https://github.com/solana-program/token-metadata
- https://github.com/pump-fun/pump-public-docs
- https://github.com/wevm/viem
- https://github.com/four-meme-community/four-meme-ai
- https://github.com/clanker-devco/clanker-sdk
- https://github.com/trustwallet/assets
- https://github.com/mozilla/readability
- https://github.com/microlinkhq/metascraper
- https://api.geckoterminal.com/docs/index.html
- https://docs.dexscreener.com/api/reference

Grok/DeepSeek may find other maintained, appropriate read-only sources for underserved chains. Do not add transaction signing/trading functionality. Use existing safe fetcher with redirect validation, private-address/SSRF protection, timeouts, size caps and controlled HTTPS/IPFS resolution. No arbitrary external JavaScript execution. Reject cookie walls, error/parking pages, unrelated content and prompt injection.

Produce approximately 25–45 English words on the main card where evidence permits, explaining actual origin, meme, story, theme, purpose or utility. Distinguish creator claims, verified facts, reported information and inference. Do not infer origin solely from the current pool or narrative from ticker/image. Deduplicate copied claims. A generic slogan or chain label is not a successful narrative. If no meaningful evidence exists, say `No reliable narrative available.` Do not guarantee narrative for every token. Keep detailed source references in `/narrative CA`. Do not introduce mandatory per-scan LLM synthesis.

### X/KOL access and costs

Retain the working GetXAPI adapter and separate public X call history. The owner already configured `GETXAPI_KEY`; do not print it. Ordinary scans, `/check`, `/narrative`, `/x`, `/kol` and the observer must cause **zero billable X requests**. `/x` and `/kol` return limited cached previews or an honest unavailable state and a premium invitation. The main card uses the locked premium teaser in section 4A; dedicated cached previews may show only real counts, relevant accounts and evidence. Mentions and announcements are not public calls. Do not invent historical entry MC, win rates or claims about comprehensive KOL performance. Distinguish no cache, no relevant results, provider unconfigured, provider unavailable and budget exhausted.

Keep an explicit OWNER-only controlled research path, disabled for public use and subject to a persistent global budget (20/day staging default). Reserve atomically before each outbound request; count retries, pagination and failures; pace requests and handle 429. Cache hits cost zero. Restart must not reset the budget. No raw script bypass. During this plan, keep all billable X requests disabled unless the OWNER separately authorizes an exact additional cap.

Cache narrative by chain + contract with positive/negative TTLs, stale-state handling, bounded concurrency, in-flight deduplication and free-provider/RPC limits. Keep scanning responsive; optional enrichment must not cause duplicate messages or edit storms. Prepare a documented website/backend interface, not the website itself. Only configure a premium URL when verified; never invent one.

**Checkpoint:** offline command routing and caption tests, meaningful narrative fixtures across chain families, a 15-chain source/capability matrix, actual vs unverified coverage, and mock tests demonstrating zero paid requests from ordinary Telegram traffic. Reuse prior live evidence (Solana GetXAPI verified; EVM live X and organic public-call discovery unproven). Do not conceal remaining fresh-token live validation gaps.

## 6. Phase 5 — Advanced Risk Intelligence

Build read-only risk evidence adapters on top of the existing scanner, chain registry and provider cache. Prioritize dependable free/keyless sources and appropriate open-source code. Research current provider semantics and chain support before use. Reuse existing GoPlus/market/RPC data where appropriate. Keep risk fetching bounded; ordinary scans must not become expensive or depend on full wallet graph analysis.

| Capability | Telegram MVP | Evidence requirements |
|---|---|---|
| Mint/freeze and contract controls | Basic flags when supported | Actual authority or verified contract/provider field; unsupported != safe |
| Buy/sell taxes and honeypot indicators | Basic when reliably available | Distinguish measured/simulated/provider-reported values; do not infer no tax from missing fields |
| LP security | Basic | Distinguish burnt, locked, unlocked, unknown; use correct pool and lock evidence |
| Holder concentration / Top 10 | Basic | Define denominator, exclusions and whether pool/burn/exchange/owner accounts are included |
| Dev holdings and history | Basic holdings + limited history preview | Verified creator/deployer identities, meaningful records, no assumption that deployer equals all insiders |
| Bundles / snipers | Basic signals or cached preview | Relevant transaction/slot/order evidence and limitations; same-block purchases alone do not prove coordination |
| Insider / fresh wallets | Limited evidence-based preview | Explicit heuristics, observation window, coverage and uncertainty |
| Wallet clusters / advanced graphs | Backend-ready evidence/preview only | Funding/transfer/transaction links; avoid claiming common ownership without proof |

Add a concise `/risk CA` and, if justified by usable data, `/dev CA` or `/bundle CA` without expanding the main card unnecessarily. Retain existing scanner behavior. Premium detailed graphing, deep dev history, bubble maps and expensive investigations are website-team responsibilities; do not implement a separate premium product inside Telegram.

Prioritize Solana and EVM families with actual data support. Do not claim full functionality on every chain. Build the feature-by-chain matrix with supported, partial, unsupported, unknown and provider-error states. Treat labels such as sniper, bundle and insider as heuristic unless directly supported. No fabricated risk percentages, no generic all-clear, no ungrounded scam verdicts. Distinguish provider data from independent verification. Do not add wallet custody, transaction execution or auto-trading.

**Checkpoint:** exact-contract/pool identity, missing/unsupported data, holder exclusions, adversarial labels, risk evidence normalization, provider failure, cache/budgets, command routing, Telegram formatting and Phase 1–4 regressions. Include verified limitations and at least representative fixtures for Solana and EVM risk paths. No new paid API purchase or unapproved live request.

## 7. Phase 6 — Community, Leaderboard and Group Settings

Use the existing canonical CallStore and observation pipeline; do not create a competing source of truth. Build internal group leaderboard only, not global competition. Ranking is based on recorded token performance, not realized personal trading profit.

- `/lb` (and `/leaderboard` alias if useful): group caller rankings, unique tracked calls, best observed return, hit rate with explicit >=2x peak threshold, average/median or other transparent ranking basis, sample size, 24h/7d/30d/all-time filters and pagination. Define ordering and tie-breaks deterministically; distinguish unobserved from measured returns. Keep losers in the eligible sample; never selectively show winners as the full history.
- `/gpnl`: group performance summary or image using valid recorded calls; no fabricated aggregate cash PnL. Preserve `/pnl`, `/calls`, `/fc`, `/call`, `/justscan` and clickable Caller Profile. Ensure repeat scans, cancellations, superseded and synthetic records never inflate rankings. Scope every query and callback to the correct group.
- `/settings`: practical group controls for scan/call mode, alert toggles and milestones, available chain defaults and other existing options. Reuse `/callsettings` and `/alerts` where appropriate. OWNER-only staging remains enforced. For future group admins, use verified authorization and fail closed on ambiguity; Telegram membership/admin queries may be limited when the bot lacks admin privileges. Do not require admin rights for basic scanning. Do not let arbitrary members change group settings. Do not implement public onboarding or enable external access now.
- Custom PnL background (`/pnlbg` if feasible): optional admin-controlled image upload/reset, safe size/dimensions/type validation, isolated group storage, readable text and existing default fallback. Do not fetch arbitrary remote backgrounds or execute uploaded content. If this noncritical feature is blocked, document it and keep the existing image working.
- Update `/help` and command menus to match actual implemented functionality. Keep output concise, mobile-friendly and English. Avoid introducing unneeded commands solely for feature count.

**Checkpoint:** multiple users/groups, duplicate call protection, ties, time filters, pagination, callback access, empty states, missing observations, persistence/restart, settings authorization, anonymous sender handling, group data isolation, optional background validation and Phase 1–5 regressions.

## 8. Phase 7 — Integrated release candidate, stability and documentation

Integrate all completed phases into a single local branch/commit and a single startup path. Ensure that `npm start` starts the live bot and its observer; Ctrl+C shuts down cleanly. The OWNER controls the actual live process. Do not create or stop pollers, send Telegram test messages, consume `getUpdates`, or interfere with an existing OWNER process. Do not launch even for acceptance without separate authorization. Automated tests must use isolated storage, mocked Telegram/provider clients and no accidental network access.

Run an integrated offline acceptance suite covering:

- Startup configuration and storage migrations with backups; real owner records remain intact.
- CA scanning and chain selection, correct original message reply and sender/command intent, in-place Refresh, narrative and locked Premium teaser, valid security metrics, image/text fallback and malicious metadata escaping.
- Manual/Auto Call, Just Scanning, duplicate and cross-instance protection, First Caller links, default 1D and explicit filters, persistence and image-only PnL.
- Observer request caps, shared market data across groups, no overlapping cycles, cancellation, 429/backoff, pending/ambiguous alert handling, retry and deduplication.
- Zero paid X requests from ordinary scans/commands/observer, cached preview and OWNER authorization, persistent budget across restarts.
- Risk evidence and unknown states, leaderboard eligibility and group isolation, settings permissions and callback routing.
- Load simulation for realistic multi-group traffic and 100/500/1,000 tracked tokens without real provider requests. Measure representative latency, request counts, resource use and scheduler fairness; report actual measurements, not invented targets.

Review Phase 3 backlog: crash-pending alerts, operator visibility, scheduler fairness and known provider limits. Preserve at-most-once handling for ambiguous Telegram delivery; do not claim guaranteed exactly-once. Migration expansion beyond Solana is optional if verified free evidence is available; otherwise document the gap. No cross-process writers unless demonstrably required and safely implemented. Keep architecture proportionate to MVP.

Review secrets, `.gitignore`, dependency/license status, safe HTTP, logs, permissions, test isolation, rate limits and failure handling. Do not expose keys, private group data or live call storage in Git, README, logs or test fixtures. Avoid costly sweeping rewrites. Use GPT-6.2 Sol for one focused independent final review after integration; fix real defects and rerun affected tests. Record what was actually reviewed.

Prepare README and user/developer documentation: setup on Windows, sanitized `.env.example` variable names, live/mock modes, exact startup command, custom emoji setup and fallback, commands, group permissions, data providers and capability matrix, cache/budgets, premium preview boundary, known limitations, troubleshooting, backup and restart instructions. Document what GitHub handoff will require, but DO NOT push or deploy.

## 9. Final OWNER handoff (the only manual acceptance gate)

Deliver one integrated release candidate and one concise Telegram summary. In the repo create `docs/OWNER-ACCEPTANCE.md` with exact current startup steps, a practical checklist grouped by feature, example commands (one per line), expected output, whether testing uses real or isolated simulated data, and what to record when it fails. Include cold restart, old call/profile links, recorded/unrecorded PnL, all alert types via existing isolated `/alerttest`, basic narrative on fresh and established tokens, remaining chain coverage, CA/chain-picker reply behavior, in-place Refresh, clean locked premium teaser, 1D default profile, cached/uncached premium preview, valid Top 10 readings, risk, group leaderboard, settings and shutdown. Tests requiring a second human account or admin permission must be identified, not faked. No live GetXAPI acceptance requests without separately authorized cap.

Create `docs/FINAL-HANDOFF.md` containing:

- Integrated branch and exact commit; phase checkpoint commits and statuses.
- Implemented features, actual GPT-6.2 Sol review contribution, test commands/results, actual live vs offline evidence.
- Complete 15-chain feature matrix, known limitations, outstanding blockers and severity.
- Provider dependencies, free/paid paths, budget settings and operational measurements.
- Confirmation that valid owner data was preserved, no poller was started by Hermes, no secrets exposed, and nothing was pushed/deployed.
- Exact CMD startup block (verify against actual package.json; expected):

```cmd
cd /d E:\meme-checker-telegram
npm start
```

Use the existing authorized test group `sissooo1` and `@MemeCheckerStagingBot` only. The OWNER will run the bot and collect defects in a single pass. Provide this defect template in the acceptance doc:

```text
ID / Feature:
Command or action:
Chain and CA (if relevant):
Expected:
Actual:
Screenshot or sanitized CMD error:
Reproducible? Severity:
```

After handoff, stop feature development. Do not claim OWNER PASS or production readiness while manual testing is pending. Await a consolidated defect list and explicit release approval. Fix reported defects in a later bounded stabilization pass, not by reopening unrelated completed work.

## 10. Permanent restrictions

- No GitHub push, public deployment, VPS migration, public beta or external testers without separate explicit OWNER approval.
- No website, subscriptions, pricing, billing or payment implementation. Premium website routing/API interface documentation only.
- No automatic paid API credits, model-plan purchases or unapproved billable provider requests. Do not bypass budgets.
- No credential disclosure, synthetic contamination of real history, unverified financial metrics, fabricated narrative or false feature coverage.
- Preserve existing work, genuine calls, approved UI and English-only product output.
- Use local commits and honest internal checkpoint results; distinguish implementation, technical verification and OWNER acceptance.

**START / RESUME:** Read this file, current Git state and `docs/MASTER-PROGRESS.md` if it exists. Complete section 4A and finish Phase 4, then proceed through 5, 6 and 7 without waiting for intermediate OWNER approval. Deliver the integrated candidate and acceptance documents, then stop. Quality and actual working behavior take priority over token-count minimization and artificial test-count targets.
