// ============= controllers/offrampController.js =============
// StackSwap Offramp: Send STX or USDC from Stacks wallet → Receive NGN via Lenco bank transfer
// VERBOSE LOGGING VERSION — every step prints to console so you can trace exactly what's happening.

const crypto = require("crypto");
const axios  = require("axios");
const Transaction = require("../models/Transaction");
const { getCurrentPrices } = require("../services/priceService");

// ── Shared console logger ────────────────────────────────────────────────────
const { offramp: log, lenco: llog, poll: plog, c, divider, box } = require("../config/consoleLogger");

// ── Config ───────────────────────────────────────────────────────────────────
const LENCO_API_KEY         = process.env.LENCO_API_KEY         || "";
const LENCO_BASE_URL        = "https://api.lenco.co";
const LENCO_WEBHOOK_SECRET  = process.env.LENCO_WEBHOOK_SECRET  || "";
const STACKS_API_URL        = process.env.STACKS_API_URL        || "https://api.mainnet.hiro.so";
const OFFRAMP_FLAT_FEE_NGN  = parseFloat(process.env.OFFRAMP_FLAT_FEE_NGN || "100");
const MIN_TOKEN_AMOUNT      = parseFloat(process.env.OFFRAMP_MIN_TOKEN     || "1");
const MAX_TOKEN_AMOUNT      = parseFloat(process.env.OFFRAMP_MAX_TOKEN     || "50000");
const SETTLEMENT_TIMEOUT_MINUTES = 30;

// ── Liquidity buffer: reject orders if balance would drop below this amount ──
// Set LENCO_MIN_BALANCE_NGN in your .env — defaults to 5,000 NGN safety cushion
const LENCO_MIN_BALANCE_NGN = parseFloat(process.env.LENCO_MIN_BALANCE_NGN || "5000");

// ── Bank list cache ──────────────────────────────────────────────────────────
let bankListCache    = null;
let bankListCachedAt = null;
const BANK_CACHE_TTL_MS = 24 * 60 * 60 * 1000;

// ── Lenco balance cache (short TTL — 30 seconds) ─────────────────────────────
let lencoBalanceCache     = null;
let lencoBalanceCachedAt  = null;
const BALANCE_CACHE_TTL_MS = 30 * 1000; // 30 seconds

// ── Helpers ──────────────────────────────────────────────────────────────────

function generateReference() {
  const ts   = Date.now().toString(36).toUpperCase();
  const rand = crypto.randomBytes(4).toString("hex").toUpperCase();
  return `SSWAP_OFFRAMP_${ts}_${rand}`;
}

function verifyLencoSignature(payload, signature) {
  if (!LENCO_WEBHOOK_SECRET) {
    log.warn("LENCO_WEBHOOK_SECRET not configured — skipping signature check");
    return true;
  }
  const hash = crypto
    .createHmac("sha256", LENCO_WEBHOOK_SECRET)
    .update(JSON.stringify(payload))
    .digest("hex");
  const match = hash === signature;
  if (!match) {
    log.error(`Signature mismatch\n  Expected: ${hash}\n  Got     : ${signature}`);
  }
  return match;
}

// ── Lenco Balance Check ───────────────────────────────────────────────────────
// Fetches the NGN balance of the platform's Lenco account.
// Uses a short cache (30s) to avoid hammering the API on every order attempt.

async function getLencoAccountBalance(forceRefresh = false) {
  const debitAccountId = process.env.LENCO_ACCOUNT_ID;
  if (!debitAccountId) {
    llog.warn("LENCO_ACCOUNT_ID not set — skipping balance check");
    return null;
  }

  const now        = Date.now();
  const cacheStale = !lencoBalanceCachedAt || now - lencoBalanceCachedAt > BALANCE_CACHE_TTL_MS;

  if (!forceRefresh && lencoBalanceCache !== null && !cacheStale) {
    llog.info(`Balance cache hit — ₦${lencoBalanceCache.toLocaleString()} (age: ${Math.round((now - lencoBalanceCachedAt) / 1000)}s)`);
    return lencoBalanceCache;
  }

  llog.info(`Fetching Lenco account balance... (accountId: ${debitAccountId})`);

  try {
    // Lenco GET /access/v1/accounts/:accountId returns account details including balance
    const res = await axios.get(`${LENCO_BASE_URL}/access/v1/accounts/${debitAccountId}`, {
      headers: { Authorization: `Bearer ${LENCO_API_KEY}`, "Content-Type": "application/json" },
      timeout: 10000,
    });

    llog.info(`  HTTP ${res.status}`);
    llog.data("Lenco account response", res.data);

    if (!res.data?.status) {
      throw new Error(res.data?.message || "Failed to fetch account balance");
    }

    // Lenco returns balance in kobo (smallest unit) — convert to NGN
    // e.g. 500000 kobo = ₦5,000
    const balanceRaw = res.data?.data?.availableBalance ?? res.data?.data?.balance ?? 0;
    const balanceNGN = balanceRaw / 100; // kobo → NGN

    lencoBalanceCache    = balanceNGN;
    lencoBalanceCachedAt = now;

    llog.success(`Lenco balance: ${c.bold}${c.green}₦${balanceNGN.toLocaleString()}${c.reset} (raw: ${balanceRaw} kobo)`);
    return balanceNGN;

  } catch (err) {
    if (err.response) {
      llog.error(`Lenco balance HTTP ${err.response.status}: ${err.response.data?.message || JSON.stringify(err.response.data)}`);
    } else {
      llog.error(`Lenco balance network error: ${err.message}`);
    }
    // Return cached value if we have one (even stale) rather than hard-failing
    if (lencoBalanceCache !== null) {
      llog.warn(`Using stale cached balance: ₦${lencoBalanceCache.toLocaleString()}`);
      return lencoBalanceCache;
    }
    return null; // null = unknown, caller decides how to handle
  }
}

