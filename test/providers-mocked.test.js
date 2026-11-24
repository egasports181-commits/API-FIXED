import test from "node:test";
import assert from "node:assert/strict";

import worker from "../index.js";
import { clearMediaCache } from "../core/anilist.js";
import * as animedunya from "../providers/animedunya.js";
import * as senshi from "../providers/senshi.js";
import * as kaa from "../providers/kickassanime.js";
import * as animeonsen from "../providers/animeonsen.js";
import * as anizone from "../providers/anizone.js";
import * as animegg from "../providers/animegg.js";
import * as animenosub from "../providers/animenosub.js";
import * as aniwaves from "../providers/aniwaves.js";
import * as reanime from "../providers/reanime.js";

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

function mockAniListMedia(overrides = {}) {
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
    ...overrides,
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

test("AnimeDunya: works with native fetch (no curl/child_process), handles brackets in titles, HLS + subtitles, rejects dub", async () => {
  const animeHtml = `
    <html><body>
      <img src="https://cdn.anime-dunya.com/thumbnail/abc123/large.jpg" />
      <script>
        self.__next_f.push([1,"\\"episodes\\":[{\\"episodeNumber\\":1,\\"streamId\\":\\"ep1hash\\",\\"translations\\":[{\\"language\\":\\"en\\",\\"title\\":\\"To You [Part 1]\\"}]},{\\"episodeNumber\\":2,\\"streamId\\":\\"ep2hash\\",\\"translations\\":[{\\"language\\":\\"en\\",\\"title\\":\\"That Day {Special}\\"}]}]"]);
      </script>
    </body></html>
  `;
  const playHtml = `
    <html><body>
      <script>
        self.__next_f.push([1,"\\"stream\\":{\\"source\\":\\"https://cdn.anime-dunya.com/hls/ep1/master.m3u8\\",\\"subtitles\\":[{\\"src\\":\\"/subs/en.vtt\\",\\"label\\":\\"English\\",\\"srclang\\":\\"en\\",\\"default\\":true},{\\"src\\":\\"\\",\\"label\\":\\"Empty\\"}]}"]);
      </script>
    </body></html>
  `;

  await withMockFetch(async (input) => {
    const url = String(input);
    if (url.includes("graphql.anilist.co")) return jsonRes({ data: { Media: mockAniListMedia() } });
    if (url.includes("arm.haglund.dev")) return jsonRes({ myanimelist: 16498 });
    if (url.includes("api.ani.zip")) return jsonRes({ episodes: {} });
    if (url === "https://anime-dunya.com/en/anime/16498") return htmlRes(animeHtml);
    if (url === "https://anime-dunya.com/en/play/16498/1") return htmlRes(playHtml);
    return htmlRes("Not Found", 404);
  }, async () => {
    const epData = await animedunya.getEpisodes(16498, { media: mockAniListMedia() });
    assert.equal(epData.meta.source, "animedunya");
    assert.equal(epData.episodes.sub.length, 2);
    assert.equal(epData.episodes.sub[0].id, "watch/animedunya/16498/sub/animedunya-1");
    assert.equal(epData.episodes.sub[0].title, "To You [Part 1]");
    assert.equal(epData.episodes.sub[1].title, "That Day {Special}");
    assert.equal(epData.episodes.dub.length, 0);

    const watchRes = await worker.fetch(new Request("http://localhost/watch/animedunya/16498/sub/animedunya-1"), {});
    assert.equal(watchRes.status, 200);
    assert.equal(watchRes.headers.get("cache-control"), "no-store");
    const watch = await watchRes.json();
    assert.equal(watch.streams.length, 1);
    assert.equal(watch.streams[0].url, "https://cdn.anime-dunya.com/hls/ep1/master.m3u8");
    assert.equal(watch.streams[0].type, "hls");
    assert.equal(watch.streams[0].subtitles.length, 1);
    assert.equal(watch.streams[0].subtitles[0].url, "https://anime-dunya.com/subs/en.vtt");
    assert.equal(watch.streams[0].subtitles[0].srclang, "en");
    assert.equal(watch.streams[0].subtitles[0].default, true);

    const dubRes = await worker.fetch(new Request("http://localhost/watch/animedunya/16498/dub/animedunya-1"), {});
    assert.equal(dubRes.status, 404);
  });
});

test("Filtered /episodes/:provider/:anilistId isolates provider failures and never leaks stack traces", async () => {
  await withMockFetch(async (input) => {
    const url = String(input);
    if (url.includes("graphql.anilist.co")) return jsonRes({ data: { Media: mockAniListMedia() } });
    if (url.includes("arm.haglund.dev")) return jsonRes({ myanimelist: 16498 });
    if (url.includes("api.ani.zip")) return jsonRes({ episodes: {} });
    if (url === "https://anime-dunya.com/en/anime/16498") {
      return htmlRes(`"episodes":[{"episodeNumber":1,"streamId":"s1","translations":[{"language":"en","title":"Ep 1"}]}]`);
    }
    if (url.includes("senshi.to")) {
      return htmlRes("Internal Server Error", 500);
    }
    return htmlRes("Not found", 404);
  }, async () => {
    const res = await worker.fetch(
      new Request("http://localhost/episodes/animedunya/senshi/bogus/16498?map=false"),
      {}
    );
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.type, "filtered");
    assert.deepEqual(data._unknownProviders, ["bogus"]);
    assert.equal(data.animedunya.episodes.sub.length, 1);
    assert.equal(typeof data.senshi.error, "string");
    assert.equal("stack" in data.senshi, false, "Provider error must not expose stack trace");
  });
});

