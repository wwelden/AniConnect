#!/usr/bin/env bun
/**
 * Snapshots AniList's community recommendations (Media.recommendations, most rated first)
 * for every show in test/fixtures/media.json into test/fixtures/recommendations.json, for
 * the fake AniList. Keeps the edges that point at a show in the snapshot, and nodes whose
 * recommended show AniList returns as null; others point at shows the fake doesn't know.
 * Uses only public, unauthenticated queries.
 *
 *   bun scripts/snapshot-recommendations.ts
 */
import { ANILIST_ENDPOINT } from "../src/anilist";
import catalog from "../test/fixtures/media.json";

/** Recommendations read per show: AniList's first page. */
const PER_SHOW = 25;
/** Shows per request, to stay under AniList's query complexity limit. */
const BATCH = 10;

type Node = { rating: number; mediaRecommendation: { id: number } | null };

const ids = catalog.map((m) => m.id);
const known = new Set(ids);
const out: Record<string, { id: number | null; rating: number }[]> = {};

for (let i = 0; i < ids.length; i += BATCH) {
  const res = await fetch(ANILIST_ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({
      query: `query ($ids: [Int]) { Page(perPage: 50) { media(id_in: $ids, type: ANIME) {
        id recommendations(sort: [RATING_DESC], perPage: ${PER_SHOW}) { nodes { rating mediaRecommendation { id } } }
      } } }`,
      variables: { ids: ids.slice(i, i + BATCH) },
    }),
  });
  const body = (await res.json()) as { data?: { Page: { media: { id: number; recommendations: { nodes: Node[] } }[] } }; errors?: unknown };
  if (!body.data) throw new Error(JSON.stringify(body.errors));
  for (const m of body.data.Page.media) {
    const edges = m.recommendations.nodes
      .filter((n) => n.mediaRecommendation === null || known.has(n.mediaRecommendation.id))
      .map((n) => ({ id: n.mediaRecommendation?.id ?? null, rating: n.rating }));
    if (edges.length) out[m.id] = edges;
  }
  // Stay well under the rate limit.
  await Bun.sleep(2500);
}

await Bun.write(new URL("../test/fixtures/recommendations.json", import.meta.url), `${JSON.stringify(out, null, 1)}\n`);
console.log(`${Object.keys(out).length} shows with recommendations inside the snapshot`);
