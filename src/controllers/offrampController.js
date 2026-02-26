// ============= controllers/offrampController.js =============
// StackSwap Offramp: Send STX or USDC from Stacks wallet → Receive NGN via Lenco bank transfer

const crypto = require("crypto");
const axios = require("axios");
const Transaction = require("../models/Transaction");
const { getCurrentPrices } = require("../services/priceService");
const logger = require("../config/logger");

// ── Config ──────────────────────────────────────────────────────
const LENCO_API_KEY = process.env.LENCO_API_KEY || "";
const LENCO_BASE_URL = "https://api.lenco.co";
const LENCO_WEBHOOK_SECRET = process.env.LENCO_WEBHOOK_SECRET || "";

// ── Fee model ────────────────────────────────────────────────────
// Flat ₦100 deducted from the NGN payout.
// User receives: (tokenAmount × marketRate) − ₦100
// e.g. 10 STX at ₦2,500/STX = ₦25,000 − ₦100 = ₦24,900
const OFFRAMP_FLAT_FEE_NGN = parseFloat(process.env.OFFRAMP_FLAT_FEE_NGN || "100");

// Limits
const MIN_TOKEN_AMOUNT = parseFloat(process.env.OFFRAMP_MIN_TOKEN || "1");
const MAX_TOKEN_AMOUNT = parseFloat(process.env.OFFRAMP_MAX_TOKEN || "50000");
const SETTLEMENT_TIMEOUT_MINUTES = 30;

// ── Bank list cache (refresh every 24h to avoid hammering Lenco) ──
let bankListCache = null;
let bankListCachedAt = null;
const BANK_CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

// ── Helpers ─────────────────────────────────────────────────────

function generateReference() {
  const ts = Date.now().toString(36).toUpperCase();
  const rand = crypto.randomBytes(4).toString("hex").toUpperCase();
  return `SSWAP_OFFRAMP_${ts}_${rand}`;
}

/**
 * Verify Lenco webhook signature
 */
function verifyLencoSignature(payload, signature) {
  if (!LENCO_WEBHOOK_SECRET) {
    logger.warn("LENCO_WEBHOOK_SECRET not configured — skipping signature check");
    return true;
  }
  const hash = crypto
    .createHmac("sha256", LENCO_WEBHOOK_SECRET)
    .update(JSON.stringify(payload))
    .digest("hex");
  return hash === signature;
}

/**
 * Calculate offramp quote: how much NGN a user gets for selling tokenAmount of STX/USDC.
 *
 * Fee model (flat ₦100):
 *   grossNGN  = tokenAmount × marketRateNGN
 *   ngnAmount = grossNGN − ₦100
 */
async function calculateOfframpQuote(token, tokenAmount) {
  const prices = await getCurrentPrices();
  const tokenData = prices[token.toUpperCase()];
  if (!tokenData) throw new Error(`Unsupported token: ${token}`);

  const marketRateNGN = tokenData.priceNGN;
  const grossNGN      = tokenAmount * marketRateNGN;
  const ngnAmount     = grossNGN - OFFRAMP_FLAT_FEE_NGN;

  if (ngnAmount <= 0) {
    throw new Error(`Amount too small — ₦${OFFRAMP_FLAT_FEE_NGN} fee exceeds payout`);
  }

  return {
    token:         token.toUpperCase(),
    marketRateNGN: parseFloat(marketRateNGN.toFixed(2)),
    flatFeeNGN:    OFFRAMP_FLAT_FEE_NGN,
    grossNGN:      parseFloat(grossNGN.toFixed(2)),
    ngnAmount:     parseFloat(ngnAmount.toFixed(2)),
    tokenAmount:   parseFloat(tokenAmount.toFixed(6)),
    priceUSD:      tokenData.priceUSD,
    usdToNgn:      tokenData.usdToNgn,
  };
}

/**
 * Verify a Nigerian bank account via Lenco.
 * Endpoint: GET /access/v1/resolve?bankCode=&accountNumber=
 * Response: { status, message, data: { accountName, accountNumber, bank: { code, name } } }
 */
