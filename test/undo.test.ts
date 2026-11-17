import { beforeEach, describe, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { AniListClient } from "../src/anilist";
import { createServer } from "../src/server";
import { JOURNAL_LIMIT, Journal } from "../src/undo";
import { PERSONA } from "./fixtures/persona";
import { FakeAniList, findMedia, type StoredEntry } from "./support/fake-anilist";

const NOW = Date.UTC(2026, 10, 17, 12);
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

beforeEach(async () => {
  fake = new FakeAniList("POINT_10_DECIMAL").seed(PERSONA);
  fake.clock = () => NOW;
  const server = createServer(new AniListClient("test-token", fake.fetch), { now: () => NOW });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  client = new Client({ name: "test", version: "0" });
  await Promise.all([server.connect(st), client.connect(ct)]);
});

/** The parts of an entry undo must put back, without the entry ID (a re-added entry gets a new one). */
function state(mediaId: number) {
  const e = fake.entries.get(mediaId);
  if (!e) return null;
  const { id, ...rest } = e;
  return rest;
}

describe("undo (R3.1)", () => {
  test("puts a rating back", async () => {
    await call("rate_anime", { anime: "frieren", score: 7 });
    expect(fake.entries.get(FRIEREN)!.scoreRaw).toBe(70);
    const r = await call("undo");
    expect(r.isError).toBe(false);
    expect(r.text).toContain("Undid the last change (rate_anime):");
    expect(r.text).toContain("Restored: [154587] Frieren: Beyond Journey’s End (TV, 2023): Completed, 28/28 episodes, 9.5/10");
    expect(fake.entries.get(FRIEREN)!.scoreRaw).toBe(95);
  });

  test("removes a show that was just added", async () => {
    const chainsaw = findMedia("Chainsaw Man").id;
    await call("add_to_list", { anime: "chainsaw man" });
    expect(fake.entries.has(chainsaw)).toBe(true);
    const r = await call("undo");
    expect(r.text).toContain("Chainsaw Man: removed from your list again.");
    expect(fake.entries.has(chainsaw)).toBe(false);
  });

  test("brings back a removed show with everything it had", async () => {
    const entry = fake.entries.get(DANDADAN)!;
    Object.assign(entry, {
      scoreRaw: 85,
      startedAt: { year: 2024, month: 10, day: 4 },
      notes: "watch with sub",
      customLists: ["Favourites"],
      private: true,
    } satisfies Partial<StoredEntry>);
    const before = state(DANDADAN);
    await call("remove_from_list", { anime: "dandadan" });
    expect(fake.entries.has(DANDADAN)).toBe(false);

    const r = await call("undo");
    expect(r.text).toContain("Put back on your list: [171018] DAN DA DAN (TV, 2024): Watching, 7/12 episodes, 8.5/10");
    expect(state(DANDADAN)).toEqual({ ...before!, repeat: 0, hiddenFromStatusLists: false });
  });

  test("clears dates and progress that a status change filled in", async () => {
    const before = state(DANDADAN);
    await call("set_status", { anime: "dandadan", status: "COMPLETED" });
    expect(fake.entries.get(DANDADAN)!.completedAt.year).toBe(2026);
    await call("undo");
    expect(state(DANDADAN)).toEqual({ ...before!, repeat: 0, notes: "", private: false, hiddenFromStatusLists: false, customLists: [] });
  });

  test("undoes several changes, newest first, back to the start", async () => {
    await call("mark_episodes_watched", { anime: "dandadan" });
    await call("mark_episodes_watched", { anime: "dandadan", count: 2 });
    await call("rate_anime", { anime: "dandadan", score: 8 });
    expect(fake.entries.get(DANDADAN)!.progress).toBe(10);

    const r = await call("undo", { count: 3 });
    expect(r.text).toContain("Undid the last 3 changes (rate_anime, mark_episodes_watched, mark_episodes_watched):");
    expect(fake.entries.get(DANDADAN)!.progress).toBe(7);
    expect(fake.entries.get(DANDADAN)!.scoreRaw).toBe(0);
  });

  test("each undo takes back one more change; undo itself isn't undone", async () => {
    await call("mark_episodes_watched", { anime: "dandadan" });
    await call("mark_episodes_watched", { anime: "dandadan" });
    await call("undo");
    expect(fake.entries.get(DANDADAN)!.progress).toBe(8);
    await call("undo");
    expect(fake.entries.get(DANDADAN)!.progress).toBe(7);
    const r = await call("undo");
    expect(r.text).toBe("Nothing to undo: AniConnect hasn't changed the list since it started.");
  });

  test("says so when asked to undo more than there is", async () => {
    await call("rate_anime", { anime: "dandadan", score: 6 });
    const r = await call("undo", { count: 4 });
    expect(r.text).toContain("Only 1 could be undone");
    expect(fake.entries.get(DANDADAN)!.scoreRaw).toBe(0);
  });

  test("leaves a show alone if it changed on anilist.co since", async () => {
    await call("mark_episodes_watched", { anime: "dandadan" });
    fake.entries.get(DANDADAN)!.progress = 11; // the user caught up on anilist.co
    const r = await call("undo");
    expect(r.text).toContain("DAN DA DAN: not undone, it has changed since");
    expect(fake.entries.get(DANDADAN)!.progress).toBe(11);
  });

  test("changes that changed nothing aren't recorded", async () => {
    await call("rate_anime", { anime: "dandadan", score: 6 });
    await call("add_to_list", { anime: "dandadan" }); // already on the list: no change
    await call("set_status", { anime: "dandadan", status: "CURRENT" }); // already watching
    const r = await call("undo");
    expect(r.text).toContain("(rate_anime)");
  });

  test("a failed undo keeps the change, so it can be tried again", async () => {
    await call("rate_anime", { anime: "dandadan", score: 6 });
    fake.rateLimited = true;
    let r = await call("undo");
    expect(r.isError).toBe(true);
    expect(r.text).toContain("rate limit");
    expect(r.text).toContain("call undo again");
    fake.rateLimited = false;
    r = await call("undo");
    expect(r.isError).toBe(false);
    expect(fake.entries.get(DANDADAN)!.scoreRaw).toBe(0);
  });

  test("uses one request to read the shows, then one write each", async () => {
    await call("rate_anime", { anime: "dandadan", score: 6 });
    await call("rate_anime", { anime: "frieren", score: 6 });
    const before = fake.calls.length;
    await call("undo", { count: 2 });
    const queries = fake.calls.slice(before).map((c) => c.query);
    expect(queries.filter((q) => q.includes("id_in"))).toHaveLength(1);
    expect(queries.filter((q) => /^\s*mutation/.test(q))).toHaveLength(2);
  });
});

describe("Journal", () => {
  test("keeps the newest changes only", () => {
    const journal = new Journal();
    const snap = { status: "CURRENT", progress: 1 } as never;
    for (let i = 0; i < JOURNAL_LIMIT + 5; i++) {
      journal.record(`t${i}`, [{ mediaId: i, title: { romaji: "x", english: null, native: null }, before: null, after: snap }]);
    }
    expect(journal.size).toBe(JOURNAL_LIMIT);
    expect(journal.take(1)[0]!.tool).toBe(`t${JOURNAL_LIMIT + 4}`);
  });
});
