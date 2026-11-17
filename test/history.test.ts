import { beforeEach, describe, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { AniListClient } from "../src/anilist";
import { describeActivity, parsePeriod } from "../src/history";
import { createServer } from "../src/server";
import { HISTORY, PERSONA } from "./fixtures/persona";
import { FakeAniList } from "./support/fake-anilist";

/** Tuesday. */
const NOW = Date.parse("2026-11-17T12:00:00Z");

function range(period: string, timeZone = "UTC", now = NOW) {
  const r = parsePeriod(period, now, timeZone);
  return [new Date(r.start).toISOString(), new Date(r.end).toISOString()];
}

describe("parsePeriod", () => {
  test("calendar periods, weeks starting Monday", () => {
    expect(range("today")).toEqual(["2026-11-17T00:00:00.000Z", "2026-11-18T00:00:00.000Z"]);
    expect(range("yesterday")).toEqual(["2026-11-16T00:00:00.000Z", "2026-11-17T00:00:00.000Z"]);
    expect(range("this week")).toEqual(["2026-11-16T00:00:00.000Z", "2026-11-18T00:00:00.000Z"]);
    expect(range("last week")).toEqual(["2026-11-09T00:00:00.000Z", "2026-11-16T00:00:00.000Z"]);
    expect(range("this month")).toEqual(["2026-11-01T00:00:00.000Z", "2026-11-18T00:00:00.000Z"]);
    expect(range("last month")).toEqual(["2026-10-01T00:00:00.000Z", "2026-11-01T00:00:00.000Z"]);
    expect(range("last year")).toEqual(["2025-01-01T00:00:00.000Z", "2026-01-01T00:00:00.000Z"]);
  });

  test("rolling periods", () => {
    expect(range("last 7 days")).toEqual(["2026-11-11T00:00:00.000Z", "2026-11-18T00:00:00.000Z"]);
    expect(range("past week")).toEqual(["2026-11-11T00:00:00.000Z", "2026-11-18T00:00:00.000Z"]);
    expect(range("in the last week")).toEqual(["2026-11-11T00:00:00.000Z", "2026-11-18T00:00:00.000Z"]);
    expect(range("the past 2 weeks")).toEqual(["2026-11-04T00:00:00.000Z", "2026-11-18T00:00:00.000Z"]);
    expect(range("last 3 months")).toEqual(["2026-08-18T00:00:00.000Z", "2026-11-18T00:00:00.000Z"]);
    // A month before March 31 is the end of February, not March 3.
    expect(range("past month", "UTC", Date.parse("2026-03-31T12:00:00Z"))).toEqual([
      "2026-03-01T00:00:00.000Z",
      "2026-04-01T00:00:00.000Z",
    ]);
  });

  test("month names take the most recent one that isn't in the future", () => {
    expect(range("in March")).toEqual(["2026-03-01T00:00:00.000Z", "2026-04-01T00:00:00.000Z"]);
    expect(range("December")).toEqual(["2025-12-01T00:00:00.000Z", "2026-01-01T00:00:00.000Z"]);
    expect(range("Sept 2024")).toEqual(["2024-09-01T00:00:00.000Z", "2024-10-01T00:00:00.000Z"]);
    expect(range("mar 14")).toEqual(["2026-03-14T00:00:00.000Z", "2026-03-15T00:00:00.000Z"]);
  });

  test("dates, ranges and open ends", () => {
    expect(range("2026-03-14")).toEqual(["2026-03-14T00:00:00.000Z", "2026-03-15T00:00:00.000Z"]);
    expect(range("2026-03")).toEqual(["2026-03-01T00:00:00.000Z", "2026-04-01T00:00:00.000Z"]);
    expect(range("2025")).toEqual(["2025-01-01T00:00:00.000Z", "2026-01-01T00:00:00.000Z"]);
    expect(range("2026-03-01 to 2026-03-15")).toEqual(["2026-03-01T00:00:00.000Z", "2026-03-16T00:00:00.000Z"]);
    expect(range("between March 1 and March 15")).toEqual(["2026-03-01T00:00:00.000Z", "2026-03-16T00:00:00.000Z"]);
    expect(range("since June")).toEqual(["2026-06-01T00:00:00.000Z", "2026-11-18T00:00:00.000Z"]);
    // The end of a range isn't pushed back a year just because it's later this month.
    expect(range("nov 10 to nov 20")).toEqual(["2026-11-10T00:00:00.000Z", "2026-11-21T00:00:00.000Z"]);
    expect(range("dec 20 to jan 5")).toEqual(["2025-12-20T00:00:00.000Z", "2026-01-06T00:00:00.000Z"]);
    expect(parsePeriod("all time", NOW, "UTC").start).toBe(0);
  });

  test("days start at local midnight, across daylight saving changes", () => {
    // 12:00 UTC is 7 AM in New York, so "today" is still the 17th there.
    expect(range("today", "America/New_York")).toEqual(["2026-11-17T05:00:00.000Z", "2026-11-18T05:00:00.000Z"]);
    // March starts in EST (UTC-5) and ends in EDT (UTC-4).
    expect(range("March", "America/New_York")).toEqual(["2026-03-01T05:00:00.000Z", "2026-04-01T04:00:00.000Z"]);
    expect(range("today", "Asia/Tokyo")).toEqual(["2026-11-16T15:00:00.000Z", "2026-11-17T15:00:00.000Z"]);
  });

  test("rejects what it can't read, with examples", () => {
    expect(() => parsePeriod("whenever", NOW, "UTC")).toThrow('Couldn\'t read the time range "whenever"');
    expect(() => parsePeriod("Feb 30", NOW, "UTC")).toThrow("Couldn't read");
    expect(() => parsePeriod("2026-13", NOW, "UTC")).toThrow("Couldn't read");
    expect(() => parsePeriod("2027", NOW, "UTC")).toThrow("hasn't started yet");
    expect(() => parsePeriod("last 0 days", NOW, "UTC")).toThrow("hasn't started yet");
    expect(() => parsePeriod("2026-03-15 to 2026-03-01", NOW, "UTC")).toThrow("ends before it starts");
  });
});

describe("describeActivity", () => {
  test("puts AniList's phrases in plain words", () => {
    expect(describeActivity({ status: "watched episode", progress: "3 - 5" })).toBe("watched episodes 3-5");
    expect(describeActivity({ status: "watched episode", progress: "7" })).toBe("watched episode 7");
    expect(describeActivity({ status: "rewatched episode", progress: "1 - 2" })).toBe("rewatched episodes 1-2");
    expect(describeActivity({ status: "completed", progress: null })).toBe("completed");
    expect(describeActivity({ status: "plans to watch", progress: null })).toBe("added to plan to watch");
    expect(describeActivity({ status: "paused watching", progress: null })).toBe("put on hold");
    expect(describeActivity({ status: "paused watching", progress: "12" })).toBe("put on hold at episode 12");
    expect(describeActivity({ status: "dropped", progress: "5" })).toBe("dropped at episode 5");
  });
});

describe("watch_history tool", () => {
  let fake: FakeAniList;
  let client: Client;
  let clock: number;

  async function call(name: string, args: Record<string, unknown>) {
    const result = (await client.callTool({ name, arguments: args })) as {
      content: { text: string }[];
      isError?: boolean;
    };
    return { text: result.content.map((c) => c.text).join("\n"), isError: Boolean(result.isError) };
  }

  beforeEach(async () => {
    clock = NOW;
    fake = new FakeAniList().seed(PERSONA).seedActivity(HISTORY);
    fake.clock = () => clock;
    const server = createServer(new AniListClient("t", fake.fetch), { now: () => clock });
    const [ct, st] = InMemoryTransport.createLinkedPair();
    client = new Client({ name: "test", version: "0" });
    await Promise.all([server.connect(st), client.connect(ct)]);
  });

  test("this week, newest first, grouped by day in the user's time zone", async () => {
    const r = await call("watch_history", { period: "this week", timeZone: "UTC" });
    expect(r.isError).toBe(false);
    // Titles are matched loosely: their display format is decided elsewhere.
    expect(r.text).toMatch(
      new RegExp(
        [
          "^List activity, Mon, Nov 16, 2026 to Tue, Nov 17, 2026 \\(UTC\\), newest first:",
          "Tue, Nov 17",
          "- 2:00 AM ONE PIECE: watched episodes 1098-1100",
          "Mon, Nov 16",
          "- 9:10 PM DAN DA DAN[^\\n]*: watched episodes 6-7",
          "Episodes logged in one sitting show as one range\\. AniList's activity feed can be incomplete[^\\n]*$",
        ].join("\\n"),
      ),
    );
    // Viewer and one page of activity.
    expect(fake.calls.length).toBe(2);
    expect(fake.calls[1]!.query).toContain("type: ANIME_LIST");
  });

  test("defaults to the last 7 days; times move with the time zone", async () => {
    const r = await call("watch_history", { timeZone: "America/Los_Angeles" });
    expect(r.text).toContain("Wed, Nov 11, 2026 to Tue, Nov 17, 2026 (America/Los_Angeles)");
    // 02:00 UTC on the 17th is 6 PM on the 16th in Los Angeles.
    expect(r.text).toContain("Mon, Nov 16\n- 6:00 PM ONE PIECE");
    expect(r.text).toMatch(/JUJUTSU KAISEN Season 2[^\n]*: watched episode 3/);
    expect(r.text).not.toContain("Oshi no Ko");
  });

  test("defaults to the user's AniList time zone", async () => {
    fake.timeZone = "-08:00";
    const r = await call("watch_history", { period: "this week" });
    expect(r.text).toContain("(-08:00), newest first:");
    expect(r.text).toContain("Mon, Nov 16\n- 6:00 PM ONE PIECE");
  });

  test("one show's history over all time", async () => {
    const r = await call("watch_history", { anime: "frieren", timeZone: "UTC" });
    expect(r.text).toMatch(/List activity for Frieren[^\n]*, all time \(UTC\)/);
    expect(r.text).toMatch(/Mon, Oct 5\n- 8:00 PM Frieren[^\n]*: completed\n- 7:00 PM Frieren[^\n]*: watched episodes 25-27/);
    expect(r.text).not.toContain("ONE PIECE");
  });

  test("a named season is found on the list without searching AniList", async () => {
    const r = await call("watch_history", { anime: "jjk season 2", timeZone: "UTC" });
    expect(r.text).toMatch(/JUJUTSU KAISEN Season 2[^\n]*: watched episode 3/);
    // Viewer, the list, and one page of activity.
    expect(fake.calls.length).toBe(3);
    expect(fake.calls.some((c) => c.query.includes("search:"))).toBe(false);
  });

  test("records new episodes, merging an episode logged soon after into one range", async () => {
    await call("mark_episodes_watched", { anime: "dandadan" });
    clock += 20 * 60_000;
    await call("mark_episodes_watched", { anime: "dandadan" });
    clock += 2 * 60 * 60_000;
    await call("set_status", { anime: "Bocchi the Rock", status: "PAUSED" });
    const r = await call("watch_history", { period: "today", timeZone: "UTC" });
    expect(r.text).toMatch(/- 2:20 PM BOCCHI THE ROCK![^\n]*: put on hold\n- 12:00 PM DAN DA DAN[^\n]*: watched episodes 8-9\n/);
  });

  test("an empty range says the feed may be incomplete, not that nothing was watched", async () => {
    const r = await call("watch_history", { period: "2026-11-01", timeZone: "UTC" });
    expect(r.isError).toBe(false);
    expect(r.text).toContain("No list activity found (Sun, Nov 1, 2026, UTC). That doesn't prove nothing was watched");
  });

  test("says when there is more than one page", async () => {
    for (let i = 0; i < 60; i++) fake.seedActivity([{ anime: "ONE PIECE", status: "watched episode", progress: String(i), at: "2026-11-16T10:00:00Z" }]);
    const r = await call("watch_history", { period: "this week", timeZone: "UTC" });
    expect(r.text).toContain("Showing the 50 most recent updates");
  });

  test("bad input is a readable error", async () => {
    expect((await call("watch_history", { period: "a while ago" })).text).toContain("Couldn't read the time range");
    expect((await call("watch_history", { timeZone: "Mars/Olympus" })).text).toContain("Unknown time zone");
  });
});