async function verifyBankAccount(bankCode, accountNumber) {
  const url = `${LENCO_BASE_URL}/access/v1/resolve`;
  logger.info(`Lenco resolve → GET ${url}?bankCode=${bankCode}&accountNumber=${accountNumber}`);

  try {
    const res = await axios.get(url, {
      params: { bankCode, accountNumber },
      headers: {
        Authorization: `Bearer ${LENCO_API_KEY}`,
        "Content-Type": "application/json",
      },
      timeout: 15000,
    });

    logger.info(`Lenco resolve response: ${JSON.stringify(res.data)}`);

    if (!res.data?.status) {
      throw new Error(res.data?.message || "Account verification failed");
    }

    return {
      success:       true,
      accountName:   res.data.data?.accountName,
      accountNumber: res.data.data?.accountNumber,
      bankCode:      res.data.data?.bank?.code || bankCode,
      bankName:      res.data.data?.bank?.name,
    };
  } catch (err) {
    if (err.response) {
      const lencoMessage =
        err.response.data?.message ||
        err.response.data?.error ||
        JSON.stringify(err.response.data);
      logger.error(`Lenco resolve error ${err.response.status}: ${lencoMessage}`);
      throw new Error(lencoMessage);
    }
    throw err;
  }
}

/**
 * Initiate NGN bank transfer via Lenco.
 * Endpoint: POST /access/v1/transactions
 * Required: amount, accountNumber, bankCode, accountName, debitAccountId, clientReference, narration
 */
async function initiateLencoTransfer(amountNGN, accountNumber, bankCode, accountName, reference) {
  const debitAccountId = process.env.LENCO_ACCOUNT_ID;
  if (!debitAccountId) throw new Error("LENCO_ACCOUNT_ID not configured — needed to debit your Lenco account");

  try {
    const res = await axios.post(
      `${LENCO_BASE_URL}/access/v1/transactions`,
      {
        amount:          amountNGN,
        accountNumber,
        bankCode,
        accountName,
        debitAccountId,
        clientReference: reference,
        narration:       `StackSwap offramp - ${reference}`,
      },
      {
        headers: {
          Authorization: `Bearer ${LENCO_API_KEY}`,
          "Content-Type": "application/json",
        },
        timeout: 30000,
      }
    );

    if (!res.data?.status) throw new Error(res.data?.message || "Lenco transfer initiation failed");

    return {
      success:        true,
      transferId:     res.data.data?.id,
      lencoReference: res.data.data?.transactionReference,
      status:         res.data.data?.status,
      reference,
    };
  } catch (err) {
    if (err.response) {
      const lencoMessage =
        err.response.data?.message ||
        err.response.data?.error ||
        JSON.stringify(err.response.data);
      logger.error(`Lenco transfer error ${err.response.status}: ${lencoMessage}`);
      throw new Error(lencoMessage);
    }
    throw err;
  }
}

// ── Controllers ─────────────────────────────────────────────────

/**
 * @desc    Get list of supported Nigerian banks from Lenco
 * @route   GET /api/offramp/banks
 * @access  Public
 */
