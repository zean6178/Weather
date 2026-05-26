'use strict';

/**
 * Auto-Compound Manager
 *
 * Implements a 50% compounding strategy:
 * - Always trade with 50% of current available balance
 * - As profits grow, trade sizes scale automatically
 *
 * Examples (starting with $10):
 *   Balance $10   → Trade size $5
 *   Balance $20   → Trade size $10
 *   Balance $1000 → Trade size $500
 *   Balance $10000→ Trade size $5000
 *
 * Features:
 * - Configurable compound ratio (default 50%)
 * - Min/max trade size safety guards
 * - Balance tracking with profit history
 * - Per-user compound settings
 * - Integration with strategy engine for dynamic sizing
 */

const logger = require('./logger');
const trader = require('./trader');

// Per-user compound configurations
const compoundConfigs = new Map();

// Default settings
const DEFAULTS = {
  enabled: false,
  ratio: 0.5,           // 50% of balance for each trade
  minTradeSize: 5,      // Minimum $5 trade
  maxTradeSize: 10000,  // Maximum $10,000 per trade
  initialBalance: 10,   // Starting balance tracker
  currentBalance: 10,   // Current tracked balance
  totalProfit: 0,       // Cumulative profit
  tradeCount: 0,        // Number of compound trades executed
  winCount: 0,          // Winning trades
  lossCount: 0,         // Losing trades
  history: [],          // Trade history [{size, result, balanceBefore, balanceAfter, timestamp}]
};

/**
 * Enable compound mode for a user
 */
function enable(chatId, options = {}) {
  const config = {
    ...DEFAULTS,
    enabled: true,
    ratio: options.ratio || DEFAULTS.ratio,
    minTradeSize: options.minTradeSize || DEFAULTS.minTradeSize,
    maxTradeSize: options.maxTradeSize || DEFAULTS.maxTradeSize,
    initialBalance: options.initialBalance || DEFAULTS.initialBalance,
    currentBalance: options.initialBalance || DEFAULTS.initialBalance,
    enabledAt: new Date().toISOString(),
  };

  compoundConfigs.set(chatId, config);
  logger.info(`Compound enabled for ${chatId}: ratio=${config.ratio}, initial=$${config.initialBalance}`);
  return config;
}

/**
 * Disable compound mode for a user
 */
function disable(chatId) {
  const config = compoundConfigs.get(chatId);
  if (config) {
    config.enabled = false;
    logger.info(`Compound disabled for ${chatId}`);
  }
  return config;
}

/**
 * Check if compound is enabled for a user
 */
function isEnabled(chatId) {
  const config = compoundConfigs.get(chatId);
  return config?.enabled || false;
}

/**
 * Get compound config for a user
 */
function getConfig(chatId) {
  return compoundConfigs.get(chatId) || null;
}

/**
 * Calculate the next trade size based on current balance and compound ratio
 * This is the core logic: trade_size = balance * ratio
 *
 * @param {string} chatId - User chat ID
 * @returns {number} Trade size in dollars (or shares at price $1)
 */
function calculateTradeSize(chatId) {
  const config = compoundConfigs.get(chatId);
  if (!config || !config.enabled) return 0;

  // Calculate: 50% of current balance
  let tradeSize = config.currentBalance * config.ratio;

  // Apply safety guards
  tradeSize = Math.max(tradeSize, config.minTradeSize);
  tradeSize = Math.min(tradeSize, config.maxTradeSize);

  // Round to 2 decimal places
  tradeSize = Math.round(tradeSize * 100) / 100;

  logger.debug(`Compound calc for ${chatId}: balance=$${config.currentBalance}, ratio=${config.ratio}, size=$${tradeSize}`);
  return tradeSize;
}

/**
 * Calculate trade size in shares given a price
 * shares = tradeSize / price
 *
 * @param {string} chatId - User chat ID
 * @param {number} price - Price per share (0.01 - 0.99)
 * @returns {number} Number of shares to buy
 */
function calculateShares(chatId, price) {
  if (!price || price <= 0 || price >= 1) return 0;

  const tradeSize = calculateTradeSize(chatId);
  if (tradeSize <= 0) return 0;

  const shares = Math.floor(tradeSize / price);
  return Math.max(shares, 1); // At least 1 share
}

/**
 * Record a trade result and update balance
 *
 * @param {string} chatId - User chat ID
 * @param {object} result - Trade result
 * @param {number} result.invested - Amount invested (cost)
 * @param {number} result.returned - Amount returned (0 if loss, payout if win)
 * @param {boolean} result.won - Whether the trade was profitable
 */
function recordTradeResult(chatId, { invested, returned, won }) {
  const config = compoundConfigs.get(chatId);
  if (!config) return;

  const balanceBefore = config.currentBalance;
  const pnl = returned - invested;

  // Update balance
  config.currentBalance = balanceBefore + pnl;
  config.totalProfit += pnl;
  config.tradeCount++;

  if (won) {
    config.winCount++;
  } else {
    config.lossCount++;
  }

  // Record in history (keep last 50)
  config.history.push({
    size: invested,
    pnl,
    won,
    balanceBefore,
    balanceAfter: config.currentBalance,
    timestamp: new Date().toISOString(),
  });

  if (config.history.length > 50) {
    config.history.shift();
  }

  logger.info(
    `Compound trade recorded for ${chatId}: ` +
    `invested=$${invested.toFixed(2)}, pnl=${pnl >= 0 ? '+' : ''}$${pnl.toFixed(2)}, ` +
    `balance: $${balanceBefore.toFixed(2)} → $${config.currentBalance.toFixed(2)}`
  );

  return config;
}

