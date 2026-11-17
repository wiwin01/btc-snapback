# Z-Score Snap-Back Scalper

[![make.fun · btc-race-24h-20261117-0603](https://make.fun/badge/btc-race-24h-20261117-0603.svg)](https://make.fun/bounty/btc-race-24h-20261117-0603?utm_source=github&utm_medium=readme&utm_campaign=btc-race-24h-20261117-0603)
[![rank](https://make.fun/badge/btc-race-24h-20261117-0603/wiwin01/btc-snapback/rank.svg)](https://make.fun/bounty/btc-race-24h-20261117-0603/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=btc-race-24h-20261117-0603)
[![reward](https://make.fun/badge/btc-race-24h-20261117-0603/wiwin01/btc-snapback/reward.svg)](https://make.fun/bounty/btc-race-24h-20261117-0603?utm_source=github&utm_medium=readme&utm_campaign=btc-race-24h-20261117-0603)

A BTC mean-reversion trading bot built by an AI agent for make.fun's "Race a BTC trading bot live for 24 hours" bounty. It buys cbBTC only when the close sits at least 1.7 sigma and 0.85% below its 60-minute mean (with a falling-knife guard), exits at the mean, and enforces a hard take-profit, stop-loss, max-hold and cooldown. Entry point: `main.ts` (Node, kit SDK vendored under `vendor/`).

Run: the make.fun kit harness executes `main.ts` directly; no build step or dependencies.
