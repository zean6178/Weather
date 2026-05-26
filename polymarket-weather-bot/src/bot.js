'use strict';

const { Telegraf, Markup } = require('telegraf');
const cron = require('node-cron');
const config = require('./config');
const polymarket = require('./polymarket');
const formatter = require('./formatter');
const alerts = require('./alerts');
const cache = require('./cache');
const logger = require('./logger');

const bot = new Telegraf(config.telegram.token);

// ────────────────────────────────────────────────────────────────
// MIDDLEWARE
// ────────────────────────────────────────────────────────────────

/**
 * Global error handling middleware
 */
bot.catch((err, ctx) => {
  logger.error(`Bot error for ${ctx.updateType}:`, err);
  try {
    ctx.reply('An error occurred. Please try again later.').catch(() => {});
  } catch (e) {
    // Ignore reply errors
  }
});

/**
 * Logging middleware - track all incoming updates
 */
bot.use(async (ctx, next) => {
  const start = Date.now();
  const userId = ctx.from?.id || 'unknown';
  const text = ctx.message?.text || ctx.callbackQuery?.data || '';
  logger.info(`[${userId}] ${text}`);

  try {
    await next();
  } finally {
    const ms = Date.now() - start;
    logger.debug(`[${userId}] Response time: ${ms}ms`);
  }
});

// ────────────────────────────────────────────────────────────────
// COMMANDS
// ────────────────────────────────────────────────────────────────

/**
 * /start - Welcome message
 */
bot.start(async (ctx) => {
  const firstName = ctx.from?.first_name || 'User';
  const text = formatter.formatWelcome(firstName);
  await ctx.replyWithMarkdownV2(text);
});

/**
 * /help - Command reference
 */
bot.help(async (ctx) => {
  const text = formatter.formatHelp();
  await ctx.replyWithMarkdownV2(text);
});

/**
 * /markets - Show active weather markets with pagination
 */
bot.command('markets', async (ctx) => {
  await ctx.reply('\u{1F504} Fetching weather markets...');

  const markets = await polymarket.getWeatherMarkets({ limit: config.bot.maxMarketsPerPage });

  if (markets.length === 0) {
    return ctx.reply('No active weather markets found at the moment.');
  }

  const text = formatter.formatMarketList(markets, 'Active Weather Markets');

  const buttons = [];
  if (markets.length >= config.bot.maxMarketsPerPage) {
    buttons.push([Markup.button.callback('\u{27A1}\uFE0F Next Page', 'markets_page_2')]);
  }
  buttons.push([
    Markup.button.callback('\u{1F504} Refresh', 'markets_refresh'),
    Markup.button.callback('\u{1F4CA} Stats', 'show_stats'),
  ]);

  await ctx.replyWithMarkdownV2(text, Markup.inlineKeyboard(buttons));
});

/**
 * /city <name> - Show markets for specific city
 */
bot.command('city', async (ctx) => {
  const args = ctx.message.text.split(' ').slice(1).join(' ').trim();
  if (!args) {
    return ctx.reply(
      'Please specify a city name.\n\nExample: /city NYC\n\nUse /cities to see available cities.'
    );
  }

  await ctx.reply(`\u{1F504} Fetching markets for ${args}...`);

  const markets = await polymarket.getWeatherMarkets({ city: args, limit: 20 });

  if (markets.length === 0) {
    return ctx.reply(
      `No active weather markets found for "${args}".\n\nUse /cities to see available cities.`
    );
  }

  const text = formatter.formatMarketList(markets, `Weather Markets: ${args}`);
  await ctx.replyWithMarkdownV2(text);
});

/**
 * /search <query> - Search markets
 */
bot.command('search', async (ctx) => {
  const query = ctx.message.text.split(' ').slice(1).join(' ').trim();
  if (!query) {
    return ctx.reply('Please provide a search query.\n\nExample: /search temperature NYC');
  }

  await ctx.reply(`\u{1F50D} Searching for "${query}"...`);

  const markets = await polymarket.searchWeatherMarkets(query);

  if (markets.length === 0) {
    return ctx.reply(`No markets found matching "${query}".`);
  }

  const text = formatter.formatMarketList(markets, `Search: ${query}`);
  await ctx.replyWithMarkdownV2(text);
});

