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

// ── Console logger with colors + timestamps ──────────────────────────
// Uses ANSI escape codes — works in any Node.js terminal (PM2, Railway, Render, etc.)
// Set NO_COLOR=1 in env to disable color if piping to a log file.
const useColor = !process.env.NO_COLOR;
const c = {
  reset:  useColor ? "\x1b[0m"  : "",
  bold:   useColor ? "\x1b[1m"  : "",
  dim:    useColor ? "\x1b[2m"  : "",
  cyan:   useColor ? "\x1b[36m" : "",
  green:  useColor ? "\x1b[32m" : "",
  yellow: useColor ? "\x1b[33m" : "",
  red:    useColor ? "\x1b[31m" : "",
  blue:   useColor ? "\x1b[34m" : "",
  orange: useColor ? "\x1b[38;5;208m" : "",
  gray:   useColor ? "\x1b[90m" : "",
};

function ts() {
  return `${c.gray}[${new Date().toISOString()}]${c.reset}`;
}

const log = {
  info:    (msg) => console.log(`${ts()} ${c.cyan}${c.bold}[Indexer]${c.reset} ${msg}`),
  success: (msg) => console.log(`${ts()} ${c.green}${c.bold}[Indexer]${c.reset} ${msg}`),
  warn:    (msg) => console.warn(`${ts()} ${c.yellow}${c.bold}[Indexer]${c.reset} ${msg}`),
  error:   (msg) => console.error(`${ts()} ${c.red}${c.bold}[Indexer]${c.reset} ${msg}`),
  poll:    (msg) => console.log(`${ts()} ${c.gray}[Indexer]${c.reset} ${msg}`),
  tx:      (msg) => console.log(`${ts()} ${c.orange}${c.bold}[Indexer]${c.reset} ${msg}`),
  banner:  (msg) => console.log(`\n${c.cyan}${c.bold}${"─".repeat(60)}${c.reset}\n${c.cyan}${c.bold}  ${msg}${c.reset}\n${c.cyan}${c.bold}${"─".repeat(60)}${c.reset}\n`),
};

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
let pollCount = 0;

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
    const inbound = txs.filter(
      (tx) =>
        tx.tx_status === "success" &&
        tx.tx_type   === "token_transfer" &&
        tx.token_transfer?.recipient_address === PLATFORM_ADDRESS
    );

    log.poll(
      `STX scan complete — ${c.bold}${txs.length}${c.reset} txs fetched, ` +
      `${c.bold}${inbound.length}${c.reset} inbound to platform`
    );

    for (const tx of inbound) {
      if (processedTxIds.has(tx.tx_id)) {
        log.poll(`  ↩  Already processed: ${c.dim}${tx.tx_id.slice(0, 20)}...${c.reset}`);
        continue;
      }

      const memo = decodeMemo(tx.token_transfer?.memo);

      if (!memo.startsWith("SSWAP_OFFRAMP_")) {
        log.poll(`  ⊘  No matching memo (got: "${c.dim}${memo || "(empty)"}${c.reset}") — skipping`);
        continue;
      }

      const tokenAmount = parseInt(tx.token_transfer.amount, 10) / 1_000_000;

      log.tx(`\n  ┌─ 🟠 INBOUND STX TRANSFER DETECTED`);
      log.tx(`  │  TX ID    : ${c.bold}${tx.tx_id}${c.reset}`);
      log.tx(`  │  From     : ${tx.sender_address}`);
      log.tx(`  │  Amount   : ${c.green}${c.bold}${tokenAmount} STX${c.reset}`);
      log.tx(`  │  Memo     : ${c.yellow}${memo}${c.reset}`);
      log.tx(`  └─ Triggering confirm-receipt...`);

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
    log.error(`STX poll failed: ${err.message}`);
  }
}

