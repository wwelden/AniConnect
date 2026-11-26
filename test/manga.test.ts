import { beforeEach, describe, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { AniListClient } from "../src/anilist";
import { formatDate, todayFuzzy } from "../src/logic";
import { createServer } from "../src/server";
import { PERSONA } from "./fixtures/persona";
import { FakeAniList } from "./support/fake-anilist";

const NOW = Date.UTC(2026, 10, 17, 12);
const TODAY = formatDate(todayFuzzy(new Date(NOW)));

/** Manga in test/fixtures/manga.json. */
const CSM_MANGA = 105778;
const CSM_ANIME = 127230;
const FRIEREN_MANGA = 118586;
const FRIEREN_ANIME = 154587;
const VAGABOND = 30656;
const PUNPUN = 34632;
const BERSERK = 30002;

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
  fake = new FakeAniList("POINT_10_DECIMAL").seed([
    ...PERSONA,
    { anime: CSM_MANGA, status: "CURRENT", progress: 70, progressVolumes: 8 },
    { anime: FRIEREN_MANGA, status: "CURRENT", progress: 120 },
    { anime: "Vagabond", status: "PAUSED", progress: 300 },
    { anime: "Oyasumi Punpun", status: "PLANNING" },
  ]);
  fake.clock = () => NOW;
  const server = createServer(new AniListClient("test-token", fake.fetch), { now: () => NOW });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  client = new Client({ name: "test", version: "0" });
  await Promise.all([server.connect(st), client.connect(ct)]);
});