async function getBankList(req, res) {
  try {
    const now = Date.now();
    const cacheStale = !bankListCachedAt || now - bankListCachedAt > BANK_CACHE_TTL_MS;

    if (!bankListCache || cacheStale) {
      logger.info("Fetching bank list from Lenco...");

      try {
        const response = await axios.get(`${LENCO_BASE_URL}/access/v1/banks`, {
          headers: {
            Authorization: `Bearer ${LENCO_API_KEY}`,
            "Content-Type": "application/json",
          },
          timeout: 15000,
        });

        if (!response.data?.status) {
          throw new Error(response.data?.message || "Failed to fetch bank list");
        }

        bankListCache = response.data.data || [];
        bankListCachedAt = now;
        logger.info(`Bank list cached: ${bankListCache.length} banks`);
      } catch (err) {
        if (err.response) {
          const msg =
            err.response.data?.message ||
            err.response.data?.error ||
            JSON.stringify(err.response.data);
          logger.error(`Lenco bank list error ${err.response.status}: ${msg}`);
          throw new Error(msg);
        }
        throw err;
      }
    }

    // Surface popular/fintech banks first, then sort the rest alphabetically
    const PRIORITY_BANKS = [
      "OPay",
      "Kuda",
      "PalmPay",
      "Moniepoint",
      "Carbon",
      "FairMoney",
      "GTBank",
      "Zenith Bank",
      "Access Bank",
      "First Bank",
      "UBA",
      "Stanbic IBTC",
      "FCMB",
      "Fidelity",
      "Union Bank",
      "Wema Bank",
      "Polaris Bank",
    ];

    const sorted = [...bankListCache].sort((a, b) => {
      const aIdx = PRIORITY_BANKS.findIndex((p) =>
        a.name?.toLowerCase().includes(p.toLowerCase())
      );
      const bIdx = PRIORITY_BANKS.findIndex((p) =>
        b.name?.toLowerCase().includes(p.toLowerCase())
      );
      if (aIdx !== -1 && bIdx !== -1) return aIdx - bIdx;
      if (aIdx !== -1) return -1;
      if (bIdx !== -1) return 1;
      return a.name?.localeCompare(b.name);
    });

    res.json({
      success: true,
      data: sorted,
      meta: {
        total: sorted.length,
        cachedAt: new Date(bankListCachedAt).toISOString(),
      },
    });
  } catch (err) {
    logger.error(`getBankList error: ${err.message}`);
    res.status(500).json({ success: false, message: err.message });
  }
}

/**
 * @desc    Get offramp rate quote
 * @route   GET /api/offramp/rate?token=STX&tokenAmount=100
 * @access  Public
 */
async function getOfframpRate(req, res) {
  try {
    const { token = "STX", tokenAmount } = req.query;

    if (!["STX", "USDC"].includes(token.toUpperCase())) {
      return res.status(400).json({ success: false, message: "token must be STX or USDC" });
    }

    let quote;
    if (tokenAmount) {
      const amount = parseFloat(tokenAmount);
      if (isNaN(amount) || amount <= 0) {
        return res.status(400).json({ success: false, message: "Invalid tokenAmount" });
      }
      if (amount < MIN_TOKEN_AMOUNT) {
        return res.status(400).json({ success: false, message: `Minimum is ${MIN_TOKEN_AMOUNT} ${token.toUpperCase()}` });
      }
      if (amount > MAX_TOKEN_AMOUNT) {
        return res.status(400).json({ success: false, message: `Maximum is ${MAX_TOKEN_AMOUNT} ${token.toUpperCase()}` });
      }
      quote = await calculateOfframpQuote(token, amount);
    } else {
      const prices = await getCurrentPrices();
      const tokenData = prices[token.toUpperCase()];
      quote = {
        token:         token.toUpperCase(),
        marketRateNGN: parseFloat(tokenData.priceNGN.toFixed(2)),
        flatFeeNGN:    OFFRAMP_FLAT_FEE_NGN,
        feeNote:       `₦${OFFRAMP_FLAT_FEE_NGN} flat fee deducted from NGN payout`,
        priceUSD:      tokenData.priceUSD,
        usdToNgn:      tokenData.usdToNgn,
      };
    }

    res.json({
      success: true,
      data: {
        ...quote,
        limits: { minToken: MIN_TOKEN_AMOUNT, maxToken: MAX_TOKEN_AMOUNT },
        estimatedSettlement: "5-15 minutes",
        fetchedAt: new Date().toISOString(),
      },
    });
  } catch (err) {
    logger.error(`getOfframpRate error: ${err.message}`);
    res.status(500).json({ success: false, message: err.message });
  }
}

/**
 * @desc    Verify a Nigerian bank account
 * @route   POST /api/offramp/verify-account
 * @access  Public
 * @body    { bankCode, accountNumber }
 */
