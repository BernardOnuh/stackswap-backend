// ============= services/stacksIndexer.js =============
// StackSwap Stacks Blockchain Indexer
//
// This service runs SERVER-SIDE and polls the Stacks blockchain for
// inbound transfers to the platform deposit address. When it finds a
// matching transfer (STX or USDC) with a valid SSWAP_OFFRAMP_ memo,
// it calls /api/offramp/confirm-receipt internally — no browser
// involvement, no SSL issues, no exposed internal keys.
//
// Architecture:
//   User wallet → Stacks blockchain → THIS INDEXER → confirm-receipt → Lenco NGN payout
//
// Why this replaces the old frontend notifyBackend():
//   - notifyBackend() was called from the browser, causing EPROTO SSL
//     errors (TLS handshake failure between browser and internal endpoint)
//   - It also leaked NEXT_PUBLIC_INTERNAL_KEY to the client bundle
//   - This indexer runs entirely server-side, is more reliable, and
//     handles missed transactions (e.g. if user closes the tab early)

const axios = require("axios");
const logger = require("../config/logger");

// ── Config ──────────────────────────────────────────────────────────
const STACKS_API_BASE  = process.env.STACKS_API_URL || "https://api.hiro.so";
const PLATFORM_ADDRESS = process.env.PLATFORM_STX_ADDRESS;
const INTERNAL_API_KEY = process.env.INTERNAL_API_KEY;
const SELF_BASE_URL    = process.env.SELF_BASE_URL || "http://localhost:5000";
const POLL_INTERVAL_MS = parseInt(process.env.INDEXER_POLL_INTERVAL_MS || "20000", 10); // 20s default

// USDC SIP-010 contract (same as frontend)
const USDC_CONTRACT_ADDRESS = process.env.USDC_CONTRACT_ADDRESS || "SP3Y2DC0WJ6EXMM9MSSEZ5JHVHPS6XMTFJ35XAPD";
const USDC_CONTRACT_NAME    = process.env.USDC_CONTRACT_NAME    || "usdc-token";
const USDC_FULL_ID          = `${USDC_CONTRACT_ADDRESS}.${USDC_CONTRACT_NAME}`;

// Track already-processed tx IDs in memory to avoid duplicate calls.
// On restart, confirm-receipt is idempotent so re-processing is safe.
const processedTxIds = new Set();

// ── Memo decoding ────────────────────────────────────────────────────
/**
 * Stacks memos are hex-encoded, null-padded 34-byte buffers.
 * Decode to string and strip null bytes.
 */
function decodeMemo(hexMemo) {
  if (!hexMemo) return "";
  try {
    const raw = Buffer.from(hexMemo.replace(/^0x/, ""), "hex").toString("utf8");
    return raw.replace(/\0/g, "").trim();
  } catch {
    return "";
  }
}

// ── STX transfer indexer ─────────────────────────────────────────────
async function checkInboundSTXTransfers() {
  if (!PLATFORM_ADDRESS) return;

  try {
    const url = `${STACKS_API_BASE}/extended/v1/address/${PLATFORM_ADDRESS}/transactions`;
    const res = await axios.get(url, {
      params: { limit: 50, offset: 0 },
      timeout: 15000,
    });

    const txs = res.data?.results || [];

    for (const tx of txs) {
      // Only process successful STX token transfers TO our address
      if (
        tx.tx_status !== "success" ||
        tx.tx_type  !== "token_transfer" ||
        tx.token_transfer?.recipient_address !== PLATFORM_ADDRESS
      ) continue;

      if (processedTxIds.has(tx.tx_id)) continue;

      const memo = decodeMemo(tx.token_transfer?.memo);
      if (!memo.startsWith("SSWAP_OFFRAMP_")) continue;

      const tokenAmount = parseInt(tx.token_transfer.amount, 10) / 1_000_000; // µSTX → STX

      logger.info(`[Indexer] Found inbound STX transfer: ${tx.tx_id}`);
      logger.info(`  Memo: ${memo} | Amount: ${tokenAmount} STX | From: ${tx.sender_address}`);

      await callConfirmReceipt({
        transactionReference: memo,
        stacksTxId:           tx.tx_id,
        tokenAmount,
        token:                "STX",
        senderAddress:        tx.sender_address,
      });

      processedTxIds.add(tx.tx_id);
    }
  } catch (err) {
    logger.error(`[Indexer] STX poll error: ${err.message}`);
  }
}

