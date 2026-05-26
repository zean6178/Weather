'use strict';

const { Telegraf, Markup } = require('telegraf');
const cron = require('node-cron');
const config = require('./config');
const polymarket = require('./polymarket');
const formatter = require('./formatter');
const alerts = require('./alerts');
const cache = require('./cache');
const logger = require('./logger');
const trader = require('./trader');
const strategy = require('./strategy');
const noaa = require('./noaa');
const weatherSignal = require('./weather-signal');

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
// NOAA FORECAST & SIGNAL COMMANDS
// ────────────────────────────────────────────────────────────────

/**
 * /forecast <city> - Get NOAA/Open-Meteo weather forecast
 */
bot.command('forecast', async (ctx) => {
  const args = ctx.message.text.split(' ').slice(1).join(' ').trim();
  if (!args) {
    const cities = noaa.getSupportedCities()
      .filter((c, i, arr) => arr.findIndex((x) => x.name === c.name) === i)
      .map((c) => c.name)
      .join(', ');
    return ctx.reply(
      '\u{1F321} *Weather Forecast*\n\n' +
      'Usage: /forecast <city>\n\n' +
      'Example: /forecast NYC\n\n' +
      `Supported cities: ${cities}`,
      { parse_mode: 'Markdown' }
    );
  }

  const city = noaa.findCity(args);
  if (!city) {
    return ctx.reply(`\u{274C} City "${args}" not found. Use /forecast to see supported cities.`);
  }

  await ctx.reply(`\u{1F30D} Fetching forecast for ${city.name}...`);

  const forecast = await noaa.getForecast(city.key);
  if (!forecast) {
    return ctx.reply(`\u{274C} Could not fetch forecast for ${city.name}. Try again later.`);
  }

  let text = `\u{1F321} *Weather Forecast: ${forecast.city}*\n`;
  text += `Source: ${forecast.source}\n\n`;

  if (forecast.today) {
    const tempDisplay = forecast.today.unit === 'F'
      ? `${forecast.today.high}\u{00B0}F (${noaa.fahrenheitToCelsius(forecast.today.high)}\u{00B0}C)`
      : `${forecast.today.high}\u{00B0}C (${forecast.maxTodayF || noaa.celsiusToFahrenheit(forecast.today.high)}\u{00B0}F)`;
    text += `\u{2600}\uFE0F *Today:* High ${tempDisplay}\n`;
    if (forecast.today.description) text += `   ${forecast.today.description}\n`;
  }

  if (forecast.tomorrow) {
    const tempDisplay = forecast.tomorrow.unit === 'F'
      ? `${forecast.tomorrow.high}\u{00B0}F (${noaa.fahrenheitToCelsius(forecast.tomorrow.high)}\u{00B0}C)`
      : `${forecast.tomorrow.high}\u{00B0}C (${forecast.maxTomorrowF || noaa.celsiusToFahrenheit(forecast.tomorrow.high)}\u{00B0}F)`;
    text += `\u{1F324} *Tomorrow:* High ${tempDisplay}\n`;
    if (forecast.tomorrow.description) text += `   ${forecast.tomorrow.description}\n`;
  }

  text += `\n_Fetched: ${new Date(forecast.fetchedAt).toLocaleTimeString()}_`;

  await ctx.reply(text, { parse_mode: 'Markdown' });
});

/**
 * /signals - Get NOAA-based trading signals (forecast vs market odds)
 */
