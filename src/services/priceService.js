// ============= services/priceService.js =============
const axios = require("axios");
const Price = require("../models/Price");

// ── Console logger (replaces logger import) ──────────────────────────
const useColor = !process.env.NO_COLOR;
const c = {
  reset:  useColor ? "\x1b[0m"  : "",
  bold:   useColor ? "\x1b[1m"  : "",
  cyan:   useColor ? "\x1b[36m" : "",
  green:  useColor ? "\x1b[32m" : "",
  yellow: useColor ? "\x1b[33m" : "",
  red:    useColor ? "\x1b[31m" : "",
  gray:   useColor ? "\x1b[90m" : "",
};
function ts() { return `${c.gray}[${new Date().toISOString()}]${c.reset}`; }
const log = {
  info:  (msg) => console.log( `${ts()} ${c.cyan}${c.bold}[PriceService]${c.reset} ${msg}`),
  ok:    (msg) => console.log( `${ts()} ${c.green}${c.bold}[PriceService]${c.reset} ${msg}`),
  warn:  (msg) => console.warn(`${ts()} ${c.yellow}${c.bold}[PriceService]${c.reset} ${msg}`),
  error: (msg) => console.error(`${ts()} ${c.red}${c.bold}[PriceService]${c.reset} ${msg}`),
};

// ── Config ───────────────────────────────────────────────────────────
const CACHE_TTL_MS    = parseInt(process.env.PRICE_CACHE_TTL_MS    || "60000",  10); // 60s fresh
const STALE_TTL_MS    = parseInt(process.env.PRICE_STALE_TTL_MS    || "300000", 10); // 5min stale ok
const BASE_BACKOFF_MS = parseInt(process.env.PRICE_BASE_BACKOFF_MS || "2000",   10); // 2s base

// Emergency fallback if CoinGecko is completely unreachable.
// Update these in .env if the real values drift significantly.
const EMERGENCY_USD_NGN  = parseFloat(process.env.EMERGENCY_USD_NGN  || "1620");
const EMERGENCY_STX_USD  = parseFloat(process.env.EMERGENCY_STX_USD  || "1.14");
const EMERGENCY_USDC_USD = parseFloat(process.env.EMERGENCY_USDC_USD || "1.00");

const COINGECKO_IDS = {
  STX:  "blockstack",
  USDC: "usd-coin",
};

// ── In-memory cache ──────────────────────────────────────────────────
// Kept compatible with original shape so callers don't change
let cache = {
  STX:         null,
  USDC:        null,
  lastFetched: null,
};

// Backoff state
let backoffUntil        = 0;
let consecutiveFailures = 0;

// Prevents concurrent fetches from firing multiple CoinGecko requests.
// All callers share one in-flight promise while a fetch is happening.
let inFlightFetch = null;

// ── Cache helpers ────────────────────────────────────────────────────

function cacheAgeMs() {
  return cache.lastFetched
    ? Date.now() - new Date(cache.lastFetched).getTime()
    : Infinity;
}

function hasFreshCache() {
  return !!(cache.STX && cache.USDC && cacheAgeMs() < CACHE_TTL_MS);
}

function hasUsableStaleCache() {
  return !!(cache.STX && cache.USDC && cacheAgeMs() < STALE_TTL_MS);
}

// ── Emergency fallback ───────────────────────────────────────────────

function buildEmergencyResults() {
  const usdToNgn = EMERGENCY_USD_NGN;
  const now      = new Date();
  const results  = {
    STX: {
      priceUSD:  EMERGENCY_STX_USD,
      priceNGN:  EMERGENCY_STX_USD  * usdToNgn,
      usdToNgn,
      change24h: 0,
      fetchedAt: now,
    },
    USDC: {
      priceUSD:  EMERGENCY_USDC_USD,
      priceNGN:  EMERGENCY_USDC_USD * usdToNgn,
      usdToNgn,
      change24h: 0,
      fetchedAt: now,
    },
  };
  log.warn(
    `⚠️  EMERGENCY FALLBACK RATES ACTIVE\n` +
    `   STX  $${EMERGENCY_STX_USD}  → ₦${results.STX.priceNGN.toFixed(2)}\n` +
    `   USDC $${EMERGENCY_USDC_USD} → ₦${results.USDC.priceNGN.toFixed(2)}\n` +
    `   USD/NGN ₦${usdToNgn}  (override with EMERGENCY_USD_NGN in .env)`
  );
  return results;
}

