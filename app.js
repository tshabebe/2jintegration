const crypto = require("crypto");
const express = require("express");
const mongoose = require("mongoose");

const app = express();
const port = Number(process.env.PORT || 3001);

app.use(express.json({ limit: "1mb" }));
app.use(express.urlencoded({ extended: false }));

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
  lobbyUsername: process.env.LOBBY_USERNAME || "giftbetdemo",
  lobbyPassword: process.env.LOBBY_PASSWORD || "GiftBetPlay123!",
  sessionSecret: process.env.SESSION_SECRET || process.env.TWOJ_MERCHANT_KEY || "giftbet-lobby-secret",
  demoOpId: process.env.DEMO_OP_ID || "giftbet-demo-player",
  demoNickname: process.env.DEMO_NICKNAME || "GiftBet Demo",
  demoBalanceBirr: Number(process.env.DEMO_BALANCE_BIRR || 10_000),
  catalogUrl:
    process.env.TWOJ_GAME_CATALOG_URL ||
    "https://docs.google.com/spreadsheets/d/1jU7XNjp02nmp0A29tnCUbw01gHsN9AIM/export?format=csv&gid=1677103144",
};

const LOBBY_COOKIE = "giftbet_lobby";
const BALANCE_SCALE = 1000;
const GAME_CATALOG_REFRESH_MS = 15 * 60 * 1000;

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
const gameCatalogCache = {
  games: [],
  fetchedAt: 0,
  promise: null,
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

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (char) => {
    switch (char) {
      case "&":
        return "&amp;";
      case "<":
        return "&lt;";
      case ">":
        return "&gt;";
      case '"':
        return "&quot;";
      case "'":
        return "&#39;";
      default:
        return char;
    }
  });
}

function birrToLi(amountBirr) {
  return Math.round(Number(amountBirr || 0) * BALANCE_SCALE);
}

function liToBirr(amountLi) {
  return Number(amountLi || 0) / BALANCE_SCALE;
}

function formatBirr(amountLi) {
  return new Intl.NumberFormat("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(liToBirr(amountLi));
}

function parseCookies(headerValue = "") {
  return headerValue
    .split(";")
    .map((item) => item.trim())
    .filter(Boolean)
    .reduce((accumulator, entry) => {
      const separatorIndex = entry.indexOf("=");
      if (separatorIndex === -1) {
        return accumulator;
      }
      const key = entry.slice(0, separatorIndex);
      const value = entry.slice(separatorIndex + 1);
      accumulator[key] = decodeURIComponent(value);
      return accumulator;
    }, {});
}

function signSessionPayload(payload) {
  return crypto.createHmac("sha256", config.sessionSecret).update(payload).digest("hex");
}

function makeLobbySession(username) {
  const expiresAt = nowMs() + 12 * 60 * 60 * 1000;
  const payload = `${username}:${expiresAt}`;
  const signature = signSessionPayload(payload);
  return `${payload}:${signature}`;
}

function readLobbySession(req) {
  const cookies = parseCookies(req.headers.cookie || "");
  const raw = cookies[LOBBY_COOKIE];
  if (!raw) {
    return null;
  }

  const parts = raw.split(":");
  if (parts.length !== 3) {
    return null;
  }

  const [username, expiresAtRaw, signature] = parts;
  const payload = `${username}:${expiresAtRaw}`;
  const expected = signSessionPayload(payload);
  if (signature !== expected) {
    return null;
  }

  const expiresAt = Number(expiresAtRaw);
  if (!Number.isFinite(expiresAt) || expiresAt < nowMs()) {
    return null;
  }

  if (username !== config.lobbyUsername) {
    return null;
  }

  return { username, expiresAt };
}

function setLobbySession(res, username) {
  const token = makeLobbySession(username);
  res.setHeader(
    "Set-Cookie",
    `${LOBBY_COOKIE}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${12 * 60 * 60}`
  );
}

function clearLobbySession(res) {
  res.setHeader("Set-Cookie", `${LOBBY_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`);
}

function requireLobbyAuth(req, res, next) {
  if (!readLobbySession(req)) {
    res.redirect("/lobby?error=login_required");
    return;
  }
  next();
}

function parseCsv(text) {
  const rows = [];
  let row = [];
  let cell = "";
  let inQuotes = false;

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    const nextChar = text[index + 1];

    if (char === '"') {
      if (inQuotes && nextChar === '"') {
        cell += '"';
        index += 1;
      } else {
        inQuotes = !inQuotes;
      }
      continue;
    }

    if (char === "," && !inQuotes) {
      row.push(cell);
      cell = "";
      continue;
    }

    if ((char === "\n" || char === "\r") && !inQuotes) {
      if (char === "\r" && nextChar === "\n") {
        index += 1;
      }
      row.push(cell);
      rows.push(row);
      row = [];
      cell = "";
      continue;
    }

    cell += char;
  }

  if (cell.length > 0 || row.length > 0) {
    row.push(cell);
    rows.push(row);
  }

  return rows;
}

