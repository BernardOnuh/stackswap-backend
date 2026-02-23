require("dotenv").config();
const express = require("express");
const cors = require("cors");
const helmet = require("helmet");
const morgan = require("morgan");
const rateLimit = require("express-rate-limit");
const cron = require("node-cron");

const connectDB = require("./config/db");
const logger = require("./config/logger");
const { notFound, errorHandler } = require("./middleware/errorHandler");
const { refreshPrices } = require("./services/priceService");

const swaggerUi = require("swagger-ui-express");
const swaggerSpec = require("./config/swagger");

const priceRoutes = require("./routes/prices");
const transactionRoutes = require("./routes/transactions");

const app = express();
const PORT = process.env.PORT || 5000;

// ── Security & Parsing ──────────────────────────────────────────
app.use(helmet());
app.use(cors({
  origin: process.env.ALLOWED_ORIGIN || "*",
  methods: ["GET", "POST", "PATCH"],
}));
app.use(express.json({ limit: "10kb" }));
app.use(morgan("dev", { stream: { write: (msg) => logger.http(msg.trim()) } }));

// ── Rate Limiting ───────────────────────────────────────────────
const limiter = rateLimit({
  windowMs: parseInt(process.env.RATE_LIMIT_WINDOW_MS) || 60_000,
  max: parseInt(process.env.RATE_LIMIT_MAX) || 100,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, message: "Too many requests. Slow down." },
});
app.use("/api/", limiter);

// ── Health Check ────────────────────────────────────────────────
app.get("/health", (req, res) => {
  res.json({
    status: "ok",
    version: "1.0.0",
    env: process.env.NODE_ENV,
    uptime: Math.floor(process.uptime()),
    timestamp: new Date().toISOString(),
  });
});

// ── Swagger Docs ────────────────────────────────────────────────
const swaggerUiOptions = {
  customSiteTitle: "StackSwap API Docs",
  customCss: `
    body { background: #ffffff; margin: 0; }
    .swagger-ui .topbar { background: #ffffff; border-bottom: 2px solid #FF6B00; padding: 10px 0; }
    .swagger-ui .topbar-wrapper img { content: url('data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 140 30"><text y="22" font-size="18" font-weight="bold" fill="%23FF6B00">StackSwap</text></svg>'); height: 28px; }
    .swagger-ui .info .title { color: #FF6B00; font-weight: 700; }
    .swagger-ui .info .description p { color: #374151; }
    .swagger-ui .scheme-container { background: #f9fafb; box-shadow: none; border-bottom: 1px solid #e5e7eb; }
    .swagger-ui .opblock-tag { color: #111827; border-bottom: 1px solid #e5e7eb; }
    .swagger-ui .opblock-tag:hover { background: #fff7ed; }
    .swagger-ui section.models { background: #f9fafb; border: 1px solid #e5e7eb; border-radius: 8px; }
    .swagger-ui .opblock.opblock-get .opblock-summary { background: #eff6ff; border-color: #3b82f6; }
    .swagger-ui .opblock.opblock-post .opblock-summary { background: #f0fdf4; border-color: #22c55e; }
    .swagger-ui .opblock.opblock-patch .opblock-summary { background: #fffbeb; border-color: #f59e0b; }
    .swagger-ui .btn.execute { background: #FF6B00; border-color: #FF6B00; color: #fff; font-weight: 600; }
    .swagger-ui .btn.execute:hover { background: #e55a00; }
    .swagger-ui table thead tr th { color: #6b7280; border-bottom: 1px solid #e5e7eb; }
    .swagger-ui .parameter__name { color: #111827; font-weight: 600; }
    .swagger-ui .parameter__type { color: #6b7280; }
    .swagger-ui input[type=text], .swagger-ui textarea { background: #f9fafb; border: 1px solid #d1d5db; color: #111827; border-radius: 6px; }
    .swagger-ui select { background: #f9fafb; border: 1px solid #d1d5db; color: #111827; }
    .swagger-ui .highlight-code { background: #f3f4f6; }
    .swagger-ui .microlight { background: #f3f4f6 !important; color: #111827 !important; }
  `,
};
app.use(
  "/api-docs",
  swaggerUi.serve,
  swaggerUi.setup(swaggerSpec, swaggerUiOptions)
);
// Raw JSON spec
app.get("/api-docs.json", (req, res) => {
  res.setHeader("Content-Type", "application/json");
  res.send(swaggerSpec);
});

// ── API Routes ──────────────────────────────────────────────────
app.use("/api/prices", priceRoutes);
app.use("/api/transactions", transactionRoutes);

// ── 404 & Error Handlers ────────────────────────────────────────
app.use(notFound);
app.use(errorHandler);

// ── Scheduled Jobs ──────────────────────────────────────────────
// Refresh prices every 2 minutes
cron.schedule("*/2 * * * *", async () => {
  try {
    await refreshPrices();
  } catch (err) {
    logger.error(`Cron price refresh failed: ${err.message}`);
  }
});

// ── Start Server ────────────────────────────────────────────────
async function start() {
  await connectDB();

  // Warm up price cache on boot
  try {
    await refreshPrices();
    logger.info("Initial price fetch complete.");
  } catch (err) {
    logger.warn(`Initial price fetch failed (will retry): ${err.message}`);
  }

  app.listen(PORT, () => {
    logger.info(`StackSwap API running on port ${PORT} [${process.env.NODE_ENV}]`);
    logger.info(`Health check: http://localhost:${PORT}/health`);
    logger.info(`Swagger docs:  http://localhost:${PORT}/api-docs`);
  });
}

start();