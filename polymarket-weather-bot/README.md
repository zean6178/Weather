# Polymarket Weather Prediction Bot v2.0

A powerful Telegram bot that tracks real-time weather prediction markets from [Polymarket](https://polymarket.com/predictions/weather) **with full auto-trading capabilities** — auto-buy, auto-sell, stop-loss, take-profit, and trailing stop.

## Features

### Market Data
- **Live Weather Markets** — Real-time data from Polymarket's weather prediction markets
- **City Filtering** — View predictions for specific cities (NYC, London, Chicago, Shanghai, Seoul, etc.)
- **Search** — Find markets by keyword
- **Trending Markets** — See highest-volume markets
- **Ending Soon** — Markets closing within 24 hours
- **Price Alerts** — Get notified when odds cross your threshold
- **Market Statistics** — Aggregate volume, liquidity, and city coverage

### Auto-Trading (NEW in v2.0)
- **Manual Orders** — Place limit buy/sell orders directly from Telegram
- **Market Orders** — Instant execution with slippage protection (FOK)
- **Auto-Buy** — Automatically buy when price drops to your target
- **Auto-Sell** — Automatically sell when price rises to your target
- **Stop-Loss** — Auto-sell to limit downside when price drops
- **Take-Profit** — Auto-sell to lock in gains at target price
- **Trailing Stop** — Dynamic stop-loss that follows price upward
- **Position Tracking** — View open positions and P&L
- **Balance Check** — Check your pUSD wallet balance
- **Order Management** — View and cancel open orders

## Architecture

```
src/
├── index.js        # Entry point with process-level error handling
├── config.js       # Environment configuration with validation
├── logger.js       # Winston logger (console + file rotation)
├── cache.js        # In-memory TTL cache to reduce API load
├── polymarket.js   # Polymarket Gamma API integration (market data)
├── trader.js       # Polymarket CLOB API trading client (buy/sell/cancel)
├── strategy.js     # Auto-trading strategy engine (signals, monitoring)
├── formatter.js    # Telegram MarkdownV2 message formatting
├── alerts.js       # Price alert manager
└── bot.js          # Telegraf bot (commands, callbacks, cron, trading)
```

## Prerequisites

- **Node.js** 18+ (LTS recommended)
- **Telegram Bot Token** — Get one from [@BotFather](https://t.me/BotFather)
- **For Trading**: Polygon wallet with pUSD balance + private key

## Quick Start

### 1. Clone the repository

```bash
git clone https://github.com/zean6178/Weather.git
cd Weather/polymarket-weather-bot
```

### 2. Install dependencies

```bash
npm install
```

### 3. Configure environment

```bash
cp .env.example .env
```

Edit `.env` and add your Telegram bot token:

```env
TELEGRAM_BOT_TOKEN=your_bot_token_from_botfather
```

### 4. (Optional) Enable Trading

Add your trading credentials to `.env`:

```env
PRIVATE_KEY=0xYourPrivateKeyHere
FUNDER_ADDRESS=0xYourWalletOrDepositWalletAddress
SIGNATURE_TYPE=0
POLYGON_RPC_URL=https://polygon-rpc.com
```

### 5. Start the bot

```bash
npm start
```

## Commands

### Market Data Commands

| Command | Description |
|---------|-------------|
| `/start` | Welcome message with quick start guide |
| `/markets` | Show active weather prediction markets |
| `/city <name>` | Markets for a specific city (e.g., `/city NYC`) |
| `/search <query>` | Search markets by keyword |
| `/stats` | Market statistics (volume, liquidity, cities) |
| `/cities` | List all cities with active markets |
| `/hot` | Trending markets by volume |
| `/ending` | Markets ending within 24 hours |
| `/alerts` | View/manage price alerts |
| `/help` | Full command reference |

### Trading Commands

| Command | Description |
|---------|-------------|
| `/buy <tokenId> <price> <size>` | Place a limit BUY order |
| `/sell <tokenId> <price> <size>` | Place a limit SELL order |
| `/marketbuy <tokenId> <amount> <maxPrice>` | Instant market buy (FOK) |
| `/marketsell <tokenId> <shares> <minPrice>` | Instant market sell (FOK) |
| `/autobuy <tokenId> <targetPrice> <size>` | Auto-buy when price drops to target |
| `/autosell <tokenId> <targetPrice> <size>` | Auto-sell when price rises to target |
| `/stoploss <tokenId> <stopPrice> <size>` | Stop-loss (sell if price drops) |
| `/takeprofit <tokenId> <profitPrice> <size>` | Take-profit (sell at target) |
| `/trailstop <tokenId> <trailPercent> <size>` | Trailing stop (dynamic stop-loss) |
| `/strategies` | View active auto-trade strategies |
| `/cancelstrategy <id>` | Cancel a specific strategy |
| `/cancelall` | Cancel all strategies + open orders |
| `/positions` | View open positions |
| `/balance` | Check wallet pUSD balance |
| `/orders` | View open orders |
| `/cancelorder <orderId>` | Cancel a specific order |
| `/tradestatus` | Trading system status |

## Trading Examples

### Basic Buy & Sell

```
# Buy 100 shares at $0.45
/buy 71321045679252212594... 0.45 100

# Sell 100 shares at $0.65
/sell 71321045679252212594... 0.65 100
```

### Auto-Trade Strategies

```
# Auto-buy 200 shares when price drops to $0.30
/autobuy 71321045679252212594... 0.30 200

# Auto-sell 200 shares when price rises to $0.75
/autosell 71321045679252212594... 0.75 200

# Stop-loss: sell 100 shares if price drops to $0.20
/stoploss 71321045679252212594... 0.20 100

# Take-profit: sell 100 shares when price hits $0.80
/takeprofit 71321045679252212594... 0.80 100

# Trailing stop: sell if price drops 15% from high
/trailstop 71321045679252212594... 15 100
```

## Configuration

All settings are configured via environment variables (`.env` file):

| Variable | Default | Description |
|----------|---------|-------------|
| `TELEGRAM_BOT_TOKEN` | *required* | Bot token from @BotFather |
| `ADMIN_CHAT_ID` | — | Chat ID for admin notifications |
| `GAMMA_API_BASE_URL` | `https://gamma-api.polymarket.com` | Polymarket Gamma API |
| `CLOB_API_BASE_URL` | `https://clob.polymarket.com` | Polymarket CLOB API |
| `PRIVATE_KEY` | — | Wallet private key (enables trading) |
| `FUNDER_ADDRESS` | — | Funder/deposit wallet address |
| `SIGNATURE_TYPE` | `0` | Order signature type (0-3) |
| `POLYGON_RPC_URL` | `https://polygon-rpc.com` | Polygon RPC endpoint |
| `STRATEGY_CHECK_SECONDS` | `30` | Auto-trade check interval |
| `MAX_POSITION_SIZE` | `1000` | Max shares per trade |
| `MAX_TOTAL_EXPOSURE` | `5000` | Max total exposure |
| `CACHE_TTL_SECONDS` | `60` | Cache TTL |
| `MAX_MARKETS_PER_PAGE` | `10` | Markets per page |
| `POLLING_INTERVAL_MINUTES` | `5` | Alert check interval |
| `LOG_LEVEL` | `info` | Log level |

## Security

### Private Key Safety

- **NEVER** commit your `.env` file to git (it's in `.gitignore`)
- **NEVER** share your private key with anyone
- Use a **dedicated trading wallet** with limited funds
- Set `MAX_POSITION_SIZE` and `MAX_TOTAL_EXPOSURE` limits
- Start with small amounts to test

### Trading Risks

- Prediction markets are volatile — prices can change rapidly
- Auto-trading strategies execute automatically without confirmation
- Network issues may cause delays in order execution
- Always monitor your bot and positions
- The bot is provided AS-IS with no guarantees

## Deployment

### Option 1: VPS / Cloud VM

```bash
npm install -g pm2
pm2 start src/index.js --name polymarket-weather-bot
pm2 save
pm2 startup
```

### Option 2: Docker

```dockerfile
FROM node:20-alpine
WORKDIR /app
COPY package*.json ./
RUN npm ci --only=production
COPY . .
CMD ["node", "src/index.js"]
```

```bash
docker build -t polymarket-weather-bot .
docker run -d --env-file .env --name weather-bot polymarket-weather-bot
```

### Option 3: Railway / Render / Fly.io

1. Push to GitHub
2. Connect repository to your platform
3. Set environment variables
4. Deploy

## API Reference

The bot uses two Polymarket APIs:

- **Gamma API** (`gamma-api.polymarket.com`) — Market discovery, events, metadata (no auth)
- **CLOB API** (`clob.polymarket.com`) — Order placement, cancellation, balances (requires auth for trading)

Authentication uses EIP-712 signatures (L1) to derive HMAC API credentials (L2), handled automatically by `@polymarket/clob-client-v2`.

## Reliability Features

- **Exponential Backoff** — Retries failed API requests up to 3 times
- **TTL Cache** — Prevents excessive API calls
- **Graceful Shutdown** — Handles SIGINT/SIGTERM, stops strategies
- **Error Isolation** — Strategy errors don't crash the bot
- **Position Tracking** — Records entries for P&L monitoring
- **Winston Logging** — File rotation with structured output

## License

MIT