// ── CoinGecko fetch ──────────────────────────────────────────────────
// Original code fired TWO requests (fetchUsdToNgn + fetchTokenPricesUSD).
// This combines them into ONE call, halving API usage.

async function fetchFromCoinGecko() {
  // Include "tether" as USD/NGN proxy in the same request
  const ids = [...Object.values(COINGECKO_IDS), "tether"].join(",");

  log.info(`→ CoinGecko: ids=[${ids}] vs=[usd,ngn]`);

  const res = await axios.get(`${process.env.COINGECKO_API_URL}/simple/price`, {
    params: {
      ids,
      vs_currencies:       "usd,ngn",
      include_24hr_change: true,
    },
    timeout: 10000,
  });

  const raw = res.data;

  // USD→NGN: prefer USDT proxy, fall back to USDC NGN price, then emergency const
  const usdToNgn =
    raw.tether?.ngn        ||
    raw["usd-coin"]?.ngn   ||
    EMERGENCY_USD_NGN;

  if (!raw.tether?.ngn && !raw["usd-coin"]?.ngn) {
    log.warn(`USD/NGN missing from CoinGecko response — using fallback ₦${usdToNgn}`);
  }

  const now     = new Date();
  const results = {};

  for (const [symbol, geckoId] of Object.entries(COINGECKO_IDS)) {
    const priceUSD = raw[geckoId]?.usd;
    if (!priceUSD) {
      log.warn(`No price data for ${symbol} (${geckoId}) in CoinGecko response`);
      continue;
    }

    // Prefer the NGN price from CoinGecko directly; compute from rate as fallback
    const priceNGN = raw[geckoId]?.ngn || priceUSD * usdToNgn;

    // DB snapshot — best-effort, don't let a DB error block the response
    Price.create({ token: symbol, priceUSD, priceNGN, usdToNgn, fetchedAt: now }).catch((dbErr) => {
      log.warn(`DB snapshot failed for ${symbol}: ${dbErr.message}`);
    });

    results[symbol] = {
      priceUSD,
      priceNGN,
      usdToNgn,
      change24h: raw[geckoId]?.usd_24h_change ?? 0,
      fetchedAt: now,
    };
  }

  if (!results.STX || !results.USDC) {
    throw new Error("CoinGecko response missing STX or USDC — cannot build quote");
  }

  return results;
}

// ── refreshPrices (replaces original — now never throws) ────────────

async function refreshPrices() {
  const now = Date.now();

  // Still inside backoff window — don't attempt CoinGecko
  if (now < backoffUntil) {
    const waitSec = Math.ceil((backoffUntil - now) / 1000);
    log.warn(`Backoff active — ${waitSec}s left before next CoinGecko attempt`);

    if (hasUsableStaleCache()) {
      log.warn(`Serving stale cache (age: ${Math.floor(cacheAgeMs() / 1000)}s)`);
      return { STX: cache.STX, USDC: cache.USDC };
    }
    return buildEmergencyResults();
  }

  try {
    const results = await fetchFromCoinGecko();

    // Success — reset backoff and update cache
    consecutiveFailures = 0;
    backoffUntil        = 0;
    cache               = { ...results, lastFetched: new Date() };

    log.ok(
      `Prices refreshed ✓\n` +
      `   STX  ${c.bold}$${results.STX.priceUSD.toFixed(4)}${c.reset}  ₦${results.STX.priceNGN.toFixed(2)}  ` +
      `(${results.STX.change24h >= 0 ? "+" : ""}${results.STX.change24h.toFixed(2)}%)\n` +
      `   USDC ${c.bold}$${results.USDC.priceUSD.toFixed(4)}${c.reset}  ₦${results.USDC.priceNGN.toFixed(2)}\n` +
      `   USD/NGN ₦${results.STX.usdToNgn.toFixed(2)}`
    );

    return results;

  } catch (err) {
    consecutiveFailures++;
    const status = err.response?.status;

    if (status === 429) {
      // Exponential backoff capped at 5 minutes
      const delay = Math.min(BASE_BACKOFF_MS * Math.pow(2, consecutiveFailures - 1), 300_000);
      backoffUntil = Date.now() + delay;
      log.warn(
        `429 from CoinGecko (failure #${consecutiveFailures})\n` +
        `   Backing off ${delay / 1000}s → next attempt after ${new Date(backoffUntil).toLocaleTimeString()}\n` +
        `   Tip: raise PRICE_CACHE_TTL_MS in .env to reduce request frequency`
      );
    } else {
      log.error(`Price refresh failed (failure #${consecutiveFailures}): ${err.message}`);
    }

    // Prefer stale cache over emergency rates
    if (hasUsableStaleCache()) {
      log.warn(`Serving stale cache (age: ${Math.floor(cacheAgeMs() / 1000)}s) after fetch failure`);
      return { STX: cache.STX, USDC: cache.USDC };
    }

    // Nothing usable in cache — return emergency rates so the caller gets 200 not 500
    const emergency = buildEmergencyResults();
    // Cache briefly so we don't hammer CoinGecko on every request during an outage
    cache = { ...emergency, lastFetched: new Date(Date.now() - CACHE_TTL_MS + 30_000) };
    return emergency;
  }
}

