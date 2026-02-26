// ============= controllers/onrampController.js =============
// StackSwap Onramp: Pay NGN via Monnify → Receive STX or USDC in Stacks wallet

const crypto = require("crypto");
const Transaction = require("../models/Transaction");
const { getCurrentPrices } = require("../services/priceService");
const logger = require("../config/logger");

// ── Config ──────────────────────────────────────────────────────
const MONNIFY_API_KEY = process.env.MONNIFY_API_KEY || "";
const MONNIFY_SECRET_KEY = process.env.MONNIFY_SECRET_KEY || "";
const MONNIFY_CONTRACT_CODE = process.env.MONNIFY_CONTRACT_CODE || "";
const MONNIFY_BASE_URL = process.env.MONNIFY_BASE_URL || "https://api.monnify.com";

// Optional IP whitelist (comma-separated in .env)
const MONNIFY_ALLOWED_IPS = process.env.MONNIFY_IPS
  ? process.env.MONNIFY_IPS.split(",").map((ip) => ip.trim()).filter(Boolean)
  : [];

// Transaction limits (NGN)
const MIN_AMOUNT_NGN = 1_000;
const MAX_AMOUNT_NGN = 2_000_000;
const DAILY_LIMIT_NGN = 10_000_000;

// ── Fee model ────────────────────────────────────────────────────
// Flat ₦100 added on top of the user's requested amount.
// User pays: amountNGN + ₦100 → receives tokens equivalent to amountNGN at onramp rate.
const FLAT_FEE_NGN = parseFloat(process.env.ONRAMP_FLAT_FEE_NGN || "100");

// ── Helpers ─────────────────────────────────────────────────────

/**
 * Verify Monnify HMAC-SHA512 webhook signature
 */
function verifyMonnifySignature(payload, signature) {
  if (!MONNIFY_SECRET_KEY) {
    logger.error("MONNIFY_SECRET_KEY not configured — cannot verify webhook");
    return false;
  }
  try {
    const hash = crypto
      .createHmac("sha512", MONNIFY_SECRET_KEY)
      .update(JSON.stringify(payload))
      .digest("hex");
    const isValid = hash === signature;
    if (!isValid) logger.warn("Monnify webhook signature mismatch");
    return isValid;
  } catch (err) {
    logger.error(`Signature verification error: ${err.message}`);
    return false;
  }
}

/**
 * Extract real client IP (handles proxies/Cloudflare)
 */
function getClientIP(req) {
  return (
    req.headers["cf-connecting-ip"] ||
    (req.headers["x-forwarded-for"] || "").split(",")[0].trim() ||
    req.headers["x-real-ip"] ||
    req.ip ||
    req.connection?.remoteAddress ||
    "unknown"
  );
}

/**
 * Check IP against optional whitelist — advisory only (signature is primary auth)
 */
function checkMonnifyIP(req) {
  const ip = getClientIP(req);
  if (MONNIFY_ALLOWED_IPS.length === 0) {
    logger.info(`Monnify webhook from ${ip} — no IP whitelist configured`);
    return { allowed: true, ip };
  }
  const allowed = MONNIFY_ALLOWED_IPS.includes(ip);
  if (!allowed) logger.warn(`Monnify webhook from unlisted IP: ${ip}`);
  return { allowed, ip };
}

/**
 * Calculate onramp quote for a given NGN token-purchase amount.
 *
 * Fee model (flat ₦100):
 *   • User specifies amountNGN — the NGN value of tokens they want.
 *   • A flat ₦100 service fee is added ON TOP.
 *   • Monnify charges: amountNGN + ₦100
 *   • Tokens delivered = amountNGN ÷ marketRate  (full amountNGN used, fee is separate)
 *
 * Example — ₦50,000 of STX at ₦2,500/STX:
 *   totalPayable = ₦50,100   (₦50,000 + ₦100 flat fee)
 *   tokenAmount  = 50,000 / 2,500 = 20 STX
 */