function mapGameRecord(headers, record) {
  const values = headers.reduce((accumulator, header, index) => {
    accumulator[header] = record[index] || "";
    return accumulator;
  }, {});

  const gameId = Number(values["游戏ID\nGame ID"] || values["游戏ID Game ID"] || values.GameID || values["Game ID"]);
  if (!Number.isFinite(gameId)) {
    return null;
  }

  return {
    gameId,
    chineseName: values["游戏名称（中）\nChinese Name"] || values["游戏名称（中） Chinese Name"] || "",
    englishName: values["游戏名称（英）\nGame Name"] || values["游戏名称（英） Game Name"] || "",
    rtp: values["返奖率\nRTP"] || values["返奖率 RTP"] || "",
    lines: values["线路\nLINE/WAY"] || values["线路 LINE/WAY"] || "",
    maxOdds: values["最高倍率\nMAX ODDS"] || values["最高倍率 MAX ODDS"] || "",
    volatility: values["波动率\nVOLATILITY"] || values["波动率 VOLATILITY"] || "",
    display: values["横竖屏\nDISPLAY"] || values["横竖屏 DISPLAY"] || "",
    publishTime: values["上线时间\nPublish Time"] || values["上线时间 Publish Time"] || "",
    demoUrl: values["游戏试玩Demo"] || "",
    iconName: values["游戏Icon"] || "",
  };
}

async function loadGameCatalog(force = false) {
  const cacheIsFresh =
    !force &&
    gameCatalogCache.games.length > 0 &&
    nowMs() - gameCatalogCache.fetchedAt < GAME_CATALOG_REFRESH_MS;

  if (cacheIsFresh) {
    return gameCatalogCache.games;
  }

  if (gameCatalogCache.promise) {
    return gameCatalogCache.promise;
  }

  gameCatalogCache.promise = (async () => {
    const response = await fetch(config.catalogUrl);
    if (!response.ok) {
      throw new Error(`Game catalog request failed with HTTP ${response.status}`);
    }

    const csvText = await response.text();
    const rows = parseCsv(csvText).filter((row) => row.some((cell) => String(cell || "").trim() !== ""));
    if (rows.length < 2) {
      throw new Error("Game catalog response was empty");
    }

    const [headers, ...records] = rows;
    const games = records
      .map((record) => mapGameRecord(headers, record))
      .filter(Boolean)
      .slice(0, 240);

    gameCatalogCache.games = games;
    gameCatalogCache.fetchedAt = nowMs();
    return games;
  })();

  try {
    return await gameCatalogCache.promise;
  } finally {
    gameCatalogCache.promise = null;
  }
}

function buildGameArtColors(gameId) {
  const hue = gameId % 360;
  return {
    start: `hsl(${hue} 80% 58%)`,
    end: `hsl(${(hue + 48) % 360} 85% 40%)`,
    glow: `hsla(${(hue + 24) % 360} 90% 70% / 0.8)`,
  };
}

