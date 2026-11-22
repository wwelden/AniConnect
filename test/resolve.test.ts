/**
 * Deterministic resolver cases (requirement R6.2): request text + a realistic list
 * -> the AniList entry it should resolve to, or "ambiguous".
 */
import { beforeEach, describe, expect, test } from "bun:test";
import { AniListClient, type ListStatus, type Media } from "../src/anilist";
import { normalize } from "../src/logic";
import { parseQuery, resolveAnime, titleSeason, type AnimeSource, type Intent } from "../src/resolve";
import { clientSource } from "../src/server";
import { PERSONA } from "./fixtures/persona";
import { catalog, FakeAniList, findMedia, type SeedEntry } from "./support/fake-anilist";

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
    ["aot final season part 2", "attack on titan final season", { part: 2 }],
  ])("%s", (raw, exact, hint) => {
    const q = parseQuery(raw);
    expect(q.exact).toBe(exact);
    expect(q.hint).toEqual(hint);
  });

  test("an abbreviation next to other words keeps the unexpanded reading to try first (#36)", () => {
    expect(parseQuery("aot final season").literal?.exact).toBe("aot final season");
    expect(parseQuery("aot").literal).toBeUndefined();
    expect(parseQuery("the aot").literal).toBeUndefined();
    expect(parseQuery("attack on titan final season").literal).toBeUndefined();
  });

  test("with a new/next season word, both literal readings are kept (#36)", () => {
    const q = parseQuery("next jjk 0 season");
    expect(q.exact).toBe("jujutsu kaisen 0");
    expect(q.literal?.exact).toBe("next jjk 0");
    expect(q.literal?.literal?.exact).toBe("jjk 0");
    expect(q.literal?.literal?.hint).toEqual({ next: true });
    expect(parseQuery("the new aot season").literal).toEqual({ exact: "the new aot", words: ["new", "aot"], hint: {} });
  });
});

