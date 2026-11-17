/**
 * Deterministic resolver cases (requirement R6.2): request text + a realistic list
 * -> the AniList entry it should resolve to, or "ambiguous".
 */
import { beforeEach, describe, expect, test } from "bun:test";
import { AniListClient } from "../src/anilist";
import { parseQuery, resolveAnime, type Intent } from "../src/resolve";
import { clientSource } from "../src/server";
import { PERSONA } from "./fixtures/persona";
import { FakeAniList, findMedia } from "./support/fake-anilist";

let fake: FakeAniList;
let client: AniListClient;

beforeEach(() => {
  fake = new FakeAniList().seed(PERSONA);
  client = new AniListClient("test", fake.fetch);
});

async function resolve(query: string, intent: Intent) {
  return resolveAnime(query, intent, clientSource(client));
}

/** [query, intent, expected romaji title | "ambiguous" | "none"] */
type Case = [string, Intent, string];

function run(cases: Case[]) {
  for (const [query, intent, expected] of cases) {
    test(`${intent}: "${query}" -> ${expected}`, async () => {
      const r = await resolve(query, intent);
      if (expected === "ambiguous" || expected === "none") {
        expect(r.kind).toBe(expected);
      } else {
        if (r.kind !== "match") throw new Error(`expected a match, got ${r.kind}: ${r.why}`);
        expect(r.media.title.romaji ?? "").toBe(expected);
        expect(r.media.id).toBe(findMedia(expected).id);
      }
    });
  }
}

describe("parseQuery", () => {
  test.each([
    ["jjk", "jujutsu kaisen", {}],
    ["JJK season 2", "jujutsu kaisen", { season: 2 }],
    ["the second season of Spy x Family", "the of spy x family", { season: 2 }],
    ["Attack on Titan S3 part 2", "attack on titan", { season: 3, part: 2 }],
    ["mob psycho 100 3rd season", "mob psycho 100", { season: 3 }],
    ["chainsaw man movie", "chainsaw man", { movie: true }],
    ["the new Frieren season", "the frieren", { latest: true }],
    ["spy x family latest season", "spy x family", { latest: true }],
    ["next season of oshi no ko", "of oshi no ko", {}],
    ["New Game!", "new game", {}],
    ["Re:Zero 2nd cour", "re zero", { part: 2 }],
  ])("%s", (raw, exact, hint) => {
    const q = parseQuery(raw);
    expect(q.exact).toBe(exact);
    expect(q.hint).toEqual(hint);
  });
});

describe("episode updates go to the season being watched (R1.4)", () => {
  run([
    ["jjk", "progress", "Jujutsu Kaisen 2nd Season"],
    ["Jujutsu Kaisen", "progress", "Jujutsu Kaisen 2nd Season"],
    ["attack on titan", "progress", "Shingeki no Kyojin: The Final Season"],
    ["AoT", "progress", "Shingeki no Kyojin: The Final Season"],
    ["oshi no ko", "progress", "[Oshi no Ko] 2nd Season"],
    ["kaguya-sama", "progress", "Kaguya-sama wa Kokurasetai: Ultra Romantic"],
    ["Love is War", "progress", "Kaguya-sama wa Kokurasetai: Ultra Romantic"],
    ["spy x family", "progress", "SPY×FAMILY Season 2"],
    ["one piece", "progress", "ONE PIECE"],
    ["dandadan", "progress", "Dandadan"],
    ["mob psycho", "progress", "Mob Psycho 100 III"],
  ]);
});

describe("titles, abbreviations and typos (R1.1, R1.2)", () => {
  run([
    ["DAN DA DAN", "progress", "Dandadan"],
    ["dandadn", "progress", "Dandadan"],
    ["frieran", "rate", "Sousou no Frieren"],
    ["Frieren: Beyond Journey's End", "rate", "Sousou no Frieren"],
    ["spyxfamily", "progress", "SPY×FAMILY Season 2"],
    ["SPY×FAMILY", "progress", "SPY×FAMILY Season 2"],
    ["進撃の巨人", "progress", "Shingeki no Kyojin: The Final Season"],
    ["bocchi", "rate", "Bocchi the Rock!"],
  ]);
});