// ── Liquidity check: can we fulfil this order? ────────────────────────────────
// Returns { ok: true } or { ok: false, reason, availableNGN, requiredNGN }

async function checkLiquidity(requiredNGN) {
  llog.info(`Checking liquidity — order needs: ${c.bold}₦${requiredNGN.toLocaleString()}${c.reset} | minimum buffer: ₦${LENCO_MIN_BALANCE_NGN.toLocaleString()}`);

  const balanceNGN = await getLencoAccountBalance();

  if (balanceNGN === null) {
    // Can't reach Lenco — fail safe: reject the order
    llog.warn("Balance unknown (Lenco unreachable) — rejecting order as precaution");
    return {
      ok: false,
      reason: "Unable to verify liquidity at this time. Please try again in a moment.",
      availableNGN: null,
      requiredNGN,
    };
  }

  // Total needed = payout amount + safety buffer
  const totalNeeded = requiredNGN + LENCO_MIN_BALANCE_NGN;

  if (balanceNGN < totalNeeded) {
    const shortfall = totalNeeded - balanceNGN;
    llog.error(
      `Insufficient liquidity!\n` +
      `  Balance     : ₦${balanceNGN.toLocaleString()}\n` +
      `  Order needs : ₦${requiredNGN.toLocaleString()}\n` +
      `  Buffer      : ₦${LENCO_MIN_BALANCE_NGN.toLocaleString()}\n` +
      `  Total needed: ₦${totalNeeded.toLocaleString()}\n` +
      `  Shortfall   : ${c.red}₦${shortfall.toLocaleString()}${c.reset}`
    );
    return {
      ok: false,
      reason: "Insufficient liquidity to process this order right now. Please try a smaller amount or come back shortly.",
      availableNGN: balanceNGN,
      requiredNGN,
      shortfallNGN: shortfall,
    };
  }

  llog.success(
    `Liquidity OK — balance ₦${balanceNGN.toLocaleString()} ≥ required ₦${totalNeeded.toLocaleString()} ` +
    `(order ₦${requiredNGN.toLocaleString()} + buffer ₦${LENCO_MIN_BALANCE_NGN.toLocaleString()})`
  );
  return {
    ok: true,
    availableNGN: balanceNGN,
    requiredNGN,
  };
}

async function calculateOfframpQuote(token, tokenAmount) {
  log.step(1, `Calculating quote — ${c.bold}${tokenAmount} ${token}${c.reset}`);
  const prices    = await getCurrentPrices();
  const tokenData = prices[token.toUpperCase()];
  if (!tokenData) throw new Error(`Unsupported token: ${token}`);

  const marketRateNGN = tokenData.priceNGN;
  const grossNGN      = tokenAmount * marketRateNGN;
  // ✅ FIX: floor to whole NGN — Lenco requires integer amounts
  const ngnAmount     = Math.floor(grossNGN - OFFRAMP_FLAT_FEE_NGN);

  const quote = {
    token:         token.toUpperCase(),
    marketRateNGN: parseFloat(marketRateNGN.toFixed(2)),
    flatFeeNGN:    OFFRAMP_FLAT_FEE_NGN,
    grossNGN:      parseFloat(grossNGN.toFixed(2)),
    ngnAmount,   // already a whole number
    tokenAmount:   parseFloat(tokenAmount.toFixed(6)),
    priceUSD:      tokenData.priceUSD,
    usdToNgn:      tokenData.usdToNgn,
  };

  box([
    `${c.bold}Token     :${c.reset} ${quote.token}`,
    `${c.bold}Amount    :${c.reset} ${quote.tokenAmount}`,
    `${c.bold}Rate NGN  :${c.reset} ₦${quote.marketRateNGN.toLocaleString()}`,
    `${c.bold}Gross NGN :${c.reset} ₦${quote.grossNGN.toLocaleString()}`,
    `${c.bold}Fee       :${c.reset} ₦${quote.flatFeeNGN}`,
    `${c.bold}Net NGN   :${c.reset} ${c.green}₦${quote.ngnAmount.toLocaleString()}${c.reset}`,
  ]);

  if (ngnAmount <= 0) throw new Error(`Amount too small — ₦${OFFRAMP_FLAT_FEE_NGN} fee exceeds payout`);
  return quote;
}

async function verifyBankAccount(bankCode, accountNumber) {
  const url = `${LENCO_BASE_URL}/access/v1/resolve`;
  llog.info(`Verifying bank account → GET ${url}`);
  llog.info(`  bankCode=${c.bold}${bankCode}${c.reset} | accountNumber=${c.bold}${accountNumber}${c.reset}`);

  try {
    const res = await axios.get(url, {
      params:  { bankCode, accountNumber },
      headers: { Authorization: `Bearer ${LENCO_API_KEY}`, "Content-Type": "application/json" },
      timeout: 15000,
    });

    llog.info(`  HTTP ${res.status} — ${res.data?.status ? c.green + "OK" + c.reset : c.red + "FAILED" + c.reset}`);
    llog.data("Lenco resolve response", res.data);

    if (!res.data?.status) throw new Error(res.data?.message || "Account verification failed");

    const result = {
      success:       true,
      accountName:   res.data.data?.accountName,
      accountNumber: res.data.data?.accountNumber,
      bankCode:      res.data.data?.bank?.code || bankCode,
      bankName:      res.data.data?.bank?.name,
    };
    llog.success(`Account verified: ${c.bold}${result.accountName}${c.reset} @ ${result.bankName}`);
    return result;
  } catch (err) {
    if (err.response) {
      const msg = err.response.data?.message || err.response.data?.error || JSON.stringify(err.response.data);
      llog.error(`Lenco resolve HTTP ${err.response.status}: ${msg}`);
      llog.data("Lenco error body", err.response.data);
      throw new Error(msg);
    }
    llog.error(`Lenco resolve network error: ${err.message}`);
    throw err;
  }
}

