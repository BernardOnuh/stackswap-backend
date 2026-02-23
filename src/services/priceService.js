const axios = require("axios");
const Price = require("../models/Price");
const logger = require("../config/logger");

// In-memory cache so we don't hammer CoinGecko on every request
let cache = {
  STX: null,
  USDC: null,
  lastFetched: null,
};

const CACHE_TTL_MS = 60_000; // 1 minute

const COINGECKO_IDS = {
  STX: "blockstack",
  USDC: "usd-coin",
};

/**
 * Fetch USD→NGN rate from CoinGecko's simple/price endpoint
 */
async function fetchUsdToNgn() {
  const res = await axios.get(`${process.env.COINGECKO_API_URL}/simple/price`, {
    params: {
      ids: "tether",        // Use USDT as USD proxy
      vs_currencies: "ngn",
    },
    timeout: 8000,
  });
  return res.data.tether.ngn;
}

/**
 * Fetch STX and USDC prices in USD from CoinGecko
 */
async function fetchTokenPricesUSD() {
  const ids = Object.values(COINGECKO_IDS).join(",");
  const res = await axios.get(`${process.env.COINGECKO_API_URL}/simple/price`, {
    params: {
      ids,
      vs_currencies: "usd",
      include_24hr_change: true,
    },
    timeout: 8000,
  });
  return res.data;
}

/**
 * Main function: refresh prices and save to DB
 */
async function refreshPrices() {
  try {
    const [usdNgn, tokenData] = await Promise.all([
      fetchUsdToNgn(),
      fetchTokenPricesUSD(),
    ]);

    const now = new Date();
    const results = {};

    for (const [symbol, geckoId] of Object.entries(COINGECKO_IDS)) {
      const priceUSD = tokenData[geckoId]?.usd;
      if (!priceUSD) continue;

      const priceNGN = priceUSD * usdNgn;

      // Save snapshot to DB
      await Price.create({
        token: symbol,
        priceUSD,
        priceNGN,
        usdToNgn: usdNgn,
        fetchedAt: now,
      });

      results[symbol] = {
        priceUSD,
        priceNGN,
        usdToNgn: usdNgn,
        change24h: tokenData[geckoId]?.usd_24h_change ?? 0,
        fetchedAt: now,
      };
    }

    // Update memory cache
    cache = { ...results, lastFetched: now };
    logger.info(`Prices refreshed — STX: ₦${results.STX?.priceNGN?.toFixed(2)}, USDC: ₦${results.USDC?.priceNGN?.toFixed(2)}`);

    return results;
  } catch (err) {
    logger.error(`Price refresh failed: ${err.message}`);
    throw err;
  }
}

/**
 * Get current prices — from cache if fresh, else fetch
 */
async function getCurrentPrices() {
  const cacheAge = cache.lastFetched ? Date.now() - new Date(cache.lastFetched).getTime() : Infinity;

  if (cacheAge < CACHE_TTL_MS && cache.STX && cache.USDC) {
    return { STX: cache.STX, USDC: cache.USDC, fromCache: true };
  }

  const fresh = await refreshPrices();
  return { ...fresh, fromCache: false };
}

/**
 * Get price history for a token from DB
 */
async function getPriceHistory(token, hours = 24) {
  const since = new Date(Date.now() - hours * 60 * 60 * 1000);
  return Price.find({ token, fetchedAt: { $gte: since } })
    .sort({ fetchedAt: 1 })
    .select("priceNGN priceUSD fetchedAt -_id")
    .lean();
}

module.exports = { getCurrentPrices, refreshPrices, getPriceHistory };