function buildGameArtSvg(game) {
  const colors = buildGameArtColors(game.gameId);
  const title = escapeHtml(game.englishName || game.chineseName || `Game ${game.gameId}`);
  const subtitle = escapeHtml(game.chineseName || game.englishName || "");
  const badge = escapeHtml(String(game.gameId));
  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 640 860" role="img" aria-label="${title}">
  <defs>
    <linearGradient id="g" x1="0" x2="1" y1="0" y2="1">
      <stop offset="0%" stop-color="${colors.start}" />
      <stop offset="100%" stop-color="${colors.end}" />
    </linearGradient>
    <radialGradient id="r" cx="30%" cy="20%" r="65%">
      <stop offset="0%" stop-color="${colors.glow}" />
      <stop offset="100%" stop-color="transparent" />
    </radialGradient>
  </defs>
  <rect width="640" height="860" rx="42" fill="#120f14" />
  <rect width="640" height="860" rx="42" fill="url(#g)" opacity="0.9" />
  <circle cx="180" cy="150" r="180" fill="url(#r)" />
  <circle cx="520" cy="730" r="160" fill="url(#r)" opacity="0.45" />
  <rect x="34" y="34" width="572" height="792" rx="30" fill="rgba(12,10,18,0.28)" stroke="rgba(255,255,255,0.28)" />
  <text x="62" y="102" fill="white" font-size="36" font-family="Georgia, serif" opacity="0.84">GiftBet x 2J</text>
  <text x="62" y="470" fill="white" font-size="58" font-weight="700" font-family="Georgia, serif">${title}</text>
  <text x="62" y="530" fill="rgba(255,255,255,0.88)" font-size="28" font-family="Georgia, serif">${subtitle}</text>
  <text x="62" y="748" fill="white" font-size="112" font-weight="700" font-family="Georgia, serif">${badge}</text>
  <text x="62" y="796" fill="rgba(255,255,255,0.82)" font-size="26" font-family="Georgia, serif">Tap to launch on the test lobby</text>
</svg>`;
}

function deriveGameCategory(game) {
  const text = `${game.englishName} ${game.chineseName} ${game.lines} ${game.panel}`.toLowerCase();

  if (text.includes("fish")) {
    return "Fish";
  }
  if (text.includes("bingo")) {
    return "Bingo";
  }
  if (text.includes("mahjong")) {
    return "Mahjong";
  }
  if (text.includes("dragon & tiger")) {
    return "Arcade Table";
  }
  if (text.includes("cascading")) {
    return "Cascade Slot";
  }
  if (text.includes("megaways") || text.includes("ways")) {
    return "Ways Slot";
  }
  if (text.includes("line")) {
    return "Line Slot";
  }
  if (text.includes("multiple")) {
    return "Arcade Reel";
  }

  return "Slot";
}

function renderLoginPage(errorMessage = "") {
  const errorBlock = errorMessage
    ? `<p class="error">${escapeHtml(errorMessage)}</p>`
    : `<p class="hint">Use the lobby credentials to enter the demo account.</p>`;

  return `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>GiftBet Lobby Login</title>
    <style>
      :root {
        --sand: #eadfcd;
        --cream: #f9f2e7;
        --ink: #17120e;
        --burnt: #b14d14;
        --deep: #4a1e11;
        --line: rgba(23, 18, 14, 0.12);
      }
      * { box-sizing: border-box; }
      body {
        margin: 0;
        min-height: 100vh;
        display: grid;
        place-items: center;
        padding: 24px;
        color: var(--ink);
        background:
          radial-gradient(circle at top left, rgba(255, 196, 127, 0.55), transparent 28%),
          radial-gradient(circle at bottom right, rgba(217, 98, 43, 0.35), transparent 24%),
          linear-gradient(140deg, #f5e6d2, #efe2d3 45%, #dfc6aa);
        font-family: Georgia, "Times New Roman", serif;
      }
      main {
        width: min(960px, 100%);
        display: grid;
        grid-template-columns: 1.2fr 0.9fr;
        background: rgba(249, 242, 231, 0.92);
        border: 1px solid rgba(255, 255, 255, 0.5);
        border-radius: 28px;
        overflow: hidden;
        box-shadow: 0 30px 80px rgba(76, 34, 13, 0.18);
        backdrop-filter: blur(12px);
      }
      .hero {
        padding: 44px;
        background:
          linear-gradient(180deg, rgba(23,18,14,0.05), transparent),
          linear-gradient(135deg, rgba(177,77,20,0.16), transparent 55%);
      }
      .panel {
        padding: 44px;
        background: rgba(255,255,255,0.58);
        border-left: 1px solid var(--line);
      }
      h1 {
        margin: 0 0 14px;
        font-size: clamp(2.4rem, 5vw, 4rem);
        line-height: 0.95;
      }
      p {
        line-height: 1.5;
        font-size: 1.02rem;
      }
      .eyebrow, .stat-label {
        text-transform: uppercase;
        letter-spacing: 0.16em;
        font-size: 0.75rem;
        color: rgba(23,18,14,0.66);
      }
      .stats {
        display: grid;
        grid-template-columns: repeat(3, 1fr);
        gap: 14px;
        margin-top: 34px;
      }
      .stat {
        padding: 16px;
        border-radius: 18px;
        background: rgba(255,255,255,0.62);
        border: 1px solid var(--line);
      }
      .stat strong {
        display: block;
        margin-top: 6px;
        font-size: 1.3rem;
      }
      form {
        display: grid;
        gap: 16px;
      }
      label {
        display: grid;
        gap: 8px;
        font-size: 0.95rem;
      }
      input {
        width: 100%;
        padding: 14px 16px;
        border-radius: 14px;
        border: 1px solid rgba(23,18,14,0.16);
        background: rgba(255,255,255,0.92);
        font: inherit;
      }
      button {
        border: 0;
        border-radius: 16px;
        padding: 15px 18px;
        color: white;
        background: linear-gradient(135deg, var(--burnt), var(--deep));
        font: inherit;
        font-weight: 700;
        cursor: pointer;
      }
      .hint, .error {
        margin: 0 0 18px;
        padding: 12px 14px;
        border-radius: 14px;
      }
      .hint {
        background: rgba(177,77,20,0.08);
      }
      .error {
        background: rgba(163, 28, 24, 0.12);
        color: #7b1612;
      }
      @media (max-width: 860px) {
        main { grid-template-columns: 1fr; }
        .panel { border-left: 0; border-top: 1px solid var(--line); }
        .stats { grid-template-columns: 1fr; }
      }
    </style>
  </head>
  <body>
    <main>
      <section class="hero">
        <p class="eyebrow">GiftBet Demo Lobby</p>
        <h1>Pick a game and enter directly.</h1>
        <p>The backend seeds one demo wallet, syncs it to 2J, and launches real game URLs from the deployed Render service.</p>
        <div class="stats">
          <div class="stat">
            <span class="stat-label">Balance</span>
            <strong>ETB 10,000</strong>
          </div>
          <div class="stat">
            <span class="stat-label">Mode</span>
            <strong>Seamless</strong>
          </div>
          <div class="stat">
            <span class="stat-label">Cluster</span>
            <strong>Production</strong>
          </div>
        </div>
      </section>
      <section class="panel">
        <p class="eyebrow">Login</p>
        ${errorBlock}
        <form method="post" action="/lobby/login">
          <label>
            Username
            <input type="text" name="username" autocomplete="username" required />
          </label>
          <label>
            Password
            <input type="password" name="password" autocomplete="current-password" required />
          </label>
          <button type="submit">Enter Lobby</button>
        </form>
      </section>
    </main>
  </body>
</html>`;
}

function renderLobbyPage({ user, games }) {
  const cards = games
    .map((game) => {
      const title = escapeHtml(game.englishName || game.chineseName || `Game ${game.gameId}`);
      const subtitle = escapeHtml(game.chineseName || game.englishName || "");
      const category = escapeHtml(deriveGameCategory(game));
      const meta = [
        game.rtp ? `RTP ${escapeHtml(game.rtp)}` : "",
        game.lines ? escapeHtml(game.lines) : "",
        game.volatility ? escapeHtml(game.volatility) : "",
      ]
        .filter(Boolean)
        .join(" • ");

      return `<article class="card" data-search="${escapeHtml(
        `${game.gameId} ${game.englishName} ${game.chineseName}`.toLowerCase()
      )}">
        <a class="thumb-link" href="/lobby/play/${game.gameId}">
          <img src="/lobby/game-art/${game.gameId}.svg" alt="${title}" loading="lazy" />
        </a>
        <div class="card-body">
          <div class="card-topline">
            <span class="game-id">#${game.gameId}</span>
            <span class="game-category">${category}</span>
          </div>
          <h2>${title}</h2>
          <p class="subtitle">${subtitle}</p>
          <p class="meta">${meta}</p>
          <p class="publish">${escapeHtml(game.publishTime || "")}</p>
          <a class="play" href="/lobby/play/${game.gameId}">Play Now</a>
        </div>
      </article>`;
    })
    .join("");

  return `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>GiftBet Demo Lobby</title>
    <style>
      :root {
        --paper: #f6efe4;
        --panel: rgba(255,255,255,0.74);
        --ink: #16110d;
        --muted: #665a4f;
        --accent: #a24715;
        --accent-2: #5a2410;
        --line: rgba(22,17,13,0.1);
      }
      * { box-sizing: border-box; }
      body {
        margin: 0;
        color: var(--ink);
        font-family: Georgia, "Times New Roman", serif;
        background:
          radial-gradient(circle at top left, rgba(248,188,120,0.55), transparent 24%),
          radial-gradient(circle at 80% 12%, rgba(186,72,17,0.24), transparent 20%),
          linear-gradient(180deg, #f8ecd8, #efe1cb 45%, #ead8c0);
      }
      .shell {
        width: min(1320px, calc(100% - 24px));
        margin: 18px auto;
        padding: 18px;
        border: 1px solid rgba(255,255,255,0.44);
        border-radius: 28px;
        background: rgba(255,255,255,0.24);
        backdrop-filter: blur(10px);
        box-shadow: 0 24px 70px rgba(76, 34, 13, 0.14);
      }
      header {
        display: flex;
        justify-content: space-between;
        gap: 18px;
        align-items: flex-end;
        padding: 18px;
      }
      h1 {
        margin: 6px 0 8px;
        font-size: clamp(2rem, 5vw, 3.8rem);
        line-height: 0.96;
      }
      p { margin: 0; }
      .eyebrow {
        text-transform: uppercase;
        letter-spacing: 0.16em;
        font-size: 0.75rem;
        color: rgba(22,17,13,0.66);
      }
      .lead {
        max-width: 760px;
        color: var(--muted);
        line-height: 1.5;
      }
      .actions {
        display: flex;
        flex-wrap: wrap;
        gap: 12px;
        justify-content: flex-end;
      }
      .stat, .search, .logout button {
        border-radius: 18px;
        border: 1px solid var(--line);
        background: var(--panel);
      }
      .stat {
        padding: 12px 16px;
        min-width: 170px;
      }
      .stat strong {
        display: block;
        margin-top: 4px;
        font-size: 1.2rem;
      }
      .toolbar {
        display: flex;
        gap: 12px;
        flex-wrap: wrap;
        padding: 0 18px 18px;
        align-items: center;
      }
      .search {
        flex: 1 1 320px;
        padding: 0 14px;
      }
      .search input {
        width: 100%;
        border: 0;
        background: transparent;
        padding: 16px 0;
        font: inherit;
        color: var(--ink);
      }
      .logout button {
        padding: 16px 18px;
        font: inherit;
        cursor: pointer;
      }
      .grid {
        display: grid;
        grid-template-columns: repeat(auto-fill, minmax(230px, 1fr));
        gap: 18px;
        padding: 0 18px 18px;
      }
      .card {
        overflow: hidden;
        border-radius: 24px;
        background: var(--panel);
        border: 1px solid var(--line);
        box-shadow: 0 18px 34px rgba(56, 29, 11, 0.08);
      }
      .thumb-link {
        display: block;
        aspect-ratio: 3 / 4;
        overflow: hidden;
        background: #171018;
      }
      .thumb-link img {
        display: block;
        width: 100%;
        height: 100%;
        object-fit: cover;
      }
      .card-body {
        padding: 16px;
      }
      .card-topline {
        display: flex;
        justify-content: space-between;
        align-items: center;
        gap: 10px;
        color: rgba(22,17,13,0.62);
        font-size: 0.82rem;
      }
      .game-category {
        padding: 5px 10px;
        border-radius: 999px;
        background: rgba(162, 71, 21, 0.1);
        color: #7d330f;
        font-weight: 700;
      }
      h2 {
        margin: 10px 0 6px;
        font-size: 1.12rem;
        line-height: 1.15;
      }
      .subtitle {
        min-height: 2.7em;
        color: var(--muted);
      }
      .meta {
        min-height: 2.7em;
        margin: 12px 0 10px;
        font-size: 0.88rem;
        color: rgba(22,17,13,0.68);
      }
      .publish {
        margin: 0 0 16px;
        font-size: 0.82rem;
        color: rgba(22,17,13,0.52);
      }
      .play {
        display: inline-block;
        width: 100%;
        text-align: center;
        text-decoration: none;
        color: white;
        border-radius: 16px;
        padding: 13px 16px;
        background: linear-gradient(135deg, var(--accent), var(--accent-2));
      }
      .empty {
        display: none;
        padding: 26px 18px 32px;
        color: var(--muted);
      }
      @media (max-width: 760px) {
        header { align-items: stretch; flex-direction: column; }
        .actions { justify-content: stretch; }
        .stat { min-width: 0; flex: 1 1 0; }
      }
    </style>
  </head>
  <body>
    <div class="shell">
      <header>
        <div>
          <p class="eyebrow">GiftBet Demo Lobby</p>
          <h1>Pick a game and launch it.</h1>
          <p class="lead">Signed game URLs are generated by the live backend using the seeded demo player. Clicking any card creates the 2J launch URL and redirects into the game.</p>
        </div>
        <div class="actions">
          <div class="stat">
            <span class="eyebrow">Player</span>
            <strong>${escapeHtml(user.nickname)}</strong>
          </div>
          <div class="stat">
            <span class="eyebrow">Balance</span>
            <strong>ETB ${escapeHtml(formatBirr(user.availableAmount))}</strong>
          </div>
          <div class="stat">
            <span class="eyebrow">Games</span>
            <strong>${games.length}</strong>
          </div>
        </div>
      </header>
      <div class="toolbar">
        <label class="search">
          <input id="search" type="search" placeholder="Search by game name or ID" />
        </label>
        <form class="logout" method="post" action="/lobby/logout">
          <button type="submit">Logout</button>
        </form>
      </div>
      <div id="grid" class="grid">${cards}</div>
      <p id="empty" class="empty">No games match that search.</p>
    </div>
    <script>
      const searchInput = document.getElementById("search");
      const cards = Array.from(document.querySelectorAll(".card"));
      const emptyState = document.getElementById("empty");
      searchInput.addEventListener("input", () => {
        const query = searchInput.value.trim().toLowerCase();
        let visible = 0;
        cards.forEach((card) => {
          const matches = !query || card.dataset.search.includes(query);
          card.style.display = matches ? "" : "none";
          if (matches) visible += 1;
        });
        emptyState.style.display = visible === 0 ? "block" : "none";
      });
    </script>
  </body>
</html>`;
}

async function ensureDemoUser() {
  const availableAmount = birrToLi(config.demoBalanceBirr);
  await User.updateOne(
    { op_id: config.demoOpId },
    {
      $setOnInsert: {
        op_id: config.demoOpId,
        gender: 0,
        availableAmount,
        meta: {
          demoAccount: true,
        },
      },
      $set: {
        nickname: config.demoNickname,
        cnt: config.defaultCountry,
        lan: config.defaultLanguage,
      },
    },
    {
      upsert: true,
    }
  );
  return User.findOne({ op_id: config.demoOpId }).lean();
}

function compute2JSign(bodyText, timestamp, key) {
  return crypto
    .createHash("md5")
    .update(bodyText)
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
  const bodyText = JSON.stringify(body);
  const sign = compute2JSign(bodyText, timestamp, config.merchantKey);
  const url = build2JUrl(pathname, timestamp, sign);

  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: bodyText,
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
      a {
        color: var(--accent);
        font-weight: 700;
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
      <p>Demo lobby: <a href="/lobby">/lobby</a></p>
    </main>
  </body>
</html>
  `);
});

