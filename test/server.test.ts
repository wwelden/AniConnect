import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { AniListClient, LIST_TTL_MS } from "../src/anilist";
import { formatDate, todayFuzzy } from "../src/logic";
import { createServer, INSTRUCTIONS, WRITE_TOOLS, type ServerOptions } from "../src/server";
import pkg from "../package.json" with { type: "json" };
import { HISTORY, PERSONA } from "./fixtures/persona";
import { catalog, FakeAniList, findMedia, type CatalogMedia } from "./support/fake-anilist";

let fake: FakeAniList;
let client: Client;

async function call(name: string, args: Record<string, unknown>) {
  const result = (await client.callTool({ name, arguments: args })) as {
    content: { text: string }[];
    isError?: boolean;
  };
  return { text: result.content.map((c) => c.text).join("\n"), isError: Boolean(result.isError) };
}

/** Rate-limit waits the client asked for, which pass at once, calling `onSleep`. */
let slept: number[] = [];
let onSleep = () => {};

async function connect(options: ServerOptions = {}) {
  const anilist = new AniListClient("test-token", fake.fetch);
  anilist.sleep = async (ms) => {
    slept.push(ms);
    onSleep();
  };
  const server = createServer(anilist, options);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  client = new Client({ name: "test", version: "0" });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
}

beforeEach(async () => {
  slept = [];
  onSleep = () => {};
  fake = new FakeAniList("POINT_5");
  await connect();
});

/** 2026-11-17 noon UTC: Apothecary Diaries Season 3 has aired 7 episodes (episode 8 airs 2026-11-20). */
const NOW = Date.UTC(2026, 10, 17, 12);
// The server dates entries by its local day; derive the same so this passes in any time zone.
const TODAY_DATE = todayFuzzy(new Date(NOW));
const TODAY = formatDate(TODAY_DATE);
const EARLIER = { year: 2024, month: 3, day: 1 };

describe("title language", () => {
  test("the viewer query asks for the title language", async () => {
    await call("search_my_list", {});
    expect(fake.calls.find((c) => c.query.includes("Viewer"))!.query).toMatch(/options \{[^}]*\btitleLanguage\b/);
  });

  test("results print the English title alone for English readers", async () => {
    fake.seed(PERSONA);
    const r = await call("mark_episodes_watched", { anime: "jjk" });
    expect(r.text).toBe(
      'Matched "jjk" to JUJUTSU KAISEN Season 2: you\'re watching it.\n' +
        "JUJUTSU KAISEN Season 2: episode 3 -> 4.\n" +
        "[145064] JUJUTSU KAISEN Season 2 (TV, 2023): Watching, 4/23 episodes, unrated",
    );
  });

  test("results print the romaji title alone for romaji readers, and English names still match", async () => {
    fake.titleLanguage = "ROMAJI";
    fake.seed(PERSONA);
    const r = await call("mark_episodes_watched", { anime: "jujutsu kaisen season 2" });
    expect(r.text).toBe(
      'Matched "jujutsu kaisen season 2" to Jujutsu Kaisen 2nd Season: it\'s season 2, going by its title.\n' +
        "Jujutsu Kaisen 2nd Season: episode 3 -> 4.\n" +
        "[145064] Jujutsu Kaisen 2nd Season (TV, 2023): Watching, 4/23 episodes, unrated",
    );
    const rated = await call("rate_anime", { anime: "attack on titan season 2", score: 8 });
    expect(rated.text).toContain("Rated Shingeki no Kyojin Season 2:");
    expect(rated.text).not.toContain("Attack on Titan Season 2");
  });

  test("native readers get native titles; romaji names still match", async () => {
    fake.titleLanguage = "NATIVE";
    fake.seed(PERSONA);
    const r = await call("search_my_list", { query: "sousou no frieren" });
    expect(r.text).toContain("[154587] 葬送のフリーレン (TV, 2023): Completed");
    expect(r.text).not.toContain("Frieren: Beyond");
  });

  test("a show with no title in the user's language falls back to romaji", async () => {
    const r = await call("add_to_list", { anime: 761 });
    expect(r.text).toBe(
      "Added: [761] NARUTO: Akaki Yotsuba no Clover wo Sagase (SPECIAL, 2003): Plan to watch, 0/1 episodes, unrated",
    );
  });

  test("ambiguous candidates keep a second title, the preferred one first", async () => {
    fake.titleLanguage = "ROMAJI";
    fake.seed(PERSONA);
    const r = await call("rate_anime", { anime: "attack on titan", score: 10 });
    expect(r.isError).toBe(true);
    expect(r.text).toContain("[16498] Shingeki no Kyojin (Attack on Titan) (TV, 2013), on your list: completed");
  });

  test("a missing title language setting defaults to romaji, AniList's default", async () => {
    const fetchWithoutOptions = async (url: string, init: RequestInit) => {
      const res = await fake.fetch(url, init);
      const body = (await res.json()) as { data?: { Viewer?: { options: unknown } } };
      if (body.data?.Viewer) body.data.Viewer.options = null;
      return new Response(JSON.stringify(body), { status: res.status });
    };
    expect((await new AniListClient("t", fetchWithoutOptions).getViewer()).titleLanguage).toBe("ROMAJI");
  });
});

