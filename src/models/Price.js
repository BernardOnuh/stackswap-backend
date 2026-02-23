const mongoose = require("mongoose");

const priceSchema = new mongoose.Schema(
  {
    token: {
      type: String,
      required: true,
      uppercase: true,
      enum: ["STX", "USDC"],
      index: true,
    },
    priceUSD: {
      type: Number,
      required: true,
    },
    priceNGN: {
      type: Number,
      required: true,
    },
    usdToNgn: {
      type: Number,
      required: true,
    },
    source: {
      type: String,
      default: "coingecko",
    },
    fetchedAt: {
      type: Date,
      default: Date.now,
    },
  },
  { timestamps: true }
);

// Keep only the latest 1440 records per token (~24h at 1-min intervals)
priceSchema.index({ token: 1, fetchedAt: -1 });

module.exports = mongoose.model("Price", priceSchema);
