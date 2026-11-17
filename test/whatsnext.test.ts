import { beforeEach, describe, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { AniListClient, type ListStatus, type Media } from "../src/anilist";
import { createServer } from "../src/server";
import {
  airedEpisodes,
  buildReport,
  caughtUpProgress,
  checkTimeZone,
  formatAirTime,
  formatReport,
  formatShow,
  nextSeasons,
  streamingLines,
  watchTime,
} from "../src/whatsnext";
import { PERSONA } from "./fixtures/persona";
import { FakeAniList } from "./support/fake-anilist";

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
    expect(formatAirTime(EP8_AIRS, NOW, "UTC")).toBe("Fri, Nov 20 at 2:00 PM (in 3 days)");
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
      "- ONE PIECE: 80 episodes to watch, about 32 hours (on 1100 of 1180 aired). Episode 1181 airs Sun, Jan 3 at 2:16 PM (in 47 days).",
    );
    expect(sections[0]!.split("\n")[2]).toContain("- DAN DA DAN: 5 episodes to watch, about 2 hours (on 7 of 12 aired).");
    expect(sections[1]).toContain("- The Apothecary Diaries Season 3: episode 8 airs Fri, Nov 20 at 2:00 PM (in 3 days).");
    // Sequels of finished shows that haven't been started; planned ones say so.
    expect(sections[2]).toContain("[182255] Frieren: Beyond Journey’s End Season 2");
    expect(sections[2]).toContain("not on your list");
    expect(sections[2]).toContain("[140439] Mob Psycho 100 III (12 episodes, 2022), on your plan-to-watch list.");
    // Sequels already started aren't suggested; dropped shows aren't "on hold".
    expect(r.text).not.toContain("After JUJUTSU KAISEN");
    expect(r.text).not.toContain("VINLAND");
    expect(sections[3]).toContain("- Attack on Titan Final Season: 6 episodes to watch, about 2.5 hours (on 10 of 16 aired).");
    expect(sections[4]).toContain("Bocchi the Rock! 2nd Season (not out yet)");
    expect(r.requests).toBeLessThanOrEqual(3);
  });

  test("one show by name: progress, next air time, what comes after", async () => {
    const r = await call({ anime: "apothecary diaries", timeZone: "UTC" });
    expect(r.text).toContain("you're watching it");
    expect(r.text).toContain("Aired: 7 of 12 episodes.");
    expect(r.text).toContain("You: Watching, watched 7.");
    expect(r.text).toContain("Next: episode 8 airs Fri, Nov 20 at 2:00 PM (in 3 days).");
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

  test("the full report doesn't fetch streaming links", async () => {
    const r = await call({ timeZone: "UTC" });
    expect(r.text).not.toContain("Stream on");
    expect(fake.calls.some((c) => c.query.includes("externalLinks"))).toBe(false);
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