async function calculateOnrampQuote(token, amountNGN) {
  const prices = await getCurrentPrices();
  const tokenData = prices[token.toUpperCase()];
  if (!tokenData) throw new Error(`Unsupported token: ${token}`);

  const marketRateNGN   = tokenData.priceNGN;
  const tokenAmount     = amountNGN / marketRateNGN;
  const totalPayableNGN = amountNGN + FLAT_FEE_NGN;

  return {
    token:            token.toUpperCase(),
    marketRateNGN:    parseFloat(marketRateNGN.toFixed(2)),
    flatFeeNGN:       FLAT_FEE_NGN,
    tokenAmount:      parseFloat(tokenAmount.toFixed(6)),
    amountNGN:        parseFloat(amountNGN.toFixed(2)),
    totalPayableNGN:  parseFloat(totalPayableNGN.toFixed(2)),
    priceUSD:         tokenData.priceUSD,
    usdToNgn:         tokenData.usdToNgn,
  };
}

/**
 * Check if address has exceeded daily onramp limit
 */
async function checkDailyLimit(senderAddress, newAmount) {
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  const result = await Transaction.aggregate([
    {
      $match: {
        senderAddress,
        direction: "onramp",
        status: { $in: ["pending", "processing", "confirmed"] },
        createdAt: { $gte: today },
      },
    },
    { $group: { _id: null, total: { $sum: "$ngnAmount" } } },
  ]);

  const usedToday = result[0]?.total || 0;
  return usedToday + newAmount <= DAILY_LIMIT_NGN;
}

// ── Controllers ─────────────────────────────────────────────────

/**
 * @desc    Get onramp quote for an amount
 * @route   GET /api/onramp/rate?token=STX&amountNGN=50000
 * @access  Public
 */
async function getOnrampRate(req, res) {
  try {
    const { token = "STX", amountNGN } = req.query;

    if (!["STX", "USDC"].includes(token.toUpperCase())) {
      return res.status(400).json({ success: false, message: "token must be STX or USDC" });
    }

    let quote;
    if (amountNGN) {
      const parsed = parseFloat(amountNGN);
      if (isNaN(parsed) || parsed <= 0) {
        return res.status(400).json({ success: false, message: "Invalid amountNGN" });
      }
      quote = await calculateOnrampQuote(token, parsed);
    } else {
      // Return rate info without amount-specific calculation
      const prices = await getCurrentPrices();
      const tokenData = prices[token.toUpperCase()];
      quote = {
        token:          token.toUpperCase(),
        marketRateNGN:  parseFloat(tokenData.priceNGN.toFixed(2)),
        flatFeeNGN:     FLAT_FEE_NGN,
        feeNote:        `₦${FLAT_FEE_NGN} flat fee added to every transaction`,
        priceUSD:       tokenData.priceUSD,
        usdToNgn:       tokenData.usdToNgn,
      };
    }

    res.json({
      success: true,
      data: {
        ...quote,
        limits: { min: MIN_AMOUNT_NGN, max: MAX_AMOUNT_NGN, daily: DAILY_LIMIT_NGN },
        fetchedAt: new Date().toISOString(),
      },
    });
  } catch (err) {
    logger.error(`getOnrampRate error: ${err.message}`);
    res.status(500).json({ success: false, message: err.message });
  }
}

/**
 * @desc    Initialize onramp — create transaction + return Monnify config
 * @route   POST /api/onramp/initialize
 * @access  Private
 * @body    { token, amountNGN, stacksAddress, customerEmail, customerPhone? }
 */