describe("tools", () => {
  test("lists every tool", async () => {
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([
      "add_to_list",
      "mark_episodes_watched",
      "rate_anime",
      "remove_from_list",
      "search_anime",
      "search_my_list",
      "set_progress",
      "set_status",
      "undo",
      "update_shows",
      "watch_history",
      "whats_next",
    ]);
  });

  test("says the shared guidance once, in the server instructions", async () => {
    const { tools } = await client.listTools();
    expect(client.getInstructions()).toBe(INSTRUCTIONS);
    // undo changes the list but takes no show.
    const writers = tools.filter((t) => t.annotations?.readOnlyHint === false && t.name !== "undo").map((t) => t.name);
    expect([...WRITE_TOOLS].sort() as string[]).toEqual(writers.sort());
    for (const name of WRITE_TOOLS) expect(INSTRUCTIONS).toContain(name);
    // Each write tool keeps a short hint of its own, for clients that don't show instructions.
    for (const t of tools) {
      expect(t.description).not.toContain("picks the right entry");
      if (writers.includes(t.name)) expect(t.description).toContain("don't search first");
    }
  });

  test("sends the token as a bearer header", async () => {
    let auth = null as string | null;
    const original = fake.fetch;
    fake.fetch = async (url, init) => {
      auth = new Headers(init.headers).get("Authorization");
      return original(url, init);
    };
    const server = createServer(new AniListClient("abc123", (u, i) => fake.fetch(u, i)));
    const [ct, st] = InMemoryTransport.createLinkedPair();
    const c = new Client({ name: "t", version: "0" });
    await Promise.all([server.connect(st), c.connect(ct)]);
    await c.callTool({ name: "search_anime", arguments: { query: "titan" } });
    expect(auth).toBe("Bearer abc123");
  });

  test("search_anime finds shows and shows list state", async () => {
    const r = await call("search_anime", { query: "titan" });
    expect(r.text).toContain("[16498] Attack on Titan (TV, 2013): not on your list");
    expect(r.text).toContain("[20958] Attack on Titan Season 2");
    expect(r.text).toContain("not on your list");
  });

  test("add_to_list adds as planning and does not overwrite an existing entry", async () => {
    let r = await call("add_to_list", { anime: 16498 });
    expect(r.text).toContain("Added:");
    expect(fake.entries.get(16498)!.status).toBe("PLANNING");

    await call("set_status", { anime: 16498, status: "CURRENT" });
    r = await call("add_to_list", { anime: 16498 });
    expect(r.text).toContain("Already on your list, unchanged");
    expect(fake.entries.get(16498)!.status).toBe("CURRENT");
  });

  test("search_my_list filters by title and status without duplicates", async () => {
    fake.seed([{ anime: 16498, status: "PLANNING" }, { anime: 21, status: "CURRENT" }]);
    // AniList returns an entry on a custom list twice: in its status list and in the custom list.
    fake.entries.get(21)!.customLists = ["Favourites"];

    let r = await call("search_my_list", { query: "attack" });
    expect(r.text).toContain("1 match on tester's list");
    expect(r.text).toContain("Attack on Titan");
    expect(r.text).not.toContain("ONE PIECE");

    r = await call("search_my_list", { status: "CURRENT" });
    expect(r.text).toContain("ONE PIECE");
    expect(r.text).not.toContain("Attack on Titan");

    r = await call("search_my_list", {});
    expect(r.text).toContain("2 matches");

    r = await call("search_my_list", { query: "naruto" });
    expect(r.text).toContain("Nothing on tester's list");
  });

  test("search_my_list pages through a long list, and the header says how to get the next page", async () => {
    fake.seed(catalog.slice(0, 120).map((m) => ({ anime: m.id, status: "COMPLETED" as const })));
    const ids = (text: string) => [...text.matchAll(/^\[(\d+)\]/gm)].map((m) => Number(m[1]));

    let r = await call("search_my_list", { status: "COMPLETED" });
    expect(r.text.split("\n")[0]).toBe("120 matches on tester's list for Completed (showing 1-50; offset 50 for more):");
    const seen = ids(r.text);
    expect(seen).toHaveLength(50);

    r = await call("search_my_list", { status: "COMPLETED", offset: 50 });
    expect(r.text.split("\n")[0]).toBe("120 matches on tester's list for Completed (showing 51-100; offset 100 for more):");
    seen.push(...ids(r.text));

    r = await call("search_my_list", { status: "COMPLETED", offset: 100 });
    expect(r.text.split("\n")[0]).toBe("120 matches on tester's list for Completed (showing 101-120):");
    seen.push(...ids(r.text));
    // Every entry once, in one title order across pages.
    expect(new Set(seen)).toEqual(new Set(catalog.slice(0, 120).map((m) => m.id)));
    expect(seen).toHaveLength(120);

    r = await call("search_my_list", { status: "COMPLETED", limit: 200 });
    expect(ids(r.text)).toEqual(seen);
    expect(r.text.split("\n")[0]).toBe("120 matches on tester's list for Completed:");

    r = await call("search_my_list", { status: "COMPLETED", offset: 120 });
    expect(r.text).toBe("120 matches on tester's list for Completed; offset 120 is past the end, so use one below 120.");
  });

  test("search_my_list sorts by score, finish or start date, and progress", async () => {
    // Attack on Titan, ONE PIECE, Frieren, Dandadan.
    fake.seed([
      { anime: 16498, status: "COMPLETED", score: 8 },
      { anime: 21, status: "CURRENT", progress: 1100 },
      { anime: 154587, status: "COMPLETED", score: 9.5 },
      { anime: 171018, status: "CURRENT", progress: 3 },
    ]);
    fake.entries.get(16498)!.completedAt = { year: 2024, month: 3, day: 1 };
    fake.entries.get(154587)!.completedAt = { year: 2025, month: 10, day: null };
    fake.entries.get(171018)!.startedAt = { year: 2024, month: 10, day: 4 };
    fake.entries.get(21)!.startedAt = { year: 1999, month: 10, day: 20 };
    const ids = (text: string) => [...text.matchAll(/^\[(\d+)\]/gm)].map((m) => Number(m[1]));

    // Unrated shows go last, in title order.
    let r = await call("search_my_list", { sort: "score" });
    expect(r.text.split("\n")[0]).toBe("4 matches on tester's list, highest score first:");
    expect(ids(r.text)).toEqual([154587, 16498, 171018, 21]);

    r = await call("search_my_list", { status: "COMPLETED", sort: "finished" });
    const lines = r.text.split("\n");
    expect(lines[0]).toBe("2 matches on tester's list for Completed, latest finish first:");
    expect(lines[1]).toMatch(/^\[154587\] .*, finished 2025-10$/);
    expect(lines[2]).toMatch(/^\[16498\] .*, finished 2024-03-01$/);

    r = await call("search_my_list", { sort: "started" });
    expect(ids(r.text)[0]).toBe(171018);
    expect(ids(r.text).slice(0, 2)).toEqual([171018, 21]);
    expect(r.text).toContain(", started 2024-10-04");
    expect(r.text).toContain(", started 1999-10-20");
    expect(r.text).toContain(", no start date");

    r = await call("search_my_list", { status: "CURRENT", sort: "progress" });
    expect(r.text.split("\n")[0]).toBe("2 matches on tester's list for Watching, most episodes first:");
    expect(ids(r.text)).toEqual([21, 171018]);
  });

  test("rate_anime sends a raw score and reports it in the user's format", async () => {
    const r = await call("rate_anime", { anime: 16498, score: 8 });
    expect(fake.calls.at(-1)!.variables.scoreRaw).toBe(80);
    expect(r.text).toBe("Added Attack on Titan to your list as Plan to watch and rated it 4 stars (of 5).");
    expect(fake.entries.get(16498)!.scoreRaw).toBe(80);
  });

  test("rate_anime rejects scores above 10", async () => {
    const r = await call("rate_anime", { anime: 16498, score: 80 });
    expect(r.isError).toBe(true);
  });

  test("mark_episodes_watched counts up and completes on the last episode", async () => {
    await call("add_to_list", { anime: 16498 });
    let r = await call("mark_episodes_watched", { anime: 16498 });
    expect(r.text).toContain("episode 0 -> 1");
    expect(r.text).toContain("Status is now Watching");
    expect(fake.entries.get(16498)!.startedAt.year).not.toBeNull();

    r = await call("mark_episodes_watched", { anime: 16498, count: 3 });
    expect(r.text).toContain("episode 1 -> 4");

    r = await call("set_progress", { anime: 16498, episodes: 25 });
    expect(r.text).toContain("Status is now Completed");
    expect(fake.entries.get(16498)!.completedAt.year).not.toBeNull();
  });

  test("progress past the last episode is an error and saves nothing", async () => {
    await call("set_progress", { anime: 16498, episodes: 24 });
    const r = await call("mark_episodes_watched", { anime: 16498, count: 2 });
    expect(r.isError).toBe(true);
    expect(r.text).toContain("Attack on Titan has 25 episodes, so 26 is past the last one.");
    expect(fake.entries.get(16498)!.progress).toBe(24);
  });

  test("set_status COMPLETED fills in all episodes", async () => {
    await call("set_status", { anime: 16498, status: "COMPLETED" });
    expect(fake.entries.get(16498)!.progress).toBe(25);
  });

  test("remove_from_list deletes the entry", async () => {
    await call("add_to_list", { anime: 16498 });
    let r = await call("remove_from_list", { anime: 16498 });
    expect(r.text).toContain("Not removed yet");
    r = await call("remove_from_list", { anime: 16498, confirmed: true });
    expect(r.text).toContain("Removed Attack on Titan");
    expect(fake.entries.has(16498)).toBe(false);
    r = await call("remove_from_list", { anime: 16498 });
    expect(r.text).toContain("isn't on your list");
  });

  test("remove_from_list asks which part of a split season, then removes the one named (#29)", async () => {
    fake.seed(PERSONA);
    let r = await call("remove_from_list", { anime: "spy x family season 1" });
    expect(r.text).not.toContain("Removed");
    expect(r.text).toContain("[140960]");
    expect(r.text).toContain("[142838]");
    expect(fake.entries.has(140960)).toBe(true);
    expect(fake.entries.has(142838)).toBe(true);

    r = await call("remove_from_list", { anime: "spy x family season 1 part 2" });
    expect(r.text).toContain("Not removed yet");
    r = await call("remove_from_list", { anime: "spy x family season 1 part 2", confirmed: true });
    expect(r.text).toContain("Removed");
    expect(fake.entries.has(142838)).toBe(false);
    expect(fake.entries.has(140960)).toBe(true);

    await call("remove_from_list", { anime: 140960 });
    r = await call("remove_from_list", { anime: 140960, confirmed: true });
    expect(r.text).toContain("Removed");
    expect(fake.entries.has(140960)).toBe(false);
  });

  test("unknown media is a readable error", async () => {
    const r = await call("add_to_list", { anime: 999999 });
    expect(r.isError).toBe(true);
    expect(r.text).toContain("No anime found with id 999999");
  });

  test("progress by name goes to the season being watched", async () => {
    fake.seed(PERSONA);
    const r = await call("mark_episodes_watched", { anime: "jjk" });
    expect(r.isError).toBe(false);
    expect(r.text).toContain('Matched "jjk" to JUJUTSU KAISEN Season 2: you\'re watching it.');
    expect(r.text).toContain("episode 3 -> 4");
    expect(fake.entries.get(145064)!.progress).toBe(4);
    expect(fake.entries.get(113415)!.progress).toBe(24);
  });

  test("a season by number resolves through the sequel chain", async () => {
    fake.seed(PERSONA);
    const r = await call("rate_anime", { anime: "attack on titan season 3 part 2", score: 9 });
    expect(r.isError).toBe(false);
    expect(fake.entries.get(104578)!.scoreRaw).toBe(90);
  });

  test("the newest of six seasons takes the list, one search and the write (R5.2)", async () => {
    fake.seed(PERSONA);
    const r = await call("add_to_list", { anime: "the new season of my hero academia" });
    expect(r.text).toContain("[139630] My Hero Academia Season 6");
    expect(fake.entries.get(139630)!.status).toBe("PLANNING");
    // The viewer lookup happens once per session, so it isn't counted.
    const requests = fake.calls.filter((c) => !c.query.includes("Viewer"));
    expect(requests.map((c) => (c.query.includes("mutation") ? "write" : c.query.includes("search:") ? "search" : c.query.includes("MediaListCollection") ? "list" : "other"))).toEqual(["list", "search", "write"]);
  });

  test("ambiguous names change nothing and list the candidates", async () => {
    fake.seed(PERSONA);
    const before = fake.writes.length;
    const r = await call("rate_anime", { anime: "attack on titan", score: 10 });
    expect(r.isError).toBe(true);
    expect(r.text).toContain("Nothing was changed");
    expect(r.text).toContain("[16498]");
    expect(r.text).toContain("[20958]");
    expect(fake.writes.length).toBe(before);
  });

  test("adding by name picks the first season and adds it", async () => {
    const r = await call("add_to_list", { anime: "frieren" });
    expect(r.text).toContain("Added:");
    expect(fake.entries.get(154587)!.status).toBe("PLANNING");
  });

  test("numeric strings are treated as IDs", async () => {
    await call("add_to_list", { anime: "16498" });
    expect(fake.entries.has(16498)).toBe(true);
  });

  test("rate limits surface the retry delay once waiting hasn't helped", async () => {
    fake.rateLimited = true;
    const r = await call("search_anime", { query: "titan" });
    expect(r.isError).toBe(true);
    expect(r.text).toContain("Try again in 30 seconds");
    expect(r.text).toContain("30 requests a minute");
    expect(slept).toEqual([30_000]);
  });

  test("a rate-limited request waits as AniList says and is sent again", async () => {
    await call("search_my_list", {}); // the viewer and list, so only the search is limited
    fake.rateLimited = true;
    onSleep = () => (fake.rateLimited = false);
    const r = await call("search_anime", { query: "frieren" });
    expect(r.isError).toBe(false);
    expect(r.text).toContain("Frieren");
    expect(slept).toEqual([30_000]);
  });

  test("a wait longer than half a minute is reported, not made", async () => {
    fake.rateLimited = true;
    fake.retryAfter = "45";
    const r = await call("search_anime", { query: "titan" });
    expect(r.text).toContain("Try again in 45 seconds");
    expect(slept).toEqual([]);
  });

  test("reports the version from package.json", () => {
    expect(client.getServerVersion()?.version).toBe(pkg.version);
  });

  test("a malformed viewer response isn't cached", async () => {
    let broken = true;
    const flaky = async (url: string, init: RequestInit) => {
      const res = await fake.fetch(url, init);
      if (!broken || !String(init.body).includes("Viewer")) return res;
      broken = false;
      const body = (await res.json()) as { data: { Viewer: { mediaListOptions: unknown } } };
      body.data.Viewer.mediaListOptions = null; // Nullable in AniList's schema.
      return new Response(JSON.stringify(body));
    };
    const anilist = new AniListClient("t", flaky);
    expect(await anilist.getViewer().then(() => "loaded", () => "failed")).toBe("failed");
    expect((await anilist.getViewer()).name).toBe("tester");
  });

  test("a stalled request times out and isn't cached", async () => {
    const anilist = new AniListClient("t", fake.fetch);
    anilist.requestTimeoutMs = 50;
    const failure = (p: Promise<unknown>) => p.then(() => "loaded", (e: Error) => e.message);

    // Calls that start while the viewer is stuck share the request, and all give up together.
    fake.stalls = (q) => q.includes("Viewer");
    const [first, second] = await Promise.all([failure(anilist.getViewer()), failure(anilist.getMyList())]);
    expect(first).toBe("AniList didn't respond within 0.05 seconds; try again.");
    expect(second).toBe(first);

    fake.stalls = (q) => q.includes("MediaListCollection");
    expect(await failure(anilist.getMyList())).toBe(first);

    // A write that times out may still have been saved, so it isn't simply "try again".
    fake.stalls = (q) => q.trimStart().startsWith("mutation");
    expect(await failure(anilist.request("mutation { DeleteMediaListEntry(id: 1) { deleted } }"))).toBe(
      "AniList didn't respond within 0.05 seconds, so the change may or may not have been saved; check the list before trying again.",
    );

    // Once AniList answers again, the next calls start fresh requests instead of reusing the failed ones.
    fake.stalls = () => false;
    expect((await anilist.getViewer()).name).toBe("tester");
    expect(await anilist.getMyList()).toEqual([]);
  });

  test("the first tool call fetches the viewer once", async () => {
    await call("add_to_list", { anime: "frieren" });
    expect(fake.calls.filter((c) => c.query.includes("Viewer")).length).toBe(1);
  });
});

