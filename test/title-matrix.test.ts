/**
 * Generated resolver checks over the whole media fixture (R6.2): every show's English and
 * romaji title, typed exactly as written, with every write intent, on the persona's list and on
 * an empty one, must resolve to that show, or ask (or, for a removal, find nothing), never write
 * to a different show; the known exceptions are pinned in KNOWN. Then every listed show's title with one letter wrong must resolve as the right spelling does, or ask.
 */
import { describe, expect, test } from "bun:test";
import { AniListClient, type Media } from "../src/anilist";
import { normalize } from "../src/logic";
import { resolveAnime, type AnimeSource, type Intent, type Resolution } from "../src/resolve";
import { clientSource } from "../src/server";
import { PERSONA } from "./fixtures/persona";
import { catalog, FakeAniList, findMedia, type SeedEntry } from "./support/fake-anilist";

const WRITES = ["add", "status", "progress", "rate", "remove"] as const satisfies Intent[];

/**
 * The fake behind a cache: nothing here writes, so the list, each search and each relation
 * fetch is asked of the fake once per list, which keeps thousands of resolutions fast.
 */
function cachedSource(entries: SeedEntry[]): AnimeSource {
  const src = clientSource(new AniListClient("test", new FakeAniList().seed(entries).fetch));
  const cache = new Map<string, Promise<Media[]>>();
  const once = (key: string, get: () => Promise<Media[]>) => {
    if (!cache.has(key)) cache.set(key, get());
    return cache.get(key)!;
  };
  return {
    listMedia: () => once("list", () => src.listMedia()),
    search: (q) => once(`search ${q}`, () => src.search(q)),
    getRelated: (ids) => once(`related ${ids.join(",")}`, () => src.getRelated(ids)),
    searchHidden: (q) => once(`hidden ${q}`, () => src.searchHidden!(q)),
  };
}

const LISTS = { persona: PERSONA, empty: [] as SeedEntry[] };
type ListName = keyof typeof LISTS;

const byId = new Map(catalog.map((m) => [m.id, m]));
const SERIES = new Set(["TV", "TV_SHORT", "ONA"]);

/** Everything after `id` in sequel order, through SEQUEL edges. */
function sequelsOf(id: number): Set<number> {
  const found = new Set<number>();
  const stack = [id];
  while (stack.length) {
    for (const e of byId.get(stack.pop()!)?.relations?.edges ?? []) {
      if (e.relationType !== "SEQUEL" || found.has(e.node.id)) continue;
      found.add(e.node.id);
      stack.push(e.node.id);
    }
  }
  return found;
}

/** No series comes before it in sequel order: its title is the show's name ("Jujutsu Kaisen"). */
function firstSeason(id: number): boolean {
  return !catalog.some((m) => SERIES.has(m.format ?? "") && m.id !== id && sequelsOf(m.id).has(id));
}

/**
 * Designed divergences. The show's name means the season the list points at for an episode or a
 * status change: the one being watched or planned (R1.4, R1.12), or after a completed season the
 * aired sequel (#35). Only for a first season's title, the show's name: a later season's title
 * means that season (#73).
 */
function designed(list: ListName, intent: Intent, typed: number, got: number): boolean {
  return list === "persona" && (intent === "status" || intent === "progress") && firstSeason(typed) && sequelsOf(typed).has(got);
}

/**
 * Known divergences, each pinned to what it resolves to today so that a change to it shows up
 * here. "<list> <intent> <title>": [what it resolves to, why it's left].
 */
/** Specials and OVAs with "movie" or "film" in the title: the word asks for a movie (R1.8). */
const NOT_A_MOVIE = [
  "ONE PIECE FILM: Z - GLORIOUS ISLAND",
  "My Hero Academia the Movie: Two Heroes Specials",
  "Boku no Hero Academia THE MOVIE: Futari no Hero Specials",
  "Boku no Hero Academia THE MOVIE: Heroes:Rising - Epilogue Plus: Yume wo Genjitsu ni",
  "Mob Psycho 100 10th Anniversary Special Movie",
];

