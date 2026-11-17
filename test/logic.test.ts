import { describe, expect, test } from "bun:test";
import { bothTitles, describePlanDates, displayTitle, formatScore, matchesTitle, planProgress, planStatus, planUpdate, toRawScore } from "../src/logic";

const today = { year: 2026, month: 11, day: 16 };
const unset = { year: null, month: null, day: null };
const earlier = { year: 2025, month: 3, day: 1 };

describe("displayTitle", () => {
  const title = { romaji: "Shingeki no Kyojin", english: "Attack on Titan", native: "進撃の巨人" };

  test("prints one title, in the user's language", () => {
    expect(displayTitle(title, "ENGLISH")).toBe("Attack on Titan");
    expect(displayTitle(title, "ROMAJI")).toBe("Shingeki no Kyojin");
    expect(displayTitle(title, "NATIVE")).toBe("進撃の巨人");
    expect(displayTitle(title, "ENGLISH_STYLISED")).toBe("Attack on Titan");
    expect(displayTitle(title, "ROMAJI_STYLISED")).toBe("Shingeki no Kyojin");
    expect(displayTitle(title, "NATIVE_STYLISED")).toBe("進撃の巨人");
  });

  test("falls back when AniList has no title in that language", () => {
    expect(displayTitle({ ...title, english: null }, "ENGLISH")).toBe("Shingeki no Kyojin");
    expect(displayTitle({ ...title, native: null }, "NATIVE")).toBe("Shingeki no Kyojin");
    expect(displayTitle({ romaji: null, english: "Attack on Titan", native: null }, "ROMAJI")).toBe("Attack on Titan");
    expect(displayTitle({ romaji: null, english: null, native: "進撃の巨人" }, "ENGLISH")).toBe("進撃の巨人");
    expect(displayTitle({ romaji: null, english: null, native: null }, "ROMAJI")).toBe("Untitled");
  });

  test("bothTitles adds the English or romaji name the user may also know", () => {
    expect(bothTitles(title, "ENGLISH")).toBe("Attack on Titan (Shingeki no Kyojin)");
    expect(bothTitles(title, "ROMAJI")).toBe("Shingeki no Kyojin (Attack on Titan)");
    expect(bothTitles(title, "NATIVE")).toBe("進撃の巨人 (Attack on Titan)");
    expect(bothTitles({ ...title, english: null }, "ENGLISH")).toBe("Shingeki no Kyojin");
    expect(bothTitles({ romaji: "ONE PIECE", english: "ONE PIECE", native: null }, "ROMAJI")).toBe("ONE PIECE");
  });
});

describe("matchesTitle", () => {
  const media = {
    title: { romaji: "Shingeki no Kyojin", english: "Attack on Titan", native: "進撃の巨人" },
    synonyms: ["AoT", "SnK"],
  };

  test("matches any title, ignoring case and punctuation", () => {
    expect(matchesTitle(media, "attack titan")).toBe(true);
    expect(matchesTitle(media, "SHINGEKI")).toBe(true);
    expect(matchesTitle(media, "進撃")).toBe(true);
    expect(matchesTitle(media, "aot")).toBe(true);
    expect(matchesTitle(media, "Attack-on")).toBe(true);
  });

  test("requires every word to appear in the same title", () => {
    expect(matchesTitle(media, "attack kyojin")).toBe(false);
    expect(matchesTitle(media, "naruto")).toBe(false);
  });

  test("ignores accents", () => {
    expect(matchesTitle({ title: { romaji: "Pokémon", english: null, native: null }, synonyms: [] }, "pokemon")).toBe(true);
  });
});

