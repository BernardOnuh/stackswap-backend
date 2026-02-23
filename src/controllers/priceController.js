const { getCurrentPrices, getPriceHistory, refreshPrices } = require("../services/priceService");
const logger = require("../config/logger");

// GET /api/prices
async function getLivePrices(req, res) {
  try {
    const prices = await getCurrentPrices();
    res.json({
      success: true,
      data: {
        STX: {
          priceNGN: prices.STX.priceNGN,
          priceUSD: prices.STX.priceUSD,
          change24h: prices.STX.change24h,
        },
        USDC: {
          priceNGN: prices.USDC.priceNGN,
          priceUSD: prices.USDC.priceUSD,
          change24h: prices.USDC.change24h,
        },
        usdToNgn: prices.STX.usdToNgn,
        fromCache: prices.fromCache,
        fetchedAt: prices.STX.fetchedAt,
      },
    });
  } catch (err) {
    logger.error(`getLivePrices error: ${err.message}`);
    res.status(502).json({ success: false, message: "Failed to fetch prices. Try again shortly." });
  }
}

// GET /api/prices/:token (STX or USDC)
async function getTokenPrice(req, res) {
  const { token } = req.params;
  const upper = token.toUpperCase();

  if (!["STX", "USDC"].includes(upper)) {
    return res.status(400).json({ success: false, message: "Invalid token. Use STX or USDC." });
  }

  try {
    const prices = await getCurrentPrices();
    const data = prices[upper];
    res.json({ success: true, data: { token: upper, ...data } });
  } catch (err) {
    logger.error(`getTokenPrice error: ${err.message}`);
    res.status(502).json({ success: false, message: "Price fetch failed." });
  }
}

// GET /api/prices/:token/history?hours=24
async function getHistory(req, res) {
  const { token } = req.params;
  const hours = Math.min(parseInt(req.query.hours) || 24, 168); // cap at 7 days
  const upper = token.toUpperCase();

  if (!["STX", "USDC"].includes(upper)) {
    return res.status(400).json({ success: false, message: "Invalid token." });
  }

  try {
    const history = await getPriceHistory(upper, hours);
    res.json({ success: true, token: upper, hours, count: history.length, data: history });
  } catch (err) {
    logger.error(`getHistory error: ${err.message}`);
    res.status(500).json({ success: false, message: "Failed to retrieve price history." });
  }
}

// POST /api/prices/refresh (manual trigger — admin use)
async function forceRefresh(req, res) {
  try {
    const prices = await refreshPrices();
    res.json({ success: true, message: "Prices refreshed.", data: prices });
  } catch (err) {
    res.status(502).json({ success: false, message: "Refresh failed." });
  }
}

module.exports = { getLivePrices, getTokenPrice, getHistory, forceRefresh };
