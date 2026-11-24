import {
  getAsync, setAsync, isFresh, needsRefresh,
  episodeTTL,
} from "./smartcache.js";
import {
  DEFAULT_PROVIDER_TIMEOUT_MS,
  mapWithConcurrency,
  sanitizeErrorMessage,
  withTimeout,
} from "./http.js";
import { getEpisodes as mkissaEpisodes } from "../providers/mkissa.js";
import { getEpisodes as reanimeEpisodes } from "../providers/reanime.js";
import { getEpisodes as anikotoEpisodes } from "../providers/anikoto.js";
import { getEpisodes as animeggEpisodes } from "../providers/animegg.js";
import { getEpisodes as animenosubEpisodes } from "../providers/animenosub.js";
import { getEpisodes as anizoneEpisodes } from "../providers/anizone.js";
import { getEpisodes as aniwavesEpisodes } from "../providers/aniwaves.js";
import { getEpisodes as senshiEpisodes } from "../providers/senshi.js";
import { getEpisodes as kaaEpisodes } from "../providers/kickassanime.js";
import { getEpisodes as animedunyaEpisodes } from "../providers/animedunya.js";
import { getEpisodes as animeonsenEpisodes } from "../providers/animeonsen.js";
import { getEpisodes as anipmEpisodes } from "../providers/anipm.js";

const inflight = new Map();
const bgRunning = new Set();

function dedupe(key, fn) {
  if (inflight.has(key)) return inflight.get(key);
  const p = Promise.resolve().then(fn).finally(() => inflight.delete(key));
  inflight.set(key, p);
  return p;
}

function bg(key, fn) {
  if (bgRunning.has(key)) return;
  bgRunning.add(key);
  Promise.resolve()
    .then(fn)
    .catch((e) => console.error(`[bg:${key}]`, e?.message ?? String(e)))
    .finally(() => bgRunning.delete(key));
}

async function withCache(key, status, fetchFn) {
  const [ttl, refreshAfter] = episodeTTL(status);
  const entry = await getAsync(key);

  if (isFresh(entry)) {
    if (needsRefresh(entry)) {
      bg(key, async () => {
        const data = await dedupe(key, fetchFn);
        await setAsync(key, data, ttl, refreshAfter);
      });
    }
    return entry.data;
  }

  const data = await dedupe(key, fetchFn);
  await setAsync(key, data, ttl, refreshAfter);
  return data;
}

function orderEpisodeFields(data) {
  if (!data?.episodes || typeof data.episodes !== "object") return data;
  const episodes = Object.fromEntries(Object.entries(data.episodes).map(([audio, list]) => [
    audio,
    Array.isArray(list)
      ? list.map(({ id, audio: itemAudio, sourceNumber, ...episode }) => ({
        ...(id === undefined ? {} : { id }),
        ...(sourceNumber === undefined ? {} : { sourceNumber }),
        ...(itemAudio === undefined ? {} : { audio: itemAudio }),
        ...episode,
      }))
      : list,
  ]));
  return { ...data, episodes };
}

async function safe(label, fn) {
  try {
    const data = await withTimeout(fn(), DEFAULT_PROVIDER_TIMEOUT_MS, `${label} episodes`);
    return { ok: true, data: orderEpisodeFields(data) };
  } catch (e) {
    console.error(`[ep:${label}]`, e?.message ?? String(e));
    return { ok: false, error: sanitizeErrorMessage(e, `${label} provider unavailable`) };
  }
}

export const ALL_PROVIDERS = [
  "mkissa",
  "reanime",
  "anikoto",
  "animegg",
  "animenosub",
  "anizone",
  "aniwaves",
  "senshi",
  "kaa",
  "animedunya",
  "animeonsen",
  "anipm",
];

const PROVIDER_ALIASES = Object.fromEntries(ALL_PROVIDERS.map((p) => [p, p]));

export function resolveProviders(rawNames) {
  const resolved = new Set();
  const unknown = [];
  for (const raw of rawNames) {
    const name = PROVIDER_ALIASES[String(raw).toLowerCase()];
    if (name) resolved.add(name);
    else unknown.push(raw);
  }
  return { resolved, unknown };
}

function providerFns(anilistId, status, ctx) {
  return {
    mkissa:     () => withCache(`epv:match2:mkissa:${anilistId}`,     status, () => mkissaEpisodes(anilistId, ctx)),
    reanime:    () => withCache(`epv:match2:reanime:${anilistId}`,    status, () => reanimeEpisodes(anilistId, ctx)),
    anikoto:    () => withCache(`epv:match2:anikoto:${anilistId}`,    status, () => anikotoEpisodes(anilistId, ctx)),
    animegg:    () => withCache(`epv:match2:animegg:${anilistId}`,    status, () => animeggEpisodes(anilistId, ctx)),
    animenosub: () => withCache(`epv:match2:animenosub:${anilistId}`, status, () => animenosubEpisodes(anilistId, ctx)),
    anizone:    () => withCache(`epv:match2:anizone:${anilistId}`,    status, () => anizoneEpisodes(anilistId, ctx)),
    aniwaves:   () => withCache(`epv:match2:aniwaves:${anilistId}`,   status, () => aniwavesEpisodes(anilistId, ctx)),
    senshi:     () => withCache(`epv:senshi:${anilistId}`,            status, () => senshiEpisodes(anilistId, ctx)),
    kaa:        () => withCache(`epv:match2:kaa:${anilistId}`,        status, () => kaaEpisodes(anilistId, ctx)),
    animedunya: () => withCache(`epv:animedunya:${anilistId}`,        status, () => animedunyaEpisodes(anilistId, ctx)),
    animeonsen: () => withCache(`epv:match2:animeonsen:${anilistId}`, status, () => animeonsenEpisodes(anilistId, ctx)),
    anipm:      () => withCache(`epv:match2:anipm:${anilistId}`,      status, () => anipmEpisodes(anilistId, ctx)),
  };
}

const EPISODE_PROVIDER_CONCURRENCY = 6;

export async function buildFilteredEpisodesWithCache(anilistId, providers, media, anizip) {
  const status = media?.status ?? "RELEASING";
  const ctx = { media, anizip, maxPages: undefined };
  const fns = providerFns(anilistId, status, ctx);
  const providerList = [...providers].filter((name) => typeof fns[name] === "function");

  const pairs = await mapWithConcurrency(providerList, EPISODE_PROVIDER_CONCURRENCY, async (name) => {
    const result = await safe(name, fns[name]);
    return [name, result.ok ? result.data : { error: result.error }];
  });

  return Object.fromEntries(pairs);
}

export async function buildEpisodesWithCache(anilistId, media, anizip) {
  const status = media?.status ?? "RELEASING";
  const ctx = { media, anizip, maxPages: undefined };
  const fns = providerFns(anilistId, status, ctx);

  const pairs = await mapWithConcurrency(ALL_PROVIDERS, EPISODE_PROVIDER_CONCURRENCY, async (name) => {
    const result = await safe(name, fns[name]);
    return [name, result.ok ? result.data : { error: result.error }];
  });

  return Object.fromEntries(pairs);
}
