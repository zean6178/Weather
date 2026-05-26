'use strict';

/**
 * Weather Signal Engine
 *
 * Compares NOAA/Open-Meteo forecast data with Polymarket weather market odds
 * to generate BUY/SELL signals when there's a significant mispricing.
 *
 * Strategy Logic:
 * 1. Fetch NOAA forecast → get predicted high temperature
 * 2. Fetch Polymarket markets for same city/date
 * 3. Parse market outcomes (e.g., "72-73°F", "24°C")
 * 4. Compare forecast temp with market odds
 * 5. If forecast strongly supports an outcome but market price is low → BUY signal
 * 6. If forecast contradicts an outcome but market price is high → SELL signal
 *
 * Confidence is based on:
 * - How far the forecast is from the market's implied outcome
 * - NOAA historical accuracy (~85% for next-day highs)
 * - Spread between forecast confidence and market price
 */

const noaa = require('./noaa');
const polymarket = require('./polymarket');
const logger = require('./logger');
const cache = require('./cache');

// Signal strength thresholds
const SIGNAL_CONFIG = {
  // Minimum price difference to generate a signal (e.g., 0.15 = 15%)
  MIN_EDGE: 0.12,
  // Strong signal threshold
  STRONG_EDGE: 0.25,
  // NOAA forecast confidence (historical accuracy for next-day high temps)
  NOAA_CONFIDENCE: 0.85,
  // Maximum hours before market end to generate signals
  MAX_HOURS_BEFORE_END: 24,
  // Temperature tolerance in degrees (forecast ±2°F or ±1°C is still "matching")
  TEMP_TOLERANCE_F: 2,
  TEMP_TOLERANCE_C: 1,
};

/**
 * Signal types
 */
const SIGNAL_TYPE = {
  STRONG_BUY: 'STRONG_BUY',
  BUY: 'BUY',
  NEUTRAL: 'NEUTRAL',
  SELL: 'SELL',
  STRONG_SELL: 'STRONG_SELL',
};

/**
 * Generate trading signals for a specific city
 * @param {string} cityName - City to analyze
 * @returns {object[]} Array of signal objects
 */
async function generateSignals(cityName) {
  const cacheKey = `signals_${cityName.toLowerCase()}`;
  const cached = cache.get(cacheKey);
  if (cached) return cached;

  try {
    // 1. Get weather forecast
    const forecast = await noaa.getForecast(cityName);
    if (!forecast) {
      logger.debug(`No forecast available for ${cityName}`);
      return [];
    }

    // 2. Get Polymarket weather markets for this city
    const markets = await polymarket.getWeatherMarkets({ city: cityName, limit: 20 });
    if (!markets || markets.length === 0) {
      logger.debug(`No Polymarket markets found for ${cityName}`);
      return [];
    }

    // 3. Analyze each market against forecast
    const signals = [];
    for (const market of markets) {
      const signal = analyzeMarket(market, forecast);
      if (signal && signal.type !== SIGNAL_TYPE.NEUTRAL) {
        signals.push(signal);
      }
    }

    // Sort by edge strength (highest first)
    signals.sort((a, b) => Math.abs(b.edge) - Math.abs(a.edge));

    cache.set(cacheKey, signals);
    logger.info(`Generated ${signals.length} signals for ${cityName}`);
    return signals;
  } catch (error) {
    logger.error(`Signal generation error for ${cityName}: ${error.message}`);
    return [];
  }
}

/**
 * Generate signals for ALL supported cities
 */
async function generateAllSignals() {
  const cacheKey = 'all_signals';
  const cached = cache.get(cacheKey);
  if (cached) return cached;

  const allSignals = [];
  const cities = noaa.getSupportedCities();

  // Deduplicate city names (some have aliases like 'nyc' and 'new york')
  const uniqueCities = [];
  const seen = new Set();
  for (const city of cities) {
    if (!seen.has(city.name)) {
      seen.add(city.name);
      uniqueCities.push(city);
    }
  }

  for (const city of uniqueCities) {
    try {
      const signals = await generateSignals(city.key);
      for (const signal of signals) {
        allSignals.push(signal);
      }
    } catch (error) {
      logger.debug(`Skipping ${city.name}: ${error.message}`);
    }
  }

  // Sort all signals by edge
  allSignals.sort((a, b) => Math.abs(b.edge) - Math.abs(a.edge));

  cache.set(cacheKey, allSignals);
  return allSignals;
}

