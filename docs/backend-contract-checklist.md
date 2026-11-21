# Backend and website contract confirmation

**Owner:** @mc-integration. **Status:** Open; offline fixtures only. @mc-lead can forward this checklist to the Core API and website owners. The [product brief](Meme_Checker_Telegram_Bot_Brief_VI.md) §§4, 5.4, 7.2–7.3, 8 and 12 describe intent; example endpoints, payloads and URLs are not confirmed contracts.

## Core API owner — confirm before live wiring

- [ ] **Request and access (§§7.2, 12):** Provide a versioned spec or redacted staging request example: base URL, method/path (is the proposed `POST /api/v1/check` correct?), content type, exact request fields, and whether one call returns the full Free scan. Confirm the service auth scheme/header, Free entitlement, and how to provision credentials privately. Do not include secret values in examples.
- [ ] **Identity (§§3, 7.3):** Confirm API chain IDs in both directions, address canonicalization, and where the response echoes the chain/address. Give one known-good contract and redacted success payload per chain. For EVM-shaped addresses, confirm how the API distinguishes unsupported chains, non-token addresses, and BNB Chain token misses. Ask whether the backend can positively identify token contracts with no market pair.
- [ ] **Free fields and units (§§4, 7.3):** Mark fields required, optional, or nullable and specify numeric types (number vs string), timestamp format/timezone, USD units, and whether percentages are fractions or percentage points. Confirm distinct market cap and FDV semantics, holder counting/exclusions, and the distinction between missing and measured zero. Provide one partial or no-market example and specify the provenance/freshness fields used to decide what can be shown.
- [ ] **Narrative and project links (§4):** Identify approved sources, provenance/reference fields, freshness limits and how the API marks unverified content. Confirm where project links come from and whether they are tied to the exact token. Omit the narrative when reliable evidence is absent; do not infer social traction from metadata alone.
- [ ] **Failures and request policy (§8):** Document HTTP statuses, response envelopes and stable business codes for invalid address, unsupported chain, confirmed token miss, no market pair, auth/entitlement failure, throttling and dependency/server failures. Specify whether business errors can come back as `2xx`. Confirm rate limits and scope, `Retry-After`, timeout budget, retry/idempotency rules for the scan, and cache TTL/freshness. Operational limits are separate from user-facing daily quotas, which stay disabled.

## Website owner — confirm before wiring links

- [ ] **Token routes (§5.4):** Provide a staging origin and a working example URL for each of the same two API demo contracts. Confirm chain slugs, address casing, path/query format, and redirect behavior. Each URL must load Free data for the exact chain/address anonymously without asking the user to re-enter it. If adding attribution, confirm supported UTM keys; do not include Telegram user/group IDs or secrets.
- [ ] **VIP (§5.2–5.4):** Confirm the upgrade destination and expected flow for a signed-out visitor coming from the token page, plus which features are live versus coming soon.

## Acceptance evidence

- Backend verification: record environment and spec/version, HTTP status, normalized outcome, and matching chain/address for each known-good contract. Verify a partial reply and a documented failure; `2xx` alone is not proof of success. Reject mismatched identity; never report infrastructure failure as `not-found`.
- Website verification: @mc-qa can click the generated URL for the same contracts in a logged-out session and compare the final page's chain/address with the scan result. A matching path string alone does not prove the page renders the correct token.
- Keep offline tests available explicitly as `mode: 'mock'`; their `.example` links are placeholders. Live failures must not fall back to mock data. Attach only redacted evidence to the handoff.
