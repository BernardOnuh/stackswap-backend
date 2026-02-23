const swaggerJsdoc = require("swagger-jsdoc");

const options = {
  definition: {
    openapi: "3.0.0",
    info: {
      title: "StackSwap API",
      version: "1.0.0",
      description: "🟠 STX & USDC ↔ NGN onramp/offramp API — powered by Stacks blockchain",
      contact: {
        name: "StackSwap",
      },
    },
    servers: [
      {
        url: "http://localhost:5000",
        description: "Local development",
      },
    ],
    tags: [
      { name: "Health", description: "Server status" },
      { name: "Prices", description: "Live STX & USDC price feeds in NGN" },
      { name: "Transactions", description: "Swap transaction lifecycle" },
    ],
    components: {
      schemas: {
        Price: {
          type: "object",
          properties: {
            priceNGN: { type: "number", example: 1847.35 },
            priceUSD: { type: "number", example: 1.14 },
            change24h: { type: "number", example: 2.4 },
          },
        },
        PricesResponse: {
          type: "object",
          properties: {
            success: { type: "boolean", example: true },
            data: {
              type: "object",
              properties: {
                STX: { $ref: "#/components/schemas/Price" },
                USDC: { $ref: "#/components/schemas/Price" },
                usdToNgn: { type: "number", example: 1620.5 },
                fromCache: { type: "boolean", example: true },
                fetchedAt: { type: "string", format: "date-time" },
              },
            },
          },
        },
        Transaction: {
          type: "object",
          properties: {
            _id: { type: "string", example: "65f1a2b3c4d5e6f7a8b9c0d1" },
            token: { type: "string", enum: ["STX", "USDC"], example: "STX" },
            type: { type: "string", enum: ["sell", "buy"], example: "sell" },
            tokenAmount: { type: "number", example: 100 },
            ngnAmount: { type: "number", example: 184735 },
            rateAtTime: { type: "number", example: 1847.35 },
            feeNGN: { type: "number", example: 923.68 },
            netNGN: { type: "number", example: 183811.32 },
            senderAddress: { type: "string", example: "SP3EWE151DHDTV7CP5D7N2YYESA3VEH3TBPNTT4EV" },
            recipientAddress: { type: "string", example: "SM2J6ZY48GV1EZ5V2V5RB9MP66SW86PYKKQVX8X0G" },
            txId: { type: "string", example: "0xabc123..." },
            status: { type: "string", enum: ["pending", "processing", "confirmed", "failed"], example: "pending" },
            memo: { type: "string", example: "Optional note" },
            createdAt: { type: "string", format: "date-time" },
            updatedAt: { type: "string", format: "date-time" },
          },
        },
        CreateTransactionBody: {
          type: "object",
          required: ["token", "type", "tokenAmount", "senderAddress", "recipientAddress"],
          properties: {
            token: { type: "string", enum: ["STX", "USDC"], example: "STX" },
            type: { type: "string", enum: ["sell", "buy"], example: "sell" },
            tokenAmount: { type: "number", example: 100 },
            senderAddress: { type: "string", example: "SP3EWE151DHDTV7CP5D7N2YYESA3VEH3TBPNTT4EV" },
            recipientAddress: { type: "string", example: "SM2J6ZY48GV1EZ5V2V5RB9MP66SW86PYKKQVX8X0G" },
            memo: { type: "string", example: "Optional note" },
          },
        },
        UpdateStatusBody: {
          type: "object",
          required: ["status"],
          properties: {
            status: { type: "string", enum: ["pending", "processing", "confirmed", "failed"] },
            stacksTxId: { type: "string", example: "0xabc123..." },
          },
        },
        ErrorResponse: {
          type: "object",
          properties: {
            success: { type: "boolean", example: false },
            message: { type: "string", example: "Something went wrong." },
          },
        },
        Pagination: {
          type: "object",
          properties: {
            page: { type: "integer", example: 1 },
            limit: { type: "integer", example: 20 },
            total: { type: "integer", example: 42 },
            pages: { type: "integer", example: 3 },
          },
        },
      },
    },
  },
  apis: ["./src/routes/*.js"],
};

module.exports = swaggerJsdoc(options);
