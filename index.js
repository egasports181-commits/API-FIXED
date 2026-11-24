import { getMedia } from "./core/anilist.js";
import { mapAnimeIds } from "./core/mapper.js";
import mkissaHandler from "./providers/mkissa.js";
import reanimeHandler from "./providers/reanime.js";
import anikotoHandler from "./providers/anikoto.js";
import animeggHandler from "./providers/animegg.js";
import animenosubHandler from "./providers/animenosub.js";
import anizoneHandler from "./providers/anizone.js";
import aniwavesHandler from "./providers/aniwaves.js";
import senshiHandler from "./providers/senshi.js";
import kaaHandler from "./providers/kickassanime.js";
import animedunyaHandler from "./providers/animedunya.js";
import animeonsenHandler from "./providers/animeonsen.js";
import anipmHandler from "./providers/anipm.js";
import { getEpisodesResponse, getFilteredEpisodesResponse } from "./core/episode-cache.js";
import { ALL_PROVIDERS, resolveProviders } from "./core/episode-strategy.js";
import { getAsync, setAsync, isFresh, mapTTL, WATCH_TTL, _CACHE_ENABLED } from "./core/smartcache.js";
import { errorResponse, jsonResponse, optionsResponse, watchJson } from "./core/http.js";

const PROVIDER_SET = new Set(ALL_PROVIDERS);
const SIGNED_STREAM_WATCH_TTL = 45_000;

function json(data, status = 200, options = {}) {
  return jsonResponse(data, status, options);
}

function rewriteRequest(request, newPath) {
  const u = new URL(request.url);
  u.pathname = newPath;
  return new Request(u.toString(), { method: request.method, headers: request.headers });
}

const watchInflight = new Map();

async function cachedWatch(cacheKey, handlerFn, ttl = WATCH_TTL, { bypassCache = false, provider = "watch" } = {}) {
  if (!bypassCache) {
    const entry = await getAsync(cacheKey);
    if (entry && isFresh(entry)) return watchJson(entry.data);
  }

  if (!bypassCache && watchInflight.has(cacheKey)) {
    try {
      const shared = await watchInflight.get(cacheKey);
      return shared.clone();
    } catch (err) {
      return errorResponse(err, { provider });
    }
  }

  const promise = (async () => {
    let response;
    try {
      response = await handlerFn();
    } catch (err) {
      response = errorResponse(err, { provider });
    }
    if (!bypassCache && response.status === 200) {
      try {
        const data = await response.clone().json();
        await setAsync(cacheKey, data, ttl);
      } catch {}
    }
    return response;
  })();

  if (!bypassCache) watchInflight.set(cacheKey, promise);
  try {
    const res = await promise;
    return res.clone();
  } finally {
    if (!bypassCache) watchInflight.delete(cacheKey);
  }
}