describe("titles made of digits", () => {
  // Real AniList: ID 86 is Gundam ZZ, and "86" is the title of ID 116589.
  const stub = (id: number, romaji: string, english: string | null, popularity: number) =>
    ({
      id, title: { romaji, english, native: null }, synonyms: [], episodes: 11, format: "TV", status: "FINISHED",
      season: "SPRING", seasonYear: 2021, startDate: { year: 2021, month: 4, day: 11 }, averageScore: 80,
      popularity, isAdult: false, siteUrl: `https://anilist.co/anime/${id}`, nextAiringEpisode: null, relations: { edges: [] }, franchise: romaji,
    }) as unknown as CatalogMedia;
  const added = [
    stub(116589, "86", "86 EIGHTY-SIX", 300000),
    stub(86, "Kidou Senshi Gundam ZZ", "Mobile Suit Gundam ZZ", 10000),
    stub(900100, "100-man no Inochi no Ue ni Ore wa Tatteiru", "I'm Standing on a Million Lives", 50000),
  ];
  beforeEach(() => void catalog.push(...added));
  afterEach(() => void catalog.splice(catalog.length - added.length, added.length));

  test("a digit string that is a title resolves as that title", async () => {
    const r = await call("add_to_list", { anime: "86" });
    expect(r.isError).toBe(false);
    expect(r.text).toContain('Matched "86" to 86 EIGHTY-SIX by title');
    expect(fake.entries.has(116589)).toBe(true);
    expect(fake.entries.has(86)).toBe(false);
  });

  test("a number is always an ID", async () => {
    await call("add_to_list", { anime: 86 });
    expect(fake.entries.has(86)).toBe(true);
    expect(fake.entries.has(116589)).toBe(false);
  });

  test("a listed show that only contains the number doesn't stop the search for one titled with it", async () => {
    // Mob Psycho 100 III is planned, which would otherwise end the search on the list.
    fake.seed(PERSONA);
    const r = await call("mark_episodes_watched", { anime: "100" });
    expect(r.isError).toBe(false);
    expect(fake.entries.get(900100)!.progress).toBe(1);
  });

  test("a digit string no show is titled with is an ID", async () => {
    // No title starts with "1000" (the test above covers one that only contains its number);
    // the fixture has no ID 1000.
    const r = await call("add_to_list", { anime: "1000" });
    expect(r.isError).toBe(true);
    expect(r.text).toContain("No anime found with id 1000");
  });
});

