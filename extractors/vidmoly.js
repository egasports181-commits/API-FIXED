import { fetchWithRetry, normalizeUrl, withTimeout } from "../core/http.js";

const DEFAULT_USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36";

export function canExtractVidmoly(url) {
  return /vidmoly\.(net|biz|to)/i.test(String(url));
}

export async function extractVidmoly(embedUrl, { fetchImpl = globalThis.fetch, userAgent = DEFAULT_USER_AGENT, referer } = {}) {
  const url = normalizeUrl(String(embedUrl));
  if (!url) throw new Error(`Invalid Vidmoly embed URL: ${embedUrl}`);
  const response = await fetchWithRetry(url, {
    fetchImpl,
    label: "Vidmoly",
    timeoutMs: 10_000,
    retries: 1,
    headers: { "User-Agent": userAgent, "Referer": referer ?? "https://animenosub.to/" },
    redirect: "follow",
  });
  if (!response.ok) throw new Error(`Vidmoly fetch HTTP ${response.status}`);
  const html = await withTimeout(response.text(), 10_000, "Vidmoly body");
  const match = html.match(/sources:\s*\[\s*\{\s*file:\s*['"]([^'"]+\.m3u8[^'"]*)['"]/);
  const streamUrl = match ? normalizeUrl(match[1], url) : null;
  if (!streamUrl) throw new Error("Vidmoly m3u8 not found in embed HTML");
  return [streamUrl];
}
