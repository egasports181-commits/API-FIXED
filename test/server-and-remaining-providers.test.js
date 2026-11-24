import test from "node:test";
import assert from "node:assert/strict";

import { createAppServer } from "../server.js";
import { clearMediaCache } from "../core/anilist.js";
import * as anikoto from "../providers/anikoto.js";
import * as anipm from "../providers/anipm.js";
import * as mkissa from "../providers/mkissa.js";
import { closeWreqSessions } from "../core/wreq.js";

function jsonRes(body, status = 200, headers = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...headers },
  });
}

function htmlRes(body, status = 200, headers = {}) {
  return new Response(body, {
    status,
    headers: { "Content-Type": "text/html; charset=utf-8", ...headers },
  });
}

function mockAniListMedia() {
  return {
    id: 16498,
    idMal: 16498,
    title: { english: "Attack on Titan", romaji: "Shingeki no Kyojin", native: "進撃の巨人" },
    status: "FINISHED",
    format: "TV",
    episodes: 2,
    seasonYear: 2013,
    startDate: { year: 2013 },
    genres: ["Action"],
    synonyms: [],
    nextAiringEpisode: null,
  };
}

function withMockFetch(mockFn, runFn) {
  const original = globalThis.fetch;
  const prevWreq = process.env.WREQ_DISABLED;
  globalThis.fetch = mockFn;
  process.env.WREQ_DISABLED = "1";
  clearMediaCache();
  return Promise.resolve()
    .then(runFn)
    .finally(() => {
      globalThis.fetch = original;
      if (prevWreq === undefined) delete process.env.WREQ_DISABLED;
      else process.env.WREQ_DISABLED = prevWreq;
      clearMediaCache();
    });
}

test("Anikoto: mocked episodes and watch subtitle thumbnail filtering", async () => {
  const media = mockAniListMedia();
  await withMockFetch(async (input) => {
    const url = String(input);
    if (url.includes("graphql.anilist.co")) return jsonRes({ data: { Media: media } });
    if (url.includes("api.ani.zip")) return jsonRes({ episodes: {} });
    if (url.includes("anikoto.cz/filter?keyword=")) {
      return htmlRes(`<a class="name d-title" href="/watch/attack-on-titan-abc" data-jp="Shingeki no Kyojin">Attack on Titan</a>`);
    }
    if (url === "https://anikoto.cz/watch/attack-on-titan-abc") {
      return htmlRes(`<div data-id="55555"></div>`);
    }
    if (url === "https://anikoto.cz/ajax/episode/list/55555") {
      return jsonRes({
        result: `<a data-id="ep1" data-num="1" data-ids="srv1" data-sub="1" data-dub="1" data-mal="16498" data-slug="ep-1" data-timestamp="100"><span class="d-title">To You</span></a>`,
      });
    }
    if (url.includes("anikoto.cz/ajax/server/list")) {
      return jsonRes({
        result: `<div class="type" data-type="sub"><ul><li data-link-id="lnk1">MegaPlay</li></ul></div>`,
      });
    }
    if (url.includes("anikoto.cz/ajax/server?get=lnk1")) {
      return jsonRes({
        result: { url: "https://megaplay.buzz/stream/s-2/123/sub" },
      });
    }
    if (url.includes("megaplay.buzz/stream/getSources")) {
      return jsonRes({
        sources: { file: "https://cdn.example.com/aot/ep1.m3u8" },
        tracks: [
          { file: "https://cdn.example.com/aot/sprites.vtt", kind: "thumbnails", label: "Thumbnails" },
          { file: "https://cdn.example.com/aot/en.vtt", kind: "captions", label: "English", default: true },
        ],
      });
    }
    if (url.includes("megaplay.buzz/stream/")) {
      return htmlRes(`<div data-id="file1"></div><script src="/app.js"></script>`);
    }
    if (url.includes("megaplay.buzz/app.js")) {
      return htmlRes(`const r = "stream/getSources"; const m = "AES-CBC";`);
    }
    return htmlRes("Not found", 404);
  }, async () => {
    const eps = await anikoto.getEpisodes(16498, { media, anizip: {} });
    assert.equal(eps.meta.source, "anikoto");
    assert.equal(eps.episodes.sub.length, 1);
    assert.equal(eps.episodes.dub.length, 1);

    const watchRes = await anikoto.default.fetch(new Request("http://localhost/watch/anikoto/16498/sub/anikoto-1"));
    assert.equal(watchRes.status, 200);
    assert.equal(watchRes.headers.get("cache-control"), "no-store");
    const watch = await watchRes.json();
    assert.equal(watch.streams[0].url, "https://cdn.example.com/aot/ep1.m3u8");
    assert.equal(watch.subtitles.length, 1, "Thumbnail tracks must be excluded from subtitles");
    assert.equal(watch.subtitles[0].url, "https://cdn.example.com/aot/en.vtt");
  });
});