describe("status changes keep dates in sync (R0.7, R3.2)", () => {
  test("set_status COMPLETED fills in progress and both dates", async () => {
    await connect({ now: () => NOW });
    fake.seed(PERSONA);
    const r = await call("set_status", { anime: "haikyuu", status: "COMPLETED" });
    const e = fake.entries.get(20464)!;
    expect(e.progress).toBe(25);
    expect(e.startedAt).toEqual(TODAY_DATE);
    expect(e.completedAt).toEqual(TODAY_DATE);
    expect(r.text).toContain(`Start date set to ${TODAY}, finish date set to ${TODAY}.`);
  });

  test("set_status CURRENT sets the start date, and add_to_list does too", async () => {
    await connect({ now: () => NOW });
    fake.seed(PERSONA);
    await call("set_status", { anime: "haikyuu", status: "CURRENT" });
    expect(fake.entries.get(20464)!.startedAt).toEqual(TODAY_DATE);
    expect(fake.entries.get(20464)!.completedAt.year).toBeNull();

    const r = await call("add_to_list", { anime: 127230, status: "CURRENT" });
    expect(fake.entries.get(127230)!.startedAt).toEqual(TODAY_DATE);
    expect(r.text).toContain(`Start date set to ${TODAY}.`);
  });

  test("set_status never overwrites dates already set", async () => {
    fake.seed(PERSONA);
    const vinland = fake.entries.get(101348)!;
    vinland.startedAt = EARLIER;
    const r = await call("set_status", { anime: "vinland saga", status: "COMPLETED" });
    expect(fake.entries.get(101348)!.startedAt).toEqual(EARLIER);
    expect(fake.entries.get(101348)!.completedAt.year).not.toBeNull();
    expect(r.text).not.toContain("Start date");
  });
});

describe("rewatches", () => {
  test("starting a rewatch resets progress so episodes can be counted again", async () => {
    fake.seed(PERSONA);
    const bocchi = fake.entries.get(130003)!;
    bocchi.startedAt = EARLIER;
    bocchi.completedAt = EARLIER;

    let r = await call("set_status", { anime: "bocchi the rock", status: "REPEATING" });
    expect(r.isError).toBe(false);
    expect(r.text).toContain("Episode count reset from 12 to 0 for the rewatch");
    expect(fake.entries.get(130003)!.progress).toBe(0);
    expect(fake.entries.get(130003)!.completedAt).toEqual(EARLIER);

    r = await call("mark_episodes_watched", { anime: "bocchi the rock" });
    expect(r.isError).toBe(false);
    expect(r.text).toContain("episode 0 -> 1");
    expect(fake.entries.get(130003)!.status).toBe("REPEATING");

    r = await call("set_progress", { anime: "bocchi the rock", episodes: 12 });
    expect(r.text).toContain("Status is now Completed (was Rewatching). Rewatch count is now 1.");
    const done = fake.entries.get(130003)!;
    expect(done).toMatchObject({ status: "COMPLETED", progress: 12, repeat: 1, startedAt: EARLIER, completedAt: EARLIER });
  });

  test("starting a rewatch and logging episodes in one update counts them from 0", async () => {
    fake.seed(PERSONA);
    const r = await call("update_shows", { updates: [{ anime: 130003, status: "REPEATING", watched: 2 }] });
    expect(r.isError).toBe(false);
    expect(r.text).toContain("Completed -> Rewatching");
    expect(r.text).not.toContain("Not changed");
    expect(fake.entries.get(130003)).toMatchObject({ status: "REPEATING", progress: 2 });
  });
});

describe("lowering progress on a completed show", () => {
  test("moves it back to watching and keeps its dates", async () => {
    fake.seed(PERSONA);
    const frieren = fake.entries.get(154587)!;
    frieren.startedAt = EARLIER;
    frieren.completedAt = EARLIER;
    const r = await call("set_progress", { anime: 154587, episodes: 5 });
    expect(r.text).toContain("episode 28 -> 5. Status is now Watching (was Completed).");
    expect(fake.entries.get(154587)).toMatchObject({ status: "CURRENT", progress: 5, startedAt: EARLIER, completedAt: EARLIER });
  });
});

describe("progress past what has aired", () => {
  test("is saved, with a note saying how many episodes have aired", async () => {
    await connect({ now: () => NOW });
    fake.seed(PERSONA);
    const r = await call("set_progress", { anime: "apothecary diaries", episodes: 11 });
    expect(r.isError).toBe(false);
    expect(fake.entries.get(195516)!.progress).toBe(11);
    expect(r.text).toContain("AniList says only 7 episodes have aired so far.");
  });

  test("says nothing when progress is within what has aired", async () => {
    await connect({ now: () => NOW });
    fake.seed(PERSONA);
    await call("set_progress", { anime: "apothecary diaries", episodes: 7 });
    const r = await call("set_progress", { anime: "apothecary diaries", episodes: 6 });
    expect(r.text).not.toContain("aired");
  });
});

test("progress on a show that hasn't premiered says so", async () => {
  await connect({ now: () => NOW });
  fake.seed(PERSONA);
  // Kusuriya no Hitorigoto: Bouhi no Hihou: episode 1 airs 2026-12-10.
  const r = await call("set_progress", { anime: 200929, episodes: 1 });
  expect(r.text).toContain("hasn't started airing yet");
});

test("progress on an unreleased show with no schedule yet says it hasn't aired", async () => {
  await connect({ now: () => NOW });
  // Bocchi the Rock! 2nd Season: not yet released, no airing schedule on AniList.
  const r = await call("set_progress", { anime: 186712, episodes: 1 });
  expect(r.isError).toBe(false);
  expect(fake.entries.get(186712)!.progress).toBe(1);
  expect(r.text).toContain("hasn't started airing yet");
});

