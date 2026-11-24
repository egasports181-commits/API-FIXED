import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import worker from "../index.js";
import { clearMediaCache } from "../core/anilist.js";
import { fetchWithRetry, mapWithConcurrency, normalizeUrl, withTimeout } from "../core/http.js";
import { extractMegaPlayDetails } from "../extractors/megaplay.js";
import mkissaHandler from "../providers/mkissa.js";

const __dir = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dir, "..");

function makeJsonRes(body, status = 200, headers = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...headers },
  });
}

function makeTextRes(body, status = 200, headers = {}) {
  return new Response(body, {
    status,
    headers: { "Content-Type": "text/html; charset=utf-8", ...headers },
  });
}

function withMockFetch(mockFn, runFn) {
  const original = globalThis.fetch;
  globalThis.fetch = mockFn;
  clearMediaCache();
  return Promise.resolve()
    .then(runFn)
    .finally(() => {
      globalThis.fetch = original;
      clearMediaCache();
    });
}

test("Static Linux & Security Audit: zero shell/curl calls, zero hardcoded JWTs, exact-case ESM imports", () => {
  const dirs = ["api", "core", "extractors", "providers"];
  const files = [
    path.join(ROOT, "index.js"),
    path.join(ROOT, "server.js"),
  ];
  for (const d of dirs) {
    const fullDir = path.join(ROOT, d);
    for (const entry of fs.readdirSync(fullDir)) {
      if (entry.endsWith(".js")) files.push(path.join(fullDir, entry));
    }
  }

  for (const file of files) {
    const src = fs.readFileSync(file, "utf8");
    const rel = path.relative(ROOT, file);

    assert.equal(/\bchild_process\b|\bexecSync\b|\bspawn\s*\(/i.test(src), false, `Disallowed child_process usage in ${rel}`);
    assert.equal(/\bcurl\s+-/i.test(src), false, `Disallowed curl shell command in ${rel}`);
    assert.equal(/eyJhbGciOiJIUzI1NiJ9\./.test(src), false, `Hardcoded JWT secret found in ${rel}`);

    for (const m of src.matchAll(/(?:import|export)\s+(?:[^'"\n]*?\s+from\s+)?['"](\.[^'"]+)['"]/g)) {
      const target = path.resolve(path.dirname(file), m[1]);
      const dir = path.dirname(target);
      const base = path.basename(target);
      const entries = fs.readdirSync(dir);
      assert.ok(entries.includes(base), `Case-sensitive import mismatch in ${rel}: ${m[1]}`);
    }
  }
});

test("Health endpoint returns 200 OK with no-store and CORS headers", async () => {
  const res = await worker.fetch(new Request("http://localhost/health"), { API_VERSION: "2.3" });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("cache-control"), "no-store");
  assert.equal(res.headers.get("access-control-allow-origin"), "*");
  const body = await res.json();
  assert.equal(body.status, "ok");
  assert.equal(body.providers, 12);
  assert.equal(typeof body.timestamp, "string");
});

test("OPTIONS preflight returns 204 with CORS headers and POST returns 405", async () => {
  const opt = await worker.fetch(new Request("http://localhost/health", { method: "OPTIONS" }), {});
  assert.equal(opt.status, 204);
  assert.equal(opt.headers.get("access-control-allow-origin"), "*");

  const post = await worker.fetch(new Request("http://localhost/map/16498", { method: "POST" }), {});
  assert.equal(post.status, 405);
  assert.equal(post.headers.get("cache-control"), "no-store");
});

test("API root metadata returns all 12 providers and /health route", async () => {
  const res = await worker.fetch(new Request("http://localhost/"), { API_VERSION: "2.3" });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.providers.length, 12);
  assert.ok(body.routes.includes("/health"));
  assert.ok(body.providers.includes("animedunya"));
});

test("Input validation rejects invalid anime IDs and invalid episode IDs with 400/404", async () => {
  const cases = [
    ["/map/abc", 400],
    ["/map/0", 400],
    ["/map/-10", 400],
    ["/episodes/abc", 400],
    ["/episodes/0", 400],
    ["/episodes/animedunya/abc", 400],
    ["/episodes/notaprovider/16498", 400],
    ["/watch/animedunya/abc/sub/animedunya-1", 400],
    ["/watch/animedunya/0/sub/animedunya-1", 400],
    ["/watch/animedunya/16498/sub/animedunya-0", 400],
    ["/watch/animedunya/16498/sub/animedunya-xyz", 400],
    ["/watch/animedunya/16498/raw/animedunya-1", 400],
    ["/stream/reanime/16498/sub/0", 400],
    ["/watch/unknownprovider/16498/sub/unknownprovider-1", 404],
    ["/nonexistent-route", 404],
  ];

  for (const [route, expectedStatus] of cases) {
    const res = await worker.fetch(new Request(`http://localhost${route}`), { API_VERSION: "2.3" });
    assert.equal(res.status, expectedStatus, `Expected ${expectedStatus} for ${route}, got ${res.status}`);
    assert.equal(res.headers.get("cache-control"), "no-store", `Error route ${route} must not be cached`);
    const body = await res.json();
    assert.equal(typeof body.error, "string");
    assert.equal("stack" in body, false, `Stack trace leaked on ${route}`);
  }
});

test("GET /map/:anilistId maps IDs cleanly and falls back to AniList idMal when ARM lacks it", async () => {
  await withMockFetch(async (input) => {
    const url = String(input);
    if (url.includes("arm.haglund.dev")) {
      return makeJsonRes({ anilist: 16498, kitsu: 7442, thetvdb: 267440, themoviedb: 1429, imdb: "tt2560140" });
    }
    if (url.includes("graphql.anilist.co")) {
      return makeJsonRes({
        data: {
          Media: {
            id: 16498,
            idMal: 16498,
            title: { english: "Attack on Titan", romaji: "Shingeki no Kyojin", native: "進撃の巨人" },
            status: "FINISHED",
            format: "TV",
            episodes: 25,
            seasonYear: 2013,
            startDate: { year: 2013 },
            genres: ["Action"],
            synonyms: ["AoT"],
            relations: { edges: [] },
          },
        },
      });
    }
    return makeTextRes("not found", 404);
  }, async () => {
    const res = await worker.fetch(new Request("http://localhost/map/16498"), { API_VERSION: "2.3" });
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.mappings.id, 16498);
    assert.equal(data.mappings.malId, 16498);
    assert.equal(data.mappings.kitsuId, 7442);
    assert.equal(data.mappings.thetvdbId, 267440);
    assert.equal(data.mappings.title, "Attack on Titan");
  });
});

