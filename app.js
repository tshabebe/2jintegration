const crypto = require("crypto");
const express = require("express");

const app = express();
const port = Number(process.env.PORT || 3001);

app.use(express.json({ limit: "1mb" }));

const users = new Map();
const processedTransfers = new Map();
const processedBatchTransfers = new Map();
const businessEvents = [];

const config = {
  port,
  baseUrl: process.env.APP_BASE_URL || `http://localhost:${port}`,
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

function getOrCreateUser(opId, seed = {}) {
  if (!users.has(opId)) {
    users.set(opId, {
      op_id: opId,
      nickname: seed.nickname || opId,
      gender: seed.gender ?? 0,
      availableAmount: Number(seed.availableAmount ?? 1_000_000),
      cnt: seed.cnt || config.defaultCountry,
      lan: seed.lan || config.defaultLanguage,
      meta: {},
    });
  }

  return users.get(opId);
}

function getExistingUser(opId) {
  return users.get(opId) || null;
}

function upsertUserFromProfile(payload) {
  const user = getOrCreateUser(payload.op_id, {
    nickname: payload.user_info?.nickname,
    gender: payload.user_info?.gender,
    cnt: payload.user_info?.cnt,
    lan: payload.user_info?.lan,
  });

  user.nickname = payload.user_info?.nickname || user.nickname;
  user.gender = payload.user_info?.gender ?? user.gender;
  user.cnt = payload.user_info?.cnt || user.cnt;
  user.lan = payload.user_info?.lan || user.lan;

  return user;
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

function applyTransfer(user, amount, transactionKey) {
  const nextAmount = user.availableAmount + amount;
  if (nextAmount < 0) {
    return {
      ok: false,
      code: errorCodes.insufficientBalance,
      msg: "insufficient balance",
    };
  }

  user.availableAmount = nextAmount;
  processedTransfers.set(transactionKey, {
    op_id: user.op_id,
    availableAmount: user.availableAmount,
  });

  return {
    ok: true,
    op_id: user.op_id,
    availableAmount: user.availableAmount,
  };
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

app.get("/", (req, res) => {
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
      <p>Callback base: <code>${config.baseUrl}</code></p>
    </main>
  </body>
</html>
  `);
});

app.get("/health", (req, res) => {
  res.json({
    ok: true,
    service: "2jintegration",
    timestamp: nowMs(),
    callbackBaseUrl: config.baseUrl,
    twoJBaseUrl: config.twoJBaseUrl,
  });
});

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

app.post("/api/dev/users/upsert", (req, res) => {
  const { op_id: opId, nickname, gender, availableAmount, cnt, lan } = req.body || {};

  if (!opId) {
    return sendError(res, errorCodes.invalidRequest, "op_id is required");
  }

  const user = getOrCreateUser(opId, {
    nickname,
    gender,
    availableAmount,
    cnt,
    lan,
  });

  if (nickname) {
    user.nickname = nickname;
  }
  if (gender !== undefined) {
    user.gender = gender;
  }
  if (availableAmount !== undefined) {
    user.availableAmount = Number(availableAmount);
  }
  if (cnt) {
    user.cnt = cnt;
  }
  if (lan) {
    user.lan = lan;
  }

  res.json({
    ok: true,
    user,
  });
});

app.get("/api/dev/users", (req, res) => {
  res.json({
    users: [...users.values()],
    processedTransfers: [...processedTransfers.entries()],
    processedBatchTransfers: [...processedBatchTransfers.entries()],
    businessEvents,
  });
});

app.post("/balance/get", (req, res) => {
  const { op_id: opId } = req.body || {};
  const user = getExistingUser(opId);

  if (!user) {
    return sendError(res, errorCodes.userNotFound, "user not exist", {
      result: {
        op_id: opId || "",
        availableAmount: 0,
      },
    });
  }

  return sendUserResult(res, user);
});

app.post("/member/profile", (req, res) => {
  const { op_id: opId } = req.body || {};
  const user = getExistingUser(opId);

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
});

app.post("/order/transfer", (req, res) => {
  const { op_id: opId, order, action } = req.body || {};

  if (!opId || !order?.trans_no || typeof order.amount !== "number") {
    return sendError(res, errorCodes.invalidRequest, "invalid transfer payload");
  }

  const user = getExistingUser(opId);
  if (!user) {
    return sendError(res, errorCodes.userNotFound, "user not exist");
  }

  const transactionKey = `${action}:${order.trans_no}`;
  const existing = processedTransfers.get(transactionKey);
  if (existing) {
    return res.json({
      header: makeHeader(errorCodes.success, ""),
      result: existing,
    });
  }

  const transferResult = applyTransfer(user, Number(order.amount), transactionKey);
  if (!transferResult.ok) {
    return sendError(res, transferResult.code, transferResult.msg, {
      result: {
        op_id: user.op_id,
        availableAmount: user.availableAmount,
      },
    });
  }

  return res.json({
    header: makeHeader(errorCodes.success, ""),
    result: transferResult,
  });
});

app.post("/order/batch_transfer", (req, res) => {
  const { action, trans_no: batchTransNo, orders } = req.body || {};

  if (!batchTransNo || !Array.isArray(orders)) {
    return sendError(res, errorCodes.invalidRequest, "invalid batch transfer payload");
  }

  const batchKey = `${action}:${batchTransNo}`;
  const cached = processedBatchTransfers.get(batchKey);
  if (cached) {
    return res.json(cached);
  }

  const results = [];
  let allFailed = true;

  for (const order of orders) {
    const user = getExistingUser(order.op_id);

    if (!user) {
      results.push({
        code: errorCodes.userNotFound,
        op_id: order.op_id,
        availableAmount: 0,
      });
      continue;
    }

    const transferKey = `${action}:${order.trans_no}`;
    const existing = processedTransfers.get(transferKey);
    if (existing) {
      results.push({
        code: errorCodes.success,
        ...existing,
      });
      allFailed = false;
      continue;
    }

    const transferResult = applyTransfer(user, Number(order.amount), transferKey);
    if (!transferResult.ok) {
      results.push({
        code: transferResult.code,
        op_id: user.op_id,
        availableAmount: user.availableAmount,
      });
      continue;
    }

    results.push({
      code: errorCodes.success,
      op_id: user.op_id,
      availableAmount: user.availableAmount,
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

  processedBatchTransfers.set(batchKey, payload);
  res.json(payload);
});

app.post("/order/business", (req, res) => {
  businessEvents.push({
    receivedAt: new Date().toISOString(),
    payload: req.body,
  });

  if (businessEvents.length > 200) {
    businessEvents.shift();
  }

  res.json({
    header: makeHeader(errorCodes.success, ""),
  });
});

app.post("/api/2j/create-user", async (req, res) => {
  try {
    const { op_id: opId, user_info: userInfo = {} } = req.body || {};

    if (!opId) {
      return sendError(res, errorCodes.invalidRequest, "op_id is required");
    }

    const user = upsertUserFromProfile({
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
  } catch (error) {
    res.status(500).json({
      error: error.message,
      response: error.response || null,
    });
  }
});

app.post("/api/2j/launch-game", async (req, res) => {
  try {
    const { op_id: opId, game_id: gameId, lang, backlink, device_type: deviceType, device_id: deviceId, ret_lobby_btn: retLobbyBtn, full_screen: fullScreen, auto_create_account: autoCreateAccount, keep_token: keepToken } = req.body || {};

    if (!opId || !gameId) {
      return sendError(res, errorCodes.invalidRequest, "op_id and game_id are required");
    }

    const user = getOrCreateUser(opId);

    const payload = {
      op_id: user.op_id,
      game_id: Number(gameId),
      lang: lang || "en-US",
      backlink: backlink || config.baseUrl,
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
  } catch (error) {
    res.status(500).json({
      error: error.message,
      response: error.response || null,
    });
  }
});

app.post("/api/2j/evict-user", async (req, res) => {
  try {
    const { op_id: opId } = req.body || {};
    if (!opId) {
      return sendError(res, errorCodes.invalidRequest, "op_id is required");
    }

    const response = await postTo2J("/open2j/c/evict", {
      op_id: opId,
    });
    res.json(response);
  } catch (error) {
    res.status(500).json({
      error: error.message,
      response: error.response || null,
    });
  }
});

app.post("/api/2j/detect-user-gaming", async (req, res) => {
  try {
    const { op_id: opId } = req.body || {};
    if (!opId) {
      return sendError(res, errorCodes.invalidRequest, "op_id is required");
    }

    const response = await postTo2J("/open2j/c/detect-user-gaming", {
      op_id: opId,
    });
    res.json(response);
  } catch (error) {
    res.status(500).json({
      error: error.message,
      response: error.response || null,
    });
  }
});

app.use((error, req, res, next) => {
  res.status(500).json({
    header: makeHeader(500, error.message || "internal error"),
  });
});

const server = app.listen(port, () => {
  console.log(`2J integration server listening on port ${port}`);
});

server.keepAliveTimeout = 120 * 1000;
server.headersTimeout = 120 * 1000;
