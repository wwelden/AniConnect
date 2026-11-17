/**
 * The user's AniList time zone: air times in whats_next and "today" for start and finish dates.
 * `bun test` runs with the server clock in UTC, so the dates below are a day ahead of or behind it.
 */
import { describe, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { AniListClient, parseTimeZone } from "../src/anilist";
import { todayFuzzy } from "../src/logic";
import { createServer } from "../src/server";
import { formatAirTime } from "../src/whatsnext";
import { FakeAniList } from "./support/fake-anilist";

const EP8_AIRS = 1795183200; // Apothecary Diaries S3 episode 8: 2026-11-20 14:00 UTC
const APOTHECARY_S3 = "Kusuriya no Hitorigoto 3rd Season";

async function connect(timeZone: string | null, now: number) {
  const fake = new FakeAniList();
  fake.timeZone = timeZone;
  const server = createServer(new AniListClient("t", fake.fetch), { now: () => now });
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "t", version: "0" });
  await Promise.all([server.connect(b), client.connect(a)]);
  const call = async (name: string, args: Record<string, unknown>) => {
    const r = (await client.callTool({ name, arguments: args })) as { content: { text: string }[]; isError?: boolean };
    return { text: r.content[0]!.text, isError: Boolean(r.isError) };
  };
  return { fake, call };
}

describe("parseTimeZone", () => {
  test("offsets become +HH:MM", () => {
    expect(parseTimeZone("-05:00")).toBe("-05:00");
    expect(parseTimeZone("+05:30")).toBe("+05:30");
    expect(parseTimeZone("9")).toBe("+09:00");
    expect(parseTimeZone("-0330")).toBe("-03:30");
    expect(parseTimeZone("UTC+01:00")).toBe("+01:00");
  });

  test("IANA names pass through", () => {
    expect(parseTimeZone("America/New_York")).toBe("America/New_York");
  });

  test("empty or unreadable values are null", () => {
    expect(parseTimeZone(null)).toBeNull();
    expect(parseTimeZone(undefined)).toBeNull();
    expect(parseTimeZone("")).toBeNull();
    expect(parseTimeZone("+25:00")).toBeNull();
    expect(parseTimeZone("Mars/Olympus")).toBeNull();
  });
});

describe("todayFuzzy", () => {
  const lateUtc = new Date("2026-11-17T23:30:00Z");
  test("in a zone", () => {
    expect(todayFuzzy(lateUtc, "+09:00")).toEqual({ year: 2026, month: 11, day: 18 });
    expect(todayFuzzy(lateUtc, "America/New_York")).toEqual({ year: 2026, month: 11, day: 17 });
    expect(todayFuzzy(new Date("2026-12-31T20:00:00Z"), "+05:00")).toEqual({ year: 2027, month: 1, day: 1 });
  });
});

describe("start and finish dates use the AniList time zone", () => {
  test("a zone a day ahead of the server clock", async () => {
    // 23:30 UTC on Nov 17 is 08:30 on Nov 18 in UTC+09:00.
    const { fake, call } = await connect("+09:00", Date.parse("2026-11-17T23:30:00Z"));
    await call("mark_episodes_watched", { anime: 16498 });
    expect(fake.entries.get(16498)!.startedAt).toEqual({ year: 2026, month: 11, day: 18 });
  });

  test("a zone a day behind the server clock", async () => {
    // 02:00 UTC on Nov 17 is 21:00 on Nov 16 in UTC-05:00.
    const { fake, call } = await connect("-05:00", Date.parse("2026-11-17T02:00:00Z"));
    await call("set_progress", { anime: 16498, episodes: 25 });
    expect(fake.entries.get(16498)!.startedAt).toEqual({ year: 2026, month: 11, day: 16 });
    expect(fake.entries.get(16498)!.completedAt).toEqual({ year: 2026, month: 11, day: 16 });
  });

  test("an IANA name works too", async () => {
    const { fake, call } = await connect("America/Los_Angeles", Date.parse("2026-11-17T02:00:00Z"));
    await call("mark_episodes_watched", { anime: 16498 });
    expect(fake.entries.get(16498)!.startedAt).toEqual({ year: 2026, month: 11, day: 16 });
  });

  test("no AniList zone falls back to the server's", async () => {
    const now = Date.parse("2026-11-17T23:30:00Z");
    const { fake, call } = await connect(null, now);
    await call("mark_episodes_watched", { anime: 16498 });
    expect(fake.entries.get(16498)!.startedAt).toEqual(todayFuzzy(new Date(now)));
  });
});

describe("whats_next air times use the AniList time zone", () => {
  const NOW = Date.parse("2026-11-17T12:00:00Z");

  async function apothecary(timeZone: string | null, args: Record<string, unknown> = {}) {
    const { fake, call } = await connect(timeZone, NOW);
    fake.seed([{ anime: APOTHECARY_S3, status: "CURRENT", progress: 7 }]);
    const r = await call("whats_next", { anime: "apothecary diaries", ...args });
    expect(r.isError).toBe(false);
    return { text: r.text, requests: fake.calls.length };
  }

  test("an offset is used and named, since it has no daylight saving", async () => {
    const r = await apothecary("-05:00");
    expect(r.text).toContain("episode 8 airs Fri, Nov 20 at 9:00 AM UTC-05:00 (in 3 days)");
  });

  test("an IANA name is used without a label", async () => {
    const r = await apothecary("Asia/Tokyo");
    expect(r.text).toContain("episode 8 airs Fri, Nov 20 at 11:00 PM (in 3 days)");
  });

  test("an explicit timeZone argument wins over the setting", async () => {
    const r = await apothecary("-05:00", { timeZone: "Asia/Tokyo" });
    expect(r.text).toContain("episode 8 airs Fri, Nov 20 at 11:00 PM (in 3 days)");
  });

  test("no AniList zone falls back to the server's", async () => {
    const r = await apothecary(null);
    const serverZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    expect(r.text).toContain(`episode 8 airs ${formatAirTime(EP8_AIRS, NOW, serverZone)}`);
  });

  test("the setting costs no extra request", async () => {
    const withZone = await apothecary("-05:00");
    const withArg = await apothecary("-05:00", { timeZone: "UTC" });
    expect(withZone.requests).toBe(withArg.requests);
  });
});

test("formatAirTime days count in an offset zone", () => {
  // 01:00 UTC on Nov 18 is still Nov 17 in UTC-05:00: "today".
  expect(formatAirTime(Date.parse("2026-11-18T01:00:00Z") / 1000, Date.parse("2026-11-17T12:00:00Z"), "-05:00")).toBe(
    "Tue, Nov 17 at 8:00 PM UTC-05:00 (today)",
  );
});
