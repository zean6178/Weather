'use strict';

const axios = require('axios');
const config = require('./config');
const cache = require('./cache');
const logger = require('./logger');

const GAMMA_API = config.polymarket.gammaApiBase;
const CLOB_API = config.polymarket.clobApiBase;

// Request timeout and retry settings
const REQUEST_TIMEOUT = 15000; // 15 seconds
const MAX_RETRIES = 3;
const RETRY_DELAY = 1000; // 1 second base delay

/**
 * Axios instance with proper defaults for Polymarket APIs
 */
const gammaClient = axios.create({
  baseURL: GAMMA_API,
  timeout: REQUEST_TIMEOUT,
  headers: {
    'Accept': 'application/json',
    'User-Agent': 'PolymarketWeatherBot/1.0',
  },
});

const clobClient = axios.create({
  baseURL: CLOB_API,
  timeout: REQUEST_TIMEOUT,
  headers: {
    'Accept': 'application/json',
    'User-Agent': 'PolymarketWeatherBot/1.0',
  },
});

/**
 * Sleep helper for retries
 */
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Execute request with exponential backoff retry
 */
async function requestWithRetry(client, url, params = {}, retries = MAX_RETRIES) {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const response = await client.get(url, { params });
      return response.data;
    } catch (error) {
      const status = error.response?.status;
      const isRetryable = !status || status >= 500 || status === 429;

      if (attempt === retries || !isRetryable) {
        logger.error(`API request failed after ${attempt} attempts: ${url}`, error.message);
        throw error;
      }

      const delay = RETRY_DELAY * Math.pow(2, attempt - 1);
      logger.warn(`Request to ${url} failed (attempt ${attempt}/${retries}), retrying in ${delay}ms...`);
      await sleep(delay);
    }
  }
}

/**
 * Fetch all active weather prediction events from Polymarket
 */
async function getWeatherEvents(options = {}) {
  const { limit = 50, offset = 0 } = options;
  const cacheKey = `weather_events_${limit}_${offset}`;
  const cached = cache.get(cacheKey);
  if (cached) return cached;

  try {
    const data = await requestWithRetry(gammaClient, '/events', {
      tag_slug: 'weather',
      active: true,
      closed: false,
      limit,
      offset,
      order: 'volume24hr',
      ascending: false,
    });

    const events = Array.isArray(data) ? data : [];
    cache.set(cacheKey, events);
    logger.info(`Fetched ${events.length} weather events from Polymarket`);
    return events;
  } catch (error) {
    logger.error('Failed to fetch weather events:', error.message);
    return [];
  }
}

/**
 * Fetch weather markets directly (more granular than events)
 */
async function getWeatherMarkets(options = {}) {
  const { limit = 100, offset = 0, city = null } = options;
  const cacheKey = `weather_markets_${limit}_${offset}_${city || 'all'}`;
  const cached = cache.get(cacheKey);
  if (cached) return cached;

  try {
    const params = {
      tag_slug: 'weather',
      active: true,
      closed: false,
      limit,
      offset,
      order: 'volume24hr',
      ascending: false,
    };

    const data = await requestWithRetry(gammaClient, '/markets', params);
    let markets = Array.isArray(data) ? data : [];

    // Filter by city if specified
    if (city) {
      const cityLower = city.toLowerCase();
      markets = markets.filter((m) => {
        const question = (m.question || '').toLowerCase();
        const groupTitle = (m.groupItemTitle || '').toLowerCase();
        return question.includes(cityLower) || groupTitle.includes(cityLower);
      });
    }

    cache.set(cacheKey, markets);
    logger.info(`Fetched ${markets.length} weather markets${city ? ` for city: ${city}` : ''}`);
    return markets;
  } catch (error) {
    logger.error('Failed to fetch weather markets:', error.message);
    return [];
  }
}

/**
 * Search for specific weather markets by keyword
 */
async function searchWeatherMarkets(query) {
  const cacheKey = `search_${query}`;
  const cached = cache.get(cacheKey);
  if (cached) return cached;

  try {
    // Use the Gamma API search with weather tag
    const data = await requestWithRetry(gammaClient, '/markets', {
      tag_slug: 'weather',
      active: true,
      closed: false,
      limit: 50,
    });

    let markets = Array.isArray(data) ? data : [];
    const queryLower = query.toLowerCase();

    // Filter results by search query
    markets = markets.filter((m) => {
      const question = (m.question || '').toLowerCase();
      const description = (m.description || '').toLowerCase();
      return question.includes(queryLower) || description.includes(queryLower);
    });

    cache.set(cacheKey, markets);
    return markets;
  } catch (error) {
    logger.error(`Failed to search weather markets for "${query}":`, error.message);
    return [];
  }
}

/**
 * Get detailed event information by ID
 */
