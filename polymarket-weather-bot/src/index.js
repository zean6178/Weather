'use strict';

/**
 * Polymarket Weather Prediction Bot
 *
 * Main entry point. Initializes configuration, logger, and starts the Telegram bot.
 */

const logger = require('./logger');
const { startBot, setupGracefulShutdown } = require('./bot');

// Handle uncaught exceptions
process.on('uncaughtException', (error) => {
  logger.error('Uncaught Exception:', error);
  process.exit(1);
});

process.on('unhandledRejection', (reason, promise) => {
  logger.error('Unhandled Rejection at:', promise, 'reason:', reason);
});

// Startup
(async () => {
  logger.info('='.repeat(50));
  logger.info('Polymarket Weather Prediction Bot');
  logger.info('='.repeat(50));
  logger.info(`Environment: ${process.env.NODE_ENV || 'development'}`);
  logger.info(`Node.js: ${process.version}`);
  logger.info('Starting bot...');

  setupGracefulShutdown();
  await startBot();
})();
