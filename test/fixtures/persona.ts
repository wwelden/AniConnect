import type { SeedActivity, SeedEntry } from "../support/fake-anilist";

/**
 * A realistic list for resolver tests and evals: several franchises part-way through,
 * so "which season did they mean?" has a real answer.
 */
export const PERSONA: SeedEntry[] = [
  { anime: "Jujutsu Kaisen", status: "COMPLETED", score: 8 },
  { anime: "Jujutsu Kaisen 2nd Season", status: "CURRENT", progress: 3 },
  { anime: "SPY×FAMILY", status: "COMPLETED", score: 8 },
  { anime: "SPY×FAMILY Part 2", status: "COMPLETED" },
  { anime: "SPY×FAMILY Season 2", status: "PLANNING" },
  { anime: "Shingeki no Kyojin", status: "COMPLETED", score: 9 },
  { anime: "Shingeki no Kyojin Season 2", status: "COMPLETED" },
  { anime: "Shingeki no Kyojin Season 3", status: "COMPLETED" },
  { anime: "Shingeki no Kyojin Season 3 Part 2", status: "COMPLETED" },
  { anime: "Shingeki no Kyojin: The Final Season", status: "PAUSED", progress: 10 },
  { anime: "Sousou no Frieren", status: "COMPLETED", score: 9.5 },
  { anime: "Dandadan", status: "CURRENT", progress: 7 },
  { anime: "ONE PIECE", status: "CURRENT", progress: 1100 },
  { anime: "Mob Psycho 100", status: "COMPLETED" },
  { anime: "Mob Psycho 100 II", status: "COMPLETED" },
  { anime: "Mob Psycho 100 III", status: "PLANNING" },
  { anime: "Bocchi the Rock!", status: "COMPLETED" },
  { anime: "[Oshi no Ko]", status: "COMPLETED" },
  { anime: "[Oshi no Ko] 2nd Season", status: "CURRENT", progress: 5 },
  { anime: "Kaguya-sama wa Kokurasetai: Tensaitachi no Renai Zunousen", status: "COMPLETED" },
  { anime: "Kaguya-sama wa Kokurasetai?: Tensaitachi no Renai Zunousen", status: "COMPLETED" },
  { anime: "Kaguya-sama wa Kokurasetai: Ultra Romantic", status: "CURRENT", progress: 2 },
  { anime: "VINLAND SAGA", status: "DROPPED", progress: 10 },
  { anime: "Haikyuu!!", status: "PLANNING" },
  // Airing now and caught up: episode 8 airs 2026-11-20.
  { anime: "Kusuriya no Hitorigoto", status: "COMPLETED" },
  { anime: "Kusuriya no Hitorigoto 2nd Season", status: "COMPLETED" },
  { anime: "Kusuriya no Hitorigoto 3rd Season", status: "CURRENT", progress: 7 },
];

/**
 * The persona's activity feed, consistent with the list above. Evals run on Tuesday
 * 2026-11-17 at 12:00 UTC, so "this week" started on Monday the 16th.
 */
export const HISTORY: SeedActivity[] = [
  { anime: "ONE PIECE", status: "watched episode", progress: "1098 - 1100", at: "2026-11-17T02:00:00Z" },
  { anime: "Dandadan", status: "watched episode", progress: "6 - 7", at: "2026-11-16T21:10:00Z" },
  { anime: "Kusuriya no Hitorigoto 3rd Season", status: "watched episode", progress: "7", at: "2026-11-15T19:00:00Z" },
  { anime: "Jujutsu Kaisen 2nd Season", status: "watched episode", progress: "3", at: "2026-11-12T20:30:00Z" },
  { anime: "[Oshi no Ko] 2nd Season", status: "watched episode", progress: "4 - 5", at: "2026-11-10T22:00:00Z" },
  { anime: "Mob Psycho 100 II", status: "completed", at: "2026-10-25T18:00:00Z" },
  { anime: "Shingeki no Kyojin: The Final Season", status: "paused watching", at: "2026-10-19T18:00:00Z" },
  { anime: "Sousou no Frieren", status: "completed", at: "2026-10-05T20:00:00Z" },
  { anime: "Sousou no Frieren", status: "watched episode", progress: "25 - 27", at: "2026-10-05T19:00:00Z" },
  { anime: "VINLAND SAGA", status: "dropped", at: "2026-09-20T18:00:00Z" },
  { anime: "Bocchi the Rock!", status: "completed", at: "2026-03-14T20:00:00Z" },
  { anime: "SPY×FAMILY Season 2", status: "plans to watch", at: "2026-03-08T12:00:00Z" },
];
