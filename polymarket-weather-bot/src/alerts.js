'use strict';

const logger = require('./logger');

/**
 * In-memory alert store for price alerts.
 * In production, this should be backed by a database (Redis, SQLite, etc.)
 */
class AlertManager {
  constructor() {
    // Map of chatId -> array of alerts
    this.alerts = new Map();
  }

  /**
   * Add a new price alert
   */
  addAlert(chatId, { marketId, marketQuestion, targetPrice, direction, outcome }) {
    if (!this.alerts.has(chatId)) {
      this.alerts.set(chatId, []);
    }

    const alert = {
      id: `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      marketId,
      marketQuestion,
      targetPrice: parseFloat(targetPrice),
      direction, // 'above' or 'below'
      outcome: outcome || 'Yes',
      createdAt: new Date().toISOString(),
      triggered: false,
    };

    this.alerts.get(chatId).push(alert);
    logger.info(`Alert created for chat ${chatId}: ${marketQuestion} ${direction} ${targetPrice}`);
    return alert;
  }

  /**
   * Get all alerts for a user
   */
  getAlerts(chatId) {
    return (this.alerts.get(chatId) || []).filter((a) => !a.triggered);
  }

  /**
   * Remove an alert
   */
  removeAlert(chatId, alertId) {
    const userAlerts = this.alerts.get(chatId);
    if (!userAlerts) return false;

    const idx = userAlerts.findIndex((a) => a.id === alertId);
    if (idx === -1) return false;

    userAlerts.splice(idx, 1);
    logger.info(`Alert ${alertId} removed for chat ${chatId}`);
    return true;
  }

  /**
   * Clear all alerts for a user
   */
  clearAlerts(chatId) {
    this.alerts.delete(chatId);
    logger.info(`All alerts cleared for chat ${chatId}`);
  }

  /**
   * Check all alerts against current market data
   * Returns array of triggered alerts with their chatIds
   */
  checkAlerts(markets) {
    const triggered = [];

    for (const [chatId, userAlerts] of this.alerts.entries()) {
      for (const alert of userAlerts) {
        if (alert.triggered) continue;

        // Find matching market
        const market = markets.find((m) => m.id === alert.marketId || m.conditionId === alert.marketId);
        if (!market) continue;

        // Get current price for the outcome
        let currentPrice = 0;
        try {
          const outcomes = typeof market.outcomes === 'string'
            ? JSON.parse(market.outcomes)
            : (market.outcomes || []);
          const prices = typeof market.outcomePrices === 'string'
            ? JSON.parse(market.outcomePrices)
            : (market.outcomePrices || []);

          const idx = outcomes.findIndex(
            (o) => o.toLowerCase() === alert.outcome.toLowerCase()
          );
          if (idx >= 0 && prices[idx]) {
            currentPrice = parseFloat(prices[idx]);
          }
        } catch (e) {
          continue;
        }

        // Check trigger condition
        const shouldTrigger =
          (alert.direction === 'above' && currentPrice >= alert.targetPrice) ||
          (alert.direction === 'below' && currentPrice <= alert.targetPrice);

        if (shouldTrigger) {
          alert.triggered = true;
          triggered.push({
            chatId,
            alert,
            currentPrice,
          });
          logger.info(`Alert triggered for chat ${chatId}: ${alert.marketQuestion}`);
        }
      }
    }

    return triggered;
  }

  /**
   * Get total active alerts count
   */
  getTotalAlertCount() {
    let count = 0;
    for (const [, userAlerts] of this.alerts.entries()) {
      count += userAlerts.filter((a) => !a.triggered).length;
    }
    return count;
  }
}

module.exports = new AlertManager();