async function initializeOnramp(req, res) {
  try {
    const { token, amountNGN, stacksAddress, customerEmail, customerPhone } = req.body;

    // ── Validate inputs ────────────────────────────────────────
    if (!token || !amountNGN || !stacksAddress || !customerEmail) {
      return res.status(400).json({
        success: false,
        message: "Missing required fields: token, amountNGN, stacksAddress, customerEmail",
      });
    }

    const upperToken = token.toUpperCase();
    if (!["STX", "USDC"].includes(upperToken)) {
      return res.status(400).json({ success: false, message: "token must be STX or USDC" });
    }

    const amount = parseFloat(amountNGN);
    if (isNaN(amount) || amount <= 0) {
      return res.status(400).json({ success: false, message: "amountNGN must be a positive number" });
    }
    if (amount < MIN_AMOUNT_NGN) {
      return res.status(400).json({ success: false, message: `Minimum amount is ₦${MIN_AMOUNT_NGN.toLocaleString()}` });
    }
    if (amount > MAX_AMOUNT_NGN) {
      return res.status(400).json({ success: false, message: `Maximum amount is ₦${MAX_AMOUNT_NGN.toLocaleString()}` });
    }

    // Basic Stacks address validation (SP... or SM... prefix)
    if (!stacksAddress.match(/^(SP|SM|ST)[0-9A-Z]{20,50}$/i)) {
      return res.status(400).json({ success: false, message: "Invalid Stacks wallet address" });
    }

    // ── Daily limit ────────────────────────────────────────────
    const withinLimit = await checkDailyLimit(stacksAddress, amount);
    if (!withinLimit) {
      return res.status(400).json({
        success: false,
        message: `Daily onramp limit of ₦${DAILY_LIMIT_NGN.toLocaleString()} exceeded`,
      });
    }

    // ── Quote calculation ──────────────────────────────────────
    const quote = await calculateOnrampQuote(upperToken, amount);

    // ── Generate payment reference ─────────────────────────────
    const timestamp = Date.now();
    const randomSuffix = crypto.randomBytes(4).toString("hex").toUpperCase();
    const paymentReference = `SSWAP_ONRAMP_${timestamp}_${randomSuffix}`;

    // ── Create pending transaction ─────────────────────────────
    const tx = await Transaction.create({
      token:            upperToken,
      type:             "buy",
      direction:        "onramp",
      tokenAmount:      quote.tokenAmount,
      ngnAmount:        amount,                    // NGN value of tokens (excl. fee)
      feeNGN:           FLAT_FEE_NGN,              // flat ₦100 fee
      netNGN:           amount,                    // full amount goes toward buying tokens
      rateAtTime:       quote.marketRateNGN,
      senderAddress:    stacksAddress,
      recipientAddress: stacksAddress,             // user receives tokens into their own wallet
      paymentReference,
      monnifyReference: "",
      customerEmail,
      status: "pending",
      meta: {
        marketRateNGN:   quote.marketRateNGN,
        totalPayableNGN: quote.totalPayableNGN,
        flatFeeNGN:      FLAT_FEE_NGN,
        usdToNgn:        quote.usdToNgn,
        priceUSD:        quote.priceUSD,
        paymentMethod:   "monnify",
      },
    });

    logger.info(`Onramp initialized: ${paymentReference} | ${upperToken} | ₦${amount} | ${stacksAddress}`);

    // ── Return Monnify payment config ──────────────────────────
    res.status(201).json({
      success: true,
      data: {
        transactionId: tx._id,
        paymentReference,
        token: upperToken,
        amountNGN: amount,
        flatFeeNGN: FLAT_FEE_NGN,
        totalPayableNGN: quote.totalPayableNGN,
        tokenAmount: quote.tokenAmount,
        marketRateNGN: quote.marketRateNGN,
        stacksAddress,
        breakdown: {
          youPay:     `₦${amount.toLocaleString()} + ₦${FLAT_FEE_NGN} flat fee = ₦${quote.totalPayableNGN.toLocaleString()} total`,
          fee:        `₦${FLAT_FEE_NGN} flat service fee`,
          youReceive: `${quote.tokenAmount.toFixed(6)} ${upperToken}`,
          rate:       `₦${quote.marketRateNGN.toFixed(2)} per ${upperToken} (live market rate)`,
        },
        // Monnify SDK config — pass this directly to @monnify/monnify-js on the frontend
        monnifyConfig: {
          amount: quote.totalPayableNGN,   // ← charge amountNGN + ₦100 flat fee
          currency: "NGN",
          reference: paymentReference,
          customerFullName: customerEmail.split("@")[0],
          customerEmail,
          customerMobileNumber: customerPhone || "",
          apiKey: MONNIFY_API_KEY,
          contractCode: MONNIFY_CONTRACT_CODE,
          paymentDescription: `Buy ${quote.tokenAmount.toFixed(6)} ${upperToken} on StackSwap`,
          paymentMethods: ["CARD", "ACCOUNT_TRANSFER", "USSD"],
          metadata: {
            transactionId: tx._id.toString(),
            token: upperToken,
            tokenAmount: quote.tokenAmount.toFixed(6),
            stacksAddress,
            paymentReference,
          },
        },
      },
    });
  } catch (err) {
    logger.error(`initializeOnramp error: ${err.message}`);
    res.status(500).json({ success: false, message: err.message });
  }
}

