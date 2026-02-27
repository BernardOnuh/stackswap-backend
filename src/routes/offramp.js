// ============= routes/offramp.js =============

const express = require("express");
const router  = express.Router();
const {
  getBankList,
  getOfframpRate,
  verifyAccount,
  initializeOfframp,
  notifyTxBroadcast,        // ← ADDED: triggers background poll after wallet signs
  confirmTokenReceipt,
  handleLencoWebhook,
  getOfframpStatus,
  getOfframpHistory,
} = require("../controllers/offrampController");

/**
 * Middleware: restrict an endpoint to server-to-server calls only.
 * Rejects any request missing a valid x-internal-key header.
 * Used to protect confirm-receipt from direct browser access.
 */
function requireInternalKey(req, res, next) {
  const key = req.headers["x-internal-key"];
  if (!key || key !== process.env.INTERNAL_API_KEY) {
    return res.status(401).json({ success: false, message: "Unauthorized" });
  }
  next();
}

/**
 * @swagger
 * /api/offramp/banks:
 *   get:
 *     summary: Get list of supported Nigerian banks (sorted, fintech-first)
 *     tags: [Offramp]
 *     description: |
 *       Returns all banks supported by Lenco for NGN payouts.
 *       Results are cached server-side for 24 hours.
 *       OPay, Kuda, PalmPay and other fintechs are surfaced at the top.
 *       Used by the frontend to populate the bank selector dropdown.
 *     responses:
 *       200:
 *         description: Sorted bank list
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                 data:
 *                   type: array
 *                   items:
 *                     type: object
 *                     properties:
 *                       code:
 *                         type: string
 *                         example: "100004"
 *                       name:
 *                         type: string
 *                         example: "OPay"
 *                 meta:
 *                   type: object
 *                   properties:
 *                     total:
 *                       type: integer
 *                     cachedAt:
 *                       type: string
 *                       format: date-time
 *       500:
 *         description: Failed to fetch from Lenco
 */
router.get("/banks", getBankList);

/**
 * @swagger
 * /api/offramp/rate:
 *   get:
 *     summary: Get offramp quote — how much NGN you receive for selling STX/USDC
 *     tags: [Offramp]
 *     parameters:
 *       - in: query
 *         name: token
 *         schema:
 *           type: string
 *           enum: [STX, USDC]
 *           default: STX
 *       - in: query
 *         name: tokenAmount
 *         schema:
 *           type: number
 *         description: Optional. If provided, returns full NGN calculation including fee breakdown.
 *         example: 100
 *     responses:
 *       200:
 *         description: Offramp rate and optional quote
 */
router.get("/rate", getOfframpRate);

/**
 * @swagger
 * /api/offramp/verify-account:
 *   post:
 *     summary: Verify a Nigerian bank account via Lenco
 *     tags: [Offramp]
 *     description: |
 *       Resolves account name for a given bank code + account number.
 *       Called automatically by the frontend when a 10-digit account number is entered.
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [bankCode, accountNumber]
 *             properties:
 *               bankCode:
 *                 type: string
 *                 example: "100004"
 *                 description: Bank code from /api/offramp/banks
 *               accountNumber:
 *                 type: string
 *                 example: "7043314162"
 *                 description: Must be exactly 10 digits
 *     responses:
 *       200:
 *         description: Account name and bank details
 *         content:
 *           application/json:
 *             example:
 *               success: true
 *               data:
 *                 accountName: "JOHN DOE"
 *                 accountNumber: "7043314162"
 *                 bankCode: "100004"
 *                 bankName: "OPAY"
 *       400:
 *         description: Verification failed or invalid input
 */
router.post("/verify-account", verifyAccount);

/**
 * @swagger
 * /api/offramp/initialize:
 *   post:
 *     summary: Initialize offramp — lock rate, create transaction, get deposit address
 *     tags: [Offramp]
 *     description: |
 *       Verifies the bank account, locks the live exchange rate, creates a pending
 *       transaction, and returns a deposit address + memo.
 *       The user must then send exactly `tokenAmount` of `token` to `depositInstructions.sendTo`
 *       with `transactionReference` as the memo/note within 30 minutes.
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [token, tokenAmount, stacksAddress, bankCode, accountNumber]
 *             properties:
 *               token:
 *                 type: string
 *                 enum: [STX, USDC]
 *                 example: STX
 *               tokenAmount:
 *                 type: number
 *                 example: 100
 *               stacksAddress:
 *                 type: string
 *                 example: SP3EWE151DHDTV7CP5D7N2YYESA3VEH3TBPNTT4EV
 *               bankCode:
 *                 type: string
 *                 example: "100004"
 *               accountNumber:
 *                 type: string
 *                 example: "7043314162"
 *               accountName:
 *                 type: string
 *                 example: "John Doe"
 *     responses:
 *       201:
 *         description: Transaction created. Send tokens to deposit address with reference as memo.
 *       400:
 *         description: Validation or bank verification error
 *       503:
 *         description: Deposit address not configured
 */