/**
 * /stats - Market statistics
 */
bot.command('stats', async (ctx) => {
  await ctx.reply('\u{1F4CA} Calculating statistics...');

  const stats = await polymarket.getMarketStats();
  const text = formatter.formatStats(stats);
  await ctx.replyWithMarkdownV2(text, Markup.inlineKeyboard([
    [Markup.button.callback('\u{1F504} Refresh', 'refresh_stats')],
  ]));
});

/**
 * /cities - Show available cities
 */
bot.command('cities', async (ctx) => {
  const cities = await polymarket.getAvailableCities();
  const text = formatter.formatCitiesList(cities);

  // Create city buttons
  const buttons = [];
  const row = [];
  for (let i = 0; i < Math.min(cities.length, 12); i++) {
    row.push(Markup.button.callback(cities[i], `city_${cities[i]}`));
    if (row.length === 3) {
      buttons.push([...row]);
      row.length = 0;
    }
  }
  if (row.length > 0) buttons.push(row);

  await ctx.replyWithMarkdownV2(text, Markup.inlineKeyboard(buttons));
});

/**
 * /hot - Trending markets (by 24h volume)
 */
bot.command('hot', async (ctx) => {
  await ctx.reply('\u{1F525} Fetching trending markets...');

  const markets = await polymarket.getWeatherMarkets({ limit: 50 });

  // Sort by volume and take top 5
  const hotMarkets = markets
    .sort((a, b) => parseFloat(b.volume24hr || b.volume || 0) - parseFloat(a.volume24hr || a.volume || 0))
    .slice(0, 5);

  const text = formatter.formatMarketList(hotMarkets, '\u{1F525} Trending Weather Markets');
  await ctx.replyWithMarkdownV2(text);
});

/**
 * /ending - Markets ending soon
 */
bot.command('ending', async (ctx) => {
  await ctx.reply('\u{23F0} Finding markets ending soon...');

  const markets = await polymarket.getWeatherMarkets({ limit: 50 });
  const now = new Date();

  // Filter markets ending within 24 hours and sort by end time
  const endingSoon = markets
    .filter((m) => {
      if (!m.endDate) return false;
      const endDate = new Date(m.endDate);
      const diffHours = (endDate - now) / 3600000;
      return diffHours > 0 && diffHours <= 24;
    })
    .sort((a, b) => new Date(a.endDate) - new Date(b.endDate))
    .slice(0, 10);

  if (endingSoon.length === 0) {
    return ctx.reply('No weather markets ending in the next 24 hours.');
  }

  const text = formatter.formatMarketList(endingSoon, '\u{23F0} Ending Soon (within 24h)');
  await ctx.replyWithMarkdownV2(text);
});

/**
 * /alerts - Manage price alerts
 */
bot.command('alerts', async (ctx) => {
  const args = ctx.message.text.split(' ').slice(1);
  const chatId = ctx.chat.id.toString();

  if (args.length === 0) {
    // Show existing alerts
    const userAlerts = alerts.getAlerts(chatId);
    const text = formatter.formatAlertInfo(userAlerts);

    const buttons = [[Markup.button.callback('\u{274C} Clear All Alerts', 'alerts_clear')]];
    await ctx.replyWithMarkdownV2(text, Markup.inlineKeyboard(buttons));
    return;
  }

  if (args[0] === 'clear') {
    alerts.clearAlerts(chatId);
    return ctx.reply('\u{2705} All alerts cleared.');
  }

  // Help text for setting alerts
  return ctx.reply(
    '\u{1F514} Price Alert Setup:\n\n' +
    'To set an alert, use the alert buttons that appear on market detail views.\n\n' +
    'Or use: /alerts clear - to remove all alerts\n' +
    'Use: /alerts - to view active alerts'
  );
});

// ────────────────────────────────────────────────────────────────
// CALLBACK QUERIES (inline keyboard buttons)
// ────────────────────────────────────────────────────────────────

/**
 * Pagination for markets
 */