async function initiateLencoTransfer(amountNGN, accountNumber, bankCode, accountName, reference) {
  const debitAccountId = process.env.LENCO_ACCOUNT_ID;

  divider("💸 LENCO NGN TRANSFER");
  llog.info(`Initiating transfer → POST ${LENCO_BASE_URL}/access/v1/transactions`);
  box([
    `${c.bold}Reference   :${c.reset} ${reference}`,
    `${c.bold}Amount      :${c.reset} ${c.green}₦${amountNGN.toLocaleString()}${c.reset}`,
    `${c.bold}To account  :${c.reset} ${accountNumber} (${bankCode})`,
    `${c.bold}Account name:${c.reset} ${accountName}`,
    `${c.bold}Debit from  :${c.reset} ${debitAccountId || c.red + "NOT SET ⚠" + c.reset}`,
  ]);

  if (!debitAccountId) throw new Error("LENCO_ACCOUNT_ID not configured — needed to debit your Lenco account");

  const payload = {
    accountId:    debitAccountId,
    amount:       String(amountNGN),
    accountNumber,
    bankCode,
    narration:    `StackSwap offramp - ${reference}`,
    reference,
  };

  llog.data("Lenco transfer request body", payload);

  try {
    const res = await axios.post(`${LENCO_BASE_URL}/access/v1/transactions`, payload, {
      headers: { Authorization: `Bearer ${LENCO_API_KEY}`, "Content-Type": "application/json" },
      timeout: 30000,
    });

    llog.info(`  HTTP ${res.status}`);
    llog.data("Lenco transfer response", res.data);

    if (!res.data?.status) throw new Error(res.data?.message || "Lenco transfer initiation failed");

    const result = {
      success:        true,
      transferId:     res.data.data?.id,
      lencoReference: res.data.data?.transactionReference,
      status:         res.data.data?.status,
      reference,
    };
    llog.success(`Transfer initiated — ID: ${c.bold}${result.transferId}${c.reset} | Status: ${result.status}`);

    // Bust the balance cache immediately after a transfer so the next order
    // sees the updated (lower) balance
    lencoBalanceCache    = null;
    lencoBalanceCachedAt = null;
    llog.info("Balance cache invalidated after transfer");

    return result;
  } catch (err) {
    if (err.response) {
      const msg = err.response.data?.message || err.response.data?.error || JSON.stringify(err.response.data);
      llog.error(`Lenco transfer HTTP ${err.response.status}: ${msg}`);
      llog.data("Lenco transfer error body", err.response.data);
      throw new Error(msg);
    }
    llog.error(`Lenco transfer network error: ${err.message}`);
    throw err;
  }
}

// ── Controllers ──────────────────────────────────────────────────────────────

async function getBankList(req, res) {
  log.info("GET /banks — fetching bank list");
  try {
    const now        = Date.now();
    const cacheStale = !bankListCachedAt || now - bankListCachedAt > BANK_CACHE_TTL_MS;

    if (!bankListCache || cacheStale) {
      log.info("Cache miss — fetching from Lenco...");
      const response = await axios.get(`${LENCO_BASE_URL}/access/v1/banks`, {
        headers: { Authorization: `Bearer ${LENCO_API_KEY}`, "Content-Type": "application/json" },
        timeout: 15000,
      });
      log.info(`Lenco banks HTTP ${response.status}`);
      if (!response.data?.status) throw new Error(response.data?.message || "Failed to fetch bank list");
      bankListCache    = response.data.data || [];
      bankListCachedAt = now;
      log.success(`Bank list cached — ${c.bold}${bankListCache.length}${c.reset} banks`);
    } else {
      log.info(`Cache hit — ${bankListCache.length} banks (age: ${Math.round((now - bankListCachedAt) / 1000)}s)`);
    }

    const PRIORITY_BANKS = ["OPay","Kuda","PalmPay","Moniepoint","Carbon","FairMoney","GTBank","Zenith Bank","Access Bank","First Bank","UBA","Stanbic IBTC","FCMB","Fidelity","Union Bank","Wema Bank","Polaris Bank"];
    const sorted = [...bankListCache].sort((a, b) => {
      const aIdx = PRIORITY_BANKS.findIndex((p) => a.name?.toLowerCase().includes(p.toLowerCase()));
      const bIdx = PRIORITY_BANKS.findIndex((p) => b.name?.toLowerCase().includes(p.toLowerCase()));
      if (aIdx !== -1 && bIdx !== -1) return aIdx - bIdx;
      if (aIdx !== -1) return -1;
      if (bIdx !== -1) return 1;
      return a.name?.localeCompare(b.name);
    });

    log.success(`Returning ${sorted.length} banks`);
    res.json({ success: true, data: sorted, meta: { total: sorted.length, cachedAt: new Date(bankListCachedAt).toISOString() } });
  } catch (err) {
    log.error(`getBankList error: ${err.message}`);
    res.status(500).json({ success: false, message: err.message });
  }
}

