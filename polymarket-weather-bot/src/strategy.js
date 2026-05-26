'use strict';

/**
 * Auto-Trading Strategy Engine
 * 
 * Manages automated buy/sell strategies for Polymarket weather markets.
 * Supports:
 * - Auto-buy when price drops below threshold (value entry)
 * - Auto-sell when price rises above threshold (take profit)
 * - Stop-loss: auto-sell when price drops below stop level
 * - Trailing stop: dynamic stop-loss that follows price up
 * - Periodic position monitoring with cron
 */

const cron = require('node-cron');
const trader = require('./trader');
const polymarket = require('./polymarket');
const logger = require('./logger');
const config = require('./config');
const compound = require('./compound');

// Active strategies per user (chatId -> strategy[])
const activeStrategies = new Map();

// Position tracker (chatId -> positions[])
const positions = new Map();

// Strategy types
const STRATEGY_TYPE = {
  AUTO_BUY: 'AUTO_BUY',       // Buy when price <= target
  AUTO_SELL: 'AUTO_SELL',     // Sell when price >= target
  STOP_LOSS: 'STOP_LOSS',    // Sell when price <= stop level
  TRAILING_STOP: 'TRAILING_STOP', // Dynamic stop-loss
  TAKE_PROFIT: 'TAKE_PROFIT', // Sell at profit target
};

/**
 * Create a new auto-buy strategy
 */
function createAutoBuy(chatId, { tokenId, marketQuestion, targetPrice, size, tickSize, negRisk }) {
  const strategy = {
    id: generateId(),
    type: STRATEGY_TYPE.AUTO_BUY,
    chatId,
    tokenId,
    marketQuestion,
    targetPrice: parseFloat(targetPrice),
    size: parseFloat(size),
    tickSize: tickSize || '0.01',
    negRisk: negRisk || false,
    status: 'ACTIVE',
    createdAt: new Date().toISOString(),
    executedAt: null,
    orderId: null,
    fills: [],
  };

  addStrategy(chatId, strategy);
  logger.info(`Auto-BUY strategy created: ${strategy.id} for chat ${chatId}`);
  return strategy;
}

/**
 * Create a new auto-sell strategy
 */
function createAutoSell(chatId, { tokenId, marketQuestion, targetPrice, size, tickSize, negRisk }) {
  const strategy = {
    id: generateId(),
    type: STRATEGY_TYPE.AUTO_SELL,
    chatId,
    tokenId,
    marketQuestion,
    targetPrice: parseFloat(targetPrice),
    size: parseFloat(size),
    tickSize: tickSize || '0.01',
    negRisk: negRisk || false,
    status: 'ACTIVE',
    createdAt: new Date().toISOString(),
    executedAt: null,
    orderId: null,
    fills: [],
  };

  addStrategy(chatId, strategy);
  logger.info(`Auto-SELL strategy created: ${strategy.id} for chat ${chatId}`);
  return strategy;
}

/**
 * Create a stop-loss strategy
 */
function createStopLoss(chatId, { tokenId, marketQuestion, stopPrice, size, tickSize, negRisk }) {
  const strategy = {
    id: generateId(),
    type: STRATEGY_TYPE.STOP_LOSS,
    chatId,
    tokenId,
    marketQuestion,
    stopPrice: parseFloat(stopPrice),
    size: parseFloat(size),
    tickSize: tickSize || '0.01',
    negRisk: negRisk || false,
    status: 'ACTIVE',
    createdAt: new Date().toISOString(),
    executedAt: null,
    orderId: null,
  };

  addStrategy(chatId, strategy);
  logger.info(`STOP-LOSS strategy created: ${strategy.id} for chat ${chatId}`);
  return strategy;
}

/**
 * Create a take-profit strategy
 */
function createTakeProfit(chatId, { tokenId, marketQuestion, profitPrice, size, tickSize, negRisk }) {
  const strategy = {
    id: generateId(),
    type: STRATEGY_TYPE.TAKE_PROFIT,
    chatId,
    tokenId,
    marketQuestion,
    profitPrice: parseFloat(profitPrice),
    size: parseFloat(size),
    tickSize: tickSize || '0.01',
    negRisk: negRisk || false,
    status: 'ACTIVE',
    createdAt: new Date().toISOString(),
    executedAt: null,
    orderId: null,
  };

  addStrategy(chatId, strategy);
  logger.info(`TAKE-PROFIT strategy created: ${strategy.id} for chat ${chatId}`);
  return strategy;
}