bot.action(/markets_page_(\d+)/, async (ctx) => {
  await ctx.answerCbQuery();
  const page = parseInt(ctx.match[1], 10);
  const offset = (page - 1) * config.bot.maxMarketsPerPage;

  const markets = await polymarket.getWeatherMarkets({
    limit: config.bot.maxMarketsPerPage,
    offset,
  });

  if (markets.length === 0) {
    return ctx.editMessageText('No more markets to show.');
  }

  const text = formatter.formatMarketList(markets, `Weather Markets (Page ${page})`);

  const buttons = [];
  const navRow = [];
  if (page > 1) {
    navRow.push(Markup.button.callback('\u{2B05}\uFE0F Previous', `markets_page_${page - 1}`));
  }
  if (markets.length >= config.bot.maxMarketsPerPage) {
    navRow.push(Markup.button.callback('\u{27A1}\uFE0F Next', `markets_page_${page + 1}`));
  }
  if (navRow.length > 0) buttons.push(navRow);
  buttons.push([
    Markup.button.callback('\u{1F504} Refresh', `markets_page_${page}`),
    Markup.button.callback('\u{1F4CA} Stats', 'show_stats'),
  ]);

  try {
    await ctx.editMessageText(text, {
      parse_mode: 'MarkdownV2',
      ...Markup.inlineKeyboard(buttons),
    });
  } catch (e) {
    // Message might be too long or unchanged
    await ctx.reply(text, {
      parse_mode: 'MarkdownV2',
      ...Markup.inlineKeyboard(buttons),
    });
  }
});

/**
 * Refresh markets
 */
bot.action('markets_refresh', async (ctx) => {
  await ctx.answerCbQuery('\u{1F504} Refreshing...');
  cache.clear();

  const markets = await polymarket.getWeatherMarkets({ limit: config.bot.maxMarketsPerPage });
  const text = formatter.formatMarketList(markets, 'Active Weather Markets');

  const buttons = [];
  if (markets.length >= config.bot.maxMarketsPerPage) {
    buttons.push([Markup.button.callback('\u{27A1}\uFE0F Next Page', 'markets_page_2')]);
  }
  buttons.push([
    Markup.button.callback('\u{1F504} Refresh', 'markets_refresh'),
    Markup.button.callback('\u{1F4CA} Stats', 'show_stats'),
  ]);

  try {
    await ctx.editMessageText(text, {
      parse_mode: 'MarkdownV2',
      ...Markup.inlineKeyboard(buttons),
    });
  } catch (e) {
    await ctx.reply(text, {
      parse_mode: 'MarkdownV2',
      ...Markup.inlineKeyboard(buttons),
    });
  }
});

/**
 * Show stats from button
 */
bot.action('show_stats', async (ctx) => {
  await ctx.answerCbQuery('\u{1F4CA} Loading stats...');
  const stats = await polymarket.getMarketStats();
  const text = formatter.formatStats(stats);

  try {
    await ctx.editMessageText(text, {
      parse_mode: 'MarkdownV2',
      ...Markup.inlineKeyboard([
        [Markup.button.callback('\u{1F504} Refresh', 'refresh_stats')],
        [Markup.button.callback('\u{2B05}\uFE0F Back to Markets', 'markets_page_1')],
      ]),
    });
  } catch (e) {
    await ctx.reply(text, { parse_mode: 'MarkdownV2' });
  }
});

/**
 * Refresh stats
 */
bot.action('refresh_stats', async (ctx) => {
  await ctx.answerCbQuery('\u{1F504} Refreshing stats...');
  cache.invalidate('market_stats');

  const stats = await polymarket.getMarketStats();
  const text = formatter.formatStats(stats);

  try {
    await ctx.editMessageText(text, {
      parse_mode: 'MarkdownV2',
      ...Markup.inlineKeyboard([
        [Markup.button.callback('\u{1F504} Refresh', 'refresh_stats')],
      ]),
    });
  } catch (e) {
    await ctx.reply(text, { parse_mode: 'MarkdownV2' });
  }
});

/**
 * City button callback
 */
