const {
  createTransaction,
  getTransactionHistory,
  updateTransactionStatus,
  getTransactionById,
  getWalletStats,
} = require("../services/transactionService");
const logger = require("../config/logger");

// POST /api/transactions
async function initTransaction(req, res) {
  const { token, type, tokenAmount, senderAddress, recipientAddress, memo } = req.body;

  if (!token || !type || !tokenAmount || !senderAddress || !recipientAddress) {
    return res.status(400).json({
      success: false,
      message: "Missing required fields: token, type, tokenAmount, senderAddress, recipientAddress",
    });
  }

  if (!["STX", "USDC"].includes(token.toUpperCase())) {
    return res.status(400).json({ success: false, message: "Invalid token. Use STX or USDC." });
  }

  if (!["sell", "buy"].includes(type)) {
    return res.status(400).json({ success: false, message: "Invalid type. Use sell or buy." });
  }

  if (isNaN(tokenAmount) || Number(tokenAmount) <= 0) {
    return res.status(400).json({ success: false, message: "tokenAmount must be a positive number." });
  }

  try {
    const tx = await createTransaction({
      token: token.toUpperCase(),
      type,
      tokenAmount: Number(tokenAmount),
      senderAddress,
      recipientAddress,
      memo,
    });

    res.status(201).json({ success: true, data: tx });
  } catch (err) {
    logger.error(`initTransaction error: ${err.message}`);
    res.status(500).json({ success: false, message: err.message });
  }
}

// GET /api/transactions?address=SP...&page=1&limit=20&token=STX&type=sell&status=confirmed
async function listTransactions(req, res) {
  const { address, page, limit, token, type, status } = req.query;

  if (!address) {
    return res.status(400).json({ success: false, message: "address query param is required." });
  }

  try {
    const result = await getTransactionHistory(address, {
      page: parseInt(page) || 1,
      limit: Math.min(parseInt(limit) || 20, 100),
      token,
      type,
      status,
    });
    res.json({ success: true, ...result });
  } catch (err) {
    logger.error(`listTransactions error: ${err.message}`);
    res.status(500).json({ success: false, message: "Failed to retrieve transactions." });
  }
}

// GET /api/transactions/:id
async function getTransaction(req, res) {
  try {
    const tx = await getTransactionById(req.params.id);
    res.json({ success: true, data: tx });
  } catch (err) {
    res.status(404).json({ success: false, message: err.message });
  }
}

// PATCH /api/transactions/:id/status
async function patchStatus(req, res) {
  const { status, stacksTxId } = req.body;
  const validStatuses = ["pending", "processing", "confirmed", "failed"];

  if (!status || !validStatuses.includes(status)) {
    return res.status(400).json({ success: false, message: `status must be one of: ${validStatuses.join(", ")}` });
  }

  try {
    const tx = await updateTransactionStatus(req.params.id, { status, stacksTxId });
    res.json({ success: true, data: tx });
  } catch (err) {
    res.status(404).json({ success: false, message: err.message });
  }
}

// GET /api/transactions/stats?address=SP...
async function walletStats(req, res) {
  const { address } = req.query;
  if (!address) return res.status(400).json({ success: false, message: "address is required." });

  try {
    const stats = await getWalletStats(address);
    res.json({ success: true, data: stats });
  } catch (err) {
    res.status(500).json({ success: false, message: "Failed to fetch stats." });
  }
}

module.exports = { initTransaction, listTransactions, getTransaction, patchStatus, walletStats };