/**
 * Analyze a single market against the forecast
 * @param {object} market - Polymarket market object
 * @param {object} forecast - NOAA/Open-Meteo forecast data
 * @returns {object|null} Signal or null
 */
function analyzeMarket(market, forecast) {
  try {
    const question = (market.question || '').toLowerCase();

    // Skip non-temperature markets
    if (!question.includes('temperature') && !question.includes('temp')) {
      return null;
    }

    // Check if market is about "highest temperature"
    if (!question.includes('highest') && !question.includes('high')) {
      return null;
    }

    // Determine if market is for today or tomorrow
    const isToday = isMarketForToday(market);
    const isTomorrow = isMarketForTomorrow(market);
    if (!isToday && !isTomorrow) return null;

    const forecastData = isToday ? forecast.today : forecast.tomorrow;
    if (!forecastData) return null;

    // Get forecast high temp in both units
    let forecastHighF, forecastHighC;
    if (forecastData.unit === 'F') {
      forecastHighF = forecastData.high;
      forecastHighC = noaa.fahrenheitToCelsius(forecastData.high);
    } else {
      forecastHighC = forecastData.high;
      forecastHighF = forecastData.highF || noaa.celsiusToFahrenheit(forecastData.high);
    }

    // Parse market outcomes and prices
    let outcomes, prices;
    try {
      outcomes = typeof market.outcomes === 'string'
        ? JSON.parse(market.outcomes)
        : (market.outcomes || []);
      prices = typeof market.outcomePrices === 'string'
        ? JSON.parse(market.outcomePrices)
        : (market.outcomePrices || []);
    } catch (e) {
      return null;
    }

    if (outcomes.length === 0 || prices.length === 0) return null;

    // Analyze each outcome
    let bestSignal = null;
    let bestEdge = 0;

    for (let i = 0; i < outcomes.length; i++) {
      const outcome = outcomes[i];
      const marketPrice = parseFloat(prices[i]) || 0;

      if (marketPrice <= 0.01 || marketPrice >= 0.99) continue; // Skip extreme prices

      // Parse what temperature range this outcome represents
      const tempRange = parseTemperatureOutcome(outcome);
      if (!tempRange) continue;

      // Calculate probability that forecast matches this outcome
      const forecastProb = calculateForecastProbability(
        tempRange,
        forecastHighF,
        forecastHighC
      );

      // Calculate edge: difference between our forecast probability and market price
      const edge = forecastProb - marketPrice;

      // Determine signal
      if (Math.abs(edge) > Math.abs(bestEdge) && Math.abs(edge) >= SIGNAL_CONFIG.MIN_EDGE) {
        bestEdge = edge;
        bestSignal = {
          type: getSignalType(edge),
          city: forecast.city,
          market: market.question,
          marketId: market.id || market.conditionId,
          tokenId: getTokenId(market, i),
          outcome,
          marketPrice,
          forecastProb: Math.round(forecastProb * 100) / 100,
          edge: Math.round(edge * 100) / 100,
          forecastTemp: `${forecastHighC}°C / ${forecastHighF}°F`,
          forecastSource: forecast.source,
          confidence: calculateConfidence(edge, forecastData),
          timeframe: isToday ? 'today' : 'tomorrow',
          endDate: market.endDate,
          volume: market.volume || market.volume24hr || 0,
          liquidity: market.liquidity || 0,
          generatedAt: new Date().toISOString(),
        };
      }
    }

    return bestSignal;
  } catch (error) {
    logger.debug(`Market analysis error: ${error.message}`);
    return null;
  }
}

/**
 * Parse temperature from outcome string
 * Examples: "72-73°F", "24°C", "66-67°F", "59°F or below", "66°F or higher"
 */
