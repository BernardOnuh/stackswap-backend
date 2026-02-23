const Transaction = require("../models/Transaction");
const { getCurrentPrices } = require("./priceService");
const logger = require("../config/logger");

const FEE_RATE = 0.005; // 0.5%

/**
 * Create a new transaction record
 */
async function createTransaction({ token, type, tokenAmount, senderAddress, recipientAddress, memo }) {
  const prices = await getCurrentPrices();
  const tokenPrice = prices[token];
  if (!tokenPrice) throw new Error(`Unsupported token: ${token}`);

  const rate = tokenPrice.priceNGN;
  const ngnAmount = tokenAmount * rate;
  const feeNGN = ngnAmount * FEE_RATE;
  const netNGN = ngnAmount - feeNGN;

  const tx = await Transaction.create({
    token,
    type,
    tokenAmount,
    ngnAmount,
    rateAtTime: rate,
    feeNGN,
    netNGN,
    senderAddress,
    recipientAddress,
    memo,
    status: "pending",
  });

  logger.info(`Transaction created: ${tx._id} | ${type} ${tokenAmount} ${token} @ ₦${rate}`);
  return tx;
}

/**
 * Get transaction history for a wallet address
 */
async function getTransactionHistory(address, { page = 1, limit = 20, token, type, status } = {}) {
  const query = { senderAddress: address };
  if (token) query.token = token.toUpperCase();
  if (type) query.type = type;
  if (status) query.status = status;

  const skip = (page - 1) * limit;
  const [transactions, total] = await Promise.all([
    Transaction.find(query)
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit)
      .lean(),
    Transaction.countDocuments(query),
  ]);

  return {
    transactions,
    pagination: {
      page,
      limit,
      total,
      pages: Math.ceil(total / limit),
    },
  };
}

/**
 * Update transaction status (e.g. after on-chain confirmation)
 */
async function updateTransactionStatus(txId, { status, stacksTxId }) {
  const tx = await Transaction.findByIdAndUpdate(
    txId,
    { status, ...(stacksTxId && { txId: stacksTxId }) },
    { new: true }
  );
  if (!tx) throw new Error("Transaction not found");
  logger.info(`Transaction ${txId} → ${status}`);
  return tx;
}

/**
 * Get a single transaction by ID
 */
async function getTransactionById(id) {
  const tx = await Transaction.findById(id).lean();
  if (!tx) throw new Error("Transaction not found");
  return tx;
}

/**
 * Summary stats for a wallet
 */
async function getWalletStats(address) {
  const stats = await Transaction.aggregate([
    { $match: { senderAddress: address, status: "confirmed" } },
    {
      $group: {
        _id: "$token",
        totalTokenVolume: { $sum: "$tokenAmount" },
        totalNgnVolume: { $sum: "$ngnAmount" },
        totalFees: { $sum: "$feeNGN" },
        count: { $sum: 1 },
      },
    },
  ]);
  return stats;
}

module.exports = {
  createTransaction,
  getTransactionHistory,
  updateTransactionStatus,
  getTransactionById,
  getWalletStats,
};