async function getOfframpRate(req, res) {
  const { token = "STX", tokenAmount } = req.query;
  log.info(`GET /rate — token=${token} tokenAmount=${tokenAmount || "(not provided)"}`);
  try {
    if (!["STX", "USDC"].includes(token.toUpperCase())) {
      return res.status(400).json({ success: false, message: "token must be STX or USDC" });
    }
    let quote;
    if (tokenAmount) {
      const amount = parseFloat(tokenAmount);
      if (isNaN(amount) || amount <= 0) return res.status(400).json({ success: false, message: "Invalid tokenAmount" });
      if (amount < MIN_TOKEN_AMOUNT) return res.status(400).json({ success: false, message: `Minimum is ${MIN_TOKEN_AMOUNT} ${token.toUpperCase()}` });
      if (amount > MAX_TOKEN_AMOUNT) return res.status(400).json({ success: false, message: `Maximum is ${MAX_TOKEN_AMOUNT} ${token.toUpperCase()}` });
      quote = await calculateOfframpQuote(token, amount);
    } else {
      const prices    = await getCurrentPrices();
      const tokenData = prices[token.toUpperCase()];
      quote = { token: token.toUpperCase(), marketRateNGN: parseFloat(tokenData.priceNGN.toFixed(2)), flatFeeNGN: OFFRAMP_FLAT_FEE_NGN, priceUSD: tokenData.priceUSD, usdToNgn: tokenData.usdToNgn };
    }
    log.success(`Rate fetched for ${token}: ₦${quote.marketRateNGN}`);
    res.json({ success: true, data: { ...quote, limits: { minToken: MIN_TOKEN_AMOUNT, maxToken: MAX_TOKEN_AMOUNT }, estimatedSettlement: "30-60 seconds", fetchedAt: new Date().toISOString() } });
  } catch (err) {
    log.error(`getOfframpRate error: ${err.message}`);
    res.status(500).json({ success: false, message: err.message });
  }
}

async function verifyAccount(req, res) {
  const { bankCode, accountNumber } = req.body;
  log.info(`POST /verify-account — bankCode=${bankCode} accountNumber=${accountNumber}`);
  try {
    if (!bankCode || !accountNumber) return res.status(400).json({ success: false, message: "bankCode and accountNumber are required" });
    if (!/^\d{10}$/.test(accountNumber)) return res.status(400).json({ success: false, message: "accountNumber must be exactly 10 digits" });
    const result = await verifyBankAccount(bankCode, accountNumber);
    res.json({ success: true, data: result });
  } catch (err) {
    log.error(`verifyAccount error: ${err.message}`);
    res.status(400).json({ success: false, message: err.message });
  }
}

// ── NEW: Public endpoint to expose available liquidity to the frontend ────────
// GET /api/offramp/liquidity
// Returns the platform's available NGN balance so the UI can warn users early.
// Does NOT expose the raw balance — returns a sanitised "maxOrderNGN" instead.

async function getLiquidityInfo(req, res) {
  log.info("GET /liquidity — checking platform liquidity");
  try {
    const balanceNGN = await getLencoAccountBalance(true); // force refresh

    if (balanceNGN === null) {
      return res.status(503).json({
        success: false,
        message: "Liquidity check temporarily unavailable",
        available: false,
      });
    }

    // Max single order = balance minus the safety buffer
    const maxOrderNGN = Math.max(0, Math.floor(balanceNGN - LENCO_MIN_BALANCE_NGN));
    const available   = maxOrderNGN > 0;

    log.info(`Liquidity: balance=₦${balanceNGN.toLocaleString()} maxOrder=₦${maxOrderNGN.toLocaleString()} available=${available}`);

    res.json({
      success: true,
      data: {
        available,          // bool — true if any orders can be processed
        maxOrderNGN,        // max NGN value of a single order we can fulfil right now
        minBufferNGN: LENCO_MIN_BALANCE_NGN,
        checkedAt: new Date().toISOString(),
      },
    });
  } catch (err) {
    log.error(`getLiquidityInfo error: ${err.message}`);
    res.status(500).json({ success: false, message: err.message });
  }
}

