'use strict';

/**
 * Polymarket CLOB Trading Client
 * 
 * Handles order placement (buy/sell), cancellation, position tracking,
 * and balance queries via the Polymarket CLOB API.
 * 
 * IMPORTANT: Trading involves real funds. Use at your own risk.
 */

const { ClobClient, Side, OrderType } = require('@polymarket/clob-client-v2');
const { createWalletClient, http } = require('viem');
const { privateKeyToAccount } = require('viem/accounts');
const { polygon } = require('viem/chains');
const config = require('./config');
const logger = require('./logger');
const cache = require('./cache');

const CHAIN_ID = 137; // Polygon mainnet

let clobClient = null;
let isInitialized = false;
let apiCreds = null;

/**
 * Initialize the CLOB trading client
 */
async function initialize() {
  if (isInitialized) return true;

  if (!config.trading.privateKey) {
    logger.warn('Trading disabled: PRIVATE_KEY not configured');
    return false;
  }

  try {
    const account = privateKeyToAccount(config.trading.privateKey);
    const signer = createWalletClient({
      account,
      chain: polygon,
      transport: http(config.trading.rpcUrl),
    });

    // First, derive API credentials
    const tempClient = new ClobClient({
      host: config.polymarket.clobApiBase,
      chain: CHAIN_ID,
      signer,
    });

    apiCreds = await tempClient.createOrDeriveApiKey();
    logger.info('CLOB API credentials derived successfully');

    // Initialize full trading client
    clobClient = new ClobClient({
      host: config.polymarket.clobApiBase,
      chain: CHAIN_ID,
      signer,
      creds: apiCreds,
      signatureType: config.trading.signatureType,
      funderAddress: config.trading.funderAddress || account.address,
    });

    isInitialized = true;
    logger.info('Trading client initialized successfully');
    logger.info(`Wallet: ${account.address}`);
    logger.info(`Funder: ${config.trading.funderAddress || account.address}`);
    return true;
  } catch (error) {
    logger.error('Failed to initialize trading client:', error.message);
    return false;
  }
}

/**
 * Check if trading is ready
 */
function isReady() {
  return isInitialized && clobClient !== null;
}

/**
 * Place a BUY order (limit order)
 * @param {string} tokenId - The token ID to buy
 * @param {number} price - The limit price (0.01 - 0.99)
 * @param {number} size - Number of shares to buy
 * @param {object} options - Additional options (tickSize, negRisk)
 * @returns {object} Order response
 */
async function placeBuyOrder(tokenId, price, size, options = {}) {
  if (!isReady()) throw new Error('Trading client not initialized');

  const tickSize = options.tickSize || '0.01';
  const negRisk = options.negRisk || false;

  logger.info(`Placing BUY order: token=${tokenId}, price=${price}, size=${size}`);

  try {
    const response = await clobClient.createAndPostOrder(
      {
        tokenID: tokenId,
        price,
        size,
        side: Side.BUY,
      },
      {
        tickSize,
        negRisk,
      },
      OrderType.GTC,
    );

    logger.info(`BUY order placed: ID=${response.orderID}, status=${response.status}`);
    return {
      success: true,
      orderId: response.orderID,
      status: response.status,
      side: 'BUY',
      price,
      size,
      tokenId,
    };
  } catch (error) {
    logger.error(`BUY order failed: ${error.message}`);
    return {
      success: false,
      error: error.message,
      side: 'BUY',
      price,
      size,
      tokenId,
    };
  }
}

/**
 * Place a SELL order (limit order)
 * @param {string} tokenId - The token ID to sell
 * @param {number} price - The limit price (0.01 - 0.99)
 * @param {number} size - Number of shares to sell
 * @param {object} options - Additional options (tickSize, negRisk)
 * @returns {object} Order response
 */