/**
 * Create a trailing-stop strategy
 */
function createTrailingStop(chatId, { tokenId, marketQuestion, trailPercent, size, tickSize, negRisk }) {
  const strategy = {
    id: generateId(),
    type: STRATEGY_TYPE.TRAILING_STOP,
    chatId,
    tokenId,
    marketQuestion,
    trailPercent: parseFloat(trailPercent), // e.g., 0.10 = 10%
    size: parseFloat(size),
    tickSize: tickSize || '0.01',
    negRisk: negRisk || false,
    status: 'ACTIVE',
    highWaterMark: 0,
    currentStopPrice: 0,
    createdAt: new Date().toISOString(),
    executedAt: null,
    orderId: null,
  };

  addStrategy(chatId, strategy);
  logger.info(`TRAILING-STOP strategy created: ${strategy.id} for chat ${chatId}`);
  return strategy;
}

/**
 * Record a position after a successful buy
 */
function recordPosition(chatId, { tokenId, marketQuestion, entryPrice, size, orderId }) {
  if (!positions.has(chatId)) {
    positions.set(chatId, []);
  }

  const position = {
    id: generateId(),
    tokenId,
    marketQuestion,
    entryPrice: parseFloat(entryPrice),
    size: parseFloat(size),
    orderId,
    openedAt: new Date().toISOString(),
    status: 'OPEN',
    pnl: 0,
  };

  positions.get(chatId).push(position);
  logger.info(`Position recorded for chat ${chatId}: ${marketQuestion} @ ${entryPrice}`);
  return position;
}

/**
 * Get all positions for a user
 */
function getPositions(chatId) {
  return (positions.get(chatId) || []).filter((p) => p.status === 'OPEN');
}

/**
 * Close a position
 */
function closePosition(chatId, positionId, exitPrice) {
  const userPositions = positions.get(chatId);
  if (!userPositions) return null;

  const pos = userPositions.find((p) => p.id === positionId);
  if (!pos) return null;

  pos.status = 'CLOSED';
  pos.exitPrice = parseFloat(exitPrice);
  pos.closedAt = new Date().toISOString();
  pos.pnl = (pos.exitPrice - pos.entryPrice) * pos.size;
  
  logger.info(`Position closed for chat ${chatId}: PnL = ${pos.pnl.toFixed(4)}`);
  return pos;
}

/**
 * Get active strategies for a user
 */
function getStrategies(chatId) {
  return (activeStrategies.get(chatId) || []).filter((s) => s.status === 'ACTIVE');
}

/**
 * Get all strategies (for monitoring loop)
 */
function getAllActiveStrategies() {
  const all = [];
  for (const [chatId, strategies] of activeStrategies.entries()) {
    for (const strategy of strategies) {
      if (strategy.status === 'ACTIVE') {
        all.push({ chatId, strategy });
      }
    }
  }
  return all;
}

/**
 * Cancel/remove a strategy
 */
function cancelStrategy(chatId, strategyId) {
  const strategies = activeStrategies.get(chatId);
  if (!strategies) return false;

  const idx = strategies.findIndex((s) => s.id === strategyId);
  if (idx === -1) return false;

  strategies[idx].status = 'CANCELLED';
  logger.info(`Strategy ${strategyId} cancelled for chat ${chatId}`);
  return true;
}

/**
 * Cancel all strategies for a user
 */
function cancelAllStrategies(chatId) {
  const strategies = activeStrategies.get(chatId);
  if (!strategies) return 0;

  let count = 0;
  for (const s of strategies) {
    if (s.status === 'ACTIVE') {
      s.status = 'CANCELLED';
      count++;
    }
  }
  logger.info(`${count} strategies cancelled for chat ${chatId}`);
  return count;
}

/**
 * Execute strategy check loop
 * This is called periodically to evaluate all active strategies
 */