bot.command('signals', async (ctx) => {
  const args = ctx.message.text.split(' ').slice(1).join(' ').trim();

  if (args) {
    // Signals for a specific city
    await ctx.reply(`\u{1F4E1} Analyzing ${args} forecast vs market odds...`);
    const signals = await weatherSignal.generateSignals(args);

    if (signals.length === 0) {
      return ctx.reply(
        `\u{26AA} No actionable signals for "${args}".\n\n` +
        `Market prices align with the current weather forecast, or no matching markets found.`
      );
    }

    let text = `\u{1F4E1} *Signals for ${args}* (${signals.length})\n\n`;
    for (const s of signals.slice(0, 5)) {
      text += weatherSignal.formatSignal(s) + '\n\n';
    }
    return ctx.reply(text, { parse_mode: 'Markdown' });
  }

  // All signals across all cities
  await ctx.reply('\u{1F4E1} Scanning all cities for mispriced weather markets...');
  const signals = await weatherSignal.generateAllSignals();
  const text = weatherSignal.formatSignalsSummary(signals);
  await ctx.reply(text, { parse_mode: 'Markdown' });
});

/**
 * /autosignal - Auto-execute trades based on NOAA signals (if trading enabled)
 */
bot.command('autosignal', async (ctx) => {
  if (!trader.isReady()) {
    return ctx.reply('\u{26A0}\uFE0F Trading not enabled. /signals shows signals without executing.');
  }

  const args = ctx.message.text.split(' ').slice(1);
  const minEdge = args[0] ? parseFloat(args[0]) / 100 : 0.15; // Default 15% edge minimum

  if (isNaN(minEdge) || minEdge < 0.05 || minEdge > 0.50) {
    return ctx.reply('Usage: /autosignal [minEdge%]\n\nExample: /autosignal 20\n(Only execute signals with 20%+ edge)\n\nRange: 5-50');
  }

  await ctx.reply(`\u{1F916} Scanning for signals with \u{2265}${(minEdge * 100).toFixed(0)}% edge...`);

  const signals = await weatherSignal.generateAllSignals();
  const actionable = signals.filter((s) => Math.abs(s.edge) >= minEdge && s.tokenId);

  if (actionable.length === 0) {
    return ctx.reply('\u{26AA} No signals meet the minimum edge threshold.');
  }

  let executed = 0;
  let text = `\u{1F916} *Auto-Signal Execution*\n\n`;

  for (const signal of actionable.slice(0, 3)) { // Max 3 trades at once
    const chatId = ctx.chat.id.toString();

    if (signal.type.includes('BUY')) {
      const s = strategy.createAutoBuy(chatId, {
        tokenId: signal.tokenId,
        marketQuestion: `[SIGNAL] ${signal.market}`,
        targetPrice: signal.marketPrice, // Buy at current (underpriced) market price
        size: Math.min(config.trading.maxPositionSize / signal.marketPrice, 100),
      });
      text += `\u{1F7E2} AUTO-BUY set: "${signal.outcome}" @ $${signal.marketPrice}\n`;
      text += `   Edge: +${(signal.edge * 100).toFixed(1)}% | Confidence: ${signal.confidence}%\n\n`;
      executed++;
    } else if (signal.type.includes('SELL')) {
      const s = strategy.createAutoSell(chatId, {
        tokenId: signal.tokenId,
        marketQuestion: `[SIGNAL] ${signal.market}`,
        targetPrice: signal.marketPrice,
        size: 50,
      });
      text += `\u{1F534} AUTO-SELL set: "${signal.outcome}" @ $${signal.marketPrice}\n`;
      text += `   Edge: ${(signal.edge * 100).toFixed(1)}% | Confidence: ${signal.confidence}%\n\n`;
      executed++;
    }
  }

  text += `\n\u{2705} ${executed} strategies created from NOAA signals.\nUse /strategies to view, /cancelall to abort.`;
  await ctx.reply(text, { parse_mode: 'Markdown' });
});

// ────────────────────────────────────────────────────────────────
// TRADING COMMANDS
// ────────────────────────────────────────────────────────────────

/**
 * /buy <tokenId> <price> <size> - Place a limit BUY order
 */
