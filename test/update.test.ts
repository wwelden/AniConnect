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

  const kinds = () =>
    fake.calls.map((c) => (/^\s*mutation/.test(c.query) ? "write" : c.query.includes("Viewer") ? "viewer" : c.query.includes("MediaListCollection") ? "list" : "other"));

  test("shows on the list cost the viewer, the list and one write each", async () => {
    await update({ anime: "jjk", watched: 1 }, { anime: "dandadan", watched: 1 }, { anime: "bocchi the rock", score: 10 });
    expect(kinds()).toEqual(["viewer", "list", "write", "write", "write"]);
  });

  test("rating a listed show by a name that isn't its exact title also searches AniList, once", async () => {
    // "Frieren" might be a show the user hasn't listed; the search finds none titled exactly that.
    await update({ anime: "frieren", score: 10 });
    expect(kinds()).toEqual(["viewer", "list", "other", "write"]);
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
        'Not changed: "dandadan": DAN DA DAN has 12 episodes, so 99 is past the last one.',
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
      `Not changed: "dandadan": 2026-12 is in the future (today is ${TODAY}).\n` +
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

describe("adding many shows (addOnly, dryRun)", () => {
  const CHAINSAW = findMedia("Chainsaw Man").id;
  const STEINS = findMedia("Steins;Gate").id;
  const searches = () => fake.calls.filter((c) => /media\(search:/.test(c.query)).length;

  test("addOnly adds new shows and never changes ones already on the list", async () => {
    const r = await call("update_shows", {
      addOnly: true,
      updates: [
        { anime: "chainsaw man" },
        { anime: "dandadan", status: "COMPLETED" },
        { anime: "steins gate", status: "COMPLETED", score: 9 },
        { anime: "frieren", status: "PLANNING" },
      ],
    });
    expect(r.isError).toBe(false);
    expect(r.text).toStartWith("Saved 2 of 4 updates; 2 already on your list, left unchanged.\n");
    expect(r.text).toContain("Already on your list, unchanged: [171018] DAN DA DAN (TV, 2024): Watching, 7/12 episodes, unrated");
    expect(fake.entries.get(CHAINSAW)).toMatchObject({ status: "PLANNING" });
    expect(fake.entries.get(STEINS)).toMatchObject({ status: "COMPLETED", scoreRaw: 90 });
    expect(fake.entries.get(DANDADAN)).toMatchObject({ status: "CURRENT", progress: 7 });
    expect(fake.entries.get(FRIEREN)).toMatchObject({ status: "COMPLETED", scoreRaw: 95 });
  });

  test("addOnly with episodes starts the show as watching", async () => {
    await call("update_shows", { addOnly: true, updates: [{ anime: "chainsaw man", episodes: 3 }] });
    expect(fake.entries.get(CHAINSAW)).toMatchObject({ status: "CURRENT", progress: 3 });
  });

  test("everything already on the list isn't an error, and writes nothing", async () => {
    const r = await call("update_shows", { addOnly: true, updates: [{ anime: "dandadan" }, { anime: "jjk", status: "DROPPED" }] });
    expect(r.isError).toBe(false);
    expect(r.text).toStartWith("Saved 0 of 2 updates; 2 already on your list, left unchanged.");
    expect(fake.writes).toHaveLength(0);
  });

  test("undo takes back the shows an addOnly call added", async () => {
    await call("update_shows", { addOnly: true, updates: [{ anime: "chainsaw man" }, { anime: "dandadan" }] });
    await call("undo");
    expect(fake.entries.has(CHAINSAW)).toBe(false);
    expect(fake.entries.get(DANDADAN)).toMatchObject({ status: "CURRENT", progress: 7 });
  });

  test("a dry run saves nothing and says what each name matches", async () => {
    const r = await call("update_shows", {
      dryRun: true,
      updates: [{ anime: "chainsaw man", status: "PLANNING" }, { anime: "jjk", episodes: 5 }, { anime: "frieren", score: 7 }],
    });
    expect(r.isError).toBe(false);
    expect(fake.writes).toHaveLength(0);
    expect(r.text).toStartWith("Dry run, nothing was saved: 3 of 3 updates would be saved.\n");
    expect(r.text).toContain(`Chainsaw Man: not on list -> Plan to watch.\n[${CHAINSAW}] Chainsaw Man (TV, 2022): not on your list`);
    expect(r.text).toContain("JUJUTSU KAISEN Season 2: episode 3 -> 5.\n[145064]");
    expect(r.text).toContain("score 9.5/10 -> 7/10.");
    expect(r.text).toContain("call again without dryRun, passing the ID");
    expect(r.text).not.toContain("addOnly");
  });

  test("a dry run with addOnly lists the shows already on the list", async () => {
    const r = await call("update_shows", { dryRun: true, addOnly: true, updates: [{ anime: "chainsaw man" }, { anime: "dandadan" }] });
    expect(r.text).toStartWith("Dry run, nothing was saved: 1 of 2 updates would be saved; 1 already on your list, left unchanged.\n");
    expect(r.text).toContain("Chainsaw Man: not on list -> Plan to watch.");
    // Saving the IDs without addOnly would change the listed shows too.
    expect(r.text).toContain("call again without dryRun but still with addOnly");
    expect(fake.writes).toHaveLength(0);
  });

  test("addOnly with a finish date adds the show as completed, and with a start date as watching", async () => {
    await call("update_shows", {
      addOnly: true,
      updates: [{ anime: "steins gate", score: 9, completedAt: "2023" }, { anime: "chainsaw man", startedAt: "2026-11" }],
    });
    expect(fake.entries.get(STEINS)).toMatchObject({ status: "COMPLETED", scoreRaw: 90, completedAt: { year: 2023 } });
    expect(fake.entries.get(CHAINSAW)).toMatchObject({ status: "CURRENT", startedAt: { year: 2026, month: 11 } });
  });

  test("when fetching the shows given by ID fails, each is looked up on its own", async () => {
    let failed = 0;
    const anilist = new AniListClient("t", async (url, init) => {
      if (!/id_in/.test(JSON.parse(init.body as string).query)) return fake.fetch(url, init);
      failed++;
      return new Response("oops", { status: 500 });
    });
    anilist.sleep = async () => {}; // the pause before a read is retried
    const [ct, st] = InMemoryTransport.createLinkedPair();
    const own = new Client({ name: "test", version: "0" });
    await Promise.all([createServer(anilist, { now: () => NOW }).connect(st), own.connect(ct)]);
    const r = (await own.callTool({ name: "update_shows", arguments: { addOnly: true, updates: [{ anime: CHAINSAW }, { anime: STEINS }] } })) as {
      isError?: boolean;
    };
    expect(failed).toBe(2); // a read failing with a 5xx is retried once
    expect(r.isError).toBeFalsy();
    expect(fake.entries.get(CHAINSAW)).toMatchObject({ status: "PLANNING" });
    expect(fake.entries.get(STEINS)).toMatchObject({ status: "PLANNING" });
  });

  test("a dry run checks up to 50 names; saving takes 10 at a time", async () => {
    const names = Array.from({ length: 11 }, () => ({ anime: "chainsaw man", status: "PLANNING" }));
    const dry = await call("update_shows", { dryRun: true, updates: names });
    expect(dry.text).toStartWith("Dry run, nothing was saved: 11 of 11 updates would be saved.");
    const save = await call("update_shows", { updates: names });
    expect(save.isError).toBe(true);
    expect(save.text).toContain("Up to 10 updates are saved per call");
    expect(fake.writes).toHaveLength(0);
  });

  test("a batch's title searches go to AniList as one request", async () => {
    await call("update_shows", {
      addOnly: true,
      updates: ["chainsaw man", "steins gate", "naruto", "mushoku tensei", "vinland saga"].map((anime) => ({ anime })),
    });
    expect(searches()).toBe(1);
  });

  test("more searches than AniList's query complexity allows in one request are split", async () => {
    await call("update_shows", {
      addOnly: true,
      dryRun: true,
      updates: ["chainsaw man", "steins gate", "naruto", "mushoku tensei", "vinland saga", "demon slayer", "monogatari", "re zero"].map(
        (anime) => ({ anime }),
      ),
    });
    expect(searches()).toBe(2); // 7 searches to a request, then 1
  });

  test("shows given by ID are fetched in one request", async () => {
    await call("update_shows", { addOnly: true, updates: [{ anime: CHAINSAW }, { anime: STEINS }, { anime: DANDADAN }] });
    expect(fake.calls.filter((c) => /id_in/.test(c.query))).toHaveLength(1);
    expect(fake.calls.filter((c) => /Media\(id:/.test(c.query))).toHaveLength(0);
    expect(fake.entries.get(CHAINSAW)).toMatchObject({ status: "PLANNING" });
    expect(fake.entries.get(DANDADAN)).toMatchObject({ status: "CURRENT" });
  });
});
