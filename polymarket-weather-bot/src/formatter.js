'use strict';

/**
 * Telegram message formatting utilities.
 * Uses MarkdownV2 for rich text formatting.
 */

/**
 * Escape special characters for Telegram MarkdownV2
 */
function escapeMarkdown(text) {
  if (!text) return '';
  return text.replace(/([_*\[\]()~`>#+\-=|{}.!\\])/g, '\\$1');
}

/**
 * Format currency value
 */
function formatCurrency(value) {
  const num = parseFloat(value) || 0;
  if (num >= 1000000) {
    return `$${(num / 1000000).toFixed(2)}M`;
  }
  if (num >= 1000) {
    return `$${(num / 1000).toFixed(1)}K`;
  }
  return `$${num.toFixed(2)}`;
}

/**
 * Format percentage
 */
function formatPercent(value) {
  const num = parseFloat(value) || 0;
  return `${(num * 100).toFixed(1)}%`;
}

/**
 * Format a single market item for display
 */
function formatMarketCard(market) {
  const question = escapeMarkdown(market.question || 'Unknown Market');
  const volume = formatCurrency(market.volume || market.volume24hr || 0);
  const liquidity = formatCurrency(market.liquidity || 0);

  // Parse outcomes and prices
  let outcomesText = '';
  try {
    const outcomes = typeof market.outcomes === 'string'
      ? JSON.parse(market.outcomes)
      : (market.outcomes || []);
    const prices = typeof market.outcomePrices === 'string'
      ? JSON.parse(market.outcomePrices)
      : (market.outcomePrices || []);

    if (outcomes.length > 0 && prices.length > 0) {
      const outcomeLines = outcomes.map((outcome, i) => {
        const price = prices[i] ? formatPercent(prices[i]) : 'N/A';
        return `   ${escapeMarkdown(outcome)}: *${escapeMarkdown(price)}*`;
      });
      outcomesText = outcomeLines.join('\n');
    }
  } catch (e) {
    outcomesText = '   _Data unavailable_';
  }

  // End date
  let endText = '';
  if (market.endDate) {
    const endDate = new Date(market.endDate);
    const now = new Date();
    const diffMs = endDate - now;
    if (diffMs > 0) {
      const hours = Math.floor(diffMs / 3600000);
      const minutes = Math.floor((diffMs % 3600000) / 60000);
      if (hours > 24) {
        const days = Math.floor(hours / 24);
        endText = `${days}d ${hours % 24}h`;
      } else if (hours > 0) {
        endText = `${hours}h ${minutes}m`;
      } else {
        endText = `${minutes}m`;
      }
    } else {
      endText = 'Ended';
    }
  }

  let text = `\u{1F321} *${question}*\n`;
  if (outcomesText) {
    text += `\n${outcomesText}\n`;
  }
  text += `\n\u{1F4B0} Vol: ${escapeMarkdown(volume)}`;
  text += ` \\| Liq: ${escapeMarkdown(liquidity)}`;
  if (endText) {
    text += `\n\u{23F0} Ends in: ${escapeMarkdown(endText)}`;
  }

  return text;
}

/**
 * Format a list of markets for display
 */
function formatMarketList(markets, title = 'Weather Markets') {
  if (!markets || markets.length === 0) {
    return `\u{1F326} *${escapeMarkdown(title)}*\n\n_No active markets found\\._`;
  }

  let text = `\u{1F326} *${escapeMarkdown(title)}*\n`;
  text += `\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\n\n`;

  for (const market of markets) {
    text += formatMarketCard(market) + '\n\n';
  }

  return text;
}

/**
 * Format event details
 */
function formatEventDetail(event) {
  if (!event) {
    return '_Event not found\\._';
  }

  const title = escapeMarkdown(event.title || event.question || 'Unknown Event');
  const desc = event.description ? escapeMarkdown(event.description.slice(0, 200)) : '';
  const volume = formatCurrency(event.volume || 0);
  const liquidity = formatCurrency(event.liquidity || 0);

  let text = `\u{1F30D} *${title}*\n\n`;
  if (desc) {
    text += `${desc}\n\n`;
  }
  text += `\u{1F4CA} Volume: ${escapeMarkdown(volume)}\n`;
  text += `\u{1F4B8} Liquidity: ${escapeMarkdown(liquidity)}\n`;

  // Markets within event
  if (event.markets && event.markets.length > 0) {
    text += `\n\u{1F4CB} *Markets \\(${event.markets.length}\\):*\n\n`;
    for (const market of event.markets.slice(0, 8)) {
      text += formatMarketCard(market) + '\n\n';
    }
    if (event.markets.length > 8) {
      text += `_\\.\\.\\. and ${event.markets.length - 8} more markets_\n`;
    }
  }

  return text;
}

/**
 * Format market statistics summary
 */
function formatStats(stats) {
  if (!stats) {
    return '_Unable to load statistics\\._';
  }

  let text = `\u{1F4CA} *Polymarket Weather Stats*\n`;
  text += `\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\n\n`;
  text += `\u{1F4C8} Active Markets: *${stats.totalMarkets}*\n`;
  text += `\u{1F4B0} Total Volume: *${escapeMarkdown(formatCurrency(stats.totalVolume))}*\n`;
  text += `\u{1F4B8} Total Liquidity: *${escapeMarkdown(formatCurrency(stats.totalLiquidity))}*\n`;
  text += `\u{1F3D9} Active Cities: *${stats.activeCities.length}*\n`;

  if (stats.activeCities.length > 0) {
    text += `\n\u{1F30D} Cities: ${escapeMarkdown(stats.activeCities.join(', '))}\n`;
  }

  if (stats.topMarkets && stats.topMarkets.length > 0) {
    text += `\n\u{1F525} *Top Markets by Volume:*\n\n`;
    for (let i = 0; i < stats.topMarkets.length; i++) {
      const m = stats.topMarkets[i];
      const emoji = ['1\uFE0F\u20E3', '2\uFE0F\u20E3', '3\uFE0F\u20E3', '4\uFE0F\u20E3', '5\uFE0F\u20E3'][i] || `${i + 1}\\.`;
      text += `${emoji} ${escapeMarkdown(m.question || 'Unknown')}\n`;
      text += `    Vol: ${escapeMarkdown(formatCurrency(m.volume))}\n\n`;
    }
  }

  return text;
}

/**
 * Format help message
 */
function formatHelp() {
  let text = `\u{2601}\uFE0F *Polymarket Weather Bot*\n`;
  text += `\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\n\n`;
  text += `Track real\\-time weather prediction markets from Polymarket\\.\n\n`;
  text += `*Commands:*\n\n`;
  text += `\u{1F321} /markets \\- Active weather markets\n`;
  text += `\u{1F3D9} /city \\<name\\> \\- Markets for a specific city\n`;
  text += `\u{1F50D} /search \\<query\\> \\- Search markets\n`;
  text += `\u{1F4CA} /stats \\- Market statistics\n`;
  text += `\u{1F30D} /cities \\- Available cities\n`;
  text += `\u{1F525} /hot \\- Trending markets \\(highest volume\\)\n`;
  text += `\u{23F0} /ending \\- Markets ending soon\n`;
  text += `\u{1F514} /alerts \\- Manage price alerts\n`;
  text += `\u{2753} /help \\- Show this help\n\n`;
  text += `*Inline Navigation:*\n`;
  text += `Use the buttons below messages to navigate between pages and get detailed views\\.\n\n`;
  text += `_Data sourced from Polymarket prediction markets\\._`;

  return text;
}

/**
 * Format welcome message
 */
function formatWelcome(firstName) {
  const name = escapeMarkdown(firstName || 'there');
  let text = `\u{1F44B} *Welcome, ${name}\\!*\n\n`;
  text += `I'm your *Polymarket Weather Prediction Bot* \u{2601}\uFE0F\u{1F321}\n\n`;
  text += `I provide real\\-time data from Polymarket's weather prediction markets, `;
  text += `including temperature forecasts, odds, volumes, and more\\.\n\n`;
  text += `\u{1F680} *Quick Start:*\n`;
  text += `\u{2022} /markets \\- See all active weather markets\n`;
  text += `\u{2022} /city NYC \\- Check NYC weather predictions\n`;
  text += `\u{2022} /hot \\- See trending markets\n`;
  text += `\u{2022} /stats \\- View market statistics\n\n`;
  text += `Type /help for all commands\\.`;

  return text;
}

/**
 * Format cities list
 */
function formatCitiesList(cities) {
  if (!cities || cities.length === 0) {
    return `\u{1F3D9} *Available Cities*\n\n_No cities found with active markets\\._`;
  }

  let text = `\u{1F3D9} *Available Cities*\n`;
  text += `\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\n\n`;
  text += `Currently active weather markets for:\n\n`;

  for (const city of cities) {
    text += `\u{1F4CD} ${escapeMarkdown(city)}\n`;
  }

  text += `\n_Use /city \\<name\\> to see markets for a specific city_`;

  return text;
}

/**
 * Format alert info
 */
function formatAlertInfo(alerts) {
  if (!alerts || alerts.length === 0) {
    return `\u{1F514} *Price Alerts*\n\n_No active alerts\\._\n\nUse /alerts set to create an alert\\.`;
  }

  let text = `\u{1F514} *Your Price Alerts*\n`;
  text += `\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\n\n`;

  for (const alert of alerts) {
    const market = escapeMarkdown(alert.marketQuestion || 'Unknown');
    const target = formatPercent(alert.targetPrice);
    const direction = alert.direction === 'above' ? '\u{2B06}\uFE0F above' : '\u{2B07}\uFE0F below';
    text += `\u{2022} ${market}\n   ${direction} ${escapeMarkdown(target)}\n\n`;
  }

  return text;
}

module.exports = {
  escapeMarkdown,
  formatCurrency,
  formatPercent,
  formatMarketCard,
  formatMarketList,
  formatEventDetail,
  formatStats,
  formatHelp,
  formatWelcome,
  formatCitiesList,
  formatAlertInfo,
};