/**
 * @desc    Handle Monnify webhook — credit STX/USDC to Stacks wallet on payment confirmation
 * @route   POST /api/onramp/webhook
 * @access  Public (verified via signature)
 */
async function handleMonnifyWebhook(req, res) {
  logger.info("=".repeat(60));
  logger.info("MONNIFY WEBHOOK RECEIVED");

  const payload = req.body;
  const signature = req.headers["monnify-signature"];

  // ── Step 1: Verify signature (required) ───────────────────────
  if (!signature) {
    logger.error("Webhook rejected — missing monnify-signature header");
    return res.status(401).json({ success: false, message: "Missing signature" });
  }

  if (!verifyMonnifySignature(payload, signature)) {
    logger.error("Webhook rejected — invalid signature");
    return res.status(401).json({ success: false, message: "Invalid signature" });
  }

  // ── Step 2: Check IP (optional, advisory) ──────────────────────
  const { ip } = checkMonnifyIP(req);
  logger.info(`Verified webhook from ${ip} | event: ${payload.eventType}`);

  // ── Step 3: Validate payload ───────────────────────────────────
  const eventData = payload.eventData;
  if (!eventData) {
    return res.status(400).json({ success: false, message: "Missing eventData" });
  }

  const {
    transactionReference: monnifyRef,
    paymentReference,
    amountPaid,
    paymentStatus,
    paymentMethod,
    paidOn,
    metaData,
  } = eventData;

  logger.info(`Payment ref: ${paymentReference} | status: ${paymentStatus} | amount: ₦${amountPaid}`);

  if (!paymentReference || !paymentStatus) {
    return res.status(400).json({ success: false, message: "Incomplete webhook payload" });
  }

  // ── Step 4: Find transaction ────────────────────────────────────
  let tx = await Transaction.findOne({ paymentReference });
  if (!tx && metaData?.paymentReference) {
    tx = await Transaction.findOne({ paymentReference: metaData.paymentReference });
  }
  if (!tx) {
    logger.warn(`Transaction not found for paymentReference: ${paymentReference}`);
    return res.status(404).json({ success: false, message: "Transaction not found" });
  }

  // ── Step 5: Idempotency ─────────────────────────────────────────
  if (tx.status === "confirmed") {
    logger.info(`Transaction ${tx._id} already confirmed — idempotent response`);
    return res.json({ success: true, message: "Already processed" });
  }

  // ── Step 6: Update monnify reference ───────────────────────────
  tx.monnifyReference = monnifyRef;
  tx.paymentMethod = paymentMethod;
  tx.paidAt = paidOn ? new Date(paidOn) : new Date();

  // ── Step 7: Handle non-payment statuses ────────────────────────
  if (paymentStatus !== "PAID") {
    tx.status = paymentStatus === "USER_CANCELLED" ? "failed" : "failed";
    tx.meta = { ...tx.meta, failureReason: `Monnify status: ${paymentStatus}` };
    await tx.save();
    logger.warn(`Transaction ${tx._id} marked failed — payment status: ${paymentStatus}`);
    return res.json({ success: true, message: `Payment ${paymentStatus.toLowerCase()}` });
  }

  // ── Step 8: Amount verification ────────────────────────────────
  // Monnify should have charged amountNGN + ₦100 flat fee = totalPayableNGN
  const expectedNGN = tx.ngnAmount + (tx.feeNGN || 100); // ngnAmount + flat fee
  const tolerance = 1; // ₦1 tolerance for rounding
  if (Math.abs(amountPaid - expectedNGN) > tolerance) {
    logger.error(`Amount mismatch! Expected ₦${expectedNGN} (₦${tx.ngnAmount} + ₦${tx.feeNGN} fee), paid ₦${amountPaid}`);
    tx.status = "failed";
    tx.meta = { ...tx.meta, failureReason: `Amount mismatch: expected ₦${expectedNGN}, received ₦${amountPaid}` };
    await tx.save();
    return res.status(400).json({ success: false, message: "Amount mismatch" });
  }

  // ── Step 9: Credit tokens to Stacks wallet ─────────────────────
  tx.status = "processing";
  await tx.save();

  try {
    const stacksTransferService = require("../services/stacksTransferService");
    const result = await stacksTransferService.sendTokens({
      token: tx.token,
      amount: tx.tokenAmount,
      recipientAddress: tx.recipientAddress,
      memo: `StackSwap onramp ${tx.paymentReference}`,
    });

    tx.status = "confirmed";
    tx.txId = result.txId;
    tx.confirmedAt = new Date();
    tx.meta = { ...tx.meta, stacksTxId: result.txId, explorerUrl: result.explorerUrl };
    await tx.save();

    logger.info(`✅ Onramp complete: ${tx.tokenAmount} ${tx.token} → ${tx.recipientAddress}`);
    logger.info(`   Stacks TxID: ${result.txId}`);

    return res.json({
      success: true,
      message: "Tokens credited to Stacks wallet",
      data: {
        transactionId: tx._id,
        token: tx.token,
        tokenAmount: tx.tokenAmount,
        stacksAddress: tx.recipientAddress,
        stacksTxId: result.txId,
        explorerUrl: result.explorerUrl,
      },
    });
  } catch (err) {
    logger.error(`CRITICAL: Stacks transfer failed for ${tx._id}: ${err.message}`);
    logger.error(`Manual action required — send ${tx.tokenAmount} ${tx.token} to ${tx.recipientAddress}`);

    tx.status = "failed";
    tx.meta = { ...tx.meta, failureReason: `Stacks transfer failed: ${err.message}`, requiresManualCredit: true };
    await tx.save();

    return res.status(500).json({
      success: false,
      message: "Token transfer failed. Support team notified.",
    });
  }
}

