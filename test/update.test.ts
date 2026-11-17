import { beforeEach, describe, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { AniListClient } from "../src/anilist";
import { formatDate, todayFuzzy } from "../src/logic";
import { createServer } from "../src/server";
import { PERSONA } from "./fixtures/persona";
import { FakeAniList, findMedia } from "./support/fake-anilist";

const NOW = Date.UTC(2026, 10, 17, 12);
const TODAY = formatDate(todayFuzzy(new Date(NOW)));
const JJK2 = 145064;
const DANDADAN = 171018;
const FRIEREN = 154587;

let fake: FakeAniList;
let client: Client;

async function call(name: string, args: Record<string, unknown> = {}) {
  const result = (await client.callTool({ name, arguments: args })) as {
    content: { text: string }[];
    isError?: boolean;
  };
  return { text: result.content.map((c) => c.text).join("\n"), isError: Boolean(result.isError) };
}

const update = (...updates: Record<string, unknown>[]) => call("update_shows", { updates });

beforeEach(async () => {
  fake = new FakeAniList("POINT_10_DECIMAL").seed(PERSONA);
  fake.clock = () => NOW;
  const server = createServer(new AniListClient("test-token", fake.fetch), { now: () => NOW });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  client = new Client({ name: "test", version: "0" });
  await Promise.all([server.connect(st), client.connect(ct)]);
});

describe("update_shows (R2.6)", () => {
  test("logs several shows in one call", async () => {
    const r = await update({ anime: "jjk", episodes: 5 }, { anime: "dandadan", status: "COMPLETED" });
    expect(r.isError).toBe(false);
    expect(r.text).toBe(
      'Matched "jjk" to JUJUTSU KAISEN Season 2: you\'re watching it.\n' +
        "JUJUTSU KAISEN Season 2: episode 3 -> 5.\n" +
        "[145064] JUJUTSU KAISEN Season 2 (TV, 2023): Watching, 5/23 episodes, unrated\n" +
        'Matched "dandadan" to DAN DA DAN: you\'re watching it.\n' +
        `DAN DA DAN: Watching -> Completed, episode 7 -> 12. Start date set to ${TODAY}, finish date set to ${TODAY}.\n` +
        "[171018] DAN DA DAN (TV, 2024): Completed, 12/12 episodes, unrated",
    );
    expect(fake.entries.get(JJK2)!.progress).toBe(5);
    expect(fake.entries.get(DANDADAN)).toMatchObject({ status: "COMPLETED", progress: 12 });
  });

  test("several changes to one show are one write", async () => {
    const before = fake.writes.length;
    const r = await update({ anime: "dandadan", status: "COMPLETED", score: 9 });
    expect(r.text).toContain("DAN DA DAN: Watching -> Completed, episode 7 -> 12, score unrated -> 9/10.");
    expect(fake.writes.length - before).toBe(1);
    expect(fake.entries.get(DANDADAN)).toMatchObject({ status: "COMPLETED", progress: 12, scoreRaw: 90 });
  });

  test("shows on the list cost the viewer, the list and one write each", async () => {
    await update({ anime: "jjk", watched: 1 }, { anime: "dandadan", watched: 1 }, { anime: "frieren", score: 10 });
    expect(fake.calls.map((c) => (/^\s*mutation/.test(c.query) ? "write" : c.query.includes("Viewer") ? "viewer" : c.query.includes("MediaListCollection") ? "list" : "other"))).toEqual(
      ["viewer", "list", "write", "write", "write"],
    );
  });

  test("an ambiguous show is listed with its candidates and the others are saved", async () => {
    const r = await update({ anime: "attack on titan", score: 10 }, { anime: "dandadan", watched: 1 });
    expect(r.isError).toBe(false);
    expect(r.text).toStartWith("Saved 1 of 2 updates.\n");
    expect(r.text).toContain('Not changed: "attack on titan":');
    expect(r.text).toContain("Ask the user which one they mean");
    expect(r.text).toContain("[16498]");
    expect(fake.entries.get(DANDADAN)!.progress).toBe(8);
  });

  test("is an error when nothing was saved", async () => {
    const r = await update({ anime: "dandadan" }, { anime: "jjk", episodes: 4, watched: 1 }, { anime: "dandadan", episodes: 99 });
    expect(r.isError).toBe(true);
    expect(r.text).toBe(
      'Not changed: "dandadan": Nothing to change: give status, episodes, watched or score.\n' +
        'Not changed: "jjk": Give episodes or watched, not both.\n' +
        'Not changed: "dandadan": This show only has 12 episodes (got 99).',
    );
    expect(fake.writes).toHaveLength(0);
  });

  test("adds a show it isn't on the list yet", async () => {
    const r = await update({ anime: "chainsaw man", watched: 2 });
    const id = findMedia("Chainsaw Man").id;
    expect(r.text).toContain("Chainsaw Man: not on list -> Watching, episode 0 -> 2.");
    expect(fake.entries.get(id)).toMatchObject({ status: "CURRENT", progress: 2 });
  });

  test("the same show twice counts both", async () => {
    await update({ anime: "dandadan", watched: 1 }, { anime: "DAN DA DAN", watched: 2 });
    expect(fake.entries.get(DANDADAN)!.progress).toBe(10);
  });

  test('"latest" catches up', async () => {
    const r = await update({ anime: "one piece", episodes: "latest" });
    expect(r.text).toContain("Latest aired episode");
    expect(fake.entries.get(findMedia("ONE PIECE").id)!.progress).toBeGreaterThan(1100);
  });

  test("one undo takes back the whole batch", async () => {
    await update({ anime: "jjk", episodes: 5 }, { anime: "dandadan", status: "COMPLETED" }, { anime: "frieren", score: 6 });
    const r = await call("undo");
    expect(r.text).toContain("Undid the last change (update_shows):");
    expect(fake.entries.get(JJK2)!.progress).toBe(3);
    expect(fake.entries.get(DANDADAN)).toMatchObject({ status: "CURRENT", progress: 7, completedAt: { year: null } });
    expect(fake.entries.get(FRIEREN)!.scoreRaw).toBe(95);
  });
});