async function initializeOfframp(req, res) {
  const { token, tokenAmount, stacksAddress, bankCode, accountNumber, accountName } = req.body;

  divider("🚀 OFFRAMP INITIALIZE");
  log.info("POST /initialize");
  box([
    `${c.bold}Token      :${c.reset} ${token}`,
    `${c.bold}Amount     :${c.reset} ${tokenAmount}`,
    `${c.bold}Wallet     :${c.reset} ${stacksAddress}`,
    `${c.bold}Bank code  :${c.reset} ${bankCode}`,
    `${c.bold}Account    :${c.reset} ${accountNumber}`,
    `${c.bold}Acct name  :${c.reset} ${accountName || "(not provided)"}`,
  ]);

  try {
    if (!token || !tokenAmount || !stacksAddress || !bankCode || !accountNumber) {
      log.warn("Missing required fields");
      return res.status(400).json({ success: false, message: "Required: token, tokenAmount, stacksAddress, bankCode, accountNumber" });
    }

    const upperToken = token.toUpperCase();
    if (!["STX", "USDC"].includes(upperToken)) return res.status(400).json({ success: false, message: "token must be STX or USDC" });

    const amount = parseFloat(tokenAmount);
    if (isNaN(amount) || amount <= 0) return res.status(400).json({ success: false, message: "tokenAmount must be a positive number" });
    if (amount < MIN_TOKEN_AMOUNT) return res.status(400).json({ success: false, message: `Minimum is ${MIN_TOKEN_AMOUNT} ${upperToken}` });
    if (amount > MAX_TOKEN_AMOUNT) return res.status(400).json({ success: false, message: `Maximum is ${MAX_TOKEN_AMOUNT} ${upperToken}` });
    if (!stacksAddress.match(/^(SP|SM|ST)[0-9A-Z]{20,50}$/i)) return res.status(400).json({ success: false, message: "Invalid Stacks wallet address" });
    if (!/^\d{10}$/.test(accountNumber)) return res.status(400).json({ success: false, message: "accountNumber must be 10 digits" });

    // Step 1: Verify bank
    log.step(1, "Verifying bank account with Lenco...");
    let bankDetails;
    try {
      bankDetails = await verifyBankAccount(bankCode, accountNumber);
    } catch (err) {
      log.error(`Bank verification failed: ${err.message}`);
      return res.status(400).json({ success: false, message: `Bank verification failed: ${err.message}` });
    }

    // Step 2: Check deposit address
    log.step(2, "Checking platform deposit address...");
    const depositAddress = process.env.PLATFORM_STX_ADDRESS;
    if (!depositAddress) {
      log.error("PLATFORM_STX_ADDRESS not set in environment!");
      return res.status(503).json({ success: false, message: "Deposit address not configured. Contact support." });
    }
    log.info(`  Deposit address: ${c.bold}${depositAddress}${c.reset}`);

    // Step 3: Calculate quote
    log.step(3, "Calculating NGN quote...");
    const quote = await calculateOfframpQuote(upperToken, amount);

    // ── Step 4: LIQUIDITY CHECK ───────────────────────────────────────────────
    // Verify the platform's Lenco account has enough NGN to fulfil this payout
    // BEFORE we create the DB record or ask the user to sign anything.
    log.step(4, "Checking Lenco account liquidity...");
    const liquidity = await checkLiquidity(quote.ngnAmount);

    if (!liquidity.ok) {
      divider("🚫 ORDER REJECTED — INSUFFICIENT LIQUIDITY");
      log.error(
        `Rejected order:\n` +
        `  Required : ₦${quote.ngnAmount.toLocaleString()}\n` +
        `  Available: ${liquidity.availableNGN !== null ? "₦" + liquidity.availableNGN.toLocaleString() : "unknown"}\n` +
        `  Reason   : ${liquidity.reason}`
      );
      return res.status(503).json({
        success: false,
        message: liquidity.reason,
        code: "INSUFFICIENT_LIQUIDITY",
        data: {
          requiredNGN:   quote.ngnAmount,
          // We deliberately don't expose the raw balance to end users for security.
          // We only tell them the max they CAN sell right now (if knowable).
          maxOrderNGN: liquidity.availableNGN !== null
            ? Math.max(0, Math.floor(liquidity.availableNGN - LENCO_MIN_BALANCE_NGN))
            : null,
        },
      });
    }

    // Step 5: Create transaction
    log.step(5, "Creating pending transaction in DB...");
    const transactionReference = generateReference();
    const expiresAt            = new Date(Date.now() + SETTLEMENT_TIMEOUT_MINUTES * 60 * 1000);

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
        // Record the balance snapshot at time of order for audit trail
        balanceAtOrderTime: liquidity.availableNGN,
      },
    });

    log.success(`Transaction created in DB — ID: ${c.bold}${tx._id}${c.reset}`);
    box([
      `${c.bold}Reference  :${c.reset} ${transactionReference}`,
      `${c.bold}DB ID      :${c.reset} ${tx._id}`,
      `${c.bold}You send   :${c.reset} ${amount} ${upperToken}`,
      `${c.bold}Gross NGN  :${c.reset} ₦${quote.grossNGN.toLocaleString()}`,
      `${c.bold}Fee        :${c.reset} ₦${OFFRAMP_FLAT_FEE_NGN}`,
      `${c.bold}Net NGN    :${c.reset} ${c.green}₦${quote.ngnAmount.toLocaleString()}${c.reset}`,
      `${c.bold}Expires at :${c.reset} ${expiresAt.toISOString()}`,
      `${c.bold}Bank       :${c.reset} ${bankDetails.accountName} — ${bankDetails.bankName} ${accountNumber}`,
      `${c.bold}Balance    :${c.reset} ₦${liquidity.availableNGN?.toLocaleString()} (at order time)`,
    ]);

    log.info(`⏳ Waiting for user to broadcast TX on Stacks...`);

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
          toBank:     `${bankDetails.accountName} — ${bankDetails.bankName} ${accountNumber}`,
        },
        depositInstructions: {
          sendTo:           depositAddress,
          amount:           `${amount} ${upperToken}`,
          memo:             transactionReference,
          warning:          `Include "${transactionReference}" as memo/note.`,
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
    log.error(`initializeOfframp error: ${err.message}`);
    log.error(err.stack);
    res.status(500).json({ success: false, message: err.message });
  }
}

// ── notifyTxBroadcast + pollAndSettle ─────────────────────────────────────────

async function notifyTxBroadcast(req, res) {
  const { transactionReference, stacksTxId } = req.body;

  divider("📡 TX BROADCAST NOTIFICATION");
  log.info("POST /notify-tx");
  box([
    `${c.bold}Reference :${c.reset} ${transactionReference}`,
    `${c.bold}Stacks TX :${c.reset} ${stacksTxId}`,
  ]);

  if (!transactionReference || !stacksTxId) {
    log.warn("Missing transactionReference or stacksTxId");
    return res.status(400).json({ success: false, message: "transactionReference and stacksTxId required" });
  }

  const tx = await Transaction.findOne({ paymentReference: transactionReference, direction: "offramp" });
  if (!tx) {
    log.error(`Transaction not found in DB for reference: ${transactionReference}`);
    return res.status(404).json({ success: false, message: "Transaction not found" });
  }

  log.info(`Found TX in DB — current status: ${c.bold}${tx.status}${c.reset}`);

  if (["confirmed", "processing", "settling"].includes(tx.status)) {
    log.warn(`Already in progress (status: ${tx.status}) — no action needed`);
    return res.json({ success: true, message: "Already processing" });
  }

  tx.txId = stacksTxId;
  tx.meta = { ...tx.meta, stacksTxId, notifiedAt: new Date().toISOString() };
  await tx.save();
  log.success(`TX ID saved to DB — starting background polling`);

  res.json({
    success: true,
    message: "TX received. Monitoring confirmation and triggering NGN payout.",
    data: { transactionReference, stacksTxId },
  });

  pollAndSettle(tx, stacksTxId, transactionReference).catch((err) => {
    log.error(`pollAndSettle crashed for ${transactionReference}: ${err.message}`);
    log.error(err.stack);
  });
}

