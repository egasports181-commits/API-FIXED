function readEnv(name) {
  try {
    return typeof process !== "undefined" ? process.env?.[name] : undefined;
  } catch {
    return undefined;
  }
}

function envPositiveInt(name, fallback) {
  const raw = readEnv(name);
  if (raw === undefined || raw === "") return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

export function getDefaultTimeoutMs() {
  return envPositiveInt("HTTP_TIMEOUT_MS", 12_000);
}

export function getDefaultProviderTimeoutMs() {
  return envPositiveInt("PROVIDER_TIMEOUT_MS", 25_000);
}

export const DEFAULT_TIMEOUT_MS = getDefaultTimeoutMs();
export const DEFAULT_PROVIDER_TIMEOUT_MS = getDefaultProviderTimeoutMs();
export const RETRYABLE_STATUSES = new Set([408, 429, 502, 503, 504]);

const MAX_RETRIES = 3;

export function getCorsOrigin() {
  const configured = String(readEnv("CORS_ORIGIN") ?? "").trim();
  return configured || "*";
}

export function corsHeaders(methods = "GET, OPTIONS") {
  return {
    "Access-Control-Allow-Origin": getCorsOrigin(),
    "Access-Control-Allow-Methods": methods,
    "Access-Control-Allow-Headers": "*",
  };
}

export function optionsResponse(methods = "GET, OPTIONS") {
  return new Response(null, {
    status: 204,
    headers: corsHeaders(methods),
  });
}

export function jsonResponse(data, status = 200, { cacheControl } = {}) {
  const resolvedCacheControl = cacheControl ?? (status >= 400 ? "no-store" : "public, max-age=300");
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Access-Control-Allow-Origin": getCorsOrigin(),
      "Cache-Control": resolvedCacheControl,
    },
  });
}

export function watchJson(data, status = 200) {
  return jsonResponse(data, status, { cacheControl: "no-store" });
}

export function isPositiveIntId(value) {
  return /^[1-9]\d{0,11}$/.test(String(value ?? ""));
}

export function sanitizeErrorMessage(err, fallback = "Upstream provider request failed") {
  const raw = typeof err === "string" ? err : err?.message;
  if (!raw || typeof raw !== "string") return fallback;
  const collapsed = raw.replace(/\s+/g, " ").trim();
  if (!collapsed) return fallback;
  // Strip any accidental HTML bodies or overly verbose dumps from public errors
  const withoutHtml = collapsed.replace(/<[^>]{1,200}>/g, " ").replace(/\s+/g, " ").trim();
  if (!withoutHtml) return fallback;
  return withoutHtml.length > 260 ? `${withoutHtml.slice(0, 257)}...` : withoutHtml;
}

export function inferErrorStatus(err, defaultStatus = 500) {
  if (Number.isInteger(err?.httpStatus) && err.httpStatus >= 400 && err.httpStatus <= 599) {
    return err.httpStatus;
  }
  if (err?.isTimeout || err?.code === "ETIMEDOUT" || err?.name === "TimeoutError") {
    return 504;
  }
  if (err?.code === "NEED_CAPTCHA") {
    return 403;
  }
  const msg = String(err?.message ?? "").toLowerCase();
  if (
    err?.status === 404 ||
    /\bnot found\b|\bno (?:sub|dub|\w+ )?(?:sources?|servers?|episodes?|streams?) (?:found|for)\b|\bonly provides subtitled\b|\bis unavailable\b|\bno english dub\b|\bno match\b|\bmatch not (?:found|confident)\b|\bno confirmed .* match\b|\bno confident .* match\b|\bno confident .* candidates\b|\bno usable search queries\b|\bno search results\b|\bcould not confidently map\b|\bno mal id found\b/.test(msg)
  ) {
    return 404;
  }
  if (err?.status === 400 || /\binvalid\b.*\b(?:id|episode|audio)\b/.test(msg)) {
    return 400;
  }
  if (err?.upstreamStatus >= 500 || err?.reason === "unreachable") {
    return 502;
  }
  if (Number.isInteger(err?.status) && err.status >= 400 && err.status <= 599) {
    // Map upstream auth/rate-limit errors to 502 so clients know the upstream provider failed
    if (err.status === 401 || err.status === 403 || err.status === 429) return 502;
    return err.status;
  }
  return defaultStatus;
}

