const __name = (fn, _) => fn;
import { getMedia } from "./anilist.js";
import { fetchWithRetry, isPositiveIntId, parseJsonSafe } from "./http.js";

var ARM2 = "https://arm.haglund.dev/api/v2/ids";
var UA2 = "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:109.0) Gecko/20100101 Firefox/121.0";

function hashFranchiseId(str) {
  let h = 0;
  for (let i = 0; i < str.length; i++) {
    h = (h << 5) - h + str.charCodeAt(i) | 0;
  }
  return h >>> 0;
}
__name(hashFranchiseId, "hashFranchiseId");

async function fetchARM(anilistId) {
  const res = await fetchWithRetry(`${ARM2}?source=anilist&id=${anilistId}`, {
    timeoutMs: 8_000,
    retries: 1,
    headers: { "User-Agent": UA2, "Accept": "application/json" },
  }).catch(() => null);
  if (!res || !res.ok) return null;
  const raw = await res.text().catch(() => "");
  if (!raw) return null;
  try {
    return parseJsonSafe(raw, "ARM");
  } catch {
    return null;
  }
}
__name(fetchARM, "fetchARM");

async function fetchAniListRelations(anilistId) {
  const q = `
  query ($id: Int) {
    Media(id: $id, type: ANIME) {
      id synonyms
      relations {
        edges {
          relationType(version: 2)
          node {
            id type format title { romaji english native }
            relations {
              edges {
                relationType(version: 2)
                node { id type format title { romaji english native } }
              }
            }
          }
        }
      }
    }
  }`;
  try {
    const res = await fetchWithRetry("https://graphql.anilist.co", {
      method: "POST",
      timeoutMs: 10_000,
      retries: 1,
      headers: { "Content-Type": "application/json", "Accept": "application/json", "User-Agent": UA2 },
      body: JSON.stringify({ query: q, variables: { id: Number(anilistId) } }),
    });
    if (!res.ok) return null;
    const raw = await res.text();
    const json6 = parseJsonSafe(raw, "AniList relations");
    return json6.data?.Media ?? null;
  } catch {
    return null;
  }
}
__name(fetchAniListRelations, "fetchAniListRelations");

async function mapAnimeIds(anilistId) {
  if (!isPositiveIntId(anilistId)) {
    const err = new Error(`Invalid AniList ID: ${anilistId}`);
    err.httpStatus = 400;
    throw err;
  }

  let mediaNotFound = false;
  const [arm, media, alRelations] = await Promise.all([
    fetchARM(anilistId),
    getMedia(anilistId).catch((e) => {
      if (e?.httpStatus === 404) mediaNotFound = true;
      return null;
    }),
    fetchAniListRelations(anilistId),
  ]);

  if (!arm && !media && !alRelations) {
    const err = new Error(`No mapping found for AniList ID ${anilistId}`);
    err.httpStatus = mediaNotFound ? 404 : 502;
    throw err;
  }

  const malId = arm?.myanimelist ?? media?.idMal ?? null;
  const format = media?.format ?? null;
  const titleEn = media?.title?.english || null;
  const titleRom = media?.title?.romaji || null;
  const synonyms = [...(media?.synonyms ?? [])];
  if (Array.isArray(alRelations?.synonyms)) {
    for (const s of alRelations.synonyms) {
      if (s && !synonyms.includes(s)) synonyms.push(s);
    }
  }
  const franchiseMap = new Map();
  if (Array.isArray(alRelations?.relations?.edges)) {
    for (const e1 of alRelations.relations.edges) {
      const node1 = e1?.node;
      if (!node1?.id) continue;
      if (!franchiseMap.has(node1.id)) {
        franchiseMap.set(node1.id, {
          relation: e1.relationType,
          anilistId: node1.id,
          title: node1.title?.romaji || node1.title?.english || null,
          type: node1.type ?? null,
          format: node1.format ?? null,
        });
      }
      if (Array.isArray(node1.relations?.edges)) {
        for (const e2 of node1.relations.edges) {
          const node2 = e2?.node;
          if (!node2?.id || node2.id === Number(anilistId)) continue;
          if (!franchiseMap.has(node2.id)) {
            franchiseMap.set(node2.id, {
              relation: e2.relationType,
              anilistId: node2.id,
              title: node2.title?.romaji || node2.title?.english || null,
              type: node2.type ?? null,
              format: node2.format ?? null,
            });
          }
        }
      }
    }
  }
  const thetvdbId = arm?.thetvdb ?? null;
  const themoviedbId = arm?.themoviedb ?? null;
  const imdbId = arm?.imdb ?? null;
  return {
    mappings: {
      id: Number(anilistId),
      title: titleEn || titleRom,
      type: arm?.media ?? null,
      format,
      episodes: media?.episodes ?? null,
      malId,
      aniId: Number(anilistId),
      anidbId: arm?.anidb ?? null,
      animePlanetId: arm?.["anime-planet"] ?? null,
      kitsuId: arm?.kitsu ?? null,
      animeCountdownId: arm?.animecountdown ?? null,
      anisearchId: arm?.anisearch ?? null,
      notifyMoeId: null,
      simklId: arm?.simkl ?? null,
      imdbId,
      themoviedbId,
      thetvdbId,
      livechartId: arm?.livechart ?? null,
      annId: arm?.animenewsnetwork ?? null,
      animescheduleId: null,
      animethemesId: null,
      animefillerlistId: null,
      franchiseAnchor: thetvdbId ? `tvdb:${thetvdbId}` : null,
      franchiseId: thetvdbId ? hashFranchiseId(`tvdb:${thetvdbId}`) : null,
      defaultTvdbSeason: arm?.["thetvdb-season"] != null ? String(arm["thetvdb-season"]) : null,
      tmdbSeason: arm?.["themoviedb-season"] != null ? String(arm["themoviedb-season"]) : null,
      episodeOffset: null,
      tmdbOffset: null,
      malIds: null,
      aniskip: null,
      animefillerlist: null,
      synonyms,
      franchise: Array.from(franchiseMap.values()),
    },
  };
}
__name(mapAnimeIds, "mapAnimeIds");

export { mapAnimeIds };