describe("planProgress", () => {
  test("watching an episode of a planned show starts it", () => {
    expect(planProgress({ episodes: 12 }, { status: "PLANNING", startedAt: unset, completedAt: unset }, 1, today)).toEqual({
      progress: 1,
      status: "CURRENT",
      startedAt: today,
    });
  });

  test("a show not on the list becomes watching", () => {
    expect(planProgress({ episodes: 12 }, null, 3, today)).toEqual({ progress: 3, status: "CURRENT", startedAt: today });
  });

  test("keeps an existing start date", () => {
    expect(planProgress({ episodes: 12 }, { status: "PAUSED", startedAt: earlier, completedAt: unset }, 4, today)).toEqual({
      progress: 4,
      status: "CURRENT",
    });
  });

  test("progress within a watching show changes nothing else", () => {
    expect(planProgress({ episodes: 12 }, { status: "CURRENT", startedAt: earlier, completedAt: unset }, 5, today)).toEqual({ progress: 5 });
  });

  test("the last episode completes the show", () => {
    expect(planProgress({ episodes: 12 }, { status: "CURRENT", startedAt: earlier, completedAt: unset }, 12, today)).toEqual({
      progress: 12,
      status: "COMPLETED",
      completedAt: today,
    });
  });

  test("finishing a rewatch keeps the first completion date and counts the rewatch", () => {
    expect(planProgress({ episodes: 12 }, { status: "REPEATING", startedAt: earlier, completedAt: earlier }, 12, today)).toEqual({
      progress: 12,
      status: "COMPLETED",
      repeat: 1,
    });
    expect(
      planProgress({ episodes: 12 }, { status: "REPEATING", startedAt: earlier, completedAt: earlier, repeat: 2 }, 12, today),
    ).toMatchObject({ repeat: 3 });
  });

  test("completing never overwrites a finish date that is already set", () => {
    expect(planProgress({ episodes: 12 }, { status: "CURRENT", startedAt: earlier, completedAt: earlier }, 12, today)).toEqual({
      progress: 12,
      status: "COMPLETED",
    });
  });

  test("going below the last episode of a completed show moves it back to watching, keeping its dates", () => {
    expect(planProgress({ episodes: 28 }, { status: "COMPLETED", startedAt: earlier, completedAt: earlier }, 5, today)).toEqual({
      progress: 5,
      status: "CURRENT",
    });
    // Even with no dates set: coming back from Completed isn't starting the show.
    expect(planProgress({ episodes: 28 }, { status: "COMPLETED", startedAt: unset, completedAt: unset }, 5, today)).toEqual({
      progress: 5,
      status: "CURRENT",
    });
  });

  test("a show marked completed without progress stays completed as episodes are counted", () => {
    const entry = { status: "COMPLETED" as const, startedAt: earlier, completedAt: earlier, progress: 0 };
    expect(planProgress({ episodes: 12 }, entry, 1, today)).toEqual({ progress: 1 });
  });

  test("a completed show with an unknown episode count goes back to watching only when progress goes down", () => {
    const entry = { status: "COMPLETED" as const, startedAt: earlier, completedAt: earlier, progress: 50 };
    expect(planProgress({ episodes: null }, entry, 40, today)).toEqual({ progress: 40, status: "CURRENT" });
    expect(planProgress({ episodes: null }, entry, 50, today)).toEqual({ progress: 50 });
  });

  test("a rewatch in progress stays a rewatch", () => {
    expect(planProgress({ episodes: 12 }, { status: "REPEATING", startedAt: earlier, completedAt: earlier }, 6, today)).toEqual({ progress: 6 });
  });

  test("unknown episode counts (airing shows) never auto-complete", () => {
    expect(planProgress({ episodes: null }, { status: "CURRENT", startedAt: earlier, completedAt: unset }, 500, today)).toEqual({ progress: 500 });
  });

  test("rejects going past the last episode", () => {
    expect(() => planProgress({ episodes: 12 }, null, 13, today)).toThrow("only has 12 episodes");
  });

  test("rejects negative or fractional counts", () => {
    expect(() => planProgress({ episodes: 12 }, null, -1, today)).toThrow();
    expect(() => planProgress({ episodes: 12 }, null, 1.5, today)).toThrow();
  });
});