test("Senshi: episodes and watch (with subtitles and embed fallback)", async () => {
  await withMockFetch(async (input) => {
    const url = String(input);
    if (url.includes("graphql.anilist.co")) return jsonRes({ data: { Media: mockAniListMedia() } });
    if (url.includes("arm.haglund.dev")) return jsonRes({ myanimelist: 16498 });
    if (url === "https://senshi.to/episodes/16498") {
      return jsonRes([
        { ep_id: 1, ep_title: "First Episode", intro_start: 10, intro_end: 95 },
      ]);
    }
    if (url === "https://senshi.to/episode-embeds/16498/1") {
      return jsonRes([
        { status: "sub", url: "http://embed.senshi.to/e/1", server2: "https://streamnin.example/e/1" },
      ]);
    }
    return htmlRes("Not found", 404);
  }, async () => {
    const eps = await senshi.getEpisodes(16498, { media: mockAniListMedia() });
    assert.equal(eps.meta.source, "senshi");
    assert.equal(eps.episodes.sub.length, 1);
    assert.equal(eps.episodes.sub[0].id, "watch/senshi/16498/sub/senshi-1");

    const watchRes = await worker.fetch(new Request("http://localhost/watch/senshi/16498/sub/senshi-1"), {});
    assert.equal(watchRes.status, 200);
    assert.equal(watchRes.headers.get("cache-control"), "no-store");
    const watch = await watchRes.json();
    assert.equal(watch.intro.start, 10);
    assert.equal(watch.streams[0].url, "https://embed.senshi.to/e/1");
    assert.equal(watch.streams[0].isActive, true);
  });
});