async function pollAndSettle(tx, stacksTxId, reference) {
  const MAX_ATTEMPTS    = 120;
  const POLL_INTERVAL   = 5000;
  const explorerBase    = "https://explorer.hiro.so/txid";

  divider("🔄 POLLING STACKS FOR TX CONFIRMATION");
  plog.info(`Starting poll loop for ${c.bold}${reference}${c.reset}`);
  box([
    `${c.bold}Stacks TX  :${c.reset} ${stacksTxId}`,
    `${c.bold}Max wait   :${c.reset} ${MAX_ATTEMPTS * POLL_INTERVAL / 1000}s (${MAX_ATTEMPTS} attempts × ${POLL_INTERVAL / 1000}s)`,
    `${c.bold}API URL    :${c.reset} ${STACKS_API_URL}/extended/v1/tx/${stacksTxId}`,
    `${c.bold}Explorer   :${c.reset} ${explorerBase}/${stacksTxId}`,
  ]);

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    await new Promise((r) => setTimeout(r, POLL_INTERVAL));

    plog.info(`Attempt ${c.bold}${attempt}/${MAX_ATTEMPTS}${c.reset} — querying Stacks API...`);

    try {
      const apiUrl = `${STACKS_API_URL}/extended/v1/tx/${stacksTxId}`;
      const res    = await axios.get(apiUrl, { timeout: 10000 });
      const data   = res.data;

      const statusColor = data.tx_status === "success" ? c.green
        : data.tx_status === "pending"  ? c.yellow
        : c.red;

      plog.info(
        `  tx_status = ${statusColor}${c.bold}${data.tx_status}${c.reset} | ` +
        `block_height = ${data.block_height || "(mempool)"} | ` +
        `burn_block_time = ${data.burn_block_time_iso || "N/A"}`
      );

      if (data.tx_status === "success") {
        divider("✅ STACKS TX CONFIRMED");
        plog.success(`TX confirmed on-chain at block ${data.block_height}`);
        box([
          `${c.bold}TX ID        :${c.reset} ${stacksTxId}`,
          `${c.bold}Block        :${c.reset} ${data.block_height}`,
          `${c.bold}Confirmed at :${c.reset} ${data.burn_block_time_iso || "N/A"}`,
          `${c.bold}Attempt      :${c.reset} ${attempt} (${(attempt * POLL_INTERVAL / 1000)}s elapsed)`,
        ]);

        const freshTx = await Transaction.findOne({ paymentReference: reference });
        plog.info(`Fresh DB status: ${c.bold}${freshTx?.status}${c.reset}`);

        if (!freshTx) { plog.error(`TX disappeared from DB for reference ${reference}!`); return; }
        if (["confirmed", "settling", "processing"].includes(freshTx.status)) {
          plog.warn(`Already handled by indexer (status: ${freshTx.status}) — skipping`);
          return;
        }

        let confirmedAmount = tx.tokenAmount;
        plog.info(`Parsing blockchain events for amount verification...`);
        try {
          const events = data.events || [];
          plog.info(`  Found ${events.length} event(s)`);
          events.forEach((e, i) => plog.info(`  Event ${i}: type=${e.event_type} amount=${e.asset?.amount || "N/A"}`));
          const ftEvent = events.find((e) => e.event_type === "fungible_token_asset" || e.event_type === "stx_asset");
          if (ftEvent?.asset?.amount) {
            confirmedAmount = parseInt(ftEvent.asset.amount) / 1_000_000;
            plog.info(`  Confirmed amount from event: ${c.bold}${confirmedAmount}${c.reset}`);
          } else {
            plog.warn(`  No FT/STX event found — using stored amount: ${confirmedAmount}`);
          }
        } catch (parseErr) {
          plog.warn(`  Event parsing error: ${parseErr.message} — using stored amount`);
        }

        plog.info(`Updating DB status → processing...`);
        freshTx.status = "processing";
        freshTx.txId   = stacksTxId;
        freshTx.meta   = { ...freshTx.meta, stacksTxId, tokenReceivedAt: new Date().toISOString(), confirmedAttempt: attempt, confirmedAmount };
        await freshTx.save();
        plog.success(`DB updated to "processing"`);

        plog.info(`Triggering Lenco NGN payout...`);
        box([
          `${c.bold}Amount NGN   :${c.reset} ${c.green}₦${freshTx.ngnAmount.toLocaleString()}${c.reset}`,
          `${c.bold}To account   :${c.reset} ${freshTx.meta.accountNumber}`,
          `${c.bold}Bank code    :${c.reset} ${freshTx.meta.bankCode}`,
          `${c.bold}Account name :${c.reset} ${freshTx.meta.accountName}`,
          `${c.bold}Reference    :${c.reset} ${reference}`,
        ]);

        try {
          const lencoResult = await initiateLencoTransfer(freshTx.ngnAmount, freshTx.meta.accountNumber, freshTx.meta.bankCode, freshTx.meta.accountName, reference);
          freshTx.status = "settling";
          freshTx.meta   = { ...freshTx.meta, lencoTransferId: lencoResult.transferId, lencoReference: lencoResult.lencoReference, settlementInitiatedAt: new Date().toISOString() };
          await freshTx.save();
          divider("🎉 NGN PAYOUT INITIATED");
          llog.success(`Lenco transfer created!\n  Lenco ID  : ${c.bold}${lencoResult.transferId}${c.reset}\n  Reference : ${lencoResult.lencoReference}\n  Status    : ${lencoResult.status}\n  Amount    : ${c.green}₦${freshTx.ngnAmount.toLocaleString()}${c.reset} → ${freshTx.meta.accountName}`);
        } catch (lencoErr) {
          divider("❌ LENCO TRANSFER FAILED");
          llog.error(`Lenco payout failed for ${reference}: ${lencoErr.message}`);
          llog.error(`CRITICAL — MANUAL ACTION REQUIRED:`);
          box([
            `${c.red}${c.bold}Stacks TX received but NGN NOT sent!${c.reset}`,
            `${c.bold}Reference  :${c.reset} ${reference}`,
            `${c.bold}Stacks TX  :${c.reset} ${stacksTxId}`,
            `${c.bold}NGN amount :${c.reset} ₦${freshTx.ngnAmount}`,
            `${c.bold}To account :${c.reset} ${freshTx.meta.accountNumber} (${freshTx.meta.bankName})`,
            `${c.bold}To name    :${c.reset} ${freshTx.meta.accountName}`,
          ]);
          freshTx.status = "failed";
          freshTx.meta   = { ...freshTx.meta, failureReason: `Lenco failed: ${lencoErr.message}`, requiresManualSettlement: true };
          await freshTx.save();
        }

        return;
      }

      if (data.tx_status === "abort_by_response" || data.tx_status === "abort_by_post_condition") {
        divider("🚫 STACKS TX ABORTED");
        plog.error(`TX aborted — status: ${data.tx_status}`);
        const failTx = await Transaction.findOne({ paymentReference: reference });
        if (failTx) { failTx.status = "failed"; failTx.meta = { ...failTx.meta, failureReason: `Stacks TX aborted: ${data.tx_status}` }; await failTx.save(); }
        return;
      }

      if (data.tx_status === "dropped_replace_by_fee" || data.tx_status === "dropped_too_expensive") {
        plog.warn(`TX was dropped from mempool: ${data.tx_status}`);
      }

      if (attempt % 6 === 0) {
        plog.info(`Still waiting... ${c.dim}(${attempt * POLL_INTERVAL / 1000}s elapsed)${c.reset}`);
        plog.info(`  Track on explorer: ${explorerBase}/${stacksTxId}`);
      }

    } catch (err) {
      if (err.response?.status === 404) {
        plog.warn(`Attempt ${attempt}: TX not found on API yet (404) — retrying...`);
      } else {
        plog.warn(`Attempt ${attempt}: API error — ${err.message} — will retry`);
      }
    }
  }

  divider("⏰ POLL TIMEOUT");
  plog.error(`Gave up after ${MAX_ATTEMPTS} attempts for ${reference}`);
  const timeoutTx = await Transaction.findOne({ paymentReference: reference });
  if (timeoutTx && timeoutTx.status === "pending") {
    timeoutTx.status = "failed";
    timeoutTx.meta   = { ...timeoutTx.meta, failureReason: "Poll timeout — TX not confirmed within 10 minutes" };
    await timeoutTx.save();
  }
}