function hasCaptchaOverride(request, url) {
  return Boolean(
    url.searchParams.get("captchaToken") ||
    url.searchParams.get("turnstileToken") ||
    request.headers.get("x-captcha-token") ||
    request.headers.get("cf-turnstile-response")
  );
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;

    if (request.method === "OPTIONS") {
      return optionsResponse("GET, HEAD, OPTIONS");
    }

    if (request.method !== "GET" && request.method !== "HEAD") {
      return json({ error: `Method ${request.method} not allowed` }, 405, { cacheControl: "no-store" });
    }

    if (path === "/health" || path === "/health/") {
      return json(
        {
          status: "ok",
          name: `Anivexa API ${env?.API_VERSION ?? "2.3"}`,
          version: env?.API_VERSION ?? "2.3",
          cache: _CACHE_ENABLED,
          providers: ALL_PROVIDERS.length,
          uptime: typeof process !== "undefined" && typeof process.uptime === "function" ? Math.floor(process.uptime()) : null,
          timestamp: new Date().toISOString(),
        },
        200,
        { cacheControl: "no-store" }
      );
    }

    let m = path.match(/^\/map\/([1-9]\d{0,11})\/?$/);
    if (m) {
      const anilistId = m[1];
      const cacheKey = `map:${anilistId}`;
      const entry = await getAsync(cacheKey);
      if (entry && isFresh(entry)) return json(entry.data);

      try {
        const [data, media] = await Promise.all([
          mapAnimeIds(anilistId),
          getMedia(anilistId).catch(() => null),
        ]);
        await setAsync(cacheKey, data, mapTTL(media?.status ?? "RELEASING"));
        return json(data);
      } catch (e) {
        if (entry) return json(entry.data);
        return errorResponse(e, { provider: "mapper" });
      }
    }
    if (path === "/map" || path.startsWith("/map/")) {
      return json({ error: "Invalid AniList ID. Expected a positive integer at /map/:anilistId" }, 400);
    }

    m = path.match(/^\/episodes\/((?:[\w-]+\/)+)([1-9]\d{0,11})\/?$/i);
    if (m) {
      const rawNames = m[1].replace(/\/$/, "").split("/");
      const anilistId = m[2];
      const includeMap = url.searchParams.get("map") !== "false";
      const { resolved, unknown } = resolveProviders(rawNames);

      if (resolved.size === 0) {
        return json({ error: "No valid providers specified", unknown }, 400);
      }

      try {
        const data = await getFilteredEpisodesResponse(anilistId, resolved, includeMap);
        if (unknown.length) data._unknownProviders = unknown;
        return json(data);
      } catch (e) {
        return errorResponse(e, { provider: "episodes" });
      }
    }

    m = path.match(/^\/episodes\/([1-9]\d{0,11})\/?$/);
    if (m) {
      const anilistId = m[1];
      try {
        return json(await getEpisodesResponse(anilistId, env));
      } catch (e) {
        return errorResponse(e, { provider: "episodes" });
      }
    }
    if (path === "/episodes" || path.startsWith("/episodes/")) {
      return json({ error: "Invalid episodes request. Expected /episodes/:anilistId or /episodes/:provider/:anilistId with a positive integer ID" }, 400);
    }

    m = path.match(/^\/watch\/mkissa\/([1-9]\d{0,11})\/(sub|dub)\/mkissa-([1-9]\d{0,11})\/?$/);
    if (m) {
      const [, id, audio, ep] = m;
      return cachedWatch(
        `watch:mkissa:${id}:${audio}:${ep}`,
        () => mkissaHandler.fetch(request),
        WATCH_TTL,
        { bypassCache: hasCaptchaOverride(request, url), provider: "mkissa" }
      );
    }

    if (path.match(/^\/captcha\/mkissa\/?$/)) {
      return mkissaHandler.fetch(request);
    }

    m = path.match(/^\/watch\/reanime\/([1-9]\d{0,11})\/(sub|dub)\/reanime-([1-9]\d{0,11})\/?$/);
    if (m) {
      const [, id, audio, ep] = m;
      return cachedWatch(
        `watch:reanime:${id}:${audio}:${ep}`,
        () => reanimeHandler.fetch(rewriteRequest(request, `/watch/${id}/${audio}/${ep}`)),
        SIGNED_STREAM_WATCH_TTL,
        { provider: "reanime" }
      );
    }

    m = path.match(/^\/stream\/reanime\/([1-9]\d{0,11})\/(sub|dub)\/([1-9]\d{0,11})\/?$/);
    if (m) {
      const [, id, audio, ep] = m;
      return reanimeHandler.fetch(rewriteRequest(request, `/stream/${id}/${audio}/${ep}`));
    }
    if (path.startsWith("/stream/reanime/")) {
      return watchJson({ error: "Invalid stream parameters. Expected /stream/reanime/:anilistId/sub|dub/:ep" }, 400);
    }
    if (path === "/stream" || path.startsWith("/stream/")) {
      return watchJson({ error: "Stream route not found" }, 404);
    }

    m = path.match(/^\/watch\/anikoto\/([1-9]\d{0,11})\/(sub|dub)\/anikoto-([1-9]\d{0,11})\/?$/);
    if (m) {
      const [, id, audio, ep] = m;
      return cachedWatch(
        `watch:anikoto:${id}:${audio}:${ep}`,
        () => anikotoHandler.fetch(request),
        SIGNED_STREAM_WATCH_TTL,
        { provider: "anikoto" }
      );
    }

    m = path.match(/^\/watch\/animegg\/([1-9]\d{0,11})\/(sub|dub)\/animegg-([1-9]\d{0,11})\/?$/);
    if (m) {
      const [, id, audio, ep] = m;
      return cachedWatch(
        `watch:animegg:${id}:${audio}:${ep}`,
        () => animeggHandler.fetch(request),
        WATCH_TTL,
        { provider: "animegg" }
      );
    }

    m = path.match(/^\/watch\/animenosub\/([1-9]\d{0,11})\/(sub|dub)\/animenosub-([1-9]\d{0,11})\/?$/);
    if (m) {
      const [, id, audio, ep] = m;
      return cachedWatch(
        `watch:animenosub:${id}:${audio}:${ep}`,
        () => animenosubHandler.fetch(request),
        WATCH_TTL,
        { provider: "animenosub" }
      );
    }

    m = path.match(/^\/watch\/anizone\/([1-9]\d{0,11})\/(sub|dub)\/anizone-([1-9]\d{0,11})\/?$/);
    if (m) {
      const [, id, audio, ep] = m;
      return cachedWatch(
        `watch:anizone:${id}:${audio}:${ep}`,
        () => anizoneHandler.fetch(request),
        WATCH_TTL,
        { provider: "anizone" }
      );
    }

    m = path.match(/^\/watch\/aniwaves\/([1-9]\d{0,11})\/(sub|dub)\/aniwaves-([1-9]\d{0,11})\/?$/);
    if (m) {
      const [, id, audio, ep] = m;
      return cachedWatch(
        `watch:aniwaves:${id}:${audio}:${ep}`,
        () => aniwavesHandler.fetch(request),
        WATCH_TTL,
        { provider: "aniwaves" }
      );
    }

    m = path.match(/^\/watch\/senshi\/([1-9]\d{0,11})\/(sub|dub)\/senshi-([1-9]\d{0,11})\/?$/);
    if (m) {
      const [, id, audio, ep] = m;
      return cachedWatch(
        `watch:senshi:${id}:${audio}:${ep}`,
        () => senshiHandler.fetch(request),
        SIGNED_STREAM_WATCH_TTL,
        { provider: "senshi" }
      );
    }

    m = path.match(/^\/watch\/kaa\/([1-9]\d{0,11})\/(sub|dub)\/kaa-([1-9]\d{0,11})\/?$/);
    if (m) {
      const [, id, audio, ep] = m;
      return cachedWatch(
        `watch:kaa:${id}:${audio}:${ep}`,
        () => kaaHandler.fetch(request),
        WATCH_TTL,
        { provider: "kaa" }
      );
    }

    m = path.match(/^\/watch\/animedunya\/([1-9]\d{0,11})\/(sub|dub)\/animedunya-([1-9]\d{0,11})\/?$/);
    if (m) {
      const [, id, audio, ep] = m;
      return cachedWatch(
        `watch:animedunya:${id}:${audio}:${ep}`,
        () => animedunyaHandler.fetch(request),
        WATCH_TTL,
        { provider: "animedunya" }
      );
    }

    m = path.match(/^\/watch\/animeonsen\/([1-9]\d{0,11})\/(sub|dub)\/animeonsen-([1-9]\d{0,11})\/?$/);
    if (m) {
      const [, id, audio, ep] = m;
      return cachedWatch(
        `watch:animeonsen:${id}:${audio}:${ep}`,
        () => animeonsenHandler.fetch(request),
        SIGNED_STREAM_WATCH_TTL,
        { provider: "animeonsen" }
      );
    }

    m = path.match(/^\/watch\/anipm\/([1-9]\d{0,11})\/(sub|dub)\/anipm-([1-9]\d{0,11})\/?$/);
    if (m) {
      const [, id, audio, ep] = m;
      return cachedWatch(
        `watch:anipm:${id}:${audio}:${ep}`,
        () => anipmHandler.fetch(request),
        SIGNED_STREAM_WATCH_TTL,
        { provider: "anipm" }
      );
    }

    if (path === "/watch" || path.startsWith("/watch/")) {
      const providerSlug = path.split("/")[2]?.toLowerCase() ?? "";
      if (providerSlug && PROVIDER_SET.has(providerSlug)) {
        return watchJson(
          { error: `Invalid watch parameters for ${providerSlug}. Expected /watch/${providerSlug}/:anilistId/sub|dub/${providerSlug}-:ep` },
          400
        );
      }
      return watchJson({ error: "Not found" }, 404);
    }

    if (path === "/" || path === "/info" || path === "/api") {
      return json({
        name: `Anivexa API ${env?.API_VERSION ?? "2.3"}`,
        cache: _CACHE_ENABLED,
        providers: ALL_PROVIDERS,
        routes: [
          "/health",
          "/map/:anilistId",
          "/episodes/:anilistId",
          "/episodes/:provider[/:provider...]/:anilistId?map=true|false",
          "/watch/mkissa/:id/sub|dub/mkissa-:ep",
          "/watch/reanime/:id/sub|dub/reanime-:ep",
          "/stream/reanime/:id/sub|dub/:ep",
          "/watch/anikoto/:id/sub|dub/anikoto-:ep",
          "/watch/animegg/:id/sub|dub/animegg-:ep",
          "/watch/animenosub/:id/sub|dub/animenosub-:ep",
          "/watch/anizone/:id/sub|dub/anizone-:ep",
          "/watch/aniwaves/:id/sub|dub/aniwaves-:ep",
          "/watch/senshi/:id/sub|dub/senshi-:ep",
          "/watch/kaa/:id/sub|dub/kaa-:ep",
          "/watch/animedunya/:id/sub|dub/animedunya-:ep",
          "/watch/animeonsen/:id/sub|dub/animeonsen-:ep",
          "/watch/anipm/:id/sub|dub/anipm-:ep",
        ],
      });
    }

    return json({ error: "Not found" }, 404);
  },
};
