/**
 * The wider read tools: search_my_list's score, format, year and backlog filters, and
 * search_anime's tag filters, paging, airing calendar and recommendations (similarTo).
 */
import { beforeEach, describe, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { AniListClient, forgetTagCollection } from "../src/anilist";
import { createServer, type ServerOptions } from "../src/server";
import { PERSONA } from "./fixtures/persona";
import { FakeAniList, findMedia } from "./support/fake-anilist";

let fake: FakeAniList;
let client: Client;

async function call(name: string, args: Record<string, unknown>) {
  const result = (await client.callTool({ name, arguments: args })) as { content: { text: string }[]; isError?: boolean };
  return { text: result.content.map((c) => c.text).join("\n"), isError: Boolean(result.isError) };
}

/** 2026-11-17 noon UTC, a Tuesday. */
const NOW = Date.UTC(2026, 10, 17, 12);

async function connect(options: ServerOptions = {}) {
  const server = createServer(new AniListClient("test-token", fake.fetch), { now: () => NOW, ...options });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  client = new Client({ name: "test", version: "0" });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
}

beforeEach(async () => {
  fake = new FakeAniList("POINT_10_DECIMAL");
  fake.clock = () => NOW;
  forgetTagCollection();
  await connect();
});

const ids = (text: string) => [...text.matchAll(/\[(\d+)\]/g)].map((m) => Number(m[1]));
const header = (text: string) => text.split("\n")[0];
const browses = () => fake.calls.filter((c) => c.query.includes("Page(") && c.query.includes("media("));

describe("search_my_list filters", () => {
  // Attack on Titan, Frieren, Dandadan, ONE PIECE, Mob Psycho 100, Bocchi, the FMA movie, a Mob Psycho special titled "Movie".
  const LIST = [
    { anime: 16498, status: "COMPLETED" as const, score: 8 },
    { anime: 154587, status: "COMPLETED" as const, score: 9.5 },
    { anime: 171018, status: "COMPLETED" as const },
    { anime: 21, status: "CURRENT" as const, progress: 1100 },
    { anime: "Mob Psycho 100", status: "REPEATING" as const },
    { anime: "Bocchi the Rock!", status: "PLANNING" as const },
    { anime: 430, status: "COMPLETED" as const, score: 7 },
    { anime: 214031, status: "COMPLETED" as const, score: 9 },
  ];

  test("unrated lists completed and rewatched shows with no score, not the plan-to-watch", async () => {
    fake.seed(LIST);
    const r = await call("search_my_list", { unrated: true });
    expect(r.isError).toBe(false);
    expect(header(r.text)).toBe("2 matches on tester's list for unrated, Completed or Rewatching:");
    expect(ids(r.text).sort()).toEqual([171018, findMedia("Mob Psycho 100").id].sort());
    // With a status, that status.
    const planned = await call("search_my_list", { unrated: true, status: "PLANNING" });
    expect(ids(planned.text)).toEqual([findMedia("Bocchi the Rock!").id]);
  });

  test("unrated can't be combined with a score range", async () => {
    const r = await call("search_my_list", { unrated: true, minScore: 8 });
    expect(r.isError).toBe(true);
    expect(r.text).toContain("unrated");
  });

  test("minScore and maxScore are out of 10, bounds included, and leave unrated shows out", async () => {
    fake.seed(LIST);
    let r = await call("search_my_list", { minScore: 9 });
    expect(ids(r.text).sort()).toEqual([154587, 214031].sort());
    expect(header(r.text)).toContain("scored 9-10 out of 10");
    r = await call("search_my_list", { maxScore: 8 });
    expect(ids(r.text).sort()).toEqual([430, 16498].sort());
    r = await call("search_my_list", { minScore: 7.5, maxScore: 8 });
    expect(ids(r.text)).toEqual([16498]);
  });

  test("score bounds are out of 10 whatever the user's format", async () => {
    fake = new FakeAniList("POINT_3");
    await connect();
    fake.seed(LIST);
    const r = await call("search_my_list", { minScore: 9 });
    expect(ids(r.text).sort()).toEqual([154587, 214031].sort());
    expect(header(r.text)).toContain("out of 10");
  });

  test("formats finds movies that a title search for 'movie' gets wrong", async () => {
    fake.seed(LIST);
    const byTitle = await call("search_my_list", { query: "movie" });
    expect(ids(byTitle.text)).toContain(214031); // a SPECIAL
    const r = await call("search_my_list", { formats: ["MOVIE"] });
    expect(ids(r.text)).toEqual([430]);
    expect(header(r.text)).toContain("MOVIE");
  });

  test("the year range falls back to the start date when the season year is unknown", async () => {
    // HUNTER×HUNTER Pilot-ban has no season year; it started in 1998.
    fake.seed([...LIST, { anime: 10189, status: "COMPLETED" }]);
    const r = await call("search_my_list", { yearFrom: 1998, yearTo: 2005 });
    // The pilot (1998), ONE PIECE (1999) and the FMA movie (2005).
    expect(ids(r.text).sort()).toEqual([10189, 21, 430].sort());
    expect(header(r.text)).toContain("released 1998-2005");
  });

  test("anilistScore sorts by AniList's score, unknown scores last, and shows it", async () => {
    // Bocchi 2nd Season has no score yet.
    fake.seed([...LIST, { anime: 186712, status: "PLANNING" }]);
    const r = await call("search_my_list", { status: "PLANNING", sort: "anilistScore" });
    expect(header(r.text)).toBe("2 matches on tester's list for Plan to watch, best AniList score first:");
    expect(ids(r.text)).toEqual([findMedia("Bocchi the Rock!").id, 186712]);
    expect(r.text).toMatch(/AniList score \d+%/);
    expect(r.text).toContain("no AniList score");
  });

  test("length sorts shortest first, with the watch time, and unknown lengths last", async () => {
    // A movie, a 12-episode show, and Bocchi 2nd Season (no episode count or length yet).
    fake.seed([
      { anime: 430, status: "PLANNING" },
      { anime: 171018, status: "PLANNING" },
      { anime: 186712, status: "PLANNING" },
      { anime: 21, status: "PLANNING" },
    ]);
    const r = await call("search_my_list", { status: "PLANNING", sort: "length" });
    expect(header(r.text)).toContain("shortest first");
    expect(ids(r.text).slice(0, 2)).toEqual([430, 171018]);
    expect(ids(r.text).slice(2).sort()).toEqual([186712, 21].sort());
    expect(r.text).toContain("about 2 hours");
    expect(r.text).toContain("length unknown");
  });

  test("filters cost no request beyond the cached list", async () => {
    fake.seed(LIST);
    await call("search_my_list", {});
    const before = fake.calls.length;
    await call("search_my_list", { minScore: 8, formats: ["TV"], yearFrom: 2010, sort: "length" });
    expect(fake.calls.length).toBe(before);
  });
});

describe("search_anime polish", () => {
  test("a sort alone says it's browsing all anime", async () => {
    const r = await call("search_anime", { sort: "popularity" });
    expect(header(r.text)).toBe("All anime, most popular first:");
  });

  test("a title search prints each show's AniList score", async () => {
    const r = await call("search_anime", { query: "frieren", limit: 1 });
    expect(header(r.text)).toMatch(/^\[154587\] .*, AniList score \d+%$/);
  });

  test("page goes past the first results and says when there are more", async () => {
    const first = await call("search_anime", { genres: ["Action"], limit: 5 });
    expect(first.text.split("\n").at(-1)).toBe("More results: page 2.");
    const second = await call("search_anime", { genres: ["Action"], limit: 5, page: 2 });
    expect(browses().at(-1)!.variables).toMatchObject({ page: 2, perPage: 5 });
    expect(ids(second.text).some((id) => ids(first.text).includes(id))).toBe(false);
    expect(header(second.text)).toBe("Action, most popular first (page 2):");
  });

  test("the last page doesn't offer another", async () => {
    const r = await call("search_anime", { query: "frieren 2nd season", limit: 25 });
    expect(r.text).not.toContain("More results");
  });
});

describe("search_anime tags and exclusions", () => {
  test("filters by tag, ignoring case, with a rank floor", async () => {
    const r = await call("search_anime", { tags: ["isekai"], sort: "score", limit: 25 });
    expect(r.isError).toBe(false);
    // AniList matches tags in any case; the tag list comes back with the results and names it right.
    expect(browses().at(-1)!.variables).toMatchObject({ tags: ["isekai"], minimumTagRank: 60 });
    expect(header(r.text)).toBe("tagged Isekai, highest rated first:");
    expect(ids(r.text)).toContain(178789); // Mushoku Tensei Season 3, Isekai at 91
    expect(ids(r.text)).not.toContain(430); // the FMA movie, Isekai at 50
  });

  test("an unknown tag gets the closest names, in the same two requests", async () => {
    const r = await call("search_anime", { tags: ["Time Travel"] });
    expect(r.isError).toBe(true);
    expect(r.text).toContain('No AniList tag "Time Travel"');
    expect(r.text).toContain("Time Loop");
    expect(r.text).toContain("Time Skip");
    expect(fake.calls).toHaveLength(2);
    // The tag list is kept: a second unknown tag needs no request for it.
    await call("search_anime", { tags: ["Iyashikay"] });
    expect(fake.calls).toHaveLength(2);
  });

  test("suggestions leave adult tags out when 18+ is off", async () => {
    const r = await call("search_anime", { tags: ["Bondag"] });
    expect(r.isError).toBe(true);
    expect(r.text).not.toContain("Bondage");
  });

  test("a genre passed as a tag is searched as a genre, and the header says so", async () => {
    const r = await call("search_anime", { tags: ["romance"], year: 2025 });
    expect(browses().at(-1)!.variables).toMatchObject({ genres: ["Romance"] });
    expect(browses().at(-1)!.variables.tags).toBeUndefined();
    expect(header(r.text)).toContain("Romance");
    expect(r.text).toContain("Chainsaw Man");
  });

  test("exclude takes genres and tags, without a rank floor", async () => {
    const r = await call("search_anime", { exclude: ["Romance", "Isekai"], year: 2026, limit: 25 });
    const vars = browses().at(-1)!.variables;
    expect(vars).toMatchObject({ excludeGenres: ["Romance"], excludeTags: ["Isekai"] });
    expect(vars.minimumTagRank).toBeUndefined();
    expect(header(r.text)).toContain("without Romance, Isekai");
    expect(ids(r.text)).not.toContain(178789);
    expect(ids(r.text)).not.toContain(182205);
  });

  test("notOnMyList leaves out every show on the list", async () => {
    fake.seed(PERSONA);
    const r = await call("search_anime", { season: "WINTER", year: 2026, notOnMyList: true, limit: 25 });
    expect(browses().at(-1)!.variables).toMatchObject({ onList: false });
    expect(header(r.text)).toContain("not on your list");
    expect(r.text).not.toMatch(/: (Watching|Completed|Plan to watch)/);
  });

  test("a year range covers year-only start dates at both ends", async () => {
    const r = await call("search_anime", { yearFrom: 2027, yearTo: 2028, limit: 25 });
    expect(browses().at(-1)!.variables).toMatchObject({ startAfter: 20269999, startBefore: 20290000 });
    expect(header(r.text)).toContain("2027-2028");
    // Started in 2028 with no month: stored as 20280000.
    expect(ids(r.text)).toContain(156631);
  });

  test("a year inside the range given with it is that year; one outside it is refused", async () => {
    let r = await call("search_anime", { year: 2024, yearFrom: 2024, yearTo: 2024 });
    expect(header(r.text)).toBe("2024, most popular first:");
    expect(browses().at(-1)!.variables).toMatchObject({ seasonYear: 2024 });
    expect(browses().at(-1)!.variables.startAfter).toBeUndefined();
    r = await call("search_anime", { yearFrom: 2024, yearTo: 2024 });
    expect(header(r.text)).toBe("2024, most popular first:");
    r = await call("search_anime", { year: 2019, yearFrom: 2020 });
    expect(r.isError).toBe(true);
    expect(r.text).toContain("yearFrom");
  });

  test("maxEpisodes includes the limit and says unknown counts are left out", async () => {
    const r = await call("search_anime", { maxEpisodes: 12, genres: ["Comedy"], limit: 25 });
    expect(browses().at(-1)!.variables).toMatchObject({ episodesBelow: 13 });
    expect(header(r.text)).toContain("12 episodes or fewer");
    expect(r.text).toContain("[171018]"); // Dandadan, 12 episodes
  });

  test("asks the fake nothing it doesn't model", async () => {
    await call("search_anime", { tags: ["Isekai"], exclude: ["Drama"], notOnMyList: true, yearFrom: 2020, maxEpisodes: 24, page: 2 });
    expect([...fake.unmodeled]).toEqual([]);
  });
});

describe("search_anime airing calendar", () => {
  const at = (iso: string) => Date.parse(iso) / 1000;

  test("lists today's episodes by local time, with the user's list state", async () => {
    fake.seed(PERSONA);
    fake.airings = [
      // 22:00 on the 17th in New York, though the 18th in UTC.
      { mediaId: 171018, episode: 9, airingAt: at("2026-11-18T03:00:00Z") },
      { mediaId: 16498, episode: 3, airingAt: at("2026-11-17T14:30:00Z") },
      // The 18th in New York.
      { mediaId: 154587, episode: 2, airingAt: at("2026-11-18T06:00:00Z") },
    ];
    const r = await call("search_anime", { airing: "today", timeZone: "America/New_York" });
    expect(r.isError).toBe(false);
    const lines = r.text.split("\n");
    expect(lines[0]).toBe("Episodes airing today (Tue, Nov 17), times in America/New_York, from AniList's schedule (it can change):");
    expect(lines[1]).toBe("Tue, Nov 17:");
    expect(lines[2]).toMatch(/^- 9:30 AM, episode 3: \[16498\] Attack on Titan \(TV, 2013\): Completed/);
    expect(lines[3]).toMatch(/^- 10:00 PM, episode 9: \[171018\] .*: Watching, 7\/12 episodes/);
    expect(r.text).not.toContain("[154587]");
    // One request besides the viewer and list.
    expect(fake.calls.filter((c) => c.query.includes("airingSchedules"))).toHaveLength(1);
  });

  test("tomorrow and a number of days give calendar days in the zone", async () => {
    fake.airings = [{ mediaId: 154587, episode: 2, airingAt: at("2026-11-18T06:00:00Z") }];
    let r = await call("search_anime", { airing: "tomorrow", timeZone: "America/New_York" });
    expect(header(r.text)).toContain("tomorrow (Wed, Nov 18)");
    expect(r.text).toContain("Wed, Nov 18:");
    expect(r.text).toContain("[154587]");
    r = await call("search_anime", { airing: "week" });
    expect(header(r.text)).toContain("the next 7 days (Tue, Nov 17 to Mon, Nov 23)");
    // The fixture's own next episodes in that week: The Apothecary Diaries Season 3 on the 20th.
    expect(r.text).toContain("Fri, Nov 20:");
    expect(r.text).toContain("[195516]");
  });

  test("the hosted server reads days in UTC and says so", async () => {
    await connect({ hosted: true });
    const r = await call("search_anime", { airing: "week" });
    expect(header(r.text)).toContain("times in UTC");
    expect(r.text).toContain("time zone is unknown");
  });

  test("adult titles stay out unless 18+ is on, and genres and formats filter", async () => {
    fake.airings = [
      { mediaId: 320, episode: 1, airingAt: at("2026-11-17T15:00:00Z") }, // A KITE, adult
      { mediaId: 171018, episode: 9, airingAt: at("2026-11-17T16:00:00Z") }, // Dandadan: Romance
      { mediaId: 16498, episode: 3, airingAt: at("2026-11-17T17:00:00Z") }, // Attack on Titan
    ];
    let r = await call("search_anime", { airing: "today", timeZone: "UTC" });
    expect(ids(r.text)).toEqual([171018, 16498]);
    r = await call("search_anime", { airing: "today", timeZone: "UTC", genres: ["Romance"] });
    expect(ids(r.text)).toEqual([171018]);
    expect(header(r.text)).toContain("Romance");
    r = await call("search_anime", { airing: "today", timeZone: "UTC", formats: ["MOVIE"] });
    expect(r.text).toContain("Nothing on AniList's schedule airs today");
  });

  test("a busy day shows the most popular, keeps the user's shows, and says how many more", async () => {
    fake.seed([{ anime: 218532, status: "CURRENT", progress: 7 }]); // the least popular show in the fixture
    const shows = [16498, 101922, 113415, 21459, 11061, 21, 20958, 5114, 20, 11757, 99147, 21856, 110277, 127230, 21507, 21355, 104578, 1735, 100166, 9253]; // the 20 most popular
    fake.airings = [...shows, 218532].map((mediaId, i) => ({ mediaId, episode: 1, airingAt: at("2026-11-17T13:00:00Z") + i * 60 }));
    const r = await call("search_anime", { airing: "today", timeZone: "UTC" });
    const listed = r.text.split("\n").filter((l) => l.startsWith("- ") && l.includes("episode"));
    expect(listed).toHaveLength(16);
    expect(r.text).toContain("[218532]");
    expect(r.text).toContain("- 5 more, less popular: pass limit (up to 25) to see them");
    // In time order.
    const times = listed.map((l) => ids(l)[0]);
    expect(times.at(-1)).toBe(218532);
  });

  test("reads three pages in one request, a fourth if needed, and says when it stopped", async () => {
    const shows = findMediaIds(220);
    fake.airings = shows.map((mediaId, i) => ({ mediaId, episode: 1, airingAt: at("2026-11-17T12:30:00Z") + i * 600 }));
    let r = await call("search_anime", { airing: 3, timeZone: "UTC", limit: 1 });
    const requests = fake.calls.filter((c) => c.query.includes("airingSchedules"));
    expect(requests).toHaveLength(2);
    expect((requests[0]!.query.match(/airingSchedules\(/g) ?? []).length).toBe(3);
    expect(r.text).toContain("only the first 200 were read");

    fake.calls = [];
    fake.airings = fake.airings.slice(0, 120);
    r = await call("search_anime", { airing: 3, timeZone: "UTC", limit: 1 });
    expect(fake.calls.filter((c) => c.query.includes("airingSchedules"))).toHaveLength(1);
    expect(r.text).not.toContain("only the first");
  });

  test("airing doesn't mix with a title or browse filters", async () => {
    let r = await call("search_anime", { airing: "today", query: "frieren" });
    expect(r.isError).toBe(true);
    expect(r.text).toContain("airing");
    r = await call("search_anime", { airing: "today", season: "FALL", year: 2026 });
    expect(r.isError).toBe(true);
  });

  test("asks the fake nothing it doesn't model", async () => {
    fake.seed(PERSONA);
    await call("search_anime", { airing: "week" });
    expect([...fake.unmodeled]).toEqual([]);
  });
});

/** The first `n` non-adult shows in the fixture, for filling a schedule. */
function findMediaIds(n: number): number[] {
  const { catalog } = require("./support/fake-anilist") as typeof import("./support/fake-anilist");
  return catalog.filter((m) => !m.isAdult).slice(0, n).map((m) => m.id);
}

describe("search_anime similarTo", () => {
  test("recommends what AniList users do, leaving out shows the user completed and folding seasons together", async () => {
    fake.seed(PERSONA);
    const r = await call("search_anime", { similarTo: "frieren" });
    expect(r.isError).toBe(false);
    const lines = r.text.split("\n");
    expect(lines[0]).toMatch(/^Matched "frieren" to Frieren: Beyond Journey’s End/);
    expect(lines[1]).toBe(
      "AniList users' recommendations for Frieren: Beyond Journey’s End, most recommended first (left out: 1 you completed or dropped):",
    );
    // Mushoku Tensei is recommended three times (seasons 1, 2 part 2 and 3): listed once, as season 1.
    expect(ids(lines.slice(2).join("\n"))).toEqual([108465]);
    expect(lines[2]).toContain("recommended by 117 (with 2 other seasons)");
    expect(lines[2]).toMatch(/AniList score \d+%/);
    // The Apothecary Diaries (completed) and the null node are left out.
    expect(r.text).not.toContain("Apothecary");
  });

  test("a recommendation on the plan-to-watch list says so", async () => {
    fake.seed([...PERSONA, { anime: 108465, status: "PLANNING" }]);
    const r = await call("search_anime", { similarTo: "frieren" });
    expect(r.text).toMatch(/\[108465\] .*: Plan to watch/);
  });

  test("filters apply on top, and an empty result says what was left out", async () => {
    fake.seed(PERSONA);
    let r = await call("search_anime", { similarTo: 16498, genres: ["Horror"] });
    expect(r.isError).toBe(false);
    expect(header(r.text)).toContain("Horror");
    // Chainsaw Man is horror; Fullmetal Alchemist: Brotherhood isn't.
    expect(ids(r.text)).toContain(127230);
    expect(ids(r.text)).not.toContain(5114);
    r = await call("search_anime", { similarTo: "frieren", formats: ["MOVIE"] });
    expect(r.text).toContain("none is left");
    expect(r.text).toContain("1 you completed or dropped");
    expect(r.text).toContain("not MOVIE");
  });

  test("leaves out the show's own sequels and prequels, and adult titles when 18+ is off", async () => {
    fake.recommendations.set(154587, [
      { id: 182255, rating: 500 }, // Frieren season 2
      { id: 320, rating: 400 }, // A KITE, adult
      { id: 127230, rating: 10 }, // Chainsaw Man
    ]);
    const r = await call("search_anime", { similarTo: 154587 });
    expect(ids(r.text.split("\n").slice(1).join("\n"))).toEqual([127230]);
    expect(r.text).toContain("1 of the same franchise");
  });

  test("a show named without a season is its first season, whatever the user is watching or planning", async () => {
    // The persona plans Mob Psycho 100 III; recommendations sit mostly on season 1.
    fake.seed(PERSONA);
    const r = await call("search_anime", { similarTo: "mob psycho 100" });
    expect(r.text).toContain("recommendations for Mob Psycho 100,");
  });

  test("recommendations with no net votes aren't listed", async () => {
    fake.recommendations.set(154587, [
      { id: 127230, rating: 0 },
      { id: 108465, rating: -2 },
      { id: 101922, rating: 3 },
    ]);
    const r = await call("search_anime", { similarTo: 154587 });
    expect(ids(r.text)).toEqual([101922]);
  });

  test("a show nobody has recommended anything for says so", async () => {
    fake.recommendations.set(154587, []);
    const r = await call("search_anime", { similarTo: 154587 });
    expect(r.text).toContain("AniList users haven't recommended anything");
  });

  test("doesn't mix with a title search or the calendar", async () => {
    let r = await call("search_anime", { similarTo: "frieren", query: "frieren" });
    expect(r.isError).toBe(true);
    r = await call("search_anime", { similarTo: "frieren", airing: "today" });
    expect(r.isError).toBe(true);
    r = await call("search_anime", { similarTo: "frieren", sort: "score" });
    expect(r.isError).toBe(true);
  });

  test("one request for the recommendations after the name is resolved, and nothing unmodeled", async () => {
    fake.seed(PERSONA);
    await call("search_anime", { similarTo: "frieren" });
    expect(fake.calls.filter((c) => c.query.includes("recommendations"))).toHaveLength(1);
    expect([...fake.unmodeled]).toEqual([]);
  });
});
