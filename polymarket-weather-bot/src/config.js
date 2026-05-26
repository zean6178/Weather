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
