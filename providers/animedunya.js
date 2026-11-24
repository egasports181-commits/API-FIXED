import { episodeMeta } from "../core/new-provider-utils.js";
import { getMedia } from "../core/anilist.js";
import { get as cacheGet, set as cacheSet, isFresh, SHOW_IDENTITY_TTL } from "../core/smartcache.js";
import {
  errorResponse,
  fetchWithRetry,
  getDefaultTimeoutMs,
  normalizeUrl,
  optionsResponse,
  watchJson,
  withTimeout,
} from "../core/http.js";
import { wreqFetch } from "../core/wreq.js";

const BASE = "https://anime-dunya.com";
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";
const BLOCK_STATUSES = new Set([403, 429, 503]);

async function resolveMalId(anilistId, ctx = {}) {
  if (ctx.media?.idMal) return ctx.media.idMal;

  const cacheKey = `np:animedunya:${anilistId}`;
  const cached = cacheGet(cacheKey);
  if (isFresh(cached)) return cached.data;

  const media = ctx.media ?? await getMedia(anilistId);
  if (!media?.idMal) {
    const err = new Error(`AnimeDunya: no MAL ID found for AniList ${anilistId}`);
    err.httpStatus = 404;
    throw err;
  }

  cacheSet(cacheKey, media.idMal, SHOW_IDENTITY_TTL);
  return media.idMal;
}

async function fetchHtml(url) {
  const headers = {
    "User-Agent": UA,
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8",
    "Accept-Language": "en-US,en;q=0.9",
    "Referer": `${BASE}/`,
  };

  const timeoutMs = getDefaultTimeoutMs();
  let res = null;
  let lastError = null;
  try {
    res = await fetchWithRetry(url, {
      label: "AnimeDunya",
      timeoutMs,
      retries: 1,
      redirect: "follow",
      headers,
    });
  } catch (err) {
    lastError = err;
  }

  // Fallback to wreq TLS impersonation only if native fetch hit bot-check status or non-timeout transport failure
  if ((!res && !lastError?.isTimeout) || (res && BLOCK_STATUSES.has(res.status))) {
    try {
      const alt = await wreqFetch(url, {
        session: "animedunya",
        headers,
        timeout: timeoutMs,
        redirect: "follow",
      });
      if (alt && (alt.ok || !res)) {
        res = alt;
        lastError = null;
      }
    } catch (err) {
      lastError = lastError || err;
    }
  }

  if (!res) {
    const err = new Error(`AnimeDunya unreachable: ${lastError?.message ?? "network error"}`);
    err.httpStatus = lastError?.isTimeout ? 504 : 502;
    throw err;
  }

  const html = await withTimeout(res.text(), 12_000, "AnimeDunya response body");
  if (!res.ok) {
    const err = new Error(`AnimeDunya HTTP ${res.status}`);
    err.status = res.status;
    err.upstreamStatus = res.status;
    if (res.status === 404) err.httpStatus = 404;
    throw err;
  }
  return html;
}

function scanBalancedJson(source, startIndex, openChar, closeChar) {
  let depth = 0;
  let started = false;
  let inString = false;
  let escaped = false;
  let result = "";

  for (let i = startIndex; i < source.length; i++) {
    const ch = source[i];

    if (started) result += ch;

    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (ch === "\\") {
        escaped = true;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }

    if (ch === '"') {
      if (started) inString = true;
      continue;
    }

    if (ch === openChar) {
      if (!started) {
        started = true;
        result = ch;
      }
      depth++;
    } else if (ch === closeChar && started) {
      depth--;
      if (depth === 0) return result;
    }
  }
  return null;
}