async function evaluateStrategies(notifyCallback) {
  if (!trader.isReady()) return;

  const allStrategies = getAllActiveStrategies();
  if (allStrategies.length === 0) return;

  logger.debug(`Evaluating ${allStrategies.length} active strategies...`);

  for (const { chatId, strategy } of allStrategies) {
    try {
      await evaluateStrategy(chatId, strategy, notifyCallback);
    } catch (error) {
      logger.error(`Strategy evaluation error (${strategy.id}): ${error.message}`);
    }
  }
}

/**
 * Evaluate a single strategy against current market data
 */
async function evaluateStrategy(chatId, strategy, notifyCallback) {
  // Get current price
  const currentPrice = await trader.getPrice(strategy.tokenId, 'BUY');
  if (currentPrice === 0) return; // Skip if price unavailable

  switch (strategy.type) {
    case STRATEGY_TYPE.AUTO_BUY:
      await evaluateAutoBuy(chatId, strategy, currentPrice, notifyCallback);
      break;

    case STRATEGY_TYPE.AUTO_SELL:
      await evaluateAutoSell(chatId, strategy, currentPrice, notifyCallback);
      break;

    case STRATEGY_TYPE.STOP_LOSS:
      await evaluateStopLoss(chatId, strategy, currentPrice, notifyCallback);
      break;

    case STRATEGY_TYPE.TAKE_PROFIT:
      await evaluateTakeProfit(chatId, strategy, currentPrice, notifyCallback);
      break;

    case STRATEGY_TYPE.TRAILING_STOP:
      await evaluateTrailingStop(chatId, strategy, currentPrice, notifyCallback);
      break;
  }
}

/**
 * AUTO_BUY: Execute buy when price <= targetPrice
 */
async function evaluateAutoBuy(chatId, strategy, currentPrice, notify) {
  if (currentPrice <= strategy.targetPrice) {
    logger.info(`AUTO_BUY triggered: ${strategy.tokenId} @ ${currentPrice} <= ${strategy.targetPrice}`);

    // Use compound sizing if enabled, otherwise use strategy's fixed size
    let size = strategy.size;
    if (compound.isEnabled(chatId)) {
      const compoundSize = compound.calculateShares(chatId, strategy.targetPrice);
      if (compoundSize > 0) {
        size = compoundSize;
        logger.info(`Compound sizing: ${size} shares (balance-based) instead of fixed ${strategy.size}`);
      }
    }

    const result = await trader.placeBuyOrder(
      strategy.tokenId,
      strategy.targetPrice,
      size,
      { tickSize: strategy.tickSize, negRisk: strategy.negRisk }
    );

    strategy.status = 'EXECUTED';
    strategy.executedAt = new Date().toISOString();
    strategy.orderId = result.orderId;

    if (result.success) {
      // Record position
      recordPosition(chatId, {
        tokenId: strategy.tokenId,
        marketQuestion: strategy.marketQuestion,
        entryPrice: strategy.targetPrice,
        size,
        orderId: result.orderId,
      });

      // Record compound investment (deduct from balance)
      if (compound.isEnabled(chatId)) {
        const invested = size * strategy.targetPrice;
        compound.recordTradeResult(chatId, { invested, returned: 0, won: false });
        // Note: returned=0 for now; will update when position closes
      }
    }

    if (notify) {
      const compoundNote = compound.isEnabled(chatId) ? ` [COMPOUND: $${(size * strategy.targetPrice).toFixed(2)}]` : '';
      await notify(chatId, formatExecutionMessage('AUTO_BUY', { ...strategy, size }, result, currentPrice) + compoundNote);
    }
  }
}

/**
 * AUTO_SELL: Execute sell when price >= targetPrice
 */
