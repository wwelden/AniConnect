#!/usr/bin/env bun
/**
 * Snapshots real AniList metadata for franchises that are hard to resolve by name
 * (many seasons, split cours, movies, sequels whose titles drop the number) into
 * test/fixtures/media.json. Uses only public, unauthenticated queries.
 *
 *   bun scripts/snapshot-fixtures.ts
 */
import { ANILIST_ENDPOINT } from "../src/anilist";

const SEEDS = [
  "Jujutsu Kaisen",
  "SPY×FAMILY",
  "Shingeki no Kyojin",
  "Sousou no Frieren",
  "Dandadan",
  "ONE PIECE",
  "Mob Psycho 100",
  "Bocchi the Rock!",
  "Oshi no Ko",
  "Kaguya-sama wa Kokurasetai: Tensai-tachi no Renai Zunousen",
  "Boku no Hero Academia",
  "Kimetsu no Yaiba",
  "Chainsaw Man",
  "Haikyuu!!",
  "Re:Zero kara Hajimeru Isekai Seikatsu",
  "Vinland Saga",
  "Kusuriya no Hitorigoto",
  "Steins;Gate",
  "Monogatari",
  "Mushoku Tensei",
  "Tensei shitara Slime Datta Ken",
  "Fullmetal Alchemist",
  "Hunter x Hunter",
  "Naruto",
  // An adult (18+) title, for the tests that keep adult titles out of search.
  "A KITE",
];

/** Relations followed when collecting a franchise. */
const FOLLOW = new Set(["SEQUEL", "PREQUEL", "PARENT", "SIDE_STORY", "ALTERNATIVE"]);
const MAX_PER_FRANCHISE = 14;

const FIELDS = `
  id
  title { romaji english native }
  synonyms
  episodes
  duration
  format
  status
  isAdult
  season
  genres
  seasonYear
  startDate { year month day }
  averageScore
  popularity
  siteUrl
  nextAiringEpisode { episode airingAt }
  externalLinks { site url type notes isDisabled }
  description
  source(version: 3)
  studios { edges { isMain node { id name } } }
  tags { name rank isMediaSpoiler isGeneralSpoiler }
  relations { edges { relationType node { id type } } }
`;

/**
 * Tags kept per show, the highest ranked (AniList sends them by rank). Answers use a few of
 * the top ones; every tag would double the fixture.
 */
const MAX_TAGS = 10;

async function gql<T>(query: string, variables: Record<string, unknown>): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(ANILIST_ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ query, variables }),
    });
    if (res.status === 429 && attempt < 5) {
      const wait = Number(res.headers.get("Retry-After") ?? 60);
      console.error(`rate limited, waiting ${wait}s`);
      await Bun.sleep(wait * 1000);
      continue;
    }
    const body = (await res.json()) as { data?: T; errors?: { message: string }[] };
    if (body.errors?.length) throw new Error(body.errors.map((e) => e.message).join("; "));
    // Stay well under the rate limit.
    await Bun.sleep(1200);
    return body.data as T;
  }
}

type Media = {
  id: number;
  format: string | null;
  tags: unknown[];
  relations: { edges: { relationType: string; node: { id: number; type: string } }[] };
  [key: string]: unknown;
};

const all = new Map<number, Media & { franchise: string }>();

for (const seed of SEEDS) {
  const { Page } = await gql<{ Page: { media: Media[] } }>(
    `query ($s: String) { Page(perPage: 1) { media(search: $s, type: ANIME, sort: SEARCH_MATCH) { ${FIELDS} } } }`,
    { s: seed },
  );
  const root = Page.media[0];
  if (!root) {
    console.error(`no match for ${seed}`);
    continue;
  }
  const franchise = seed;
  let frontier = [root];
  const seen = new Set<number>([root.id]);
  all.set(root.id, { ...root, franchise });

  while (frontier.length && seen.size < MAX_PER_FRANCHISE) {
    const next = new Set<number>();
    for (const m of frontier) {
      for (const edge of m.relations.edges) {
        if (edge.node.type === "ANIME" && FOLLOW.has(edge.relationType) && !seen.has(edge.node.id)) {
          next.add(edge.node.id);
        }
      }
    }
    const ids = [...next].slice(0, MAX_PER_FRANCHISE - seen.size);
    if (!ids.length) break;
    const { Page: page } = await gql<{ Page: { media: Media[] } }>(
      `query ($ids: [Int]) { Page(perPage: 50) { media(id_in: $ids, type: ANIME) { ${FIELDS} } } }`,
      { ids },
    );
    frontier = page.media;
    for (const m of page.media) {
      seen.add(m.id);
      if (!all.has(m.id)) all.set(m.id, { ...m, franchise });
    }
  }
  console.error(`${seed}: ${seen.size} entries`);
}

const out = [...all.values()].sort((a, b) => a.id - b.id).map((m) => ({ ...m, tags: m.tags.slice(0, MAX_TAGS) }));
await Bun.write(
  new URL("../test/fixtures/media.json", import.meta.url),
  JSON.stringify(out, null, 1) + "\n",
);
console.error(`wrote ${out.length} media`);