async function confirmTokenReceipt(req, res) {
  const { transactionReference, stacksTxId, tokenAmount, token, senderAddress } = req.body;

  divider("🔒 CONFIRM TOKEN RECEIPT (Internal/Indexer)");
  log.info("POST /confirm-receipt");
  box([
    `${c.bold}Reference  :${c.reset} ${transactionReference}`,
    `${c.bold}Stacks TX  :${c.reset} ${stacksTxId}`,
    `${c.bold}Token      :${c.reset} ${tokenAmount} ${token}`,
    `${c.bold}Sender     :${c.reset} ${senderAddress}`,
  ]);

  try {
    if (!transactionReference || !stacksTxId) {
      log.warn("Missing required fields");
      return res.status(400).json({ success: false, message: "transactionReference and stacksTxId required" });
    }

    const tx = await Transaction.findOne({ paymentReference: transactionReference, direction: "offramp" });
    if (!tx) { log.error(`Transaction not found: ${transactionReference}`); return res.status(404).json({ success: false, message: "Transaction not found" }); }

    log.info(`Found TX — status: ${c.bold}${tx.status}${c.reset}`);

    if (tx.status === "confirmed" || tx.status === "processing") {
      log.warn(`Already processed (status: ${tx.status})`);
      return res.json({ success: true, message: "Already processed" });
    }
    if (tx.status !== "pending") {
      log.warn(`Unexpected status "${tx.status}"`);
      return res.status(400).json({ success: false, message: `Cannot confirm — status is ${tx.status}` });
    }

    const tolerance = tx.tokenAmount * 0.001;
    const diff      = Math.abs(parseFloat(tokenAmount) - tx.tokenAmount);
    if (diff > tolerance) {
      log.warn(`Amount mismatch — expected ${tx.tokenAmount}, got ${tokenAmount}`);
    } else {
      log.success(`Amount verified — expected ${tx.tokenAmount}, got ${tokenAmount}`);
    }

    tx.status = "processing";
    tx.txId   = stacksTxId;
    tx.meta   = { ...tx.meta, stacksTxId, tokenReceivedAt: new Date().toISOString() };
    await tx.save();
    log.success(`DB updated to "processing"`);

    let lencoResult;
    try {
      lencoResult = await initiateLencoTransfer(tx.ngnAmount, tx.meta.accountNumber, tx.meta.bankCode, tx.meta.accountName, transactionReference);
      tx.status = "settling";
      tx.meta   = { ...tx.meta, lencoTransferId: lencoResult.transferId, settlementInitiatedAt: new Date().toISOString() };
      await tx.save();
      log.success(`DB updated to "settling" — Lenco transfer ID: ${lencoResult.transferId}`);
    } catch (lencoErr) {
      log.error(`Lenco transfer failed: ${lencoErr.message}`);
      tx.status = "failed";
      tx.meta   = { ...tx.meta, failureReason: `Lenco failed: ${lencoErr.message}`, requiresManualSettlement: true };
      await tx.save();
      return res.status(500).json({ success: false, message: "NGN settlement failed. Support notified." });
    }

    res.json({ success: true, message: "Tokens received. NGN settlement initiated.", data: { transactionReference, stacksTxId, tokenAmount: tx.tokenAmount, ngnAmount: tx.ngnAmount, lencoTransferId: lencoResult.transferId, estimatedSettlement: "30-60 seconds" } });
  } catch (err) {
    log.error(`confirmTokenReceipt error: ${err.message}`);
    res.status(500).json({ success: false, message: err.message });
  }
}

