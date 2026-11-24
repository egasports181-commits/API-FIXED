import { webcrypto as crypto } from "node:crypto";
import { fetchWithRetry, normalizeUrl, parseJsonSafe, withTimeout } from "../core/http.js";

const DEFAULT_USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36";
const BLOCKS = 512;
const MASK = BLOCKS - 1;
const ROUNDS = 2;
const MUL_A = 2654435761;
const MUL_B = 2246822519;

function b64u(value) {
  return Buffer.from(value).toString("base64url");
}

function b64uDec(value) {
  return Buffer.from(value, "base64url");
}

function rot(value, shift) {
  return (value << shift | value >>> 32 - shift) >>> 0;
}

function mul(value, factor) {
  return Math.imul(value, factor) >>> 0;
}

function mix(state) {
  state[0] = state[0] + state[1] >>> 0;
  state[3] = rot(state[3] ^ state[0], 16);
  state[2] = state[2] + state[3] >>> 0;
  state[1] = rot(state[1] ^ state[2], 12);
  state[0] = state[0] + state[1] >>> 0;
  state[3] = rot(state[3] ^ state[0], 8);
  state[2] = state[2] + state[3] >>> 0;
  state[1] = rot(state[1] ^ state[2], 7);
}

function hash(bytes) {
  const state = new Uint32Array([1779033703, 3144134277, 1013904242, 2773480762]);
  for (let i = 0; i < bytes.length; i++) {
    state[0] = state[0] + bytes[i] >>> 0;
    state[0] = rot(state[0], 7);
    mix(state);
  }
  for (let i = 0; i < 8; i++) mix(state);
  const table = new Uint32Array(BLOCKS);
  for (let i = 0; i < BLOCKS; i++) {
    mix(state);
    table[i] = (state[0] ^ state[2]) >>> 0;
  }
  for (let i = 0; i < ROUNDS; i++) {
    for (let index = 0; index < BLOCKS; index++) {
      const tableIndex = table[index] & MASK;
      let value = table[index] + table[tableIndex] >>> 0;
      value = rot(value, 13);
      value = (value ^ mul(table[(index + 1) & MASK], MUL_A)) >>> 0;
      table[index] = value;
      state[0] = (state[0] ^ value) >>> 0;
      mix(state);
    }
  }
  const out = new Uint32Array(8);
  const width = BLOCKS / 8;
  for (let i = 0; i < 8; i++) {
    mix(state);
    let value = state[0];
    const offset = i * width;
    for (let index = 0; index < width; index++) {
      const tableValue = table[offset + index];
      value = value + tableValue >>> 0;
      value = rot(value, 5);
      value = (value ^ mul(tableValue, MUL_B)) >>> 0;
    }
    out[i] = (value ^ state[2]) >>> 0;
  }
  return out;
}

function latin1Bytes(value) {
  const out = new Uint8Array(value.length);
  for (let i = 0; i < value.length; i++) out[i] = value.charCodeAt(i) & 255;
  return out;
}

function leadingZeros(value) {
  let total = 0;
  for (let i = 0; i < value.length; i++) {
    const item = value[i];
    if (item === 0) {
      total += 32;
      continue;
    }
    return total + Math.clz32(item);
  }
  return total;
}

function solvePoW(nonce, difficulty) {
  if (!nonce || !Number.isInteger(difficulty) || difficulty < 0 || difficulty > 28) {
    throw new Error(`Invalid Byse PoW parameters (difficulty: ${difficulty})`);
  }
  const prefix = `${nonce}:`;
  for (let counter = 0; counter < 5_000_000; counter++) {
    if (leadingZeros(hash(latin1Bytes(prefix + counter))) >= difficulty) return String(counter);
  }
  throw new Error("Byse PoW exceeded safety iteration bound");
}

async function byseJson(fetchImpl, url, init, label) {
  const response = await fetchWithRetry(url, {
    fetchImpl,
    timeoutMs: 10_000,
    retries: 0,
    label: `Byse ${label}`,
    ...init,
  });
  if (!response.ok) throw new Error(`Byse ${label} HTTP ${response.status}`);
  const raw = await withTimeout(response.text(), 10_000, `Byse ${label} body`);
  return parseJsonSafe(raw, `Byse ${label}`);
}

export function canExtractByse(url) {
  return /(?:bysesayeveum\.com|gn1r5n\.org)\/e\//i.test(String(url));
}

