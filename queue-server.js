"use strict";

const fs = require("fs");
const http = require("http");
const https = require("https");
const os = require("os");
const path = require("path");
const crypto = require("crypto");

const HOST = process.env.QUEUE_HOST || "0.0.0.0";
const PORT = Number(process.env.PORT || process.env.QUEUE_PORT || 8787);
const HTTPS_PORT = Number(process.env.QUEUE_HTTPS_PORT || 0);
const TLS_KEY = process.env.QUEUE_TLS_KEY || path.join(__dirname, "certs", "queue-key.pem");
const TLS_CERT = process.env.QUEUE_TLS_CERT || path.join(__dirname, "certs", "queue-cert.pem");
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
      const filePath = path.join(PUBLIC_DIR, path.basename(url.pathname));
      serveStatic(res, filePath, contentType(filePath));
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/health") {
      sendJson(res, 200, {
        ok: true,
        service: "konami-entry-queue",
        time: new Date().toISOString()
      });
      return;
    }

    const scanMatch = url.pathname.match(/^\/api\/tournaments\/([^/]+)\/scans$/);
    if (scanMatch && req.method === "POST") {
      const body = await readJson(req);
      if (!hasScanAccess(body, url)) {
        sendJson(res, 403, { ok: false, error: "Invalid scan token." });
        return;
      }

      const tournamentNo = decodeURIComponent(scanMatch[1]);
      const cardGameId = normalizeId(body.cardGameId);
      const scannerName = cleanText(body.scannerName || body.deviceName || "phone", 40);

      if (!/^\d{10}$/.test(cardGameId)) {
        sendJson(res, 400, { ok: false, error: "Card Game ID must be 10 digits." });
        return;
      }

      const entry = addScan(tournamentNo, cardGameId, scannerName);
      saveStore();
      sendJson(res, 200, { ok: true, entry });
      return;
    }

    const queueMatch = url.pathname.match(/^\/api\/tournaments\/([^/]+)\/queue$/);
    if (queueMatch && req.method === "GET") {
      if (!hasAdminAccess(req, url)) {
        sendJson(res, 403, { ok: false, error: "Invalid admin token." });
        return;
      }

      const tournamentNo = decodeURIComponent(queueMatch[1]);
      sendJson(res, 200, {
        ok: true,
        tournamentNo,
        entries: getTournament(tournamentNo).entries,
        nextQueueNo: formatQueueNo(getTournament(tournamentNo).nextNumber),
        updatedAt: new Date().toISOString()
      });
      return;
    }

    const entryMatch = url.pathname.match(/^\/api\/tournaments\/([^/]+)\/queue\/([^/]+)$/);
    if (entryMatch && req.method === "PATCH") {
      if (!hasAdminAccess(req, url)) {
        sendJson(res, 403, { ok: false, error: "Invalid admin token." });
        return;
      }

      const tournamentNo = decodeURIComponent(entryMatch[1]);
      const queueNo = normalizeQueueNo(decodeURIComponent(entryMatch[2]));
      const body = await readJson(req);
      const result = updateQueueEntry(tournamentNo, queueNo, body);

      if (!result) {
        sendJson(res, 404, { ok: false, error: "Queue number not found." });
        return;
      }

      saveStore();
      sendJson(res, 200, { ok: true, entry: result });
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
  console.log("KONAMI entry queue bridge is running.");
  console.log(`Admin token: ${tokens.adminToken}`);
  console.log(`Scan token:  ${tokens.scanToken}`);
  console.log("");
  console.log("Counter URLs:");
  urls.forEach((url) => {
    console.log(`  ${counterUrl(url, "E26-063505")}`);
  });
  console.log("");
  console.log("Phone scanner URLs:");
  urls.forEach((url) => {
    console.log(`  ${scannerUrl(url, "E26-063505")}`);
  });
  console.log("");
  console.log(`Queue file: ${STORE_FILE}`);
  console.log("");
});

if (HTTPS_PORT && fs.existsSync(TLS_KEY) && fs.existsSync(TLS_CERT)) {
  https.createServer({
    key: fs.readFileSync(TLS_KEY),
    cert: fs.readFileSync(TLS_CERT)
  }, requestHandler).listen(HTTPS_PORT, HOST, () => {
    console.log(`HTTPS scanner server: https://127.0.0.1:${HTTPS_PORT}`);
    console.log(`Phone HTTPS scanner path: /scanner?tournament=E26-063505&scanToken=${tokens.scanToken}`);
    console.log("");
  });
} else if (HTTPS_PORT) {
  console.log(`HTTPS requested, but certificate files were not found: ${TLS_KEY} and ${TLS_CERT}`);
}

function addScan(tournamentNo, cardGameId, scannerName) {
  const tournament = getTournament(tournamentNo);
  const existing = tournament.entries.find((entry) => {
    return entry.cardGameId === cardGameId && entry.status !== "void";
  });

  if (existing) {
    existing.lastSeenAt = new Date().toISOString();
    existing.lastScannerName = scannerName;
    return { ...existing, duplicate: true };
  }

  const now = new Date().toISOString();
  const entry = {
    queueNo: formatQueueNo(tournament.nextNumber),
    cardGameId,
    status: "waiting",
    scannerName,
    scannedAt: now,
    updatedAt: now
  };

  tournament.nextNumber += 1;
  tournament.entries.push(entry);
  return entry;
}

