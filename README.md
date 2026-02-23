# StackSwap Backend

Express + MongoDB API for the StackSwap STX/USDC ↔ NGN onramp/offramp.

## Stack
- **Runtime**: Node.js
- **Framework**: Express
- **Database**: MongoDB (Mongoose)
- **Price Feed**: CoinGecko (free, no API key needed)
- **Scheduler**: node-cron (auto-refreshes prices every 2 min)

---

## Setup

```bash
# 1. Install dependencies
npm install

# 2. Configure environment
cp .env.example .env
# Edit .env with your MongoDB URI

# 3. Start dev server
npm run dev

# 4. Start production server
npm start
```

---

## API Reference

### Health
```
GET /health
```

---

### Prices

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/prices` | All live prices (STX + USDC in NGN) |
| GET | `/api/prices/:token` | Single token price |
| GET | `/api/prices/:token/history?hours=24` | Price history (max 168h) |
| POST | `/api/prices/refresh` | Force price refresh |

**Example response — GET /api/prices**
```json
{
  "success": true,
  "data": {
    "STX":  { "priceNGN": 1847.35, "priceUSD": 1.14, "change24h": 2.4 },
    "USDC": { "priceNGN": 1620.50, "priceUSD": 1.00, "change24h": 0.1 },
    "usdToNgn": 1620.50,
    "fromCache": true,
    "fetchedAt": "2026-02-22T10:00:00.000Z"
  }
}
```

---

### Transactions

| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/api/transactions` | Create transaction |
| GET | `/api/transactions?address=SP...` | List by wallet |
| GET | `/api/transactions/stats?address=SP...` | Wallet volume stats |
| GET | `/api/transactions/:id` | Single transaction |
| PATCH | `/api/transactions/:id/status` | Update status |

**Example — POST /api/transactions**
```json
{
  "token": "STX",
  "type": "sell",
  "tokenAmount": 100,
  "senderAddress": "SP3EWE151DHDTV7CP5D7N2YYESA3VEH3TBPNTT4EV",
  "recipientAddress": "SM2J6ZY48GV1EZ5V2V5RB9MP66SW86PYKKQVX8X0G",
  "memo": "Optional note"
}
```

**Example — PATCH /api/transactions/:id/status**
```json
{
  "status": "confirmed",
  "stacksTxId": "0xabc123..."
}
```

Transaction statuses: `pending` → `processing` → `confirmed` | `failed`

---

## Project Structure

```
stackswap-backend/
├── src/
│   ├── index.js              # Entry point, Express app
│   ├── config/
│   │   ├── db.js             # MongoDB connection
│   │   └── logger.js         # Winston logger
│   ├── models/
│   │   ├── Price.js          # Price snapshot schema
│   │   └── Transaction.js    # Transaction schema
│   ├── services/
│   │   ├── priceService.js   # CoinGecko + cache logic
│   │   └── transactionService.js
│   ├── controllers/
│   │   ├── priceController.js
│   │   └── transactionController.js
│   ├── routes/
│   │   ├── prices.js
│   │   └── transactions.js
│   └── middleware/
│       └── errorHandler.js
├── logs/                     # Auto-created log files
├── .env.example
├── .gitignore
└── package.json
```
