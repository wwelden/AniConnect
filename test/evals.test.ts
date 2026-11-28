/** Checks the eval cases and grader themselves, without running a model. */
import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { CASES, type Change } from "../evals/cases";
import { serveFake } from "../evals/fake-http";
import { diff, gradeCase, mentions } from "../evals/grade";
import { MANGA_PERSONA, PERSONA, PERSONA_FAVORITES } from "./fixtures/persona";
import { FakeAniList, findMedia } from "./support/fake-anilist";

function date(text: string) {
  const [year, month, day] = text.split("-").map(Number);
  return { year: year!, month: month ?? null, day: day ?? null };
}

function applyChanges(changes: Change[]) {
  const fake = new FakeAniList().seed([...PERSONA, ...MANGA_PERSONA]).seedFavorites(PERSONA_FAVORITES);
  const before = structuredClone(fake.exportState());
  for (const c of changes) {
    const m = findMedia(c.anime);
    if (c.favorite !== undefined) {
      fake.favorites = fake.favorites.filter((id) => id !== m.id);
      if (c.favorite) fake.favorites.push(m.id);
    }
    // A change of the favorite alone leaves the list entry as it is.
    if (Object.keys(c).every((k) => k === "anime" || k === "favorite")) continue;
    if (c.removed) {
      fake.entries.delete(m.id);
      continue;
    }
    const e = fake.entries.get(m.id) ?? {
      id: fake.nextEntryId++, mediaId: m.id, status: "PLANNING" as const, progress: 0, scoreRaw: 0,
      startedAt: { year: null, month: null, day: null }, completedAt: { year: null, month: null, day: null },
    };
    fake.entries.set(m.id, {
      ...e,
      ...(c.status && { status: c.status }),
      ...(c.progress !== undefined && { progress: c.progress }),
      ...(c.volumes !== undefined && { progressVolumes: c.volumes }),
      ...(c.score !== undefined && { scoreRaw: Math.round(c.score * 10) }),
      ...(c.startedAt !== undefined && { startedAt: date(c.startedAt) }),
      ...(c.completedAt !== undefined && { completedAt: date(c.completedAt) }),
      ...(c.noteHas && { notes: c.noteHas.join(" ") }),
    });
  }
  const after = fake.exportState();
  return diff(before.entries, after.entries, { before: before.favorites, after: after.favorites });
}

describe("eval cases", () => {
  test("ids are unique", () => {
    expect(new Set(CASES.map((c) => c.id)).size).toBe(CASES.length);
  });

  for (const c of CASES) {
    const outcomes = Array.isArray(c.expect) ? c.expect : [c.expect];
    test(`${c.id}: expectations are satisfiable and not trivially passed`, () => {
      for (const o of outcomes) {
        if ("changes" in o) {
          for (const ch of o.changes) expect(() => findMedia(ch.anime)).not.toThrow();
          // Doing exactly what's expected passes...
          expect(gradeCase(c, applyChanges(o.changes), "Done.")).toBeNull();
        }
        if ("asks" in o) expect(gradeCase(c, applyChanges([]), "Which season do you mean?")).toBeNull();
      }
      // ...and a case that expects a change fails when nothing happens.
      if (outcomes.every((o) => "changes" in o && o.changes.length > 0)) {
        expect(gradeCase(c, applyChanges([]), "Done.")).not.toBeNull();
      }
    });
  }

  test("mentions ignore spacing and case", () => {
    const c = CASES.find((x) => x.id === "read-watching")!;
    const reply = "You're watching DAN DA DAN, ONE PIECE and JUJUTSU KAISEN Season 2.";
    expect(gradeCase(c, applyChanges([]), reply)).toBeNull();
    expect(gradeCase(c, applyChanges([]), "You're watching ONE PIECE.")).not.toBeNull();
  });

  test("mentions start at a word boundary", () => {
    expect(mentions("It's on your Plan to Watch list", "plan")).toBe(true);
    expect(mentions("You're planning to watch it", "plan")).toBe(true);
    expect(mentions("Here's an explanation", "plan")).toBe(false);
  });

  test("a favorite case fails when the favorite changes but the entry was wanted too, and the other way", () => {
    const c = CASES.find((x) => x.id === "favorite-with-finish")!;
    expect(gradeCase(c, applyChanges([{ anime: "Dandadan", favorite: true }]), "Done.")).toBe('"Dandadan"\'s list entry was not changed');
    expect(gradeCase(c, applyChanges([{ anime: "Dandadan", status: "COMPLETED", score: 9 }]), "Done.")).toBe('"Dandadan" was not made a favorite');
    const add = CASES.find((x) => x.id === "favorite-add")!;
    expect(gradeCase(add, applyChanges([{ anime: "Sousou no Frieren", favorite: true, score: 10 }]), "Done.")).toBe(
      '"Sousou no Frieren"\'s list entry changed too',
    );
  });

  test("a favorite nobody asked for fails a list change", () => {
    const c = CASES.find((x) => x.id === "rate-simple")!;
    const changed = applyChanges([{ anime: "Bocchi the Rock!", score: 9, favorite: true }]);
    expect(gradeCase(c, changed, "Done.")).toBe('"Bocchi the Rock!" was made a favorite too');
  });

  test("an unexpected extra change fails", () => {
    const c = CASES.find((x) => x.id === "rate-simple")!;
    const changed = applyChanges([
      { anime: "Bocchi the Rock!", score: 9 },
      { anime: "Dandadan", progress: 8 },
    ]);
    expect(gradeCase(c, changed, "Done.")).toContain("also changed Dandadan");
  });
});

