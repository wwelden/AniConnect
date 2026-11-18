/**
 * Deterministic resolver cases (requirement R6.2): request text + a realistic list
 * -> the AniList entry it should resolve to, or "ambiguous".
 */
import { beforeEach, describe, expect, test } from "bun:test";
import { AniListClient, type Media } from "../src/anilist";
import { normalize } from "../src/logic";
import { parseQuery, resolveAnime, titleSeason, type Intent } from "../src/resolve";
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
  return resolveAnime(query, intent, clientSource(client), "ENGLISH");
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
    ["next season of oshi no ko", "of oshi no ko", { next: true }],
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
    // A part with no season number: the title has none, and its synonyms tag it season 4.
    ["attack on titan final season part 2", "status", "Shingeki no Kyojin: The Final Season Part 2"],
    ["attack on titan final season part 2", "add", "Shingeki no Kyojin: The Final Season Part 2"],
    // Season 3 Part 2 and The Final Season Part 2 both fit: the list decides, else ask.
    ["attack on titan part 2", "rate", "Shingeki no Kyojin Season 3 Part 2"],
    ["attack on titan part 2", "add", "ambiguous"],
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
    // Next = after the furthest season started: S1 and its Part 2 are done, Season 2 is planned.
    ["next season of spy x family", "add", "SPY×FAMILY Season 2"],
    ["the next dandadan season", "progress", "Dandadan 2nd Season"],
    ["next season of bocchi the rock", "add", "Bocchi the Rock! 2nd Season"],
    // Latest walks the whole sequel chain, past split cours, and skips unaired entries.
    ["latest season of attack on titan", "rate", "Shingeki no Kyojin: The Final Season Part 2"],
    ["the new apothecary diaries season", "add", "Kusuriya no Hitorigoto 3rd Season"],
  ]);

  test("a title containing \"new\" is read literally first", async () => {
    const base = clientSource(client);
    const newGame = {
      ...findMedia("Dandadan"),
      id: 9001,
      title: { romaji: "New Game!", english: "New Game!", native: null },
      synonyms: [],
      mediaListEntry: null,
    } as unknown as Media;
    const source = {
      ...base,
      search: async (q: string) => [...(await base.search(q)), ...(q.includes("new game") ? [newGame] : [])],
    };
    const r = await resolveAnime("new game season", "add", source, "ENGLISH");
    expect(r.kind === "match" && r.media.id).toBe(9001);
  });

  test("a sequel chain search didn't cover is fetched two seasons per request (R5.2)", async () => {
    // Search results without relations, so every step of the chain has to be fetched.
    const base = clientSource(client);
    const source = {
      ...base,
      search: async (q: string) => (await base.search(q)).map(({ relations, ...m }) => m),
    };
    const r = await resolveAnime("the new season of my hero academia", "add", source, "ENGLISH");
    expect(r.kind === "match" && r.media.title.romaji).toBe("Boku no Hero Academia 6");
    // Six seasons: fetching seasons 1, 3 and 5 brings in 2, 4 and 6 with their relations.
    const fetches = fake.calls.filter((c) => c.query.includes("id_in"));
    expect(fetches.map((c) => c.variables.ids)).toEqual([[21459], [100166], [117193]]);
  });

  test("the fake nests relations like AniList: two levels, then empty", async () => {
    const [season5] = await client.getRelated([117193]);
    const sequel = season5!.relations!.edges.find((e) => e.relationType === "SEQUEL")!.node as unknown as Media;
    expect(sequel.title.romaji).toBe("Boku no Hero Academia 6");
    expect(sequel.relations!.edges.some((e) => e.relationType === "PREQUEL" && e.node.id === 117193)).toBe(true);
    const deeper = await fake.fetch("", {
      body: JSON.stringify({
        query: "query ($ids: [Int]) { Page { media(id_in: $ids) { relations { edges { node { relations { edges { node { relations { edges { node { id } } } } } } } } } } } }",
        variables: { ids: [117193] },
      }),
    });
    const body = (await deeper.json()) as any;
    const level2 = body.data.Page.media[0].relations.edges[0].node.relations.edges[0].node;
    expect(level2.relations).toEqual({ edges: [] });
  });

  test("removing never searches beyond the list", async () => {
    await resolve("spy x family season 2", "remove");
    expect(fake.calls.some((c) => c.query.includes("search:"))).toBe(false);
  });
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