describe("abbreviations next to other words (#36)", () => {
  run([
    ["aot final season", "status", "Shingeki no Kyojin: The Final Season"],
    ["aot final season part 2", "status", "Shingeki no Kyojin: The Final Season Part 2"],
    ["aot final season part 2", "add", "Shingeki no Kyojin: The Final Season Part 2"],
    ["aot ova", "add", "Shingeki no Kyojin OVA"],
    ["fma brotherhood", "add", "Hagane no Renkinjutsushi: FULLMETAL ALCHEMIST"],
    // Names that contain the short form still match it as written.
    ["jjk 0", "add", "Jujutsu Kaisen 0"],
    ["csm reze", "add", "Chainsaw Man: Reze-hen"],
    ["hxh phantom rogue", "add", "HUNTER×HUNTER: Phantom Rouge"],
  ]);

  const show = (id: number, romaji: string, format: string, synonyms: string[] = []): Media => ({
    id, title: { romaji, english: null, native: null }, synonyms, episodes: 1, duration: 24, format,
    status: "FINISHED", seasonYear: 2023, startDate: { year: 2023, month: 1, day: 1 }, averageScore: null,
    siteUrl: "", nextAiringEpisode: null, mediaListEntry: null, relations: { edges: [] },
  });

  test("falls back to the expanded reading when the literal one misses the hint", async () => {
    // The TV entry matches "aot final season" as written, but a movie was asked for.
    const all = [
      show(1, "Shingeki no Kyojin: The Final Season", "TV", ["AoT Final Season"]),
      show(2, "Attack on Titan: The Final Season Movie", "MOVIE"),
    ];
    const source = { listMedia: async () => [], search: async () => all, getRelated: async () => [] };
    const r = await resolveAnime("aot final season movie", "add", source, "ENGLISH");
    if (r.kind !== "match") throw new Error(`expected a match, got ${r.kind}: ${r.why}`);
    expect(r.media.id).toBe(2);

    // Only an adult movie fits as written: say so rather than "couldn't find".
    const adult = show(3, "AoT Final Season Movie", "MOVIE");
    const withHidden = { ...source, search: async () => [all[0]!], searchHidden: async () => [adult] };
    const hidden = await resolveAnime("aot final season movie", "add", withHidden, "ENGLISH");
    expect(hidden).toMatchObject({ kind: "none", hidden: true });
  });

  test("an adult title named with the short form still explains the miss", async () => {
    const adult = show(4, "JJK 0", "MOVIE");
    const source = {
      listMedia: async () => [],
      search: async () => [],
      getRelated: async () => [],
      searchHidden: async () => [adult],
    };
    const r = await resolveAnime("jjk 0", "add", source, "ENGLISH");
    expect(r).toMatchObject({ kind: "none", hidden: true });
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
    // Between shows not on the list, a rating goes to the one titled as asked, as other intents do.
    ["Hitoribocchi no Isekai Kouryaku", "rate", "Hitoribocchi no Isekai Kouryaku"],
    ["Bocchi the Rock! Re:Re:", "rate", "Bocchi the Rock! Re:Re:"],
    ["Sword Art Online Fatal Bullet -The Third Episode-", "rate", "Sword Art Online Fatal Bullet -The Third Episode-"],
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

describe("an episode of a completed show stays with it unless an aired sequel follows (#35)", () => {
  run([
    // The 2nd Season is a sequel but hasn't aired.
    ["bocchi the rock", "progress", "Bocchi the Rock!"],
    ["Bocchi the Rock!", "progress", "Bocchi the Rock!"],
    // The aired 2nd Season still wins; the unaired 3rd doesn't.
    ["frieren", "progress", "Sousou no Frieren 2nd Season"],
  ]);

  test("the other version of a remake isn't picked over the completed one", async () => {
    fake.seed([{ anime: "HUNTER×HUNTER (2011)", status: "COMPLETED" }]);
    const r = await resolve("hunter x hunter", "progress");
    expect(r.kind === "match" && r.media.id).toBe(11061);
  });

  test("the aired next movie after a completed movie still wins", async () => {
    fake.seed([{ anime: "Kizumonogatari I: Tekketsu-hen", status: "COMPLETED" }]);
    const r = await resolve("kizumonogatari movie", "progress");
    expect(r.kind === "match" && r.media.id).toBe(findMedia("Kizumonogatari II: Nekketsu-hen").id);
  });

  interface Show {
    id: number;
    title: string;
    format?: string;
    completed?: boolean;
    /** The ID of the show this one is the sequel of. */
    after?: number;
  }

  /** Hand-made shows, all aired, as AniList search returns them with their sequel relations. */
  function shows(...items: Show[]): AnimeSource {
    // The fixture keeps every studio, as edges; a Media only has the main ones that were asked for.
    const { studios: _studios, ...base } = findMedia("Dandadan");
    const noDate = { year: null, month: null, day: null };
    const edge = (relationType: string, id: number) => ({
      relationType,
      node: { id, type: "ANIME", format: items.find((s) => s.id === id)!.format ?? "TV" },
    });
    const all: Media[] = items.map((s) => ({
      ...base,
      id: s.id,
      title: { romaji: s.title, english: null, native: null },
      synonyms: [],
      format: s.format ?? "TV",
      status: "FINISHED",
      relations: {
        edges: [
          ...(s.after ? [edge("PREQUEL", s.after)] : []),
          ...items.filter((n) => n.after === s.id).map((n) => edge("SEQUEL", n.id)),
        ],
      },
      mediaListEntry: s.completed
        ? { id: s.id, status: "COMPLETED", progress: 12, score: 0, displayScore: 0, startedAt: noDate, completedAt: noDate }
        : null,
    }));
    return {
      listMedia: async () => all.filter((m) => m.mediaListEntry),
      search: async () => all,
      getRelated: async (ids) => all.filter((m) => ids.includes(m.id)),
    };
  }

  const progress = async (query: string, source: AnimeSource) => {
    const r = await resolveAnime(query, "progress", source, "ENGLISH");
    if (r.kind !== "match") throw new Error(`expected a match, got ${r.kind}: ${r.why}`);
    return r.media.id;
  };

  test.each([
    ["monster", [19, "Monster"], [1469, "Monster Farm: Enbanseki no Himitsu"]],
    ["another", [11111, "Another"], [1745, "Wild 7 another Bouryaku Unga"]],
  ] as const)("not to a show that shares a word: %s", async (query, [id, title], [otherId, otherTitle]) => {
    expect(await progress(query, shows({ id, title, completed: true }, { id: otherId, title: otherTitle }))).toBe(id);
  });

  test("a weaker completed match can't vouch for its own sequel", async () => {
    const source = shows(
      { id: 1, title: "Alpha", completed: true },
      { id: 2, title: "Alpha Side Story", completed: true },
      { id: 3, title: "Alpha Side Story II", after: 2 },
    );
    expect(await progress("alpha", source)).toBe(1);
  });

  test("a later completed season leads on to the aired season after it", async () => {
    const source = shows(
      { id: 1, title: "Alpha", completed: true },
      { id: 2, title: "Alpha 2nd Season", completed: true, after: 1 },
      { id: 3, title: "Alpha 3rd Season", after: 2 },
    );
    expect(await progress("alpha", source)).toBe(3);
  });

  test("the next season after a movie in between still wins", async () => {
    // Made in Abyss: season 1, then the movie Dawn of the Deep Soul, then season 2.
    const source = shows(
      { id: 1, title: "Made in Abyss", completed: true },
      { id: 2, title: "Made in Abyss Movie 3: Fukaki Tamashii no Reimei", format: "MOVIE", after: 1 },
      { id: 3, title: "Made in Abyss: Retsujitsu no Ougonkyou", after: 2 },
    );
    expect(await progress("made in abyss", source)).toBe(3);
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

describe("a show titled as asked isn't taken for a listed one that only contains the name", () => {
  const only = (anime: string) => {
    fake = new FakeAniList().seed([{ anime, status: "COMPLETED" }]);
    client = new AniListClient("test", fake.fetch);
  };

  test("with only the JJK 0 movie listed, \"Jujutsu Kaisen\" is the TV series", async () => {
    only("Jujutsu Kaisen 0");
    for (const intent of ["status", "rate"] as const) {
      const r = await resolve("Jujutsu Kaisen", intent);
      if (r.kind !== "match") throw new Error(`expected a match, got ${r.kind}: ${r.why}`);
      expect(r.media.id).toBe(findMedia("Jujutsu Kaisen").id);
    }
  });

  test("with only a One Piece special listed, \"One Piece\" is the series", async () => {
    only("ONE PIECE: Heart of Gold");
    const r = await resolve("one piece", "status");
    expect(r.kind === "match" && r.media.id).toBe(findMedia("ONE PIECE").id);
  });

  test("a listed series with a longer title and an unlisted one titled as asked: ask", async () => {
    for (const [listed, query, other] of [
      ["NARUTO: Shippuuden", "Naruto", "NARUTO"],
      ["Hagane no Renkinjutsushi: FULLMETAL ALCHEMIST", "Fullmetal Alchemist", "Hagane no Renkinjutsushi"],
      ["Steins;Gate 0", "Steins;Gate", "Steins;Gate"],
    ]) {
      only(listed!);
      for (const intent of ["status", "rate"] as const) {
        const r = await resolve(query!, intent);
        if (r.kind !== "ambiguous") throw new Error(`${query} (${intent}): expected ambiguous, got ${r.kind}: ${r.why}`);
        expect(r.candidates.map((m) => m.id)).toEqual([findMedia(other!).id, findMedia(listed!).id]);
        expect(r.why).toContain("isn't on your list");
      }
    }
  });

  test("reading about a show keeps the listed one, with no search", async () => {
    only("NARUTO: Shippuuden");
    const r = await resolve("Naruto", "show");
    expect(r.kind === "match" && r.media.id).toBe(findMedia("NARUTO: Shippuuden").id);
    expect(fake.calls.some((c) => c.query.includes("search:"))).toBe(false);
  });

  test("the show titled as asked is on the list: no question", async () => {
    fake = new FakeAniList().seed([{ anime: "NARUTO", status: "COMPLETED" }, { anime: "NARUTO: Shippuuden", status: "COMPLETED" }]);
    client = new AniListClient("test", fake.fetch);
    const r = await resolve("Naruto", "status");
    expect(r.kind === "match" && r.media.id).toBe(findMedia("NARUTO").id);
  });
});

describe("titles that differ only in punctuation (#61)", () => {
  beforeEach(() => {
    fake = new FakeAniList().seed([]);
    client = new AniListClient("test", fake.fetch);
  });

  test.each([
    ["Kaguya-sama: Love is War?", 112641],
    ["kaguya-sama: love is war?", 112641],
    ["Kaguya-sama:Love is War？", 112641],
    ["Kaguya-sama wa Kokurasetai?: Tensaitachi no Renai Zunousen", 112641],
    ["Kaguya-sama: Love is War", 101921],
    ["Kaguya-sama Love is War", 101921],
    ["Kaguya-sama: Love is War Season 2", 112641],
  ])("add \"%s\" on an empty list -> %d", async (query, id) => {
    const r = await resolve(query, "add");
    if (r.kind !== "match") throw new Error(`expected a match, got ${r.kind}: ${r.why}`);
    expect(r.media.id).toBe(id);
  });
});

describe("a later season's title typed exactly as written beats list status on every intent (#73)", () => {
  const S1 = 101921;
  const S2 = 112641;
  const S3 = 125367;
  const s1 = "Kaguya-sama wa Kokurasetai: Tensaitachi no Renai Zunousen";
  const s2 = "Kaguya-sama wa Kokurasetai?: Tensaitachi no Renai Zunousen";
  const seed = (entries: SeedEntry[]) => {
    fake = new FakeAniList().seed(entries);
    client = new AniListClient("test", fake.fetch);
  };
  const searches = () => fake.calls.filter((c) => c.query.includes("search:")).length;
  const shapes: [string, SeedEntry[], Partial<Record<Intent, number | "ambiguous">>][] = [
    ["the persona: S1 and S2 completed, S3 watching", PERSONA, { status: S2, progress: S2, show: S2, rate: S2, remove: S2 }],
    ["S1 and S2 completed", [{ anime: s1, status: "COMPLETED" }, { anime: s2, status: "COMPLETED" }], { status: S2, progress: S2, show: S2, rate: S2, remove: S2 }],
    ["S1 completed, S2 watching", [{ anime: s1, status: "COMPLETED" }, { anime: s2, status: "CURRENT", progress: 3 }], { status: S2, progress: S2, show: S2, rate: S2, remove: S2 }],
    // Only S1 listed: the season typed isn't on the list, so a change to S1 asks first.
    ["only S1 listed", [{ anime: s1, status: "COMPLETED" }], { status: "ambiguous", rate: "ambiguous", remove: "ambiguous", progress: S2, show: S2 }],
    ["an empty list", [], { status: S2, progress: S2, show: S2, rate: S2, add: S2 }],
  ];
  for (const [shape, entries, expected] of shapes) {
    for (const query of ["Kaguya-sama: Love is War?", s2]) {
      for (const [intent, want] of Object.entries(expected) as [Intent, number | "ambiguous"][]) {
        test(`${shape}: ${intent} "${query}" -> ${want}`, async () => {
          seed(entries);
          const r = await resolve(query, intent);
          if (want === "ambiguous") {
            if (r.kind !== "ambiguous") throw new Error(`expected ambiguous, got ${r.kind}: ${r.why}`);
            expect(r.candidates.map((m) => m.id)).toContain(S2);
            expect(r.candidates.map((m) => m.id)).toContain(S1);
          } else {
            if (r.kind !== "match") throw new Error(`expected a match, got ${r.kind}: ${r.why}`);
            expect(r.media.id).toBe(want);
          }
        });
      }
    }
  }

  test("the first season's title, without the mark, still means the season being watched (R1.4)", async () => {
    seed(PERSONA);
    for (const query of ["Kaguya-sama: Love is War", s1]) {
      for (const intent of ["progress", "status"] as const) {
        const r = await resolve(query, intent);
        expect(r.kind === "match" && r.media.id).toBe(S3);
      }
    }
  });

  test("costs one search only when the listed season isn't the one typed", async () => {
    seed(PERSONA);
    await resolve("Kaguya-sama: Love is War?", "progress");
    expect(searches()).toBe(0);
    seed([{ anime: s1, status: "COMPLETED" }]);
    await resolve("Kaguya-sama: Love is War?", "status");
    expect(searches()).toBe(1);
    seed([{ anime: s1, status: "COMPLETED" }]);
    await resolve("Kaguya-sama: Love is War", "status");
    expect(searches()).toBe(0);
    // Fewer marks than the listed title: nothing can be titled as written but it.
    seed([{ anime: s1, status: "COMPLETED" }]);
    await resolve("kaguya-sama love is war", "remove");
    expect(searches()).toBe(0);
  });
});

describe("a misspelled name resolves as the right spelling does (R1.2)", () => {
  const seed = (entries: SeedEntry[]) => {
    fake = new FakeAniList().seed(entries);
    client = new AniListClient("test", fake.fetch);
  };
  const searches = () => fake.calls.filter((c) => c.query.includes("search:")).length;

  run([
    // Season 1 is completed and season 2 has aired: an episode is season 2's (#35), as for "frieren".
    ["frieran", "progress", "Sousou no Frieren 2nd Season"],
    ["frieren", "progress", "Sousou no Frieren 2nd Season"],
    ["frieran", "status", "Sousou no Frieren"],
    ["jujutsu kaisan", "progress", "Jujutsu Kaisen 2nd Season"],
  ]);

  test("with only Shippuden listed, a misspelled \"naruto\" asks as \"naruto\" does (R1.3)", async () => {
    for (const [query, intent] of [["naruto", "status"], ["narto", "status"], ["narutoo", "rate"]] as const) {
      seed([{ anime: "NARUTO: Shippuuden", status: "COMPLETED" }]);
      const r = await resolve(query, intent);
      if (r.kind !== "ambiguous") throw new Error(`${query}: expected ambiguous, got ${r.kind}: ${r.why}`);
      expect(r.candidates.map((m) => m.id)).toEqual([findMedia("NARUTO").id, findMedia("NARUTO: Shippuuden").id]);
    }
  });

  test("a real title one letter off a listed one isn't corrected to it", async () => {
    const make = (id: number, romaji: string, entry: Media["mediaListEntry"]): Media => ({
      id, title: { romaji, english: null, native: null }, synonyms: [], episodes: 12, duration: 24, format: "TV",
      status: "FINISHED", seasonYear: 2020, startDate: { year: 2020, month: 1, day: 1 }, averageScore: null,
      siteUrl: "", nextAiringEpisode: null, mediaListEntry: entry, relations: { edges: [] },
    });
    const kaiju = make(1, "Kaiju No. 8", { status: "CURRENT", progress: 3 } as Media["mediaListEntry"]);
    const kaiji = make(2, "Gyakkyou Burai Kaiji", null);
    const source: AnimeSource = {
      listMedia: async () => [kaiju],
      search: async (q) => (q === "kaiji" ? [kaiji] : []),
      getRelated: async () => [],
    };
    for (const intent of ["progress", "show", "status"] as const) {
      const r = await resolveAnime("kaiji", intent, source, "ENGLISH");
      expect(r.kind === "match" && r.media.id).toBe(2);
    }
  });

  test("costs one search, only on the typo path", async () => {
    seed(PERSONA);
    await resolve("dandadan", "progress");
    expect(searches()).toBe(0);
    seed(PERSONA);
    await resolve("dandadn", "progress");
    expect(searches()).toBe(1);
  });

  test("a misspelling one letter off two listed names isn't guessed", async () => {
    const make = (id: number, romaji: string): Media => ({
      id, title: { romaji, english: null, native: null }, synonyms: [], episodes: 12, duration: 24, format: "TV",
      status: "FINISHED", seasonYear: 2020, startDate: { year: 2020, month: 1, day: 1 }, averageScore: null,
      siteUrl: "", nextAiringEpisode: null, mediaListEntry: { status: "COMPLETED", progress: 12 } as Media["mediaListEntry"], relations: { edges: [] },
    });
    const source: AnimeSource = {
      listMedia: async () => [make(1, "Hyouka"), make(2, "Hyouko")],
      search: async () => [],
      getRelated: async () => [],
    };
    const r = await resolveAnime("hyoukq", "status", source, "ENGLISH");
    if (r.kind !== "ambiguous") throw new Error(`expected ambiguous, got ${r.kind}: ${r.why}`);
    expect(r.candidates.map((m) => m.id).sort()).toEqual([1, 2]);
  });

  test("two listed shows that would respell it differently, one closer: not respelled", async () => {
    const make = (id: number, romaji: string, status: "CURRENT" | "COMPLETED"): Media => ({
      id, title: { romaji, english: null, native: null }, synonyms: [], episodes: 12, duration: 24, format: "TV",
      status: "FINISHED", seasonYear: 2020, startDate: { year: 2020, month: 1, day: 1 }, averageScore: null,
      siteUrl: "", nextAiringEpisode: null, mediaListEntry: { status, progress: 3 } as Media["mediaListEntry"], relations: { edges: [] },
    });
    const source: AnimeSource = {
      listMedia: async () => [make(1, "Hellsing", "CURRENT"), make(2, "Helsinge", "COMPLETED")],
      search: async () => [],
      getRelated: async () => [],
    };
    // As before: the show being watched takes the episode, not the closer spelling.
    const r = await resolveAnime("helsingg", "progress", source, "ENGLISH");
    expect(r.kind === "match" && r.media.id).toBe(1);
  });
});

describe("a numbered season of two different shows asks which show (#62)", () => {
  const season2 = (id: number, romaji: string, related: number[] = []): Media => ({
    id, title: { romaji, english: null, native: null }, synonyms: [], episodes: 13, duration: 24, format: "TV",
    status: "FINISHED", seasonYear: 2014 + id, startDate: { year: 2014 + id, month: 4, day: 1 }, averageScore: null,
    siteUrl: "", nextAiringEpisode: null, mediaListEntry: null,
    relations: { edges: related.map((rid) => ({ relationType: "SEQUEL", node: { id: rid, type: "ANIME", format: "TV" } })) },
  } as unknown as Media);
  const source = (all: Media[], list: Media[] = []): AnimeSource => ({
    listMedia: async () => list,
    search: async () => all,
    getRelated: async () => [],
  });

  test("two season 2s of different shows: ask", async () => {
    const all = [season2(1, "Love Live! 2nd Season"), season2(2, "Love Live! Sunshine!! 2nd Season")];
    const r = await resolveAnime("love season 2", "add", source(all), "ENGLISH");
    if (r.kind !== "ambiguous") throw new Error(`expected ambiguous, got ${r.kind}: ${r.why}`);
    expect(r.candidates.map((m) => m.id)).toEqual([1, 2]);
    expect(r.why).toBe('Season 2 of "love" matches 2 shows.');
  });

  test("the one on the list is the one meant", async () => {
    const all = [season2(1, "Love Live! 2nd Season"), season2(2, "Love Live! Sunshine!! 2nd Season")];
    const listed = { ...all[1]!, mediaListEntry: { status: "CURRENT", progress: 3 } } as unknown as Media;
    const r = await resolveAnime("love season 2", "progress", source(all, [listed]), "ENGLISH");
    expect(r.kind === "match" && r.media.id).toBe(2);
  });

  test("a spin-off's season 2 doesn't rival the show titled as asked", async () => {
    const all = [season2(1, "Sword Art Online II"), season2(2, "Sword Art Online Alternative: Gun Gale Online II")];
    const first = await resolveAnime("sword art online season 2", "add", source(all), "ENGLISH");
    expect(first.kind === "match" && first.media.id).toBe(1);
    const second = await resolveAnime("sword art online season 2", "add", source([...all].reverse()), "ENGLISH");
    expect(second.kind === "match" && second.media.id).toBe(1);
  });

  test.each(["the second season of sword art online", "season 2 of sword art online", "sao 2nd season", "SAO S2"])(
    "every season phrasing keeps the show titled as asked: \"%s\"",
    async (query) => {
      const all = [season2(2, "Sword Art Online Alternative: Gun Gale Online II"), season2(1, "Sword Art Online II")];
      const r = await resolveAnime(query, "add", source(all), "ENGLISH");
      expect(r.kind === "match" && r.media.id).toBe(1);
    },
  );

  test("two parts of one season (joined by a sequel edge) still pick the first part", async () => {
    const all = [season2(1, "Love Live! 2nd Season", [2]), season2(2, "Love Live! 2nd Season Part 2")];
    const r = await resolveAnime("love season 2", "add", source(all), "ENGLISH");
    expect(r.kind === "match" && r.media.id).toBe(1);
  });

  run([
    // Season 3 and its Part 2 both state season 3; Frieren's season 2 has a side-story ONA.
    ["attack on titan season 3", "add", "Shingeki no Kyojin Season 3"],
    ["frieren season 2", "add", "Sousou no Frieren 2nd Season"],
  ]);
});

describe("\"next season ... part N\" resolves that part of the next season (#63)", () => {
  test("a next season with no such part: none, not another part", async () => {
    fake = new FakeAniList().seed([]);
    client = new AniListClient("test", fake.fetch);
    const r = await resolve("next season of Frieren part 2", "add");
    expect(r.kind).toBe("none");
    expect(r.why).toBe("AniList doesn't list a part 2 of Frieren: Beyond Journey’s End Season 2.");
  });

  test("the requested part of the next season", async () => {
    fake = new FakeAniList().seed([
      { anime: "Shingeki no Kyojin", status: "COMPLETED" },
      { anime: "Shingeki no Kyojin Season 2", status: "COMPLETED" },
    ]);
    client = new AniListClient("test", fake.fetch);
    const part2 = await resolve("next season of attack on titan part 2", "add");
    if (part2.kind !== "match") throw new Error(`expected a match, got ${part2.kind}: ${part2.why}`);
    expect(part2.media.title.romaji).toBe("Shingeki no Kyojin Season 3 Part 2");
    expect(part2.why).toBe("it's the season after Attack on Titan Season 2, part 2");
    const part1 = await resolve("next season of attack on titan part 1", "add");
    expect(part1.kind === "match" && part1.media.title.romaji).toBe("Shingeki no Kyojin Season 3");
  });

  test("partway through a split season, the next season is the one after it", async () => {
    fake = new FakeAniList().seed([{ anime: "Shingeki no Kyojin Season 3", status: "CURRENT", progress: 5 }]);
    client = new AniListClient("test", fake.fetch);
    const part1 = await resolve("next season of attack on titan part 1", "add");
    expect(part1.kind === "match" && part1.media.title.romaji).toBe("Shingeki no Kyojin: The Final Season");
    const part2 = await resolve("next season of attack on titan part 2", "add");
    expect(part2.kind === "match" && part2.media.title.romaji).toBe("Shingeki no Kyojin: The Final Season Part 2");
  });
});

describe("anime that share a name with a movie or a music video", () => {
  const media = (id: number, romaji: string, format: string, year: number): Media => ({
    id, title: { romaji, english: romaji, native: null }, synonyms: [], episodes: null, duration: null, format,
    status: "FINISHED", seasonYear: year, startDate: { year, month: 1, day: 1 }, averageScore: null,
    siteUrl: "", nextAiringEpisode: null, mediaListEntry: null, relations: { edges: [] },
  });
  const from = (all: Media[]): AnimeSource => ({ listMedia: async () => [], search: async () => all, getRelated: async () => [] });

  // AniList search results for "Spriggan", in its order.
  const SPRIGGAN = [media(420, "SPRIGGAN", "MOVIE", 1998), media(108353, "SPRIGGAN (ONA)", "ONA", 2022)];

  test("a series whose title only adds its format matches its name exactly, so it wins as a series", async () => {
    for (const intent of ["add", "status", "progress"] as const) {
      const r = await resolveAnime("Spriggan", intent, from(SPRIGGAN), "ENGLISH");
      expect(r.kind === "match" && r.media.id).toBe(108353);
    }
  });

  test("the movie is still there when asked for", async () => {
    const r = await resolveAnime("spriggan movie", "add", from(SPRIGGAN), "ENGLISH");
    expect(r.kind === "match" && r.media.id).toBe(420);
  });

  test("a music video titled as asked doesn't stand in for the shows with that word in their title", async () => {
    // AniList search results for "Idol": the MV for the Oshi no Ko song comes first.
    const idol = [media(164117, "Idol", "MUSIC", 2023), media(97618, "Idol Jihen", "TV", 2017), media(7569, "Idol Ace", "ONA", 1997)];
    for (const intent of ["add", "rate"] as const) {
      const r = await resolveAnime("Idol", intent, from(idol), "ENGLISH");
      expect(r.kind).toBe("ambiguous");
      if (r.kind === "ambiguous") expect(r.candidates.map((m) => m.id)).not.toContain(164117);
    }
  });

  test("a music video on the user's list can still be named", async () => {
    const mv = { ...media(164117, "Idol", "MUSIC", 2023), mediaListEntry: { status: "COMPLETED" } as Media["mediaListEntry"] };
    const source: AnimeSource = { listMedia: async () => [mv], search: async () => [mv, media(97618, "Idol Jihen", "TV", 2017)], getRelated: async () => [] };
    for (const intent of ["rate", "remove"] as const) {
      const r = await resolveAnime("Idol", intent, source, "ENGLISH");
      expect(r.kind === "match" && r.media.id).toBe(164117);
    }
  });

  test("a music video still matches when nothing else does", async () => {
    const r = await resolveAnime("Idol", "add", from([media(164117, "Idol", "MUSIC", 2023)]), "ENGLISH");
    expect(r.kind === "match" && r.media.id).toBe(164117);
  });
});

describe("a spin-off with the show's name doesn't take a request for the show (R1.10)", () => {
  const KONOSUBA = "Kono Subarashii Sekai ni Shukufuku wo!";
  const KONOSUBA_2 = "Kono Subarashii Sekai ni Shukufuku wo! 2";
  const KONOSUBA_MOVIE = "Kono Subarashii Sekai ni Shukufuku wo! Kurenai Densetsu";
  const KONOSUBA_3 = "Kono Subarashii Sekai ni Shukufuku wo! 3";
  const EXPLOSION = "Kono Subarashii Sekai ni Bakuen wo!";

  const list = (...entries: [anime: string, status: ListStatus][]) => {
    fake = new FakeAniList().seed(entries.map(([anime, status]) => ({ anime, status, progress: status === "COMPLETED" ? undefined : 1 })));
    client = new AniListClient("test", fake.fetch);
  };
  const expectAsk = async (query: string, intent: Intent, titles: string[]) => {
    const r = await resolve(query, intent);
    if (r.kind !== "ambiguous") throw new Error(`${intent}: expected ambiguous, got ${r.kind}: ${r.why}`);
    expect(r.candidates.map((m) => m.title.romaji)).toEqual(titles);
    return r;
  };
  const expectMatch = async (query: string, intent: Intent, title: string) => {
    const r = await resolve(query, intent);
    if (r.kind !== "match") throw new Error(`${intent}: expected a match, got ${r.kind}: ${r.why}`);
    expect(r.media.title.romaji).toBe(title);
  };

  test("seasons 1 and 2 done, season 3 out, the spin-off planned: ask which", async () => {
    list([KONOSUBA, "COMPLETED"], [KONOSUBA_2, "COMPLETED"], [EXPLOSION, "PLANNING"]);
    for (const intent of ["progress", "status", "show"] as const) {
      const r = await expectAsk("konosuba", intent, [KONOSUBA_3, EXPLOSION]);
      expect(r.why).toBe('"konosuba" is the title of a show with more to watch, and a different show on your list has that name in its title.');
    }
    // Unchanged: a rating asks which finished season, a removal never guesses, adding means season 1.
    await expectAsk("konosuba", "rate", [KONOSUBA, KONOSUBA_2]);
    await expectAsk("konosuba", "remove", [KONOSUBA, KONOSUBA_2, EXPLOSION]);
    await expectMatch("konosuba", "add", KONOSUBA);
  });

  test("the movie between seasons 2 and 3 is looked past, for one search and no other request", async () => {
    list([KONOSUBA, "COMPLETED"], [KONOSUBA_2, "COMPLETED"], [KONOSUBA_MOVIE, "COMPLETED"], [EXPLOSION, "PLANNING"]);
    await expectAsk("konosuba", "progress", [KONOSUBA_3, EXPLOSION]);
    const kinds = fake.calls.map((c) => (c.query.includes("MediaListCollection") ? "list" : c.query.includes("search:") ? "search" : c.query.includes("id_in") ? "related" : "other"));
    expect(kinds.filter((k) => k !== "other")).toEqual(["list", "search"]);
  });

  test("a season missing from the list before one that's on it isn't offered as left to watch", async () => {
    // Season 2 was never logged, but the movie after it was: what's left is season 3.
    list([KONOSUBA, "COMPLETED"], [KONOSUBA_MOVIE, "COMPLETED"], [EXPLOSION, "PLANNING"]);
    await expectAsk("konosuba", "progress", [KONOSUBA_3, EXPLOSION]);
  });

  test("the spin-off keeps its status pick when the show has nothing left to watch", async () => {
    // Season 4 is announced but hasn't aired.
    list([KONOSUBA, "COMPLETED"], [KONOSUBA_2, "COMPLETED"], [KONOSUBA_MOVIE, "COMPLETED"], [KONOSUBA_3, "COMPLETED"], [EXPLOSION, "PLANNING"]);
    for (const intent of ["progress", "status", "show"] as const) await expectMatch("konosuba", intent, EXPLOSION);
  });

  test("the spin-off being watched keeps episodes and status changes, not a rating", async () => {
    list([KONOSUBA, "COMPLETED"], [KONOSUBA_2, "COMPLETED"], [EXPLOSION, "CURRENT"]);
    for (const intent of ["progress", "status", "show"] as const) await expectMatch("konosuba", intent, EXPLOSION);
    list([KONOSUBA, "CURRENT"], [EXPLOSION, "COMPLETED"]);
    await expectAsk("konosuba", "rate", [KONOSUBA, EXPLOSION]);
    await expectMatch("konosuba", "progress", KONOSUBA);
  });

  test("Sword Art Online: Gun Gale Online is a spin-off, its season II too", async () => {
    for (const spinOff of ["Sword Art Online Alternative: Gun Gale Online", "Sword Art Online Alternative: Gun Gale Online II"]) {
      list(["Sword Art Online", "COMPLETED"], [spinOff, "PLANNING"]);
      for (const query of ["sword art online", "sao"]) await expectAsk(query, "progress", ["Sword Art Online II", spinOff]);
    }
  });

  test("Tensura: season 2 follows an OVA, and the diary spin-off doesn't stand in for it", async () => {
    list(["Tensei Shitara Slime Datta Ken", "COMPLETED"], ["Tensei Shitara Slime Datta Ken: Tensura Nikki", "PLANNING"]);
    await expectAsk("tensura", "progress", ["Tensei Shitara Slime Datta Ken 2nd Season", "Tensei Shitara Slime Datta Ken: Tensura Nikki"]);
  });

  test("a later season of the named show is told by its title, with no search (R5.2)", async () => {
    // "Jujutsu Kaisen 2nd Season" (watched), "Shingeki no Kyojin: The Final Season" (paused,
    // synonym "Attack on Titan Season 4"), "SPY×FAMILY Season 2" (planned).
    for (const [query, title] of [
      ["jjk", "Jujutsu Kaisen 2nd Season"],
      ["attack on titan", "Shingeki no Kyojin: The Final Season"],
      ["spy x family", "SPY×FAMILY Season 2"],
    ] as const) {
      fake.calls.length = 0;
      await expectMatch(query, "progress", title);
      expect(fake.calls.some((c) => c.query.includes("search:"))).toBe(false);
    }
  });
});

describe("planned seasons of one show that tie: the next one to watch (R1.12)", () => {
  const S1 = "Tensei Shitara Slime Datta Ken";
  const S2 = "Tensei Shitara Slime Datta Ken 2nd Season";
  const S2P2 = "Tensei Shitara Slime Datta Ken 2nd Season Part 2";
  const S3 = "Tensei Shitara Slime Datta Ken 3rd Season";
  const S4 = "Tensei Shitara Slime Datta Ken 4th Season Part 1 & 2";
  const S4P3 = "Tensei Shitara Slime Datta Ken 4th Season Part 3"; // not yet aired
  const NIKKI = "Tensei Shitara Slime Datta Ken: Tensura Nikki"; // a spin-off, not a season
  const NEXT = ["progress", "status", "show"] as const;

  const list = (...entries: [anime: string, status: ListStatus][]) => {
    fake = new FakeAniList().seed(entries.map(([anime, status]) => ({ anime, status, progress: status === "COMPLETED" ? undefined : 0 })));
    client = new AniListClient("test", fake.fetch);
  };
  const expectMatch = async (query: string, intent: Intent, title: string) => {
    const r = await resolve(query, intent);
    if (r.kind !== "match") throw new Error(`${intent}: expected a match, got ${r.kind}: ${r.why}`);
    expect(r.media.title.romaji).toBe(title);
    return r;
  };
  const expectAsk = async (query: string, intent: Intent, titles: string[]) => {
    const r = await resolve(query, intent);
    if (r.kind !== "ambiguous") throw new Error(`${intent}: expected ambiguous, got ${r.kind}: ${r.why}`);
    expect(r.candidates.map((m) => m.title.romaji)).toEqual(titles);
  };
  const kinds = () =>
    fake.calls
      .map((c) => (c.query.includes("MediaListCollection") ? "list" : c.query.includes("search:") ? "search" : c.query.includes("id_in") ? "related" : "other"))
      .filter((k) => k !== "other");

  test("seasons 1 and 2 done, the rest planned: the one after season 2, past the OVA after season 1", async () => {
    const seed = () => list([S1, "COMPLETED"], [S2, "COMPLETED"], [S2P2, "PLANNING"], [S3, "PLANNING"], [S4, "PLANNING"]);
    for (const intent of NEXT) {
      seed();
      const r = await expectMatch("tensura", intent, S2P2);
      expect(r.why).toBe("it's on your plan-to-watch list and comes next after That Time I Got Reincarnated as a Slime Season 2");
      // The list and one search, which carries the relations; no other request.
      expect(kinds()).toEqual(["list", "search"]);
    }
    // Unchanged: a rating asks which finished season, a removal never guesses.
    seed();
    await expectAsk("tensura", "rate", [S1, S2]);
    await expectAsk("tensura", "remove", [S1, S2, S2P2, S3, S4]);
  });

  test("nothing started: the first season", async () => {
    // "slime datta ken" is no season's exact title, so all three tie.
    list([S1, "PLANNING"], [S2, "PLANNING"], [S2P2, "PLANNING"]);
    for (const intent of NEXT) {
      const r = await expectMatch("slime datta ken", intent, S1);
      expect(r.why).toBe("it's on your plan-to-watch list and comes first in the show");
    }
  });

  test("a season that hasn't aired never goes before one that has", async () => {
    list([S1, "COMPLETED"], [S2, "COMPLETED"], [S2P2, "COMPLETED"], [S3, "COMPLETED"], [S4P3, "PLANNING"], [S4, "PLANNING"]);
    for (const intent of NEXT) await expectMatch("tensura", intent, S4);
  });

  test("planned shows that aren't seasons of one show: ask", async () => {
    list([S1, "COMPLETED"], [S2, "COMPLETED"], [S2P2, "COMPLETED"], [S3, "PLANNING"], [NIKKI, "PLANNING"]);
    for (const intent of NEXT) await expectAsk("tensura", intent, [NIKKI, S3]);
  });

  test("a season missing from the list before the planned ones: ask", async () => {
    // Season 2 and its part 2 were never logged: the user may be watching them.
    list([S1, "COMPLETED"], [S3, "PLANNING"], [S4, "PLANNING"]);
    for (const intent of NEXT) await expectAsk("tensura", intent, [S3, S4]);
  });

  test("an anime the walk can't load could hide a gap: ask", async () => {
    // Season 1 isn't on the list, and the only way to it is the OVA, which AniList doesn't return here.
    list([S2, "PLANNING"], [S2P2, "PLANNING"]);
    const OVA = findMedia("Tensei Shitara Slime Datta Ken: Coleus no Yume").id;
    const source = clientSource(client);
    const lossy: AnimeSource = {
      ...source,
      search: async (query) => (await source.search(query)).filter((m) => m.id !== OVA),
      getRelated: async (ids) => (await source.getRelated(ids)).filter((m) => m.id !== OVA),
    };
    for (const intent of ["progress", "show"] as const) {
      const r = await resolveAnime("tensura", intent, lossy, "ENGLISH");
      if (r.kind !== "ambiguous") throw new Error(`${intent}: expected ambiguous, got ${r.kind}: ${r.why}`);
      expect(r.candidates.map((m) => m.title.romaji)).toEqual([S2, S2P2]);
    }
  });

  test("a reached season whose relations don't load could hide a gap: ask", async () => {
    // Season 1 isn't on the list; season 2 is, but neither the search nor a fetch brings its relations.
    list([S2, "COMPLETED"], [S2P2, "PLANNING"], [S3, "PLANNING"]);
    const SEASON_2 = findMedia(S2).id;
    const source = clientSource(client);
    const lossy: AnimeSource = {
      ...source,
      search: async (query) => (await source.search(query)).filter((m) => m.id !== SEASON_2),
      getRelated: async (ids) => (await source.getRelated(ids)).filter((m) => m.id !== SEASON_2),
    };
    for (const intent of ["progress", "show"] as const) {
      const r = await resolveAnime("tensura", intent, lossy, "ENGLISH");
      if (r.kind !== "ambiguous") throw new Error(`${intent}: expected ambiguous, got ${r.kind}: ${r.why}`);
      expect(r.candidates.map((m) => m.title.romaji)).toEqual([S2P2, S3]);
    }
  });

  describe("the sequel order must be one line that agrees with the air dates", () => {
    // Three planned TV seasons of a made-up show, "Zeta Quest: A", "B" and "C", all matching "zeta quest" alike.
    const synthetic = (years: Record<string, number>, edges: [from: string, to: string][]): AnimeSource => {
      const ids: Record<string, number> = { A: 9001, B: 9002, C: 9003 };
      const node = (k: string) => ({ id: ids[k]!, type: "ANIME", format: "TV", status: "FINISHED", startDate: { year: years[k]!, month: 1, day: 1 } });
      const media: Media[] = Object.keys(ids).map((k) => ({
        id: ids[k]!,
        title: { romaji: `Zeta Quest: ${k}`, english: null, native: null },
        synonyms: [],
        episodes: 12,
        duration: 24,
        format: "TV",
        status: "FINISHED",
        seasonYear: years[k]!,
        startDate: { year: years[k]!, month: 1, day: 1 },
        averageScore: null,
        popularity: 1000,
        siteUrl: "",
        nextAiringEpisode: null,
        mediaListEntry: { id: ids[k]!, status: "PLANNING", progress: 0 } as Media["mediaListEntry"],
        relations: {
          edges: [
            ...edges.filter(([f]) => f === k).map(([, t]) => ({ relationType: "SEQUEL", node: node(t) })),
            ...edges.filter(([, t]) => t === k).map(([f]) => ({ relationType: "PREQUEL", node: node(f) })),
          ],
        },
      }));
      return {
        listMedia: async () => media.map((m) => ({ ...m, relations: undefined })),
        search: async () => media,
        getRelated: async (wanted) => media.filter((m) => wanted.includes(m.id)),
      };
    };
    const resolveIn = (source: AnimeSource) => resolveAnime("zeta quest", "progress", source, "ENGLISH");

    test("in order: the first", async () => {
      const r = await resolveIn(synthetic({ A: 2020, B: 2021, C: 2022 }, [["A", "B"], ["B", "C"]]));
      expect(r.kind === "match" && r.media.title.romaji).toBe("Zeta Quest: A");
    });

    test("air dates out of order between later seasons: ask", async () => {
      const r = await resolveIn(synthetic({ A: 2020, B: 2022, C: 2021 }, [["A", "B"], ["B", "C"]]));
      expect(r.kind).toBe("ambiguous");
    });

    test("a branch (two sequels of one season): ask", async () => {
      const r = await resolveIn(synthetic({ A: 2020, B: 2021, C: 2022 }, [["A", "B"], ["A", "C"]]));
      expect(r.kind).toBe("ambiguous");
    });
  });

  test("a season before them that isn't completed: ask", async () => {
    // Season 1 dropped: the user may be picking it back up.
    list([S1, "DROPPED"], [S2, "PLANNING"], [S2P2, "PLANNING"]);
    for (const intent of NEXT) await expectAsk("tensura", intent, [S2, S2P2]);
  });
});

describe("a synonym or a match inside a word gives way to a more popular show titled with the words", () => {
  const KNY = "Kimetsu no Yaiba";
  const BTR = "Bocchi the Rock!";
  const LONER = "Hitoribocchi no Isekai Kouryaku";

  const list = (...entries: [anime: string, status: ListStatus][]) => {
    fake = new FakeAniList().seed(entries.map(([anime, status]) => ({ anime, status, progress: status === "COMPLETED" ? undefined : 1 })));
    client = new AniListClient("test", fake.fetch);
  };
  const expectMatch = async (query: string, intent: Intent, title: string) => {
    const r = await resolve(query, intent);
    if (r.kind !== "match") throw new Error(`${intent}: expected a match, got ${r.kind}: ${r.why}`);
    expect(r.media.title.romaji).toBe(title);
  };
  const expectAsk = async (query: string, intent: Intent, titles: string[]) => {
    const r = await resolve(query, intent);
    if (r.kind !== "ambiguous") throw new Error(`${intent}: expected ambiguous, got ${r.kind}: ${r.why}`);
    expect(r.candidates.map((m) => m.title.romaji)).toEqual(titles);
  };
  const ALL: Intent[] = ["add", "progress", "status", "show", "rate"];

  test('"demon slayer" is Kimetsu no Yaiba, not Onigiri, whose synonym it is', async () => {
    list();
    for (const intent of ALL) await expectMatch("demon slayer", intent, KNY);
  });

  test("with every Demon Slayer entry completed, an episode update doesn't add Onigiri", async () => {
    const done = catalog.filter((m) => m.franchise === KNY && m.status === "FINISHED").map((m) => m.title.romaji);
    list(...done.map((anime) => [anime, "COMPLETED"] as [string, ListStatus]));
    for (const intent of ["progress", "status", "rate", "show"] as const) {
      const r = await resolve("demon slayer", intent);
      const ids = r.kind === "match" ? [r.media.id] : r.kind === "ambiguous" ? r.candidates.map((m) => m.id) : [];
      expect(ids).not.toContain(findMedia("Onigiri").id);
    }
    await expectMatch("demon slayer", "add", KNY);
  });

  test("Onigiri being watched keeps episodes and status changes, not a rating (R1.10)", async () => {
    list(["Onigiri", "CURRENT"]);
    for (const intent of ["progress", "status", "show"] as const) await expectMatch("demon slayer", intent, "Onigiri");
    await expectAsk("demon slayer", "rate", [KNY, "Onigiri"]);
  });

  test("a season being watched with the name inside a word keeps the episode (R1.4)", async () => {
    // "Owarimonogatari" has "monogatari" only inside a word; more popular seasons have it as one.
    list(["Owarimonogatari", "CURRENT"]);
    await expectMatch("monogatari", "progress", "Owarimonogatari");
    // Words run together from the start of a word still count as the title's: no extra search.
    list(["Re:Zero kara Hajimeru Isekai Seikatsu", "CURRENT"]);
    fake.calls.length = 0;
    await expectMatch("rezero", "progress", "Re:Zero kara Hajimeru Isekai Seikatsu");
    expect(fake.calls.some((c) => c.query.includes("search:"))).toBe(false);
  });

  test('"naruto" is Naruto: "NARUTO (2026)" is a synonym of NARUTO×NINKU, not a second version', async () => {
    list();
    for (const intent of ["add", "progress", "show"] as const) await expectMatch("naruto", intent, "NARUTO");
  });

  test('"bocchi" is Bocchi the Rock!, a word of its title, over shows with it inside a word', async () => {
    list();
    for (const intent of ALL) await expectMatch("bocchi", intent, BTR);
  });

  test("a listed show with the name inside a word isn't picked by its status: ask, or add the one titled with it", async () => {
    list([LONER, "COMPLETED"]);
    for (const intent of ["status", "show", "rate"] as const) {
      const r = await resolve("bocchi", intent);
      if (r.kind !== "ambiguous") throw new Error(`${intent}: expected ambiguous, got ${r.kind}: ${r.why}`);
      expect(r.candidates.map((m) => m.title.romaji)).toEqual([BTR, LONER]);
      expect(r.why).toBe('"bocchi" is in the title of a show with more to watch, and a different show on your list only has it in another name or inside a word.');
    }
    // A completed show takes an episode only when nothing else fits; adding means the titled show.
    await expectMatch("bocchi", "progress", BTR);
    await expectMatch("bocchi", "add", BTR);
    // The one being watched keeps episodes and status changes, as a spin-off does (R1.10).
    list([LONER, "CURRENT"]);
    await expectMatch("bocchi", "progress", LONER);
    await expectAsk("bocchi", "rate", [BTR, LONER]);
    // The listed show titled with the word settles it.
    list([LONER, "COMPLETED"], [BTR, "COMPLETED"]);
    for (const intent of ["progress", "show", "rate"] as const) await expectMatch("bocchi", intent, BTR);
  });
});

describe("giving way, with made-up shows (R1.11, PR #87 review)", () => {
  const show = (id: number, romaji: string, popularity: number, more: Partial<Media> = {}): Media => ({
    id, title: { romaji, english: null, native: null }, synonyms: [], episodes: 12, duration: 24, format: "TV",
    status: "FINISHED", seasonYear: 2020, startDate: { year: 2020, month: 1, day: 1 }, averageScore: null, popularity,
    siteUrl: "", nextAiringEpisode: null, mediaListEntry: null, relations: { edges: [] }, ...more,
  });
  const on = (m: Media, status: ListStatus): Media => ({ ...m, mediaListEntry: { status, progress: 1 } as Media["mediaListEntry"] });
  /** AniList search returns every show with relations; the list carries none, as fetchMyList does. */
  const source = (all: Media[]): AnimeSource => ({
    listMedia: async () => all.filter((m) => m.mediaListEntry).map((m) => ({ ...m, relations: undefined })),
    search: async () => all,
    getRelated: async (ids) => all.filter((m) => ids.includes(m.id)),
  });
  const edge = (relationType: string, m: Media) => ({
    relationType, node: { id: m.id, type: "ANIME", format: m.format, status: m.status, episodes: m.episodes, title: m.title, startDate: m.startDate },
  });
  const run = async (query: string, intent: Intent, all: Media[]) => resolveAnime(query, intent, source(all), "ENGLISH");

  test("a listed sequel known by a synonym doesn't give way to its listed prequel", async () => {
    const first = show(1, "Alpha Chronicles", 200);
    const sequel = show(2, "Beta Odyssey", 100, { synonyms: ["Alpha"], startDate: { year: 2022, month: 1, day: 1 } });
    first.relations = { edges: [edge("SEQUEL", sequel)] as never };
    sequel.relations = { edges: [edge("PREQUEL", first)] as never };
    const r = await run("alpha", "progress", [on(first, "PLANNING"), on(sequel, "PLANNING")]);
    expect(r.kind === "match" && r.media.id).toBe(2);
  });

  test("a movie asked for isn't lost to a more popular series titled with the name", async () => {
    const r = await run("alpha movie", "add", [show(1, "Alpha", 500), show(2, "Beta Gekijouban", 100, { format: "MOVIE", synonyms: ["Alpha"] })]);
    expect(r.kind === "match" && r.media.id).toBe(2);
  });

  test("a listed movie being watched that gave way keeps the episode", async () => {
    const r = await run("alpha", "progress", [show(1, "Alpha Chronicles", 500), on(show(2, "Beta", 100, { format: "MOVIE", synonyms: ["Alpha"] }), "CURRENT")]);
    expect(r.kind === "match" && r.media.id).toBe(2);
  });

  test("a season asked for isn't taken by a listed movie that gave way", async () => {
    const tv = show(1, "Alpha 2nd Season", 500, { title: { romaji: "Alpha 2nd Season", english: "Alpha", native: null } });
    const movie = on(show(2, "Beta 2nd Season", 100, { format: "MOVIE", synonyms: ["Alpha"] }), "PLANNING");
    const r = await run("alpha season 2", "progress", [tv, movie]);
    expect(r.kind === "match" && r.media.id).toBe(1);
  });

  test("a rating goes to the completed show titled as asked over a completed one that gave way", async () => {
    const r = await run("alpha", "rate", [on(show(1, "Alpha", 500), "COMPLETED"), on(show(2, "Beta", 100, { synonyms: ["Alpha"] }), "COMPLETED")]);
    expect(r.kind === "match" && r.media.id).toBe(1);
  });

  test("a music video not on the list doesn't make a series give way (R1.8)", async () => {
    const r = await run("alpha", "add", [show(1, "Beta", 100, { synonyms: ["Alpha"] }), show(2, "Alpha", 500, { format: "MUSIC" })]);
    expect(r.kind === "match" && r.media.id).toBe(1);
  });

  test("a status change asks when a show titled exactly as asked isn't on the list (R1.3), even beside the one being watched", async () => {
    const r = await run("alpha", "status", [show(1, "Alpha", 500), on(show(2, "Beta", 100, { synonyms: ["Alpha"] }), "CURRENT")]);
    expect(r.kind).toBe("ambiguous");
    // An episode goes to the one being watched.
    const p = await run("alpha", "progress", [show(1, "Alpha", 500), on(show(2, "Beta", 100, { synonyms: ["Alpha"] }), "CURRENT")]);
    expect(p.kind === "match" && p.media.id).toBe(2);
  });
});