describe("a read-only request (#65)", () => {
  const c = CASES.find((x) => x.id === "read-watching")!;
  const reply = "You're watching Dandadan, One Piece and Jujutsu Kaisen Season 2.";
  const edits = {
    private: { private: true },
    "repeat count": { repeat: 2 },
    "hidden from status lists": { hiddenFromStatusLists: true },
    "custom list membership": { customLists: ["Favourites"] },
  };

  for (const [name, edit] of Object.entries(edits)) {
    test(`fails when it changes only the ${name}`, () => {
      const fake = new FakeAniList().seed(PERSONA);
      const before = fake.exportState().entries.map((e) => ({ ...e }));
      const id = findMedia("Dandadan").id;
      fake.entries.set(id, { ...fake.entries.get(id)!, ...edit });
      expect(gradeCase(c, diff(before, fake.exportState().entries), reply)).toBe("changed 1 entries on a read-only request");
    });
  }

  test("fails when it changes only a favorite", () => {
    const fake = new FakeAniList().seed(PERSONA);
    const before = fake.exportState();
    fake.seedFavorites(["Dandadan"]);
    const after = fake.exportState();
    const changed = diff(before.entries, after.entries, { before: before.favorites, after: after.favorites });
    expect(gradeCase(c, changed, reply)).toBe("changed 1 entries on a read-only request");
  });

  test("an unset field and its default are the same", () => {
    const fake = new FakeAniList().seed(PERSONA);
    const before = fake.exportState().entries.map((e) => ({ ...e }));
    const id = findMedia("Dandadan").id;
    fake.entries.set(id, { ...fake.entries.get(id)!, private: false, repeat: 0, hiddenFromStatusLists: false, customLists: [] });
    expect(diff(before, fake.exportState().entries).size).toBe(0);
  });
});

describe("the eval runner's arguments (#64)", () => {
  for (const value of ["typo", "0", "1.5"]) {
    test(`rejects --concurrency ${value} before running anything`, async () => {
      const proc = Bun.spawn(["bun", join(import.meta.dir, "../evals/run.ts"), "--concurrency", value, "--filter", "rate-ambiguous-franchise"], {
        stdout: "pipe",
        stderr: "pipe",
      });
      const [out, err] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
      expect(await proc.exited).toBe(1);
      expect(err).toContain("--concurrency must be a positive whole number");
      expect(out).toBe("");
    });
  }
});

describe("grading other servers (R6.4)", () => {
  const c = { id: "x", prompt: "", expect: { readOnly: true as const, tools: ["whats_next"] } };

  test("a read-only case's tools need only some tool call, since other servers name theirs differently", () => {
    expect(gradeCase(c, new Map(), "Sure.", ["anilist_list"])).toBe("didn't call whats_next");
    expect(gradeCase(c, new Map(), "Sure.", ["anilist_list"], { anyTool: true })).toBeNull();
    expect(gradeCase(c, new Map(), "Sure.", [], { anyTool: true })).toBe("didn't call any tool");
  });
});

describe("sending another server's AniList requests to the fake (R6.4)", () => {
  test.skipIf(!Bun.which("node"))("redirects Node's fetch to the fake", async () => {
    const fake = new FakeAniList();
    const http = serveFake(fake);
    try {
      const proc = Bun.spawn(
        [
          "node",
          "-e",
          `fetch("https://graphql.anilist.co", { method: "POST", headers: { "Content-Type": "application/json", Authorization: "Bearer x" },
            body: JSON.stringify({ query: "query { Viewer { name } }" }) }).then((r) => r.json()).then((b) => console.log(b.data.Viewer.name))`,
        ],
        { env: { ...process.env, FAKE_ANILIST_URL: http.url, NODE_OPTIONS: `--require ${JSON.stringify(join(import.meta.dir, "../evals/anilist-redirect.cjs"))}` }, stdout: "pipe" },
      );
      expect((await new Response(proc.stdout).text()).trim()).toBe("tester");
      expect(fake.calls).toHaveLength(1);
    } finally {
      http.stop();
    }
  });
});