test("GET /map/:anilistId returns 404 for nonexistent AniList ID without stack trace", async () => {
  await withMockFetch(async (input) => {
    const url = String(input);
    if (url.includes("arm.haglund.dev")) return makeTextRes("Not found", 404);
    if (url.includes("graphql.anilist.co")) {
      return makeJsonRes({ data: { Media: null }, errors: [{ message: "Not Found.", status: 404 }] }, 404);
    }
    return makeTextRes("Not found", 404);
  }, async () => {
    const res = await worker.fetch(new Request("http://localhost/map/999999999"), { API_VERSION: "2.3" });
    assert.equal(res.status, 404);
    const data = await res.json();
    assert.equal(typeof data.error, "string");
    assert.equal("stack" in data, false);
  });
});

test("core/http fetchWithRetry retries transient 503 once and respects timeout", async () => {
  let calls = 0;
  const res = await fetchWithRetry("https://example.test/retry", {
    retries: 1,
    retryDelayMs: 10,
    timeoutMs: 1000,
    fetchImpl: async () => {
      calls++;
      if (calls === 1) return makeTextRes("Service Unavailable", 503);
      return makeJsonRes({ ok: true }, 200);
    },
  });
  assert.equal(calls, 2);
  assert.equal(res.status, 200);

  await assert.rejects(
    () =>
      fetchWithRetry("https://example.test/slow", {
        retries: 0,
        timeoutMs: 30,
        label: "SlowProvider",
        fetchImpl: (_url, init) =>
          new Promise((_resolve, reject) => {
            init.signal.addEventListener("abort", () => reject(init.signal.reason));
          }),
      }),
    (err) => err.isTimeout === true && /timed out/i.test(err.message)
  );
});

test("core/http utilities: mapWithConcurrency, withTimeout, normalizeUrl", async () => {
  let active = 0;
  let peak = 0;
  const out = await mapWithConcurrency([1, 2, 3, 4, 5, 6], 2, async (item) => {
    active++;
    peak = Math.max(peak, active);
    await new Promise((r) => setTimeout(r, 10));
    active--;
    return item * 10;
  });
  assert.deepEqual(out, [10, 20, 30, 40, 50, 60]);
  assert.ok(peak <= 2);

  await assert.rejects(
    () => withTimeout(new Promise((r) => setTimeout(r, 200)), 25, "HungProvider"),
    (err) => err.isTimeout === true
  );

  assert.equal(normalizeUrl("//cdn.example.com/a.m3u8"), "https://cdn.example.com/a.m3u8");
  assert.equal(normalizeUrl("/subs/en.vtt", "https://example.com"), "https://example.com/subs/en.vtt");
  assert.equal(normalizeUrl("javascript:alert(1)"), null);
  assert.equal(normalizeUrl(""), null);
});

test("extractors/megaplay handles null failed script fetches without TypeError crash", async () => {
  const mockFetch = async (url) => {
    const href = String(url);
    if (href.includes("stream/getSources")) {
      return makeJsonRes({
        sources: { file: "https://cdn.example.com/video/master.m3u8" },
        tracks: [{ file: "https://cdn.example.com/en.vtt", label: "English" }],
      });
    }
    if (href.includes("/stream/")) {
      return makeTextRes(
        `<html><body><div data-id="abc123"></div><script src="/broken.js"></script><script src="/player.js"></script></body></html>`,
        200
      );
    }
    if (href.includes("broken.js")) {
      return makeTextRes("Not Found", 404);
    }
    if (href.includes("player.js")) {
      return makeTextRes(
        `var x = "stream/getSources"; var algo = "AES-CBC";`,
        200,
        { "Content-Type": "application/javascript" }
      );
    }
    return makeTextRes("Not found", 404);
  };

  const details = await extractMegaPlayDetails("https://megaplay.buzz/stream/s-2/123/sub", {
    fetchImpl: mockFetch,
  });
  assert.equal(details.sources.length, 1);
  assert.equal(details.sources[0].url, "https://cdn.example.com/video/master.m3u8");
});

test("MKissa /captcha/mkissa blocks invalid next paths and escapes XSS payloads", async () => {
  const malicious = encodeURIComponent('/watch/mkissa/</script><script>alert(1)</script>');
  const res = await mkissaHandler.fetch(new Request(`http://localhost/captcha/mkissa?next=${malicious}`));
  assert.equal(res.status, 200);
  const html = await res.text();
  assert.equal(html.includes("<script>alert(1)</script>"), false);
  assert.ok(html.includes('const next="";'));

  const valid = encodeURIComponent("/watch/mkissa/16498/sub/mkissa-1");
  const res2 = await mkissaHandler.fetch(new Request(`http://localhost/captcha/mkissa?next=${valid}`));
  const html2 = await res2.text();
  assert.ok(html2.includes('const next="/watch/mkissa/16498/sub/mkissa-1";'));
});
