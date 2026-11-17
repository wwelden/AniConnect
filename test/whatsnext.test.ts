import { beforeEach, describe, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { AniListClient, type ListStatus, type Media } from "../src/anilist";
import { createServer } from "../src/server";
import { airedEpisodes, buildReport, checkTimeZone, formatAirTime, formatReport, nextSeasons } from "../src/whatsnext";
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
      "- ONE PIECE: 80 episodes to watch (on 1100 of 1180 aired). Episode 1181 airs Sun, Jan 3 at 2:16 PM (in 47 days).",
    );
    expect(sections[0]!.split("\n")[2]).toContain("DAN DA DAN (Dandadan): 5 episodes to watch (on 7 of 12 aired).");
    expect(sections[1]).toContain("Kusuriya no Hitorigoto 3rd Season): episode 8 airs Fri, Nov 20 at 2:00 PM (in 3 days).");
    // Sequels of finished shows that haven't been started; planned ones say so.
    expect(sections[2]).toContain("[182255] Frieren: Beyond Journey’s End Season 2");
    expect(sections[2]).toContain("not on your list");
    expect(sections[2]).toContain("[140439] Mob Psycho 100 III (12 episodes, 2022), on your plan-to-watch list.");
    // Sequels already started aren't suggested; dropped shows aren't "on hold".
    expect(r.text).not.toContain("After JUJUTSU KAISEN");
    expect(r.text).not.toContain("VINLAND");
    expect(sections[3]).toContain("Attack on Titan Final Season (Shingeki no Kyojin: The Final Season): 6 episodes to watch");
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

  test("a finished show is described with its next season", async () => {
    const r = await call({ anime: "frieren", timeZone: "UTC" });
    expect(r.text).toContain("(Sousou no Frieren) [154587]");
    expect(r.text).toContain("You: Completed, watched 28.");
    expect(r.text).toContain("Comes next: [182255] Frieren: Beyond Journey’s End Season 2 (Sousou no Frieren 2nd Season) (10 episodes, 2026), not on your list.");
  });

  test("a sequel by ID says which season before it is on the list", async () => {
    const r = await call({ anime: 182255, timeZone: "UTC" });
    expect(r.text).toContain("Comes after: [154587] Frieren: Beyond Journey’s End (Sousou no Frieren), completed on your list.");
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
    expect(r.content[0]!.text).toContain("1 episode to watch (on 7 of 8 aired).");
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

  test("never writes", async () => {
    await call({ timeZone: "UTC" });
    await call({ anime: "jjk", timeZone: "UTC" });
    expect(fake.writes.length).toBe(0);
  });
});

describe("buildReport edge cases", () => {
  const base = {
    title: { romaji: "Show", english: null, native: null },
    synonyms: [],
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

  test("a show airing with no announced schedule still appears", () => {
    const m = { ...base, id: 1, episodes: null, status: "RELEASING", nextAiringEpisode: null, mediaListEntry: entry("CURRENT", 4) } as Media;
    const text = formatReport(buildReport([m], [], NOW), NOW, "UTC");
    expect(text).toContain("Show: still airing, no date announced for the next episode.");
  });

  test("cancelled sequels aren't suggested", () => {
    const finished = {
      ...base, id: 1, episodes: 12, status: "FINISHED", nextAiringEpisode: null, mediaListEntry: entry("COMPLETED", 12),
      relations: { edges: [{ relationType: "SEQUEL", node: { id: 2, type: "ANIME", format: "TV", status: "CANCELLED" } }] },
    } as Media;
    expect(nextSeasons([finished], new Map([[1, "COMPLETED"]]))).toEqual([]);
  });
});
