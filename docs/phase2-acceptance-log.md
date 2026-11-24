# Phase 2 acceptance log — real group

**Group:** `sissooo1` · chat_id `-5333984336` · type `group`
**Bot:** @MemeCheckerStagingBot · status **member** (not admin) · privacy mode OFF
**Allowlist:** `ALLOWED_CHAT_IDS=-5333984336`, `OWNER_USER_IDS=1307106746`

## Verified by direct evidence

| Item | Result | Evidence |
| --- | --- | --- |
| Group identity | PASS | `getChat` → title `sissooo1`, id `-5333984336` |
| Bot is a plain member | PASS | `getChatMember` → `status: member` |
| Privacy mode off (no admin needed to read) | PASS | `getMe` → `can_read_all_group_messages: true` |
| Bot can post in the group | PASS | probe `sendMessage` → id 179, then deleted |
| Auto-detect of a pasted CA in the group | PASS | poller log: `image: banner 32103B for solana:DezXAZ8z7P…` ×3 |
| Approved Variant A photo card | PASS | same log line — image resolution runs only on the send path |
| PnL photo delivery into the group | PASS | `sendPhoto` → message_id **184**, `hasPhoto: true`, caption 421 chars, 10 caption entities parsed |
| PnL text card delivery | PASS | `sendMessage` → message_id **185** |
| Synthetic data is labelled | PASS | caption opens `🧪 ACCEPTANCE TEST — SIMULATED DATA` |
| Synthetic records excluded from real stats | PASS | store: 3 synthetic / 0 real; `/calls` and `/fc` filter them |
| Group isolation | PASS | a different chat id returns 0 calls |
| Auto-call defaults to manual | PASS | `groupSettings.autoCall === 'manual'`; a pasted CA scanned and recorded **no** call |
| Command menu registered | PASS | 15 commands via `getMyCommands`, including /call /calls /fc /pnl /callsettings |
| No duplicate polling instance | PASS | single poller, no 409 in the log |
| Allowlist enforced and visible | PASS | startup log: `chats=[-5333984336] owners=[1307106746] allowAny=false` |

## Still requiring an OWNER-entered command

These need the owner to type in the group; they cannot be driven from outside
without posting as a fake user, which would be dishonest evidence.

- `/call` → real call record with entry market cap
- `/calls` → list rendering
- `/fc` → first-caller attribution (needs ≥2 calls for the interesting case)
- `/pnl` → image for a REAL call
- Duplicate-call prevention (`/call` twice)
- First-caller attribution with a second caller
- Persistence across a restart of a REAL call

## Synthetic vs real separation

The acceptance PnL card used a record with `source: 'synthetic'` and a caption
that states it is simulated. It is stored in the same file but is filtered from
`/calls`, `/fc` and observer passes, so it can never appear as real performance.

## Notes

- Two extra scans appeared in the log beyond the first paste. This is consistent
  with additional pastes, not with a double-send: a duplicate CA inside the
  60-second window is suppressed by the cooldown module before any scan runs, so
  each scan line corresponds to a distinct post.
- `can_manage_topics` is null and the group is a plain `group`, so no forum-topic
  handling is required.
