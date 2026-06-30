# 2jintegration

Express service prepared for a 2J seamless-wallet integration.

This app now covers two integration surfaces:

- OP callback endpoints that 2J will call for balance, profile, transfer, batch transfer, and business notices
- Helper endpoints that call 2J's own APIs with the required `mch`, `ts`, and `sign` values

## Local Development

```bash
npm install
npm start
```

The app listens on `PORT`, defaulting to `3001`.

## Environment Variables

Set these in Render before using the live 2J helper endpoints:

```bash
APP_BASE_URL=https://twojintegration.onrender.com
MONGODB_URI=mongodb+srv://<user>:<password>@<cluster>/<db>?retryWrites=true&w=majority
MONGODB_DB_NAME=2jintegration
TWOJ_BASE_URL=https://2j.com
TWOJ_MCH_ID=your_2j_merchant_id
TWOJ_MERCHANT_KEY=your_2j_merchant_key
TWOJ_DEFAULT_COUNTRY=US
TWOJ_DEFAULT_LANGUAGE=en
```

## Implemented Endpoints

### 2J callback endpoints

- `POST /balance/get`
- `POST /member/profile`
- `POST /order/transfer`
- `POST /order/batch_transfer`
- `POST /order/business`

### Local helper endpoints

- `POST /api/dev/users/upsert`
- `GET /api/dev/users`
- `POST /api/2j/create-user`
- `POST /api/2j/launch-game`
- `POST /api/2j/evict-user`
- `POST /api/2j/detect-user-gaming`

## Quick Test Flow

Create a local test wallet user:

```bash
curl -X POST http://localhost:3001/api/dev/users/upsert \
  -H 'Content-Type: application/json' \
  -d '{"op_id":"player-1001","nickname":"Demo User","availableAmount":5000}'
```

Ask the wallet callback for the current balance:

```bash
curl -X POST http://localhost:3001/balance/get \
  -H 'Content-Type: application/json' \
  -d '{"op_id":"player-1001"}'
```

Apply a debit or credit:

```bash
curl -X POST http://localhost:3001/order/transfer \
  -H 'Content-Type: application/json' \
  -d '{
    "op_id":"player-1001",
    "action":"bet",
    "order":{"trans_no":"tx-1001","amount":-250}
  }'
```

Launch a 2J game after setting merchant credentials:

```bash
curl -X POST http://localhost:3001/api/2j/launch-game \
  -H 'Content-Type: application/json' \
  -d '{"op_id":"player-1001","game_id":1001}'
```

## Render Deployment

This repo includes a [render.yaml](/home/teshe/projects/2jintegration/render.yaml) blueprint for a Node web service:

- Build command: `npm install`
- Start command: `node app.js`
- Health check endpoint: `GET /health`

## Notes

- Wallet users, transfer idempotency, and business events are now stored in MongoDB through Mongoose.
- `MONGODB_URI` is required in production unless you are intentionally using a local Mongo instance.
- Transfer idempotency is persisted by transaction key in MongoDB, so duplicate callbacks survive restarts.
- The 2J signing logic is based on the 2J API support documentation at `https://2j.com/api-support/en/` and the API pages under `/api/`.
