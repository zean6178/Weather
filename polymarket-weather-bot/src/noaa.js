'use strict';

/**
 * Weather Forecast Client
 *
 * Uses TWO sources for maximum coverage:
 * 1. NOAA/NWS API (api.weather.gov) — US cities (NYC, Chicago, Miami, etc.)
 * 2. Open-Meteo API (open-meteo.com) — International cities (London, Shanghai, Seoul, etc.)
 *
 * Both are FREE, no API key required.
 * Returns high temperature forecasts for today and tomorrow.
 */

const axios = require('axios');
const logger = require('./logger');
const cache = require('./cache');

// ── City Coordinates Database ──
const CITY_COORDS = {
  'nyc': { lat: 40.7128, lon: -73.9996, name: 'New York City', country: 'US' },
  'new york': { lat: 40.7128, lon: -73.9996, name: 'New York City', country: 'US' },
  'chicago': { lat: 41.8781, lon: -87.6298, name: 'Chicago', country: 'US' },
  'miami': { lat: 25.7617, lon: -80.1918, name: 'Miami', country: 'US' },
  'los angeles': { lat: 34.0522, lon: -118.2437, name: 'Los Angeles', country: 'US' },
  'san francisco': { lat: 37.7749, lon: -122.4194, name: 'San Francisco', country: 'US' },
  'london': { lat: 51.5074, lon: -0.1278, name: 'London', country: 'UK' },
  'shanghai': { lat: 31.2304, lon: 121.4737, name: 'Shanghai', country: 'CN' },
  'seoul': { lat: 37.5665, lon: 126.9780, name: 'Seoul', country: 'KR' },
  'tokyo': { lat: 35.6762, lon: 139.6503, name: 'Tokyo', country: 'JP' },
  'paris': { lat: 48.8566, lon: 2.3522, name: 'Paris', country: 'FR' },
  'sydney': { lat: -33.8688, lon: 151.2093, name: 'Sydney', country: 'AU' },
  'dubai': { lat: 25.2048, lon: 55.2708, name: 'Dubai', country: 'AE' },
  'mumbai': { lat: 19.0760, lon: 72.8777, name: 'Mumbai', country: 'IN' },
  'beijing': { lat: 39.9042, lon: 116.4074, name: 'Beijing', country: 'CN' },
  'hong kong': { lat: 22.3193, lon: 114.1694, name: 'Hong Kong', country: 'HK' },
  'singapore': { lat: 1.3521, lon: 103.8198, name: 'Singapore', country: 'SG' },
  'berlin': { lat: 52.5200, lon: 13.4050, name: 'Berlin', country: 'DE' },
};

const US_CITIES = ['nyc', 'new york', 'chicago', 'miami', 'los angeles', 'san francisco'];

const NWS_CLIENT = axios.create({
  baseURL: 'https://api.weather.gov',
  timeout: 10000,
  headers: {
    'Accept': 'application/geo+json',
    'User-Agent': 'PolymarketWeatherBot/2.0 (contact@example.com)',
  },
});

const OPENMETEO_CLIENT = axios.create({
  baseURL: 'https://api.open-meteo.com/v1',
  timeout: 10000,
});

/**
 * Get temperature forecast for a city
 * @param {string} cityName - City name (case insensitive)
 * @returns {object|null} Forecast data
 */
async function getForecast(cityName) {
  const key = cityName.toLowerCase().trim();
  const cacheKey = `forecast_${key}`;
  const cached = cache.get(cacheKey);
  if (cached) return cached;

  const city = CITY_COORDS[key];
  if (!city) {
    logger.warn(`Unknown city for forecast: ${cityName}`);
    return null;
  }

  try {
    let forecast;
    if (US_CITIES.includes(key)) {
      forecast = await fetchNOAAForecast(city);
    } else {
      forecast = await fetchOpenMeteoForecast(city);
    }

    if (forecast) {
      cache.set(cacheKey, forecast);
    }
    return forecast;
  } catch (error) {
    logger.error(`Forecast fetch error for ${cityName}: ${error.message}`);
    // Fallback: try Open-Meteo for US cities too if NOAA fails
    try {
      const forecast = await fetchOpenMeteoForecast(city);
      if (forecast) cache.set(cacheKey, forecast);
      return forecast;
    } catch (e) {
      logger.error(`Fallback forecast also failed for ${cityName}: ${e.message}`);
      return null;
    }
  }
}

/**
 * Fetch forecast from NOAA/NWS API (US cities only)
 * Flow: /points/{lat},{lon} → get gridpoint URL → /gridpoints/{office}/{x},{y}/forecast
 */
