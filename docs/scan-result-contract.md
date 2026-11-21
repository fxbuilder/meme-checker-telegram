# Scanner-to-card contract (v1)

This is the internal interface for `scan({ chain, address })` → `formatCard(result)`. It is not the Core API wire schema. The mock implementation defines the current field names; the live adapter will map confirmed backend fields into this shape. No staging URL, request, field mapping or error-code mapping is implied by this document.

## Request and successful result

- `chain`: `solana` or `bsc` (internal names). `address`: Solana case preserved; BNB Chain canonicalized to lowercase. Identity is the pair `(chain, address)`, never a ticker. The adapter verifies the backend response belongs to that pair before returning `ok` or constructing a token link.
- `mode`: `'mock'` for fixtures, `'live'` for the live path. `status`: `'ok'` for the object below. All keys listed for `ok` are present; absent optional values are `null`. `market`, `holders` and `project` are objects even when their values are all null.

| Key | Shape / units |
| --- | --- |
| `token` | `{ chain, address, name, symbol }`; name and symbol are non-empty strings in v1. |
| `market` | `{ priceUsd, marketCapUsd, fdvUsd, liquidityUsd, volume24hUsd, priceChange24h }`; finite numbers or `null`. Price and money values are USD; change is signed percentage points (`18.5` means `+18.5%`). |
| `holders` | `{ total, top10Percentage, largestHolderPercentage }`; count and percentage points, respectively; finite numbers or `null`. |
| `narrative` | `null` or `{ summary, source }`, both non-empty strings. The adapter, not the renderer, gates this on reliable provenance for the same token. |
| `project` | `{ website, x, telegram }`; verified HTTPS URLs or `null`. The adapter must reject untrusted URL schemes and credentials; renderer still escapes HTML attributes. |
| `updatedAt` | Backend observation timestamp as an ISO 8601 string with timezone, or `null`; never synthesize freshness. |
| `fullAnalysisUrl` | Adapter-supplied absolute HTTPS URL for the exact chain/address, or `null`. Live requires a confirmed token route, not just a configured origin. Mock mode defaults to `null` and may link only to an explicitly configured demo destination using the mock route convention. Placeholder hosts (including `.example`), malformed URLs and URLs with userinfo are never CTA links in either mode. The renderer uses an accepted URL unchanged; it never invents a route. |

A confirmed token with no market pair is still `ok` if required identity is available; unavailable market fields are `null`. Measured `0` is preserved. FDV never fills a missing market cap.

## Full card layout and link configuration

Sections 4.1 and 9 of the brief do not require new normalized scan fields. Keep the Holder Overview, Narrative and Project Info headings even when data is absent. Use concise English availability copy for null fields; a missing narrative means no summary (e.g. “No verified narrative available”), and absent project URLs show “Not Available” without links. The DYOR teaser, CTA text and emoji theme are presentation, not backend evidence. Mark unlaunched features “Coming Soon” rather than suggesting they are available.

- **Full Analysis** uses only `fullAnalysisUrl` from the scanner, for the matched chain/address. Keep the section visible without a working CTA by showing an availability note when the URL is `null`.
- **Premium** is a separate, optional bot-level HTTPS destination, not a per-token scan field. Pass an explicit destination into the formatter and `/upgrade`; never derive `/pricing` from the token-page origin. If the destination is absent, malformed, credentialed, non-HTTPS, or a placeholder, omit the Premium button. This must not affect Website or Add Bot to Group. The configured destination is not considered verified until the website flow is checked.
- When all destinations are present, preserve the §9 order: Full Analysis; Premium then Website; Add Bot to Group. Omit unavailable buttons and empty rows, without changing the relative order of those that remain.

## Failure result

`{ mode, status }`, with no token data or CTA. Current renderer status vocabulary: `not-found` (confirmed token miss in live mode, fixture miss in mock mode), `invalid-response` (unexpected payload or identity mismatch), `api-error` (access/config/transport/upstream failure), `rate-limited` (confirmed throttle). The adapter must not map an undocumented HTTP/business error to `not-found`, including an otherwise unexplained `404`. New user-facing statuses, if needed after Core confirmation, require coordination before being emitted. Mock failures stay labeled mock; no live failure can fall back to mock.

## Verification

- Mock: run `node --test` in the integration and Telegram worktrees. Compare scanner output directly with the renderer input for both chains, and verify partial data, error modes and absent CTA behavior.
- Live: map redacted evidence against this contract and the [backend checklist](backend-contract-checklist.md); verify the rendered token page signed out. Passing offline tests does not confirm staging routes, VIP destination, or backend behavior.