async function verifyAccount(req, res) {
  try {
    const { bankCode, accountNumber } = req.body;

    if (!bankCode || !accountNumber) {
      return res.status(400).json({ success: false, message: "bankCode and accountNumber are required" });
    }
    if (!/^\d{10}$/.test(accountNumber)) {
      return res.status(400).json({ success: false, message: "accountNumber must be exactly 10 digits" });
    }

    const result = await verifyBankAccount(bankCode, accountNumber);
    res.json({ success: true, data: result });
  } catch (err) {
    logger.error(`verifyAccount error: ${err.message}`);
    res.status(400).json({ success: false, message: err.message });
  }
}

/**
 * @desc    Initiate offramp — locks rate, creates transaction, returns deposit address
 * @route   POST /api/offramp/initialize
 * @access  Public
 * @body    { token, tokenAmount, stacksAddress, bankCode, accountNumber, accountName? }
 */
async function initializeOfframp(req, res) {
  try {
    const { token, tokenAmount, stacksAddress, bankCode, accountNumber, accountName } = req.body;

    if (!token || !tokenAmount || !stacksAddress || !bankCode || !accountNumber) {
      return res.status(400).json({
        success: false,
        message: "Required: token, tokenAmount, stacksAddress, bankCode, accountNumber",
      });
    }

    const upperToken = token.toUpperCase();
    if (!["STX", "USDC"].includes(upperToken)) {
      return res.status(400).json({ success: false, message: "token must be STX or USDC" });
    }

    const amount = parseFloat(tokenAmount);
    if (isNaN(amount) || amount <= 0) {
      return res.status(400).json({ success: false, message: "tokenAmount must be a positive number" });
    }
    if (amount < MIN_TOKEN_AMOUNT) {
      return res.status(400).json({ success: false, message: `Minimum is ${MIN_TOKEN_AMOUNT} ${upperToken}` });
    }
    if (amount > MAX_TOKEN_AMOUNT) {
      return res.status(400).json({ success: false, message: `Maximum is ${MAX_TOKEN_AMOUNT} ${upperToken}` });
    }
    if (!stacksAddress.match(/^(SP|SM|ST)[0-9A-Z]{20,50}$/i)) {
      return res.status(400).json({ success: false, message: "Invalid Stacks wallet address" });
    }
    if (!/^\d{10}$/.test(accountNumber)) {
      return res.status(400).json({ success: false, message: "accountNumber must be 10 digits" });
    }

    // ── Verify bank account ──────────────────────────────────────
    logger.info(`Verifying bank account ${accountNumber} (${bankCode})...`);
    let bankDetails;
    try {
      bankDetails = await verifyBankAccount(bankCode, accountNumber);
    } catch (err) {
      return res.status(400).json({ success: false, message: `Bank verification failed: ${err.message}` });
    }

    const depositAddress = process.env.PLATFORM_STX_ADDRESS;
    if (!depositAddress) {
      return res.status(503).json({ success: false, message: "Deposit address not configured. Contact support." });
    }

    const quote = await calculateOfframpQuote(upperToken, amount);

    const transactionReference = generateReference();
    const expiresAt = new Date(Date.now() + SETTLEMENT_TIMEOUT_MINUTES * 60 * 1000);

    const tx = await Transaction.create({
      token:            upperToken,
      type:             "sell",
      direction:        "offramp",
      tokenAmount:      amount,
      ngnAmount:        quote.ngnAmount,
      feeNGN:           OFFRAMP_FLAT_FEE_NGN,
      feeToken:         0,
      netNGN:           quote.ngnAmount,
      rateAtTime:       quote.marketRateNGN,
      senderAddress:    stacksAddress,
      recipientAddress: depositAddress,
      paymentReference: transactionReference,
      status:           "pending",
      meta: {
        bankCode:        bankDetails.bankCode,
        accountNumber:   bankDetails.accountNumber,
        accountName:     bankDetails.accountName || accountName,
        bankName:        bankDetails.bankName,
        marketRateNGN:   quote.marketRateNGN,
        grossNGN:        quote.grossNGN,
        flatFeeNGN:      OFFRAMP_FLAT_FEE_NGN,
        usdToNgn:        quote.usdToNgn,
        depositAddress,
        expiresAt:       expiresAt.toISOString(),
        lencoTransferId: null,
      },
    });

    logger.info(
      `Offramp created: ${transactionReference} | ${amount} ${upperToken} → ₦${quote.ngnAmount} (after ₦${OFFRAMP_FLAT_FEE_NGN} fee) | ${stacksAddress}`
    );

    res.status(201).json({
      success: true,
      data: {
        transactionId:        tx._id,
        transactionReference,
        token:                upperToken,
        tokenAmount:          amount,
        flatFeeNGN:           OFFRAMP_FLAT_FEE_NGN,
        grossNGN:             quote.grossNGN,
        ngnAmount:            quote.ngnAmount,
        marketRateNGN:        quote.marketRateNGN,
        breakdown: {
          youSend:    `${amount} ${upperToken}`,
          grossNGN:   `${amount} × ₦${quote.marketRateNGN} = ₦${quote.grossNGN.toLocaleString()}`,
          fee:        `−₦${OFFRAMP_FLAT_FEE_NGN} flat service fee`,
          youReceive: `₦${quote.ngnAmount.toLocaleString()}`,
          rate:       `₦${quote.marketRateNGN.toFixed(2)} per ${upperToken} (live market rate)`,
          toBank:     `${bankDetails.accountName} — ${bankDetails.bankName} ${accountNumber}`,
        },
        depositInstructions: {
          sendTo:           depositAddress,
          amount:           `${amount} ${upperToken}`,
          memo:             transactionReference,
          warning:          `Include "${transactionReference}" as memo/note. Tokens without correct memo cannot be matched.`,
          expiresAt:        expiresAt.toISOString(),
          expiresInMinutes: SETTLEMENT_TIMEOUT_MINUTES,
        },
        bank: {
          accountName:   bankDetails.accountName,
          accountNumber,
          bankName:      bankDetails.bankName,
          bankCode:      bankDetails.bankCode,
        },
      },
    });
  } catch (err) {
    logger.error(`initializeOfframp error: ${err.message}`);
    res.status(500).json({ success: false, message: err.message });
  }
}

