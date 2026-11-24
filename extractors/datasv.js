import { fetchWithRetry, normalizeUrl, parseJsonSafe, withTimeout } from "../core/http.js";

const DEFAULT_USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36";

export function canExtractDataSv(url) {
  return /play\.echovideo\.ru\/embed-20\//i.test(String(url));
}

export async function extractDataSv(embedUrl, { fetchImpl = globalThis.fetch, userAgent = DEFAULT_USER_AGENT } = {}) {
  const url = new URL(String(embedUrl));
  const id = url.pathname.match(/^\/embed-20\/([^/]+)$/i)?.[1];
  if (!id) throw new Error(`Cannot extract DATASV id from ${embedUrl}`);
  const endpoint = new URL("/embed-20/getSources", url.origin);
  endpoint.searchParams.set("id", id);
  const response = await fetchWithRetry(endpoint, {
    fetchImpl,
    label: "DATASV",
    timeoutMs: 10_000,
    retries: 1,
    headers: {
      "User-Agent": userAgent,
      "Referer": embedUrl,
      "X-Requested-With": "XMLHttpRequest",
    },
  });
  if (!response.ok) throw new Error(`DATASV sources HTTP ${response.status}`);
  const raw = await withTimeout(response.text(), 10_000, "DATASV body");
  const data = parseJsonSafe(raw, "DATASV");
  const sources = [];
  for (const [quality, urls] of Object.entries(data?.sources ?? {})) {
    for (const source of Array.isArray(urls) ? urls : [urls]) {
      const validUrl = normalizeUrl(source, url.origin);
      if (validUrl) sources.push({ url: validUrl, type: "mp4", quality });
    }
  }
  const available = await Promise.all(sources.map(async (source) => {
    try {
      const check = await fetchWithRetry(source.url, {
        fetchImpl,
        method: "HEAD",
        timeoutMs: 6_000,
        retries: 0,
        headers: { "User-Agent": userAgent, "Referer": `${url.origin}/` },
      });
      return check.ok ? source : null;
    } catch {
      return null;
    }
  }));
  const valid = available.filter(Boolean);
  if (!valid.length) throw new Error("DATASV response has no available sources");
  return valid;
}
