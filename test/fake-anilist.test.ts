/**
 * The fake AniList answers any query AniList's schema allows, not just AniConnect's, so
 * other AniList servers can run against it (R6.4). These check it behaves like AniList.
 */
import { describe, expect, test } from "bun:test";
import { PERSONA } from "./fixtures/persona";
import { FakeAniList, findMedia } from "./support/fake-anilist";

async function gql(fake: FakeAniList, query: string, variables: Record<string, unknown> = {}, token: string | null = "t") {
  const res = await fake.fetch("https://graphql.anilist.co", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify({ query, variables }),
  });
  return { status: res.status, body: (await res.json()) as any };
}

const DANDADAN = findMedia("Dandadan").id;

describe("fake AniList", () => {
  test("rejects a query AniList's schema would, with HTTP 400", async () => {
    const r = await gql(new FakeAniList(), "query { Media(id: 1) { notAField } }");
    expect(r.status).toBe(400);
    expect(r.body.errors[0].message).toContain('Cannot query field "notAField" on type "Media"');
    expect(r.body.data).toBeNull();
  });

  test("answers an unknown ID with 404 Not Found, like AniList", async () => {
    const r = await gql(new FakeAniList(), "query { Media(id: 999999999) { id } }");
    expect(r.status).toBe(404);
    expect(r.body.errors[0]).toMatchObject({ message: "Not Found.", status: 404 });
  });

  test("needs a token for Viewer and for writes", async () => {
    const fake = new FakeAniList();
    expect((await gql(fake, "query { Viewer { id } }", {}, null)).status).toBe(401);
    expect((await gql(fake, `mutation { SaveMediaListEntry(mediaId: ${DANDADAN}) { id } }`, {}, null)).status).toBe(401);
    expect((await gql(fake, "query { Viewer { id name } }")).body.data.Viewer).toEqual({ id: 1, name: "tester" });
    // A show's list entry is the viewer's, so without a token it is null.
    fake.seed([{ anime: DANDADAN, status: "CURRENT" }]);
    const media = `query { Media(id: ${DANDADAN}) { mediaListEntry { status } } }`;
    expect((await gql(fake, media, {}, null)).body.data.Media.mediaListEntry).toBeNull();
    expect((await gql(fake, media)).body.data.Media.mediaListEntry).toEqual({ status: "CURRENT" });
  });

  test("finds a show by name with Media(search:), and pages through Page.media", async () => {
    const fake = new FakeAniList();
    const one = await gql(fake, 'query { Media(search: "frieren", type: ANIME) { id title { userPreferred } } }');
    expect(one.body.data.Media).toEqual({ id: findMedia("Sousou no Frieren").id, title: { userPreferred: "Frieren: Beyond Journey’s End" } });

    const page = await gql(
      fake,
      `query ($page: Int) { Page(page: $page, perPage: 2) {
        pageInfo { total currentPage lastPage hasNextPage }
        media(search: "jujutsu kaisen", type: ANIME, sort: [START_DATE]) { title { romaji } }
      } }`,
      { page: 1 },
    );
    expect(page.body.data.Page.pageInfo).toMatchObject({ currentPage: 1, hasNextPage: true });
    expect(page.body.data.Page.pageInfo.total).toBeGreaterThan(2);
    expect(page.body.data.Page.media.map((m: any) => m.title.romaji)).toEqual(["Jujutsu Kaisen", "Jujutsu Kaisen 0"]);
  });

  test("saves a score given in the user's own format, and reads it back in any format", async () => {
    const fake = new FakeAniList("POINT_5");
    const r = await gql(fake, `mutation { SaveMediaListEntry(mediaId: ${DANDADAN}, score: 4, status: CURRENT) {
      mediaId score hundred: score(format: POINT_100) status user { name } media { id }
    } }`);
    expect(r.body.data.SaveMediaListEntry).toEqual({ mediaId: DANDADAN, score: 4, hundred: 80, status: "CURRENT", user: { name: "tester" }, media: { id: DANDADAN } });
    expect(fake.entries.get(DANDADAN)!.scoreRaw).toBe(80);
  });

  test("updates entries by entry ID, one at a time or with UpdateMediaListEntries", async () => {
    const fake = new FakeAniList().seed(PERSONA);
    const [a, b] = [...fake.entries.values()].filter((e) => e.status === "PLANNING");
    await gql(fake, `mutation { SaveMediaListEntry(id: ${a!.id}, progress: 2) { id } }`);
    expect(fake.entries.get(a!.mediaId)!.progress).toBe(2);
    const r = await gql(fake, `mutation ($ids: [Int]) { UpdateMediaListEntries(ids: $ids, status: DROPPED) { mediaId status } }`, { ids: [a!.id, b!.id] });
    expect(r.body.data.UpdateMediaListEntries).toHaveLength(2);
    expect([fake.entries.get(a!.mediaId)!.status, fake.entries.get(b!.mediaId)!.status]).toEqual(["DROPPED", "DROPPED"]);
  });

  test("looks up one entry with MediaList, and 404s when the show isn't on the list", async () => {
    const fake = new FakeAniList().seed([{ anime: DANDADAN, status: "CURRENT", progress: 3 }]);
    const q = "query ($m: Int) { MediaList(userName: \"tester\", mediaId: $m) { progress } }";
    expect((await gql(fake, q, { m: DANDADAN })).body.data.MediaList).toEqual({ progress: 3 });
    expect((await gql(fake, q, { m: findMedia("ONE PIECE").id })).status).toBe(404);
    // `id` here is the entry's ID, not the user's.
    const id = fake.entries.get(DANDADAN)!.id;
    expect((await gql(fake, `query { MediaList(id: ${id}) { mediaId } }`)).body.data.MediaList).toEqual({ mediaId: DANDADAN });
    expect((await gql(fake, `query { Page { mediaList(id: ${id}) { mediaId } } }`)).body.data.Page.mediaList).toEqual([{ mediaId: DANDADAN }]);
  });

  test("lists airing episodes with IDs that fit GraphQL's Int", async () => {
    const r = await gql(new FakeAniList(), "query { Page { airingSchedules(notYetAired: true) { id episode media { id } } } }");
    expect(r.status).toBe(200);
    expect(r.body.data.Page.airingSchedules.length).toBeGreaterThan(0);
  });

  test("groups the list into status lists, and repeats an entry in each custom list it's on", async () => {
    const fake = new FakeAniList().seed([
      { anime: DANDADAN, status: "CURRENT" },
      { anime: "ONE PIECE", status: "CURRENT" },
      { anime: "Sousou no Frieren", status: "COMPLETED" },
    ]);
    fake.entries.get(DANDADAN)!.customLists = ["Favourites"];
    const r = await gql(fake, `query { MediaListCollection(userName: "tester", type: ANIME) {
      lists { name isCustomList entries { mediaId customLists(asArray: true) } }
    } }`);
    const lists = r.body.data.MediaListCollection.lists;
    expect(lists.map((l: any) => [l.name, l.entries.length])).toEqual([["Watching", 2], ["Completed", 1], ["Favourites", 1]]);
    expect(lists[2].entries[0]).toEqual({ mediaId: DANDADAN, customLists: [{ name: "Favourites", enabled: true }] });
    // Without asArray, AniList's object form.
    const plain = await gql(fake, `query { MediaList(userId: 1, mediaId: ${findMedia("ONE PIECE").id}) { customLists } }`);
    expect(plain.body.data.MediaList.customLists).toEqual({ Favourites: false });
  });

  test("returns list activity through the ActivityUnion", async () => {
    const fake = new FakeAniList();
    fake.clock = () => Date.parse("2026-11-17T12:00:00Z");
    await gql(fake, `mutation { SaveMediaListEntry(mediaId: ${DANDADAN}, status: CURRENT, progress: 1) { id } }`);
    const r = await gql(fake, `query { Page { activities(userId: 1, type: ANIME_LIST, sort: ID_DESC) {
      __typename ... on ListActivity { status progress media { id } }
    } } }`);
    expect(r.body.data.Page.activities).toEqual([{ __typename: "ListActivity", status: "watched episode", progress: "1", media: { id: DANDADAN } }]);
  });

  test("lists a show's studios, or only its main ones when asked", async () => {
    const studios = async (args: string) =>
      (await gql(new FakeAniList(), `query { Media(id: ${findMedia("Sousou no Frieren").id}) { studios${args} { nodes { name } edges { isMain } } } }`))
        .body.data.Media.studios;
    expect((await studios("(isMain: true)")).nodes).toEqual([{ name: "MADHOUSE" }]);
    const all = await studios("");
    expect(all.nodes.length).toBeGreaterThan(1);
    expect(all.edges.filter((e: { isMain: boolean }) => e.isMain).length).toBe(1);
  });

  test("logs fields it has no data for, and refuses writes it doesn't keep", async () => {
    const fake = new FakeAniList();
    const r = await gql(fake, `query { Media(id: ${DANDADAN}) { id trailer { id } characters { nodes { id } } rankings { rank } } }`);
    // Empty the way AniList's "none" is: no trailer, but an empty connection and list.
    expect(r.body.data.Media).toEqual({ id: DANDADAN, trailer: null, characters: { nodes: [] }, rankings: [] });
    expect([...fake.unmodeled]).toEqual(["Media.trailer", "Media.characters", "CharacterConnection.nodes", "Media.rankings"]);

    const fav = await gql(fake, `mutation { ToggleFavourite(animeId: ${DANDADAN}) { anime { nodes { id } } } }`);
    expect(fav.status).toBe(400);
    expect(fav.body.errors[0].message).toBe("The fake AniList doesn't support ToggleFavourite.");
  });
});
