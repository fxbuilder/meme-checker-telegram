# Phase 4 — Narrative and X/KOL intelligence

What is actually wired, what each source can and cannot do, and what it costs.

## The single most important fact

**X post discovery is not configured.** Neither this project nor the Onchain
Intelligence Scanner has a `SORSA_API_KEY` or `GETXAPI_KEY` in its environment.
Discovery therefore reports `not-configured` and the UI says so in words.

It does **not** say "0 posts", because that would assert we searched and found
nothing. It does **not** fall back to scraping X mirrors (unauthorised). It does
**not** invent posts.

Adding the key is the only change needed: the adapter, cache, budget, dedupe and
classification are already built and tested against mocked provider payloads.

## Provider status, verified on this machine

| Source | Auth | Verified | Used for |
| --- | --- | --- | --- |
| CoinGecko `/coins/{platform}/contract/{addr}` | none | 200 for solana (BONK 2,410 chars), ethereum (PEPE 1,053), binance-smart-chain (CAKE 168) | Narrative |
| X oEmbed `publish.twitter.com/oembed` | none | 200 for a live post, 404 for a deleted one | Single-post verification only |
| Sorsa `/v3/search-tweets` | `ApiKey` header | adapter built; **no key present** | X discovery when configured |
| X API v2 search | OAuth2 bearer | **BLOCKED** — no credential, paid | not used |

oEmbed **cannot search**. It can only confirm that a URL we already hold exists and
belongs to the handle we expect. That distinction is why "verified post" never means
"verified narrative".

## Feature-by-chain coverage

| Feature | Chains | Basis |
| --- | --- | --- |
| Market scan, calls, PnL, alerts | 15 | DexScreener pair data (unchanged from Phases 2–3) |
| Narrative | `solana`, `ethereum`, `bsc`, `base`, `arbitrum`, `optimism`, `polygon`, `avalanche` | CoinGecko has a verified platform slug for these |
| Narrative | other market chains (`hyperevm`, `monad`, `unichain`, `berachain`, `abstract`, `megaeth`, `robinhood`) | **Unsupported** — no verified CoinGecko slug, so the card says so rather than guessing |
| X discovery | all chains, when a key is configured | search is chain-agnostic; the contract is the query |
| X post verification | all chains | oEmbed is chain-agnostic |
| KOL profiles | all chains, but only for calls this bot recorded | see below |

A chain having market data says nothing about narrative coverage, and the code does
not imply otherwise.

## Narrative: what the label means

Every summary is returned with `summaryClass: 'project-claim'` and a named source,
and the card and `/narrative` both print that label under the text.

| Class | Meaning |
| --- | --- |
| `verified` | read from the chain or a deterministic provider field (name, symbol, contract) |
| `project-claim` | the project's own words, quoted, **not checked by this bot** |
| `reported` | asserted by a third party, attributed |
| `inferred` | this bot's reading, explicitly not a fact |

The narrative engine never composes prose. It extracts the first useful paragraph of
the project's own description and labels it. If no description exists, it returns
`{available:false, reason}` and the card keeps its existing honest unavailable line.
There is no template that generates a plausible story from a name.

## X / KOL: what counts as a call

| Classification | Rule |
| --- | --- |
| `public-call` | post text carries the **exact contract** AND reads as a call (ape/buy/entry/loading/target language) |
| `mention` | contract present but no call language, or ticker only |
| `announcement` | author is the project's own declared account |
| `repost` | the post is a quote or reply |

- A mention is **not** a call. A popular account with no contract match is a mention.
- `containsContract` is Solana case-sensitive and EVM case-insensitive, because that
  is how those addresses actually work.
- A ticker match is tracked in a separate field and never promoted to a contract
  match, so two tokens sharing a ticker across chains stay separate.
- Null metrics stay null. Unknown engagement never renders as zero engagement.
- Post URLs are derived only from `author + id`; a post with no author gets no URL.

`/kol` reports only public calls this bot recorded. It always states the sample size
and says the record is not the account's full trading history. An entry market cap is
shown only when it was verifiable; otherwise the row says performance is unavailable.
**The current market cap is never used as a stand-in for a historical entry.**

## Cost and budget

| Item | Cost | Control |
| --- | --- | --- |
| CoinGecko contract profile | free, keyless | 2.2s minimum interval between calls, 6h cache per token |
| X oEmbed | free, keyless | 8s timeout, used only for explicit verification |
| Sorsa search | ~$0.001/request (published), 100 free lifetime | `RESEARCH_X_BUDGET`, default 20/day, refuses when spent |

