// ============= routes/onramp.js =============

const express = require("express");
const router = express.Router();
const {
  getOnrampRate,
  initializeOnramp,
  handleMonnifyWebhook,
  verifyOnramp,
  getOnrampHistory,
} = require("../controllers/onrampController");

/**
 * @swagger
 * /api/onramp/rate:
 *   get:
 *     summary: Get onramp quote — how many STX/USDC you receive for a given NGN amount
 *     tags: [Onramp]
 *     parameters:
 *       - in: query
 *         name: token
 *         schema:
 *           type: string
 *           enum: [STX, USDC]
 *           default: STX
 *       - in: query
 *         name: amountNGN
 *         schema:
 *           type: number
 *         description: Optional. If provided, returns full calculation breakdown.
 *         example: 50000
 *     responses:
 *       200:
 *         description: Onramp rate and optional calculation
 */
router.get("/rate", getOnrampRate);

/**
 * @swagger
 * /api/onramp/initialize:
 *   post:
 *     summary: Initialize onramp — creates transaction and returns Monnify payment config
 *     tags: [Onramp]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [token, amountNGN, stacksAddress, customerEmail]
 *             properties:
 *               token:
 *                 type: string
 *                 enum: [STX, USDC]
 *                 example: STX
 *               amountNGN:
 *                 type: number
 *                 example: 50000
 *               stacksAddress:
 *                 type: string
 *                 example: SP3EWE151DHDTV7CP5D7N2YYESA3VEH3TBPNTT4EV
 *               customerEmail:
 *                 type: string
 *                 format: email
 *                 example: user@example.com
 *               customerPhone:
 *                 type: string
 *                 example: "08012345678"
 *     responses:
 *       201:
 *         description: Transaction created. Use monnifyConfig on the frontend to launch payment modal.
 *       400:
 *         description: Validation error
 */
router.post("/initialize", initializeOnramp);

/**
 * @swagger
 * /api/onramp/webhook:
 *   post:
 *     summary: Monnify payment webhook — auto-credits STX/USDC on successful payment
 *     tags: [Onramp]
 *     description: Called by Monnify after payment. Verifies HMAC-SHA512 signature and credits tokens to the Stacks wallet.
 *     responses:
 *       200:
 *         description: Processed
 *       401:
 *         description: Invalid or missing signature
 */
router.post("/webhook", handleMonnifyWebhook);

/**
 * @swagger
 * /api/onramp/verify/{reference}:
 *   get:
 *     summary: Check status of an onramp transaction
 *     tags: [Onramp]
 *     parameters:
 *       - in: path
 *         name: reference
 *         required: true
 *         schema:
 *           type: string
 *         example: SSWAP_ONRAMP_1720000000000_A1B2C3D4
 *     responses:
 *       200:
 *         description: Transaction details
 *       404:
 *         description: Not found
 */
router.get("/verify/:reference", verifyOnramp);

/**
 * @swagger
 * /api/onramp/history:
 *   get:
 *     summary: Get onramp history for a Stacks address
 *     tags: [Onramp]
 *     parameters:
 *       - in: query
 *         name: address
 *         required: true
 *         schema:
 *           type: string
 *         example: SP3EWE151DHDTV7CP5D7N2YYESA3VEH3TBPNTT4EV
 *       - in: query
 *         name: page
 *         schema:
 *           type: integer
 *           default: 1
 *       - in: query
 *         name: limit
 *         schema:
 *           type: integer
 *           default: 20
 *     responses:
 *       200:
 *         description: Paginated onramp history
 */
router.get("/history", getOnrampHistory);

module.exports = router;