bot.command('buy', async (ctx) => {
  if (!trader.isReady()) {
    return ctx.reply('\u{26A0}\uFE0F Trading is not enabled. Set PRIVATE_KEY in .env to activate.');
  }

  const args = ctx.message.text.split(' ').slice(1);
  if (args.length < 3) {
    return ctx.reply(
      '\u{1F4B0} *Buy Order*\n\n' +
      'Usage: /buy <tokenId> <price> <size>\n\n' +
      'Example: /buy 1234567890... 0.45 100\n\n' +
      'Parameters:\n' +
      '\u{2022} tokenId - Market token ID (from /markets)\n' +
      '\u{2022} price - Limit price (0.01-0.99)\n' +
      '\u{2022} size - Number of shares\n\n' +
      'For market order: /marketbuy <tokenId> <amount> <maxPrice>'
    );
  }

  const [tokenId, priceStr, sizeStr] = args;
  const price = parseFloat(priceStr);
  const size = parseFloat(sizeStr);

  if (isNaN(price) || price <= 0 || price >= 1) {
    return ctx.reply('\u{274C} Invalid price. Must be between 0.01 and 0.99.');
  }
  if (isNaN(size) || size <= 0) {
    return ctx.reply('\u{274C} Invalid size. Must be a positive number.');
  }

  await ctx.reply(`\u{23F3} Placing BUY order: ${size} shares @ $${price}...`);

  const tickSize = await trader.getTickSize(tokenId);
  const negRisk = await trader.getNegRisk(tokenId);
  const result = await trader.placeBuyOrder(tokenId, price, size, { tickSize, negRisk });

  if (result.success) {
    const chatId = ctx.chat.id.toString();
    strategy.recordPosition(chatId, {
      tokenId,
      marketQuestion: `Token: ${tokenId.slice(0, 10)}...`,
      entryPrice: price,
      size,
      orderId: result.orderId,
    });

    await ctx.reply(
      `\u{2705} BUY Order Placed!\n\n` +
      `Order ID: ${result.orderId}\n` +
      `Status: ${result.status}\n` +
      `Price: $${price}\n` +
      `Size: ${size} shares\n` +
      `Total: $${(price * size).toFixed(2)}`
    );
  } else {
    await ctx.reply(`\u{274C} Buy order failed: ${result.error}`);
  }
});

/**
 * /sell <tokenId> <price> <size> - Place a limit SELL order
 */
bot.command('sell', async (ctx) => {
  if (!trader.isReady()) {
    return ctx.reply('\u{26A0}\uFE0F Trading is not enabled. Set PRIVATE_KEY in .env to activate.');
  }

  const args = ctx.message.text.split(' ').slice(1);
  if (args.length < 3) {
    return ctx.reply(
      '\u{1F4B8} *Sell Order*\n\n' +
      'Usage: /sell <tokenId> <price> <size>\n\n' +
      'Example: /sell 1234567890... 0.65 100\n\n' +
      'Parameters:\n' +
      '\u{2022} tokenId - Market token ID\n' +
      '\u{2022} price - Limit price (0.01-0.99)\n' +
      '\u{2022} size - Number of shares to sell\n\n' +
      'For market order: /marketsell <tokenId> <shares> <minPrice>'
    );
  }

  const [tokenId, priceStr, sizeStr] = args;
  const price = parseFloat(priceStr);
  const size = parseFloat(sizeStr);

  if (isNaN(price) || price <= 0 || price >= 1) {
    return ctx.reply('\u{274C} Invalid price. Must be between 0.01 and 0.99.');
  }
  if (isNaN(size) || size <= 0) {
    return ctx.reply('\u{274C} Invalid size. Must be a positive number.');
  }

  await ctx.reply(`\u{23F3} Placing SELL order: ${size} shares @ $${price}...`);

  const tickSize = await trader.getTickSize(tokenId);
  const negRisk = await trader.getNegRisk(tokenId);
  const result = await trader.placeSellOrder(tokenId, price, size, { tickSize, negRisk });

  if (result.success) {
    await ctx.reply(
      `\u{2705} SELL Order Placed!\n\n` +
      `Order ID: ${result.orderId}\n` +
      `Status: ${result.status}\n` +
      `Price: $${price}\n` +
      `Size: ${size} shares\n` +
      `Expected: $${(price * size).toFixed(2)}`
    );
  } else {
    await ctx.reply(`\u{274C} Sell order failed: ${result.error}`);
  }
});