/**
 * @desc    Confirm Stacks token receipt and trigger Lenco NGN payout
 * @route   POST /api/offramp/confirm-receipt
 * @access  Internal (x-internal-key header required — called by stacksIndexer.js only)
 */
async function confirmTokenReceipt(req, res) {
  try {
    const { transactionReference, stacksTxId, tokenAmount, token, senderAddress } = req.body;

    if (!transactionReference || !stacksTxId) {
      return res.status(400).json({ success: false, message: "transactionReference and stacksTxId required" });
    }

    const tx = await Transaction.findOne({ paymentReference: transactionReference, direction: "offramp" });
    if (!tx) return res.status(404).json({ success: false, message: "Transaction not found" });

    if (tx.status === "confirmed" || tx.status === "processing") {
      logger.info(`Offramp ${transactionReference} already processed — idempotent`);
      return res.json({ success: true, message: "Already processed" });
    }

    if (tx.status !== "pending") {
      return res.status(400).json({ success: false, message: `Cannot confirm — status is ${tx.status}` });
    }

    const tolerance = tx.tokenAmount * 0.001;
    if (Math.abs(parseFloat(tokenAmount) - tx.tokenAmount) > tolerance) {
      logger.warn(
        `Token amount mismatch for ${transactionReference}: expected ${tx.tokenAmount}, got ${tokenAmount}`
      );
    }

    tx.status = "processing";
    tx.txId   = stacksTxId;
    tx.meta   = { ...tx.meta, stacksTxId, tokenReceivedAt: new Date().toISOString() };
    await tx.save();

    logger.info(`Tokens received for ${transactionReference} — initiating Lenco NGN payout`);
    logger.info(`  Amount: ${tx.ngnAmount} NGN → ${tx.meta.accountName} (${tx.meta.bankName})`);

    let lencoResult;
    try {
      lencoResult = await initiateLencoTransfer(
        tx.ngnAmount,
        tx.meta.accountNumber,
        tx.meta.bankCode,
        tx.meta.accountName,
        transactionReference
      );

      tx.status = "settling";
      tx.meta   = {
        ...tx.meta,
        lencoTransferId:       lencoResult.transferId,
        settlementInitiatedAt: new Date().toISOString(),
      };
      await tx.save();

      logger.info(`Lenco transfer initiated: ${lencoResult.transferId}`);
    } catch (lencoErr) {
      logger.error(`Lenco transfer failed for ${transactionReference}: ${lencoErr.message}`);
      logger.error(`CRITICAL: Tokens received but NGN not sent — manual action required`);
      logger.error(`  Stacks TX: ${stacksTxId} | NGN: ${tx.ngnAmount} → ${tx.meta.accountNumber}`);

      tx.status = "failed";
      tx.meta   = {
        ...tx.meta,
        failureReason:            `Lenco failed: ${lencoErr.message}`,
        requiresManualSettlement: true,
      };
      await tx.save();

      return res.status(500).json({ success: false, message: "NGN settlement failed. Support notified." });
    }

    res.json({
      success: true,
      message: "Tokens received. NGN settlement initiated.",
      data: {
        transactionReference,
        stacksTxId,
        tokenAmount:         tx.tokenAmount,
        ngnAmount:           tx.ngnAmount,
        lencoTransferId:     lencoResult.transferId,
        estimatedSettlement: "5-15 minutes",
      },
    });
  } catch (err) {
    logger.error(`confirmTokenReceipt error: ${err.message}`);
    res.status(500).json({ success: false, message: err.message });
  }
}