app.get(
  "/lobby/game-art/:gameId.svg",
  asyncHandler(async (req, res) => {
    const gameId = Number(req.params.gameId);
    if (!Number.isFinite(gameId)) {
      return res.status(404).end();
    }

    const games = await loadGameCatalog();
    const game = games.find((item) => item.gameId === gameId);
    if (!game) {
      return res.status(404).end();
    }

    res.type("image/svg+xml").send(buildGameArtSvg(game));
  })
);

app.get(
  "/lobby",
  asyncHandler(async (req, res) => {
    const session = readLobbySession(req);
    if (!session) {
      const error = req.query.error === "invalid_credentials" ? "Invalid username or password." : "";
      return res.type("html").send(renderLoginPage(error));
    }

    const [user, games] = await Promise.all([ensureDemoUser(), loadGameCatalog()]);
    res.type("html").send(renderLobbyPage({ user, games }));
  })
);

app.post("/lobby/login", (req, res) => {
  const { username = "", password = "" } = req.body || {};
  if (username !== config.lobbyUsername || password !== config.lobbyPassword) {
    return res.redirect("/lobby?error=invalid_credentials");
  }

  setLobbySession(res, username);
  res.redirect("/lobby");
});

app.post("/lobby/logout", (req, res) => {
  clearLobbySession(res);
  res.redirect("/lobby");
});

