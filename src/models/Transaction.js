const mongoose = require("mongoose");

const transactionSchema = new mongoose.Schema(
  {
    // Which token was swapped
    token: {
      type: String,
      required: true,
      uppercase: true,
      enum: ["STX", "USDC"],
    },

    // Direction
    type: {
      type: String,
      required: true,
      enum: ["sell", "buy"], // sell = token→NGN, buy = NGN→token
    },

    // Amounts
    tokenAmount: {
      type: Number,
      required: true,
      min: 0,
    },
    ngnAmount: {
      type: Number,
      required: true,
      min: 0,
    },
    rateAtTime: {
      type: Number,
      required: true,
    },
    feeNGN: {
      type: Number,
      required: true,
    },
    netNGN: {
      type: Number,
      required: true,
    },

    // Stacks blockchain info
    senderAddress: {
      type: String,
      required: true,
      trim: true,
    },
    recipientAddress: {
      type: String,
      required: true,
      trim: true,
    },
    txId: {
      type: String,
      trim: true,
      sparse: true, // optional until confirmed
    },

    // Status lifecycle
    status: {
      type: String,
      enum: ["pending", "processing", "confirmed", "failed"],
      default: "pending",
    },

    // Optional memo / reference
    memo: {
      type: String,
      maxlength: 120,
    },
  },
  { timestamps: true }
);

// Useful query indexes
transactionSchema.index({ senderAddress: 1, createdAt: -1 });
transactionSchema.index({ status: 1 });
transactionSchema.index({ txId: 1 }, { sparse: true });

module.exports = mongoose.model("Transaction", transactionSchema);