/**
 * /marketbuy <tokenId> <amount> <maxPrice> - Instant market buy (FOK)
 */
bot.command('marketbuy', async (ctx) => {
  if (!trader.isReady()) {
    return ctx.reply('\u{26A0}\uFE0F Trading is not enabled.');
  }

  const args = ctx.message.text.split(' ').slice(1);
  if (args.length < 3) {
    return ctx.reply('Usage: /marketbuy <tokenId> <dollarAmount> <maxPrice>');
  }

  const [tokenId, amountStr, maxPriceStr] = args;
  const amount = parseFloat(amountStr);
  const maxPrice = parseFloat(maxPriceStr);

  if (isNaN(amount) || amount <= 0) return ctx.reply('\u{274C} Invalid amount.');
  if (isNaN(maxPrice) || maxPrice <= 0 || maxPrice >= 1) return ctx.reply('\u{274C} Invalid max price.');

  await ctx.reply(`\u{26A1} Executing MARKET BUY: $${amount} (max price: ${maxPrice})...`);

  const tickSize = await trader.getTickSize(tokenId);
  const negRisk = await trader.getNegRisk(tokenId);
  const result = await trader.marketBuy(tokenId, amount, maxPrice, { tickSize, negRisk });

  if (result.success) {
    await ctx.reply(`\u{2705} Market BUY executed!\nOrder ID: ${result.orderId}\nStatus: ${result.status}`);
  } else {
    await ctx.reply(`\u{274C} Market buy failed: ${result.error}`);
  }
});

/**
 * /marketsell <tokenId> <shares> <minPrice> - Instant market sell (FOK)
 */
bot.command('marketsell', async (ctx) => {
  if (!trader.isReady()) {
    return ctx.reply('\u{26A0}\uFE0F Trading is not enabled.');
  }

  const args = ctx.message.text.split(' ').slice(1);
  if (args.length < 3) {
    return ctx.reply('Usage: /marketsell <tokenId> <shares> <minPrice>');
  }

  const [tokenId, sharesStr, minPriceStr] = args;
  const shares = parseFloat(sharesStr);
  const minPrice = parseFloat(minPriceStr);

  if (isNaN(shares) || shares <= 0) return ctx.reply('\u{274C} Invalid shares.');
  if (isNaN(minPrice) || minPrice <= 0 || minPrice >= 1) return ctx.reply('\u{274C} Invalid min price.');

  await ctx.reply(`\u{26A1} Executing MARKET SELL: ${shares} shares (min price: ${minPrice})...`);

  const tickSize = await trader.getTickSize(tokenId);
  const negRisk = await trader.getNegRisk(tokenId);
  const result = await trader.marketSell(tokenId, shares, minPrice, { tickSize, negRisk });

  if (result.success) {
    await ctx.reply(`\u{2705} Market SELL executed!\nOrder ID: ${result.orderId}\nStatus: ${result.status}`);
  } else {
    await ctx.reply(`\u{274C} Market sell failed: ${result.error}`);
  }
});

/**
 * /autobuy <tokenId> <targetPrice> <size> - Auto-buy when price drops to target
 */
