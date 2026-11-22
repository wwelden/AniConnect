import { beforeEach, describe, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { ElicitRequestSchema, type ElicitResult } from "@modelcontextprotocol/sdk/types.js";
import { AniListClient } from "../src/anilist";
import { createServer, UserState } from "../src/server";
import { PERSONA } from "./fixtures/persona";
import { FakeAniList, findMedia } from "./support/fake-anilist";

const DANDADAN = 171018;
const FRIEREN = 154587;
const BOCCHI = findMedia("Bocchi the Rock!").id;
const CHAINSAW = findMedia("Chainsaw Man").id;

let fake: FakeAniList;
let client: Client;
let clock: number;

const kind = (query: string) =>
  query.includes("MediaListCollection")
    ? "list"
    : query.includes("Viewer")
      ? "viewer"
      : /^\s*mutation/.test(query)
        ? "write"
        : "other";

/** Calls a tool; returns its text and the kinds of AniList requests it made (viewer reads left out). */
async function call(name: string, args: Record<string, unknown> = {}) {
  const start = fake.calls.length;
  const result = (await client.callTool({ name, arguments: args })) as { content: { text: string }[]; isError?: boolean };
  return {
    text: result.content.map((c) => c.text).join("\n"),
    isError: Boolean(result.isError),
    requests: fake.calls.slice(start).map((c) => kind(c.query)).filter((k) => k !== "viewer"),
  };
}

async function connect(capabilities: Record<string, unknown> = {}, answer?: () => ElicitResult, user?: UserState) {
  const anilist = new AniListClient("t", fake.fetch);
  anilist.sleep = async () => {};
  const server = createServer(anilist, { now: () => clock, user });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  client = new Client({ name: "t", version: "0" }, { capabilities });
  if (answer) client.setRequestHandler(ElicitRequestSchema, async () => answer());
  await Promise.all([server.connect(st), client.connect(ct)]);
}

beforeEach(async () => {
  clock = Date.parse("2026-11-17T12:00:00Z");
  fake = new FakeAniList("POINT_10_DECIMAL").seed(PERSONA);
  fake.clock = () => clock;
  await connect();
});

/** Loads the list into the cache, then moves the clock on past the point where it is trusted for a write. */
async function warmThenWait(ms = 20_000) {
  await call("search_my_list", {});
  clock += ms;
}

describe("writes read the show fresh when the cached list may be out of date", () => {
  test("episodes count up from a change made on anilist.co, and undo goes back to it", async () => {
    await warmThenWait();
    fake.entries.get(DANDADAN)!.progress = 11; // set on the website
    const r = await call("mark_episodes_watched", { anime: "dandadan" });
    expect(r.text).toContain("episode 11 -> 12");
    expect(r.requests).toEqual(["other", "write"]);
    expect(fake.entries.get(DANDADAN)!.progress).toBe(12);

    const undone = await call("undo");
    expect(undone.text).toContain("11/12");
    expect(fake.entries.get(DANDADAN)!.progress).toBe(11);
  });

  test("a paused show set on the website moves to watching with the next episode", async () => {
    await warmThenWait();
    fake.entries.get(DANDADAN)!.status = "PAUSED";
    const r = await call("mark_episodes_watched", { anime: "dandadan" });
    expect(r.text).toContain("Status is now Watching (was Paused)");
    expect(fake.entries.get(DANDADAN)!.status).toBe("CURRENT");
  });

  test("addNote keeps a note written elsewhere", async () => {
    await warmThenWait();
    fake.entries.get(DANDADAN)!.notes = "dub is great";
    await call("update_shows", { updates: [{ anime: "dandadan", watched: 1, addNote: "great ep" }] });
    expect(fake.entries.get(DANDADAN)!.notes).toBe("dub is great\ngreat ep");
  });

  test("undo of a status change keeps a score set elsewhere", async () => {
    await warmThenWait();
    fake.entries.get(DANDADAN)!.scoreRaw = 90;
    await call("set_status", { anime: "dandadan", status: "PAUSED" });
    const r = await call("undo");
    expect(r.text).toContain("9/10");
    expect(fake.entries.get(DANDADAN)!.scoreRaw).toBe(90);
    expect(fake.entries.get(DANDADAN)!.status).toBe("CURRENT");
  });

  test("update_shows reads every show it changes in one request", async () => {
    await warmThenWait();
    fake.entries.get(DANDADAN)!.progress = 11;
    const r = await call("update_shows", {
      updates: [
        { anime: "dandadan", watched: 1 },
        { anime: "jjk", watched: 1 },
        { anime: "frieren", score: 8 },
      ],
    });
    expect(r.text).toContain("episode 11 -> 12");
    const reads = fake.calls.filter((c) => Array.isArray(c.variables.ids));
    expect(reads.map((c) => c.variables.ids)).toEqual([[DANDADAN, 145064, FRIEREN]]);
    expect(r.requests.filter((k) => k === "write")).toHaveLength(3);
  });

  test("a list fetched moments ago is trusted: no extra request", async () => {
    await warmThenWait(2_000);
    const r = await call("mark_episodes_watched", { anime: "dandadan" });
    expect(r.requests).toEqual(["write"]);
  });

  test("a show given by ID is read fresh already, so no second read", async () => {
    await warmThenWait();
    fake.entries.get(DANDADAN)!.progress = 11;
    const r = await call("mark_episodes_watched", { anime: DANDADAN });
    expect(r.text).toContain("episode 11 -> 12");
    expect(r.requests).toEqual(["other", "write"]);
  });
});

describe("removing without a dialog takes two calls", () => {
  test("the first call shows the entry and removes nothing; confirmed: true removes it", async () => {
    const { tools } = await client.listTools();
    expect(tools.find((t) => t.name === "remove_from_list")!.description).toContain("confirmed: true");
    let r = await call("remove_from_list", { anime: "dandadan" });
    expect(r.isError).toBe(false);
    expect(r.text).toContain("Not removed yet");
    expect(r.text).toContain("DAN DA DAN (TV, 2024): Watching, 7/12 episodes");
    expect(r.text).toContain("confirmed: true");
    expect(r.requests).not.toContain("write");
    expect(fake.entries.has(DANDADAN)).toBe(true);

    r = await call("remove_from_list", { anime: "dandadan", confirmed: true });
    expect(r.text).toContain("Removed DAN DA DAN from your list.");
    expect(fake.entries.has(DANDADAN)).toBe(false);
  });

  test("confirmed: true on the first call only shows the entry", async () => {
    const r = await call("remove_from_list", { anime: "dandadan", confirmed: true });
    expect(r.text).toContain("Not removed yet");
    expect(fake.entries.has(DANDADAN)).toBe(true);
  });

  test("an entry changed since it was shown is not removed", async () => {
    await call("remove_from_list", { anime: "dandadan" });
    clock += 20_000;
    fake.entries.get(DANDADAN)!.progress = 9;
    const r = await call("remove_from_list", { anime: "dandadan", confirmed: true });
    expect(r.text).toContain("changed since");
    expect(r.text).toContain("9/12");
    expect(fake.entries.has(DANDADAN)).toBe(true);
  });

  test("a confirmation expires after 10 minutes, and works once", async () => {
    await call("remove_from_list", { anime: "dandadan" });
    clock += 10 * 60_000 + 1;
    let r = await call("remove_from_list", { anime: "dandadan", confirmed: true });
    expect(r.text).toContain("Not removed yet");
    expect(fake.entries.has(DANDADAN)).toBe(true);

    r = await call("remove_from_list", { anime: "dandadan", confirmed: true });
    expect(r.text).toContain("Removed DAN DA DAN");
    await call("add_to_list", { anime: DANDADAN });
    r = await call("remove_from_list", { anime: "dandadan", confirmed: true });
    expect(r.text).toContain("Not removed yet");
    expect(fake.entries.has(DANDADAN)).toBe(true);
  });

  test("the confirmation carries over to another conversation of the same user", async () => {
    const user = new UserState();
    await connect({}, undefined, user);
    await call("remove_from_list", { anime: "dandadan" });
    await connect({}, undefined, user);
    const r = await call("remove_from_list", { anime: "dandadan", confirmed: true });
    expect(r.text).toContain("Removed DAN DA DAN");
  });

  test("a dialog closed without an answer falls back to the same two calls (claude -p cancels every form)", async () => {
    await connect({ elicitation: {} }, () => ({ action: "cancel" }));
    let r = await call("remove_from_list", { anime: "dandadan" });
    expect(r.text).toContain("Not removed yet");
    expect(r.text).toContain("confirmed: true");
    expect(fake.entries.has(DANDADAN)).toBe(true);
    r = await call("remove_from_list", { anime: "dandadan", confirmed: true });
    expect(r.text).toContain("Removed DAN DA DAN");
  });
});

test("a removal accepted after a while journals the entry as it was when deleted", async () => {
  await connect({ elicitation: {} }, () => {
    clock += 20_000;
    fake.entries.get(DANDADAN)!.progress = 9; // logged on anilist.co while the dialog was open
    return { action: "accept", content: { confirm: true } };
  });
  const r = await call("remove_from_list", { anime: "dandadan" });
  expect(r.text).toContain("Removed DAN DA DAN");
  await call("undo");
  expect(fake.entries.get(DANDADAN)!.progress).toBe(9);
});

test("update_shows still saves when the batched re-read fails", async () => {
  const fetch = fake.fetch;
  fake.fetch = async (url: string, init: RequestInit) => {
    if (Array.isArray(JSON.parse(init.body as string).variables?.ids)) return new Response("down", { status: 500 });
    return fetch(url, init);
  };
  await connect();
  await warmThenWait();
  const r = await call("update_shows", { updates: [{ anime: "dandadan", watched: 1 }, { anime: "jjk", watched: 1 }] });
  expect(r.isError).toBe(false);
  expect(fake.entries.get(DANDADAN)!.progress).toBe(8);
  expect(fake.entries.get(145064)!.progress).toBe(4);
});

describe("rewinding a completed show reached by a typo asks first", () => {
  test("a typo that would move a completed show back to watching changes nothing", async () => {
    const r = await call("set_progress", { anime: "bochi the rock", episodes: 3 });
    expect(r.isError).toBe(true);
    expect(r.text).toStartWith('Nothing was changed. Matched "bochi the rock" to BOCCHI THE ROCK!');
    expect(r.text).toContain(`call again with its ID (${BOCCHI})`);
    expect(fake.entries.get(BOCCHI)!.progress).toBe(12);
    expect(fake.entries.get(BOCCHI)!.status).toBe("COMPLETED");
  });

  test("the same rewind by ID, or by a name that matches, writes at once", async () => {
    let r = await call("set_progress", { anime: FRIEREN, episodes: 5 });
    expect(r.isError).toBe(false);
    expect(fake.entries.get(FRIEREN)!.progress).toBe(5);

    // A short name is a word match, not a typo: a rewatch said this way isn't slowed down.
    r = await call("set_progress", { anime: "bocchi", episodes: 3 });
    expect(r.isError).toBe(false);
    expect(fake.entries.get(BOCCHI)!.progress).toBe(3);
  });

  test("update_shows checks too, unless the status is given", async () => {
    let r = await call("update_shows", { updates: [{ anime: "bochi the rock", episodes: 3 }] });
    expect(r.text).toContain("Not changed");
    expect(r.text).toContain(`its ID (${BOCCHI})`);
    expect(fake.entries.get(BOCCHI)!.status).toBe("COMPLETED");

    r = await call("update_shows", { updates: [{ anime: "bochi the rock", status: "REPEATING", episodes: 3 }] });
    expect(r.isError).toBe(false);
    expect(fake.entries.get(BOCCHI)!.status).toBe("REPEATING");
  });
});

describe("results name the show and say what else changed", () => {
  test("an episode past the last names the matched show and says nothing changed", async () => {
    const r = await call("mark_episodes_watched", { anime: "jujutsu kaisen", count: 21 });
    expect(r.isError).toBe(true);
    expect(r.text).toBe(
      "Nothing was changed. Matched \"jujutsu kaisen\" to JUJUTSU KAISEN Season 2: you're watching it.\n" +
        "JUJUTSU KAISEN Season 2 has 23 episodes, so 24 is past the last one.",
    );
  });

  test("by ID, the error still names the show", async () => {
    const r = await call("set_progress", { anime: FRIEREN, episodes: 29 });
    expect(r.text).toBe("Nothing was changed. Frieren: Beyond Journey’s End has 28 episodes, so 29 is past the last one.");
  });

  test("update_shows names the show in the failure line", async () => {
    const r = await call("update_shows", { updates: [{ anime: FRIEREN, episodes: 29 }] });
    expect(r.text).toContain("Frieren: Beyond Journey’s End has 28 episodes, so 29 is past the last one.");
  });

  test("rating a show that isn't on the list says it was added, and as what", async () => {
    const r = await call("rate_anime", { anime: CHAINSAW, score: 8 });
    expect(r.text).toBe("Added Chainsaw Man to your list as Plan to watch and rated it 8/10.");
    expect(fake.entries.get(CHAINSAW)!.status).toBe("PLANNING");
  });

  test("an episode of a show that isn't on the list says it was added", async () => {
    const r = await call("mark_episodes_watched", { anime: CHAINSAW });
    expect(r.text).toContain("Added to your list as Watching.");
  });
});

test("a show picked in a dialog is read again, even when the list was refetched while the dialog was open", async () => {
  const AOT = findMedia("Shingeki no Kyojin").id;
  const anilist = new AniListClient("t", fake.fetch);
  const server = createServer(anilist, { now: () => clock });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  client = new Client({ name: "t", version: "0" }, { capabilities: { elicitation: {} } });
  client.setRequestHandler(ElicitRequestSchema, async (req) => {
    // The dialog stays open past the list cache's life; the score changes on anilist.co, and
    // another call refetches the list, so the cache is fresh but the show in hand is not.
    clock += 70_000;
    fake.entries.get(AOT)!.scoreRaw = 70;
    await call("search_my_list", {});
    const options = (req.params as unknown as { requestedSchema: { properties: { anime: { oneOf: { const: string; title: string }[] } } } })
      .requestedSchema.properties.anime.oneOf;
    return { action: "accept", content: { anime: options.find((o) => o.title.includes("(TV, 2013)"))!.const } };
  });
  await Promise.all([server.connect(st), client.connect(ct)]);
  const r = await call("rate_anime", { anime: "attack on titan", score: 10 });
  expect(r.isError).toBe(false);
  expect(fake.entries.get(AOT)!.scoreRaw).toBe(100);
  await call("undo");
  expect(fake.entries.get(AOT)!.scoreRaw).toBe(70);
});