describe("seasons by name, number and part (R1.5)", () => {
  run([
    ["jjk season 2", "rate", "Jujutsu Kaisen 2nd Season"],
    ["jujutsu kaisen season 3", "add", "Jujutsu Kaisen: Shimetsu Kaiyuu - Zenpen"],
    ["spy x family season 2", "progress", "SPY×FAMILY Season 2"],
    ["the second season of spy x family", "rate", "SPY×FAMILY Season 2"],
    ["spy x family part 2", "rate", "SPY×FAMILY Part 2"],
    ["attack on titan season 2", "rate", "Shingeki no Kyojin Season 2"],
    ["attack on titan season 3 part 2", "rate", "Shingeki no Kyojin Season 3 Part 2"],
    ["attack on titan season 4", "progress", "Shingeki no Kyojin: The Final Season"],
    ["aot s4 part 2", "add", "Shingeki no Kyojin: The Final Season Part 2"],
    ["mob psycho 100 season 2", "rate", "Mob Psycho 100 II"],
    ["frieren season 2", "add", "Sousou no Frieren 2nd Season"],
    ["kaguya sama season 2", "rate", "Kaguya-sama wa Kokurasetai?: Tensaitachi no Renai Zunousen"],
    ["kaguya sama season 3", "progress", "Kaguya-sama wa Kokurasetai: Ultra Romantic"],
    ["my hero academia season 3", "add", "Boku no Hero Academia 3"],
    ["haikyuu season 4", "add", "Haikyuu!! TO THE TOP"],
    ["haikyuu season 3", "add", "Haikyuu!!: Karasuno Koukou VS Shiratorizawa Gakuen Koukou"],
    ["re zero season 2 part 2", "add", "Re:Zero kara Hajimeru Isekai Seikatsu 2nd Season Part 2"],
    ["mushoku tensei season 2", "add", "Mushoku Tensei II: Isekai Ittara Honki Dasu"],
    ["dandadan season 2", "add", "Dandadan 2nd Season"],
    ["frieren season 7", "add", "none"],
  ]);
});

describe("latest and next seasons", () => {
  run([
    // Season 3 is announced but hasn't aired, so the newest is season 2.
    ["the new Frieren season", "progress", "Sousou no Frieren 2nd Season"],
    ["Frieren new season", "add", "Sousou no Frieren 2nd Season"],
    // Season 4 (2027) hasn't aired; season 3 (2025) is the latest.
    ["latest season of spy x family", "add", "SPY×FAMILY Season 3"],
    ["next season of frieren", "progress", "Sousou no Frieren 2nd Season"],
  ]);
});

describe("intent-aware defaults (R1.6, R1.8)", () => {
  run([
    // Adding means the first season, not a movie or a later season.
    ["frieren", "add", "Sousou no Frieren"],
    ["chainsaw man", "add", "Chainsaw Man"],
    ["re:zero", "add", "Re:Zero kara Hajimeru Isekai Seikatsu"],
    ["the slime anime", "add", "Tensei Shitara Slime Datta Ken"],
    ["tensura", "add", "Tensei Shitara Slime Datta Ken"],
    ["fullmetal alchemist brotherhood", "add", "Hagane no Renkinjutsushi: FULLMETAL ALCHEMIST"],
    ["demon slayer", "add", "Kimetsu no Yaiba"],
    ["my hero academia", "add", "Boku no Hero Academia"],
    // Asking for the movie gets the movie.
    ["chainsaw man movie", "add", "Chainsaw Man: Reze-hen"],
    ["jujutsu kaisen 0", "add", "Jujutsu Kaisen 0"],
    // A finished show you start an episode of again is the next season, not a silent rewind.
    ["frieren", "progress", "Sousou no Frieren 2nd Season"],
    // Ratings go to what you've finished.
    ["bocchi the rock", "rate", "Bocchi the Rock!"],
    ["vinland saga", "status", "VINLAND SAGA"],
  ]);
});

describe("asks instead of guessing (R1.7)", () => {
  run([
    // Two different shows share the name.
    ["hunter x hunter", "add", "ambiguous"],
    // Several finished seasons: which one is being rated?
    ["attack on titan", "rate", "ambiguous"],
    ["kaguya-sama", "rate", "ambiguous"],
    // Removing never guesses.
    ["spy x family", "remove", "ambiguous"],
    ["naruto", "remove", "none"],
    ["zzzz not a show", "add", "none"],
  ]);
});