describe("planStatus", () => {
  test("completing fills in all episodes and both dates", () => {
    expect(planStatus({ episodes: 25 }, { status: "PLANNING", startedAt: unset, completedAt: unset }, "COMPLETED", today)).toEqual({
      status: "COMPLETED",
      progress: 25,
      startedAt: today,
      completedAt: today,
    });
  });

  test("starting to watch sets the start date, also for a show not on the list", () => {
    expect(planStatus({ episodes: 12 }, null, "CURRENT", today)).toEqual({ status: "CURRENT", startedAt: today });
  });

  test("never overwrites dates that are already set", () => {
    expect(planStatus({ episodes: 25 }, { status: "PAUSED", startedAt: earlier, completedAt: earlier }, "COMPLETED", today)).toEqual({
      status: "COMPLETED",
      progress: 25,
    });
  });

  test("a partial date (month without a year) counts as set", () => {
    const monthOnly = { year: null, month: 3, day: null };
    expect(planStatus({ episodes: 25 }, { status: "CURRENT", startedAt: monthOnly, completedAt: monthOnly }, "COMPLETED", today)).toEqual({
      status: "COMPLETED",
      progress: 25,
    });
  });

  test("planning, pausing and dropping set no dates", () => {
    for (const status of ["PLANNING", "PAUSED", "DROPPED"] as const) {
      expect(planStatus({ episodes: 12 }, { status: "CURRENT", startedAt: unset, completedAt: unset, progress: 3 }, status, today)).toEqual({ status });
    }
  });

  test("starting a rewatch of a finished show resets progress and keeps the dates", () => {
    const done = { status: "COMPLETED" as const, startedAt: earlier, completedAt: earlier, progress: 12 };
    expect(planStatus({ episodes: 12 }, done, "REPEATING", today)).toEqual({ status: "REPEATING", progress: 0 });
  });

  test("a rewatch already under way keeps its progress", () => {
    const rewatching = { status: "REPEATING" as const, startedAt: earlier, completedAt: earlier, progress: 4 };
    expect(planStatus({ episodes: 12 }, rewatching, "REPEATING", today)).toEqual({ status: "REPEATING" });
  });

  test("finishing a rewatch by status counts it and keeps the finish date", () => {
    const rewatching = { status: "REPEATING" as const, startedAt: earlier, completedAt: earlier, progress: 4, repeat: 1 };
    expect(planStatus({ episodes: 12 }, rewatching, "COMPLETED", today)).toEqual({ status: "COMPLETED", progress: 12, repeat: 2 });
  });

  test("describes the dates it writes", () => {
    expect(describePlanDates({ startedAt: today, completedAt: today })).toBe(
      " Start date set to 2026-11-16, finish date set to 2026-11-16.",
    );
    expect(describePlanDates({ repeat: 1 })).toBe(" Rewatch count is now 1.");
    expect(describePlanDates({ progress: 3 })).toBe("");
  });
});

describe("scores", () => {
  test("converts 0-10 to AniList's raw 0-100 score", () => {
    expect(toRawScore(8)).toBe(80);
    expect(toRawScore(7.5)).toBe(75);
    expect(toRawScore(0)).toBe(0);
    expect(toRawScore(10)).toBe(100);
  });

  test("rejects out-of-range scores", () => {
    expect(() => toRawScore(11)).toThrow();
    expect(() => toRawScore(-1)).toThrow();
    expect(() => toRawScore(Number.NaN)).toThrow();
  });

  test("formats in the user's scoring format", () => {
    expect(formatScore(85, "POINT_100")).toBe("85/100");
    expect(formatScore(4, "POINT_5")).toBe("4 stars (of 5)");
    expect(formatScore(0, "POINT_10")).toBe("unrated");
  });
});

describe("planUpdate (R2.6)", () => {
  const show = { episodes: 12 };
  const planned = { status: "PLANNING" as const, progress: 0, startedAt: unset, completedAt: unset };

  test("episodes then a status, as if saved one after the other", () => {
    expect(planUpdate(show, planned, { progress: 3, status: "PAUSED" }, today)).toEqual({
      progress: 3,
      status: "PAUSED",
      startedAt: today,
    });
  });

  test("a status alone plans like set_status", () => {
    expect(planUpdate(show, planned, { status: "COMPLETED" }, today)).toEqual(planStatus(show, planned, "COMPLETED", today));
  });

  test("episodes alone plan like set_progress", () => {
    expect(planUpdate(show, planned, { progress: 12 }, today)).toEqual(planProgress(show, planned, 12, today));
  });

  test("an explicit episode count wins over the one a status implies", () => {
    const done = { status: "COMPLETED" as const, progress: 12, startedAt: earlier, completedAt: earlier };
    expect(planUpdate(show, done, { progress: 3, status: "REPEATING" }, today)).toEqual({
      progress: 3,
      status: "REPEATING",
    });
  });

  test("a new show watched and finished in one go gets both dates", () => {
    expect(planUpdate(show, null, { progress: 12, status: "COMPLETED" }, today)).toEqual({
      progress: 12,
      status: "COMPLETED",
      startedAt: today,
      completedAt: today,
    });
  });

  test("nothing to plan when only a score changes", () => {
    expect(planUpdate(show, planned, {}, today)).toEqual({});
  });
});
