import crypto from "node:crypto";
import { fetchWithRetry, normalizeUrl, parseJsonSafe, withTimeout } from "../core/http.js";

const DEFAULT_USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36";
const KEY = Buffer.from("6b69656d7469656e6d75613931316361", "hex");
const IV = Buffer.from("313233343536373839306f6975797472", "hex");

export function canExtractNova(url) {
  return /upn\.one/i.test(String(url));
}

export async function extractNova(embedUrl, { fetchImpl = globalThis.fetch, userAgent = DEFAULT_USER_AGENT } = {}) {
  const id = String(embedUrl).match(/upn\.one\/#([A-Za-z0-9]+)/i)?.[1];
  if (!id) throw new Error(`Cannot extract Nova id from ${embedUrl}`);
  const response = await fetchWithRetry(`https://nova.upn.one/api/v1/video?id=${encodeURIComponent(id)}&w=1920&h=1080&r=`, {
    fetchImpl,
    label: "Nova",
    timeoutMs: 10_000,
    retries: 1,
    headers: { "User-Agent": userAgent, "Referer": "https://nova.upn.one/" },
  });
  if (!response.ok) throw new Error(`Nova fetch HTTP ${response.status}`);
  const hex = (await withTimeout(response.text(), 10_000, "Nova body")).trim();
  if (!hex || hex.length % 2 !== 0 || !/^[0-9a-f]+$/i.test(hex)) {
    throw new Error("Nova returned invalid encrypted payload");
  }
  let decryptedText;
  try {
    const decipher = crypto.createDecipheriv("aes-128-cbc", KEY, IV);
    const decrypted = Buffer.concat([decipher.update(Buffer.from(hex, "hex")), decipher.final()]);
    decryptedText = decrypted.toString("utf8");
  } catch {
    throw new Error("Nova payload decryption failed");
  }
  const data = parseJsonSafe(decryptedText, "Nova");
  const url = normalizeUrl(data?.cf ?? data?.source);
  if (!url) throw new Error("Nova response missing m3u8 url");
  return [url];
}