At the default settings a token's narrative is fetched **once every 6 hours** no
matter how many groups scan it, and no X request is made at all without a key.

## Caching

`ResearchCache` has three mechanisms, all verified by test:

- **in-process Map**, bounded to 800 entries, evicting oldest-first
- **in-flight promise sharing** — six concurrent scans of one token were measured
  making exactly **one** provider call
- **split TTLs** — description 6h, posts 30m, failure 30s, so a throttle recovers
  quickly without being hammered

Negative results (`not-found`, `unsupported-chain`) are cached on the long TTL
because they are real findings; provider failures are cached on the short one.

## Scan isolation

Research is additive. On a scan card it runs under a 2.5s ceiling
(`RESEARCH_TIMEOUT_MS`) inside a `Promise.race`; if it loses, the card ships without
research. `RESEARCH_ON_SCAN=off` removes the call entirely. A research failure has no
path into call recording, PnL or alerts.

Measured card lengths with research and First Call attribution both present:

| Token | Plain | Enriched | Limit |
| --- | --- | --- | --- |
| BONK | 504 | 854 | 1024 |
| PEPE | 484 | 826 | 1024 |

Both fit. If a longer narrative ever overflows, `delivery.mjs` sends the card as a
text message rather than truncating the contract address or a risk warning.

## Known limitations

- **X discovery is unavailable without a key.** This is the headline gap in Phase 4.
- `/kol` has no data source until discovery is configured, so it will report "no
  recorded calls" for every account. That is honest, not a bug.
- Narrative is a single provider (CoinGecko). A token not listed there has no
  narrative even if its own website describes it.
- Narrative is English-only, as is all bot-facing text.
- No AI synthesis is used. Extraction is deterministic, so there is no per-scan
  model cost and no risk of a model inventing a story.
- Historical entry market caps for X calls are not derivable from post text alone, so
  KOL performance remains unavailable until a post is observed live at call time.

---

## X provider configuration — what to set

Recovered from `E:\Projects\Onchain-Intelligence-Scanner` (read-only), commit
`9ca3db5` *"feat(x): add GetXAPI as a second live search provider, behind a real
spend guard"*.

### GetXAPI (primary)

| Item | Value |
| --- | --- |
| Environment variable | `GETXAPI_KEY` |
| Optional host override | `GETXAPI_BASE_URL` (default `https://api.getxapi.com`) |
| Auth header | `Authorization: Bearer <key>` |
| Search endpoint | `GET /twitter/tweet/advanced_search?q=<query>&product=Latest\|Top[&cursor=]` |
| Response | `{ tweets: [...], has_more, next_cursor, tweet_count }` |
| User endpoint | `GET /twitter/user/info?userName=<handle>` |
| Published cost | $0.001 per standard search call |
| Post fields | `id`, `text`, `createdAt`, `author.{userName,name,followers,isVerified,isBlueVerified}`, `likeCount`, `retweetCount`, `replyCount`, `quoteCount`, `viewCount`, `bookmarkCount`, `isReply`, `isQuote`, `quotedTweetId`, `url` |

**No credential is present in either project.** `GETXAPI_KEY` was never committed to
git in the reference project (verified with `git log -S`), and `.env.example` there
lists no X provider at all. The adapter was added with tests but there is no record of
a live key being configured on this machine.

To enable X/KOL intelligence, set in `E:\meme-checker-telegram\.env`:

```
GETXAPI_KEY=<your key>
```

Then restart the bot. Nothing else needs changing — the adapter, field mapping,
cache, budget, dedupe and classification are built and tested against the recovered
contract.

### Provider selection

`X_PROVIDER=getxapi|sorsa` names the backend explicitly. Without it, GetXAPI wins if
its key exists, then Sorsa. Silent precedence is avoided on purpose: cost and
provenance should not depend on which variable a machine happens to have.

### Budget

`RESEARCH_X_BUDGET` (default 20) caps X search requests per rolling day. A cache hit
does not spend budget, and an exhausted budget reports `budget-exhausted` rather than
silently making the request.

### What is verified vs not

- **Verified here:** the request shape, field mapping, error classification,
  deduplication and classification logic — all against mocked payloads in the exact
  recovered shape.
- **NOT verified here:** that a live key works end to end. That requires the key.
  Until a real search returns real posts, X intelligence is not claimed to work.