/**
 * @desc    Verify onramp transaction status
 * @route   GET /api/onramp/verify/:reference
 * @access  Public
 */
async function verifyOnramp(req, res) {
  try {
    const tx = await Transaction.findOne({
      paymentReference: req.params.reference,
      direction: "onramp",
    }).lean();

    if (!tx) return res.status(404).json({ success: false, message: "Transaction not found" });

    res.json({
      success: true,
      data: {
        transactionId: tx._id,
        paymentReference: tx.paymentReference,
        token: tx.token,
        tokenAmount: tx.tokenAmount,
        ngnAmount: tx.ngnAmount,
        feeNGN: tx.feeNGN,
        status: tx.status,
        stacksAddress: tx.recipientAddress,
        stacksTxId: tx.txId,
        explorerUrl: tx.meta?.explorerUrl,
        createdAt: tx.createdAt,
        confirmedAt: tx.confirmedAt,
      },
    });
  } catch (err) {
    logger.error(`verifyOnramp error: ${err.message}`);
    res.status(500).json({ success: false, message: "Verification failed" });
  }
}

/**
 * @desc    Get onramp history for a Stacks address
 * @route   GET /api/onramp/history?address=SP...&page=1&limit=20
 * @access  Public
 */
async function getOnrampHistory(req, res) {
  try {
    const { address, page = 1, limit = 20 } = req.query;
    if (!address) return res.status(400).json({ success: false, message: "address is required" });

    const skip = (parseInt(page) - 1) * Math.min(parseInt(limit), 100);
    const [txs, total] = await Promise.all([
      Transaction.find({ senderAddress: address, direction: "onramp" })
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(parseInt(limit))
        .lean(),
      Transaction.countDocuments({ senderAddress: address, direction: "onramp" }),
    ]);

    res.json({
      success: true,
      data: txs,
      pagination: { page: parseInt(page), limit: parseInt(limit), total, pages: Math.ceil(total / parseInt(limit)) },
    });
  } catch (err) {
    logger.error(`getOnrampHistory error: ${err.message}`);
    res.status(500).json({ success: false, message: "Failed to fetch history" });
  }
}

module.exports = {
  getOnrampRate,
  initializeOnramp,
  handleMonnifyWebhook,
  verifyOnramp,
  getOnrampHistory,
};