describe("fixes from the PR #1 review", () => {
  run([
    // An explicit movie request never falls back to a TV season, and searches past the list.
    ["jjk movie", "progress", "Jujutsu Kaisen 0"],
    ["dandadan movie", "rate", "none"],
    // "II" is not a prefix match for "III".
    ["Mob Psycho 100 II", "progress", "Mob Psycho 100 II"],
    ["mob psycho 100 iii", "rate", "Mob Psycho 100 III"],
    // Naming a season doesn't settle which of two versions is meant.
    ["hunter x hunter season 1", "add", "ambiguous"],
    // Arcs that share a season number ("KnY 2") don't shift later seasons.
    ["demon slayer season 3", "add", "Kimetsu no Yaiba: Katanakaji no Sato-hen"],
    ["demon slayer season 4", "add", "Kimetsu no Yaiba: Hashira Geiko-hen"],
    ["demon slayer season 2", "add", "Kimetsu no Yaiba: Mugen Ressha-hen (TV)"],
  ]);

  test("a numbered title isn't read as a season (\"Macross 7\")", () => {
    const m = { ...findMedia("Dandadan"), title: { romaji: "Macross 7", english: null, native: null }, synonyms: ["Macross Seven"] } as unknown as Media;
    expect(titleSeason(m)).toBeUndefined();
    expect(titleSeason({ ...m, synonyms: ["KnY 3"] } as Media)).toBe(3);
  });

  test("the version on the list settles a numbered-season request", async () => {
    fake.seed([{ anime: "HUNTER×HUNTER (2011)", status: "CURRENT", progress: 40 }]);
    const r = await resolve("hunter x hunter season 1", "progress");
    expect(r.kind === "match" && r.media.id).toBe(11061);
  });

  test("voiced kana survive normalization", () => {
    expect(normalize("ガンダム")).toBe("ガンダム");
    expect(normalize("ぼっち・ざ・ろっく！")).toBe("ぼっち ざ ろっく");
    expect(normalize("Pokémon")).toBe("pokemon");
  });
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

describe("a part with no season isn't called season 1 (#45)", () => {
  test("a match names only the part", async () => {
    const r = await resolve("spy x family part 2", "rate");
    if (r.kind !== "match") throw new Error(`expected a match, got ${r.kind}: ${r.why}`);
    expect(r.why).toStartWith("it's part 2, going by ");
  });

  test("a miss names only the part", async () => {
    const r = await resolve("spy x family part 5", "rate");
    expect(r.kind).toBe("none");
    expect(r.why).toBe('Couldn\'t find part 5 of "spy x family" on AniList.');
  });

  test("a named season is still in the label", async () => {
    const r = await resolve("spy x family season 1 part 2", "rate");
    if (r.kind !== "match") throw new Error(`expected a match, got ${r.kind}: ${r.why}`);
    expect(r.why).toStartWith("it's season 1 part 2, going by ");
  });
});

describe("removing a split season asks which part (#29)", () => {
  run([
    // Season 1 has two parts on the list, both completed: naming the season isn't enough.
    ["spy x family season 1", "remove", "ambiguous"],
    ["attack on titan season 3", "remove", "ambiguous"],
    // Naming the part, or a season with one part, settles it.
    ["spy x family season 1 part 2", "remove", "SPY×FAMILY Part 2"],
    ["spy x family season 1 part 1", "remove", "SPY×FAMILY"],
    ["attack on titan season 3 part 2", "remove", "Shingeki no Kyojin Season 3 Part 2"],
    ["attack on titan season 3 part 1", "remove", "Shingeki no Kyojin Season 3"],
    ["spy x family season 2", "remove", "SPY×FAMILY Season 2"],
    // Non-destructive intents keep their first-part defaults.
    ["spy x family season 1", "add", "SPY×FAMILY"],
    ["spy x family season 1", "progress", "SPY×FAMILY"],
    ["attack on titan season 3", "rate", "Shingeki no Kyojin Season 3"],
  ]);

  test("the ambiguity lists both listed parts", async () => {
    const r = await resolve("spy x family season 1", "remove");
    if (r.kind !== "ambiguous") throw new Error(`expected ambiguous, got ${r.kind}: ${r.why}`);
    expect(r.candidates.map((m) => m.id).sort()).toEqual([140960, 142838]);
  });

  test("one listed part of a split season is removed without asking", async () => {
    fake = new FakeAniList().seed([{ anime: "SPY×FAMILY Part 2", status: "COMPLETED" }]);
    client = new AniListClient("test", fake.fetch);
    const r = await resolve("spy x family season 1", "remove");
    expect(r.kind === "match" && r.media.id).toBe(142838);
  });
});