async function fetchNOAAForecast(city) {
  // Step 1: Get grid point metadata
  const pointsResp = await NWS_CLIENT.get(`/points/${city.lat},${city.lon}`);
  const gridUrl = pointsResp.data.properties.forecast;

  // Step 2: Get forecast from grid endpoint
  const forecastResp = await NWS_CLIENT.get(gridUrl);
  const periods = forecastResp.data.properties.periods;

  if (!periods || periods.length === 0) return null;

  // Extract today's and tomorrow's high
  const today = periods.find((p) => p.isDaytime && p.number <= 2);
  const tomorrow = periods.find((p) => p.isDaytime && p.number > 2 && p.number <= 4);

  // Also get hourly forecast for more granular data
  const hourlyUrl = pointsResp.data.properties.forecastHourly;
  let hourlyTemps = [];
  try {
    const hourlyResp = await NWS_CLIENT.get(hourlyUrl);
    const hourlyPeriods = hourlyResp.data.properties.periods || [];
    // Get next 24 hours of hourly temps
    hourlyTemps = hourlyPeriods.slice(0, 24).map((p) => ({
      time: p.startTime,
      temp: p.temperature,
      unit: p.temperatureUnit,
    }));
  } catch (e) {
    // Hourly is optional
    logger.debug(`Hourly forecast unavailable: ${e.message}`);
  }

  const result = {
    city: city.name,
    country: city.country,
    source: 'NOAA/NWS',
    fetchedAt: new Date().toISOString(),
    today: today ? {
      high: today.temperature,
      unit: today.temperatureUnit, // 'F' for Fahrenheit
      description: today.shortForecast,
      detailedForecast: today.detailedForecast,
    } : null,
    tomorrow: tomorrow ? {
      high: tomorrow.temperature,
      unit: tomorrow.temperatureUnit,
      description: tomorrow.shortForecast,
      detailedForecast: tomorrow.detailedForecast,
    } : null,
    hourly: hourlyTemps,
    maxToday: today ? today.temperature : null,
    maxTodayC: today ? fahrenheitToCelsius(today.temperature) : null,
  };

  logger.info(`NOAA forecast for ${city.name}: today high = ${result.today?.high}°${result.today?.unit}`);
  return result;
}

/**
 * Fetch forecast from Open-Meteo API (works globally, no API key)
 * Endpoint: /v1/forecast?latitude=X&longitude=Y&daily=temperature_2m_max&hourly=temperature_2m
 */
async function fetchOpenMeteoForecast(city) {
  const resp = await OPENMETEO_CLIENT.get('/forecast', {
    params: {
      latitude: city.lat,
      longitude: city.lon,
      daily: 'temperature_2m_max,temperature_2m_min',
      hourly: 'temperature_2m',
      timezone: 'auto',
      forecast_days: 3,
    },
  });

  const data = resp.data;
  if (!data.daily || !data.daily.temperature_2m_max) return null;

  const dailyMax = data.daily.temperature_2m_max;
  const dailyMin = data.daily.temperature_2m_min;
  const dates = data.daily.time;

  // Hourly temps for next 24h
  const hourlyTemps = (data.hourly?.temperature_2m || []).slice(0, 24).map((temp, i) => ({
    time: data.hourly.time[i],
    temp: Math.round(temp),
    unit: 'C',
  }));

  const todayHighC = dailyMax[0];
  const tomorrowHighC = dailyMax[1];

  const result = {
    city: city.name,
    country: city.country,
    source: 'Open-Meteo',
    fetchedAt: new Date().toISOString(),
    today: {
      high: todayHighC,
      unit: 'C',
      highF: celsiusToFahrenheit(todayHighC),
      low: dailyMin[0],
      date: dates[0],
    },
    tomorrow: {
      high: tomorrowHighC,
      unit: 'C',
      highF: celsiusToFahrenheit(tomorrowHighC),
      low: dailyMin[1],
      date: dates[1],
    },
    hourly: hourlyTemps,
    maxToday: todayHighC,
    maxTodayC: todayHighC,
    maxTodayF: celsiusToFahrenheit(todayHighC),
    maxTomorrowC: tomorrowHighC,
    maxTomorrowF: celsiusToFahrenheit(tomorrowHighC),
  };

  logger.info(`Open-Meteo forecast for ${city.name}: today high = ${todayHighC}°C (${result.maxTodayF}°F)`);
  return result;
}

/**
 * Get forecasts for all supported cities
 */
async function getAllForecasts() {
  const cacheKey = 'all_forecasts';
  const cached = cache.get(cacheKey);
  if (cached) return cached;

  const results = {};
  const cities = Object.keys(CITY_COORDS);

  // Fetch in parallel (batches of 5 to avoid rate limits)
  for (let i = 0; i < cities.length; i += 5) {
    const batch = cities.slice(i, i + 5);
    const promises = batch.map((c) => getForecast(c).then((f) => ({ city: c, forecast: f })));
    const batchResults = await Promise.allSettled(promises);

    for (const result of batchResults) {
      if (result.status === 'fulfilled' && result.value.forecast) {
        results[result.value.city] = result.value.forecast;
      }
    }
  }

  cache.set(cacheKey, results);
  return results;
}

/**
 * Get list of supported cities
 */
function getSupportedCities() {
  return Object.entries(CITY_COORDS).map(([key, val]) => ({
    key,
    name: val.name,
    country: val.country,
    isUS: US_CITIES.includes(key),
  }));
}

/**
 * Find city coordinates by name (fuzzy match)
 */
function findCity(name) {
  const key = name.toLowerCase().trim();
  if (CITY_COORDS[key]) return { key, ...CITY_COORDS[key] };

  // Fuzzy search
  for (const [k, v] of Object.entries(CITY_COORDS)) {
    if (v.name.toLowerCase().includes(key) || k.includes(key)) {
      return { key: k, ...v };
    }
  }
  return null;
}

// ── Helpers ──

function celsiusToFahrenheit(c) {
  return Math.round((c * 9) / 5 + 32);
}

function fahrenheitToCelsius(f) {
  return Math.round(((f - 32) * 5) / 9);
}

module.exports = {
  getForecast,
  getAllForecasts,
  getSupportedCities,
  findCity,
  celsiusToFahrenheit,
  fahrenheitToCelsius,
  CITY_COORDS,
};
