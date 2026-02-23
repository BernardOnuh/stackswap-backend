const express = require("express");
const router = express.Router();
const { getLivePrices, getTokenPrice, getHistory, forceRefresh } = require("../controllers/priceController");

/**
 * @swagger
 * /api/prices:
 *   get:
 *     summary: Get all live token prices in NGN
 *     tags: [Prices]
 *     responses:
 *       200:
 *         description: Live STX and USDC prices
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/PricesResponse'
 *       502:
 *         description: Failed to fetch from price feed
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorResponse'
 */
router.get("/", getLivePrices);

/**
 * @swagger
 * /api/prices/{token}:
 *   get:
 *     summary: Get price for a single token
 *     tags: [Prices]
 *     parameters:
 *       - in: path
 *         name: token
 *         required: true
 *         schema:
 *           type: string
 *           enum: [STX, USDC]
 *         example: STX
 *     responses:
 *       200:
 *         description: Token price in NGN and USD
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                 data:
 *                   allOf:
 *                     - $ref: '#/components/schemas/Price'
 *                     - type: object
 *                       properties:
 *                         token:
 *                           type: string
 *                           example: STX
 *       400:
 *         description: Invalid token
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorResponse'
 */
router.get("/:token", getTokenPrice);

/**
 * @swagger
 * /api/prices/{token}/history:
 *   get:
 *     summary: Get historical prices for a token
 *     tags: [Prices]
 *     parameters:
 *       - in: path
 *         name: token
 *         required: true
 *         schema:
 *           type: string
 *           enum: [STX, USDC]
 *         example: STX
 *       - in: query
 *         name: hours
 *         schema:
 *           type: integer
 *           default: 24
 *           maximum: 168
 *         description: Hours of history to return (max 168 = 7 days)
 *     responses:
 *       200:
 *         description: Price history array
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                 token:
 *                   type: string
 *                 hours:
 *                   type: integer
 *                 count:
 *                   type: integer
 *                 data:
 *                   type: array
 *                   items:
 *                     type: object
 *                     properties:
 *                       priceNGN:
 *                         type: number
 *                       priceUSD:
 *                         type: number
 *                       fetchedAt:
 *                         type: string
 *                         format: date-time
 */
router.get("/:token/history", getHistory);

/**
 * @swagger
 * /api/prices/refresh:
 *   post:
 *     summary: Force refresh prices from CoinGecko
 *     tags: [Prices]
 *     responses:
 *       200:
 *         description: Prices refreshed successfully
 *       502:
 *         description: Refresh failed
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorResponse'
 */
router.post("/refresh", forceRefresh);

module.exports = router;