bot.command('autobuy', async (ctx) => {
  if (!trader.isReady()) {
    return ctx.reply('\u{26A0}\uFE0F Trading is not enabled.');
  }

  const args = ctx.message.text.split(' ').slice(1);
  if (args.length < 3) {
    return ctx.reply(
      '\u{1F916} *Auto-Buy Strategy*\n\n' +
      'Automatically buys when price drops to your target.\n\n' +
      'Usage: /autobuy <tokenId> <targetPrice> <size>\n\n' +
      'Example: /autobuy 1234... 0.30 200\n' +
      '(Buy 200 shares when price drops to $0.30)'
    );
  }

  const [tokenId, targetStr, sizeStr] = args;
  const targetPrice = parseFloat(targetStr);
  const size = parseFloat(sizeStr);

  if (isNaN(targetPrice) || targetPrice <= 0 || targetPrice >= 1) {
    return ctx.reply('\u{274C} Invalid target price.');
  }
  if (isNaN(size) || size <= 0) return ctx.reply('\u{274C} Invalid size.');

  const chatId = ctx.chat.id.toString();
  const s = strategy.createAutoBuy(chatId, {
    tokenId,
    marketQuestion: `Token ${tokenId.slice(0, 12)}...`,
    targetPrice,
    size,
  });

  await ctx.reply(
    `\u{2705} Auto-BUY strategy active!\n\n` +
    `ID: ${s.id}\n` +
    `Will buy ${size} shares when price \u{2264} $${targetPrice}\n` +
    `Monitoring every ${config.trading.strategyCheckSeconds}s\n\n` +
    `Use /strategies to view active strategies\n` +
    `Use /cancelstrategy ${s.id} to cancel`
  );
});

/**
 * /autosell <tokenId> <targetPrice> <size> - Auto-sell when price rises to target
 */
bot.command('autosell', async (ctx) => {
  if (!trader.isReady()) {
    return ctx.reply('\u{26A0}\uFE0F Trading is not enabled.');
  }

  const args = ctx.message.text.split(' ').slice(1);
  if (args.length < 3) {
    return ctx.reply(
      '\u{1F916} *Auto-Sell Strategy*\n\n' +
      'Automatically sells when price rises to your target.\n\n' +
      'Usage: /autosell <tokenId> <targetPrice> <size>\n\n' +
      'Example: /autosell 1234... 0.75 200\n' +
      '(Sell 200 shares when price rises to $0.75)'
    );
  }

  const [tokenId, targetStr, sizeStr] = args;
  const targetPrice = parseFloat(targetStr);
  const size = parseFloat(sizeStr);

  if (isNaN(targetPrice) || targetPrice <= 0 || targetPrice >= 1) {
    return ctx.reply('\u{274C} Invalid target price.');
  }
  if (isNaN(size) || size <= 0) return ctx.reply('\u{274C} Invalid size.');

  const chatId = ctx.chat.id.toString();
  const s = strategy.createAutoSell(chatId, {
    tokenId,
    marketQuestion: `Token ${tokenId.slice(0, 12)}...`,
    targetPrice,
    size,
  });

  await ctx.reply(
    `\u{2705} Auto-SELL strategy active!\n\n` +
    `ID: ${s.id}\n` +
    `Will sell ${size} shares when price \u{2265} $${targetPrice}\n\n` +
    `Use /cancelstrategy ${s.id} to cancel`
  );
});

/**
 * /stoploss <tokenId> <stopPrice> <size> - Set stop-loss
 */
bot.command('stoploss', async (ctx) => {
  if (!trader.isReady()) {
    return ctx.reply('\u{26A0}\uFE0F Trading is not enabled.');
  }

  const args = ctx.message.text.split(' ').slice(1);
  if (args.length < 3) {
    return ctx.reply(
      '\u{1F6D1} *Stop-Loss Strategy*\n\n' +
      'Automatically sells when price drops to stop level.\n\n' +
      'Usage: /stoploss <tokenId> <stopPrice> <size>\n\n' +
      'Example: /stoploss 1234... 0.20 100\n' +
      '(Market sell 100 shares if price drops to $0.20)'
    );
  }

  const [tokenId, stopStr, sizeStr] = args;
  const stopPrice = parseFloat(stopStr);
  const size = parseFloat(sizeStr);

  if (isNaN(stopPrice) || stopPrice <= 0 || stopPrice >= 1) return ctx.reply('\u{274C} Invalid stop price.');
  if (isNaN(size) || size <= 0) return ctx.reply('\u{274C} Invalid size.');

  const chatId = ctx.chat.id.toString();
  const s = strategy.createStopLoss(chatId, {
    tokenId,
    marketQuestion: `Token ${tokenId.slice(0, 12)}...`,
    stopPrice,
    size,
  });

  await ctx.reply(
    `\u{2705} Stop-Loss active!\n\n` +
    `ID: ${s.id}\n` +
    `Will market-sell ${size} shares if price \u{2264} $${stopPrice}\n\n` +
    `Use /cancelstrategy ${s.id} to cancel`
  );
});

