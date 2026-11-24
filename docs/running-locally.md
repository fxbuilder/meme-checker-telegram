# Running the Meme Checker staging bot (OWNER)

The owner runs the bot locally. Only ONE polling process may exist per bot token;
two would fight over Telegram's `getUpdates` and both would die with
`409 Conflict`.

## Start

Double-click **`start-bot.cmd`** in `E:\meme-checker-telegram`, or from CMD:

```cmd
cd /d E:\meme-checker-telegram
npm start
```

Both force `SCAN_MODE=live`. A shell value beats `--env-file`, so the `SCAN_MODE`
line inside `.env` cannot silently put you in mock mode. `npm run start:mock` exists
for offline work and prints a warning banner.

## Stop

`Ctrl+C` in the terminal window. Then restart with the same command.

## What the terminal should show

```
[bot] Starting Meme Checker bot (SCAN_MODE=live)…
[bot] Store: E:\meme-checker-telegram\data\calls.json
[bot] Connected as @MemeCheckerStagingBot.
[bot] Command menu registered.
[bot] Staging allowlist: chats=[-5333984336] owners=[1307106746] allowAny=false
[bot] Polling for updates. (Ctrl+C to stop)
```

If `SCAN_MODE` is anything but `live`, a loud warning is printed. Cards would then
show fixture data.

Every command and button press logs one line:

```
[cmd] CMD /pnl DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263 (from=1307106746 chat=-5333984336)
[cmd] CB cp:cp_AbCdEf:1d (from=1307106746 DM)
```

That distinguishes "the update never arrived" from "the handler failed": if there
is no `[cmd]` line, Telegram did not deliver it; if there is a line but no response,
the failure is in the handler and the exception is printed below it.

## If it exits immediately with 409 Conflict

Another poller is still running. Find and stop only that process:

```cmd
tasklist /FI "IMAGENAME eq node.exe"
```

Never stop the Hermes gateway or unrelated Node processes.

## Data

- Call history: `data/calls.json` (atomic writes, backed up before any repair)
- Do not delete this file to "reset" — it holds the real call records
- `.env` holds the token; never paste it into chat or a screenshot

## Known limits (Phase 2)

- Top holders / LP lock / tax need a paid or keyed provider; the card shows an
  honest unavailable state rather than a zero
- Caller profiles are owner-only during staging. Membership verification is
  Phase 6 — without it, a forwarded profile link cannot be scoped to members
- Custom PnL backgrounds (`/pnlbg`) are Phase 6