// ── getCurrentPrices (public, never throws) ──────────────────────────

async function getCurrentPrices() {
  // Hot path — serve from fresh cache, no network call
  if (hasFreshCache()) {
    log.info(
      `Cache hit (age: ${Math.floor(cacheAgeMs() / 1000)}s / TTL: ${CACHE_TTL_MS / 1000}s) ` +
      `STX ₦${cache.STX.priceNGN.toFixed(2)} | USDC ₦${cache.USDC.priceNGN.toFixed(2)}`
    );
    return { STX: cache.STX, USDC: cache.USDC, fromCache: true };
  }

  // Deduplicate concurrent callers — share one in-flight fetch
  if (inFlightFetch) {
    log.info("Fetch in progress — awaiting shared result...");
    const result = await inFlightFetch;
    return { ...result, fromCache: false };
  }

  log.info(
    cache.lastFetched
      ? `Cache stale (age: ${Math.floor(cacheAgeMs() / 1000)}s) — refreshing...`
      : "First fetch — no cache yet..."
  );

  inFlightFetch = refreshPrices().finally(() => { inFlightFetch = null; });

  const result = await inFlightFetch;
  return { ...result, fromCache: false };
}

// ── getPriceHistory (unchanged) ──────────────────────────────────────

async function getPriceHistory(token, hours = 24) {
  const since = new Date(Date.now() - hours * 60 * 60 * 1000);
  return Price.find({ token, fetchedAt: { $gte: since } })
    .sort({ fetchedAt: 1 })
    .select("priceNGN priceUSD fetchedAt -_id")
    .lean();
}

// ── Background refresh ───────────────────────────────────────────────
// Call startPriceRefresh() in server.js so the cache is always warm
// and requests never stall waiting for a CoinGecko round-trip.

let _refreshInterval = null;

function startPriceRefresh() {
  if (_refreshInterval) return;

  // Warm the cache on startup
  getCurrentPrices().catch(() => {});

  _refreshInterval = setInterval(async () => {
    if (hasFreshCache()) {
      log.info(`Background tick — cache still fresh (${Math.floor(cacheAgeMs() / 1000)}s old), skipping`);
      return;
    }
    log.info("Background refresh — cache stale, fetching...");
    await refreshPrices();
  }, CACHE_TTL_MS);

  log.ok(
    `Background refresh started\n` +
    `   Interval   : every ${CACHE_TTL_MS / 1000}s\n` +
    `   Stale limit: ${STALE_TTL_MS / 1000}s\n` +
    `   Backoff base: ${BASE_BACKOFF_MS / 1000}s (doubles on each 429, capped at 5min)`
  );
}

function stopPriceRefresh() {
  if (_refreshInterval) {
    clearInterval(_refreshInterval);
    _refreshInterval = null;
    log.info("Background refresh stopped");
  }
}

module.exports = {
  getCurrentPrices,
  refreshPrices,
  getPriceHistory,
  startPriceRefresh,
  stopPriceRefresh,
};