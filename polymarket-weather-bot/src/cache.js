'use strict';

const config = require('./config');
const logger = require('./logger');

/**
 * Simple in-memory cache with TTL support.
 * Prevents excessive API calls to Polymarket.
 */
class Cache {
  constructor(ttlSeconds = config.cache.ttlSeconds) {
    this.store = new Map();
    this.ttl = ttlSeconds * 1000; // Convert to ms
  }

  get(key) {
    const entry = this.store.get(key);
    if (!entry) return null;

    if (Date.now() - entry.timestamp > this.ttl) {
      this.store.delete(key);
      logger.debug(`Cache expired for key: ${key}`);
      return null;
    }

    logger.debug(`Cache hit for key: ${key}`);
    return entry.data;
  }

  set(key, data) {
    this.store.set(key, {
      data,
      timestamp: Date.now(),
    });
    logger.debug(`Cache set for key: ${key}`);
  }

  invalidate(key) {
    this.store.delete(key);
  }

  clear() {
    this.store.clear();
    logger.debug('Cache cleared');
  }

  /**
   * Get cache stats for monitoring
   */
  getStats() {
    let active = 0;
    let expired = 0;
    const now = Date.now();

    for (const [, entry] of this.store) {
      if (now - entry.timestamp > this.ttl) {
        expired++;
      } else {
        active++;
      }
    }

    return { active, expired, total: this.store.size };
  }
}

module.exports = new Cache();
