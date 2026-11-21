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
| `fullAnalysisUrl` | Adapter-supplied HTTPS URL or `null`. Build only from confirmed website route rules for the matched token; preserve required address casing. The renderer uses it unchanged or omits the CTA. `.example` fixture URLs are mock-only. |

A confirmed token with no market pair is still `ok` if required identity is available; unavailable market fields are `null`. Measured `0` is preserved. FDV never fills a missing market cap.

## Failure result

`{ mode, status }`, with no token data or CTA. Current renderer status vocabulary: `not-found` (confirmed token miss in live mode, fixture miss in mock mode), `invalid-response` (unexpected payload or identity mismatch), `api-error` (access/config/transport/upstream failure), `rate-limited` (confirmed throttle). The adapter must not map an undocumented HTTP/business error to `not-found`, including an otherwise unexplained `404`. New user-facing statuses, if needed after Core confirmation, require coordination before being emitted. Mock failures stay labeled mock; no live failure can fall back to mock.

## Verification

- Mock: run `node --test` in the integration and Telegram worktrees. Compare scanner output directly with the renderer input for both chains, and verify partial data, error modes and absent CTA behavior.
- Live: map redacted evidence against this contract and the [backend checklist](backend-contract-checklist.md); verify the rendered token page signed out. Passing offline tests does not confirm staging routes, VIP destination, or backend behavior.
