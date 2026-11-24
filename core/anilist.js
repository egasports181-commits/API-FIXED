import { fetchWithRetry, isPositiveIntId, parseJsonSafe, withTimeout } from "./http.js";

const __name = (fn, _) => fn;

const MAX_RESOLVED = 500;
const TTL_AIRING_MS = 10 * 60_000;
const TTL_FINISHED_MS = 60 * 60_000;

var resolved = new Map();
var inflight = new Map();
var UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";
var ARM = "https://arm.haglund.dev/api/v2/ids";
var ANILIST_WEB = "https://anilist.co";

const AL_STATUS_MAP = {
  RELEASING: "RELEASING",
  FINISHED: "FINISHED",
  NOT_YET_RELEASED: "NOT_YET_RELEASED",
  CANCELLED: "FINISHED",
  HIATUS: "HIATUS",
};

function cookiesFromHeaders(headers) {
  const values = typeof headers.getSetCookie === "function" ? headers.getSetCookie() : [headers.get("set-cookie")].filter(Boolean);
  return values.map((value) => String(value).split(";")[0]).join("; ");
}

async function mediaFromResponse(res) {
  if (!res) return { media: null, notFound: false };
  if (res.status === 404) return { media: null, notFound: true };
  if (!res.ok) return { media: null, notFound: false };
  try {
    const raw = await withTimeout(res.text(), 8_000, "AniList body");
    const json = parseJsonSafe(raw, "AniList");
    if (json?.data?.Media) return { media: json.data.Media, notFound: false };
    const isNotFound = Array.isArray(json?.errors) && json.errors.some((e) => e?.status === 404 || /not found/i.test(String(e?.message ?? "")));
    return { media: null, notFound: isNotFound };
  } catch {
    return { media: null, notFound: false };
  }
}

async function fetchFromAniListWeb(body) {
  const home = await fetchWithRetry(`${ANILIST_WEB}/`, {
    timeoutMs: 8_000,
    retries: 0,
    headers: { "User-Agent": UA, Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8" },
  }).catch(() => null);
  if (!home?.ok) return { media: null, notFound: false };
  const html = await withTimeout(home.text(), 8_000, "AniList web home").catch(() => "");
  const token = html.match(/window\.al_token\s*=\s*"([^"]+)"/)?.[1];
  const cookie = cookiesFromHeaders(home.headers);
  if (!token || !cookie) return { media: null, notFound: false };
  const res = await fetchWithRetry(`${ANILIST_WEB}/graphql`, {
    method: "POST",
    timeoutMs: 8_000,
    retries: 0,
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
      "User-Agent": UA,
      Referer: `${ANILIST_WEB}/home`,
      "x-csrf-token": token,
      schema: "default",
      Cookie: cookie,
    },
    body,
  }).catch(() => null);
  return mediaFromResponse(res);
}

async function fetchFromAniList(id) {
  const fullQuery = `query($id:Int){Media(id:$id,type:ANIME){id idMal title{english romaji native} status format episodes seasonYear startDate{year} genres synonyms nextAiringEpisode{episode airingAt timeUntilAiring}}}`;
  const body = JSON.stringify({ query: fullQuery, variables: { id } });
  let timedOut = false;
  let res = null;
  try {
    res = await fetchWithRetry("https://graphql.anilist.co", {
      method: "POST",
      label: "AniList",
      timeoutMs: 10_000,
      retries: 1,
      headers: { "Content-Type": "application/json", "Accept": "application/json", "User-Agent": UA },
      body,
    });
  } catch (err) {
    if (err?.isTimeout) timedOut = true;
  }
  const primary = await mediaFromResponse(res);
  if (primary.media || primary.notFound) return primary;
  if (timedOut) return { media: null, notFound: false, timedOut: true };
  return fetchFromAniListWeb(body);
}

function getCachedMedia(id) {
  const entry = resolved.get(id);
  if (!entry) return null;
  if (Date.now() < entry.expiresAt) return entry.data;
  resolved.delete(id);
  return null;
}

function setCachedMedia(id, media) {
  if (resolved.size >= MAX_RESOLVED) {
    const oldest = resolved.keys().next().value;
    if (oldest !== undefined) resolved.delete(oldest);
  }
  const ttl = media.status === "FINISHED" ? TTL_FINISHED_MS : TTL_AIRING_MS;
  resolved.set(id, { data: media, expiresAt: Date.now() + ttl });
}

async function getMedia(anilistId) {
  if (!isPositiveIntId(anilistId)) {
    const err = new Error(`Invalid AniList ID: ${anilistId}`);
    err.httpStatus = 400;
    throw err;
  }
  const id = Number(anilistId);
  const cached = getCachedMedia(id);
  if (cached) return cached;
  if (inflight.has(id)) return inflight.get(id);

  const promise = (async () => {
    const [arm, alResult] = await Promise.all([
      fetchWithRetry(`${ARM}?source=anilist&id=${id}`, {
        timeoutMs: 6_000,
        retries: 0,
        headers: { "User-Agent": UA, "Accept": "application/json" },
      })
        .then(async (r) => (r.ok ? parseJsonSafe(await r.text(), "ARM") : null))
        .catch(() => null),
      fetchFromAniList(id),
    ]);

    const al = alResult?.media ?? null;
    if (!al) {
      if (alResult?.timedOut) {
        const err = new Error(`AniList timed out for ID ${id}`);
        err.isTimeout = true;
        err.httpStatus = 504;
        throw err;
      }
      const err = new Error(`No data found for AniList ID ${id}`);
      if (alResult?.notFound) err.httpStatus = 404;
      throw err;
    }

    const media = {
      id,
      idMal: al.idMal ?? arm?.myanimelist ?? null,
      title: {
        english: al.title?.english ?? null,
        romaji: al.title?.romaji ?? null,
        native: al.title?.native ?? null,
      },
      status: AL_STATUS_MAP[al.status] ?? "RELEASING",
      format: al.format ?? null,
      episodes: al.episodes ?? null,
      seasonYear: al.seasonYear ?? null,
      startDate: al.startDate ?? null,
      genres: Array.isArray(al.genres) ? al.genres : [],
      nextAiringEpisode: al.nextAiringEpisode ?? null,
      synonyms: Array.isArray(al.synonyms) ? al.synonyms : [],
    };
    setCachedMedia(id, media);
    return media;
  })().finally(() => {
    inflight.delete(id);
  });

  inflight.set(id, promise);
  return promise;
}
__name(getMedia, "getMedia");

function forgetMedia(anilistId) {
  resolved.delete(Number(anilistId));
}

function clearMediaCache() {
  resolved.clear();
}

export { getMedia, forgetMedia, clearMediaCache };