async function placeSellOrder(tokenId, price, size, options = {}) {
  if (!isReady()) throw new Error('Trading client not initialized');

  const tickSize = options.tickSize || '0.01';
  const negRisk = options.negRisk || false;

  logger.info(`Placing SELL order: token=${tokenId}, price=${price}, size=${size}`);

  try {
    const response = await clobClient.createAndPostOrder(
      {
        tokenID: tokenId,
        price,
        size,
        side: Side.SELL,
      },
      {
        tickSize,
        negRisk,
      },
      OrderType.GTC,
    );

    logger.info(`SELL order placed: ID=${response.orderID}, status=${response.status}`);
    return {
      success: true,
      orderId: response.orderID,
      status: response.status,
      side: 'SELL',
      price,
      size,
      tokenId,
    };
  } catch (error) {
    logger.error(`SELL order failed: ${error.message}`);
    return {
      success: false,
      error: error.message,
      side: 'SELL',
      price,
      size,
      tokenId,
    };
  }
}

/**
 * Place a market BUY order (FOK - Fill or Kill)
 * @param {string} tokenId - The token ID to buy
 * @param {number} amount - Dollar amount to spend
 * @param {number} worstPrice - Maximum price willing to pay (slippage protection)
 * @param {object} options - Additional options
 * @returns {object} Order response
 */
async function marketBuy(tokenId, amount, worstPrice, options = {}) {
  if (!isReady()) throw new Error('Trading client not initialized');

  const tickSize = options.tickSize || '0.01';
  const negRisk = options.negRisk || false;

  logger.info(`Placing MARKET BUY: token=${tokenId}, amount=$${amount}, maxPrice=${worstPrice}`);

  try {
    const signedOrder = await clobClient.createMarketOrder(
      {
        tokenID: tokenId,
        side: Side.BUY,
        amount,
        price: worstPrice,
      },
      { tickSize, negRisk },
    );

    const response = await clobClient.postOrder(signedOrder, OrderType.FOK);

    logger.info(`MARKET BUY executed: ID=${response.orderID}, status=${response.status}`);
    return {
      success: true,
      orderId: response.orderID,
      status: response.status,
      side: 'BUY',
      amount,
      worstPrice,
      tokenId,
      type: 'MARKET',
    };
  } catch (error) {
    logger.error(`MARKET BUY failed: ${error.message}`);
    return {
      success: false,
      error: error.message,
      side: 'BUY',
      amount,
      tokenId,
      type: 'MARKET',
    };
  }
}

/**
 * Place a market SELL order (FOK - Fill or Kill)
 * @param {string} tokenId - The token ID to sell
 * @param {number} shares - Number of shares to sell
 * @param {number} worstPrice - Minimum price willing to accept (slippage protection)
 * @param {object} options - Additional options
 * @returns {object} Order response
 */
async function marketSell(tokenId, shares, worstPrice, options = {}) {
  if (!isReady()) throw new Error('Trading client not initialized');

  const tickSize = options.tickSize || '0.01';
  const negRisk = options.negRisk || false;

  logger.info(`Placing MARKET SELL: token=${tokenId}, shares=${shares}, minPrice=${worstPrice}`);

  try {
    const signedOrder = await clobClient.createMarketOrder(
      {
        tokenID: tokenId,
        side: Side.SELL,
        amount: shares,
        price: worstPrice,
      },
      { tickSize, negRisk },
    );

    const response = await clobClient.postOrder(signedOrder, OrderType.FOK);

    logger.info(`MARKET SELL executed: ID=${response.orderID}, status=${response.status}`);
    return {
      success: true,
      orderId: response.orderID,
      status: response.status,
      side: 'SELL',
      shares,
      worstPrice,
      tokenId,
      type: 'MARKET',
    };
  } catch (error) {
    logger.error(`MARKET SELL failed: ${error.message}`);
    return {
      success: false,
      error: error.message,
      side: 'SELL',
      shares,
      tokenId,
      type: 'MARKET',
    };
  }
}

/**
 * Cancel a specific order
 */
async function cancelOrder(orderId) {
  if (!isReady()) throw new Error('Trading client not initialized');

  try {
    const response = await clobClient.cancelOrder(orderId);
    logger.info(`Order cancelled: ${orderId}`);
    return { success: true, canceled: response.canceled };
  } catch (error) {
    logger.error(`Cancel order failed: ${error.message}`);
    return { success: false, error: error.message };
  }
}

