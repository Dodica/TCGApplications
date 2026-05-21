"use strict";

const fs = require("fs");
const http = require("http");
const os = require("os");
const path = require("path");
const crypto = require("crypto");

const DEFAULT_PORT = 8787;
const STORE_VERSION = 2;
const MAX_JSON_BYTES = 1024 * 1024;
const CARD_GAME_ID_RE = /^\d{10}$/;
const ALLOWED_STATUSES = new Set(["waiting", "done"]);
const PUBLIC_FILES = new Set(["quagga.min.js"]);

const HOST = process.env.QUEUE_HOST || "0.0.0.0";
const PORT = positiveInteger(process.env.PORT || process.env.QUEUE_PORT, DEFAULT_PORT);
const DATA_DIR = process.env.QUEUE_DATA_DIR ? path.resolve(process.env.QUEUE_DATA_DIR) : path.join(__dirname, "queue-data");
const PUBLIC_DIR = path.join(__dirname, "public");
const STORE_FILE = path.join(DATA_DIR, "queue.json");
const TOKEN_FILE = path.join(DATA_DIR, "tokens.json");

ensureDir(DATA_DIR);

const tokens = loadTokens();
let store = loadStore();

const requestHandler = async (req, res) => {
  try {
    setCorsHeaders(res);

    if (req.method === "OPTIONS") {
      sendJson(res, 204, null);
      return;
    }

    const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);

    if (req.method === "GET" && (url.pathname === "/" || url.pathname === "/scanner")) {
      serveStatic(res, path.join(PUBLIC_DIR, "scanner.html"), "text/html; charset=utf-8");
      return;
    }

    if (req.method === "GET" && url.pathname === "/counter") {
      serveStatic(res, path.join(PUBLIC_DIR, "counter.html"), "text/html; charset=utf-8");
      return;
    }

    if (req.method === "GET" && url.pathname.startsWith("/public/")) {
      const fileName = path.basename(url.pathname);
      if (PUBLIC_FILES.has(fileName)) {
        serveStatic(res, path.join(PUBLIC_DIR, fileName), contentType(fileName));
        return;
      }

      sendJson(res, 404, { ok: false, error: "File not found." });
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/health") {
      sendJson(res, 200, {
        ok: true,
        service: "entry-queue",
        time: new Date().toISOString()
      });
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/scans") {
      const body = await readJson(req);
      if (!hasScanAccess(body, url)) {
        sendJson(res, 403, { ok: false, error: "Invalid scan token." });
        return;
      }

      const id = normalizeId(body.id);
      const scannerName = cleanText(body.scannerName || body.deviceName || "phone", 40) || "phone";

      if (!isCardGameId(id)) {
        sendJson(res, 400, { ok: false, error: "ID must be exactly 10 digits." });
        return;
      }

      const entry = addScan(id, scannerName);
      saveStore();
      sendJson(res, 200, {
        ok: true,
        duplicate: Boolean(entry.duplicate),
        entry
      });
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/queue") {
      if (!hasAdminAccess(req, url)) {
        sendJson(res, 403, { ok: false, error: "Invalid admin token." });
        return;
      }

      sendJson(res, 200, {
        ok: true,
        entries: store.entries,
        nextQueueNo: formatQueueNo(store.nextNumber),
        updatedAt: new Date().toISOString()
      });
      return;
    }

    const entryMatch = url.pathname.match(/^\/api\/queue\/([^/]+)$/);
    if (entryMatch && req.method === "PATCH") {
      if (!hasAdminAccess(req, url)) {
        sendJson(res, 403, { ok: false, error: "Invalid admin token." });
        return;
      }

      const queueNo = normalizeQueueNo(decodePathComponent(entryMatch[1]));
      const body = await readJson(req);
      const result = updateQueueEntry(queueNo, body);

      if (!result) {
        sendJson(res, 404, { ok: false, error: "Queue number not found." });
        return;
      }

      if (result.error) {
        sendJson(res, 400, { ok: false, error: result.error });
        return;
      }

      saveStore();
      sendJson(res, 200, { ok: true, entry: result.entry });
      return;
    }

    sendJson(res, 404, { ok: false, error: "Not found." });
  } catch (error) {
    sendJson(res, 500, { ok: false, error: error.message || "Server error." });
  }
};

const server = http.createServer(requestHandler);