bot.action(/city_(.+)/, async (ctx) => {
  await ctx.answerCbQuery();
  const city = ctx.match[1];

  const markets = await polymarket.getWeatherMarkets({ city, limit: 10 });

  if (markets.length === 0) {
    return ctx.reply(`No active weather markets found for "${city}".`);
  }

  const text = formatter.formatMarketList(markets, `Weather: ${city}`);

  try {
    await ctx.editMessageText(text, { parse_mode: 'MarkdownV2' });
  } catch (e) {
    await ctx.reply(text, { parse_mode: 'MarkdownV2' });
  }
});

/**
 * Clear alerts
 */
bot.action('alerts_clear', async (ctx) => {
  await ctx.answerCbQuery('\u{2705} Alerts cleared');
  const chatId = ctx.chat.id.toString();
  alerts.clearAlerts(chatId);

  try {
    await ctx.editMessageText('\u{2705} All price alerts have been cleared.');
  } catch (e) {
    await ctx.reply('\u{2705} All price alerts have been cleared.');
  }
});

// ────────────────────────────────────────────────────────────────
// SCHEDULED TASKS
// ────────────────────────────────────────────────────────────────

/**
 * Alert checking cron job - runs every X minutes
 */
function startAlertChecker() {
  const intervalMin = config.bot.pollingIntervalMinutes;
  const cronExpr = `*/${intervalMin} * * * *`;

  cron.schedule(cronExpr, async () => {
    try {
      if (alerts.getTotalAlertCount() === 0) return;

      logger.debug('Running alert check...');
      const markets = await polymarket.getWeatherMarkets({ limit: 100 });
      const triggered = alerts.checkAlerts(markets);

      for (const { chatId, alert, currentPrice } of triggered) {
        const direction = alert.direction === 'above' ? '\u{2B06}\uFE0F' : '\u{2B07}\uFE0F';
        const message =
          `\u{1F514} *ALERT TRIGGERED*\n\n` +
          `${direction} ${formatter.escapeMarkdown(alert.marketQuestion)}\n` +
          `Current price: *${formatter.escapeMarkdown(formatter.formatPercent(currentPrice))}*\n` +
          `Target: ${alert.direction} ${formatter.escapeMarkdown(formatter.formatPercent(alert.targetPrice))}`;

        try {
          await bot.telegram.sendMessage(chatId, message, { parse_mode: 'MarkdownV2' });
        } catch (e) {
          logger.error(`Failed to send alert to chat ${chatId}:`, e.message);
        }
      }
    } catch (error) {
      logger.error('Alert checker error:', error.message);
    }
  });

  logger.info(`Alert checker scheduled every ${intervalMin} minutes`);
}

/**
 * Cache cleanup cron - every 10 minutes
 */
function startCacheCleanup() {
  cron.schedule('*/10 * * * *', () => {
    const stats = cache.getStats();
    if (stats.expired > 0) {
      cache.clear();
      logger.debug(`Cache cleanup: cleared ${stats.expired} expired entries`);
    }
  });
}

// ────────────────────────────────────────────────────────────────
// BOT LIFECYCLE
// ────────────────────────────────────────────────────────────────

/**
 * Start the bot
 */
async function startBot() {
  try {
    // Launch bot with polling
    await bot.launch({
      dropPendingUpdates: true,
    });

    logger.info('\u{2705} Polymarket Weather Bot is running!');
    logger.info(`Bot username: @${bot.botInfo.username}`);

    // Start background tasks
    startAlertChecker();
    startCacheCleanup();

    // Notify admin if configured
    if (config.telegram.adminChatId) {
      try {
        await bot.telegram.sendMessage(
          config.telegram.adminChatId,
          '\u{2705} Bot started successfully!'
        );
      } catch (e) {
        logger.warn('Could not notify admin:', e.message);
      }
    }
  } catch (error) {
    logger.error('Failed to start bot:', error);
    process.exit(1);
  }
}

/**
 * Graceful shutdown
 */
function setupGracefulShutdown() {
  const shutdown = (signal) => {
    logger.info(`Received ${signal}. Shutting down gracefully...`);
    bot.stop(signal);
    process.exit(0);
  };

  process.once('SIGINT', () => shutdown('SIGINT'));
  process.once('SIGTERM', () => shutdown('SIGTERM'));
}

module.exports = { startBot, setupGracefulShutdown, bot };
