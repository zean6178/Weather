'use strict';

/**
 * Daily Loss Limit Risk Manager
 *
 * Prevents trading when daily losses exceed the configured limit.
 * Default: 20% of current balance.
 *
 * Logic:
 * - Tracks all losses per day per user
 * - When cumulative daily loss >= limit → PAUSE trading
 * - Sends notification at 80% warning and 100% stop
 * - Auto-resets every day at 00:00 UTC
 *
 * Example with $100 balance, 20% limit:
 *   Max daily loss = $20
 *   Trade 1: -$8 (used: $8/$20)
 *   Trade 2: -$10 (used: $18/$20) → WARNING at 80%
 *   Trade 3: -$5 → BLOCKED! Limit reached.
 */

const logger = require('./logger');
const compound = require('./compound');

// Per-user risk state
const riskState = new Map();

// Default config
const DEFAULT_LOSS_LIMIT_PERCENT = 0.20; // 20% of balance

/**
 * Initialize or get risk state for a user
 */
function getState(chatId) {
  if (!riskState.has(chatId)) {
    riskState.set(chatId, {
      enabled: true,
      lossLimitPercent: DEFAULT_LOSS_LIMIT_PERCENT,
      dailyLoss: 0,
      dailyTradeCount: 0,
      dailyWins: 0,
      dailyLosses: 0,
      paused: false,
      pausedAt: null,
      lastResetDate: getTodayUTC(),
      warningNotified: false,
    });
  }

  const state = riskState.get(chatId);

  // Auto-reset if new day
  const today = getTodayUTC();
  if (state.lastResetDate !== today) {
    resetDaily(chatId);
  }

  return state;
}

/**
 * Set loss limit percentage for a user
 * @param {string} chatId
 * @param {number} percent - e.g., 0.20 for 20%
 */
function setLossLimit(chatId, percent) {
  const state = getState(chatId);
  state.lossLimitPercent = Math.max(0.05, Math.min(percent, 0.50)); // Clamp 5%-50%
  logger.info(`Risk limit set for ${chatId}: ${(state.lossLimitPercent * 100).toFixed(0)}%`);
  return state;
}

/**
 * Get the current daily loss limit in dollars
 */
function getDailyLimitDollars(chatId) {
  const state = getState(chatId);
  const compoundConfig = compound.getConfig(chatId);
  const balance = compoundConfig ? compoundConfig.currentBalance : 100; // Default $100 if no compound
  return balance * state.lossLimitPercent;
}

/**
 * Check if trading is allowed (not paused by risk manager)
 * @param {string} chatId
 * @returns {object} { allowed: boolean, reason: string, remaining: number }
 */
function canTrade(chatId) {
  const state = getState(chatId);

  if (!state.enabled) {
    return { allowed: true, reason: 'Risk manager disabled', remaining: Infinity };
  }

  if (state.paused) {
    const limit = getDailyLimitDollars(chatId);
    return {
      allowed: false,
      reason: `Daily loss limit reached ($${state.dailyLoss.toFixed(2)} / $${limit.toFixed(2)}). Trading paused until 00:00 UTC.`,
      remaining: 0,
    };
  }

  const limit = getDailyLimitDollars(chatId);
  const remaining = limit - state.dailyLoss;

  return {
    allowed: true,
    reason: 'OK',
    remaining: Math.max(remaining, 0),
    used: state.dailyLoss,
    limit,
    usedPercent: limit > 0 ? (state.dailyLoss / limit * 100).toFixed(0) : 0,
  };
}

/**
 * Record a loss and check if limit is reached
 * @param {string} chatId
 * @param {number} lossAmount - Positive number representing the loss
 * @returns {object} { limitReached: boolean, warning: boolean, paused: boolean }
 */
function recordLoss(chatId, lossAmount) {
  const state = getState(chatId);
  const limit = getDailyLimitDollars(chatId);

  state.dailyLoss += Math.abs(lossAmount);
  state.dailyTradeCount++;
  state.dailyLosses++;

  const usedPercent = limit > 0 ? (state.dailyLoss / limit) : 0;

  let warning = false;
  let limitReached = false;

  // Check 80% warning threshold
  if (usedPercent >= 0.80 && !state.warningNotified) {
    state.warningNotified = true;
    warning = true;
    logger.warn(`Risk WARNING for ${chatId}: ${(usedPercent * 100).toFixed(0)}% of daily loss limit used ($${state.dailyLoss.toFixed(2)} / $${limit.toFixed(2)})`);
  }

  // Check 100% limit
  if (state.dailyLoss >= limit) {
    state.paused = true;
    state.pausedAt = new Date().toISOString();
    limitReached = true;
    logger.warn(`Risk LIMIT REACHED for ${chatId}: Trading PAUSED. Loss: $${state.dailyLoss.toFixed(2)} >= Limit: $${limit.toFixed(2)}`);
  }

  return {
    limitReached,
    warning,
    paused: state.paused,
    dailyLoss: state.dailyLoss,
    limit,
    usedPercent: (usedPercent * 100).toFixed(0),
    remaining: Math.max(limit - state.dailyLoss, 0),
  };
}