export function errorResponse(err, { provider, fallbackMessage, defaultStatus = 500, status, extra = {} } = {}) {
  const tag = provider ? `[${provider}]` : "[api]";
  console.error(tag, err?.message ?? String(err));
  const resolvedStatus = status ?? inferErrorStatus(err, defaultStatus);
  const message = sanitizeErrorMessage(err, fallbackMessage ?? (provider ? `${provider} request failed` : "Request failed"));
  return jsonResponse({ error: message, ...extra }, resolvedStatus, { cacheControl: "no-store" });
}

export function normalizeUrl(value, base) {
  if (typeof value !== "string") return null;
  let cleaned = value.trim().replace(/\\+\//g, "/");
  if (!cleaned) return null;
  if (cleaned.startsWith("//")) cleaned = `https:${cleaned}`;
  try {
    const parsed = base ? new URL(cleaned, base) : new URL(cleaned);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
    return parsed.href;
  } catch {
    return null;
  }
}

export function isValidHttpUrl(value) {
  return normalizeUrl(value) !== null;
}

function sleep(ms, signal) {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason ?? new Error("Aborted"));
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal.reason ?? new Error("Aborted"));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    if (typeof timer.unref === "function") timer.unref();
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function createTimeoutController(timeoutMs, parentSignal) {
  const controller = new AbortController();
  let timedOut = false;

  const onParentAbort = () => {
    controller.abort(parentSignal.reason ?? new Error("Request aborted"));
  };

  if (parentSignal) {
    if (parentSignal.aborted) {
      controller.abort(parentSignal.reason ?? new Error("Request aborted"));
    } else {
      parentSignal.addEventListener("abort", onParentAbort, { once: true });
    }
  }

  let timer = null;
  if (Number.isFinite(timeoutMs) && timeoutMs > 0) {
    timer = setTimeout(() => {
      timedOut = true;
      const err = new Error(`Request timed out after ${timeoutMs}ms`);
      err.name = "TimeoutError";
      err.code = "ETIMEDOUT";
      err.isTimeout = true;
      controller.abort(err);
    }, timeoutMs);
    if (typeof timer.unref === "function") timer.unref();
  }

  return {
    signal: controller.signal,
    didTimeout: () => timedOut,
    cleanup: () => {
      if (timer) clearTimeout(timer);
      parentSignal?.removeEventListener("abort", onParentAbort);
    },
  };
}

function retryDelayFromResponse(response, attempt, baseDelayMs) {
  const retryAfter = response?.headers?.get?.("retry-after");
  if (retryAfter) {
    const secs = Number(retryAfter);
    if (Number.isFinite(secs) && secs >= 0) {
      return Math.min(2000, Math.max(100, secs * 1000));
    }
  }
  return Math.min(2000, baseDelayMs * Math.pow(2, attempt));
}

function isRetryableNetworkError(err, parentSignal) {
  if (parentSignal?.aborted) return false;
  if (!err) return false;
  if (err.isTimeout || err.name === "TimeoutError" || err.code === "ETIMEDOUT") return true;
  if (err.name === "AbortError") return false;
  const code = err.cause?.code || err.code || "";
  if (["ECONNRESET", "ECONNREFUSED", "ETIMEDOUT", "EAI_AGAIN", "ENOTFOUND", "EPIPE", "UND_ERR_CONNECT_TIMEOUT", "UND_ERR_HEADERS_TIMEOUT", "UND_ERR_BODY_TIMEOUT", "UND_ERR_SOCKET"].includes(code)) {
    return true;
  }
  return err instanceof TypeError;
}

