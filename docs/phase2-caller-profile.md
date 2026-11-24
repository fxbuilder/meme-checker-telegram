# Phase 2 — First Call attribution, caller profiles, image-only /pnl

Status of the two UX corrections requested after the first Phase 2 review.

## 1. First Call attribution inside the token card

The line is rendered by `formatCard()` when a `firstCall` is supplied:

```
🔥 First Call <a href="https://t.me/<bot>?start=cp_XXXX">Foxy</a> @ $18.22M
```

- It sits **inside** the token card, immediately above `Powered by MEME CHECKER`.
  No separate attribution message is sent.
- The whole Variant A layout is untouched: the line is optional and its absence
  produces byte-identical output to the pre-change card (asserted by tests).

### Mode behaviour

| Mode | Paste a CA | Call recorded? |
| --- | --- | --- |
| Auto | card shows First Call if one exists; **this paste becomes the call** | yes, attributed to the message sender |
| Manual | card shows First Call if one exists | no |
| `/call` | records deliberately, then shows attribution | yes |
| `/justscan` | scans only, cancels for this CA | no |

Auto mode records the call **before** the card is built, so the same card carries
the attribution. The previous implementation scanned twice and sent a second
"call recorded" message; both are gone.

Attribution is never overwritten: `firstCall()` returns the earliest non-cancelled
record, and a later caller is reported as `isFirstCall: false`.

## 2. Caller identity

`src/caller-identity.mjs` reads `sender_chat`, which is authoritative whenever
Telegram supplies a placeholder `from`:

| `from.id` | Meaning | Resolution |
| --- | --- | --- |
| `1087968824` | @GroupAnonymousBot | `sender_chat` → `c:<chatId>` |
| `136817688` | @Channel_Bot | `sender_chat` → `c:<channelId>` |
| `777000` | Telegram service | `sender_chat`, else unattributed |
| anything else | ordinary user | `u:<userId>` |

- `callerKey` (`u:<id>` / `c:<chatId>`) is the primary identity. Display names and
  usernames are labels only and may change without affecting attribution.
- A placeholder **without** `sender_chat` is left unattributed rather than credited
  to a bot id shared by every group on Telegram.
- The record keeps `messageId` and `messageDate`; a call's time is the moment the
  CA was posted, not when the bot processed it.
- Calls are scoped by `chatId` on every read.
- Dedup matches both `callerKey` and the legacy `callerId`, so records written
  before this change still block duplicates.

### Known limitation

Anonymous admins of the same group are **indistinguishable**: their `sender_chat`
is the group itself. Two different anon admins calling the same token therefore
look like one caller. This is a Telegram constraint, not a bug here.

## 3. Clickable caller profile

The name is a `t.me/<bot>?start=<payload>` deep link. A bot cannot link to a
Telegram user profile, so a `tg://user` link is never used.

**Payload** = `cp_` + base64url(HMAC-SHA256(secret, `chatId:callerKey:period`)[0..12]),
19 characters — well under Telegram's 64-char limit. Properties, all tested:

- not reversible; contains neither the user id nor the chat id
- scoped: the same person gets a different token in each group, so a forwarded
  link cannot expose another group's records
- signed: a tampered or guessed payload resolves to nothing
- deterministic and restart-safe when `CALLER_LINK_SECRET` is set in `.env`

Resolution never trusts a client-supplied id: the bot recomputes the token for each
caller known in that group and compares in constant time.

**Access:** owner-only during staging. Unknown payloads get a neutral
"link is no longer valid" that does not reveal whether it ever existed.

**Profile content:** caller, group, period, total calls, hit rate (≥2× peak, stated
on the card), best call, average and median peak, token list with current and peak
per token, time since each call. Periods 1D/7D/14D/30D via inline buttons that edit
the same message. Current and peak are labelled separately and the card states that
peak is the highest *observed* value, not all-time high.

Synthetic records are excluded from profiles by construction: `callerKeysInGroup()`
filters them, so a simulated 20× cannot be reached through a profile link.

### Membership verification for production (Phase 6)

When the bot is **not** an administrator it cannot call `getChatMember` reliably for
arbitrary users, so it cannot confirm that a link holder is still in the group.
Options, in order of preference:

1. Verify with `getChatMember(chat_id, user_id)` and require status in
   `creator|administrator|member`. Requires the bot to be an admin, or at minimum
   the group to be public / the user to have interacted recently.
2. Cache membership at call time: a caller who recorded a call in that group is
   treated as a member for the life of their record.
3. Fail closed: show only aggregate figures, never the token list, when membership
   cannot be confirmed.

Do not enable public profile links until (1) or (2) is implemented.

## 4. `/pnl` is image only

`/pnl <contract_address>`:

- resolves the address against **this group's** recorded calls only
- one photo, sent as a reply to the command, with **no caption**, no buttons and no
  follow-up text
- no call → exactly `No recorded call for this token in this group.`; nothing is
  inserted
- address recorded on several chains → asks instead of guessing
- cancelled call → says it was cancelled
- renderer failure → `⚠️ Could not generate the PnL image.` — a text report is never
  passed off as the image

Verified against Telegram's own API response: `has photo: True`, `caption: None`.

## 5. PnL image

Verified layout: circular token logo, token name, `$TICKER · chain · group`, large
**CURRENT ROI** with its label, a single labelled **PEAK ROI**, entry / current /
peak market cap rows, caller, time since call, and the disclaimer that peak is the
highest observed value rather than realised profit.

- Logo comes from the identity-checked pair's `media.logo` only. Fetching is
  https-only with content-type, 2 MB, 512 px and 6 s limits, and falls back silently.
- No charts are drawn — there is no reliable historical observation series yet.
- `/pnlbg` (custom group backgrounds) is deferred to Phase 6.

## Test coverage

- `test/caller-identity.test.mjs` — placeholder ids, anon admin, channel, scoping
- `test/deep-link.test.mjs` — signing, tampering, cross-group portability, periods
- `test/first-call-and-profile.test.mjs` — in-card line, escaping, aggregation,
  period filtering, hit-rate threshold, current-vs-peak labelling
- `test/call-commands.test.mjs` — image-only `/pnl`, no-call response, no
  cross-group fallback, render-failure honesty

Real-Telegram: `qa/phase2-ux-acceptance.mjs` (25 checks) and
`qa/phase2-profile-acceptance.mjs` (23 checks), both of which tag their records
`synthetic`, delete them afterwards, and assert real history is untouched.