server.listen(PORT, HOST, () => {
  const urls = publicUrls(PORT);
  console.log("");
  console.log("Entry queue server is running.");
  console.log(`Admin token: ${tokens.adminToken}`);
  console.log(`Scan token:  ${tokens.scanToken}`);
  console.log("");
  console.log("Counter URLs:");
  urls.forEach((url) => {
    console.log(`  ${counterUrl(url)}`);
  });
  console.log("");
  console.log("Phone scanner URLs:");
  urls.forEach((url) => {
    console.log(`  ${scannerUrl(url)}`);
  });
  console.log("");
  console.log(`Queue file: ${STORE_FILE}`);
  console.log("");
});

function addScan(id, scannerName) {
  const existing = store.entries.find((entry) => entry.id === id);
  const now = new Date().toISOString();

  if (existing) {
    existing.updatedAt = now;
    return { ...existing, duplicate: true };
  }

  const entry = {
    queueNo: formatQueueNo(store.nextNumber),
    id,
    status: "waiting",
    scannerName,
    scannedAt: now,
    updatedAt: now
  };

  store.nextNumber += 1;
  store.entries.push(entry);
  return entry;
}

function updateQueueEntry(queueNo, body) {
  const entry = store.entries.find((item) => item.queueNo === queueNo);
  if (!entry) return null;

  const status = String(body.status || "").trim();
  if (!status) return { error: "Status is required." };

  if (!ALLOWED_STATUSES.has(status)) {
    return { error: "Status must be waiting or done." };
  }

  const now = new Date().toISOString();
  entry.status = status;
  entry.updatedAt = now;

  if (status === "done" && !entry.doneAt) entry.doneAt = now;
  if (status === "waiting") entry.doneAt = "";

  return { entry };
}

function loadStore() {
  if (!fs.existsSync(STORE_FILE)) {
    return defaultStore();
  }

  try {
    const parsed = JSON.parse(fs.readFileSync(STORE_FILE, "utf8"));
    return normalizeStore(parsed);
  } catch (error) {
    const backup = `${STORE_FILE}.broken-${Date.now()}`;
    fs.copyFileSync(STORE_FILE, backup);
    return defaultStore();
  }
}

function normalizeStore(parsed) {
  if (parsed && Array.isArray(parsed.entries)) {
    const entries = parsed.entries.map(normalizeEntry).filter(Boolean);
    return {
      version: STORE_VERSION,
      nextNumber: Math.max(positiveInteger(parsed.nextNumber, 1), nextNumberAfter(entries)),
      entries
    };
  }

  return defaultStore();
}

function normalizeEntry(entry) {
  if (!entry) return null;

  const queueNo = normalizeQueueNo(entry.queueNo);
  const id = normalizeId(entry.id);
  if (!queueNo || !isCardGameId(id)) return null;

  const rawStatus = String(entry.status || "waiting").trim();
  const status = ALLOWED_STATUSES.has(rawStatus) ? rawStatus : "waiting";
  return {
    queueNo,
    id,
    status,
    scannerName: cleanText(entry.scannerName || "", 40),
    scannedAt: entry.scannedAt || entry.createdAt || "",
    doneAt: status === "done" ? entry.doneAt || "" : "",
    updatedAt: entry.updatedAt || entry.scannedAt || entry.createdAt || ""
  };
}

function defaultStore() {
  return { version: STORE_VERSION, nextNumber: 1, entries: [] };
}

function nextNumberAfter(entries) {
  return entries.reduce((max, entry) => {
    return Math.max(max, Number(entry.queueNo || 0) + 1);
  }, 1);
}