test("KickAssAnime: episodes and watch return valid HLS master URL with single active stream", async () => {
  await withMockFetch(async (input) => {
    const url = String(input);
    if (url.includes("graphql.anilist.co")) return jsonRes({ data: { Media: mockAniListMedia() } });
    if (url.includes("arm.haglund.dev")) return jsonRes({ myanimelist: 16498 });
    if (url.includes("kaa.lt/api/fsearch")) {
      return jsonRes({
        result: [
          { slug: "attack-on-titan", title_en: "Attack on Titan", title: "Shingeki no Kyojin", year: 2013, type: "tv", locales: ["ja-JP", "en-US"] },
        ],
      });
    }
    if (url.includes("kaa.lt/api/show/attack-on-titan/episodes")) {
      return jsonRes({
        pages: [{ eps: [1] }],
        result: [{ episode_number: 1, slug: "abc123", title: "Ep 1", duration_ms: 1440000 }],
      });
    }
    if (url.includes("kaa.lt/api/show/attack-on-titan/episode/ep-1-abc123")) {
      return jsonRes({
        servers: [
          { name: "VidStreaming", src: "https://krussdomi.com/player?id=stream111" },
          { name: "DuckStream", src: "https://krussdomi.com/player?id=stream222" },
        ],
      });
    }
    if (url.includes("kaa.lt/api/show/attack-on-titan")) {
      return jsonRes({ type: "tv", locales: ["ja-JP", "en-US"] });
    }
    return htmlRes("Not found", 404);
  }, async () => {
    const eps = await kaa.getEpisodes(16498, { media: mockAniListMedia() });
    assert.equal(eps.meta.source, "kaa");
    assert.equal(eps.episodes.sub.length, 1);
    assert.equal(eps.episodes.dub.length, 1);

    const watchRes = await worker.fetch(new Request("http://localhost/watch/kaa/16498/sub/kaa-1"), {});
    assert.equal(watchRes.status, 200);
    assert.equal(watchRes.headers.get("cache-control"), "no-store");
    const watch = await watchRes.json();
    assert.equal(watch.streams.length, 2);
    assert.equal(watch.streams[0].url, "https://hls.krussdomi.com/manifest/stream111/master.m3u8");
    assert.equal(watch.streams[0].isActive, true);
    assert.equal(watch.streams[1].isActive, false);
  });
});

test("AnimeOnsen: session bootstrap, episodes, DASH watch + subtitles, dub returns 404", async () => {
  // Encode token "test-token-123": each char shifted by -1, then base64
  const shifted = [..."test-token-123"].map((c) => String.fromCharCode(c.charCodeAt(0) - 1)).join("");
  const cookieVal = encodeURIComponent(Buffer.from(shifted, "utf8").toString("base64"));

  await withMockFetch(async (input) => {
    const url = String(input);
    if (url.includes("graphql.anilist.co")) return jsonRes({ data: { Media: mockAniListMedia() } });
    if (url.includes("arm.haglund.dev")) return jsonRes({ myanimelist: 16498 });
    if (url === "https://www.animeonsen.xyz/") {
      return htmlRes(
        `<html><head>
          <meta name="ao-api-origin" content="https://api.animeonsen.xyz">
          <meta name="ao-search-origin" content="https://search.animeonsen.xyz">
          <meta name="ao-search-token" content="search-tok">
        </head></html>`,
        200,
        { "set-cookie": `ao.session=${cookieVal}; Path=/; HttpOnly` }
      );
    }
    if (url.includes("search.animeonsen.xyz/multi-search")) {
      return jsonRes({
        results: [{ hits: [{ content_id: "ao-aot", content_title_en: "Attack on Titan", content_title: "Shingeki no Kyojin" }] }],
      });
    }
    if (url.includes("api.animeonsen.xyz/v4/content/ao-aot/video/1")) {
      return jsonRes({
        uri: {
          stream: "https://cdn.animeonsen.xyz/dash/ep1.mpd",
          subtitles: { "en-US": "https://cdn.animeonsen.xyz/subs/en.vtt" },
        },
        metadata: {
          mal_id: 16498,
          total_episodes: 2,
          is_movie: false,
          subtitles: { "en-US": "English" },
          episode: [{ skipIntro_s: 5, skipIntro_e: 90 }],
        },
      });
    }
    if (url.includes("api.animeonsen.xyz/v4/content/ao-aot/episodes")) {
      return jsonRes({ "1": { contentTitle_episode_en: "Episode 1" } });
    }
    return htmlRes("Not found", 404);
  }, async () => {
    const eps = await animeonsen.getEpisodes(16498, { media: mockAniListMedia() });
    assert.equal(eps.meta.source, "animeonsen");
    assert.equal(eps.episodes.sub.length, 1);

    const watchRes = await worker.fetch(new Request("http://localhost/watch/animeonsen/16498/sub/animeonsen-1"), {});
    assert.equal(watchRes.status, 200);
    assert.equal(watchRes.headers.get("cache-control"), "no-store");
    const watch = await watchRes.json();
    assert.equal(watch.streams[0].url, "https://cdn.animeonsen.xyz/dash/ep1.mpd");
    assert.equal(watch.streams[0].subtitles[0].srclang, "en-US");

    const dubRes = await worker.fetch(new Request("http://localhost/watch/animeonsen/16498/dub/animeonsen-1"), {});
    assert.equal(dubRes.status, 404);
  });
});