describe("set_status COMPLETED on a show still airing", () => {
  test("notes how many episodes have aired", async () => {
    await connect({ now: () => NOW });
    const r = await call("set_status", { anime: 195516, status: "COMPLETED" });
    expect(r.isError).toBe(false);
    expect(fake.entries.get(195516)!.progress).toBe(12);
    expect(r.text).toContain("AniList says only 7 episodes have aired so far.");
  });

  test("notes a show that hasn't premiered, even with no episode count", async () => {
    await connect({ now: () => NOW });
    // Bocchi the Rock! 2nd Season: not yet released, episode count unknown.
    const r = await call("set_status", { anime: 186712, status: "COMPLETED" });
    expect(r.isError).toBe(false);
    expect(fake.entries.get(186712)).toMatchObject({ status: "COMPLETED", progress: 0 });
    expect(r.text).toContain("hasn't started airing yet");
  });

  test("says nothing for a finished show or another status", async () => {
    await connect({ now: () => NOW });
    let r = await call("set_status", { anime: 16498, status: "COMPLETED" });
    expect(r.text).not.toContain("AniList says");
    r = await call("set_status", { anime: 186712, status: "PLANNING" });
    expect(r.text).not.toContain("AniList says");
  });
});

describe("add_to_list as COMPLETED on a show still airing", () => {
  test("notes how many episodes have aired, as set_status does", async () => {
    await connect({ now: () => NOW });
    const r = await call("add_to_list", { anime: 195516, status: "COMPLETED" });
    expect(r.isError).toBe(false);
    expect(fake.entries.get(195516)!.progress).toBe(12);
    expect(r.text).toBe(
      `Added: [195516] The Apothecary Diaries Season 3 (TV, 2026): Completed, 12/12 episodes, unrated. Start date set to ${TODAY}, finish date set to ${TODAY}. Note: AniList says only 7 episodes have aired so far.`,
    );
  });

  test("notes a show that hasn't premiered", async () => {
    await connect({ now: () => NOW });
    const r = await call("add_to_list", { anime: 186712, status: "COMPLETED" });
    expect(r.text).toContain("hasn't started airing yet");
  });

  test("says nothing for a plain add", async () => {
    await connect({ now: () => NOW });
    const r = await call("add_to_list", { anime: 195516 });
    expect(r.text).toBe("Added: [195516] The Apothecary Diaries Season 3 (TV, 2026): Plan to watch, 0/12 episodes, unrated");
  });
});

test("set_status puts a full stop between the entry and what else changed", async () => {
  await connect({ now: () => NOW });
  const r = await call("set_status", { anime: 16498, status: "CURRENT" });
  expect(r.text).toBe(`not on list -> Watching: [16498] Attack on Titan (TV, 2013): Watching, 0/25 episodes, unrated. Start date set to ${TODAY}.`);
});

describe("parts without a season number", () => {
  test("a part that fits two seasons goes to the one the intent points at", async () => {
    fake.seed([...PERSONA.filter((e) => e.anime !== "Shingeki no Kyojin Season 3 Part 2"), { anime: "Shingeki no Kyojin Season 3 Part 2", status: "CURRENT", progress: 2 }]);
    const r = await call("mark_episodes_watched", { anime: "attack on titan part 2" });
    expect(r.isError).toBe(false);
    expect(fake.entries.get(104578)!.progress).toBe(3);
  });

  test("set_status finds The Final Season Part 2", async () => {
    fake.seed(PERSONA);
    const r = await call("set_status", { anime: "attack on titan final season part 2", status: "PLANNING" });
    expect(r.isError).toBe(false);
    expect(fake.entries.get(131681)!.status).toBe("PLANNING");
  });
});

describe('set_progress "latest" (caught up)', () => {
  /** The fixture's airing schedule was captured on this day. */
  const NOW = Date.parse("2026-11-17T12:00:00Z");

  async function connect(list = PERSONA) {
    fake = new FakeAniList("POINT_10_DECIMAL").seed(list);
    const server = createServer(new AniListClient("t", fake.fetch), { now: () => NOW });
    const [a, b] = InMemoryTransport.createLinkedPair();
    client = new Client({ name: "t", version: "0" });
    await Promise.all([server.connect(b), client.connect(a)]);
  }

  test("a finished show completes at its last episode", async () => {
    await connect();
    const r = await call("set_progress", { anime: "dandadan", episodes: "latest" });
    expect(r.isError).toBe(false);
    expect(r.text).toContain("episode 7 -> 12. Status is now Completed (was Watching). That's every episode.");
    expect(fake.entries.get(171018)).toMatchObject({ progress: 12, status: "COMPLETED" });
  });

  test("an airing show goes to the latest aired episode and keeps watching", async () => {
    await connect();
    const r = await call("set_progress", { anime: "one piece", episodes: "latest" });
    expect(r.isError).toBe(false);
    expect(r.text).toContain("episode 1100 -> 1180. Latest aired episode: 1180.");
    expect(fake.entries.get(21)).toMatchObject({ progress: 1180, status: "CURRENT" });
  });

  test("a paused show still airing moves to watching", async () => {
    await connect([{ anime: "Kusuriya no Hitorigoto 3rd Season", status: "PAUSED", progress: 5 }]);
    const r = await call("set_progress", { anime: 195516, episodes: "latest" });
    expect(r.text).toContain("episode 5 -> 7. Status is now Watching (was Paused). Latest aired episode: 7 of 12.");
    expect(fake.entries.get(195516)).toMatchObject({ progress: 7, status: "CURRENT" });
  });

  test("never lowers progress when AniList's schedule lags", async () => {
    await connect([{ anime: "Kusuriya no Hitorigoto 3rd Season", status: "CURRENT", progress: 8 }]);
    const r = await call("set_progress", { anime: 195516, episodes: "latest" });
    expect(r.text).toContain("episode 8 -> 8. AniList says only 7 episodes have aired, so progress stays at 8.");
    expect(fake.entries.get(195516)!.progress).toBe(8);
  });

  test("an airing show with no schedule changes nothing and asks for a number", async () => {
    await connect();
    const onePiece = catalog.find((m) => m.id === 21)!;
    const schedule = onePiece.nextAiringEpisode;
    onePiece.nextAiringEpisode = null;
    try {
      const before = fake.writes.length;
      const r = await call("set_progress", { anime: "one piece", episodes: "latest" });
      expect(r.isError).toBe(true);
      expect(r.text).toContain(
        'Nothing was changed. Matched "one piece" to ONE PIECE: you\'re watching it.\nAniList doesn\'t say how many episodes of ONE PIECE are out',
      );
      expect(r.text).toContain("Ask the user which episode they're on");
      expect(fake.writes.length).toBe(before);
      expect(fake.entries.get(21)!.progress).toBe(1100);
    } finally {
      onePiece.nextAiringEpisode = schedule;
    }
  });
});

