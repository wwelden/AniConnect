/** Checks the eval cases and grader themselves, without running a model. */
import { describe, expect, test } from "bun:test";
import { CASES, type Change } from "../evals/cases";
import { diff, gradeCase } from "../evals/grade";
import { PERSONA } from "./fixtures/persona";
import { FakeAniList, findMedia } from "./support/fake-anilist";

function applyChanges(changes: Change[]) {
  const fake = new FakeAniList().seed(PERSONA);
  const before = fake.exportState().entries.map((e) => ({ ...e }));
  for (const c of changes) {
    const m = findMedia(c.anime);
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
      ...(c.score !== undefined && { scoreRaw: Math.round(c.score * 10) }),
    });
  }
  return diff(before, fake.exportState().entries);
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

  test("an unexpected extra change fails", () => {
    const c = CASES.find((x) => x.id === "rate-simple")!;
    const changed = applyChanges([
      { anime: "Bocchi the Rock!", score: 9 },
      { anime: "Dandadan", progress: 8 },
    ]);
    expect(gradeCase(c, changed, "Done.")).toContain("also changed Dandadan");
  });
});