const KNOWN: Record<string, [number | "none", string]> = Object.fromEntries(
  [
    ...(["persona", "empty"] as const).flatMap((list) =>
      (["add", "status", "progress", "rate"] as const).map((intent) => [
        `${list} ${intent} Kimetsu no Yaiba: Mugen Ressha-hen`,
        // The TV arc's romaji is the movie's plus AniList's "(TV)" tag, which tells same-named
        // anime apart; both read as the name, and the series is preferred (FORMAT_TAG).
        [129874, "the TV arc shares the movie's romaji title, told apart only by AniList's (TV) tag"],
      ]),
    ),
    // Season 2, being watched, has the movie's arc name in a synonym: it keeps an episode (R1.10),
    // and a removal looks only at the list, where the movie isn't.
    ["persona progress Jujutsu Kaisen: Kaigyoku・Gyokusetsu", [145064, "R1.10: the season being watched has the name in a synonym"]],
    ["persona remove Jujutsu Kaisen: Kaigyoku・Gyokusetsu", [145064, "a removal sees only the list; the movie isn't on it"]],
    // Finds nothing rather than a wrong show: the movie filter leaves only movies, and these aren't.
    ...(["persona", "empty"] as const).flatMap((list) =>
      (["add", "status", "progress", "rate"] as const).flatMap((intent) =>
        NOT_A_MOVIE.map((title) => [`${list} ${intent} ${title}`, ["none", "a special or OVA with movie or film in its title: the word asks for a movie (R1.8)"]]),
      ),
    ),
  ] as [string, [number | "none", string]][],
);

const outcome = (r: Resolution) => (r.kind === "match" ? r.media.id : r.kind);

describe("every exact title, every write intent", () => {
  for (const list of Object.keys(LISTS) as ListName[]) {
    test(`on ${list === "persona" ? "the persona's list" : "an empty list"}`, async () => {
      const source = cachedSource(LISTS[list]);
      const cases = catalog
        .filter((m) => !m.isAdult)
        .flatMap((m) => [...new Set([m.title.english, m.title.romaji].filter((t): t is string => Boolean(t)))].map((title) => ({ m, title })))
        .flatMap(({ m, title }) => WRITES.map((intent) => ({ id: m.id, title, intent, key: `${list} ${intent} ${title}` })));
      // All at once: nothing writes, and the searches go out in batches as they would in update_shows.
      const results = await Promise.all(cases.map((c) => resolveAnime(c.title, c.intent, source, "ENGLISH")));
      const wrong: string[] = [];
      const seen = new Set<string>();
      cases.forEach(({ id, intent, key }, i) => {
        const got = outcome(results[i]!);
        if (KNOWN[key]) {
          seen.add(key);
          if (got !== KNOWN[key][0]) wrong.push(`${key}: now ${got}; update KNOWN`);
          return;
        }
        // Asking changes nothing: safe. Finding nothing is expected only for a removal of an unlisted show.
        if (got === id || got === "ambiguous" || (got === "none" && intent === "remove") || (typeof got === "number" && designed(list, intent, id, got))) return;
        wrong.push(`${key} [${id}] -> ${got}`);
      });
      expect(wrong).toEqual([]);
      expect([...seen].sort()).toEqual(Object.keys(KNOWN).filter((k) => k.startsWith(`${list} `)).sort());
      expect(cases.length).toBeGreaterThan(1500);
    });
  }
});

/** One letter wrong in the longest Latin word of 5 letters or more ("frieren" -> "frieran"). */
function misspell(title: string): string | undefined {
  const words = normalize(title).split(" ");
  const word = [...words].filter((w) => /^[a-z]{5,}$/.test(w)).sort((a, b) => b.length - a.length)[0];
  if (!word) return undefined;
  const i = word.length - 2;
  const wrong = `${word.slice(0, i)}${word[i] === "a" ? "e" : "a"}${word.slice(i + 1)}`;
  return words.map((w) => (w === word ? wrong : w)).join(" ");
}

describe("a title with one letter wrong resolves as the right spelling does (R1.2)", () => {
  test("for every show on the persona's list", async () => {
    const source = cachedSource(PERSONA);
    const wrong: string[] = [];
    let checked = 0;
    for (const m of PERSONA.map((e) => findMedia(e.anime))) {
      for (const title of new Set([m.title.english, m.title.romaji].filter((t): t is string => Boolean(t)))) {
        const typo = misspell(title);
        if (!typo) continue;
        for (const intent of ["status", "progress", "rate"] as const) {
          const right = outcome(await resolveAnime(normalize(title), intent, source, "ENGLISH"));
          const got = outcome(await resolveAnime(typo, intent, source, "ENGLISH"));
          checked++;
          // Asking, or finding nothing, is safe; a different entry is not.
          if (got !== right && typeof got === "number") wrong.push(`${intent} "${typo}" -> ${got}, but "${title}" -> ${right}`);
        }
      }
    }
    expect(wrong).toEqual([]);
    expect(checked).toBeGreaterThan(80);
  });
});