export async function fetchWithRetry(url, options = {}) {
  const {
    timeoutMs = getDefaultTimeoutMs(),
    retries: requestedRetries,
    retryDelayMs = 300,
    retryOnStatuses = RETRYABLE_STATUSES,
    fetchImpl,
    signal: parentSignal,
    label,
    ...init
  } = options;

  const method = String(init.method ?? "GET").toUpperCase();
  const defaultRetries = method === "GET" || method === "HEAD" ? 1 : 0;
  const retries = Math.min(MAX_RETRIES, Math.max(0, requestedRetries ?? defaultRetries));
  const doFetch = fetchImpl ?? globalThis.fetch;

  if (typeof doFetch !== "function") {
    throw new Error("Fetch API is unavailable in this runtime");
  }

  let lastError = null;
  for (let attempt = 0; attempt <= retries; attempt++) {
    const tc = createTimeoutController(timeoutMs, parentSignal);
    try {
      const response = await doFetch(url, {
        redirect: "follow",
        ...init,
        signal: tc.signal,
      });

      if (attempt < retries && retryOnStatuses.has(response.status)) {
        const delay = retryDelayFromResponse(response, attempt, retryDelayMs);
        // Drain body to release underlying socket cleanly
        await response.body?.cancel?.().catch(() => {});
        tc.cleanup();
        await sleep(delay, parentSignal);
        continue;
      }

      tc.cleanup();
      return response;
    } catch (err) {
      const timedOut = tc.didTimeout();
      tc.cleanup();
      if (timedOut) {
        const timeoutErr = new Error(`${label ? `${label}: ` : ""}Request timed out after ${timeoutMs}ms`);
        timeoutErr.name = "TimeoutError";
        timeoutErr.code = "ETIMEDOUT";
        timeoutErr.isTimeout = true;
        lastError = timeoutErr;
      } else {
        lastError = err;
      }

      if (attempt < retries && isRetryableNetworkError(lastError, parentSignal)) {
        await sleep(Math.min(2000, retryDelayMs * Math.pow(2, attempt)), parentSignal);
        continue;
      }
      throw lastError;
    }
  }

  throw lastError ?? new Error(`${label ? `${label}: ` : ""}Request failed`);
}

export function parseJsonSafe(raw, label = "Upstream") {
  try {
    return JSON.parse(raw);
  } catch {
    const err = new Error(`${label} returned invalid JSON`);
    err.code = "INVALID_JSON";
    err.upstreamStatus = 502;
    throw err;
  }
}

export async function fetchText(url, options = {}) {
  const { label = "Upstream", timeoutMs = getDefaultTimeoutMs(), ...rest } = options;
  const res = await fetchWithRetry(url, { ...rest, timeoutMs, label });
  const text = await withTimeout(res.text(), timeoutMs, `${label} response body`);
  if (!res.ok) {
    const err = new Error(`${label} HTTP ${res.status}`);
    err.status = res.status;
    err.upstreamStatus = res.status;
    err.rawBody = text.slice(0, 1000);
    throw err;
  }
  return { text, status: res.status, headers: res.headers, url: res.url || String(url) };
}

export async function fetchJson(url, options = {}) {
  const { label = "Upstream", ...rest } = options;
  const result = await fetchText(url, { ...rest, label });
  const data = parseJsonSafe(result.text, label);
  return { ...result, data };
}

export async function mapWithConcurrency(items, limit, worker) {
  const list = Array.from(items ?? []);
  if (!list.length) return [];
  const maxConcurrent = Math.max(1, Math.min(limit || 4, list.length));
  const results = new Array(list.length);
  let cursor = 0;

  async function runWorker() {
    while (true) {
      const idx = cursor++;
      if (idx >= list.length) break;
      results[idx] = await worker(list[idx], idx);
    }
  }

  await Promise.all(Array.from({ length: maxConcurrent }, () => runWorker()));
  return results;
}

export function withTimeout(promise, ms, label = "Operation") {
  if (!Number.isFinite(ms) || ms <= 0) return promise;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      const err = new Error(`${label} timed out after ${ms}ms`);
      err.name = "TimeoutError";
      err.code = "ETIMEDOUT";
      err.isTimeout = true;
      reject(err);
    }, ms);
    if (typeof timer.unref === "function") timer.unref();

    Promise.resolve(promise).then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      }
    );
  });
}