export async function extractByse(embedUrl, { fetchImpl = globalThis.fetch, userAgent = DEFAULT_USER_AGENT, referer } = {}) {
  const code = String(embedUrl).match(/\/e\/([a-z0-9]+)/i)?.[1];
  if (!code) throw new Error(`Cannot extract Byse code from ${embedUrl}`);
  const embedOrigin = new URL(embedUrl).origin;
  const parentUrl = referer || embedUrl;
  const parentHost = new URL(parentUrl).hostname;
  const embedHeaders = {
    "X-Embed-Origin": parentHost,
    "X-Embed-Referer": parentUrl,
    "X-Embed-Parent": embedUrl,
  };
  const details = await byseJson(fetchImpl, `${embedOrigin}/api/videos/${code}/embed/details`, {
    headers: { "User-Agent": userAgent, "Referer": embedUrl, ...embedHeaders }
  }, "details");
  const frameUrl = details?.embed_frame_url || embedUrl;
  const frameBase = new URL(frameUrl).origin;
  const challenge = await byseJson(fetchImpl, `${frameBase}/api/videos/access/challenge`, {
    method: "POST",
    headers: { "Content-Length": "0", "Origin": frameBase, "Referer": frameUrl, "User-Agent": userAgent }
  }, "challenge");
  if (!challenge?.nonce || !challenge?.challenge_id) throw new Error("Byse challenge missing nonce");
  const keyPair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign"]);
  const publicKey = await crypto.subtle.exportKey("jwk", keyPair.publicKey);
  const signature = await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, keyPair.privateKey, new TextEncoder().encode(challenge.nonce));
  const attest = await byseJson(fetchImpl, `${frameBase}/api/videos/access/attest`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "Origin": frameBase, "Referer": frameUrl, "User-Agent": userAgent },
    body: JSON.stringify({ nonce: challenge.nonce, challenge_id: challenge.challenge_id, public_key: publicKey, signature: b64u(signature) })
  }, "attest");
  if (!attest?.token || !attest?.viewer_id || !attest?.device_id) throw new Error("Byse attest response incomplete");
  const cookie = `byse_viewer_id=${attest.viewer_id}; byse_device_id=${attest.device_id}`;
  const fingerprint = { token: attest.token, viewer_id: attest.viewer_id, device_id: attest.device_id, confidence: attest.confidence };
  const captcha = await byseJson(fetchImpl, `${frameBase}/api/videos/${code}/embed/captcha`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "Origin": frameBase, "Referer": frameUrl, "User-Agent": userAgent, "Cookie": cookie, ...embedHeaders },
    body: JSON.stringify({ fingerprint })
  }, "captcha");
  const verification = await byseJson(fetchImpl, `${frameBase}/api/videos/${code}/embed/captcha/verify`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "Origin": frameBase, "Referer": frameUrl, "User-Agent": userAgent, "Cookie": cookie, ...embedHeaders },
    body: JSON.stringify({ pow_token: captcha?.pow_token, solution: solvePoW(captcha?.pow_nonce, captcha?.pow_difficulty), fingerprint })
  }, "verify");
  if (!verification?.token) throw new Error("Byse verification missing token");
  const playbackData = await byseJson(fetchImpl, `${frameBase}/api/videos/${code}/embed/playback`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "Origin": frameBase, "Referer": frameUrl, "User-Agent": userAgent, "Cookie": cookie, "X-Captcha-Token": verification.token, ...embedHeaders },
    body: JSON.stringify({ fingerprint })
  }, "playback");
  const playback = playbackData?.playback;
  if (!playback || !Array.isArray(playback.key_parts) || !playback.iv || !playback.payload) {
    throw new Error("Byse playback payload incomplete");
  }
  const keyBytes = Buffer.concat(playback.key_parts.filter((item) => typeof item === "string" && b64uDec(item).length === 16).map(b64uDec));
  if (!keyBytes.length) throw new Error("Byse playback key missing");
  const aesKey = await crypto.subtle.importKey("raw", keyBytes, { name: "AES-GCM" }, false, ["decrypt"]);
  const decrypted = await crypto.subtle.decrypt({ name: "AES-GCM", iv: b64uDec(playback.iv) }, aesKey, b64uDec(playback.payload));
  const parsed = parseJsonSafe(new TextDecoder().decode(decrypted), "Byse playback");
  const urls = (Array.isArray(parsed?.sources) ? parsed.sources : [])
    .map((item) => normalizeUrl(item?.url))
    .filter(Boolean);
  if (!urls.length) throw new Error("Byse playback contained no valid sources");
  return urls;
}