describe("list cache (R5.4)", () => {
  let clock: number;
  let c: Client;

  const kinds = (calls: FakeAniList["calls"]) =>
    calls.map((x) =>
      x.query.includes("MediaListCollection")
        ? "list"
        : x.query.includes("Viewer")
          ? "viewer"
          : /^\s*mutation/.test(x.query)
            ? "write"
            : "other",
    );

  /** Calls a tool and returns its text with the kinds of AniList requests it made. */
  async function run(name: string, args: Record<string, unknown>) {
    const start = fake.calls.length;
    const r = (await c.callTool({ name, arguments: args })) as { content: { text: string }[]; isError?: boolean };
    return { text: r.content.map((x) => x.text).join("\n"), isError: Boolean(r.isError), requests: kinds(fake.calls.slice(start)) };
  }

  beforeEach(async () => {
    clock = Date.parse("2026-11-17T12:00:00Z");
    fake.seed(PERSONA);
    const anilist = new AniListClient("t", fake.fetch);
    anilist.sleep = async () => {};
    const server = createServer(anilist, { now: () => clock });
    const [ct, st] = InMemoryTransport.createLinkedPair();
    c = new Client({ name: "t", version: "0" });
    await Promise.all([server.connect(st), c.connect(ct)]);
  });

  test("two progress updates in a row fetch the list once and count from the first", async () => {
    let r = await run("mark_episodes_watched", { anime: "jjk" });
    expect(r.text).toContain("episode 3 -> 4");
    expect(r.requests.filter((k) => k !== "viewer")).toEqual(["list", "write"]);

    clock += 2_000;
    r = await run("mark_episodes_watched", { anime: "jjk" });
    expect(r.text).toContain("episode 4 -> 5");
    expect(r.requests).toEqual(["write"]);
    expect(fake.entries.get(145064)!.progress).toBe(5);
  });

  test("a write more than a few seconds after the list was fetched reads its show again first", async () => {
    await run("mark_episodes_watched", { anime: "jjk" });
    clock += 30_000;
    fake.entries.get(145064)!.progress = 6; // a scrobbler, in between
    const r = await run("mark_episodes_watched", { anime: "jjk" });
    expect(r.text).toContain("episode 6 -> 7");
    expect(r.requests).toEqual(["other", "write"]);
  });

  test("parallel progress updates to one show count every episode (#28)", async () => {
    const [a, b] = await Promise.all([
      run("mark_episodes_watched", { anime: "dandadan" }),
      run("mark_episodes_watched", { anime: "dandadan" }),
    ]);
    expect([a.text, b.text].map((t) => t.match(/episode \d+ -> \d+/)![0]).sort()).toEqual([
      "episode 7 -> 8",
      "episode 8 -> 9",
    ]);
    expect(fake.entries.get(171018)!.progress).toBe(9);
    expect(fake.writes.map((w) => w.variables.progress)).toEqual([8, 9]);
  });

  test("parallel progress updates by name and by ID serialize on the resolved show", async () => {
    await Promise.all([
      run("mark_episodes_watched", { anime: "dandadan", count: 2 }),
      run("mark_episodes_watched", { anime: 171018 }),
      run("mark_episodes_watched", { anime: "171018" }),
    ]);
    expect(fake.entries.get(171018)!.progress).toBe(11);
  });

  test("parallel progress updates to different shows both land", async () => {
    await Promise.all([
      run("mark_episodes_watched", { anime: "dandadan" }),
      run("mark_episodes_watched", { anime: "jjk" }),
    ]);
    expect(fake.entries.get(171018)!.progress).toBe(8);
    expect(fake.entries.get(145064)!.progress).toBe(4);
  });

  test("a status search after a write is served from the patched cache", async () => {
    await run("search_my_list", { status: "PAUSED" });
    let r = await run("set_status", { anime: "dandadan", status: "PAUSED" });
    expect(r.requests).toEqual(["write"]);

    r = await run("search_my_list", { status: "PAUSED" });
    expect(r.requests).toEqual([]);
    expect(r.text).toContain("2 matches");
    expect(r.text).toContain("[171018]");

    r = await run("search_my_list", { status: "CURRENT" });
    expect(r.requests).toEqual([]);
    expect(r.text).not.toContain("[171018]");
  });

  test("adding and removing a show patch the cache", async () => {
    await run("search_my_list", {});
    let r = await run("add_to_list", { anime: 9253 });
    expect(r.text).toContain("Added:");
    r = await run("search_my_list", { query: "steins gate" });
    expect(r.text).toContain("1 match");
    r = await run("search_my_list", {});
    expect(r.text).toContain(`${PERSONA.length + 1} matches`);

    r = await run("remove_from_list", { anime: "frieren" });
    expect(r.text).toContain("Not removed yet");
    r = await run("remove_from_list", { anime: "frieren", confirmed: true });
    expect(r.text).toContain("Removed Frieren");
    r = await run("search_my_list", { query: "frieren" });
    expect(r.text).toContain("Nothing on tester's list");
    expect(r.requests).toEqual([]);
    expect(kinds(fake.calls).filter((k) => k === "list")).toHaveLength(1);
  });

  test("changes made on anilist.co show up once the cache expires", async () => {
    await run("search_my_list", { query: "dandadan" });
    fake.entries.get(171018)!.progress = 9; // edited on the website

    let r = await run("search_my_list", { query: "dandadan" });
    expect(r.requests).toEqual([]);
    expect(r.text).toContain("7/12");

    clock += LIST_TTL_MS;
    r = await run("search_my_list", { query: "dandadan" });
    expect(r.requests).toEqual(["list"]);
    expect(r.text).toContain("9/12");
  });

  test("a failed write drops the cache", async () => {
    await run("search_my_list", {});
    fake.rateLimited = true;
    expect((await run("mark_episodes_watched", { anime: "dandadan" })).isError).toBe(true);
    fake.rateLimited = false;
    const r = await run("search_my_list", { query: "dandadan" });
    expect(r.requests).toEqual(["list"]);
  });

  /** A client whose save with `progress: 8` answers only once `release` is called. */
  function heldClient() {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const client = new AniListClient("t", async (url, init) => {
      const res = await fake.fetch(url, init);
      if (JSON.parse(init.body as string).variables.progress === 8) await gate;
      return res;
    });
    client.now = () => clock;
    return { client, release };
  }

  test("overlapping writes to one show drop the cache instead of patching it out of order", async () => {
    const { client, release } = heldClient();
    await client.getMyList();
    // The first save lands first but answers last, so its older entry would win a patch.
    const first = client.saveEntry({ mediaId: 171018, progress: 8 });
    await client.saveEntry({ mediaId: 171018, scoreRaw: 90 });
    release();
    await first;
    const before = fake.calls.length;
    const dandadan = (await client.getMyList()).find((e) => e.media.id === 171018)!;
    expect(kinds(fake.calls.slice(before))).toEqual(["list"]);
    expect([dandadan.progress, dandadan.score]).toEqual([8, 9]);
  });

  test("overlapping writes to different shows still patch the cache", async () => {
    const { client, release } = heldClient();
    await client.getMyList();
    const first = client.saveEntry({ mediaId: 171018, progress: 8 });
    await client.saveEntry({ mediaId: 21, scoreRaw: 90 });
    release();
    await first;
    const before = fake.calls.length;
    const list = await client.getMyList();
    expect(kinds(fake.calls.slice(before))).toEqual([]);
    expect(list.find((e) => e.media.id === 171018)!.progress).toBe(8);
    expect(list.find((e) => e.media.id === 21)!.score).toBe(9);
  });

  test("a write that answers after the list was refetched drops the cache", async () => {
    const { client, release } = heldClient();
    await client.getMyList();
    const save = client.saveEntry({ mediaId: 171018, progress: 8 });
    await Bun.sleep(0);
    fake.entries.get(171018)!.progress = 9; // another app, after our write landed
    clock += LIST_TTL_MS;
    await client.getMyList();
    release();
    await save;
    const dandadan = (await client.getMyList()).find((e) => e.media.id === 171018)!;
    expect(dandadan.progress).toBe(9);
  });
});

