const express = require("express");
const router = express.Router();
const {
  initTransaction,
  listTransactions,
  getTransaction,
  patchStatus,
  walletStats,
} = require("../controllers/transactionController");

/**
 * @swagger
 * /api/transactions:
 *   get:
 *     summary: List transactions for a wallet address
 *     tags: [Transactions]
 *     parameters:
 *       - in: query
 *         name: address
 *         required: true
 *         schema:
 *           type: string
 *         description: Stacks wallet address
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
 *           maximum: 100
 *       - in: query
 *         name: token
 *         schema:
 *           type: string
 *           enum: [STX, USDC]
 *       - in: query
 *         name: type
 *         schema:
 *           type: string
 *           enum: [sell, buy]
 *       - in: query
 *         name: status
 *         schema:
 *           type: string
 *           enum: [pending, processing, confirmed, failed]
 *     responses:
 *       200:
 *         description: Paginated list of transactions
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                 transactions:
 *                   type: array
 *                   items:
 *                     $ref: '#/components/schemas/Transaction'
 *                 pagination:
 *                   $ref: '#/components/schemas/Pagination'
 *       400:
 *         description: Missing address param
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorResponse'
 */
router.get("/", listTransactions);

/**
 * @swagger
 * /api/transactions/stats:
 *   get:
 *     summary: Get volume stats for a wallet
 *     tags: [Transactions]
 *     parameters:
 *       - in: query
 *         name: address
 *         required: true
 *         schema:
 *           type: string
 *         example: SP3EWE151DHDTV7CP5D7N2YYESA3VEH3TBPNTT4EV
 *     responses:
 *       200:
 *         description: Aggregated stats per token
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
 *                       _id:
 *                         type: string
 *                         example: STX
 *                       totalTokenVolume:
 *                         type: number
 *                       totalNgnVolume:
 *                         type: number
 *                       totalFees:
 *                         type: number
 *                       count:
 *                         type: integer
 */
router.get("/stats", walletStats);

/**
 * @swagger
 * /api/transactions:
 *   post:
 *     summary: Create a new swap transaction
 *     tags: [Transactions]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             $ref: '#/components/schemas/CreateTransactionBody'
 *     responses:
 *       201:
 *         description: Transaction created successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                 data:
 *                   $ref: '#/components/schemas/Transaction'
 *       400:
 *         description: Validation error
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorResponse'
 */
router.post("/", initTransaction);

/**
 * @swagger
 * /api/transactions/{id}:
 *   get:
 *     summary: Get a single transaction by ID
 *     tags: [Transactions]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *         description: MongoDB transaction ID
 *         example: 65f1a2b3c4d5e6f7a8b9c0d1
 *     responses:
 *       200:
 *         description: Transaction details
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                 data:
 *                   $ref: '#/components/schemas/Transaction'
 *       404:
 *         description: Transaction not found
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorResponse'
 */
router.get("/:id", getTransaction);

/**
 * @swagger
 * /api/transactions/{id}/status:
 *   patch:
 *     summary: Update transaction status after on-chain confirmation
 *     tags: [Transactions]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *         example: 65f1a2b3c4d5e6f7a8b9c0d1
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             $ref: '#/components/schemas/UpdateStatusBody'
 *     responses:
 *       200:
 *         description: Status updated
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                 data:
 *                   $ref: '#/components/schemas/Transaction'
 *       400:
 *         description: Invalid status value
 *       404:
 *         description: Transaction not found
 */
router.patch("/:id/status", patchStatus);

module.exports = router;