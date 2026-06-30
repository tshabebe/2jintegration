const crypto = require("crypto");
const express = require("express");
const mongoose = require("mongoose");

const app = express();
const port = Number(process.env.PORT || 3001);

app.use(express.json({ limit: "1mb" }));

const config = {
  port,
  baseUrl: process.env.APP_BASE_URL || "",
  mongoUri: process.env.MONGODB_URI || "mongodb://127.0.0.1:27017/2jintegration",
  mongoDbName: process.env.MONGODB_DB_NAME || "",
  twoJBaseUrl: process.env.TWOJ_BASE_URL || "https://2j.com",
  merchantId: process.env.TWOJ_MCH_ID || "",
  merchantKey: process.env.TWOJ_MERCHANT_KEY || "",
  defaultCountry: process.env.TWOJ_DEFAULT_COUNTRY || "US",
  defaultLanguage: process.env.TWOJ_DEFAULT_LANGUAGE || "en",
};

const errorCodes = {
  success: 0,
  invalidRequest: 100,
  userNotFound: 103,
  insufficientBalance: 108,
};

const userSchema = new mongoose.Schema(
  {
    op_id: { type: String, required: true, unique: true, index: true },
    nickname: { type: String, required: true },
    gender: { type: Number, default: 0 },
    availableAmount: { type: Number, default: 1_000_000 },
    cnt: { type: String, default: config.defaultCountry },
    lan: { type: String, default: config.defaultLanguage },
    meta: { type: mongoose.Schema.Types.Mixed, default: {} },
  },
  { timestamps: true, versionKey: false }
);

const transferSchema = new mongoose.Schema(
  {
    transactionKey: { type: String, required: true, unique: true, index: true },
    kind: { type: String, enum: ["single", "batch"], required: true },
    action: { type: String, required: true },
    op_id: { type: String, default: null },
    trans_no: { type: String, required: true },
    amount: { type: Number, default: null },
    batchResult: { type: mongoose.Schema.Types.Mixed, default: null },
    result: {
      op_id: { type: String, default: null },
      availableAmount: { type: Number, default: null },
      code: { type: Number, default: errorCodes.success },
    },
  },
  { timestamps: true, versionKey: false }
);

const businessEventSchema = new mongoose.Schema(
  {
    payload: { type: mongoose.Schema.Types.Mixed, required: true },
  },
  { timestamps: true, versionKey: false }
);

const User = mongoose.model("User", userSchema);
const Transfer = mongoose.model("Transfer", transferSchema);
const BusinessEvent = mongoose.model("BusinessEvent", businessEventSchema);

function nowMs() {
  return Date.now();
}

function makeHeader(code = 0, msg = "") {
  return {
    code,
    msg,
    timestamp: nowMs(),
  };
}

function sortObject(value) {
  if (Array.isArray(value)) {
    return value.map(sortObject);
  }

  if (value && typeof value === "object") {
    return Object.keys(value)
      .sort()
      .reduce((accumulator, key) => {
        accumulator[key] = sortObject(value[key]);
        return accumulator;
      }, {});
  }

  return value;
}

function stableJson(value) {
  return JSON.stringify(sortObject(value));
}

function compute2JSign(body, timestamp, key) {
  return crypto
    .createHash("md5")
    .update(stableJson(body))
    .update(String(timestamp))
    .update(key)
    .digest("hex");
}

function build2JUrl(pathname, timestamp, sign) {
  const url = new URL(pathname, config.twoJBaseUrl);
  url.searchParams.set("mch", config.merchantId);
  url.searchParams.set("ts", String(timestamp));
  url.searchParams.set("sign", sign);
  return url;
}

function require2JCredentials() {
  return Boolean(config.merchantId && config.merchantKey);
}

function getPublicBaseUrl(req) {
  if (config.baseUrl) {
    return config.baseUrl;
  }

  const protocol = req.get("x-forwarded-proto") || req.protocol || "http";
  const host = req.get("x-forwarded-host") || req.get("host");
  return host ? `${protocol}://${host}` : `http://localhost:${port}`;
}

function normalizeUser(user) {
  return {
    op_id: user.op_id,
    nickname: user.nickname,
    gender: user.gender,
    availableAmount: user.availableAmount,
    cnt: user.cnt,
    lan: user.lan,
    meta: user.meta || {},
  };
}

