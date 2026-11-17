/**
 * Lists of thousands of shows (R5.3). AniList returns a whole list in one request (2,752
 * entries: 2 MB in 1.6 s, measured 2026-11-17), so what's left to check is that resolving a
 * name over that many titles stays fast and still finds the right season.
 */
import { describe, expect, test } from "bun:test";
import { AniListClient, type Media } from "../src/anilist";
import { resolveAnime, type AnimeSource } from "../src/resolve";
import { clientSource } from "../src/server";
import { PERSONA } from "./fixtures/persona";
import { FakeAniList, findMedia } from "./support/fake-anilist";

const WORDS = [
  "sword", "magic", "academy", "dragon", "girl", "hero", "world", "love", "summer", "star", "ghost", "king",
  "blade", "night", "spirit", "battle", "school", "dream", "princess", "demon", "sky", "moon", "legend", "tale",
];

/** `count` made-up shows on the list, titled from common anime words so they compete for matches. */
function filler(count: number): Media[] {
  return Array.from({ length: count }, (_, i) => {
    const title = [WORDS[i % 24], WORDS[Math.floor(i / 24) % 24], WORDS[Math.floor(i / 576) % 24]].join(" ");
    return {
      id: 10_000_000 + i,
      title: { romaji: `${title} ${i}`, english: null, native: null },
      synonyms: [],
      episodes: 12,
      duration: 24,
      format: "TV",
      status: "FINISHED",
      seasonYear: 2000 + (i % 25),
      startDate: { year: 2000 + (i % 25), month: 1, day: 1 },
      averageScore: 70,
      siteUrl: "",
      nextAiringEpisode: null,
      mediaListEntry: {
        id: i,
        status: "COMPLETED",
        progress: 12,
        score: 0,
        displayScore: 0,
        startedAt: { year: null, month: null, day: null },
        completedAt: { year: null, month: null, day: null },
      },
    };
  });
}

describe("a list of 3,000 shows (R5.3)", async () => {
  const persona = clientSource(new AniListClient("t", new FakeAniList().seed(PERSONA).fetch));
  const list = [...(await persona.listMedia()), ...filler(3000)];
  const source: AnimeSource = { ...persona, listMedia: async () => list };

  test.each([
    ["jjk", "progress", "Jujutsu Kaisen 2nd Season"],
    ["frieran", "rate", "Sousou no Frieren"],
    ["attack on titan season 3 part 2", "rate", "Shingeki no Kyojin Season 3 Part 2"],
    ["spy x family season 2", "progress", "SPY×FAMILY Season 2"],
  ] as const)('"%s" (%s) still finds %s, quickly', async (query, intent, expected) => {
    const start = performance.now();
    const r = await resolveAnime(query, intent, source, "ENGLISH");
    const ms = performance.now() - start;
    if (r.kind !== "match") throw new Error(`expected a match, got ${r.kind}: ${r.why}`);
    expect(r.media.id).toBe(findMedia(expected).id);
    // About 50 ms on a laptop; the bound leaves room for slow CI machines.
    expect(ms).toBeLessThan(1000);
  });
});