/**
 * /takeprofit <tokenId> <profitPrice> <size> - Set take-profit
 */
bot.command('takeprofit', async (ctx) => {
  if (!trader.isReady()) {
    return ctx.reply('\u{26A0}\uFE0F Trading is not enabled.');
  }

  const args = ctx.message.text.split(' ').slice(1);
  if (args.length < 3) {
    return ctx.reply(
      '\u{1F3AF} *Take-Profit Strategy*\n\n' +
      'Automatically sells when price reaches profit target.\n\n' +
      'Usage: /takeprofit <tokenId> <profitPrice> <size>\n\n' +
      'Example: /takeprofit 1234... 0.80 100'
    );
  }

  const [tokenId, profitStr, sizeStr] = args;
  const profitPrice = parseFloat(profitStr);
  const size = parseFloat(sizeStr);

  if (isNaN(profitPrice) || profitPrice <= 0 || profitPrice >= 1) return ctx.reply('\u{274C} Invalid profit price.');
  if (isNaN(size) || size <= 0) return ctx.reply('\u{274C} Invalid size.');

  const chatId = ctx.chat.id.toString();
  const s = strategy.createTakeProfit(chatId, {
    tokenId,
    marketQuestion: `Token ${tokenId.slice(0, 12)}...`,
    profitPrice,
    size,
  });

  await ctx.reply(
    `\u{2705} Take-Profit active!\n\n` +
    `ID: ${s.id}\n` +
    `Will sell ${size} shares when price \u{2265} $${profitPrice}\n\n` +
    `Use /cancelstrategy ${s.id} to cancel`
  );
});

/**
 * /trailstop <tokenId> <trailPercent> <size> - Trailing stop
 */
bot.command('trailstop', async (ctx) => {
  if (!trader.isReady()) {
    return ctx.reply('\u{26A0}\uFE0F Trading is not enabled.');
  }

  const args = ctx.message.text.split(' ').slice(1);
  if (args.length < 3) {
    return ctx.reply(
      '\u{1F4C9} *Trailing Stop*\n\n' +
      'Dynamic stop-loss that follows price upward.\n\n' +
      'Usage: /trailstop <tokenId> <trailPercent> <size>\n\n' +
      'Example: /trailstop 1234... 10 100\n' +
      '(Sell if price drops 10% from its high)'
    );
  }

  const [tokenId, trailStr, sizeStr] = args;
  const trailPercent = parseFloat(trailStr) / 100; // Convert 10 -> 0.10
  const size = parseFloat(sizeStr);

  if (isNaN(trailPercent) || trailPercent <= 0 || trailPercent >= 1) return ctx.reply('\u{274C} Invalid trail percent (1-99).');
  if (isNaN(size) || size <= 0) return ctx.reply('\u{274C} Invalid size.');

  const chatId = ctx.chat.id.toString();
  const s = strategy.createTrailingStop(chatId, {
    tokenId,
    marketQuestion: `Token ${tokenId.slice(0, 12)}...`,
    trailPercent,
    size,
  });

  await ctx.reply(
    `\u{2705} Trailing Stop active!\n\n` +
    `ID: ${s.id}\n` +
    `Trail: ${(trailPercent * 100).toFixed(0)}% below high\n` +
    `Size: ${size} shares\n\n` +
    `Use /cancelstrategy ${s.id} to cancel`
  );
});