/**
 * Record a win (reduces effective daily loss)
 */
function recordWin(chatId, winAmount) {
  const state = getState(chatId);
  state.dailyTradeCount++;
  state.dailyWins++;
  // Wins reduce daily loss counter (net loss tracking)
  state.dailyLoss = Math.max(0, state.dailyLoss - Math.abs(winAmount));

  // Un-pause if loss drops below limit after a win
  if (state.paused) {
    const limit = getDailyLimitDollars(chatId);
    if (state.dailyLoss < limit) {
      state.paused = false;
      state.pausedAt = null;
      logger.info(`Risk un-paused for ${chatId}: Win brought loss below limit`);
    }
  }
}

/**
 * Reset daily counters (called at 00:00 UTC or manually)
 */
function resetDaily(chatId) {
  const state = getState(chatId);
  state.dailyLoss = 0;
  state.dailyTradeCount = 0;
  state.dailyWins = 0;
  state.dailyLosses = 0;
  state.paused = false;
  state.pausedAt = null;
  state.warningNotified = false;
  state.lastResetDate = getTodayUTC();
  logger.info(`Risk daily reset for ${chatId}`);
  return state;
}

/**
 * Force unpause (manual override)
 */
function forceUnpause(chatId) {
  const state = getState(chatId);
  state.paused = false;
  state.pausedAt = null;
  logger.info(`Risk force-unpaused for ${chatId}`);
  return state;
}

/**
 * Enable/disable risk manager
 */
function setEnabled(chatId, enabled) {
  const state = getState(chatId);
  state.enabled = enabled;
  if (!enabled) {
    state.paused = false;
  }
  logger.info(`Risk manager ${enabled ? 'enabled' : 'disabled'} for ${chatId}`);
  return state;
}

/**
 * Get risk summary for display
 */
function getSummary(chatId) {
  const state = getState(chatId);
  const limit = getDailyLimitDollars(chatId);
  const remaining = Math.max(limit - state.dailyLoss, 0);
  const usedPercent = limit > 0 ? (state.dailyLoss / limit * 100) : 0;

  return {
    enabled: state.enabled,
    paused: state.paused,
    pausedAt: state.pausedAt,
    lossLimitPercent: state.lossLimitPercent,
    dailyLimitDollars: limit,
    dailyLoss: state.dailyLoss,
    remaining,
    usedPercent: usedPercent.toFixed(0),
    dailyTradeCount: state.dailyTradeCount,
    dailyWins: state.dailyWins,
    dailyLosses: state.dailyLosses,
    lastResetDate: state.lastResetDate,
  };
}

/**
 * Format risk status for Telegram
 */
function formatStatus(chatId) {
  const s = getSummary(chatId);

  const statusEmoji = s.paused ? '\u{1F6D1}' : (parseFloat(s.usedPercent) >= 80 ? '\u{26A0}\uFE0F' : '\u{2705}');
  const barLength = 20;
  const filledLength = Math.round((parseFloat(s.usedPercent) / 100) * barLength);
  const progressBar = '\u{2588}'.repeat(filledLength) + '\u{2591}'.repeat(barLength - filledLength);

  let text = `${statusEmoji} *Daily Risk Status*\n`;
  text += `\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\n\n`;

  text += `Status: ${s.paused ? '\u{1F6D1} PAUSED (limit reached)' : '\u{2705} Active'}\n`;
  text += `Risk Limit: ${(s.lossLimitPercent * 100).toFixed(0)}% of balance\n\n`;

  text += `*Daily Loss:*\n`;
  text += `[${progressBar}] ${s.usedPercent}%\n`;
  text += `Used: $${s.dailyLoss.toFixed(2)} / $${s.dailyLimitDollars.toFixed(2)}\n`;
  text += `Remaining: $${s.remaining.toFixed(2)}\n\n`;

  text += `*Today's Trades:* ${s.dailyTradeCount}\n`;
  text += `Wins: ${s.dailyWins} | Losses: ${s.dailyLosses}\n`;
  text += `Resets: 00:00 UTC\n`;

  if (s.paused) {
    text += `\n\u{26A0}\uFE0F _Trading paused since ${new Date(s.pausedAt).toLocaleTimeString()}_\n`;
    text += `_Will auto-resume at 00:00 UTC tomorrow_`;
  }

  return text;
}

// ── Helpers ──

function getTodayUTC() {
  return new Date().toISOString().split('T')[0]; // "2026-05-26"
}

module.exports = {
  getState,
  setLossLimit,
  getDailyLimitDollars,
  canTrade,
  recordLoss,
  recordWin,
  resetDaily,
  forceUnpause,
  setEnabled,
  getSummary,
  formatStatus,
  DEFAULT_LOSS_LIMIT_PERCENT,
};