function parseTemperatureOutcome(outcome) {
  if (!outcome) return null;

  // Pattern: "XX-YY°F" or "XX-YY°C"
  const rangeMatch = outcome.match(/(\d+)\s*[-–]\s*(\d+)\s*°?\s*([FCfc])/);
  if (rangeMatch) {
    return {
      low: parseInt(rangeMatch[1]),
      high: parseInt(rangeMatch[2]),
      unit: rangeMatch[3].toUpperCase(),
      type: 'range',
    };
  }

  // Pattern: "XX°F or below" / "XX°C or below"
  const belowMatch = outcome.match(/(\d+)\s*°?\s*([FCfc])\s*(or\s*)?below/i);
  if (belowMatch) {
    return {
      low: 0,
      high: parseInt(belowMatch[1]),
      unit: belowMatch[2].toUpperCase(),
      type: 'below',
    };
  }

  // Pattern: "XX°F or higher" / "XX°C or higher"
  const aboveMatch = outcome.match(/(\d+)\s*°?\s*([FCfc])\s*(or\s*)?higher/i);
  if (aboveMatch) {
    return {
      low: parseInt(aboveMatch[1]),
      high: 200, // effectively no upper limit
      unit: aboveMatch[2].toUpperCase(),
      type: 'above',
    };
  }

  // Pattern: single temp "XX°F" or "XX°C"
  const singleMatch = outcome.match(/(\d+)\s*°?\s*([FCfc])/);
  if (singleMatch) {
    const temp = parseInt(singleMatch[1]);
    return {
      low: temp,
      high: temp,
      unit: singleMatch[2].toUpperCase(),
      type: 'exact',
    };
  }

  return null;
}

/**
 * Calculate probability that forecast falls within the outcome's temperature range
 * Uses a normal distribution approximation around the forecast value
 */
function calculateForecastProbability(tempRange, forecastF, forecastC) {
  const forecastTemp = tempRange.unit === 'F' ? forecastF : forecastC;
  const tolerance = tempRange.unit === 'F'
    ? SIGNAL_CONFIG.TEMP_TOLERANCE_F
    : SIGNAL_CONFIG.TEMP_TOLERANCE_C;

  // Standard deviation: NOAA is accurate to about ±3°F or ±1.5°C for next-day
  const stdDev = tempRange.unit === 'F' ? 3.0 : 1.7;

  switch (tempRange.type) {
    case 'range': {
      // Probability that actual temp falls in [low, high]
      const zLow = (tempRange.low - forecastTemp) / stdDev;
      const zHigh = (tempRange.high - forecastTemp) / stdDev;
      return normalCDF(zHigh) - normalCDF(zLow);
    }
    case 'below': {
      const z = (tempRange.high - forecastTemp) / stdDev;
      return normalCDF(z);
    }
    case 'above': {
      const z = (tempRange.low - forecastTemp) / stdDev;
      return 1 - normalCDF(z);
    }
    case 'exact': {
      // For "exact" match, use a small range around the value
      const zLow = (tempRange.low - tolerance - forecastTemp) / stdDev;
      const zHigh = (tempRange.high + tolerance - forecastTemp) / stdDev;
      return normalCDF(zHigh) - normalCDF(zLow);
    }
    default:
      return 0.5; // Unknown — neutral
  }
}

/**
 * Approximate normal CDF using Abramowitz and Stegun formula
 */
function normalCDF(x) {
  if (x < -6) return 0;
  if (x > 6) return 1;

  const t = 1 / (1 + 0.2316419 * Math.abs(x));
  const d = 0.3989422804 * Math.exp(-0.5 * x * x);
  const p = d * t * (0.3193815 + t * (-0.3565638 + t * (1.781478 + t * (-1.821256 + t * 1.330274))));

  return x > 0 ? 1 - p : p;
}

/**
 * Determine signal type based on edge
 */
function getSignalType(edge) {
  if (edge >= SIGNAL_CONFIG.STRONG_EDGE) return SIGNAL_TYPE.STRONG_BUY;
  if (edge >= SIGNAL_CONFIG.MIN_EDGE) return SIGNAL_TYPE.BUY;
  if (edge <= -SIGNAL_CONFIG.STRONG_EDGE) return SIGNAL_TYPE.STRONG_SELL;
  if (edge <= -SIGNAL_CONFIG.MIN_EDGE) return SIGNAL_TYPE.SELL;
  return SIGNAL_TYPE.NEUTRAL;
}

/**
 * Calculate overall confidence score (0-100)
 */
function calculateConfidence(edge, forecastData) {
  let confidence = 50; // Base

  // Edge strength adds confidence
  confidence += Math.min(Math.abs(edge) * 100, 30);

  // NOAA source is more reliable
  if (forecastData.source === 'NOAA/NWS') {
    confidence += 10;
  }

  // Cap at 95
  return Math.min(Math.round(confidence), 95);
}

/**
 * Check if market is for today's temperature
 */
