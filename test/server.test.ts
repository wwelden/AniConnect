import { beforeEach, describe, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { AniListClient, LIST_TTL_MS } from "../src/anilist";
import { createServer } from "../src/server";
import { PERSONA } from "./fixtures/persona";
import { catalog, FakeAniList } from "./support/fake-anilist";

let fake: FakeAniList;
let client: Client;

async function call(name: string, args: Record<string, unknown>) {
  const result = (await client.callTool({ name, arguments: args })) as {
    content: { text: string }[];
    isError?: boolean;
  };
  return { text: result.content.map((c) => c.text).join("\n"), isError: Boolean(result.isError) };
}

beforeEach(async () => {
  fake = new FakeAniList("POINT_5");
  const server = createServer(new AniListClient("test-token", fake.fetch));
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  client = new Client({ name: "test", version: "0" });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
});

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
      "whats_next",
    ]);
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
    await call("add_to_list", { anime: 16498 });
    await call("add_to_list", { anime: 21, status: "CURRENT" });

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

  test("rate_anime sends a raw score and reports it in the user's format", async () => {
    const r = await call("rate_anime", { anime: 16498, score: 8 });
    expect(fake.calls.at(-1)!.variables.scoreRaw).toBe(80);
    expect(r.text).toBe("Rated Attack on Titan: 4 stars (of 5)");
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
    expect(r.text).toContain("only has 25 episodes");
    expect(fake.entries.get(16498)!.progress).toBe(24);
  });

  test("set_status COMPLETED fills in all episodes", async () => {
    await call("set_status", { anime: 16498, status: "COMPLETED" });
    expect(fake.entries.get(16498)!.progress).toBe(25);
  });

  test("remove_from_list deletes the entry", async () => {
    await call("add_to_list", { anime: 16498 });
    let r = await call("remove_from_list", { anime: 16498 });
    expect(r.text).toContain("Removed Attack on Titan");
    expect(fake.entries.has(16498)).toBe(false);
    r = await call("remove_from_list", { anime: 16498 });
    expect(r.text).toContain("isn't on your list");
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

  test("rate limits surface the retry delay", async () => {
    fake.rateLimited = true;
    const r = await call("search_anime", { query: "titan" });
    expect(r.isError).toBe(true);
    expect(r.text).toContain("Try again in 30 seconds");
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
    expect(r.text).toContain("episode 7 -> 12. Status is now Completed. That's every episode.");
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
    expect(r.text).toContain("episode 5 -> 7. Status is now Watching. Latest aired episode: 7 of 12.");
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
      expect(r.text).toContain("Nothing was changed. AniList doesn't say how many episodes of ONE PIECE are out");
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
    const server = createServer(new AniListClient("t", fake.fetch), { now: () => clock });
    const [ct, st] = InMemoryTransport.createLinkedPair();
    c = new Client({ name: "t", version: "0" });
    await Promise.all([server.connect(st), c.connect(ct)]);
  });

  test("two progress updates in a row fetch the list once and count from the first", async () => {
    let r = await run("mark_episodes_watched", { anime: "jjk" });
    expect(r.text).toContain("episode 3 -> 4");
    expect(r.requests.filter((k) => k !== "viewer")).toEqual(["list", "write"]);

    clock += 30_000;
    r = await run("mark_episodes_watched", { anime: "jjk" });
    expect(r.text).toContain("episode 4 -> 5");
    expect(r.requests).toEqual(["write"]);
    expect(fake.entries.get(145064)!.progress).toBe(5);
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

  test("a plain title search keeps its old shape and sorts by best match", async () => {
    const r = await call("search_anime", { query: "frieren" });
    expect(r.text).not.toContain("first:");
    expect(r.text).not.toContain("AniList score");
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