async function evaluateAutoSell(chatId, strategy, currentPrice, notify) {
  // For sell, check the SELL side price (what you'd receive)
  const sellPrice = await trader.getPrice(strategy.tokenId, 'SELL');
  if (sellPrice === 0) return;

  if (sellPrice >= strategy.targetPrice) {
    logger.info(`AUTO_SELL triggered: ${strategy.tokenId} @ ${sellPrice} >= ${strategy.targetPrice}`);

    // Use compound sizing if enabled
    let size = strategy.size;
    if (compound.isEnabled(chatId)) {
      const compoundSize = compound.calculateShares(chatId, strategy.targetPrice);
      if (compoundSize > 0) {
        size = compoundSize;
        logger.info(`Compound sizing (sell): ${size} shares`);
      }
    }

    const result = await trader.placeSellOrder(
      strategy.tokenId,
      strategy.targetPrice,
      size,
      { tickSize: strategy.tickSize, negRisk: strategy.negRisk }
    );

    strategy.status = 'EXECUTED';
    strategy.executedAt = new Date().toISOString();
    strategy.orderId = result.orderId;

    // Record compound profit on sell
    if (result.success && compound.isEnabled(chatId)) {
      const returned = size * strategy.targetPrice;
      compound.recordTradeResult(chatId, { invested: 0, returned, won: true });
    }

    if (notify) {
      const compoundNote = compound.isEnabled(chatId) ? ` [COMPOUND: +$${(size * strategy.targetPrice).toFixed(2)}]` : '';
      await notify(chatId, formatExecutionMessage('AUTO_SELL', { ...strategy, size }, result, sellPrice) + compoundNote);
    }
  }
}

/**
 * STOP_LOSS: Sell when price drops to/below stopPrice
 */
async function evaluateStopLoss(chatId, strategy, currentPrice, notify) {
  const sellPrice = await trader.getPrice(strategy.tokenId, 'SELL');
  if (sellPrice === 0) return;

  if (sellPrice <= strategy.stopPrice) {
    logger.info(`STOP_LOSS triggered: ${strategy.tokenId} @ ${sellPrice} <= ${strategy.stopPrice}`);

    const result = await trader.marketSell(
      strategy.tokenId,
      strategy.size,
      strategy.stopPrice * 0.95, // 5% slippage allowance below stop
      { tickSize: strategy.tickSize, negRisk: strategy.negRisk }
    );

    strategy.status = 'EXECUTED';
    strategy.executedAt = new Date().toISOString();
    strategy.orderId = result.orderId;

    if (notify) {
      await notify(chatId, formatExecutionMessage('STOP_LOSS', strategy, result, sellPrice));
    }
  }
}

/**
 * TAKE_PROFIT: Sell when price rises to/above profitPrice
 */
async function evaluateTakeProfit(chatId, strategy, currentPrice, notify) {
  const sellPrice = await trader.getPrice(strategy.tokenId, 'SELL');
  if (sellPrice === 0) return;

  if (sellPrice >= strategy.profitPrice) {
    logger.info(`TAKE_PROFIT triggered: ${strategy.tokenId} @ ${sellPrice} >= ${strategy.profitPrice}`);

    const result = await trader.placeSellOrder(
      strategy.tokenId,
      strategy.profitPrice,
      strategy.size,
      { tickSize: strategy.tickSize, negRisk: strategy.negRisk }
    );

    strategy.status = 'EXECUTED';
    strategy.executedAt = new Date().toISOString();
    strategy.orderId = result.orderId;

    if (notify) {
      await notify(chatId, formatExecutionMessage('TAKE_PROFIT', strategy, result, sellPrice));
    }
  }
}

/**
 * TRAILING_STOP: Dynamic stop that follows price upward
 */
async function evaluateTrailingStop(chatId, strategy, currentPrice, notify) {
  const sellPrice = await trader.getPrice(strategy.tokenId, 'SELL');
  if (sellPrice === 0) return;

  // Update high water mark
  if (sellPrice > strategy.highWaterMark) {
    strategy.highWaterMark = sellPrice;
    strategy.currentStopPrice = sellPrice * (1 - strategy.trailPercent);
    logger.debug(`Trailing stop updated: HWM=${strategy.highWaterMark}, stop=${strategy.currentStopPrice}`);
  }

  // Check if stop triggered
  if (strategy.highWaterMark > 0 && sellPrice <= strategy.currentStopPrice) {
    logger.info(`TRAILING_STOP triggered: ${strategy.tokenId} @ ${sellPrice} <= ${strategy.currentStopPrice}`);

    const result = await trader.marketSell(
      strategy.tokenId,
      strategy.size,
      strategy.currentStopPrice * 0.95,
      { tickSize: strategy.tickSize, negRisk: strategy.negRisk }
    );

    strategy.status = 'EXECUTED';
    strategy.executedAt = new Date().toISOString();
    strategy.orderId = result.orderId;

    if (notify) {
      await notify(chatId, formatExecutionMessage('TRAILING_STOP', strategy, result, sellPrice));
    }
  }
}

