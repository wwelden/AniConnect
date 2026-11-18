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

  test("a rewatch with episodes targets the show on the list, not its next season (#35)", async () => {
    // Frieren's aired 2nd Season would take a plain episode update.
    const r = await update({ anime: "frieren", status: "REPEATING", episodes: 2 });
    expect(r.isError).toBe(false);
    expect(r.text).toContain("you've completed it.\n");
    expect(fake.entries.get(FRIEREN)).toMatchObject({ status: "REPEATING", progress: 2 });
    expect(fake.entries.get(findMedia("Sousou no Frieren 2nd Season").id)).toBeUndefined();
  });

  test("a rewatch with watched episodes targets the show on the list and counts from 0 (#35, #37)", async () => {
    const r = await update({ anime: "frieren", status: "REPEATING", watched: 2 });
    expect(r.isError).toBe(false);
    expect(r.text).toContain("you've completed it.\n");
    expect(fake.entries.get(FRIEREN)).toMatchObject({ status: "REPEATING", progress: 2 });
    expect(fake.entries.get(findMedia("Sousou no Frieren 2nd Season").id)).toBeUndefined();
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
      'Not changed: "dandadan": Nothing to change: give status, episodes, watched, score, a date or a note.\n' +
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

  test("clearing something on a show that isn't on the list leaves it off", async () => {
    const id = findMedia("Chainsaw Man").id;
    const rated = await call("rate_anime", { anime: "chainsaw man", score: 0 });
    expect(rated.isError).toBe(false);
    expect(rated.text).toContain("Chainsaw Man isn't on your list, so there's no rating to clear.");
    const r = await update(
      { anime: "chainsaw man", notes: "" },
      { anime: "chainsaw man", completedAt: "clear" },
      { anime: "chainsaw man", score: 0, startedAt: "clear" },
    );
    expect(r.isError).toBe(true);
    expect(r.text).toContain("Chainsaw Man isn't on your list, so there's nothing to clear.");
    expect(fake.writes).toHaveLength(0);
    expect(fake.entries.has(id)).toBe(false);
  });

  test("a clear with something to set still adds the show", async () => {
    const r = await update({ anime: "chainsaw man", score: 0, status: "PLANNING" });
    expect(r.text).toContain("Chainsaw Man: not on list -> Plan to watch");
    expect(fake.entries.has(findMedia("Chainsaw Man").id)).toBe(true);
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

describe("start and finish dates (R0.10)", () => {
  test("sets a finish date the user remembers by month", async () => {
    const r = await update({ anime: "frieren", completedAt: "2025-03" });
    expect(r.text).toContain("Frieren: Beyond Journey’s End: finish date none -> 2025-03.\n");
    expect(fake.entries.get(FRIEREN)!.completedAt).toEqual({ year: 2025, month: 3, day: null });
  });

  test("corrects a date already set, and clears one", async () => {
    fake.entries.get(FRIEREN)!.startedAt = { year: 2023, month: 9, day: 29 };
    fake.entries.get(FRIEREN)!.completedAt = { year: 2024, month: 3, day: 22 };
    let r = await update({ anime: "frieren", completedAt: "2024-04-01" });
    expect(r.text).toContain("finish date 2024-03-22 -> 2024-04-01.");
    r = await update({ anime: "frieren", startedAt: "clear" });
    expect(r.text).toContain("start date 2023-09-29 -> none.");
    expect(fake.entries.get(FRIEREN)!.startedAt).toEqual({ year: null, month: null, day: null });
  });

  test("a finish date given with Completed replaces today's", async () => {
    const r = await update({ anime: "dandadan", status: "COMPLETED", completedAt: "2026-11-02" });
    expect(r.text).toContain(`DAN DA DAN: Watching -> Completed, episode 7 -> 12, finish date none -> 2026-11-02.\n`);
    // Today would start it after it finished, so the start date stays unset.
    expect(fake.entries.get(DANDADAN)!.startedAt).toEqual({ year: null, month: null, day: null });
    expect(fake.entries.get(DANDADAN)!.completedAt).toEqual({ year: 2026, month: 11, day: 2 });
  });

  test("refuses dates in the future, impossible dates, and a start after the finish", async () => {
    fake.entries.get(FRIEREN)!.completedAt = { year: 2024, month: 3, day: 22 };
    const r = await update(
      { anime: "dandadan", completedAt: "2026-12" },
      { anime: "jjk", startedAt: "2025-02-30" },
      { anime: "frieren", startedAt: "2024-05" },
    );
    expect(r.isError).toBe(true);
    expect(r.text).toBe(
      'Not changed: "dandadan": 2026-12 is in the future (today is 2026-11-17).\n' +
        'Not changed: "jjk": There\'s no day 30 in 2025-02 (got "2025-02-30").\n' +
        'Not changed: "frieren": The start date (2024-05) is after the finish date (2024-03-22).',
    );
  });

  test("rejects a date that isn't a date before calling AniList", async () => {
    const r = await update({ anime: "frieren", completedAt: "last March" });
    expect(r.isError).toBe(true);
    expect(fake.calls).toHaveLength(0);
  });

  test("undo puts the old dates back", async () => {
    fake.entries.get(FRIEREN)!.completedAt = { year: 2024, month: 3, day: 22 };
    await update({ anime: "frieren", completedAt: "2025" });
    await call("undo");
    expect(fake.entries.get(FRIEREN)!.completedAt).toEqual({ year: 2024, month: 3, day: 22 });
  });
});

describe("private notes (R0.11)", () => {
  test("writes a note, adds a line to it, and removes it", async () => {
    let r = await update({ anime: "dandadan", notes: "watch the dub" });
    expect(r.text).toContain('DAN DA DAN: note is now "watch the dub".');
    r = await update({ anime: "dandadan", addNote: "ep 7 was great" });
    expect(r.text).toContain('note is now "watch the dub / ep 7 was great"');
    expect(fake.entries.get(DANDADAN)!.notes).toBe("watch the dub\nep 7 was great");
    r = await update({ anime: "dandadan", notes: "" });
    expect(r.text).toContain("DAN DA DAN: note removed.");
    expect(fake.entries.get(DANDADAN)!.notes).toBe("");
  });

  test("adding to an empty note doesn't start with a blank line", async () => {
    await update({ anime: "dandadan", addNote: "first" });
    expect(fake.entries.get(DANDADAN)!.notes).toBe("first");
  });

  test("a note comes with other changes in the same write", async () => {
    const before = fake.writes.length;
    await update({ anime: "dandadan", watched: 1, addNote: "the cursed tape arc starts" });
    expect(fake.writes.length - before).toBe(1);
    expect(fake.entries.get(DANDADAN)).toMatchObject({ progress: 8, notes: "the cursed tape arc starts" });
  });

  test("notes and addNote together are refused", async () => {
    const r = await update({ anime: "dandadan", notes: "a", addNote: "b" });
    expect(r.isError).toBe(true);
    expect(r.text).toContain("Give notes or addNote, not both.");
  });

  test("search_my_list shows notes, on one line", async () => {
    fake.entries.get(DANDADAN)!.notes = "watch the dub\nwith Sam";
    const r = await call("search_my_list", { query: "dandadan" });
    expect(r.text).toContain('[171018] DAN DA DAN (TV, 2024): Watching, 7/12 episodes, unrated. Note: "watch the dub / with Sam"');
  });

  test("other tools leave notes alone, and undo restores them", async () => {
    fake.entries.get(DANDADAN)!.notes = "keep me";
    await call("mark_episodes_watched", { anime: "dandadan" });
    await call("set_status", { anime: "dandadan", status: "PAUSED" });
    expect(fake.entries.get(DANDADAN)!.notes).toBe("keep me");
    await update({ anime: "dandadan", notes: "replaced" });
    await call("undo");
    expect(fake.entries.get(DANDADAN)!.notes).toBe("keep me");
  });
});