/**
 * Manually update balance (e.g., after checking on-chain balance)
 */
function updateBalance(chatId, newBalance) {
  const config = compoundConfigs.get(chatId);
  if (!config) return null;

  const oldBalance = config.currentBalance;
  config.currentBalance = newBalance;
  logger.info(`Compound balance updated for ${chatId}: $${oldBalance.toFixed(2)} → $${newBalance.toFixed(2)}`);
  return config;
}

/**
 * Sync balance from on-chain wallet
 */
async function syncBalance(chatId) {
  if (!trader.isReady()) return null;

  const config = compoundConfigs.get(chatId);
  if (!config) return null;

  try {
    const bal = await trader.getBalance();
    const balanceUsd = parseFloat(bal.balance) / 1e6; // pUSD has 6 decimals

    if (balanceUsd > 0) {
      config.currentBalance = balanceUsd;
      logger.info(`Compound balance synced for ${chatId}: $${balanceUsd.toFixed(2)}`);
    }
    return config;
  } catch (error) {
    logger.error(`Compound balance sync failed for ${chatId}: ${error.message}`);
    return config;
  }
}

/**
 * Get a formatted summary of compound status
 */
function getSummary(chatId) {
  const config = compoundConfigs.get(chatId);
  if (!config) {
    return null;
  }

  const nextTradeSize = calculateTradeSize(chatId);
  const growthPercent = config.initialBalance > 0
    ? ((config.currentBalance / config.initialBalance - 1) * 100).toFixed(1)
    : '0.0';
  const winRate = config.tradeCount > 0
    ? ((config.winCount / config.tradeCount) * 100).toFixed(0)
    : '0';

  return {
    enabled: config.enabled,
    ratio: config.ratio,
    initialBalance: config.initialBalance,
    currentBalance: config.currentBalance,
    totalProfit: config.totalProfit,
    growthPercent,
    nextTradeSize,
    tradeCount: config.tradeCount,
    winCount: config.winCount,
    lossCount: config.lossCount,
    winRate,
    minTradeSize: config.minTradeSize,
    maxTradeSize: config.maxTradeSize,
    enabledAt: config.enabledAt,
    recentHistory: config.history.slice(-5),
  };
}

/**
 * Format compound summary for Telegram display
 */
function formatSummary(chatId) {
  const summary = getSummary(chatId);
  if (!summary) {
    return (
      '\u{1F4B0} *Auto-Compound*\n\n' +
      '_Not configured._\n\n' +
      'Use /compound <initial_balance> to start.\n' +
      'Example: /compound 10\n' +
      '(Start with $10, trade 50% each time)'
    );
  }

  let text = `\u{1F4B0} *Auto-Compound Status*\n`;
  text += `\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\n\n`;
  text += `Status: ${summary.enabled ? '\u{2705} Active' : '\u{274C} Disabled'}\n`;
  text += `Ratio: ${(summary.ratio * 100).toFixed(0)}% of balance per trade\n\n`;

  text += `\u{1F4CA} *Balance*\n`;
  text += `Initial: $${summary.initialBalance.toFixed(2)}\n`;
  text += `Current: $${summary.currentBalance.toFixed(2)}\n`;
  text += `Growth: ${summary.growthPercent}%\n`;
  text += `Total P&L: ${summary.totalProfit >= 0 ? '+' : ''}$${summary.totalProfit.toFixed(2)}\n\n`;

  text += `\u{1F3AF} *Next Trade*\n`;
  text += `Size: $${summary.nextTradeSize.toFixed(2)}\n`;
  text += `(${(summary.ratio * 100).toFixed(0)}% of $${summary.currentBalance.toFixed(2)})\n\n`;

  text += `\u{1F4CB} *Stats*\n`;
  text += `Trades: ${summary.tradeCount}\n`;
  text += `Win Rate: ${summary.winRate}% (${summary.winCount}W / ${summary.lossCount}L)\n`;
  text += `Min Size: $${summary.minTradeSize} | Max: $${summary.maxTradeSize}\n`;

  // Show scaling examples
  text += `\n\u{1F4C8} *Compound Scale:*\n`;
  const examples = [10, 20, 100, 1000, 10000];
  for (const bal of examples) {
    const size = Math.min(Math.max(bal * summary.ratio, summary.minTradeSize), summary.maxTradeSize);
    const marker = Math.abs(bal - summary.currentBalance) < 1 ? ' \u{25C0} you' : '';
    text += `  $${bal.toLocaleString()} → trade $${size.toLocaleString()}${marker}\n`;
  }

  if (summary.recentHistory.length > 0) {
    text += `\n\u{1F4DC} *Recent:*\n`;
    for (const h of summary.recentHistory) {
      const emoji = h.won ? '\u{2705}' : '\u{274C}';
      text += `  ${emoji} $${h.size.toFixed(2)} → ${h.pnl >= 0 ? '+' : ''}$${h.pnl.toFixed(2)} (bal: $${h.balanceAfter.toFixed(2)})\n`;
    }
  }

  return text;
}

module.exports = {
  enable,
  disable,
  isEnabled,
  getConfig,
  calculateTradeSize,
  calculateShares,
  recordTradeResult,
  updateBalance,
  syncBalance,
  getSummary,
  formatSummary,
};
