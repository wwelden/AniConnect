import { beforeEach, describe, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { AniListClient } from "../src/anilist";
import { createServer } from "../src/server";
import { PERSONA } from "./fixtures/persona";
import { FakeAniList } from "./support/fake-anilist";

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
    expect(fake.calls.find((c) => c.query.includes("Viewer"))!.query).toContain("options { titleLanguage }");
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
