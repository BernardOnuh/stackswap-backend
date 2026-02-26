// ============= services/stacksTransferService.js =============
// Handles sending STX and SIP-010 USDC tokens from the platform hot wallet

const {
    makeSTXTokenTransfer,
    makeContractCall,
    broadcastTransaction,
    AnchorMode,
    PostConditionMode,
    FungibleConditionCode,
    makeStandardFungiblePostCondition,
    createAssetInfo,
    uintCV,
    standardPrincipalCV,
    bufferCVFromString,
    getAddressFromPrivateKey,
    TransactionVersion,
  } = require("@stacks/transactions");
  const { StacksMainnet, StacksTestnet } = require("@stacks/network");
  const logger = require("../config/logger");
  
  // Platform hot wallet private key (hex) — loaded from env, never hardcoded
  const PLATFORM_PRIVATE_KEY = process.env.PLATFORM_STX_PRIVATE_KEY || "";
  const NETWORK_ENV = process.env.STACKS_NETWORK || "mainnet"; // "mainnet" | "testnet"
  
  // USDC on Stacks (SIP-010 token)
  // Mainnet: SP3FBR2AGK5H9QBDH3EEN6DF8EK8JY7RX8QJ5SVTE.usdc-token
  // Testnet: ST3FBR2AGK5H9QBDH3EEN6DF8EK8JY7RX8QJ5SVTE.usdc-token
  const USDC_CONTRACT = {
    mainnet: {
      address: process.env.USDC_CONTRACT_ADDRESS || "SP3FBR2AGK5H9QBDH3EEN6DF8EK8JY7RX8QJ5SVTE",
      name: process.env.USDC_CONTRACT_NAME || "usdc-token",
    },
    testnet: {
      address: process.env.USDC_CONTRACT_ADDRESS_TESTNET || "ST3FBR2AGK5H9QBDH3EEN6DF8EK8JY7RX8QJ5SVTE",
      name: process.env.USDC_CONTRACT_NAME_TESTNET || "usdc-token",
    },
  };
  
  // STX decimals = 6 (microSTX), USDC on Stacks = 6 decimals
  const STX_DECIMALS = 1_000_000;
  const USDC_DECIMALS = 1_000_000;
  
  const STACKS_EXPLORER = NETWORK_ENV === "mainnet"
    ? "https://explorer.stacks.co/txid"
    : "https://explorer.stacks.co/txid?chain=testnet";
  
  function getNetwork() {
    return NETWORK_ENV === "mainnet" ? new StacksMainnet() : new StacksTestnet();
  }
  
  function getUSDCConfig() {
    return USDC_CONTRACT[NETWORK_ENV] || USDC_CONTRACT.mainnet;
  }
  
  /**
   * Send STX to a recipient address
   */
  async function sendSTX(recipientAddress, amount, memo = "") {
    if (!PLATFORM_PRIVATE_KEY) throw new Error("PLATFORM_STX_PRIVATE_KEY not configured");
  
    const microSTX = Math.round(amount * STX_DECIMALS);
    logger.info(`Sending ${amount} STX (${microSTX} μSTX) to ${recipientAddress}`);
  
    const network = getNetwork();
  
    const txOptions = {
      recipient: recipientAddress,
      amount: microSTX,
      senderKey: PLATFORM_PRIVATE_KEY,
      network,
      memo: memo.slice(0, 34), // Stacks memo max 34 bytes
      anchorMode: AnchorMode.Any,
      fee: 2000, // micro-STX fee — adjust based on network congestion
    };
  
    const transaction = await makeSTXTokenTransfer(txOptions);
    const broadcastResponse = await broadcastTransaction(transaction, network);
  
    if (broadcastResponse.error) {
      throw new Error(`STX broadcast failed: ${broadcastResponse.error} — ${broadcastResponse.reason}`);
    }
  
    const txId = broadcastResponse.txid;
    logger.info(`STX sent ✓ txId: ${txId}`);
  
    return {
      txId,
      explorerUrl: `${STACKS_EXPLORER}/${txId}`,
      amount,
      token: "STX",
      recipient: recipientAddress,
    };
  }
  
  /**
   * Send USDC (SIP-010) to a recipient address
   */
  async function sendUSDC(recipientAddress, amount, memo = "") {
    if (!PLATFORM_PRIVATE_KEY) throw new Error("PLATFORM_STX_PRIVATE_KEY not configured");
  
    const microUSDC = Math.round(amount * USDC_DECIMALS);
    const network = getNetwork();
    const usdcConfig = getUSDCConfig();
    const senderAddress = getAddressFromPrivateKey(
      PLATFORM_PRIVATE_KEY,
      NETWORK_ENV === "mainnet" ? TransactionVersion.Mainnet : TransactionVersion.Testnet
    );
  
    logger.info(`Sending ${amount} USDC (${microUSDC} μUSDC) to ${recipientAddress}`);
  
    // SIP-010 transfer function: (transfer (uint principal principal (optional (buff 34))) (response bool uint))
    const txOptions = {
      contractAddress: usdcConfig.address,
      contractName: usdcConfig.name,
      functionName: "transfer",
      functionArgs: [
        uintCV(microUSDC),
        standardPrincipalCV(senderAddress),
        standardPrincipalCV(recipientAddress),
        memo ? { type: 9, value: bufferCVFromString(memo.slice(0, 34)) } : { type: 9, value: null }, // (some (buff 34)) or none
      ],
      senderKey: PLATFORM_PRIVATE_KEY,
      network,
      anchorMode: AnchorMode.Any,
      postConditionMode: PostConditionMode.Deny,
      postConditions: [
        // Assert that exactly microUSDC tokens leave the sender
        makeStandardFungiblePostCondition(
          senderAddress,
          FungibleConditionCode.Equal,
          microUSDC,
          createAssetInfo(usdcConfig.address, usdcConfig.name, "usdc")
        ),
      ],
    };
  
    const transaction = await makeContractCall(txOptions);
    const broadcastResponse = await broadcastTransaction(transaction, network);
  
    if (broadcastResponse.error) {
      throw new Error(`USDC broadcast failed: ${broadcastResponse.error} — ${broadcastResponse.reason}`);
    }
  
    const txId = broadcastResponse.txid;
    logger.info(`USDC sent ✓ txId: ${txId}`);
  
    return {
      txId,
      explorerUrl: `${STACKS_EXPLORER}/${txId}`,
      amount,
      token: "USDC",
      recipient: recipientAddress,
    };
  }
  
  /**
   * Unified entry point — routes to STX or USDC transfer based on token
   */
  async function sendTokens({ token, amount, recipientAddress, memo = "" }) {
    if (!token || !amount || !recipientAddress) {
      throw new Error("sendTokens requires: token, amount, recipientAddress");
    }
  
    switch (token.toUpperCase()) {
      case "STX":
        return sendSTX(recipientAddress, amount, memo);
      case "USDC":
        return sendUSDC(recipientAddress, amount, memo);
      default:
        throw new Error(`Unsupported token: ${token}`);
    }
  }
  
  module.exports = { sendTokens, sendSTX, sendUSDC };