async function getOrCreateUser(opId, seed = {}) {
  await User.updateOne(
    { op_id: opId },
    {
      $setOnInsert: {
        op_id: opId,
        nickname: seed.nickname || opId,
        gender: seed.gender ?? 0,
        availableAmount: Number(seed.availableAmount ?? 1_000_000),
        cnt: seed.cnt || config.defaultCountry,
        lan: seed.lan || config.defaultLanguage,
        meta: seed.meta || {},
      },
    },
    { upsert: true }
  );

  return User.findOne({ op_id: opId }).lean();
}

async function getExistingUser(opId) {
  return User.findOne({ op_id: opId }).lean();
}

async function upsertUserFromProfile(payload) {
  const update = {
    $setOnInsert: {
      op_id: payload.op_id,
      availableAmount: 1_000_000,
      meta: {},
    },
    $set: {
      nickname: payload.user_info?.nickname || payload.op_id,
      gender: payload.user_info?.gender ?? 0,
      cnt: payload.user_info?.cnt || config.defaultCountry,
      lan: payload.user_info?.lan || config.defaultLanguage,
    },
  };

  return User.findOneAndUpdate({ op_id: payload.op_id }, update, {
    upsert: true,
    new: true,
    lean: true,
  });
}

function sendUserResult(res, user) {
  return res.json({
    header: makeHeader(errorCodes.success, ""),
    result: {
      op_id: user.op_id,
      availableAmount: user.availableAmount,
    },
  });
}

function sendError(res, code, msg, extra = {}) {
  return res.json({
    header: makeHeader(code, msg),
    ...extra,
  });
}

async function applySingleTransfer({ user, amount, transactionKey, action, transNo }) {
  const existing = await Transfer.findOne({ transactionKey }).lean();
  if (existing) {
    return {
      ok: true,
      duplicate: true,
      op_id: existing.result.op_id,
      availableAmount: existing.result.availableAmount,
    };
  }

  const updatedUser = await User.findOneAndUpdate(
    amount < 0
      ? { op_id: user.op_id, availableAmount: { $gte: Math.abs(amount) } }
      : { op_id: user.op_id },
    { $inc: { availableAmount: amount } },
    { new: true, lean: true }
  );

  if (!updatedUser) {
    return {
      ok: false,
      code: errorCodes.insufficientBalance,
      msg: "insufficient balance",
    };
  }

  try {
    await Transfer.create({
      transactionKey,
      kind: "single",
      action,
      op_id: user.op_id,
      trans_no: transNo,
      amount,
      result: {
        op_id: updatedUser.op_id,
        availableAmount: updatedUser.availableAmount,
        code: errorCodes.success,
      },
    });
  } catch (error) {
    if (error.code === 11000) {
      const duplicate = await Transfer.findOne({ transactionKey }).lean();
      return {
        ok: true,
        duplicate: true,
        op_id: duplicate.result.op_id,
        availableAmount: duplicate.result.availableAmount,
      };
    }
    throw error;
  }

  return {
    ok: true,
    op_id: updatedUser.op_id,
    availableAmount: updatedUser.availableAmount,
  };
}

async function getStoredBatchTransfer(transactionKey) {
  const existing = await Transfer.findOne({ transactionKey }).lean();
  return existing?.batchResult || null;
}

async function storeBatchTransfer({ transactionKey, action, transNo, batchResult }) {
  try {
    await Transfer.create({
      transactionKey,
      kind: "batch",
      action,
      trans_no: transNo,
      batchResult,
      result: {
        op_id: null,
        availableAmount: null,
        code: batchResult.header.code,
      },
    });
  } catch (error) {
    if (error.code !== 11000) {
      throw error;
    }
  }
}

async function trimBusinessEvents(limit = 200) {
  const count = await BusinessEvent.countDocuments();
  if (count <= limit) {
    return;
  }

  const overflow = count - limit;
  const stale = await BusinessEvent.find().sort({ createdAt: 1 }).limit(overflow).select("_id").lean();
  if (stale.length > 0) {
    await BusinessEvent.deleteMany({ _id: { $in: stale.map((item) => item._id) } });
  }
}

async function postTo2J(pathname, body) {
  if (!require2JCredentials()) {
    throw new Error("Missing TWOJ_MCH_ID or TWOJ_MERCHANT_KEY");
  }

  const timestamp = nowMs();
  const sign = compute2JSign(body, timestamp, config.merchantKey);
  const url = build2JUrl(pathname, timestamp, sign);

  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

  const text = await response.text();
  let data = null;

  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = { raw: text };
  }

  if (!response.ok) {
    const error = new Error(`2J request failed with HTTP ${response.status}`);
    error.response = data;
    throw error;
  }

  return data;
}