async function handleLencoWebhook(req, res) {
  divider("🔔 LENCO WEBHOOK");
  llog.info("POST /lenco-webhook");

  const payload   = req.body;
  const signature = req.headers["x-lenco-signature"];

  llog.info(`Event: ${c.bold}${payload?.event}${c.reset} | Reference: ${payload?.data?.reference}`);
  llog.data("Full webhook payload", payload);

  if (!signature) { llog.error("Missing x-lenco-signature header"); return res.status(401).json({ success: false, message: "Missing signature" }); }
  if (!verifyLencoSignature(payload, signature)) { llog.error("Invalid signature"); return res.status(401).json({ success: false, message: "Invalid signature" }); }

  llog.success("Signature verified");

  const { event, data } = payload;

  if (event === "transfer.completed") {
    const tx = await Transaction.findOne({ paymentReference: data.reference, direction: "offramp" });
    if (!tx) { llog.warn(`No TX found for reference ${data.reference}`); return res.json({ success: true, message: "Webhook received" }); }
    if (tx.status === "confirmed") { llog.info("Already confirmed"); return res.json({ success: true, message: "Already confirmed" }); }
    tx.status      = "confirmed";
    tx.confirmedAt = new Date();
    tx.meta        = { ...tx.meta, lencoStatus: "completed", lencoSettledAt: new Date().toISOString() };
    await tx.save();
    llog.success(`✅ OFFRAMP COMPLETE — ${tx.tokenAmount} ${tx.token} → ₦${tx.ngnAmount} → ${tx.meta.accountName}`);
    // Refresh balance cache after confirmed payout
    getLencoAccountBalance(true).catch(() => {});
    return res.json({ success: true, message: "Transaction confirmed" });
  }

  if (event === "transfer.failed" || event === "transfer.reversed") {
    llog.error(`Transfer FAILED/REVERSED for ${data?.reference}`);
    const tx = await Transaction.findOne({ paymentReference: data.reference, direction: "offramp" });
    if (tx) {
      tx.status = "failed";
      tx.meta   = { ...tx.meta, lencoStatus: "failed", failureReason: data.reason || `Lenco event: ${event}`, requiresManualSettlement: true };
      await tx.save();
    }
    return res.json({ success: true, message: "Failure recorded" });
  }

  llog.info(`Unhandled event "${event}" — acknowledged`);
  res.json({ success: true, message: `Event ${event} acknowledged` });
}

async function getOfframpStatus(req, res) {
  log.info(`GET /status/${req.params.reference}`);
  try {
    const tx = await Transaction.findOne({ paymentReference: req.params.reference, direction: "offramp" }).lean();
    if (!tx) return res.status(404).json({ success: false, message: "Transaction not found" });
    const statusMessages = { pending: "Awaiting token deposit", processing: "Tokens received. Initiating NGN transfer.", settling: "NGN bank transfer in progress", confirmed: "NGN successfully sent to your bank account", failed: "Transaction failed" };
    res.json({ success: true, data: { transactionId: tx._id, transactionReference: tx.paymentReference, token: tx.token, tokenAmount: tx.tokenAmount, ngnAmount: tx.ngnAmount, status: tx.status, statusMessage: statusMessages[tx.status] || tx.status, stacksTxId: tx.txId, lencoTransferId: tx.meta?.lencoTransferId, bank: { accountName: tx.meta?.accountName, accountNumber: tx.meta?.accountNumber, bankName: tx.meta?.bankName }, createdAt: tx.createdAt, confirmedAt: tx.confirmedAt, failureReason: tx.status === "failed" ? tx.meta?.failureReason : undefined } });
  } catch (err) {
    log.error(`getOfframpStatus error: ${err.message}`);
    res.status(500).json({ success: false, message: "Failed to fetch status" });
  }
}

async function getOfframpHistory(req, res) {
  const { address, page = 1, limit = 20, status, token } = req.query;
  log.info(`GET /history — address=${address} status=${status || "any"} token=${token || "any"} page=${page}`);
  try {
    if (!address) return res.status(400).json({ success: false, message: "address is required" });
    const query    = { senderAddress: address, direction: "offramp" };
    if (status) query.status = status;
    if (token)  query.token  = token.toUpperCase();
    const pageNum  = parseInt(page);
    const limitNum = Math.min(parseInt(limit), 100);
    const skip     = (pageNum - 1) * limitNum;
    const [txs, total] = await Promise.all([Transaction.find(query).sort({ createdAt: -1 }).skip(skip).limit(limitNum).lean(), Transaction.countDocuments(query)]);
    log.success(`Returning ${txs.length} records (total: ${total})`);
    res.json({ success: true, data: txs.map((tx) => ({ transactionId: tx._id, transactionReference: tx.paymentReference, token: tx.token, tokenAmount: tx.tokenAmount, ngnAmount: tx.ngnAmount, status: tx.status, bankName: tx.meta?.bankName, accountLast4: tx.meta?.accountNumber?.slice(-4), stacksTxId: tx.txId, createdAt: tx.createdAt, confirmedAt: tx.confirmedAt })), pagination: { page: pageNum, limit: limitNum, total, pages: Math.ceil(total / limitNum) } });
  } catch (err) {
    log.error(`getOfframpHistory error: ${err.message}`);
    res.status(500).json({ success: false, message: "Failed to fetch history" });
  }
}

module.exports = {
  getBankList,
  getOfframpRate,
  verifyAccount,
  initializeOfframp,
  notifyTxBroadcast,
  confirmTokenReceipt,
  handleLencoWebhook,
  getOfframpStatus,
  getOfframpHistory,
  getLiquidityInfo,       // ← new: expose to router as GET /api/offramp/liquidity
  getLencoAccountBalance, // ← new: export for health checks / admin tooling
};