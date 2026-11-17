import type { SeedEntry } from "../support/fake-anilist";

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
];