// ── USDC transfer indexer ────────────────────────────────────────────
async function checkInboundUSDCTransfers() {
  if (!PLATFORM_ADDRESS) return;

  try {
    const url = `${STACKS_API_BASE}/extended/v1/address/${USDC_FULL_ID}/transactions`;
    const res = await axios.get(url, {
      params: { limit: 50, offset: 0 },
      timeout: 15000,
    });

    const txs = res.data?.results || [];
    const calls = txs.filter(
      (tx) => tx.tx_status === "success" && tx.tx_type === "contract_call" &&
              tx.contract_call?.function_name === "transfer"
    );

    log.poll(
      `USDC scan complete — ${c.bold}${txs.length}${c.reset} txs fetched, ` +
      `${c.bold}${calls.length}${c.reset} transfer() calls`
    );

    for (const tx of calls) {
      if (processedTxIds.has(tx.tx_id)) {
        log.poll(`  ↩  Already processed: ${c.dim}${tx.tx_id.slice(0, 20)}...${c.reset}`);
        continue;
      }

      // Parse FT transfer events to confirm recipient and amount
      const ftEvents = tx.events?.filter(
        (e) =>
          e.event_type === "fungible_token_asset" &&
          e.asset?.asset_id?.startsWith(USDC_FULL_ID) &&
          e.asset?.recipient === PLATFORM_ADDRESS
      ) || [];

      if (ftEvents.length === 0) {
        log.poll(`  ⊘  No FT events to platform address — skipping ${c.dim}${tx.tx_id.slice(0, 16)}...${c.reset}`);
        continue;
      }

      const memoArg = tx.contract_call?.function_args?.[3];
      const memo    = memoArg?.repr ? decodeMemo(memoArg.repr.replace(/^0x/, "")) : "";

      if (!memo.startsWith("SSWAP_OFFRAMP_")) {
        log.poll(`  ⊘  No matching memo (got: "${c.dim}${memo || "(empty)"}${c.reset}") — skipping`);
        continue;
      }

      const rawAmount   = ftEvents.reduce((sum, e) => sum + parseInt(e.asset.amount || "0", 10), 0);
      const tokenAmount = rawAmount / 1_000_000;

      log.tx(`\n  ┌─ 🔵 INBOUND USDC TRANSFER DETECTED`);
      log.tx(`  │  TX ID    : ${c.bold}${tx.tx_id}${c.reset}`);
      log.tx(`  │  From     : ${tx.sender_address}`);
      log.tx(`  │  Amount   : ${c.green}${c.bold}${tokenAmount} USDC${c.reset}`);
      log.tx(`  │  Memo     : ${c.yellow}${memo}${c.reset}`);
      log.tx(`  └─ Triggering confirm-receipt...`);

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
    log.error(`USDC poll failed: ${err.message}`);
  }
}

// ── Internal confirm-receipt call ────────────────────────────────────
async function callConfirmReceipt(payload) {
  try {
    log.info(
      `Calling confirm-receipt → ${c.bold}${payload.transactionReference}${c.reset} ` +
      `(${payload.tokenAmount} ${payload.token})`
    );

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
      log.success(
        `✅ NGN settlement initiated!\n` +
        `  ${c.bold}Ref     :${c.reset} ${payload.transactionReference}\n` +
        `  ${c.bold}Tokens  :${c.reset} ${payload.tokenAmount} ${payload.token}\n` +
        `  ${c.bold}Stacks  :${c.reset} ${payload.stacksTxId}\n` +
        `  ${c.bold}Lenco ID:${c.reset} ${res.data?.data?.lencoTransferId || "pending"}\n` +
        `  ${c.bold}ETA     :${c.reset} ${res.data?.data?.estimatedSettlement || "5-15 min"}`
      );
    } else {
      log.warn(`confirm-receipt returned non-success: ${JSON.stringify(res.data)}`);
    }
  } catch (err) {
    const status  = err.response?.status;
    const message = err.response?.data?.message || err.message;

    // 404 = transaction not in DB yet (race condition) — will retry on next poll
    if (status === 404) {
      log.warn(
        `⚠️  Transaction not in DB yet for ${payload.transactionReference}\n` +
        `   Will retry on next poll cycle (~${POLL_INTERVAL_MS / 1000}s)`
      );
      processedTxIds.delete(payload.stacksTxId);
      return;
    }

    // 401 = bad internal key — config error, log loudly
    if (status === 401) {
      log.error(
        `🔐 UNAUTHORIZED — x-internal-key rejected\n` +
        `   Check that INTERNAL_API_KEY env var matches the server config`
      );
      return;
    }

    log.error(
      `❌ confirm-receipt failed (HTTP ${status || "network error"}): ${message}\n` +
      `   Ref: ${payload.transactionReference} | TX: ${payload.stacksTxId}`
    );
  }
}

// ── Poll loop ────────────────────────────────────────────────────────
let indexerInterval = null;

async function runPoll() {
  pollCount++;
  log.poll(
    `Poll #${c.bold}${pollCount}${c.reset} — ` +
    `${c.dim}${new Date().toLocaleTimeString()}${c.reset} — ` +
    `${c.dim}${processedTxIds.size} tx(s) in memory cache${c.reset}`
  );
  await Promise.all([checkInboundSTXTransfers(), checkInboundUSDCTransfers()]);
}

function startIndexer() {
  if (!PLATFORM_ADDRESS) {
    log.warn("PLATFORM_STX_ADDRESS not set — indexer disabled");
    return;
  }
  if (!INTERNAL_API_KEY) {
    log.warn("INTERNAL_API_KEY not set — indexer disabled");
    return;
  }

  log.banner("StackSwap Stacks Indexer");

  console.log(`  ${c.bold}Platform wallet :${c.reset} ${c.cyan}${PLATFORM_ADDRESS}${c.reset}`);
  console.log(`  ${c.bold}Stacks API      :${c.reset} ${STACKS_API_BASE}`);
  console.log(`  ${c.bold}Backend URL     :${c.reset} ${SELF_BASE_URL}`);
  console.log(`  ${c.bold}Poll interval   :${c.reset} every ${POLL_INTERVAL_MS / 1000}s`);
  console.log(`  ${c.bold}USDC contract   :${c.reset} ${USDC_FULL_ID}`);
  console.log();
  console.log(`  ${c.green}Watching for inbound STX transfers and USDC contract calls...${c.reset}`);
  console.log(`  ${c.dim}(Set NO_COLOR=1 to disable ANSI colors in log files)${c.reset}\n`);

  // Run once immediately on startup
  runPoll().catch((err) => log.error(`Initial poll error: ${err.message}`));

  indexerInterval = setInterval(() => {
    runPoll().catch((err) => log.error(`Poll error: ${err.message}`));
  }, POLL_INTERVAL_MS);

  // Graceful shutdown
  process.on("SIGTERM", stopIndexer);
  process.on("SIGINT",  stopIndexer);
}

function stopIndexer() {
  if (indexerInterval) {
    clearInterval(indexerInterval);
    indexerInterval = null;
    log.info(`Stopped after ${pollCount} poll(s). Goodbye.`);
  }
}

module.exports = { startIndexer, stopIndexer };