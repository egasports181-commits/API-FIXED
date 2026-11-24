import "dotenv/config";
import http from "node:http";
import { readFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";
import worker from "./index.js";
import { closeWreqSessions } from "./core/wreq.js";
import { getCorsOrigin } from "./core/http.js";

const PORT = Number(process.env.PORT) || 4000;
const HOST = process.env.HOST || "0.0.0.0";
const BASE = process.env.BASE_PATH ?? "";
const API_VERSION = "2.3";
const MAX_BODY_BYTES = 1024 * 1024;
const __dir = dirname(fileURLToPath(import.meta.url));

const STATIC = {
  "/":          { file: "docs/landing.html", mime: "text/html" },
  "/docs":      { file: "docs/index.html",   mime: "text/html" },
  "/style.css": { file: "docs/style.css",    mime: "text/css" },
  "/logo.svg":  { file: "docs/logo.svg",     mime: "image/svg+xml" },
};

function serveStatic(req, res, entry) {
  try {
    const body = readFileSync(join(__dir, entry.file), "utf8").replaceAll("{{API_VERSION}}", API_VERSION);
    res.writeHead(200, {
      "Content-Type": entry.mime + "; charset=utf-8",
      "Cache-Control": "no-cache",
    });
    if (req.method === "HEAD") {
      res.end();
      return;
    }
    res.end(body);
  } catch {
    res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("Not found");
  }
}

async function nodeToRequest(req) {
  const protoHeader = String(req.headers["x-forwarded-proto"] ?? "").split(",")[0].trim();
  const proto = protoHeader === "https" ? "https" : "http";
  const host = req.headers["host"] ?? `localhost:${PORT}`;
  const rawUrl = req.url || "/";
  const stripped = BASE && rawUrl.startsWith(BASE) ? rawUrl.slice(BASE.length) || "/" : rawUrl;
  const url = `${proto}://${host}${stripped.startsWith("/") ? stripped : `/${stripped}`}`;

  const headers = new Headers();
  for (const [key, value] of Object.entries(req.headers)) {
    if (value === undefined) continue;
    const lower = key.toLowerCase();
    if (lower === "connection" || lower === "keep-alive" || lower === "transfer-encoding" || lower === "upgrade") {
      continue;
    }
    if (Array.isArray(value)) {
      for (const item of value) headers.append(key, item);
    } else {
      headers.set(key, String(value));
    }
  }

  const method = String(req.method || "GET").toUpperCase();
  const hasBody = method !== "GET" && method !== "HEAD" && method !== "OPTIONS";
  if (!hasBody) {
    return new Request(url, { method, headers });
  }

  const chunks = [];
  let total = 0;
  for await (const chunk of req) {
    total += chunk.length;
    if (total > MAX_BODY_BYTES) {
      const err = new Error("Payload too large");
      err.status = 413;
      throw err;
    }
    chunks.push(chunk);
  }
  const body = chunks.length ? Buffer.concat(chunks) : null;

  return new Request(url, {
    method,
    headers,
    body: body?.length ? body : undefined,
    ...(body?.length ? { duplex: "half" } : {}),
  });
}

export function createAppServer() {
  return http.createServer(async (req, res) => {
    const start = Date.now();
    const rawUrl = req.url || "/";
    const pathname = rawUrl.split("?")[0];
    const staticEntry = STATIC[pathname];

    if ((req.method === "GET" || req.method === "HEAD") && staticEntry) {
      serveStatic(req, res, staticEntry);
      return;
    }

    try {
      const request = await nodeToRequest(req);
      const response = await worker.fetch(request, { API_VERSION });

      res.statusCode = response.status;
      const setCookies = typeof response.headers.getSetCookie === "function" ? response.headers.getSetCookie() : [];
      for (const [k, v] of response.headers) {
        if (k.toLowerCase() === "set-cookie") continue;
        res.setHeader(k, v);
      }
      if (setCookies.length) res.setHeader("Set-Cookie", setCookies);

      if (req.method === "HEAD") {
        res.end();
      } else {
        const buf = await response.arrayBuffer();
        res.end(Buffer.from(buf));
      }

      console.log(`${req.method} ${rawUrl} -> ${response.status} (${Date.now() - start}ms)`);
    } catch (err) {
      console.error(`Unhandled error on ${req.method} ${rawUrl}:`, err);
      if (res.headersSent) {
        res.end();
        return;
      }
      const status = err?.status === 413 ? 413 : 500;
      const message = status === 413 ? "Request body too large" : "Internal server error";
      res.writeHead(status, {
        "Content-Type": "application/json; charset=utf-8",
        "Access-Control-Allow-Origin": getCorsOrigin(),
        "Cache-Control": "no-store",
      });
      res.end(JSON.stringify({ error: message }));
    }
  });
}

const isEntryPoint = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isEntryPoint) {
  const server = createAppServer();

  server.listen(PORT, HOST, () => {
    console.log(`Anivexa API v${API_VERSION} listening on http://${HOST}:${PORT}`);
  });

  let shuttingDown = false;
  const shutdown = (signal) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`Received ${signal}, shutting down gracefully...`);
    const forceTimer = setTimeout(() => {
      console.error("Forced shutdown after timeout");
      process.exit(1);
    }, 10_000);
    if (typeof forceTimer.unref === "function") forceTimer.unref();

    server.close(async () => {
      await closeWreqSessions().catch(() => {});
      clearTimeout(forceTimer);
      process.exit(0);
    });
  };

  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("unhandledRejection", (reason) => {
    console.error("Unhandled promise rejection:", reason);
  });
}