describe("search_anime filters", () => {
  const lines = (text: string) => text.split("\n").slice(1);

  test("a plain title search has no header and sorts by best match", async () => {
    const r = await call("search_anime", { query: "frieren" });
    expect(r.text).not.toContain("first:");
    expect(fake.calls.at(-1)!.variables).toMatchObject({ search: "frieren", sort: ["SEARCH_MATCH"], perPage: 5 });
  });

  test("browses a season and says which season it used", async () => {
    const r = await call("search_anime", { season: "FALL", year: 2026 });
    expect(r.isError).toBe(false);
    expect(r.text.split("\n")[0]).toBe("Fall 2026, most popular first:");
    expect(r.text).toContain("The Apothecary Diaries Season 3");
    expect(r.text).not.toContain("Frieren");
    expect(lines(r.text).every((l) => l.includes(", 2026)"))).toBe(true);
  });

  test("filters by genre and year, best rated first", async () => {
    const r = await call("search_anime", { genres: ["Romance"], year: 2025, sort: "score" });
    expect(r.text.split("\n")[0]).toBe("2025, Romance, highest rated first:");
    const rows = lines(r.text);
    expect(rows[0]).toContain("Chainsaw Man – The Movie: Reze Arc");
    expect(rows[0]).toContain("AniList score 90%");
    const scores = rows.map((l) => Number(/AniList score (\d+)%/.exec(l)![1]));
    expect(scores).toEqual([...scores].sort((a, b) => b - a));
    expect(r.text).toContain("DAN DA DAN Season 2");
    // Romance from other years, and 2025 shows without romance, stay out.
    expect(r.text).not.toContain("First Kiss");
    expect(r.text).not.toContain("SPY×FAMILY");
  });

  test("several genres must all match, like AniList's genre_in", async () => {
    const r = await call("search_anime", { genres: ["Romance", "Horror"], limit: 25 });
    expect(r.text.split("\n")[0]).toBe("Romance and Horror, most popular first:");
    expect(r.text).toContain("Reze Arc");
    // Dandadan is romance without horror.
    expect(r.text).not.toContain("DAN DA DAN");
  });

  test("filters by format and airing status", async () => {
    const r = await call("search_anime", { formats: ["MOVIE"], airingStatus: "NOT_YET_RELEASED", limit: 25 });
    expect(r.text.split("\n")[0]).toBe("MOVIE, not yet aired, most popular first:");
    const rows = lines(r.text);
    expect(rows.length).toBeGreaterThan(2);
    expect(rows.every((l) => l.includes("(MOVIE"))).toBe(true);
    expect(r.text).not.toContain("Reze Arc");
  });

  test("flags results that continue a completed show, in two AniList requests", async () => {
    fake.seed(PERSONA);
    const before = fake.calls.length;
    const r = await call("search_anime", { season: "WINTER", year: 2026 });
    expect(fake.calls.length - before).toBe(2);
    const frieren = lines(r.text).find((l) => l.includes("Frieren: Beyond Journey’s End Season 2"))!;
    expect(frieren).toContain("Continues Frieren: Beyond Journey’s End, which you completed");
    // The prequel (JJK season 2) is still being watched, so this one isn't flagged.
    const jjk = lines(r.text).find((l) => l.includes("The Culling Game Part 1"))!;
    expect(jjk).not.toContain("Continues");
  });

  test("counts a prequel being rewatched as completed", async () => {
    fake.seed([{ anime: "Sousou no Frieren", status: "REPEATING" }]);
    const r = await call("search_anime", { query: "frieren 2nd season", limit: 1 });
    expect(r.text).toContain("Continues Frieren: Beyond Journey’s End, which you completed");
  });

  test("doesn't flag a continuation the user is already watching", async () => {
    fake.seed(PERSONA);
    const r = await call("search_anime", { query: "apothecary diaries season 3" });
    expect(r.text).toContain("Watching");
    expect(r.text).not.toContain("Continues");
  });

  test("asks for the year instead of guessing the season", async () => {
    const before = fake.calls.length;
    const r = await call("search_anime", { season: "WINTER" });
    expect(r.isError).toBe(true);
    expect(r.text).toContain("Pass `year` with `season`");
    expect(fake.calls.length).toBe(before);
  });

  test("needs a title or a filter", async () => {
    const r = await call("search_anime", {});
    expect(r.isError).toBe(true);
    expect(r.text).toContain("at least one filter");
  });
});

describe("adult titles (AniList's 18+ content setting)", () => {
  // A KITE (320) is the fixture's only adult title, and the only one matching "kite".
  const searches = () => fake.calls.filter((c) => c.query.includes("search:")).map((c) => c.variables.isAdult);

  test("search_anime leaves them out when the setting is off, and says so in one line", async () => {
    const r = await call("search_anime", { query: "kite" });
    expect(r.isError).toBe(false);
    expect(r.text).not.toContain("[320]");
    expect(r.text).toContain('Only adult (18+) titles match "kite"');
    expect(r.text.split("\n")).toHaveLength(1);
    expect(searches()).toEqual([false, true]);
  });

  test("search_anime includes them when the setting is on", async () => {
    fake.displayAdultContent = true;
    const r = await call("search_anime", { query: "kite" });
    expect(r.text).toContain("[320]");
    expect(r.text).not.toContain("hidden");
    expect(searches()).toEqual([undefined]);
  });

  test("a search that finds nothing at all still says nothing was found", async () => {
    const r = await call("search_anime", { query: "zzzz" });
    expect(r.text).toBe('No anime found for "zzzz".');
  });

  test("names don't resolve to them when the setting is off, and the error says why", async () => {
    const r = await call("add_to_list", { anime: "kite" });
    expect(r.isError).toBe(true);
    expect(r.text).toContain('Nothing was changed. Only adult (18+) titles match "kite"');
    expect(r.text).toContain("use the show's AniList ID");
    expect(fake.writes).toHaveLength(0);
  });

  test("turning the setting on after being told to takes effect without a restart", async () => {
    expect((await call("add_to_list", { anime: "kite" })).isError).toBe(true);
    fake.displayAdultContent = true;
    expect((await call("add_to_list", { anime: "kite" })).isError).toBe(false);
    expect(fake.entries.has(320)).toBe(true);
  });

  test("turning the setting off takes effect within minutes, without a restart", async () => {
    let clock = 0;
    const server = createServer(new AniListClient("t", fake.fetch), { now: () => clock });
    const [a, b] = InMemoryTransport.createLinkedPair();
    client = new Client({ name: "t", version: "0" });
    await Promise.all([server.connect(b), client.connect(a)]);

    fake.displayAdultContent = true;
    expect((await call("search_anime", { query: "kite" })).text).toContain("[320]");
    fake.displayAdultContent = false;
    clock += 5 * 60_000;
    const r = await call("search_anime", { query: "kite" });
    expect(r.text).not.toContain("[320]");
    expect(r.text).toContain("Only adult (18+) titles match");
  });

  test("a format mismatch isn't blamed on the setting", async () => {
    // A KITE is an OVA, so "kite movie" matches nothing, adult or not.
    const r = await call("add_to_list", { anime: "kite movie" });
    expect(r.text).toContain('Couldn\'t find "kite movie" on AniList.');
  });

  test("names resolve to them when the setting is on", async () => {
    fake.displayAdultContent = true;
    const r = await call("add_to_list", { anime: "kite" });
    expect(r.isError).toBe(false);
    expect(fake.entries.get(320)!.status).toBe("PLANNING");
  });

  test("a show already on the list resolves and displays whatever the setting", async () => {
    fake.seed([{ anime: 320, status: "CURRENT" }]);
    let r = await call("mark_episodes_watched", { anime: "a kite" });
    expect(r.isError).toBe(false);
    expect(fake.entries.get(320)!.progress).toBe(1);

    r = await call("search_anime", { query: "kite" });
    expect(r.text).toContain("[320]");
    expect(r.text).not.toContain("hidden");

    r = await call("search_my_list", { query: "kite" });
    expect(r.text).toContain("[320]");
  });

  test("an AniList ID works whatever the setting", async () => {
    const r = await call("add_to_list", { anime: 320 });
    expect(r.isError).toBe(false);
    expect(fake.entries.has(320)).toBe(true);
  });

  test("other misses keep the usual message", async () => {
    const r = await call("add_to_list", { anime: "zzzz" });
    expect(r.text).toContain('Couldn\'t find "zzzz" on AniList.');
  });
});