app.get(
  "/lobby/play/:gameId",
  requireLobbyAuth,
  asyncHandler(async (req, res) => {
    const gameId = Number(req.params.gameId);
    if (!Number.isFinite(gameId)) {
      return res.status(400).type("html").send("Invalid game ID");
    }

    const [games] = await Promise.all([loadGameCatalog(), ensureDemoUser()]);
    const game = games.find((item) => item.gameId === gameId);
    if (!game) {
      return res.status(404).type("html").send("Game not found");
    }

    const user = await ensureDemoUser();

    await postTo2J("/open2j/c/create", {
      op_id: user.op_id,
      user_info: {
        nickname: user.nickname,
        gender: user.gender,
        cnt: user.cnt,
        lan: user.lan,
      },
    });

    const response = await postTo2J("/open2j/c/launch", {
      op_id: user.op_id,
      game_id: game.gameId,
      lang: "en-US",
      backlink: `${getPublicBaseUrl(req)}/lobby`,
      device_type: 1,
      ret_lobby_btn: true,
      auto_create_account: false,
    });

    if (!response?.url) {
      throw new Error("2J launch response did not include a URL");
    }

    res.redirect(response.url);
  })
);

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
    ui: {
      lobby: "/lobby",
    },
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
  await ensureDemoUser();

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