test("AniZone: pagination loop guard prevents infinite Livewire cursor loops + watch returns HLS and subtitles", async () => {
  const searchItems = JSON.stringify([
    { slug: "attack-on-titan", main_title: "Attack on Titan", title_list: { "1": "Attack on Titan" }, type: "TV", start_year: 2013, episode_count: 2 },
  ]);
  const detailItems = JSON.stringify([
    { slug: "1", title_list: { "1": "Ep 1" }, duration: "24:00", videos_count: 1 },
  ]);
  const playerPayload = JSON.stringify({
    src: "https://cdn.anizone.to/hls/ep1/index.m3u8",
    subtitles: [{ file: "/subs/en.vtt", title: "English", language: "en", default: true }],
  });

  let livewireCalls = 0;

  await withMockFetch(async (input) => {
    const url = String(input);
    if (url.includes("graphql.anilist.co")) return jsonRes({ data: { Media: mockAniListMedia({ episodes: null }) } });
    if (url.includes("arm.haglund.dev")) return jsonRes({ myanimelist: 16498 });
    if (url.includes("anizone.to/anime?search=")) {
      return htmlRes(`<script>items: JSON.parse('${searchItems}')</script>`);
    }
    if (url === "https://anizone.to/anime/attack-on-titan") {
      return htmlRes(`
        <meta name="csrf-token" content="tok123">
        <div wire:snapshot="{&quot;memo&quot;:{&quot;name&quot;:&quot;pages.anime-detail&quot;}}"></div>
        <script>items: JSON.parse('${detailItems}'), nextCursor: 'REPEAT_CURSOR', hasMore: true</script>
      `);
    }
    if (url === "https://anizone.to/livewire/update") {
      livewireCalls++;
      return jsonRes({
        components: [{
          snapshot: '{"memo":{"name":"pages.anime-detail"}}',
          effects: {
            dispatches: [{
              name: "items-loaded",
              params: {
                items: [{ slug: "2", title_list: { "1": "Ep 2" }, duration: "24:00", videos_count: 1 }],
                nextCursor: "REPEAT_CURSOR",
                hasMore: true,
              },
            }],
          },
        }],
      });
    }
    if (url === "https://anizone.to/anime/attack-on-titan/1") {
      return htmlRes(`<script>vidstackPlayer(JSON.parse('${playerPayload}'))</script>`);
    }
    return htmlRes("Not found", 404);
  }, async () => {
    const eps = await anizone.getEpisodes(16498, { media: mockAniListMedia({ episodes: null }) });
    assert.equal(livewireCalls, 1, "Repeated cursor must terminate pagination immediately");
    assert.equal(eps.episodes.sub.length, 2);

    const watchRes = await worker.fetch(new Request("http://localhost/watch/anizone/16498/sub/anizone-1"), {});
    assert.equal(watchRes.status, 200);
    assert.equal(watchRes.headers.get("cache-control"), "no-store");
    const watch = await watchRes.json();
    assert.equal(watch.streams[0].url, "https://cdn.anizone.to/hls/ep1/index.m3u8");
    assert.equal(watch.streams[0].subtitles[0].url, "https://anizone.to/subs/en.vtt");
  });
});