describe("whats_next on a long list", () => {
  // 45 finished shows being watched, each with episodes left: more than a report should list.
  const stub = (i: number) =>
    ({
      id: 960000 + i, title: { romaji: `Backlog Show ${i}`, english: null, native: null }, synonyms: [], episodes: 12 + i,
      duration: 24, format: "TV", status: "FINISHED", season: "SPRING", seasonYear: 2010, startDate: { year: 2010, month: 4, day: 1 },
      averageScore: 70, popularity: 1000, isAdult: false, siteUrl: "", nextAiringEpisode: null, relations: { edges: [] },
      franchise: `Backlog Show ${i}`,
    }) as unknown as CatalogMedia;
  const added = Array.from({ length: 45 }, (_, i) => stub(i));
  beforeEach(() => void catalog.push(...added));
  afterEach(() => void catalog.splice(catalog.length - added.length, added.length));

  async function report(args: Record<string, unknown>) {
    fake = new FakeAniList().seed(added.map((m) => ({ anime: m.id, status: "CURRENT" as const, progress: 1 })));
    await connect({ now: () => NOW });
    const r = await call("whats_next", args);
    expect(r.isError).toBe(false);
    return { ...r, requests: fake.calls.length };
  }

  test("lists the shows closest to done and says how to see the rest", async () => {
    const r = await report({});
    const lines = r.text.split("\n");
    expect(lines[0]).toBe("New episodes to watch:");
    expect(lines[1]).toBe("- Backlog Show 0: 11 episodes to watch, about 4.5 hours (on 1 of 12 aired).");
    expect(lines.filter((l) => l.startsWith("- "))).toHaveLength(8);
    expect(r.text).toContain("...and 37 more.");
    expect(r.text).not.toContain("Backlog Show 44");
    expect(r.text).toEndWith("Long sections are cut short: to list every show, call again with all: true.");
  });

  test("all: true lists every show, in the same requests", async () => {
    const cut = await report({});
    const all = await report({ all: true });
    expect(all.text.split("\n").filter((l) => l.startsWith("- "))).toHaveLength(45);
    expect(all.text).toContain("- Backlog Show 44: 55 episodes to watch");
    expect(all.text).not.toContain("more.");
    expect(all.text).not.toContain("all: true");
    expect(all.requests).toBe(cut.requests);
  });
});

test("whats_next lists next seasons most recently finished first, whatever order AniList answers in", async () => {
  fake = new FakeAniList().seed(PERSONA);
  const finishedOn = { "Mob Psycho 100 II": [2026, 10, 25], "Sousou no Frieren": [2026, 10, 5], "SPY×FAMILY Part 2": [2025, 6, 1] };
  for (const [title, [year, month, day]] of Object.entries(finishedOn)) {
    fake.entries.get(findMedia(title).id)!.completedAt = { year: year!, month: month!, day: day! };
  }
  // AniList answers id_in in an order of its own: here, the reverse of the request's.
  const original = fake.fetch;
  fake.fetch = async (url, init) => {
    const res = await original(url, init);
    if (!String(init.body).includes("id_in")) return res;
    const body = (await res.json()) as { data?: { Page?: { media: unknown[] } } };
    body.data?.Page?.media.reverse();
    return new Response(JSON.stringify(body), { status: res.status });
  };
  await connect({ now: () => NOW });
  const r = await call("whats_next", {});
  const next = r.text.split("\n\n").find((s) => s.startsWith("Next seasons"))!.split("\n").slice(1);
  expect(next.map((l) => l.split(":")[0])).toEqual(["- After Mob Psycho 100 II", "- After Frieren", "- After SPY x FAMILY Cour 2"]);
});

describe("the UTC note on the hosted server appears only with a time or day it applies to", () => {
  const NOTE = "Times and days are in UTC";
  beforeEach(async () => {
    fake = new FakeAniList().seed(PERSONA);
    await connect({ now: () => NOW, hosted: true });
  });

  test("one show: only when the next episode's air time is given", async () => {
    const finished = await call("whats_next", { anime: "jjk" });
    expect(finished.text).not.toContain(" airs ");
    expect(finished.text).not.toContain(NOTE);
    const airing = await call("whats_next", { anime: "apothecary diaries" });
    expect(airing.text).toContain("Next: episode 8 airs Fri, Nov 20 at 2:00 PM UTC (in 3 days).");
    expect(airing.text).toContain(NOTE);
  });

  test("the whole list: only when a listed show has an air time", async () => {
    expect((await call("whats_next", {})).text).toContain(NOTE);
    fake = new FakeAniList().seed([{ anime: "Dandadan", status: "CURRENT", progress: 7 }]);
    await connect({ now: () => NOW, hosted: true });
    const r = await call("whats_next", {});
    expect(r.text).toBe("New episodes to watch:\n- DAN DA DAN: 5 episodes to watch, about 2 hours (on 7 of 12 aired).");
  });

  test("watch_history: not for an all-time answer with nothing dated in it", async () => {
    const empty = await call("watch_history", { anime: 145064 });
    expect(empty.text).toContain("No list activity for JUJUTSU KAISEN Season 2 found (all time, UTC)");
    expect(empty.text).not.toContain(NOTE);
    fake.seedActivity(HISTORY);
    const dated = await call("watch_history", { anime: 145064 });
    expect(dated.text).toContain("Thu, Nov 12\n- 8:30 PM JUJUTSU KAISEN Season 2: watched episode 3");
    expect(dated.text).toContain(NOTE);
  });

  test("watch_history: always for a range of days, which were read in UTC", async () => {
    const r = await call("watch_history", { period: "this week" });
    expect(r.text).toContain("No list activity found");
    expect(r.text).toContain(NOTE);
  });

  test("watch_history finished: list finish dates are the user's own days and need no note", async () => {
    const r = await call("watch_history", { period: "all time", finished: true });
    expect(r.text).toContain("No finished shows found");
    expect(r.text).not.toContain(NOTE);
    fake.seedActivity(HISTORY);
    const fromFeed = await call("watch_history", { period: "all time", finished: true });
    expect(fromFeed.text).toContain("Frieren");
    expect(fromFeed.text).toContain(NOTE);
  });

  test("watch_history finished: no note when the feed's finish disagrees with a corrected date on the list", async () => {
    fake.entries.get(findMedia("Sousou no Frieren").id)!.completedAt = { year: 2026, month: 10, day: 20 };
    fake.seedActivity([{ anime: "Sousou no Frieren", status: "completed", at: "2026-10-05T20:00:00Z" }]);
    const r = await call("watch_history", { period: "all time", finished: true });
    expect(r.text).toContain("- Tue, Oct 20: Frieren");
    expect(r.text).not.toContain(NOTE);
  });
});
