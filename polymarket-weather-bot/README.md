# Polymarket Weather Prediction Bot 🌤️

A powerful Telegram bot that tracks real-time weather prediction markets from [Polymarket](https://polymarket.com/predictions/weather). Get live odds, volumes, and alerts for temperature prediction markets across major cities worldwide.

## Features

- **Live Weather Markets** — Real-time data from Polymarket's weather prediction markets
- **City Filtering** — View predictions for specific cities (NYC, London, Chicago, Shanghai, Seoul, etc.)
- **Search** — Find markets by keyword
- **Trending Markets** — See highest-volume markets
- **Ending Soon** — Markets closing within 24 hours
- **Price Alerts** — Get notified when odds cross your threshold
- **Market Statistics** — Aggregate volume, liquidity, and city coverage
- **Pagination** — Navigate large result sets with inline buttons
- **Auto-Refresh** — Periodic background polling for alert checks
- **Error Resilience** — Exponential backoff retries, in-memory caching, graceful shutdown

## Architecture

```
src/
├── index.js        # Entry point with process-level error handling
├── config.js       # Environment configuration with validation
├── logger.js       # Winston logger (console + file rotation)
├── cache.js        # In-memory TTL cache to reduce API load
├── polymarket.js   # Polymarket Gamma & CLOB API integration
├── formatter.js    # Telegram MarkdownV2 message formatting
├── alerts.js       # Price alert manager
└── bot.js          # Telegraf bot (commands, callbacks, cron)
```

## Prerequisites

- **Node.js** 18+ (LTS recommended)
- **Telegram Bot Token** — Get one from [@BotFather](https://t.me/BotFather)

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

### 4. Start the bot

```bash
npm start
```

For development with auto-reload:

```bash
npm run dev
```

## Commands

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

## Configuration

All settings are configured via environment variables (`.env` file):

| Variable | Default | Description |
|----------|---------|-------------|
| `TELEGRAM_BOT_TOKEN` | *required* | Bot token from @BotFather |
| `ADMIN_CHAT_ID` | — | Chat ID for admin error notifications |
| `GAMMA_API_BASE_URL` | `https://gamma-api.polymarket.com` | Polymarket Gamma API base |
| `CLOB_API_BASE_URL` | `https://clob.polymarket.com` | Polymarket CLOB API base |
| `CACHE_TTL_SECONDS` | `60` | Cache time-to-live in seconds |
| `MAX_MARKETS_PER_PAGE` | `10` | Markets per page in pagination |
| `POLLING_INTERVAL_MINUTES` | `5` | Alert check interval |
| `LOG_LEVEL` | `info` | Log level (error, warn, info, debug) |

## Deployment

### Option 1: VPS / Cloud VM

```bash
# Install PM2 for process management
npm install -g pm2

# Start with PM2
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
3. Set `TELEGRAM_BOT_TOKEN` in environment variables
4. Deploy — the `npm start` script is auto-detected

## API Reference

The bot uses two Polymarket APIs (no authentication required for read-only access):

- **Gamma API** (`gamma-api.polymarket.com`) — Market discovery, events, metadata
- **CLOB API** (`clob.polymarket.com`) — Orderbook data, pricing, price history

Data is sourced from the `tag_slug=weather` filter which includes daily temperature prediction markets.

## Reliability Features

- **Exponential Backoff** — Retries failed API requests up to 3 times with increasing delays
- **TTL Cache** — Prevents excessive API calls (configurable TTL)
- **Graceful Shutdown** — Handles SIGINT/SIGTERM properly
- **Uncaught Exception Handling** — Logs and exits cleanly on fatal errors
- **Winston Logging** — File rotation (error.log + combined.log) with structured output
- **Rate Limit Awareness** — Respects HTTP 429 responses with backoff

## License

MIT