function updateQueueEntry(tournamentNo, queueNo, body) {
  const tournament = getTournament(tournamentNo);
  const entry = tournament.entries.find((item) => item.queueNo === queueNo);
  if (!entry) return null;

  const status = String(body.status || "").trim();
  const allowedStatuses = new Set(["waiting", "called", "paid_submitted", "void"]);

  if (allowedStatuses.has(status)) {
    entry.status = status;
  }

  if (body.note) {
    entry.note = cleanText(body.note, 200);
  }

  const now = new Date().toISOString();
  entry.updatedAt = now;

  if (status === "called" && !entry.calledAt) entry.calledAt = now;
  if (status === "paid_submitted" && !entry.paidSubmittedAt) entry.paidSubmittedAt = now;
  if (status === "void" && !entry.voidedAt) entry.voidedAt = now;

  return entry;
}

function getTournament(tournamentNo) {
  if (!store.tournaments[tournamentNo]) {
    store.tournaments[tournamentNo] = {
      nextNumber: 1,
      entries: []
    };
  }

  return store.tournaments[tournamentNo];
}

function loadStore() {
  if (!fs.existsSync(STORE_FILE)) {
    return { version: 1, tournaments: {} };
  }

  try {
    const parsed = JSON.parse(fs.readFileSync(STORE_FILE, "utf8"));
    return {
      version: 1,
      tournaments: parsed && parsed.tournaments ? parsed.tournaments : {}
    };
  } catch (error) {
    const backup = `${STORE_FILE}.broken-${Date.now()}`;
    fs.copyFileSync(STORE_FILE, backup);
    return { version: 1, tournaments: {} };
  }
}

function saveStore() {
  const tmp = `${STORE_FILE}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(store, null, 2));
  fs.renameSync(tmp, STORE_FILE);
}

function loadTokens() {
  const envTokens = {
    scanToken: process.env.SCAN_TOKEN || process.env.QUEUE_SCAN_TOKEN || "",
    adminToken: process.env.ADMIN_TOKEN || process.env.QUEUE_ADMIN_TOKEN || ""
  };

  if (envTokens.scanToken && envTokens.adminToken) return envTokens;

  if (fs.existsSync(TOKEN_FILE)) {
    try {
      const parsed = JSON.parse(fs.readFileSync(TOKEN_FILE, "utf8"));
      if (parsed.scanToken && parsed.adminToken) return parsed;
    } catch (error) {
      // Fall through and generate a clean token file.
    }
  }

  const generated = {
    scanToken: crypto.randomBytes(9).toString("hex"),
    adminToken: crypto.randomBytes(16).toString("hex")
  };
  fs.writeFileSync(TOKEN_FILE, JSON.stringify(generated, null, 2));
  return generated;
}

function hasScanAccess(body, url) {
  const token = String((body && body.scanToken) || url.searchParams.get("scanToken") || "");
  return token && token === tokens.scanToken;
}

function hasAdminAccess(req, url) {
  const token = String(req.headers["x-admin-token"] || url.searchParams.get("adminToken") || "");
  return token && token === tokens.adminToken;
}

function normalizeId(value) {
  return String(value || "")
    .replace(/[０-９]/g, (digit) => String.fromCharCode(digit.charCodeAt(0) - 65248))
    .replace(/\D/g, "");
}

function normalizeQueueNo(value) {
  const digits = normalizeId(value);
  if (!digits) return "";
  return formatQueueNo(Number(digits));
}

function formatQueueNo(number) {
  return String(number).padStart(3, "0");
}

function cleanText(value, maxLength) {
  return String(value || "").replace(/[^\w .:@-]/g, "").slice(0, maxLength);
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
      if (body.length > 1024 * 1024) {
        req.destroy();
        reject(new Error("Request body too large."));
      }
    });
    req.on("end", () => {
      if (!body) {
        resolve({});
        return;
      }

      try {
        resolve(JSON.parse(body));
      } catch (error) {
        reject(new Error("Invalid JSON body."));
      }
    });
    req.on("error", reject);
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

function counterUrl(baseUrl, tournamentNo) {
  return `${baseUrl}/counter?tournament=${encodeURIComponent(tournamentNo)}&adminToken=${encodeURIComponent(tokens.adminToken)}`;
}

function scannerUrl(baseUrl, tournamentNo) {
  return `${baseUrl}/scanner?tournament=${encodeURIComponent(tournamentNo)}&scanToken=${encodeURIComponent(tokens.scanToken)}`;
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
    nets[name].forEach((net) => {
      if (net.family === "IPv4" && !net.internal) {
        urls.push(`http://${net.address}:${port}`);
      }
    });
  });

  return urls;
}