function asyncHandler(handler) {
  return (req, res, next) => {
    Promise.resolve(handler(req, res, next)).catch(next);
  };
}

app.get("/", (req, res) => {
  const publicBaseUrl = getPublicBaseUrl(req);

  res.type("html").send(`
<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>2J Integration</title>
    <style>
      :root {
        color-scheme: light;
        --bg: #f4efe6;
        --panel: #fffaf2;
        --ink: #18140f;
        --accent: #bf5b04;
        --muted: #6f6255;
      }
      * { box-sizing: border-box; }
      body {
        margin: 0;
        font-family: Georgia, "Times New Roman", serif;
        background:
          radial-gradient(circle at top left, #f7dcc0 0, transparent 30%),
          linear-gradient(180deg, var(--bg), #efe5d8);
        color: var(--ink);
        min-height: 100vh;
        display: grid;
        place-items: center;
        padding: 24px;
      }
      main {
        width: min(760px, 100%);
        background: var(--panel);
        border: 1px solid rgba(24, 20, 15, 0.08);
        border-radius: 24px;
        padding: 32px;
        box-shadow: 0 20px 60px rgba(58, 40, 16, 0.12);
      }
      h1 {
        font-size: clamp(2rem, 5vw, 3.5rem);
        margin: 0 0 16px;
      }
      p {
        margin: 0 0 12px;
        line-height: 1.5;
        color: var(--muted);
      }
      code {
        color: var(--accent);
        font-weight: 700;
      }
    </style>
  </head>
  <body>
    <main>
      <h1>2J Seamless Wallet Gateway</h1>
      <p>This service exposes the OP callbacks required by 2J seamless-wallet mode and helper endpoints for signed 2J API calls.</p>
      <p>Health check: <code>GET /health</code></p>
      <p>Callback base: <code>${publicBaseUrl}</code></p>
    </main>
  </body>
</html>
  `);
});

app.get(
  "/health",
  asyncHandler(async (req, res) => {
    res.json({
      ok: true,
      service: "2jintegration",
      timestamp: nowMs(),
      callbackBaseUrl: getPublicBaseUrl(req),
      twoJBaseUrl: config.twoJBaseUrl,
      database: {
        readyState: mongoose.connection.readyState,
        name: mongoose.connection.name || null,
      },
    });
  })
);

app.get("/api/docs", (req, res) => {
  res.json({
    callbacks: {
      balance: "/balance/get",
      profile: "/member/profile",
      transfer: "/order/transfer",
      batchTransfer: "/order/batch_transfer",
      business: "/order/business",
    },
    twoJHelpers: {
      createUser: "/api/2j/create-user",
      launchGame: "/api/2j/launch-game",
      evictUser: "/api/2j/evict-user",
      detectUserGaming: "/api/2j/detect-user-gaming",
    },
  });
});

app.post(
  "/api/dev/users/upsert",
  asyncHandler(async (req, res) => {
    const { op_id: opId, nickname, gender, availableAmount, cnt, lan } = req.body || {};

    if (!opId) {
      return sendError(res, errorCodes.invalidRequest, "op_id is required");
    }

    const update = {
      $setOnInsert: {
        op_id: opId,
        meta: {},
      },
      $set: {},
    };

    if (nickname) {
      update.$set.nickname = nickname;
    }
    if (gender !== undefined) {
      update.$set.gender = gender;
    }
    if (availableAmount !== undefined) {
      update.$set.availableAmount = Number(availableAmount);
    }
    if (cnt) {
      update.$set.cnt = cnt;
    }
    if (lan) {
      update.$set.lan = lan;
    }

    if (!update.$set.nickname) {
      update.$set.nickname = opId;
    }
    if (update.$set.gender === undefined) {
      update.$set.gender = 0;
    }
    if (!update.$set.cnt) {
      update.$set.cnt = config.defaultCountry;
    }
    if (!update.$set.lan) {
      update.$set.lan = config.defaultLanguage;
    }
    if (update.$set.availableAmount === undefined) {
      update.$setOnInsert.availableAmount = 1_000_000;
    }

    const user = await User.findOneAndUpdate({ op_id: opId }, update, {
      upsert: true,
      new: true,
      lean: true,
    });

    res.json({
      ok: true,
      user: normalizeUser(user),
    });
  })
);