function saveStore() {
  const tmp = `${STORE_FILE}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(store, null, 2));
  fs.renameSync(tmp, STORE_FILE);
}

function loadTokens() {
  const envTokens = {
    scanToken: cleanToken(process.env.SCAN_TOKEN || process.env.QUEUE_SCAN_TOKEN),
    adminToken: cleanToken(process.env.ADMIN_TOKEN || process.env.QUEUE_ADMIN_TOKEN)
  };

  if (envTokens.scanToken && envTokens.adminToken) return envTokens;

  const fileTokens = readTokenFile();
  const resolved = {
    scanToken: envTokens.scanToken || fileTokens.scanToken || randomToken(9),
    adminToken: envTokens.adminToken || fileTokens.adminToken || randomToken(16)
  };

  if (resolved.scanToken !== fileTokens.scanToken || resolved.adminToken !== fileTokens.adminToken) {
    writeTokenFile(resolved);
  }

  return resolved;
}

function readTokenFile() {
  if (fs.existsSync(TOKEN_FILE)) {
    try {
      const parsed = JSON.parse(fs.readFileSync(TOKEN_FILE, "utf8"));
      return {
        scanToken: cleanToken(parsed.scanToken),
        adminToken: cleanToken(parsed.adminToken)
      };
    } catch (error) {
      return { scanToken: "", adminToken: "" };
    }
  }

  return { scanToken: "", adminToken: "" };
}

function writeTokenFile(value) {
  fs.writeFileSync(TOKEN_FILE, JSON.stringify(value, null, 2));
}

function hasScanAccess(body, url) {
  const token = cleanToken((body && body.scanToken) || url.searchParams.get("scanToken"));
  return token && token === tokens.scanToken;
}

function hasAdminAccess(req, url) {
  const token = cleanToken(req.headers["x-admin-token"] || url.searchParams.get("adminToken"));
  return token && token === tokens.adminToken;
}

function normalizeId(value) {
  return String(value || "")
    .replace(/\D/g, "");
}

function isCardGameId(value) {
  return CARD_GAME_ID_RE.test(value);
}

function normalizeQueueNo(value) {
  const digits = normalizeId(value);
  if (!digits) return "";

  const number = positiveInteger(digits, 0);
  if (!number) return "";
  return formatQueueNo(number);
}

function decodePathComponent(value) {
  try {
    return decodeURIComponent(value);
  } catch (error) {
    return "";
  }
}

function formatQueueNo(number) {
  return String(number).padStart(3, "0");
}

function positiveInteger(value, fallback) {
  const number = Number(value);
  return Number.isInteger(number) && number > 0 ? number : fallback;
}

function cleanText(value, maxLength) {
  return String(value || "").replace(/[^\w .:@-]/g, "").slice(0, maxLength);
}

function cleanToken(value) {
  return String(value || "").trim();
}

function randomToken(bytes) {
  return crypto.randomBytes(bytes).toString("hex");
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    let completed = false;

    const finish = (callback, value) => {
      if (completed) return;
      completed = true;
      callback(value);
    };

    req.on("data", (chunk) => {
      body += chunk;
      if (body.length > MAX_JSON_BYTES) {
        req.destroy();
        finish(reject, new Error("Request body too large."));
      }
    });
    req.on("end", () => {
      if (!body) {
        finish(resolve, {});
        return;
      }

      try {
        finish(resolve, JSON.parse(body));
      } catch (error) {
        finish(reject, new Error("Invalid JSON body."));
      }
    });
    req.on("error", (error) => {
      finish(reject, error);
    });
  });
}

function serveStatic(res, filePath, type) {
  if (!fs.existsSync(filePath)) {
    sendJson(res, 404, { ok: false, error: "File not found." });
    return;
  }

  res.writeHead(200, {
    "Content-Type": type,
    "Cache-Control": "no-store"
  });
  fs.createReadStream(filePath).pipe(res);
}

function contentType(filePath) {
  if (filePath.endsWith(".html")) return "text/html; charset=utf-8";
  if (filePath.endsWith(".js")) return "text/javascript; charset=utf-8";
  if (filePath.endsWith(".css")) return "text/css; charset=utf-8";
  return "application/octet-stream";
}

function sendJson(res, statusCode, payload) {
  if (statusCode === 204) {
    res.writeHead(204);
    res.end();
    return;
  }

  res.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store"
  });
  res.end(JSON.stringify(payload));
}

function setCorsHeaders(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,PATCH,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type,X-Admin-Token");
  res.setHeader("Access-Control-Max-Age", "86400");
}

function ensureDir(dir) {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

function counterUrl(baseUrl) {
  return `${baseUrl}/counter?adminToken=${encodeURIComponent(tokens.adminToken)}`;
}

function scannerUrl(baseUrl) {
  return `${baseUrl}/scanner?scanToken=${encodeURIComponent(tokens.scanToken)}`;
}

function publicUrls(port) {
  const publicBaseUrl = process.env.PUBLIC_BASE_URL || process.env.RENDER_EXTERNAL_URL || "";
  if (publicBaseUrl) return [publicBaseUrl.replace(/\/+$/, "")];
  return localUrls(port);
}

function localUrls(port) {
  const urls = [`http://127.0.0.1:${port}`];
  const nets = os.networkInterfaces();

  Object.keys(nets).forEach((name) => {
    (nets[name] || []).forEach((net) => {
      if (net.family === "IPv4" && !net.internal) {
        urls.push(`http://${net.address}:${port}`);
      }
    });
  });

  return urls;
}