async function getEventById(eventId) {
  const cacheKey = `event_${eventId}`;
  const cached = cache.get(cacheKey);
  if (cached) return cached;

  try {
    const data = await requestWithRetry(gammaClient, `/events/${eventId}`);
    cache.set(cacheKey, data);
    return data;
  } catch (error) {
    logger.error(`Failed to fetch event ${eventId}:`, error.message);
    return null;
  }
}

/**
 * Get detailed market information by ID
 */
async function getMarketById(marketId) {
  const cacheKey = `market_${marketId}`;
  const cached = cache.get(cacheKey);
  if (cached) return cached;

  try {
    const data = await requestWithRetry(gammaClient, `/markets/${marketId}`);
    cache.set(cacheKey, data);
    return data;
  } catch (error) {
    logger.error(`Failed to fetch market ${marketId}:`, error.message);
    return null;
  }
}

/**
 * Get market orderbook data from CLOB API
 */
async function getOrderbook(tokenId) {
  const cacheKey = `orderbook_${tokenId}`;
  const cached = cache.get(cacheKey);
  if (cached) return cached;

  try {
    const data = await requestWithRetry(clobClient, '/book', {
      token_id: tokenId,
    });
    cache.set(cacheKey, data);
    return data;
  } catch (error) {
    logger.error(`Failed to fetch orderbook for token ${tokenId}:`, error.message);
    return null;
  }
}

/**
 * Get price history for a market
 */
async function getPriceHistory(tokenId, interval = '1d') {
  const cacheKey = `price_history_${tokenId}_${interval}`;
  const cached = cache.get(cacheKey);
  if (cached) return cached;

  try {
    const data = await requestWithRetry(clobClient, '/prices-history', {
      market: tokenId,
      interval,
    });
    cache.set(cacheKey, data);
    return data;
  } catch (error) {
    logger.error(`Failed to fetch price history for token ${tokenId}:`, error.message);
    return null;
  }
}

/**
 * Get all available cities from weather markets
 */
async function getAvailableCities() {
  const cacheKey = 'available_cities';
  const cached = cache.get(cacheKey);
  if (cached) return cached;

  try {
    const markets = await getWeatherMarkets({ limit: 100 });
    const citySet = new Set();

    // Common cities in Polymarket weather markets
    const knownCities = [
      'NYC', 'New York', 'London', 'Chicago', 'Shanghai',
      'Seoul', 'Tokyo', 'Paris', 'Sydney', 'Miami',
      'Los Angeles', 'San Francisco', 'Dubai', 'Mumbai',
      'Beijing', 'Hong Kong', 'Singapore', 'Berlin',
    ];

    for (const market of markets) {
      const question = (market.question || '').toLowerCase();
      for (const city of knownCities) {
        if (question.includes(city.toLowerCase())) {
          citySet.add(city);
        }
      }
    }

    const cities = Array.from(citySet).sort();
    cache.set(cacheKey, cities);
    return cities;
  } catch (error) {
    logger.error('Failed to get available cities:', error.message);
    return [];
  }
}

/**
 * Get market summary statistics
 */
async function getMarketStats() {
  const cacheKey = 'market_stats';
  const cached = cache.get(cacheKey);
  if (cached) return cached;

  try {
    const markets = await getWeatherMarkets({ limit: 100 });
    const stats = {
      totalMarkets: markets.length,
      totalVolume: 0,
      totalLiquidity: 0,
      activeCities: new Set(),
      topMarkets: [],
    };

    for (const market of markets) {
      const volume = parseFloat(market.volume || 0);
      const liquidity = parseFloat(market.liquidity || 0);
      stats.totalVolume += volume;
      stats.totalLiquidity += liquidity;

      // Extract city
      const question = (market.question || '').toLowerCase();
      const knownCities = ['nyc', 'london', 'chicago', 'shanghai', 'seoul', 'tokyo', 'paris', 'miami'];
      for (const city of knownCities) {
        if (question.includes(city)) {
          stats.activeCities.add(city.charAt(0).toUpperCase() + city.slice(1));
        }
      }
    }

    // Top 5 by volume
    stats.topMarkets = markets
      .sort((a, b) => parseFloat(b.volume || 0) - parseFloat(a.volume || 0))
      .slice(0, 5)
      .map((m) => ({
        question: m.question,
        volume: parseFloat(m.volume || 0),
        liquidity: parseFloat(m.liquidity || 0),
      }));

    stats.activeCities = Array.from(stats.activeCities);
    cache.set(cacheKey, stats);
    return stats;
  } catch (error) {
    logger.error('Failed to get market stats:', error.message);
    return null;
  }
}

module.exports = {
  getWeatherEvents,
  getWeatherMarkets,
  searchWeatherMarkets,
  getEventById,
  getMarketById,
  getOrderbook,
  getPriceHistory,
  getAvailableCities,
  getMarketStats,
};