test("Ani.pm: mocked episodes and watch fallback to fetch when wreq unavailable, normalizes subtitles", async () => {
  const media = mockAniListMedia();
  await withMockFetch(async (input) => {
    const url = String(input);
    if (url.includes("graphql.anilist.co")) return jsonRes({ data: { Media: media } });
    if (url.includes("ani.pm/api/anime/search")) {
      return jsonRes([{ id: "pm-1", source: "anipm", title: "Attack on Titan", anilistId: 16498, malId: 16498 }]);
    }
    if (url.includes("ani.pm/api/anime/playback-bootstrap/anipm/pm-1")) {
      return jsonRes({
        core: {
          title: "Attack on Titan",
          anilistId: 16498,
          malId: 16498,
          episodes: [{ number: 1, title: "To You" }],
        },
        anipmPackages: { episodes: { "1": { sub: true, dub: false } } },
        settlarSelection: "sel-token",
      });
    }
    if (url.includes("ani.pm/api/anime/settlar/session")) {
      return jsonRes({ embedUrl: "https://embed.settlar.io/e?t=sess123" });
    }
    if (url.includes("embed.settlar.io/api/embed/session")) {
      return jsonRes({
        source: "https://cdn.settlar.io/hls/ep1.m3u8",
        subtitles: [{ url: "/subs/en.vtt", label: "English", srclang: "en", default: true }],
      });
    }
    return htmlRes("Not found", 404);
  }, async () => {
    const eps = await anipm.getEpisodes(16498, { media, anizip: {} });
    assert.equal(eps.meta.source, "anipm");
    assert.equal(eps.episodes.sub.length, 1);

    const watchRes = await anipm.default.fetch(new Request("http://localhost/watch/anipm/16498/sub/anipm-1"));
    assert.equal(watchRes.status, 200);
    assert.equal(watchRes.headers.get("cache-control"), "no-store");
    const watch = await watchRes.json();
    assert.equal(watch.streams[0].url, "https://cdn.settlar.io/hls/ep1.m3u8");
    assert.equal(watch.streams[0].subtitles[0].url, "https://ani.pm/subs/en.vtt");
  });
});

test("HTTP server startup and route smoke tests (server.js on ephemeral port)", async () => {
  const server = createAppServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address();
  const baseUrl = `http://127.0.0.1:${addr.port}`;

  try {
    // 1. Health check GET & HEAD
    const health = await fetch(`${baseUrl}/health`);
    assert.equal(health.status, 200);
    assert.equal(health.headers.get("cache-control"), "no-store");
    const healthBody = await health.json();
    assert.equal(healthBody.status, "ok");
    assert.equal(healthBody.providers, 12);

    const healthHead = await fetch(`${baseUrl}/health`, { method: "HEAD" });
    assert.equal(healthHead.status, 200);
    assert.equal((await healthHead.text()).length, 0);

    // 2. Static landing page & docs
    const landing = await fetch(`${baseUrl}/`);
    assert.equal(landing.status, 200);
    assert.match(landing.headers.get("content-type"), /text\/html/);

    const docs = await fetch(`${baseUrl}/docs`);
    assert.equal(docs.status, 200);
    const docsHtml = await docs.text();
    assert.equal(docsHtml.includes("{{API_VERSION}}"), false, "Template version must be substituted");

    // 3. Invalid ID validation over live HTTP socket
    const badMap = await fetch(`${baseUrl}/map/notanid`);
    assert.equal(badMap.status, 400);
    const badMapJson = await badMap.json();
    assert.equal(typeof badMapJson.error, "string");
    assert.equal("stack" in badMapJson, false);

    const badWatch = await fetch(`${baseUrl}/watch/animedunya/16498/sub/animedunya-0`);
    assert.equal(badWatch.status, 400);

    // 4. OPTIONS preflight
    const opt = await fetch(`${baseUrl}/episodes/16498`, { method: "OPTIONS" });
    assert.equal(opt.status, 204);
    assert.equal(opt.headers.get("access-control-allow-origin"), "*");

    // 5. MKissa module exports intact
    assert.equal(typeof mkissa.getEpisodes, "function");
    assert.equal(typeof anipm.getEpisodes, "function");
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await closeWreqSessions();
  }
});