app.get(
  "/api/dev/users",
  asyncHandler(async (req, res) => {
    const [users, processedTransfers, processedBatchTransfers, businessEvents] = await Promise.all([
      User.find().sort({ updatedAt: -1 }).lean(),
      Transfer.find({ kind: "single" }).sort({ updatedAt: -1 }).lean(),
      Transfer.find({ kind: "batch" }).sort({ updatedAt: -1 }).lean(),
      BusinessEvent.find().sort({ createdAt: -1 }).limit(200).lean(),
    ]);

    res.json({
      users: users.map(normalizeUser),
      processedTransfers: processedTransfers.map((item) => ({
        transactionKey: item.transactionKey,
        result: item.result,
        action: item.action,
        trans_no: item.trans_no,
        amount: item.amount,
      })),
      processedBatchTransfers: processedBatchTransfers.map((item) => ({
        transactionKey: item.transactionKey,
        action: item.action,
        trans_no: item.trans_no,
        batchResult: item.batchResult,
      })),
      businessEvents,
    });
  })
);

app.post(
  "/balance/get",
  asyncHandler(async (req, res) => {
    const { op_id: opId } = req.body || {};
    const user = await getExistingUser(opId);

    if (!user) {
      return sendError(res, errorCodes.userNotFound, "user not exist", {
        result: {
          op_id: opId || "",
          availableAmount: 0,
        },
      });
    }

    return sendUserResult(res, user);
  })
);

app.post(
  "/member/profile",
  asyncHandler(async (req, res) => {
    const { op_id: opId } = req.body || {};
    const user = await getExistingUser(opId);

    if (!user) {
      return sendError(res, errorCodes.userNotFound, "user not exist");
    }

    res.json({
      header: makeHeader(errorCodes.success, ""),
      result: {
        nickname: user.nickname,
        gender: user.gender,
      },
    });
  })
);

app.post(
  "/order/transfer",
  asyncHandler(async (req, res) => {
    const { op_id: opId, order, action } = req.body || {};

    if (!opId || !order?.trans_no || typeof order.amount !== "number") {
      return sendError(res, errorCodes.invalidRequest, "invalid transfer payload");
    }

    const user = await getExistingUser(opId);
    if (!user) {
      return sendError(res, errorCodes.userNotFound, "user not exist");
    }

    const transactionKey = `${action}:${order.trans_no}`;
    const transferResult = await applySingleTransfer({
      user,
      amount: Number(order.amount),
      transactionKey,
      action,
      transNo: order.trans_no,
    });

    if (!transferResult.ok) {
      const currentUser = await getExistingUser(opId);
      return sendError(res, transferResult.code, transferResult.msg, {
        result: {
          op_id: opId,
          availableAmount: currentUser?.availableAmount ?? 0,
        },
      });
    }

    return res.json({
      header: makeHeader(errorCodes.success, ""),
      result: {
        op_id: transferResult.op_id,
        availableAmount: transferResult.availableAmount,
      },
    });
  })
);

app.post(
  "/order/batch_transfer",
  asyncHandler(async (req, res) => {
    const { action, trans_no: batchTransNo, orders } = req.body || {};

    if (!batchTransNo || !Array.isArray(orders)) {
      return sendError(res, errorCodes.invalidRequest, "invalid batch transfer payload");
    }

    const batchKey = `${action}:${batchTransNo}`;
    const cached = await getStoredBatchTransfer(batchKey);
    if (cached) {
      return res.json(cached);
    }

    const results = [];
    let allFailed = true;

    for (const order of orders) {
      const user = await getExistingUser(order.op_id);

      if (!user) {
        results.push({
          code: errorCodes.userNotFound,
          op_id: order.op_id,
          availableAmount: 0,
        });
        continue;
      }

      const transferResult = await applySingleTransfer({
        user,
        amount: Number(order.amount),
        transactionKey: `${action}:${order.trans_no}`,
        action,
        transNo: order.trans_no,
      });

      if (!transferResult.ok) {
        const currentUser = await getExistingUser(order.op_id);
        results.push({
          code: transferResult.code,
          op_id: order.op_id,
          availableAmount: currentUser?.availableAmount ?? 0,
        });
        continue;
      }

      results.push({
        code: errorCodes.success,
        op_id: transferResult.op_id,
        availableAmount: transferResult.availableAmount,
      });
      allFailed = false;
    }

    const payload = {
      header: makeHeader(
        allFailed ? errorCodes.invalidRequest : errorCodes.success,
        allFailed ? "all batch transfer items failed" : ""
      ),
      result: {
        data: results,
      },
    };

    await storeBatchTransfer({
      transactionKey: batchKey,
      action,
      transNo: batchTransNo,
      batchResult: payload,
    });

    res.json(payload);
  })
);