/**
 * @desc    Handle Lenco webhook — finalize transaction on successful bank transfer
 * @route   POST /api/offramp/lenco-webhook
 * @access  Public (verified via HMAC signature)
 */
async function handleLencoWebhook(req, res) {
  logger.info("=".repeat(60));
  logger.info("LENCO WEBHOOK RECEIVED");

  const payload   = req.body;
  const signature = req.headers["x-lenco-signature"];

  if (!signature) {
    logger.error("Lenco webhook rejected — missing x-lenco-signature header");
    return res.status(401).json({ success: false, message: "Missing signature" });
  }

  if (!verifyLencoSignature(payload, signature)) {
    logger.error("Lenco webhook rejected — invalid signature");
    return res.status(401).json({ success: false, message: "Invalid signature" });
  }

  const { event, data } = payload;
  logger.info(`Lenco event: ${event} | reference: ${data?.reference}`);

  if (event === "transfer.completed") {
    const tx = await Transaction.findOne({ paymentReference: data.reference, direction: "offramp" });

    if (!tx) {
      logger.warn(`Lenco webhook: no offramp tx found for reference ${data.reference}`);
      return res.json({ success: true, message: "Webhook received" });
    }

    if (tx.status === "confirmed") {
      return res.json({ success: true, message: "Already confirmed" });
    }

    tx.status      = "confirmed";
    tx.confirmedAt = new Date();
    tx.meta        = {
      ...tx.meta,
      lencoStatus:    "completed",
      lencoSettledAt: new Date().toISOString(),
    };
    await tx.save();

    logger.info(`✅ Offramp COMPLETE: ${tx.tokenAmount} ${tx.token} → ₦${tx.ngnAmount} → ${tx.meta.accountName}`);
    return res.json({ success: true, message: "Transaction confirmed" });
  }

  if (event === "transfer.failed" || event === "transfer.reversed") {
    const tx = await Transaction.findOne({ paymentReference: data.reference, direction: "offramp" });

    if (tx) {
      tx.status = "failed";
      tx.meta   = {
        ...tx.meta,
        lencoStatus:              "failed",
        failureReason:            data.reason || `Lenco event: ${event}`,
        requiresManualSettlement: true,
      };
      await tx.save();
      logger.error(`Offramp settlement FAILED: ${data.reference} — ${data.reason || event}`);
      logger.error(`MANUAL ACTION: Refund ${tx.tokenAmount} ${tx.token} to ${tx.senderAddress}`);
    }

    return res.json({ success: true, message: "Failure recorded" });
  }

  res.json({ success: true, message: `Event ${event} acknowledged` });
}

