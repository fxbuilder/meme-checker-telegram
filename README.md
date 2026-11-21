# Meme Checker Telegram MVP

Demo: 23 November 2026, Vietnam time. See the [product brief](docs/Meme_Checker_Telegram_Bot_Brief_VI.md) and [team handoff](docs/handoff.md).

## Offline integration starter

From the project directory, use Node.js 24 (no package install):

```sh
node --test
node src/mock-scan.mjs solana
node src/mock-scan.mjs bsc
```

Both scans use synthetic fixtures based on §7.3 of the brief. They are not on-chain results. Links use `https://meme-checker.example` and only demonstrate matching the chain and address; they are not clickable demo endpoints. No Telegram bot or live API is started by these commands. `.env.example` lists placeholders for later wiring.

Telegram can import `mockScan({chain, address})` from `src/mock-scan.mjs`. Internal chain IDs are provisionally `solana` and `bsc`. See `test/mock-scan.test.mjs` for expected results. `status` is `ok`, `not-found` (fixture miss only, not a claim about a real token), or `invalid-response`. `mode: 'mock'` must be visible on mock cards. The starter deliberately omits narrative since the brief's example provenance is not a verified source. Live normalization and routing require the confirmed contracts; do not convert mock output into a live fallback.