app.post(
  "/order/business",
  asyncHandler(async (req, res) => {
    await BusinessEvent.create({
      payload: req.body,
    });
    await trimBusinessEvents();

    res.json({
      header: makeHeader(errorCodes.success, ""),
    });
  })
);

app.post(
  "/api/2j/create-user",
  asyncHandler(async (req, res) => {
    const { op_id: opId, user_info: userInfo = {} } = req.body || {};

    if (!opId) {
      return sendError(res, errorCodes.invalidRequest, "op_id is required");
    }

    const user = await upsertUserFromProfile({
      op_id: opId,
      user_info: {
        nickname: userInfo.nickname || opId,
        gender: userInfo.gender ?? 0,
        cnt: userInfo.cnt || config.defaultCountry,
        lan: userInfo.lan || config.defaultLanguage,
      },
    });

    const payload = {
      op_id: user.op_id,
      user_info: {
        nickname: user.nickname,
        gender: user.gender,
        cnt: user.cnt,
        lan: user.lan,
      },
    };

    const response = await postTo2J("/open2j/c/create", payload);
    res.json(response);
  })
);

app.post(
  "/api/2j/launch-game",
  asyncHandler(async (req, res) => {
    const {
      op_id: opId,
      game_id: gameId,
      lang,
      backlink,
      device_type: deviceType,
      device_id: deviceId,
      ret_lobby_btn: retLobbyBtn,
      full_screen: fullScreen,
      auto_create_account: autoCreateAccount,
      keep_token: keepToken,
    } = req.body || {};

    if (!opId || !gameId) {
      return sendError(res, errorCodes.invalidRequest, "op_id and game_id are required");
    }

    const user = await getOrCreateUser(opId);

    const payload = {
      op_id: user.op_id,
      game_id: Number(gameId),
      lang: lang || "en-US",
      backlink: backlink || getPublicBaseUrl(req),
      device_type: deviceType,
      device_id: deviceId,
      ret_lobby_btn: retLobbyBtn,
      full_screen: fullScreen,
      auto_create_account: autoCreateAccount,
      keep_token: keepToken,
    };

    Object.keys(payload).forEach((key) => {
      if (payload[key] === undefined) {
        delete payload[key];
      }
    });

    const response = await postTo2J("/open2j/c/launch", payload);
    res.json(response);
  })
);

app.post(
  "/api/2j/evict-user",
  asyncHandler(async (req, res) => {
    const { op_id: opId } = req.body || {};
    if (!opId) {
      return sendError(res, errorCodes.invalidRequest, "op_id is required");
    }

    const response = await postTo2J("/open2j/c/evict", {
      op_id: opId,
    });
    res.json(response);
  })
);

app.post(
  "/api/2j/detect-user-gaming",
  asyncHandler(async (req, res) => {
    const { op_id: opId } = req.body || {};
    if (!opId) {
      return sendError(res, errorCodes.invalidRequest, "op_id is required");
    }

    const response = await postTo2J("/open2j/c/detect-user-gaming", {
      op_id: opId,
    });
    res.json(response);
  })
);

app.use((error, req, res, next) => {
  const is2JError = Boolean(error.response);
  const status = is2JError ? 502 : 500;

  res.status(status).json({
    header: makeHeader(status, error.message || "internal error"),
    response: error.response || null,
  });
});

async function connectDatabase() {
  if (mongoose.connection.readyState === 1) {
    return mongoose.connection;
  }

  await mongoose.connect(config.mongoUri, config.mongoDbName ? { dbName: config.mongoDbName } : {});
  return mongoose.connection;
}

async function disconnectDatabase() {
  if (mongoose.connection.readyState === 0) {
    return;
  }

  await mongoose.disconnect();
}

let server = null;

async function start() {
  await connectDatabase();

  server = app.listen(port, () => {
    console.log(`2J integration server listening on port ${port}`);
  });

  server.keepAliveTimeout = 120 * 1000;
  server.headersTimeout = 120 * 1000;

  return server;
}

async function stop() {
  if (server) {
    await new Promise((resolve, reject) => {
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve();
      });
    });
    server = null;
  }

  await disconnectDatabase();
}

module.exports = {
  app,
  config,
  models: {
    User,
    Transfer,
    BusinessEvent,
  },
  start,
  stop,
  connectDatabase,
  disconnectDatabase,
};

if (require.main === module) {
  start().catch((error) => {
    console.error("Failed to start server", error);
    process.exit(1);
  });
}