test("AnimeGG, AnimeNoSub, AniWaves, Reanime: mocked episodes and error-handling contracts", async () => {
  const media = mockAniListMedia();

  // AnimeGG
  await withMockFetch(async (input) => {
    const url = String(input);
    if (url.includes("graphql.anilist.co")) return jsonRes({ data: { Media: media } });
    if (url.includes("animegg.org/search")) {
      return htmlRes(`<a class="mse" href="/series/attack-on-titan"><strong>Attack on Titan</strong></a>`);
    }
    if (url.includes("animegg.org/series/attack-on-titan")) {
      return htmlRes(`<ul><li><a class="anm_det_pop" href="/attack-on-titan-episode-1"><strong>Episode 1</strong><i class="anititle">First</i><span class="btn-subbed">SUB</span></a></li></ul>`);
    }
    return htmlRes("Not found", 404);
  }, async () => {
    const eps = await animegg.getEpisodes(16498, { media });
    assert.equal(eps.meta.source, "animegg");
    assert.equal(eps.episodes.sub.length, 1);
  });

  // AnimeNoSub
  await withMockFetch(async (input) => {
    const url = String(input);
    if (url.includes("graphql.anilist.co")) return jsonRes({ data: { Media: media } });
    if (url.includes("animenosub.to/wp-admin/admin-ajax.php")) {
      return jsonRes({ anime: [{ all: [{ post_link: "https://animenosub.to/anime/attack-on-titan/", post_title: "Attack on Titan" }] }] });
    }
    if (url.includes("animenosub.to/anime/attack-on-titan/")) {
      return htmlRes(`<li data-index="0"><a href="https://animenosub.to/attack-on-titan-episode-1/"><div class="epl-num">1</div></a></li>`);
    }
    return htmlRes("Not found", 404);
  }, async () => {
    const eps = await animenosub.getEpisodes(16498, { media });
    assert.equal(eps.meta.source, "animenosub");
    assert.equal(eps.episodes.sub.length, 1);
  });

  // AniWaves
  await withMockFetch(async (input) => {
    const url = String(input);
    if (url.includes("graphql.anilist.co")) return jsonRes({ data: { Media: media } });
    if (url.includes("aniwaves.ru/filter")) {
      return htmlRes(`<a class="name d-title" href="/watch/attack-on-titan-99" data-jp="Shingeki no Kyojin">Attack on Titan</a>`);
    }
    if (url === "https://aniwaves.ru/watch/attack-on-titan-99") {
      return htmlRes(`<h1>Attack on Titan</h1><div>Type:<span>TV</span></div><div>Date aired:<span>Apr 2013</span></div><div>Episodes:<span>2</span></div>`);
    }
    if (url.includes("aniwaves.ru/ajax/episode/list/99")) {
      return jsonRes({ status: 200, result: `<a data-num="1" data-slug="1" data-ids="ep1" data-sub="1" data-dub="0">1 First</a>` });
    }
    return htmlRes("Not found", 404);
  }, async () => {
    const eps = await aniwaves.getEpisodes(16498, { media });
    assert.equal(eps.meta.source, "aniwaves");
    assert.equal(eps.episodes.sub.length, 1);
  });

  // Reanime
  await withMockFetch(async (input) => {
    const url = String(input);
    if (url.includes("graphql.anilist.co")) return jsonRes({ data: { Media: media } });
    if (url.includes("api.ani.zip")) return jsonRes({ episodes: {} });
    if (url.includes("reanime.to/api/v1/search")) {
      return jsonRes({
        results: [{
          anime_id: "aot-1",
          title: { english: "Attack on Titan", romaji: "Shingeki no Kyojin" },
          cover_image: { large: "https://s4.anilist.co/file/anilistcdn/media/anime/cover/large/bx16498-abc.jpg" },
          subbed: 2,
          dubbed: 1,
          episodes: 2,
        }],
      });
    }
    if (url.includes("reanime.to/api/v1/anime/aot-1/episodes")) {
      return jsonRes({ data: [{ episode_number: 1, title: "Ep 1" }] });
    }
    return htmlRes("Not found", 404);
  }, async () => {
    const eps = await reanime.getEpisodes(16498, { media, anizip: {} });
    assert.equal(eps.meta.animeId, "aot-1");
    assert.equal(eps.episodes.sub.length, 1);
    assert.equal(eps.episodes.dub.length, 1);
  });
});

