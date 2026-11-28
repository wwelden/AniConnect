/** AniList favorites: set_favorite, search_my_list with `favorites`, and undo of both. */
import { beforeEach, describe, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { AniListClient } from "../src/anilist";
import { createServer } from "../src/server";
import { MANGA_PERSONA, PERSONA } from "./fixtures/persona";
import { catalog, FakeAniList, findMedia } from "./support/fake-anilist";

const NOW = Date.UTC(2026, 10, 17, 12);
const FRIEREN = 154587;
const FRIEREN_MANGA = 118586;
const MOB = findMedia("Mob Psycho 100").id;
const VAGABOND = findMedia("Vagabond").id;

let fake: FakeAniList;
let client: Client;

async function call(name: string, args: Record<string, unknown> = {}) {
  const result = (await client.callTool({ name, arguments: args })) as { content: { text: string }[]; isError?: boolean };
  return { text: result.content.map((c) => c.text).join("\n"), isError: Boolean(result.isError) };
}

beforeEach(async () => {
  fake = new FakeAniList("POINT_10_DECIMAL").seed([...PERSONA, ...MANGA_PERSONA]).seedFavorites(["Mob Psycho 100"]);
  fake.clock = () => NOW;
  const anilist = new AniListClient("test-token", (u, i) => fake.fetch(u, i));
  anilist.sleep = async () => {};
  const server = createServer(anilist, { now: () => NOW });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  client = new Client({ name: "test", version: "0" });
  await Promise.all([server.connect(st), client.connect(ct)]);
});

const toggles = () => fake.writes.filter((w) => w.query.includes("ToggleFavourite"));
const entries = () => JSON.stringify([...fake.entries.values()]);

describe("set_favorite", () => {
  test("adds a show by name to the favorites, leaving its list entry alone", async () => {
    const before = entries();
    const r = await call("set_favorite", { anime: "frieren" });
    expect(r.isError).toBe(false);
    expect(r.text).toContain("Added Frieren: Beyond Journey’s End to your favorite anime on AniList.");
    expect(fake.favorites).toEqual([MOB, FRIEREN]);
    expect(entries()).toBe(before);
    expect(toggles()).toHaveLength(1);
    expect(toggles()[0]!.query).toContain("animeId");
    expect(toggles()[0]!.variables).toEqual({ id: FRIEREN });
  });

  test("says so, and sends nothing, when the show is already a favorite", async () => {
    const r = await call("set_favorite", { anime: MOB });
    expect(r.text).toBe("Mob Psycho 100 is already one of your favorite anime, so nothing changed.");
    expect(fake.favorites).toEqual([MOB]);
    expect(fake.writes).toHaveLength(0);
  });

  test("takes a show out with favorite: false, and leaves one that isn't a favorite as it is", async () => {
    const out = await call("set_favorite", { anime: "mob psycho", favorite: false });
    expect(out.text).toBe(
      'Matched "mob psycho" to Mob Psycho 100, one of your favorites.\nTook Mob Psycho 100 out of your favorite anime on AniList.',
    );
    expect(fake.favorites).toEqual([]);
    const again = await call("set_favorite", { anime: MOB, favorite: false });
    expect(again.text).toContain("is not one of your favorite anime, so nothing changed.");
    expect(toggles()).toHaveLength(1);
  });

  test("asks which season when the name fits two the user finished, as a rating does", async () => {
    const r = await call("set_favorite", { anime: "mob psycho 100" });
    expect(r.isError).toBe(true);
    expect(r.text).toStartWith('Nothing was changed. "mob psycho 100" matches 2 shows equally well. Ask the user which one they mean');
    expect(toggles()).toHaveLength(0);
  });

  test("taking out: a name that fits several favorites, or names a season, is resolved as usual", async () => {
    fake.seedFavorites(["Mob Psycho 100 II"]);
    const both = await call("set_favorite", { anime: "mob psycho", favorite: false });
    expect(both.isError).toBe(true);
    expect(both.text).toContain("Ask the user which one they mean");
    const second = await call("set_favorite", { anime: "mob psycho season 2", favorite: false });
    expect(second.text).toEndWith("\nTook Mob Psycho 100 II out of your favorite anime on AniList.");
    expect(second.text).not.toContain("one of your favorites"); // resolved as a season, not among the favorites
    expect(fake.favorites).toEqual([MOB]);
  });

  test("favorites a show that isn't on the list without adding it", async () => {
    const show = catalog.find((m) => !fake.entries.has(m.id) && m.title.romaji === "Chainsaw Man")!;
    const r = await call("set_favorite", { anime: show.id });
    expect(r.isError).toBe(false);
    expect(fake.favorites).toContain(show.id);
    expect(fake.entries.has(show.id)).toBe(false);
  });

  test("toggles a manga with mangaId, by type or when only the manga list has the name", async () => {
    await call("set_favorite", { anime: "frieren", type: "manga" });
    await call("set_favorite", { anime: "Vagabond" });
    expect(fake.favorites).toEqual([MOB, FRIEREN_MANGA, VAGABOND]);
    expect(toggles().map((w) => [w.query.includes("mangaId"), w.variables.id])).toEqual([
      [true, FRIEREN_MANGA],
      [true, VAGABOND],
    ]);
  });

  test("refuses a show AniList won't let be a favorite, sending no toggle", async () => {
    fake.favoriteBlocked.add(FRIEREN);
    const r = await call("set_favorite", { anime: "frieren" });
    expect(r.isError).toBe(true);
    expect(r.text).toBe("Nothing was changed. AniList doesn't let Frieren: Beyond Journey’s End be a favorite.");
    expect(toggles()).toHaveLength(0);
  });

  test("two calls for the same show at once toggle it once", async () => {
    const [a, b] = await Promise.all([call("set_favorite", { anime: "frieren" }), call("set_favorite", { anime: FRIEREN })]);
    expect(fake.favorites).toEqual([MOB, FRIEREN]);
    expect(toggles()).toHaveLength(1);
    expect([a.text, b.text].some((t) => t.includes("already one of your favorite anime"))).toBe(true);
  });

  test("reads the favorite fresh: a change made on anilist.co since isn't toggled back", async () => {
    await call("search_my_list", {}); // the list is cached now
    fake.favorites.push(FRIEREN); // favorited on anilist.co
    const r = await call("set_favorite", { anime: "frieren" });
    expect(r.text).toContain("already one of your favorite anime");
    expect(fake.favorites).toEqual([MOB, FRIEREN]);
  });
});

describe("undo of a favorite", () => {
  test("takes a new favorite out again, and puts a removed one back", async () => {
    await call("set_favorite", { anime: "frieren" });
    const u1 = await call("undo");
    expect(u1.text).toContain("Undid the last change (set_favorite):");
    expect(u1.text).toContain("Frieren: Beyond Journey’s End: taken out of your favorites.");
    expect(fake.favorites).toEqual([MOB]);

    await call("set_favorite", { anime: MOB, favorite: false });
    const u2 = await call("undo");
    expect(u2.text).toContain("Mob Psycho 100: back among your favorites.");
    expect(fake.favorites).toEqual([MOB]);
  });

  test("leaves a favorite changed since on anilist.co alone", async () => {
    await call("set_favorite", { anime: "frieren" });
    fake.favorites = [MOB]; // taken out on anilist.co
    const r = await call("undo");
    expect(r.text).toContain("Frieren: Beyond Journey’s End: not undone, its favorite has changed since");
    expect(toggles()).toHaveLength(1);
  });

  test("an undo and a set_favorite at once take turns, so the favorite isn't toggled twice", async () => {
    await call("set_favorite", { anime: MOB, favorite: false });
    // Toggles land a moment late, as over the network: both calls read the state before either lands.
    const answer = fake.fetch;
    fake.fetch = async (url, init) => {
      if (String(init.body).includes("ToggleFavourite")) await new Promise((r) => setTimeout(r, 20));
      return answer(url, init);
    };
    await Promise.all([call("undo"), call("set_favorite", { anime: MOB })]);
    expect(fake.favorites).toEqual([MOB]);
    expect(toggles()).toHaveLength(2);
  });

  test("undoes a favorite and a list change together, newest first", async () => {
    await call("rate_anime", { anime: "frieren", score: 7 });
    await call("set_favorite", { anime: "frieren" });
    const r = await call("undo", { count: 2 });
    expect(r.text).toContain("the last 2 changes (set_favorite, rate_anime)");
    expect(fake.favorites).toEqual([MOB]);
    expect(fake.entries.get(FRIEREN)!.scoreRaw).toBe(95);
  });

  test("nothing to undo when the favorite didn't change", async () => {
    await call("set_favorite", { anime: MOB });
    expect((await call("undo")).text).toContain("Nothing to undo");
  });
});

describe("search_my_list with favorites", () => {
  test("lists the favorites in the user's order, on the list or not", async () => {
    const show = catalog.find((m) => m.title.romaji === "Chainsaw Man")!;
    fake.seedFavorites(["Sousou no Frieren", show.id]);
    const r = await call("search_my_list", { favorites: true });
    expect(r.text.split("\n")).toEqual([
      "3 favorite anime on tester's AniList profile, in their order:",
      expect.stringMatching(/^1\. \[\d+\] Mob Psycho 100 \(TV, 2016\): Completed, 12\/12 episodes/),
      expect.stringMatching(/^2\. \[154587\] Frieren: Beyond Journey’s End \(TV, 2023\): Completed, 28\/28 episodes, 9\.5/),
      expect.stringMatching(/^3\. \[\d+\] Chainsaw Man \(TV, 2022\): not on your list/),
    ]);
  });

  test("lists manga favorites with type manga, and says when there are none", async () => {
    expect((await call("search_my_list", { favorites: true, type: "manga" })).text).toBe("tester has no favorite manga on AniList.");
    fake.seedFavorites(["Vagabond"]);
    expect((await call("search_my_list", { favorites: true, type: "manga" })).text).toContain("1. [");
  });

  test("reads favorites a page of 25 at a time, as far as limit and offset need", async () => {
    fake.favorites = catalog.slice(0, 30).map((m) => m.id);
    const first = await call("search_my_list", { favorites: true, limit: 10 });
    expect(first.text.split("\n")[0]).toBe("30 favorite anime on tester's AniList profile, in their order (showing 1-10; offset 10 for more):");
    const rest = await call("search_my_list", { favorites: true, offset: 20 });
    expect(rest.text.split("\n")[0]).toBe("30 favorite anime on tester's AniList profile, in their order (showing 21-30):");
    expect(rest.text).toContain(`30. [${catalog[29]!.id}]`);
    const pages = fake.calls.filter((c) => c.query.includes("favourites")).map((c) => c.variables.page);
    expect(pages).toEqual([1, 1, 2]);
  });

  test("refuses the list filters, which favorites don't take", async () => {
    const r = await call("search_my_list", { favorites: true, status: "COMPLETED" });
    expect(r.isError).toBe(true);
    expect(r.text).toBe("`favorites` takes only `type`; call again without `status`.");
  });
});