/**
 * @desc    Get offramp transaction status
 * @route   GET /api/offramp/status/:reference
 * @access  Public
 */
async function getOfframpStatus(req, res) {
  try {
    const tx = await Transaction.findOne({
      paymentReference: req.params.reference,
      direction:        "offramp",
    }).lean();

    if (!tx) return res.status(404).json({ success: false, message: "Transaction not found" });

    const statusMessages = {
      pending:    "Awaiting token deposit to our address",
      processing: "Tokens received. Initiating NGN transfer.",
      settling:   "NGN bank transfer in progress",
      confirmed:  "NGN successfully sent to your bank account",
      failed:     "Transaction failed",
    };

    res.json({
      success: true,
      data: {
        transactionId:        tx._id,
        transactionReference: tx.paymentReference,
        token:                tx.token,
        tokenAmount:          tx.tokenAmount,
        ngnAmount:            tx.ngnAmount,
        status:               tx.status,
        statusMessage:        statusMessages[tx.status] || tx.status,
        stacksTxId:           tx.txId,
        lencoTransferId:      tx.meta?.lencoTransferId,
        bank: {
          accountName:   tx.meta?.accountName,
          accountNumber: tx.meta?.accountNumber,
          bankName:      tx.meta?.bankName,
        },
        createdAt:     tx.createdAt,
        confirmedAt:   tx.confirmedAt,
        failureReason: tx.status === "failed" ? tx.meta?.failureReason : undefined,
      },
    });
  } catch (err) {
    logger.error(`getOfframpStatus error: ${err.message}`);
    res.status(500).json({ success: false, message: "Failed to fetch status" });
  }
}

/**
 * @desc    Get offramp history for a Stacks address
 * @route   GET /api/offramp/history?address=SP...&page=1&limit=20
 * @access  Public
 */
async function getOfframpHistory(req, res) {
  try {
    const { address, page = 1, limit = 20, status, token } = req.query;
    if (!address) return res.status(400).json({ success: false, message: "address is required" });

    const query = { senderAddress: address, direction: "offramp" };
    if (status) query.status = status;
    if (token) query.token = token.toUpperCase();

    const pageNum  = parseInt(page);
    const limitNum = Math.min(parseInt(limit), 100);
    const skip     = (pageNum - 1) * limitNum;

    const [txs, total] = await Promise.all([
      Transaction.find(query).sort({ createdAt: -1 }).skip(skip).limit(limitNum).lean(),
      Transaction.countDocuments(query),
    ]);

    const safeList = txs.map((tx) => ({
      transactionId:        tx._id,
      transactionReference: tx.paymentReference,
      token:                tx.token,
      tokenAmount:          tx.tokenAmount,
      ngnAmount:            tx.ngnAmount,
      status:               tx.status,
      bankName:             tx.meta?.bankName,
      accountLast4:         tx.meta?.accountNumber?.slice(-4),
      stacksTxId:           tx.txId,
      createdAt:            tx.createdAt,
      confirmedAt:          tx.confirmedAt,
    }));

    res.json({
      success: true,
      data:    safeList,
      pagination: {
        page:  pageNum,
        limit: limitNum,
        total,
        pages: Math.ceil(total / limitNum),
      },
    });
  } catch (err) {
    logger.error(`getOfframpHistory error: ${err.message}`);
    res.status(500).json({ success: false, message: "Failed to fetch history" });
  }
}

module.exports = {
  getBankList,
  getOfframpRate,
  verifyAccount,
  initializeOfframp,
  confirmTokenReceipt,
  handleLencoWebhook,
  getOfframpStatus,
  getOfframpHistory,
};