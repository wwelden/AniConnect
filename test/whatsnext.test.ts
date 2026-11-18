import { beforeEach, describe, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { AniListClient, type ListStatus, type Media } from "../src/anilist";
import { createServer } from "../src/server";
import {
  aboutLines,
  airedEpisodes,
  buildReport,
  caughtUpProgress,
  checkTimeZone,
  formatAirTime,
  formatReport,
  formatShow,
  nextSeasons,
  plainSynopsis,
  SECTION_LIMITS,
  streamingLines,
  SYNOPSIS_LENGTH,
  watchTime,
  type NextSeason,
} from "../src/whatsnext";
import { PERSONA } from "./fixtures/persona";
import { FakeAniList, findMedia } from "./support/fake-anilist";

/** The fixture's airing schedule was captured on this day. */
const NOW = Date.parse("2026-11-17T12:00:00Z");
const EP8_AIRS = 1795183200; // Apothecary Diaries S3 episode 8: 2026-11-20 14:00 UTC

describe("airedEpisodes", () => {
  test("airing: one before the next scheduled episode", () => {
    expect(airedEpisodes({ status: "RELEASING", episodes: 12, nextAiringEpisode: { episode: 8, airingAt: EP8_AIRS } }, NOW)).toBe(7);
  });

  test("counts a scheduled episode whose air time has passed", () => {
    const later = (EP8_AIRS + 60) * 1000;
    expect(airedEpisodes({ status: "RELEASING", episodes: 12, nextAiringEpisode: { episode: 8, airingAt: EP8_AIRS } }, later)).toBe(8);
  });

  test("finished: every episode", () => {
    expect(airedEpisodes({ status: "FINISHED", episodes: 24, nextAiringEpisode: null }, NOW)).toBe(24);
  });

  test("unknown when airing without a schedule, or not out", () => {
    expect(airedEpisodes({ status: "RELEASING", episodes: null, nextAiringEpisode: null }, NOW)).toBeNull();
    expect(airedEpisodes({ status: "NOT_YET_RELEASED", episodes: 12, nextAiringEpisode: null }, NOW)).toBeNull();
  });
});

describe("formatAirTime", () => {
  test("weekday, time and days away in the given zone", () => {
    expect(formatAirTime(EP8_AIRS, NOW, "UTC")).toBe("Fri, Nov 20 at 2:00 PM UTC (in 3 days)");
    expect(formatAirTime(EP8_AIRS, NOW, "Asia/Tokyo")).toBe("Fri, Nov 20 at 11:00 PM (in 3 days)");
  });

  test("today and tomorrow by calendar day, not 24-hour blocks", () => {
    expect(formatAirTime(NOW / 1000 + 3600, NOW, "UTC")).toContain("(today)");
    expect(formatAirTime(NOW / 1000 + 13 * 3600, NOW, "UTC")).toContain("(tomorrow)");
  });

  test("rejects unknown time zones", () => {
    expect(() => checkTimeZone("Mars/Olympus")).toThrow("Unknown time zone");
    expect(checkTimeZone("America/New_York")).toBe("America/New_York");
  });
});

describe("watchTime", () => {
  test("minutes to the nearest 5 under an hour", () => {
    expect(watchTime(1, 24)).toBe(", about 25 minutes");
    expect(watchTime(2, 12)).toBe(", about 25 minutes");
    expect(watchTime(1, 2)).toBe(", a few minutes");
    expect(watchTime(3, 2)).toBe(", about 5 minutes");
  });

  test("hours to the nearest half from an hour up", () => {
    expect(watchTime(1, 58)).toBe(", about 1 hour");
    expect(watchTime(5, 24)).toBe(", about 2 hours");
    expect(watchTime(6, 24)).toBe(", about 2.5 hours");
    expect(watchTime(3, 24)).toBe(", about 1 hour");
  });

  test("whole hours from 10 up", () => {
    expect(watchTime(25, 24)).toBe(", about 10 hours");
    expect(watchTime(80, 24)).toBe(", about 32 hours");
  });

  test("nothing when the duration is unknown or nothing is left", () => {
    expect(watchTime(5, null)).toBe("");
    expect(watchTime(5, 0)).toBe("");
    expect(watchTime(0, 24)).toBe("");
  });
});

describe("whats_next tool", () => {
  let fake: FakeAniList;
  let client: Client;

  beforeEach(async () => {
    fake = new FakeAniList().seed(PERSONA);
    const server = createServer(new AniListClient("t", fake.fetch), { now: () => NOW });
    const [a, b] = InMemoryTransport.createLinkedPair();
    client = new Client({ name: "t", version: "0" });
    await Promise.all([server.connect(b), client.connect(a)]);
  });

  async function call(args: Record<string, unknown>) {
    const before = fake.calls.length;
    const r = (await client.callTool({ name: "whats_next", arguments: args })) as {
      content: { text: string }[];
      isError?: boolean;
    };
    return { text: r.content[0]!.text, isError: Boolean(r.isError), requests: fake.calls.length - before };
  }

  test("full report: unwatched episodes, air times, next seasons, on hold", async () => {
    const r = await call({ timeZone: "UTC" });
    expect(r.isError).toBe(false);
    const sections = r.text.split("\n\n");
    expect(sections.map((s) => s.split("\n")[0])).toEqual([
      "New episodes to watch:",
      "Caught up, waiting for new episodes:",
      "Next seasons of shows you finished:",
      "On hold, with episodes left:",
      "Announced sequels:",
    ]);
    // Airing shows first, then fewest episodes to go.
    expect(sections[0]).toContain(
      "- ONE PIECE: 80 episodes to watch, about 32 hours (on 1100 of 1180 aired). Episode 1181 airs Sun, Jan 3 at 2:16 PM UTC (in 47 days).",
    );
    expect(sections[0]!.split("\n")[2]).toContain("- DAN DA DAN: 5 episodes to watch, about 2 hours (on 7 of 12 aired).");
    expect(sections[1]).toContain("- The Apothecary Diaries Season 3: episode 8 airs Fri, Nov 20 at 2:00 PM UTC (in 3 days).");
    // Sequels of finished shows that haven't been started; planned ones say so.
    expect(sections[2]).toContain("[182255] Frieren: Beyond Journey’s End Season 2");
    expect(sections[2]).toContain("not on your list");
    expect(sections[2]).toContain("[140439] Mob Psycho 100 III (12 episodes, 2022), on your plan-to-watch list.");
    // Sequels already started aren't suggested; dropped shows aren't "on hold".
    expect(r.text).not.toContain("After JUJUTSU KAISEN");
    expect(r.text).not.toContain("VINLAND");
    expect(sections[3]).toContain("- Attack on Titan Final Season: 6 episodes to watch, about 2.5 hours (on 10 of 16 aired).");
    expect(sections[4]).toContain("Bocchi the Rock! 2nd Season (not out yet)");
    // A list this size isn't cut.
    expect(r.text).not.toContain("more.");
    expect(r.text).not.toContain("all: true");
    expect(r.requests).toBeLessThanOrEqual(3);
  });

  test("all: true reads the same as the default on a short list", async () => {
    const cut = await call({ timeZone: "UTC" });
    const all = await call({ timeZone: "UTC", all: true });
    expect(all.text).toBe(cut.text);
  });

  test("one show by name: progress, next air time, what comes after", async () => {
    const r = await call({ anime: "apothecary diaries", timeZone: "UTC" });
    expect(r.text).toContain("you're watching it");
    expect(r.text).toContain("Aired: 7 of 12 episodes.");
    expect(r.text).toContain("You: Watching, watched 7.");
    expect(r.text).toContain("Next: episode 8 airs Fri, Nov 20 at 2:00 PM UTC (in 3 days).");
    expect(r.text).toContain("Comes next: [200927] Kusuriya no Hitorigoto 3rd Season Part 2 (not out yet, expected 2027)");
  });

  test("one show you're behind on says how long the aired episodes take", async () => {
    const r = await call({ anime: "dandadan", timeZone: "UTC" });
    expect(r.text).toContain("You: Watching, watched 7, 5 aired episodes to go, about 2 hours.");
  });

  test("a finished show is described with its next season", async () => {
    const r = await call({ anime: "frieren", timeZone: "UTC" });
    expect(r.text).toContain("\nFrieren: Beyond Journey’s End [154587]\n");
    expect(r.text).toContain("You: Completed, watched 28.");
    expect(r.text).toContain("Comes next: [182255] Frieren: Beyond Journey’s End Season 2 (10 episodes, 2026), not on your list.");
  });

  test("where to watch: streaming sites with links, in the same requests", async () => {
    const show = await call({ anime: "frieren", timeZone: "UTC" });
    expect(show.text).toContain(
      "Stream on (availability varies by region):\n- Crunchyroll: https://www.crunchyroll.com/series/GG5H5XQX4/frieren-beyond-journeys-end",
    );
    expect(show.text).toContain("- YouTube (Muse Asia): https://www.youtube.com/");
    // Official site and social links aren't streaming.
    expect(show.text).not.toContain("frieren-anime.jp");
    expect(show.text).not.toContain("twitter.com");
    // Viewer, list, then one fetch for relations and links together: the same as before links.
    expect(show.requests).toBe(3);
  });

  test("shows found by search or a season lookup carry their links, without another request", async () => {
    // Not on the list: found by search. Same 3 requests as before streaming links.
    const search = await call({ anime: "chainsaw man", timeZone: "UTC" });
    expect(search.text).toContain("Stream on (availability varies by region):");
    expect(search.requests).toBe(3);
    const season = await call({ anime: "the new frieren season", timeZone: "UTC" });
    expect(season.text).toContain("[182255]");
    expect(season.text).toContain("Stream on (availability varies by region):");
    expect(season.requests).toBe(2); // the viewer and list are cached by now: search, then getRelated
  });

  test("what a show is about: format, season, studio, source, genres, tags and synopsis, in the same requests", async () => {
    const r = await call({ anime: "frieren", timeZone: "UTC" });
    const lines = r.text.split("\n");
    expect(lines.slice(1, 4)).toEqual([
      "Frieren: Beyond Journey’s End [154587]",
      "TV, Fall 2023, by MADHOUSE, based on a manga. Genres: Adventure, Drama, Fantasy.",
      // "Time Skip" ranks above Found Family on AniList, but it's marked a spoiler.
      "Tags: Travel, Magic, Elf, Female Protagonist, Philosophy.",
    ]);
    expect(lines[4]).toStartWith("About: The adventure is over but life goes on for an elf mage");
    // AniList's line breaks and its "(Source: Crunchyroll)" credit are gone.
    expect(lines[4]).toEndWith("finds herself beginning a new adventure…");
    expect(r.text).not.toContain("Time Skip");
    expect(r.requests).toBe(3); // viewer, list, then one fetch for relations, links and details
  });

  test("a show found by search says what it's about, without another request", async () => {
    const r = await call({ anime: "chainsaw man", timeZone: "UTC" });
    expect(r.text).toContain("TV, Fall 2022, by MAPPA, based on a manga. Genres: Action, Drama, Horror, Supernatural.");
    expect(r.text).toContain("About: Denji is a teenage boy living with a Chainsaw Devil named Pochita.");
    expect(r.requests).toBe(3); // viewer, list, search
  });

  test("searches with the one-show fields go 6 to a request, to stay under AniList's complexity limit", async () => {
    // Measured on AniList: 7 searches count 7 × 58 = 406 of the 500 allowed, but 7 × 77 = 539 with these fields.
    const anilist = new AniListClient("t", fake.fetch);
    const names = ["frieren", "jjk", "dandadan", "one piece", "bocchi", "oshi no ko", "haikyuu"];
    const before = fake.calls.length;
    await anilist.searchMany(names, 15);
    expect(fake.calls.length - before).toBe(1);
    const results = await anilist.searchMany(names, 15, { oneShow: true });
    expect(fake.calls.length - before).toBe(3);
    expect(results.map((r) => r.length > 0)).toEqual(names.map(() => true));
    expect(results[0]![0]!.description).toBeString();
  });

  test("the full report doesn't fetch streaming links or what shows are about", async () => {
    const r = await call({ timeZone: "UTC" });
    expect(r.text).not.toContain("Stream on");
    expect(r.text).not.toContain("About:");
    expect(fake.calls.some((c) => /externalLinks|description|tags/.test(c.query))).toBe(false);
  });

  test("a sequel by ID says which season before it is on the list", async () => {
    const r = await call({ anime: 182255, timeZone: "UTC" });
    expect(r.text).toContain("Comes after: [154587] Frieren: Beyond Journey’s End, completed on your list.");
    expect(r.text).toContain("Not on your list.");
  });

  test("a scheduled episode whose time has passed counts as aired and isn't shown as upcoming", async () => {
    fake.entries.clear();
    fake.seed([{ anime: "Kusuriya no Hitorigoto 3rd Season", status: "CURRENT", progress: 7 }]);
    const server = createServer(new AniListClient("t", fake.fetch), { now: () => (EP8_AIRS + 3600) * 1000 });
    const [a, b] = InMemoryTransport.createLinkedPair();
    const late = new Client({ name: "t", version: "0" });
    await Promise.all([server.connect(b), late.connect(a)]);
    const r = (await late.callTool({ name: "whats_next", arguments: { timeZone: "UTC" } })) as { content: { text: string }[] };
    expect(r.content[0]!.text).toContain("1 episode to watch, about 25 minutes (on 7 of 8 aired).");
    expect(r.content[0]!.text).not.toContain("airs");
  });

  test("read-only errors don't claim nothing was changed", async () => {
    const r = await call({ anime: "zzzz not a show" });
    expect(r.isError).toBe(true);
    expect(r.text).not.toContain("Nothing was changed");
  });

  test("an empty list is caught up", async () => {
    fake.entries.clear();
    const r = await call({ timeZone: "UTC" });
    expect(r.text).toBe("Nothing new: you're caught up on everything you're watching.");
  });

  test("a movie that continues a finished show comes next, in the report and for the show", async () => {
    fake.entries.clear();
    fake.seed([{ anime: "Chainsaw Man", status: "COMPLETED" }]);
    const line = "[171627] Chainsaw Man – The Movie: Reze Arc (movie, 2025), not on your list.";
    const show = await call({ anime: "chainsaw man", timeZone: "UTC" });
    expect(show.text).toContain(`Comes next: ${line}`);
    const report = await call({ timeZone: "UTC" });
    expect(report.text).toBe(`Next seasons of shows you finished:\n- After Chainsaw Man: ${line}`);
    expect(report.requests).toBeLessThanOrEqual(3);
  });

  test("a movie that retells the next TV season is named with it, not listed again", async () => {
    fake.entries.clear();
    fake.seed([{ anime: "Kimetsu no Yaiba", status: "COMPLETED" }]);
    const line =
      "[129874] Demon Slayer: Kimetsu no Yaiba Mugen Train Arc (7 episodes, 2021), not on your list. " +
      "Same story as the movie [112151] Demon Slayer -Kimetsu no Yaiba- The Movie: Mugen Train; watch either.";
    const report = await call({ timeZone: "UTC" });
    expect(report.text).toBe(`Next seasons of shows you finished:\n- After Demon Slayer: Kimetsu no Yaiba: ${line}`);
    expect(report.requests).toBeLessThanOrEqual(4);
    const show = await call({ anime: "demon slayer", timeZone: "UTC" });
    expect(show.text).toContain(`Comes next: ${line}`);
    expect(show.text.match(/Comes next/g)?.length).toBe(1);
  });

  test("having watched the movie version skips the TV version and moves on", async () => {
    fake.entries.clear();
    fake.seed([
      { anime: "Kimetsu no Yaiba", status: "COMPLETED" },
      { anime: "Kimetsu no Yaiba: Mugen Ressha-hen", status: "COMPLETED" },
    ]);
    const r = await call({ timeZone: "UTC" });
    expect(r.text).not.toContain("[129874]");
    expect(r.text).toContain("[142329] Demon Slayer: Kimetsu no Yaiba Entertainment District Arc");
  });

  test("a planned movie version of the next season says it's planned", async () => {
    fake.entries.clear();
    fake.seed([
      { anime: "Kimetsu no Yaiba", status: "COMPLETED" },
      { anime: "Kimetsu no Yaiba: Mugen Ressha-hen", status: "PLANNING" },
    ]);
    const r = await call({ timeZone: "UTC" });
    expect(r.text).toContain("Mugen Train Arc (7 episodes, 2021), not on your list.");
    expect(r.text).toContain("The Movie: Mugen Train (on your plan-to-watch list); watch either.");
  });

  test("a movie sequel that isn't the same story is listed on its own", async () => {
    fake.entries.clear();
    fake.seed([{ anime: "Tensei Shitara Slime Datta Ken 3rd Season", status: "COMPLETED" }]);
    const r = await call({ timeZone: "UTC" });
    expect(r.text).toContain("[182205] That Time I Got Reincarnated as a Slime Season 4");
    expect(r.text).toContain("[182206] That Time I Got Reincarnated as a Slime the Movie: Tears of the Azure Sea (movie, 2026), not on your list.");
    expect(r.text).not.toContain("Same story");
  });

  test("a recap movie isn't next, even when another recap lists it as a sequel", async () => {
    fake.entries.clear();
    fake.seed([
      { anime: "Bocchi the Rock!", status: "COMPLETED" },
      { anime: "Bocchi the Rock! Re:", status: "COMPLETED" },
    ]);
    const r = await call({ timeZone: "UTC" });
    expect(r.text).not.toContain("[171099]");
    expect(r.text).toContain("Bocchi the Rock! 2nd Season");
  });

  test("a planned movie says it's on the plan-to-watch list", async () => {
    fake.entries.clear();
    fake.seed([
      { anime: "Chainsaw Man", status: "COMPLETED" },
      { anime: "Chainsaw Man: Reze-hen", status: "PLANNING" },
    ]);
    expect((await call({ anime: "chainsaw man", timeZone: "UTC" })).text).toContain(
      "(movie, 2025), on your plan-to-watch list.",
    );
  });

  // A separate test, so the list isn't served from the cache filled by the call above.
  test("a movie already started isn't next", async () => {
    fake.entries.clear();
    fake.seed([
      { anime: "Chainsaw Man", status: "COMPLETED" },
      { anime: "Chainsaw Man: Reze-hen", status: "CURRENT" },
    ]);
    expect((await call({ anime: "chainsaw man", timeZone: "UTC" })).text).not.toContain("Comes next");
  });

  test("never writes", async () => {
    await call({ timeZone: "UTC" });
    await call({ anime: "jjk", timeZone: "UTC" });
    expect(fake.writes.length).toBe(0);
  });
});

describe("streamingLines", () => {
  const link = (site: string, url: string | null, type = "STREAMING", extra: Partial<{ notes: string; isDisabled: boolean }> = {}) => ({
    site, url, type, notes: extra.notes ?? null, isDisabled: extra.isDisabled ?? false,
  });

  test("nothing when AniList has no streaming links", () => {
    expect(streamingLines([])).toEqual([]);
    expect(streamingLines([link("Official Site", "https://a.jp", "INFO"), link("Twitter", "https://x.com/a", "SOCIAL")])).toEqual([]);
  });

  test("streaming links only, with notes, skipping disabled and repeated links", () => {
    expect(
      streamingLines([
        link("Crunchyroll", "https://cr.com/a"),
        link("Twitter", "https://x.com/a", "SOCIAL"),
        link("YouTube", "https://yt.com/en", "STREAMING", { notes: "EN" }),
        link("Old site", "https://old.com/a", "STREAMING", { isDisabled: true }),
        link("Crunchyroll", "https://cr.com/a"),
        link("No URL", null),
      ]),
    ).toEqual([
      "Stream on (availability varies by region):",
      "- Crunchyroll: https://cr.com/a",
      "- YouTube (EN): https://yt.com/en",
    ]);
  });
});

describe("buildReport edge cases", () => {
  const base = {
    title: { romaji: "Show", english: null, native: null },
    synonyms: [],
    duration: null,
    format: "TV",
    seasonYear: 2026,
    startDate: { year: 2026, month: 1, day: 1 },
    averageScore: null,
    siteUrl: "",
  };
  const entry = (status: ListStatus, progress: number) => ({
    id: 1, status, progress, score: 0, displayScore: 0,
    startedAt: { year: null, month: null, day: null }, completedAt: { year: null, month: null, day: null },
  });

  test("a show airing with no schedule is reported as unknown, not caught up", () => {
    const m = { ...base, id: 1, episodes: null, status: "RELEASING", nextAiringEpisode: null, mediaListEntry: entry("CURRENT", 0) } as Media;
    const text = formatReport(buildReport([m], [], NOW), NOW, "UTC", "ENGLISH");
    expect(text).toBe("Airing, but AniList doesn't say how many episodes are out:\n- Show: you're on episode 0.");
  });

  test("caught up on an airing show whose next date isn't announced", () => {
    // The last scheduled episode (4) has aired and been watched; no new date yet.
    const m = {
      ...base, id: 1, episodes: 12, status: "RELEASING",
      nextAiringEpisode: { episode: 4, airingAt: NOW / 1000 - 3600 }, mediaListEntry: entry("CURRENT", 4),
    } as Media;
    const text = formatReport(buildReport([m], [], NOW), NOW, "UTC", "ENGLISH");
    expect(text).toBe("Caught up, waiting for new episodes:\n- Show: still airing, no date announced for the next episode.");
  });

  test("a sequel isn't next when the user finished another version of it", () => {
    // Show 1's only sequel is series 2; movie 3, finished, is the same story as 2.
    const show = {
      ...base, id: 1, episodes: 12, status: "FINISHED", nextAiringEpisode: null, mediaListEntry: entry("COMPLETED", 12),
      relations: { edges: [{ relationType: "SEQUEL", node: { id: 2, type: "ANIME", format: "TV", status: "FINISHED" } }] },
    } as Media;
    const movie = {
      ...show, id: 3, format: "MOVIE", episodes: 1,
      relations: { edges: [{ relationType: "ALTERNATIVE", node: { id: 2, type: "ANIME", format: "TV", status: "FINISHED" } }] },
    } as Media;
    expect(nextSeasons([show], new Map([[1, "COMPLETED"]])).map((s) => s.next.id)).toEqual([2]);
    expect(nextSeasons([show, movie], new Map<number, ListStatus>([[1, "COMPLETED"], [3, "COMPLETED"]]))).toEqual([]);
  });

  test("episode counts leave the time out when the duration is unknown", () => {
    const m = { ...base, id: 1, episodes: 12, status: "FINISHED", nextAiringEpisode: null, mediaListEntry: entry("CURRENT", 2) } as Media;
    expect(formatReport(buildReport([m], [], NOW), NOW, "UTC", "ENGLISH")).toBe("New episodes to watch:\n- Show: 10 episodes to watch (on 2 of 12 aired).");
    expect(formatShow(m, [], new Map(), NOW, "UTC", "ENGLISH")).toContain("You: Watching, watched 2, 10 aired episodes to go.");
  });

  test("episode counts give the time when the duration is known", () => {
    const m = { ...base, id: 1, episodes: 12, duration: 24, status: "FINISHED", nextAiringEpisode: null, mediaListEntry: entry("PAUSED", 9) } as Media;
    expect(formatReport(buildReport([m], [], NOW), NOW, "UTC", "ENGLISH")).toBe(
      "On hold, with episodes left:\n- Show: 3 episodes to watch, about 1 hour (on 9 of 12 aired).",
    );
    expect(formatShow(m, [], new Map(), NOW, "UTC", "ENGLISH")).toContain("You: Paused, watched 9, 3 aired episodes to go, about 1 hour.");
  });

  test("cancelled sequels aren't suggested", () => {
    const finished = {
      ...base, id: 1, episodes: 12, status: "FINISHED", nextAiringEpisode: null, mediaListEntry: entry("COMPLETED", 12),
      relations: { edges: [{ relationType: "SEQUEL", node: { id: 2, type: "ANIME", format: "TV", status: "CANCELLED" } }] },
    } as Media;
    expect(nextSeasons([finished], new Map([[1, "COMPLETED"]]))).toEqual([]);
  });
});

describe("caughtUpProgress", () => {
  const title = { romaji: "Show", english: null, native: null };
  const schedule = (episode: number, airedAgo: number) => ({ episode, airingAt: NOW / 1000 - airedAgo });

  test("changes nothing when no episode has aired yet", () => {
    const m = { title, status: "NOT_YET_RELEASED", episodes: 12, nextAiringEpisode: schedule(1, -3600) };
    expect(() => caughtUpProgress(m, 0, NOW, "ENGLISH")).toThrow("Nothing was changed. Show hasn't aired any episodes yet.");
  });

  test("never goes past the episode count when the schedule runs ahead of it", () => {
    const m = { title, status: "RELEASING", episodes: 12, nextAiringEpisode: schedule(14, 3600) };
    expect(caughtUpProgress(m, 5, NOW, "ENGLISH").episodes).toBe(12);
  });
});

describe("plainSynopsis", () => {
  test("nothing when AniList has no description", () => {
    expect(plainSynopsis(null)).toBe("");
    expect(plainSynopsis("")).toBe("");
  });

  test("plain text: no HTML, markdown, entities or source credits", () => {
    expect(
      plainSynopsis(
        "<i>Edward</i> &amp; Alphonse&#039;s <b>quest</b>&#8252;<br><br>\nThey __search__ for the [stone](https://x.com).\n<br><br>\n(Source: Crunchyroll)",
      ),
    ).toBe("Edward & Alphonse's quest‼ They search for the stone.");
    expect(plainSynopsis("A story. img220(https://a.png) ~~~centered~~~ [Written by MAL Rewrite]")).toBe("A story. centered");
  });

  test("leaves spoilers out, including one left open", () => {
    expect(plainSynopsis("She leaves. ~!The hero dies.!~ Then winter comes.")).toBe("She leaves. Then winter comes.");
    expect(plainSynopsis("She leaves. ~!The hero dies, and")).toBe("She leaves.");
    expect(plainSynopsis(`She leaves. <span class='markdown_spoiler'><span>The hero dies.</span></span> Then winter comes.`)).toBe(
      "She leaves. Then winter comes.",
    );
  });

  test("drops notes about the adaptation, including a heading with a line per note", () => {
    expect(plainSynopsis("The story.<br><br>\nNote: Episodes 11 and 12 adapt a novel.")).toBe("The story.");
    // As AniList has it for Demon Slayer's Swordsmith Village Arc.
    const swordsmith = findMedia(145139).description;
    expect(swordsmith).toContain("<i>Notes:<br>\n•");
    expect(plainSynopsis(swordsmith)).toEndWith("a new battle begins for Tanjiro and his comrades.");
  });

  test("keeps story text that only looks like a credit", () => {
    expect(plainSynopsis("He found the (source of his power) at last.")).toBe("He found the (source of his power) at last.");
  });

  test("markdown italics and headings come out as plain words", () => {
    expect(plainSynopsis("# The Story\n_Frieren_ meets *Fern*. Snake_case and 5 * 3 stay.")).toBe(
      "The Story Frieren meets Fern. Snake_case and 5 * 3 stay.",
    );
  });

  test("abbreviations and initials don't end a sentence", () => {
    const text = `${"A".repeat(60)} met him. Then he meets Mr. Satan and J. Smith, who are strong and loud and fast.`;
    expect(plainSynopsis(text, 100)).toBe(`${"A".repeat(60)} met him.`);
  });

  test("a long synopsis ends at the last whole sentence that fits", () => {
    const sentence = "Short sentence here."; // 20 characters, so 4 and their spaces fit in 100
    const text = Array.from({ length: 40 }, () => sentence).join(" ");
    expect(plainSynopsis(text, 100)).toBe(Array.from({ length: 4 }, () => sentence).join(" "));
    expect(plainSynopsis(text).length).toBeLessThanOrEqual(SYNOPSIS_LENGTH);
  });

  test("without a sentence end to cut at, it cuts between words and says so", () => {
    expect(plainSynopsis("word ".repeat(50), 23)).toBe("word word word word…");
    expect(plainSynopsis("x".repeat(50), 10)).toBe(`${"x".repeat(10)}…`);
  });
});

describe("aboutLines", () => {
  test("nothing for a show fetched without the one-show fields", () => {
    const { title, id, format, seasonYear } = findMedia("Sousou no Frieren");
    expect(aboutLines({ title, id, format, seasonYear } as unknown as Media)).toEqual([]);
  });

  test("tags: the highest ranked, without spoilers, and adult ones only with the 18+ setting", () => {
    const tag = (name: string, rank: number, extra: Record<string, boolean> = {}) => ({
      name, rank, isAdult: false, isMediaSpoiler: false, isGeneralSpoiler: false, ...extra,
    });
    const m = {
      genres: ["Comedy"],
      tags: [tag("Low", 20), tag("Twist", 95, { isMediaSpoiler: true }), tag("Nudity", 90, { isAdult: true }), tag("High", 80)],
    } as unknown as Media;
    expect(aboutLines(m)).toContain("Tags: High, Low.");
    expect(aboutLines(m, true)).toContain("Tags: Nudity, High, Low.");
  });

  test("names every main studio and the source in words", () => {
    const m = { format: "TV", genres: [], studios: { nodes: [{ name: "A" }, { name: "B" }, { name: "C" }] }, source: "LIVE_ACTION" };
    expect(aboutLines(m as unknown as Media)).toEqual(["TV, by A, B and C, based on a live-action work."]);
  });

  test("leaves out what AniList doesn't know", () => {
    const m = { format: "ONA", season: null, seasonYear: null, description: null, genres: [], source: "OTHER", studios: { nodes: [] }, tags: [] };
    expect(aboutLines(m as unknown as Media)).toEqual(["ONA."]);
    expect(aboutLines({ ...m, format: null, source: "ORIGINAL", seasonYear: 2024 } as unknown as Media)).toEqual(["2024, original story."]);
  });
});

describe("a long list is cut to what matters most", () => {
  const show = (id: number, romaji: string, fields: Partial<Media>, status: ListStatus, progress: number) =>
    ({
      id, title: { romaji, english: null, native: null }, synonyms: [], duration: 24, format: "TV", seasonYear: 2026,
      startDate: { year: 2026, month: 1, day: 1 }, averageScore: null, siteUrl: "", episodes: null, status: "FINISHED",
      nextAiringEpisode: null,
      mediaListEntry: {
        id, status, progress, score: 0, displayScore: 0,
        startedAt: { year: null, month: null, day: null }, completedAt: { year: null, month: null, day: null },
      },
      ...fields,
    }) as Media;
  const DAY = 86_400;
  const nowS = NOW / 1000;
  // Like the owner's list: 48 shows being watched, 12 on hold, 7 announced sequels.
  const airing = Array.from({ length: 6 }, (_, i) =>
    show(100 + i, `Airing ${i + 1}`, { status: "RELEASING", nextAiringEpisode: { episode: 10, airingAt: nowS + (i + 1) * DAY } }, "CURRENT", 8 - i),
  );
  const backlog = Array.from({ length: 36 }, (_, i) =>
    show(200 + i, `Backlog ${i + 1}`, { episodes: 50 }, "CURRENT", 48 - i),
  );
  const naruto = show(299, "Naruto: Shippuden", { episodes: 500 }, "CURRENT", 366);
  const waiting = Array.from({ length: 5 }, (_, i) =>
    show(300 + i, `Waiting ${i + 1}`, { status: "RELEASING", nextAiringEpisode: { episode: 5, airingAt: nowS + (i + 1) * DAY } }, "CURRENT", 4),
  );
  const onHold = Array.from({ length: 12 }, (_, i) => show(400 + i, `On hold ${i + 1}`, { episodes: 24 }, "PAUSED", 20 - i));
  const finished = show(500, "Finished", { episodes: 12 }, "COMPLETED", 12);
  const sequel = (id: number, status: string): NextSeason => ({
    after: finished,
    next: { id, type: "ANIME", format: "TV", status, episodes: 12, title: { romaji: `Sequel ${id}`, english: null, native: null } } as NextSeason["next"],
    planned: false,
  });
  const sequels = [sequel(600, "FINISHED"), sequel(601, "FINISHED"), ...Array.from({ length: 7 }, (_, i) => sequel(700 + i, "NOT_YET_RELEASED"))];
  const report = buildReport([...backlog, naruto, ...airing, ...waiting, ...onHold, finished], sequels, NOW);

  test("each section keeps its first few and says how many more there are", () => {
    const text = formatReport(report, NOW, "UTC", "ENGLISH");
    const sections = text.split("\n\n");
    expect(sections.map((s) => s.split("\n")[0])).toEqual([
      "New episodes to watch:",
      "Caught up, waiting for new episodes:",
      "Next seasons of shows you finished:",
      "On hold, with episodes left:",
      "Announced sequels:",
      "Long sections are cut short: to list every show, call again with all: true.",
    ]);
    const lines = (i: number) => sections[i]!.split("\n").slice(1);
    // The cut keeps what just aired (airing, at most 3 behind), then the shows closest to
    // done, airing first on a tie, and lists them in the usual order: airing shows first.
    expect(lines(0)).toHaveLength(SECTION_LIMITS.newEpisodes + 1);
    expect(lines(0).map((l) => l.split(":")[0])).toEqual([
      "- Airing 1", "- Airing 2", "- Airing 3", "- Airing 4", "- Airing 5",
      "- Backlog 1", "- Backlog 2", "- Backlog 3", "...and 35 more.",
    ]);
    expect(lines(0)[5]).toBe("- Backlog 1: 2 episodes to watch, about 50 minutes (on 48 of 50 aired).");
    expect(text).not.toContain("Naruto");
    // Sections that fit aren't cut.
    expect(lines(1)).toHaveLength(5);
    expect(lines(2)).toHaveLength(2);
    expect(lines(3)).toEqual([
      "- On hold 1: 4 episodes to watch, about 1.5 hours (on 20 of 24 aired).",
      "- On hold 2: 5 episodes to watch, about 2 hours (on 19 of 24 aired).",
      "- On hold 3: 6 episodes to watch, about 2.5 hours (on 18 of 24 aired).",
      "...and 9 more.",
    ]);
    expect(lines(4)).toHaveLength(SECTION_LIMITS.comingSequels + 1);
    expect(lines(4).at(-1)).toBe("...and 4 more.");
    // Short enough to read at a glance; uncut, it's the owner's 75 lines and more.
    expect(text.split("\n").length).toBeLessThanOrEqual(35);
    expect(formatReport(report, NOW, "UTC", "ENGLISH", { all: true }).split("\n").length).toBeGreaterThan(75);
  });

  test("all: true lists every show, with no cut notes", () => {
    const text = formatReport(report, NOW, "UTC", "ENGLISH", { all: true });
    expect(text).toContain("- Naruto: Shippuden: 134 episodes to watch, about 54 hours (on 366 of 500 aired).");
    expect(text.split("\n\n")[0]!.split("\n")).toHaveLength(1 + 43);
    expect(text.split("\n\n")[3]!.split("\n")).toHaveLength(1 + 12);
    expect(text).not.toContain("more.");
    expect(text).not.toContain("all: true");
  });

  test("a long backlog of an airing show is cut before a show that's nearly done", () => {
    const longRunner = show(910, "Long Runner", { status: "RELEASING", nextAiringEpisode: { episode: 1101, airingAt: nowS + DAY } }, "CURRENT", 800);
    const weekly = Array.from({ length: 7 }, (_, i) =>
      show(920 + i, `Weekly ${i}`, { status: "RELEASING", nextAiringEpisode: { episode: 6, airingAt: nowS + DAY } }, "CURRENT", 4),
    );
    const nearlyDone = show(930, "Nearly Done", { episodes: 12 }, "CURRENT", 11);
    const text = formatReport(buildReport([longRunner, ...weekly, nearlyDone], [], NOW), NOW, "UTC", "ENGLISH");
    expect(text).toContain("- Nearly Done: 1 episode to watch");
    expect(text).not.toContain("Long Runner");
    expect(text).toContain("...and 1 more.");
    // Listed in the usual order: airing shows first.
    expect(text.split("\n")[8]).toStartWith("- Nearly Done");
  });

  test("the zone note is added only when an air time is listed", () => {
    const note = "\nTimes are in UTC.";
    expect(formatReport(report, NOW, "UTC", "ENGLISH", { zoneNote: note })).toEndWith(note);
    expect(formatReport(buildReport([...backlog, naruto, ...onHold], [], NOW), NOW, "UTC", "ENGLISH", { zoneNote: note })).not.toContain(note);
    // Eight shows whose latest episode just aired (AniList hasn't moved the schedule on) rank
    // ahead of one with an air time ahead and more to watch, which is cut.
    const lagging = Array.from({ length: 8 }, (_, i) =>
      show(800 + i, `Lagging ${i}`, { status: "RELEASING", nextAiringEpisode: { episode: 3, airingAt: nowS - 60 } }, "CURRENT", 2),
    );
    const later = show(900, "Later", { status: "RELEASING", nextAiringEpisode: { episode: 11, airingAt: nowS + DAY } }, "CURRENT", 1);
    const cut = buildReport([...lagging, later], [], NOW);
    expect(formatReport(cut, NOW, "UTC", "ENGLISH", { zoneNote: note })).not.toContain(" airs ");
    expect(formatReport(cut, NOW, "UTC", "ENGLISH", { zoneNote: note })).not.toContain(note);
    expect(formatReport(cut, NOW, "UTC", "ENGLISH", { all: true, zoneNote: note })).toEndWith(note);
    expect(formatReport(buildReport([], [], NOW), NOW, "UTC", "ENGLISH", { zoneNote: note })).not.toContain(note);
  });

});