function isMarketForToday(market) {
  const question = (market.question || '').toLowerCase();
  const today = new Date();
  const todayStr = today.toISOString().split('T')[0];

  // Check for "today" keyword
  if (question.includes('today')) return true;

  // Check for today's date in various formats
  const months = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
  const monthName = months[today.getMonth()];
  const dayNum = today.getDate();

  if (question.includes(`${monthName} ${dayNum}`) || question.includes(`${monthName}${dayNum}`)) {
    return true;
  }

  // Check endDate
  if (market.endDate) {
    const endDate = new Date(market.endDate);
    const endStr = endDate.toISOString().split('T')[0];
    if (endStr === todayStr) return true;
  }

  return false;
}

/**
 * Check if market is for tomorrow's temperature
 */
function isMarketForTomorrow(market) {
  const question = (market.question || '').toLowerCase();
  const tomorrow = new Date();
  tomorrow.setDate(tomorrow.getDate() + 1);
  const tomorrowStr = tomorrow.toISOString().split('T')[0];

  if (question.includes('tomorrow')) return true;

  const months = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
  const monthName = months[tomorrow.getMonth()];
  const dayNum = tomorrow.getDate();

  if (question.includes(`${monthName} ${dayNum}`) || question.includes(`${monthName}${dayNum}`)) {
    return true;
  }

  if (market.endDate) {
    const endDate = new Date(market.endDate);
    const endStr = endDate.toISOString().split('T')[0];
    if (endStr === tomorrowStr) return true;
  }

  return false;
}

/**
 * Get token ID from market for a specific outcome index
 */
function getTokenId(market, outcomeIndex) {
  try {
    if (market.clobTokenIds) {
      const tokenIds = typeof market.clobTokenIds === 'string'
        ? JSON.parse(market.clobTokenIds)
        : market.clobTokenIds;
      return tokenIds[outcomeIndex] || null;
    }
    return null;
  } catch (e) {
    return null;
  }
}

/**
 * Format a signal for display
 */
function formatSignal(signal) {
  const emoji = {
    STRONG_BUY: '\u{1F7E2}\u{1F7E2}',
    BUY: '\u{1F7E2}',
    NEUTRAL: '\u{26AA}',
    SELL: '\u{1F534}',
    STRONG_SELL: '\u{1F534}\u{1F534}',
  };

  const arrow = signal.edge > 0 ? '\u{2B06}\uFE0F' : '\u{2B07}\uFE0F';

  let text = `${emoji[signal.type] || ''} *${signal.type}*\n`;
  text += `\u{1F3D9} ${signal.city} (${signal.timeframe})\n`;
  text += `\u{1F321} Forecast: ${signal.forecastTemp}\n`;
  text += `\u{1F3AF} Outcome: "${signal.outcome}"\n`;
  text += `${arrow} Market: ${(signal.marketPrice * 100).toFixed(1)}% → Forecast: ${(signal.forecastProb * 100).toFixed(1)}%\n`;
  text += `\u{1F4CA} Edge: ${signal.edge > 0 ? '+' : ''}${(signal.edge * 100).toFixed(1)}%\n`;
  text += `\u{1F4AA} Confidence: ${signal.confidence}%\n`;
  text += `\u{1F4D6} Source: ${signal.forecastSource}`;

  return text;
}

/**
 * Format all signals summary
 */
function formatSignalsSummary(signals) {
  if (!signals || signals.length === 0) {
    return '\u{1F4E1} *Weather Trading Signals*\n\n_No actionable signals right now. Market prices align with forecasts._';
  }

  let text = `\u{1F4E1} *Weather Trading Signals*\n`;
  text += `\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\n`;
  text += `_NOAA/Open-Meteo vs Polymarket odds_\n\n`;

  const buySignals = signals.filter((s) => s.type.includes('BUY'));
  const sellSignals = signals.filter((s) => s.type.includes('SELL'));

  if (buySignals.length > 0) {
    text += `\u{1F7E2} *BUY Signals (${buySignals.length}):*\n\n`;
    for (const s of buySignals.slice(0, 5)) {
      text += formatSignal(s) + '\n\n';
    }
  }

  if (sellSignals.length > 0) {
    text += `\u{1F534} *SELL Signals (${sellSignals.length}):*\n\n`;
    for (const s of sellSignals.slice(0, 5)) {
      text += formatSignal(s) + '\n\n';
    }
  }

  text += `\n_Generated: ${new Date().toLocaleTimeString()} | Top ${Math.min(signals.length, 10)} signals shown_`;
  return text;
}

module.exports = {
  generateSignals,
  generateAllSignals,
  formatSignal,
  formatSignalsSummary,
  analyzeMarket,
  SIGNAL_TYPE,
  SIGNAL_CONFIG,
};