describe("manga progress", () => {
  test("chapters mean the manga, without a type", async () => {
    const r = await call("set_progress", { anime: "chainsaw man", chapters: 74 });
    expect(r.isError).toBe(false);
    expect(r.text).toBe(
      'Matched "chainsaw man" to Chainsaw Man: you\'re reading it.\n' +
        "Chainsaw Man: chapter 70 -> 74.\n" +
        "[105778] Chainsaw Man (MANGA, 2018): Reading, 74/232 chapters, volume 8/24, unrated",
    );
    expect(fake.entries.get(CSM_MANGA)!.progress).toBe(74);
    expect(fake.entries.has(CSM_ANIME)).toBe(false);
  });

  test("type manga counts chapters read, and the anime of the same name is left alone", async () => {
    const r = await call("mark_episodes_watched", { anime: "frieren", type: "manga", count: 2 });
    expect(r.isError).toBe(false);
    expect(r.text).toContain("chapter 120 -> 122.");
    expect(fake.entries.get(FRIEREN_MANGA)!.progress).toBe(122);
    expect(fake.entries.get(FRIEREN_ANIME)!.progress).toBe(28);
  });

  test("the last chapter completes the manga, with its dates", async () => {
    const r = await call("set_progress", { anime: "punpun", chapters: 147 });
    expect(r.text).toContain(
      `Goodnight Punpun: chapter 0 -> 147. Status is now Completed (was Plan to read). Start date set to ${TODAY}, finish date set to ${TODAY}.`,
    );
    expect(fake.entries.get(PUNPUN)).toMatchObject({ status: "COMPLETED", progress: 147 });
  });

  test("completing a manga reads every chapter and volume", async () => {
    const r = await call("set_status", { anime: "punpun", type: "manga", status: "COMPLETED" });
    expect(r.text).toContain("Plan to read -> Completed: [34632] Goodnight Punpun (MANGA, 2007): Completed, 147/147 chapters, volume 13/13");
    expect(fake.entries.get(PUNPUN)).toMatchObject({ status: "COMPLETED", progress: 147, progressVolumes: 13 });
  });

  test("volumes on their own move a planned manga to reading", async () => {
    const r = await call("set_progress", { anime: "punpun", volumes: 3 });
    expect(r.text).toContain(`Goodnight Punpun: volume 0 -> 3. Status is now Reading (was Plan to read). Start date set to ${TODAY}.`);
    expect(fake.entries.get(PUNPUN)).toMatchObject({ status: "CURRENT", progress: 0, progressVolumes: 3 });
  });

  test("a chapter past the last is refused", async () => {
    const r = await call("set_progress", { anime: "punpun", chapters: 200 });
    expect(r.isError).toBe(true);
    expect(r.text).toContain("Goodnight Punpun has 147 chapters, so 200 is past the last one.");
    expect(fake.writes).toHaveLength(0);
  });

  test('"latest" needs a chapter count, which AniList has only once a manga has finished', async () => {
    const r = await call("set_progress", { anime: "vagabond", chapters: "latest" });
    expect(r.isError).toBe(true);
    expect(r.text).toContain("AniList doesn't count the chapters of Vagabond until it has finished");
    const done = await call("set_progress", { anime: "chainsaw man", chapters: "latest" });
    expect(done.text).toContain("chapter 70 -> 232. Status is now Completed (was Reading).");
  });

  test("units and types that disagree are refused before anything is looked up", async () => {
    const before = fake.calls.length;
    expect((await call("set_progress", { anime: "frieren", type: "manga", episodes: 3 })).text).toContain(
      "A manga counts chapters: pass chapters",
    );
    expect((await call("set_progress", { anime: "frieren", type: "anime", chapters: 3 })).text).toContain(
      "An anime has episodes, not chapters or volumes",
    );
    expect((await call("set_progress", { anime: "frieren", episodes: 3, chapters: 3 })).text).toContain("not both");
    expect((await call("set_progress", { anime: "frieren" })).text).toContain("Pass episodes (for an anime), or chapters or volumes");
    expect(fake.calls.length).toBe(before);
  });

  test("an ID says by itself which it is, and chapters on an anime's ID are refused", async () => {
    const manga = await call("set_progress", { anime: CSM_MANGA, chapters: 75 });
    expect(manga.text).toContain("Chainsaw Man: chapter 70 -> 75.");
    const anime = await call("set_progress", { anime: CSM_ANIME, chapters: 75 });
    expect(anime.isError).toBe(true);
    expect(anime.text).toBe(
      'Nothing was changed. Chainsaw Man [127230] is an anime, not a manga. Pass its name with type "manga" for the manga, or the anime\'s units (episodes).',
    );
  });

  test("episodes mean an anime: a manga's ID with episodes is refused, not saved as chapters", async () => {
    const r = await call("set_progress", { anime: CSM_MANGA, episodes: 8 });
    expect(r.isError).toBe(true);
    expect(r.text).toContain("Chainsaw Man [105778] is a manga, not an anime.");
    const batch = await call("update_shows", { updates: [{ anime: CSM_MANGA, episodes: 8 }] });
    expect(batch.text).toContain("Not changed: ID 105778: Chainsaw Man [105778] is a manga, not an anime.");
    expect(fake.entries.get(CSM_MANGA)!.progress).toBe(70);
  });

  test("episodes skip the manga list: a show only read so far gets its anime", async () => {
    const r = await call("set_progress", { anime: "chainsaw man", episodes: 2 });
    expect(r.text).toContain("Chainsaw Man: episode 0 -> 2.");
    expect(fake.entries.get(CSM_ANIME)!.progress).toBe(2);
    expect(fake.entries.get(CSM_MANGA)!.progress).toBe(70);
  });
});