function unescapeEmbeddedJson(raw) {
  return raw
    .replace(/\\u0026/g, "&")
    .replace(/\\"/g, '"')
    .replace(/\\\\/g, "\\");
}

function extractEpisodesList(html) {
  const match = String(html ?? "").match(/\\?"episodes\\?":\s*\[/);
  if (!match) return [];
  const openIdx = match.index + match[0].length - 1;
  const escapedPayload = match[0].startsWith('\\"');
  const slice = escapedPayload ? unescapeEmbeddedJson(html.slice(openIdx)) : html.slice(openIdx);
  const block = scanBalancedJson(slice, 0, "[", "]");
  if (!block) return [];
  try {
    const parsed = JSON.parse(block);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    try {
      const parsed = JSON.parse(unescapeEmbeddedJson(block));
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }
}

function extractStream(html) {
  const text = String(html ?? "");
  const match = text.match(/\\?"stream\\?":\s*/);
  if (!match) return null;
  const startIdx = match.index + match[0].length;
  const escapedPayload = match[0].startsWith('\\"');
  const slice = escapedPayload ? unescapeEmbeddedJson(text.slice(startIdx)) : text.slice(startIdx);
  const block = scanBalancedJson(slice, 0, "{", "}");
  if (block) {
    try {
      return JSON.parse(block);
    } catch {
      try {
        return JSON.parse(unescapeEmbeddedJson(block));
      } catch {
        // fall through to regex fallback
      }
    }
  }
  const sourceMatch = text.match(/\\?"source\\?"\s*:\s*\\?"([^"\\]+(?:\\.[^"\\]*)*)\\?"/);
  if (sourceMatch) {
    return { source: sourceMatch[1].replace(/\\\//g, "/").replace(/\\/g, "") };
  }
  return null;
}

export async function getEpisodes(anilistId, ctx = {}) {
  const malId = await resolveMalId(anilistId, ctx);
  const html = await fetchHtml(`${BASE}/en/anime/${malId}`);
  if (!html) throw new Error("AnimeDunya: episodes fetch failed");

  let cdnBase = "https://cdn.anime-dunya.com/thumbnail/";
  let cdnExt = "small.jpg";

  const thumbMatch = html.match(/(https?:\/\/[^\s"'`<>]+?\/thumbnail\/)([a-zA-Z0-9]+?)\/((?:small|large)\.jpg)/);
  if (thumbMatch) {
    cdnBase = thumbMatch[1];
    cdnExt = thumbMatch[3];
  }

  const episodes = extractEpisodesList(html);
  const watchable = episodes.filter((ep) => ep && ep.streamId !== null && ep.streamId !== undefined);
  const sub = [];

  for (const ep of watchable) {
    const epNum = Number(ep.episodeNumber);
    if (!Number.isFinite(epNum) || epNum < 1) continue;
    const meta = episodeMeta(epNum, ctx);
    const customTitle = Array.isArray(ep.translations)
      ? ep.translations.find((t) => t?.language === "en")?.title
      : ep.translations?.title;
    sub.push({
      id: `watch/animedunya/${anilistId}/sub/animedunya-${epNum}`,
      number: epNum,
      title: customTitle || meta.title || `Episode ${epNum}`,
      duration: meta.duration,
      audio: "sub",
      filler: Boolean(ep.filler || meta.filler),
      uncensored: false,
      description: meta.description,
      image: ep.streamId ? `${cdnBase}${ep.streamId}/${cdnExt}` : meta.image,
      airDate: meta.airDate,
    });
  }

  sub.sort((a, b) => a.number - b.number);

  return {
    meta: {
      title: ctx.media?.title?.english ?? ctx.media?.title?.romaji ?? null,
      malId,
      source: "animedunya",
    },
    episodes: { sub, dub: [] },
  };
}

async function handleWatch(anilistId, audio, epNum, ctx = {}) {
  if (audio !== "sub") {
    return watchJson({ error: "AnimeDunya only provides subtitled streams" }, 404);
  }
  const malId = await resolveMalId(anilistId, ctx);
  const html = await fetchHtml(`${BASE}/en/play/${malId}/${epNum}`);
  if (!html) return watchJson({ error: "AnimeDunya watch fetch failed" }, 502);

  const streamData = extractStream(html);
  const streamUrl = normalizeUrl(streamData?.source, BASE);
  if (!streamUrl) {
    return watchJson({ error: "AnimeDunya: stream source not found" }, 404);
  }

  const subtitles = (Array.isArray(streamData.subtitles) ? streamData.subtitles : [])
    .map((s) => {
      const subUrl = normalizeUrl(s?.src ?? s?.url ?? s?.file, BASE);
      if (!subUrl) return null;
      return {
        url: subUrl,
        label: s.label || s.srclang || "Subtitle",
        srclang: s.srclang || "und",
        default: Boolean(s.default),
      };
    })
    .filter(Boolean);

  const streams = [{
    url: streamUrl,
    type: "hls",
    server: "AnimeDunya",
    referer: `${BASE}/`,
    subtitles,
    priority: 5,
    isActive: true,
  }];

  return watchJson({
    anilistId: Number(anilistId),
    malId,
    episode: Number(epNum),
    audio,
    streams,
  });
}

export default {
  async fetch(request) {
    if (request.method === "OPTIONS") {
      return optionsResponse("GET, OPTIONS");
    }
    const url = new URL(request.url);
    try {
      const m = url.pathname.match(/^\/watch\/animedunya\/([1-9]\d{0,11})\/(sub|dub)\/animedunya-([1-9]\d{0,11})\/?$/);
      if (m) return await handleWatch(m[1], m[2], m[3]);
      return watchJson({ error: "Not found" }, 404);
    } catch (err) {
      return errorResponse(err, { provider: "animedunya" });
    }
  },
};