router.post("/initialize", initializeOfframp);

/**
 * @swagger
 * /api/offramp/notify-tx:
 *   post:
 *     summary: Notify backend that wallet has signed and broadcast the Stacks TX
 *     tags: [Offramp]
 *     description: |
 *       Called by the frontend immediately after the user approves the transaction
 *       in their wallet (Leather/Xverse) and onFinish fires with a txId.
 *       Saves the Stacks TX ID to the database and starts a background poll loop
 *       that watches the Stacks blockchain for confirmation, then triggers the
 *       Lenco NGN bank payout automatically once the TX is confirmed on-chain.
 *
 *       This endpoint responds immediately (fire-and-forget polling in background).
 *       The frontend does not need to wait for settlement — it just needs to call
 *       this once so the backend knows which TX to watch.
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [transactionReference, stacksTxId]
 *             properties:
 *               transactionReference:
 *                 type: string
 *                 description: The reference returned by /initialize (e.g. SSWAP_OFFRAMP_...)
 *                 example: SSWAP_OFFRAMP_MM4PKWOL_1DEEFEA8
 *               stacksTxId:
 *                 type: string
 *                 description: The Stacks transaction ID from the wallet's onFinish callback
 *                 example: be93a32cf499e79a70edf08edc901c5faf9afdd876975fa2aa55cd92d49
 *     responses:
 *       200:
 *         description: TX received, background polling started
 *         content:
 *           application/json:
 *             example:
 *               success: true
 *               message: "TX received. Monitoring confirmation and triggering NGN payout."
 *               data:
 *                 transactionReference: SSWAP_OFFRAMP_MM4PKWOL_1DEEFEA8
 *                 stacksTxId: be93a32cf499e79a70edf08edc901c5faf9afdd876975fa2aa55cd92d49
 *       400:
 *         description: Missing transactionReference or stacksTxId
 *       404:
 *         description: Transaction not found in database
 */
router.post("/notify-tx", notifyTxBroadcast);

/**
 * @swagger
 * /api/offramp/confirm-receipt:
 *   post:
 *     summary: "[Internal] Confirm on-chain token receipt and trigger NGN payout"
 *     tags: [Offramp]
 *     description: |
 *       Called exclusively by the server-side Stacks blockchain indexer
 *       (services/stacksIndexer.js) when it detects an inbound token transfer
 *       to the deposit address with a matching SSWAP_OFFRAMP_ memo.
 *       Triggers the Lenco NGN bank transfer.
 *
 *       SECURITY: Protected by requireInternalKey middleware (x-internal-key header).
 *       This endpoint must NEVER be called from the browser.
 *     security:
 *       - InternalApiKey: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [transactionReference, stacksTxId, tokenAmount, token]
 *             properties:
 *               transactionReference:
 *                 type: string
 *                 example: SSWAP_OFFRAMP_LKJHG_A1B2C3D4
 *               stacksTxId:
 *                 type: string
 *               tokenAmount:
 *                 type: number
 *               token:
 *                 type: string
 *               senderAddress:
 *                 type: string
 *     responses:
 *       200:
 *         description: Tokens confirmed, NGN settlement initiated
 *       401:
 *         description: Unauthorized — missing or invalid x-internal-key
 *       404:
 *         description: Transaction not found
 *       500:
 *         description: Lenco transfer failed — manual action required
 */
router.post("/confirm-receipt", requireInternalKey, confirmTokenReceipt);

/**
 * @swagger
 * /api/offramp/lenco-webhook:
 *   post:
 *     summary: Lenco webhook — finalizes transaction on successful NGN bank transfer
 *     tags: [Offramp]
 *     description: |
 *       Receives transfer status events from Lenco (transfer.completed, transfer.failed,
 *       transfer.reversed). Verified via HMAC signature in x-lenco-signature header.
 *     responses:
 *       200:
 *         description: Event processed
 *       401:
 *         description: Missing or invalid signature
 */
router.post("/lenco-webhook", handleLencoWebhook);

/**
 * @swagger
 * /api/offramp/status/{reference}:
 *   get:
 *     summary: Get status of an offramp transaction
 *     tags: [Offramp]
 *     parameters:
 *       - in: path
 *         name: reference
 *         required: true
 *         schema:
 *           type: string
 *         example: SSWAP_OFFRAMP_LKJHG_A1B2C3D4
 *     responses:
 *       200:
 *         description: Transaction status and details
 *       404:
 *         description: Not found
 */
router.get("/status/:reference", getOfframpStatus);

/**
 * @swagger
 * /api/offramp/history:
 *   get:
 *     summary: Get paginated offramp history for a Stacks address
 *     tags: [Offramp]
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
 *       - in: query
 *         name: token
 *         schema:
 *           type: string
 *           enum: [STX, USDC]
 *       - in: query
 *         name: status
 *         schema:
 *           type: string
 *           enum: [pending, processing, settling, confirmed, failed]
 *     responses:
 *       200:
 *         description: Paginated offramp history
 */
router.get("/history", getOfframpHistory);

module.exports = router;