describe("a name with no type", () => {
  test("means the anime when it's on the anime list", async () => {
    const r = await call("rate_anime", { anime: "frieren", score: 10 });
    expect(r.text).toContain("Rated Frieren: Beyond Journey’s End: 10/10");
    expect(fake.entries.get(FRIEREN_ANIME)!.scoreRaw).toBe(100);
    expect(fake.entries.get(FRIEREN_MANGA)!.scoreRaw).toBe(0);
  });

  test("on the manga list and matching an anime off the list asks which", async () => {
    const r = await call("rate_anime", { anime: "chainsaw man", score: 9 });
    expect(r.isError).toBe(true);
    expect(r.text).toContain('"chainsaw man" is on your manga list, and the anime it matches isn\'t on your anime list.');
    expect(r.text).toContain("[127230] Chainsaw Man (TV, 2022), not on your list");
    expect(r.text).toContain("[105778] Chainsaw Man (MANGA, 2018), on your list: current");
    expect(fake.writes).toHaveLength(0);
  });

  test("several anime off the list and a manga on it: all are offered", async () => {
    fake.seed([{ anime: 30026, status: "CURRENT", progress: 390 }]); // HUNTER×HUNTER (manga)
    const r = await call("rate_anime", { anime: "hunter x hunter", score: 10 });
    expect(r.isError).toBe(true);
    expect(r.text).toContain('"hunter x hunter" is on your manga list, and the anime it matches isn\'t on your anime list.');
    expect(r.text).toContain("[30026] Hunter x Hunter (HUNTER×HUNTER) (MANGA, 1998), on your list: current");
    expect(r.text.match(/\(TV, (1999|2011)\)/g)).toHaveLength(2);
    expect(fake.writes).toHaveLength(0);
  });

  test("removing by a name only the manga list has says the anime list had no match", async () => {
    const r = await call("remove_from_list", { anime: "chainsaw man" });
    expect(r.text).toStartWith('Matched "chainsaw man" to Chainsaw Man, a manga on your list: no anime on your list matches.\nNot removed yet.');
    expect(fake.entries.has(CSM_MANGA)).toBe(true);
  });

  test("type anime skips the manga list", async () => {
    const r = await call("rate_anime", { anime: "chainsaw man", type: "anime", score: 9 });
    expect(r.text).toContain("Added Chainsaw Man to your list");
    expect(fake.entries.get(CSM_ANIME)!.scoreRaw).toBe(90);
    expect(fake.calls.some((c) => c.variables.type === "MANGA")).toBe(false);
  });

  test("only a manga matches: the manga, saying so", async () => {
    const r = await call("set_status", { anime: "vagabond", status: "CURRENT" });
    expect(r.isError).toBe(false);
    expect(r.text).toBe(
      'Matched "vagabond" to Vagabond, a manga on your list: no anime matched.\n' +
        `Paused -> Reading: [30656] Vagabond (MANGA, 1998): Reading, 300/? chapters, unrated. Start date set to ${TODAY}.`,
    );
    expect(fake.entries.get(VAGABOND)!.status).toBe("CURRENT");
  });

  test("adding still means the anime", async () => {
    const r = await call("add_to_list", { anime: "chainsaw man" });
    expect(r.text).toContain("[127230] Chainsaw Man (TV, 2022): Plan to watch");
  });

  test("a manga not on the list is added by type", async () => {
    const r = await call("add_to_list", { anime: "berserk", type: "manga" });
    expect(r.text).toBe(
      'Matched "berserk" to Berserk: it\'s not on your list yet.\nAdded: [30002] Berserk (MANGA, 1989): Plan to read, 0/? chapters, unrated',
    );
    expect(fake.entries.get(BERSERK)!.status).toBe("PLANNING");
  });
});