/**
 * Cancel all open orders
 */
async function cancelAllOrders() {
  if (!isReady()) throw new Error('Trading client not initialized');

  try {
    const response = await clobClient.cancelAll();
    logger.info(`All orders cancelled: ${response.canceled?.length || 0} orders`);
    return { success: true, canceled: response.canceled };
  } catch (error) {
    logger.error(`Cancel all orders failed: ${error.message}`);
    return { success: false, error: error.message };
  }
}

/**
 * Get all open orders
 */
async function getOpenOrders(market = null) {
  if (!isReady()) throw new Error('Trading client not initialized');

  try {
    const params = market ? { market } : undefined;
    const orders = await clobClient.getOpenOrders(params);
    return orders || [];
  } catch (error) {
    logger.error(`Get open orders failed: ${error.message}`);
    return [];
  }
}

/**
 * Get trade history
 */
async function getTrades(params = {}) {
  if (!isReady()) throw new Error('Trading client not initialized');

  try {
    const trades = await clobClient.getTrades(params);
    return trades || [];
  } catch (error) {
    logger.error(`Get trades failed: ${error.message}`);
    return [];
  }
}

/**
 * Get balance and allowance for collateral (pUSD)
 */
async function getBalance() {
  if (!isReady()) throw new Error('Trading client not initialized');

  try {
    const balance = await clobClient.getBalanceAllowance({
      asset_type: 'COLLATERAL',
    });
    return {
      balance: balance?.balance || '0',
      allowance: balance?.allowance || '0',
    };
  } catch (error) {
    logger.error(`Get balance failed: ${error.message}`);
    return { balance: '0', allowance: '0' };
  }
}

/**
 * Get token balance for a specific conditional token
 */
async function getTokenBalance(tokenId) {
  if (!isReady()) throw new Error('Trading client not initialized');

  try {
    const balance = await clobClient.getBalanceAllowance({
      asset_type: 'CONDITIONAL',
      token_id: tokenId,
    });
    return {
      balance: balance?.balance || '0',
      allowance: balance?.allowance || '0',
    };
  } catch (error) {
    logger.error(`Get token balance failed: ${error.message}`);
    return { balance: '0', allowance: '0' };
  }
}

/**
 * Get tick size for a market
 */
async function getTickSize(tokenId) {
  if (!isReady()) throw new Error('Trading client not initialized');

  try {
    const tickSize = await clobClient.getTickSize(tokenId);
    return tickSize;
  } catch (error) {
    logger.error(`Get tick size failed: ${error.message}`);
    return '0.01'; // Default
  }
}

/**
 * Get neg risk status for a market
 */
async function getNegRisk(tokenId) {
  if (!isReady()) throw new Error('Trading client not initialized');

  try {
    const negRisk = await clobClient.getNegRisk(tokenId);
    return negRisk;
  } catch (error) {
    logger.error(`Get neg risk failed: ${error.message}`);
    return false; // Default
  }
}

/**
 * Get the current best price for a token
 */
async function getPrice(tokenId, side = 'BUY') {
  if (!isReady()) throw new Error('Trading client not initialized');

  try {
    const price = await clobClient.getPrice(tokenId, side);
    return parseFloat(price?.price || '0');
  } catch (error) {
    logger.error(`Get price failed: ${error.message}`);
    return 0;
  }
}

/**
 * Get orderbook for a token
 */
async function getOrderbook(tokenId) {
  if (!isReady()) throw new Error('Trading client not initialized');

  try {
    const book = await clobClient.getOrderBook(tokenId);
    return book;
  } catch (error) {
    logger.error(`Get orderbook failed: ${error.message}`);
    return null;
  }
}

module.exports = {
  initialize,
  isReady,
  placeBuyOrder,
  placeSellOrder,
  marketBuy,
  marketSell,
  cancelOrder,
  cancelAllOrders,
  getOpenOrders,
  getTrades,
  getBalance,
  getTokenBalance,
  getTickSize,
  getNegRisk,
  getPrice,
  getOrderbook,
};
