'use strict';

require('dotenv').config();

const config = {
  telegram: {
    token: process.env.TELEGRAM_BOT_TOKEN,
    adminChatId: process.env.ADMIN_CHAT_ID || null,
  },
  polymarket: {
    gammaApiBase: process.env.GAMMA_API_BASE_URL || 'https://gamma-api.polymarket.com',
    clobApiBase: process.env.CLOB_API_BASE_URL || 'https://clob.polymarket.com',
  },
  cache: {
    ttlSeconds: parseInt(process.env.CACHE_TTL_SECONDS, 10) || 60,
  },
  bot: {
    maxMarketsPerPage: parseInt(process.env.MAX_MARKETS_PER_PAGE, 10) || 10,
    pollingIntervalMinutes: parseInt(process.env.POLLING_INTERVAL_MINUTES, 10) || 5,
  },
  trading: {
    // Private key for signing orders (hex string starting with 0x)
    privateKey: process.env.PRIVATE_KEY || null,
    // Funder/deposit wallet address (where pUSD is held)
    funderAddress: process.env.FUNDER_ADDRESS || null,
    // Signature type: 0=EOA, 1=POLY_PROXY, 2=GNOSIS_SAFE, 3=POLY_1271 (deposit wallet)
    signatureType: parseInt(process.env.SIGNATURE_TYPE, 10) || 0,
    // Polygon RPC URL for signing transactions
    rpcUrl: process.env.POLYGON_RPC_URL || 'https://polygon-rpc.com',
    // Strategy check interval in seconds
    strategyCheckSeconds: parseInt(process.env.STRATEGY_CHECK_SECONDS, 10) || 30,
    // Max position size per trade (safety limit)
    maxPositionSize: parseFloat(process.env.MAX_POSITION_SIZE) || 1000,
    // Max total exposure across all positions
    maxTotalExposure: parseFloat(process.env.MAX_TOTAL_EXPOSURE) || 5000,
  },
  forecast: {
    // Minimum edge (%) to generate a signal (default 12%)
    minEdgePercent: parseFloat(process.env.SIGNAL_MIN_EDGE_PERCENT) || 12,
    // Minimum edge (%) for auto-execution (default 15%)
    autoExecMinEdgePercent: parseFloat(process.env.SIGNAL_AUTO_EXEC_EDGE_PERCENT) || 15,
    // NOAA User-Agent contact email (recommended by weather.gov)
    noaaContact: process.env.NOAA_CONTACT_EMAIL || 'polymarket-bot@example.com',
  },
  logging: {
    level: process.env.LOG_LEVEL || 'info',
  },
};

// Validate required config
if (!config.telegram.token) {
  console.error('FATAL: TELEGRAM_BOT_TOKEN is required. Set it in your .env file.');
  process.exit(1);
}

module.exports = config;