describe("update_shows with manga", () => {
  test("anime and manga in one call", async () => {
    const r = await call("update_shows", {
      updates: [
        { anime: "chainsaw man", chapters: 80, volumes: 9, score: 8 },
        { anime: "dandadan", episodes: 8 },
      ],
    });
    expect(r.isError).toBe(false);
    expect(r.text).toContain("Chainsaw Man: chapter 70 -> 80, volume 8 -> 9, score unrated -> 8/10.");
    expect(r.text).toContain("DAN DA DAN: episode 7 -> 8.");
    expect(fake.entries.get(CSM_MANGA)).toMatchObject({ progress: 80, progressVolumes: 9, scoreRaw: 80 });
  });

  test("a manga's chapters read since last time", async () => {
    const r = await call("update_shows", { updates: [{ anime: "frieren", type: "manga", watched: 3 }] });
    expect(r.text).toContain("chapter 120 -> 123.");
  });

  test("an item whose units disagree with its show fails alone", async () => {
    const r = await call("update_shows", {
      updates: [
        { anime: CSM_ANIME, chapters: 3 },
        { anime: "dandadan", episodes: 8 },
      ],
    });
    expect(r.text).toContain("Not changed: ID 127230: Chainsaw Man [127230] is an anime, not a manga.");
    expect(r.text).toContain("DAN DA DAN: episode 7 -> 8.");
  });

  test("a name only on the manga list is the manga, as with the other tools", async () => {
    const r = await call("update_shows", { updates: [{ anime: "vagabond", status: "CURRENT" }, { anime: "chainsaw man", score: 9 }] });
    expect(r.text).toContain('Matched "vagabond" to Vagabond, a manga on your list: no anime matched.');
    expect(r.text).toContain('Not changed: "chainsaw man": "chainsaw man" is on your manga list, and the anime it matches isn\'t on your anime list.');
    expect(fake.entries.get(VAGABOND)!.status).toBe("CURRENT");
    expect(fake.entries.has(CSM_ANIME)).toBe(false);
  });

  test("a reread started in a batch resets the volumes too, as set_status does", async () => {
    await call("set_status", { anime: "punpun", status: "COMPLETED" });
    const r = await call("update_shows", { updates: [{ anime: "punpun", status: "REPEATING" }] });
    expect(r.text).toContain("Completed -> Rereading, chapter 147 -> 0, volume 13 -> 0.");
    expect(fake.entries.get(PUNPUN)).toMatchObject({ status: "REPEATING", progress: 0, progressVolumes: 0 });
  });

  test("a reread from a given chapter starts the volumes over, and volumes given are kept", async () => {
    await call("set_status", { anime: "punpun", status: "COMPLETED" });
    await call("update_shows", { updates: [{ anime: "punpun", status: "REPEATING", chapters: 3 }] });
    expect(fake.entries.get(PUNPUN)).toMatchObject({ status: "REPEATING", progress: 3, progressVolumes: 0 });
    await call("undo");
    await call("update_shows", { updates: [{ anime: "punpun", status: "REPEATING", chapters: 3, volumes: 1 }] });
    expect(fake.entries.get(PUNPUN)).toMatchObject({ status: "REPEATING", progress: 3, progressVolumes: 1 });
  });

  test("an anime link to a manga's ID is refused in a batch, as alone", async () => {
    const r = await call("update_shows", { updates: [{ anime: "https://anilist.co/anime/105778", score: 9 }] });
    expect(r.text).toContain("Chainsaw Man [105778] is a manga, not an anime.");
    expect(fake.entries.get(CSM_MANGA)!.scoreRaw).toBe(0);
  });

  test("a dry run says what a manga update would change", async () => {
    const r = await call("update_shows", { updates: [{ anime: "punpun", chapters: 10 }], dryRun: true });
    expect(r.text).toContain("Goodnight Punpun: Plan to read -> Reading, chapter 0 -> 10.");
    expect(fake.writes).toHaveLength(0);
  });
});

describe("the manga list", () => {
  test("search_my_list reads it with type manga", async () => {
    const r = await call("search_my_list", { type: "manga", status: "CURRENT" });
    expect(r.text).toBe(
      "2 matches on tester's manga list for Reading:\n" +
        "[105778] Chainsaw Man (MANGA, 2018): Reading, 70/232 chapters, volume 8/24, unrated\n" +
        "[118586] Frieren: Beyond Journey’s End (MANGA, 2020): Reading, 120/? chapters, unrated",
    );
  });

  test("the anime list leaves the manga out", async () => {
    const r = await call("search_my_list", { query: "chainsaw" });
    expect(r.text).toBe("Nothing on tester's list matching \"chainsaw\".");
  });

  test("undo puts back a manga's chapters and volumes", async () => {
    await call("set_progress", { anime: "chainsaw man", chapters: 90, volumes: 10 });
    const r = await call("undo");
    expect(r.text).toContain("Restored: [105778] Chainsaw Man (MANGA, 2018): Reading, 70/232 chapters, volume 8/24, unrated");
    expect(fake.entries.get(CSM_MANGA)).toMatchObject({ progress: 70, progressVolumes: 8 });
  });

  test("a write to a manga keeps the cached anime list", async () => {
    await call("search_my_list", {});
    await call("set_progress", { anime: "chainsaw man", chapters: 71 });
    const before = fake.calls.length;
    await call("search_my_list", {});
    expect(fake.calls.length).toBe(before);
  });

  test("anime-only tools refuse a manga's ID", async () => {
    const r = await call("whats_next", { anime: CSM_MANGA });
    expect(r.isError).toBe(true);
    expect(r.text).toBe("Chainsaw Man is a manga, and whats_next covers anime only.");
  });

  test("search_my_list sorts the manga list by chapters for length", async () => {
    const r = await call("search_my_list", { type: "manga", sort: "length" });
    expect(r.text.split("\n").slice(1)).toEqual([
      "[34632] Goodnight Punpun (MANGA, 2007): Plan to read, 0/147 chapters, unrated, 147 chapters",
      "[105778] Chainsaw Man (MANGA, 2018): Reading, 70/232 chapters, volume 8/24, unrated, 232 chapters",
      "[118586] Frieren: Beyond Journey’s End (MANGA, 2020): Reading, 120/? chapters, unrated, length unknown",
      "[30656] Vagabond (MANGA, 1998): Paused, 300/? chapters, unrated, length unknown",
    ]);
  });

  test("search_my_list filters the manga list by a manga format", async () => {
    const r = await call("search_my_list", { type: "manga", formats: ["NOVEL"] });
    expect(r.text).toBe("Nothing on tester's manga list matching NOVEL.");
  });
});