/**
 * /strategies - View active strategies
 */
bot.command('strategies', async (ctx) => {
  const chatId = ctx.chat.id.toString();
  const userStrategies = strategy.getStrategies(chatId);

  if (userStrategies.length === 0) {
    return ctx.reply('\u{1F4CB} No active strategies.\n\nUse /autobuy, /autosell, /stoploss, /takeprofit, or /trailstop to create one.');
  }

  let text = '\u{1F916} *Active Strategies*\n\n';
  for (const s of userStrategies) {
    text += `\u{2022} [${s.type}] ID: \`${s.id}\`\n`;
    text += `  Token: ${s.tokenId.slice(0, 12)}...\n`;
    if (s.targetPrice) text += `  Target: $${s.targetPrice}\n`;
    if (s.stopPrice) text += `  Stop: $${s.stopPrice}\n`;
    if (s.profitPrice) text += `  Profit: $${s.profitPrice}\n`;
    if (s.trailPercent) text += `  Trail: ${(s.trailPercent * 100).toFixed(0)}%\n`;
    text += `  Size: ${s.size} shares\n\n`;
  }

  text += `\nCancel with: /cancelstrategy <id>\nCancel all: /cancelall`;
  await ctx.reply(text, { parse_mode: 'Markdown' });
});

/**
 * /cancelstrategy <id> - Cancel a specific strategy
 */
bot.command('cancelstrategy', async (ctx) => {
  const args = ctx.message.text.split(' ').slice(1);
  if (args.length === 0) return ctx.reply('Usage: /cancelstrategy <strategyId>');

  const chatId = ctx.chat.id.toString();
  const success = strategy.cancelStrategy(chatId, args[0]);

  if (success) {
    await ctx.reply(`\u{2705} Strategy ${args[0]} cancelled.`);
  } else {
    await ctx.reply('\u{274C} Strategy not found or already inactive.');
  }
});

/**
 * /cancelall - Cancel all strategies and orders
 */
bot.command('cancelall', async (ctx) => {
  const chatId = ctx.chat.id.toString();
  const count = strategy.cancelAllStrategies(chatId);

  let msg = `\u{2705} ${count} strategies cancelled.`;

  if (trader.isReady()) {
    const orderResult = await trader.cancelAllOrders();
    if (orderResult.success) {
      msg += `\n\u{2705} ${orderResult.canceled?.length || 0} open orders cancelled.`;
    }
  }

  await ctx.reply(msg);
});

/**
 * /positions - View open positions
 */
bot.command('positions', async (ctx) => {
  const chatId = ctx.chat.id.toString();
  const userPositions = strategy.getPositions(chatId);

  if (userPositions.length === 0) {
    return ctx.reply('\u{1F4CB} No open positions.\n\nPositions are recorded when auto-buy executes or you use /buy.');
  }

  let text = '\u{1F4CA} *Open Positions*\n\n';
  for (const p of userPositions) {
    text += `\u{2022} ${p.marketQuestion}\n`;
    text += `  Entry: $${p.entryPrice} | Size: ${p.size}\n`;
    text += `  Opened: ${new Date(p.openedAt).toLocaleDateString()}\n\n`;
  }

  await ctx.reply(text, { parse_mode: 'Markdown' });
});

/**
 * /balance - Check wallet balance
 */
bot.command('balance', async (ctx) => {
  if (!trader.isReady()) {
    return ctx.reply('\u{26A0}\uFE0F Trading is not enabled. Set PRIVATE_KEY in .env.');
  }

  await ctx.reply('\u{1F4B0} Checking balance...');

  const bal = await trader.getBalance();
  const balNum = parseFloat(bal.balance) / 1e6; // pUSD has 6 decimals

  await ctx.reply(
    `\u{1F4B0} *Wallet Balance*\n\n` +
    `pUSD: $${balNum.toFixed(2)}\n` +
    `Allowance: ${bal.allowance}\n\n` +
    `_Balance reflects pUSD in your funder wallet_`,
    { parse_mode: 'Markdown' }
  );
});