test("GET /episodes/:anilistId aggregates all 12 providers and isolates individual failures", async () => {
  const prevTimeout = process.env.HTTP_TIMEOUT_MS;
  process.env.HTTP_TIMEOUT_MS = "150";
  try {
    await withMockFetch(async (input) => {
      const url = String(input);
      if (url.includes("graphql.anilist.co")) return jsonRes({ data: { Media: mockAniListMedia() } });
      if (url.includes("arm.haglund.dev")) return jsonRes({ myanimelist: 16498 });
      if (url.includes("api.ani.zip")) return jsonRes({ episodes: {} });
      if (url === "https://anime-dunya.com/en/anime/16498") {
        return htmlRes(`"episodes":[{"episodeNumber":1,"streamId":"s1","translations":[{"language":"en","title":"Ep 1"}]}]`);
      }
      return htmlRes("Service Unavailable", 500);
    }, async () => {
      const res = await worker.fetch(new Request("http://localhost/episodes/16498"), { API_VERSION: "2.3" });
      assert.equal(res.status, 200);
      const data = await res.json();
      assert.equal(data.type, "all");
      assert.equal(data.animedunya.episodes.sub.length, 1);
      for (const p of ["mkissa", "reanime", "anikoto", "animegg", "animenosub", "anizone", "aniwaves", "senshi", "kaa", "animedunya", "animeonsen", "anipm"]) {
        assert.ok(p in data, `Missing provider key ${p}`);
        assert.equal("stack" in (data[p] ?? {}), false, `Stack leaked in provider ${p}`);
      }
    });
  } finally {
    if (prevTimeout === undefined) delete process.env.HTTP_TIMEOUT_MS;
    else process.env.HTTP_TIMEOUT_MS = prevTimeout;
  }
});

test("Provider timeout returns 504 without crashing API or leaking stack traces", async () => {
  const prevTimeout = process.env.HTTP_TIMEOUT_MS;
  process.env.HTTP_TIMEOUT_MS = "120";
  try {
    await withMockFetch(async (input, init) => {
      const url = String(input);
      if (url.includes("graphql.anilist.co")) return jsonRes({ data: { Media: mockAniListMedia() } });
      if (url.includes("arm.haglund.dev")) return jsonRes({ myanimelist: 16498 });
      return new Promise((_resolve, reject) => {
        const onAbort = () => reject(init.signal.reason);
        if (init?.signal?.aborted) return onAbort();
        init?.signal?.addEventListener("abort", onAbort, { once: true });
      });
    }, async () => {
      const res = await worker.fetch(new Request("http://localhost/watch/animedunya/16498/sub/animedunya-1"), {});
      assert.equal(res.status, 504, `Expected 504 on timeout, got ${res.status}`);
      assert.equal(res.headers.get("cache-control"), "no-store");
      const body = await res.json();
      assert.match(body.error, /timed out|unreachable/i);
      assert.equal("stack" in body, false);
    });
  } finally {
    if (prevTimeout === undefined) delete process.env.HTTP_TIMEOUT_MS;
    else process.env.HTTP_TIMEOUT_MS = prevTimeout;
  }
});
