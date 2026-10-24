# Changelog

## v0.3.0 (2026-10-24)

### Polymarket Protocol V2
- Markets carry their protocol `version`. V2 markets trade, quote and stream under their V2 position IDs instead of CTF token IDs, and V2 sells check balances as `CONDITIONAL-V2`. A one-time approval fallback for V2 points at the PositionManager.
- Positions from the Data API, which doesn't report a version, look up their market's version on Gamma before selling (cached; V1 if unknown).
- No V2 markets are live yet, so nothing changes for current trades; the app is ready when they open.

### Unified SDK and Data API v2
- `@polymarket/client` 0.12.0 → 0.14.0. Its approval setup also covers the V2 contracts, and redemptions pick the protocol from the market's version.
- Data API v1 is retired today (2026-10-24). The last v1 calls moved to v2: `/traded` → `/v2/user-stats` and `/value` → `/v2/value`. The v1 leaderboard fallback is gone.

### Perps
- Preparation only: Perps attribution uses a builder account address rather than our bytes32 code, and needs Polymarket to register us first. A Perps trading view with builder attribution is planned for a later release.

## v0.2.0 (2026-10-17)

### ⚡ 1-click trading
- Optional session keys: sign one gasless authorization and trade without a wallet pop-up. The key is CLOB-only (it can't withdraw), lives in your browser, expires after 180 days and can be revoked at any time.
- A quiet "Turn on 1-click" option under the buy button, a ⚡ mark on the button when it's on, and a line on the home page.
- After you turn it off, the switch waits a minute, because Polymarket's relayer refuses a second action on a wallet while one is in flight. That refusal now shows a clear message.

### 📒 Portfolio, profiles and leaderboard
- Portfolio dashboard: value card, interactive P&L chart (1D, 1W, 1M, ALL) that starts at break-even like polymarket.com, and a calling card with volume, markets traded, Yay/Nay lean and caller style.
- New activity feed with filters, search, market icons, a net figure per day and route rails for deposits and withdrawals.
- Public read-only caller profiles at `#/u/<wallet>` with share links.
- Leaderboard at `#/leaderboard` on Data API v2: periods, profit or volume, categories, a candle podium and your own rank.

### 📰 News
- `GET /api/news`: public headlines from Google News RSS, with Bing News as a fallback, cached at the edge for 3 minutes.
- "In the news" card on market pages, headlines inside market cards with the odds move since each story, and a news corner on the home page that starts as a pill.

### Fixes and polish
- New buys show at once on the market page as "Confirming…" until Polymarket's position data catches up (about a minute), and balances keep refreshing for 90 seconds after a trade.
- Clicking "Balance" fills the most you can spend after Polymarket's fee, instead of an amount the fee would push over your balance.
- Leaderboard rows no longer nest links.
- `#/wallet?d=withdraw` opens the withdraw tab.

## v0.1.0 (2026-10-06)

First release on Arc mainnet: deposit from Arc to Polymarket through Circle CCTP V2, builder-attributed trading, gasless withdrawals back to Arc, top-ups from 7 chains via LI.FI, price alerts with Web Push, call history and quests.