/**
 * Format execution notification message
 */
function formatExecutionMessage(type, strategy, result, triggerPrice) {
  const emoji = result.success ? '\u{2705}' : '\u{274C}';
  const typeEmoji = {
    'AUTO_BUY': '\u{1F4B0}',
    'AUTO_SELL': '\u{1F4B8}',
    'STOP_LOSS': '\u{1F6D1}',
    'TAKE_PROFIT': '\u{1F3AF}',
    'TRAILING_STOP': '\u{1F4C9}',
  };

  let msg = `${emoji} ${typeEmoji[type] || ''} *${type} EXECUTED*\n\n`;
  msg += `Market: ${strategy.marketQuestion || 'Unknown'}\n`;
  msg += `Trigger Price: ${triggerPrice}\n`;
  msg += `Size: ${strategy.size} shares\n`;

  if (result.success) {
    msg += `Order ID: \`${result.orderId}\`\n`;
    msg += `Status: ${result.status}\n`;
  } else {
    msg += `Error: ${result.error}\n`;
  }

  msg += `\nTime: ${new Date().toISOString()}`;
  return msg;
}

/**
 * Start the strategy monitoring loop
 */
let strategyCheckJob = null;

function startMonitoring(notifyCallback, intervalSeconds = 30) {
  if (strategyCheckJob) return;

  // Run every N seconds
  const cronExpr = `*/${Math.max(intervalSeconds, 10)} * * * * *`; // seconds-level with node-cron

  // node-cron doesn't support seconds by default, so use setInterval instead
  const intervalMs = intervalSeconds * 1000;

  strategyCheckJob = setInterval(async () => {
    try {
      await evaluateStrategies(notifyCallback);
    } catch (error) {
      logger.error('Strategy monitoring error:', error.message);
    }
  }, intervalMs);

  logger.info(`Strategy monitoring started (every ${intervalSeconds}s)`);
}

/**
 * Stop the strategy monitoring loop
 */
function stopMonitoring() {
  if (strategyCheckJob) {
    clearInterval(strategyCheckJob);
    strategyCheckJob = null;
    logger.info('Strategy monitoring stopped');
  }
}

/**
 * Get summary stats
 */
function getStats() {
  let totalStrategies = 0;
  let activeCount = 0;
  let executedCount = 0;

  for (const [, strategies] of activeStrategies.entries()) {
    for (const s of strategies) {
      totalStrategies++;
      if (s.status === 'ACTIVE') activeCount++;
      if (s.status === 'EXECUTED') executedCount++;
    }
  }

  let totalPositions = 0;
  let openPositions = 0;
  for (const [, userPositions] of positions.entries()) {
    for (const p of userPositions) {
      totalPositions++;
      if (p.status === 'OPEN') openPositions++;
    }
  }

  return {
    totalStrategies,
    activeCount,
    executedCount,
    totalPositions,
    openPositions,
  };
}

// ── Helpers ──

function addStrategy(chatId, strategy) {
  if (!activeStrategies.has(chatId)) {
    activeStrategies.set(chatId, []);
  }
  activeStrategies.get(chatId).push(strategy);
}

function generateId() {
  return `${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
}

module.exports = {
  STRATEGY_TYPE,
  createAutoBuy,
  createAutoSell,
  createStopLoss,
  createTakeProfit,
  createTrailingStop,
  recordPosition,
  getPositions,
  closePosition,
  getStrategies,
  getAllActiveStrategies,
  cancelStrategy,
  cancelAllStrategies,
  evaluateStrategies,
  startMonitoring,
  stopMonitoring,
  getStats,
};
