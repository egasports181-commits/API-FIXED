import worker from "../index.js";
import { getCorsOrigin } from "../core/http.js";

export default async function handler(req, res) {
  try {
    const host = req.headers["host"] ?? "localhost";
    const url = `https://${host}${req.url || "/"}`;

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
    let body = null;
    if (hasBody) {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      body = chunks.length ? Buffer.concat(chunks) : null;
    }

    const request = new Request(url, {
      method,
      headers,
      ...(body?.length ? { body, duplex: "half" } : {}),
    });

    const response = await worker.fetch(request, {});

    res.statusCode = response.status;
    for (const [k, v] of response.headers) res.setHeader(k, v);

    if (method === "HEAD") {
      res.end();
      return;
    }
    const buf = await response.arrayBuffer();
    res.end(Buffer.from(buf));
  } catch (err) {
    console.error("Unhandled serverless handler error:", err);
    if (!res.headersSent) {
      res.statusCode = 500;
      res.setHeader("Content-Type", "application/json; charset=utf-8");
      res.setHeader("Access-Control-Allow-Origin", getCorsOrigin());
      res.setHeader("Cache-Control", "no-store");
      res.end(JSON.stringify({ error: "Internal server error" }));
    } else {
      res.end();
    }
  }
}