describe("removing and undoing manga", () => {
  test("remove_from_list shows the manga, then removes it on confirmation", async () => {
    const first = await call("remove_from_list", { anime: "vagabond", type: "manga" });
    expect(first.text).toContain("Not removed yet. Vagabond (MANGA, 1998): Paused, 300/? chapters, unrated");
    expect(fake.entries.has(VAGABOND)).toBe(true);
    const second = await call("remove_from_list", { anime: "vagabond", type: "manga", confirmed: true });
    expect(second.text).toEndWith("Removed Vagabond from your list.");
    expect(fake.entries.has(VAGABOND)).toBe(false);
    // The manga list cached before the removal no longer has it.
    expect((await call("search_my_list", { type: "manga", query: "vagabond" })).text).toBe(
      'Nothing on tester\'s manga list matching "vagabond".',
    );
  });

  test("undo brings back a removed manga, and takes back a manga just added", async () => {
    await call("remove_from_list", { anime: "vagabond", type: "manga" });
    await call("remove_from_list", { anime: "vagabond", type: "manga", confirmed: true });
    expect((await call("undo")).text).toContain("Put back on your list: [30656] Vagabond (MANGA, 1998): Paused, 300/? chapters");
    expect(fake.entries.get(VAGABOND)).toMatchObject({ status: "PAUSED", progress: 300 });

    await call("add_to_list", { anime: "berserk", type: "manga" });
    expect((await call("undo")).text).toContain("Berserk: removed from your list again.");
    expect(fake.entries.has(BERSERK)).toBe(false);
  });

  test("a reread starts the chapters and volumes over", async () => {
    await call("set_status", { anime: "punpun", status: "COMPLETED" });
    const r = await call("set_status", { anime: "punpun", status: "REPEATING" });
    expect(r.text).toContain("Completed -> Rereading: [34632] Goodnight Punpun (MANGA, 2007): Rereading, 0/147 chapters, unrated");
    expect(r.text).toContain("Chapter count reset from 147 to 0 for the reread.");
    expect(fake.entries.get(PUNPUN)).toMatchObject({ status: "REPEATING", progress: 0, progressVolumes: 0 });
  });
});

describe("manga links and IDs in update_shows", () => {
  test("a manga link is the manga, fetched by ID", async () => {
    const r = await call("update_shows", { updates: [{ anime: "https://anilist.co/manga/34632/Oyasumi-Punpun", chapters: 12 }] });
    expect(r.text).toContain("Goodnight Punpun: Plan to read -> Reading, chapter 0 -> 12.");
  });

  test("a manga link with type anime is refused, and the rest still saved", async () => {
    const r = await call("update_shows", {
      updates: [
        { anime: "https://anilist.co/manga/34632", type: "anime", status: "CURRENT" },
        { anime: "dandadan", episodes: 8 },
      ],
    });
    expect(r.text).toContain("Not changed: \"https://anilist.co/manga/34632\": That's a manga link, and the call asked for an anime.");
    expect(r.text).toContain("DAN DA DAN: episode 7 -> 8.");
    expect(fake.entries.get(PUNPUN)!.status).toBe("PLANNING");
  });

  test("addOnly adds a manga by type and leaves a listed one alone", async () => {
    const r = await call("update_shows", {
      addOnly: true,
      updates: [
        { anime: "berserk", type: "manga" },
        { anime: "vagabond", type: "manga" },
      ],
    });
    expect(r.text).toContain("[30002] Berserk (MANGA, 1989)");
    expect(r.text).toContain("Already on your list, unchanged: [30656] Vagabond (MANGA, 1998): Paused");
    expect(fake.entries.get(BERSERK)!.status).toBe("PLANNING");
    expect(fake.entries.get(VAGABOND)!.status).toBe("PAUSED");
  });
});