// ── USDC transfer indexer ────────────────────────────────────────────
async function checkInboundUSDCTransfers() {
  if (!PLATFORM_ADDRESS) return;

  try {
    // Fetch contract call transactions for the USDC token contract
    const url = `${STACKS_API_BASE}/extended/v1/address/${USDC_FULL_ID}/transactions`;
    const res = await axios.get(url, {
      params: { limit: 50, offset: 0 },
      timeout: 15000,
    });

    const txs = res.data?.results || [];

    for (const tx of txs) {
      if (tx.tx_status !== "success" || tx.tx_type !== "contract_call") continue;
      if (tx.contract_call?.function_name !== "transfer")              continue;
      if (processedTxIds.has(tx.tx_id))                                continue;

      // Parse FT transfer events to confirm recipient and amount
      const ftEvents = tx.events?.filter(
        (e) =>
          e.event_type === "fungible_token_asset" &&
          e.asset?.asset_id?.startsWith(USDC_FULL_ID) &&
          e.asset?.recipient === PLATFORM_ADDRESS
      ) || [];

      if (ftEvents.length === 0) continue;

      // Memo is the 4th argument of SIP-010 transfer(amount, from, to, memo)
      const memoArg = tx.contract_call?.function_args?.[3];
      const memo    = memoArg?.repr
        ? decodeMemo(memoArg.repr.replace(/^0x/, ""))
        : "";

      if (!memo.startsWith("SSWAP_OFFRAMP_")) continue;

      // Sum all FT transfer amounts to this address (usually just one)
      const rawAmount   = ftEvents.reduce((sum, e) => sum + parseInt(e.asset.amount || "0", 10), 0);
      const tokenAmount = rawAmount / 1_000_000; // USDC has 6 decimals

      logger.info(`[Indexer] Found inbound USDC transfer: ${tx.tx_id}`);
      logger.info(`  Memo: ${memo} | Amount: ${tokenAmount} USDC | From: ${tx.sender_address}`);

      await callConfirmReceipt({
        transactionReference: memo,
        stacksTxId:           tx.tx_id,
        tokenAmount,
        token:                "USDC",
        senderAddress:        tx.sender_address,
      });

      processedTxIds.add(tx.tx_id);
    }
  } catch (err) {
    logger.error(`[Indexer] USDC poll error: ${err.message}`);
  }
}

// ── Internal confirm-receipt call ────────────────────────────────────
async function callConfirmReceipt(payload) {
  try {
    const res = await axios.post(
      `${SELF_BASE_URL}/api/offramp/confirm-receipt`,
      payload,
      {
        headers: {
          "Content-Type": "application/json",
          "x-internal-key": INTERNAL_API_KEY,
        },
        timeout: 30000,
      }
    );

    if (res.data?.success) {
      logger.info(`[Indexer] confirm-receipt OK: ${payload.transactionReference}`);
    } else {
      logger.warn(`[Indexer] confirm-receipt non-success: ${JSON.stringify(res.data)}`);
    }
  } catch (err) {
    const status  = err.response?.status;
    const message = err.response?.data?.message || err.message;

    // 404 = transaction not in DB yet (race condition) — will retry on next poll
    if (status === 404) {
      logger.warn(`[Indexer] Transaction not found yet for ${payload.transactionReference} — will retry`);
      // Remove from processed set so it's retried next poll
      processedTxIds.delete(payload.stacksTxId);
      return;
    }

    // 401 = bad internal key — config error, log loudly
    if (status === 401) {
      logger.error(`[Indexer] UNAUTHORIZED — check INTERNAL_API_KEY env var`);
      return;
    }

    logger.error(`[Indexer] confirm-receipt failed (${status}): ${message}`);
  }
}

// ── Poll loop ────────────────────────────────────────────────────────
let indexerInterval = null;

function startIndexer() {
  if (!PLATFORM_ADDRESS) {
    logger.warn("[Indexer] PLATFORM_STX_ADDRESS not set — indexer disabled");
    return;
  }
  if (!INTERNAL_API_KEY) {
    logger.warn("[Indexer] INTERNAL_API_KEY not set — indexer disabled");
    return;
  }

  logger.info(`[Indexer] Starting — polling every ${POLL_INTERVAL_MS / 1000}s`);
  logger.info(`[Indexer] Watching address: ${PLATFORM_ADDRESS}`);

  // Run once immediately on startup
  Promise.all([checkInboundSTXTransfers(), checkInboundUSDCTransfers()]).catch(
    (err) => logger.error(`[Indexer] Initial poll error: ${err.message}`)
  );

  indexerInterval = setInterval(async () => {
    await Promise.all([
      checkInboundSTXTransfers(),
      checkInboundUSDCTransfers(),
    ]);
  }, POLL_INTERVAL_MS);

  // Graceful shutdown
  process.on("SIGTERM", stopIndexer);
  process.on("SIGINT",  stopIndexer);
}

function stopIndexer() {
  if (indexerInterval) {
    clearInterval(indexerInterval);
    indexerInterval = null;
    logger.info("[Indexer] Stopped");
  }
}

module.exports = { startIndexer, stopIndexer };