/**
 * /orders - View open orders
 */
bot.command('orders', async (ctx) => {
  if (!trader.isReady()) {
    return ctx.reply('\u{26A0}\uFE0F Trading is not enabled.');
  }

  const orders = await trader.getOpenOrders();

  if (!orders || orders.length === 0) {
    return ctx.reply('\u{1F4CB} No open orders.');
  }

  let text = `\u{1F4CB} *Open Orders (${orders.length})*\n\n`;
  for (const o of orders.slice(0, 10)) {
    text += `\u{2022} ${o.side} @ $${o.price} | ${o.size_matched}/${o.original_size} filled\n`;
    text += `  ID: \`${o.id.slice(0, 16)}...\`\n\n`;
  }

  if (orders.length > 10) {
    text += `_...and ${orders.length - 10} more_`;
  }

  await ctx.reply(text, { parse_mode: 'Markdown' });
});

/**
 * /cancelorder <orderId> - Cancel specific order
 */
bot.command('cancelorder', async (ctx) => {
  if (!trader.isReady()) {
    return ctx.reply('\u{26A0}\uFE0F Trading is not enabled.');
  }

  const args = ctx.message.text.split(' ').slice(1);
  if (args.length === 0) return ctx.reply('Usage: /cancelorder <orderId>');

  const result = await trader.cancelOrder(args[0]);
  if (result.success) {
    await ctx.reply(`\u{2705} Order cancelled.`);
  } else {
    await ctx.reply(`\u{274C} Cancel failed: ${result.error}`);
  }
});

/**
 * /tradestatus - Trading system status
 */
bot.command('tradestatus', async (ctx) => {
  const stats = strategy.getStats();
  const tradingReady = trader.isReady();

  let text = `\u{1F916} *Trading System Status*\n\n`;
  text += `Trading Engine: ${tradingReady ? '\u{2705} Active' : '\u{274C} Disabled'}\n`;
  text += `Active Strategies: ${stats.activeCount}\n`;
  text += `Executed Strategies: ${stats.executedCount}\n`;
  text += `Open Positions: ${stats.openPositions}\n`;
  text += `Check Interval: ${config.trading.strategyCheckSeconds}s\n`;

  await ctx.reply(text, { parse_mode: 'Markdown' });
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

    // Initialize trading engine if configured
    if (config.trading.privateKey) {
      const tradingReady = await trader.initialize();
      if (tradingReady) {
        // Start strategy monitoring loop
        const notifyCallback = async (chatId, message) => {
          try {
            await bot.telegram.sendMessage(chatId, message, { parse_mode: 'Markdown' });
          } catch (e) {
            logger.error(`Failed to send trade notification to ${chatId}:`, e.message);
          }
        };
        strategy.startMonitoring(notifyCallback, config.trading.strategyCheckSeconds);
        logger.info('\u{2705} Auto-trading engine active');
      }
    } else {
      logger.info('Trading disabled (no PRIVATE_KEY configured)');
    }

    // Notify admin if configured
    if (config.telegram.adminChatId) {
      try {
        await bot.telegram.sendMessage(
          config.telegram.adminChatId,
          '\u{2705} Bot started successfully!' + (trader.isReady() ? ' Trading: ON' : ' Trading: OFF')
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
    strategy.stopMonitoring();
    bot.stop(signal);
    process.exit(0);
  };

  process.once('SIGINT', () => shutdown('SIGINT'));
  process.once('SIGTERM', () => shutdown('SIGTERM'));
}

module.exports = { startBot, setupGracefulShutdown, bot };
