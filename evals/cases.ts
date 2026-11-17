/**
 * End-to-end eval cases (requirement R6.3): a plain-language request, run by a real
 * model against the MCP server, graded on the list it leaves behind.
 *
 * Every case starts from the persona list in test/fixtures/persona.ts. Phrasing is
 * deliberately different from the resolver unit tests, so these also catch overfitting.
 */
import type { ListStatus } from "../src/anilist";

export interface Change {
  /** Exact romaji title from the fixture, or an AniList ID. */
  anime: string | number;
  status?: ListStatus;
  progress?: number;
  /** Out of 10. */
  score?: number;
  added?: true;
  removed?: true;
}

export type Outcome =
  /** Exactly these entries change (fields not given aren't checked), nothing else. */
  | { changes: Change[] }
  /** Nothing changes and the assistant asks the user something. */
  | { asks: true }
  /** Nothing changes; the reply mentions each of these (ignoring case and spacing) and the named tools were called. */
  | { readOnly: true; mentions?: string[]; tools?: string[] };

export interface EvalCase {
  id: string;
  prompt: string;
  /** Any of these outcomes passes. */
  expect: Outcome | Outcome[];
  /** Number of AniConnect tool calls considered efficient (reported, not graded). */
  idealCalls?: number;
}

export const CASES: EvalCase[] = [
  // Episode progress: should land on the season in progress, in one call.
  { id: "progress-jjk-abbrev", prompt: "just watched episode 4 of jjk", idealCalls: 1,
    expect: { changes: [{ anime: "Jujutsu Kaisen 2nd Season", progress: 4 }] } },
  { id: "progress-next-ep", prompt: "Watched the next episode of Jujutsu Kaisen last night", idealCalls: 1,
    expect: { changes: [{ anime: "Jujutsu Kaisen 2nd Season", progress: 4 }] } },
  { id: "progress-one-piece-bump", prompt: "I watched two more episodes of One Piece", idealCalls: 1,
    expect: { changes: [{ anime: "ONE PIECE", progress: 1102 }] } },
  { id: "progress-aot-paused", prompt: "Mark episode 11 of Attack on Titan as watched", idealCalls: 1,
    expect: { changes: [{ anime: "Shingeki no Kyojin: The Final Season", progress: 11, status: "CURRENT" }] } },
  { id: "progress-oshi", prompt: "finished ep 6 of oshi no ko", idealCalls: 1,
    expect: { changes: [{ anime: "[Oshi no Ko] 2nd Season", progress: 6 }] } },
  { id: "progress-typo", prompt: "I watched episode 8 of dandadn", idealCalls: 1,
    expect: { changes: [{ anime: "Dandadan", progress: 8 }] } },
  { id: "progress-planned-season", prompt: "Started Spy x Family season 2, just finished the first episode", idealCalls: 1,
    expect: { changes: [{ anime: "SPY×FAMILY Season 2", progress: 1, status: "CURRENT" }] } },
  { id: "progress-love-is-war", prompt: "Love is War ep 3 done", idealCalls: 1,
    expect: { changes: [{ anime: "Kaguya-sama wa Kokurasetai: Ultra Romantic", progress: 3 }] } },
  { id: "progress-new-show", prompt: "I started watching Chainsaw Man and I'm 2 episodes in", idealCalls: 1,
    expect: { changes: [{ anime: "Chainsaw Man", added: true, progress: 2, status: "CURRENT" }] } },
  { id: "progress-finish-season", prompt: "I just watched the season finale of jujutsu kaisen season 2!", idealCalls: 1,
    expect: { changes: [{ anime: "Jujutsu Kaisen 2nd Season", progress: 23, status: "COMPLETED" }] } },
  // "I'm caught up": set_progress with "latest", no whats_next lookup first.
  { id: "progress-caught-up-airing", prompt: "I'm all caught up on One Piece", idealCalls: 1,
    expect: { changes: [{ anime: "ONE PIECE", progress: 1180, status: "CURRENT" }] } },
  { id: "progress-caught-up-finished", prompt: "I'm all caught up on Dandadan", idealCalls: 1,
    expect: { changes: [{ anime: "Dandadan", progress: 12, status: "COMPLETED" }] } },
  { id: "progress-next-season-after-complete", prompt: "watched episode 1 of the new Frieren season",
    expect: { changes: [{ anime: "Sousou no Frieren 2nd Season", added: true, progress: 1, status: "CURRENT" }] } },

  // Status changes.
  { id: "status-drop", prompt: "I'm giving up on One Piece, drop it", idealCalls: 1,
    expect: { changes: [{ anime: "ONE PIECE", status: "DROPPED" }] } },
  { id: "status-hold", prompt: "put dandadan on hold for now", idealCalls: 1,
    expect: { changes: [{ anime: "Dandadan", status: "PAUSED" }] } },
  { id: "status-finished", prompt: "Finished the second season of Oshi no Ko", idealCalls: 1,
    expect: { changes: [{ anime: "[Oshi no Ko] 2nd Season", status: "COMPLETED", progress: 13 }] } },
  { id: "status-resume-dropped", prompt: "I'm giving Vinland Saga another shot, set it back to watching", idealCalls: 1,
    expect: { changes: [{ anime: "VINLAND SAGA", status: "CURRENT" }] } },

  // Ratings.
  { id: "rate-simple", prompt: "rate bocchi the rock 9/10", idealCalls: 1,
    expect: { changes: [{ anime: "Bocchi the Rock!", score: 9 }] } },
  { id: "rate-season-ordinal", prompt: "Give the second season of Kaguya-sama an 8.5", idealCalls: 1,
    expect: { changes: [{ anime: "Kaguya-sama wa Kokurasetai?: Tensaitachi no Renai Zunousen", score: 8.5 }] } },
  { id: "rate-roman-season", prompt: "Mob Psycho 100 II deserves a 10", idealCalls: 1,
    expect: { changes: [{ anime: "Mob Psycho 100 II", score: 10 }] } },
  { id: "rate-ambiguous-franchise", prompt: "rate attack on titan a 10",
    expect: [{ asks: true }, { changes: [{ anime: "Shingeki no Kyojin", score: 10 }] }] },
  { id: "rate-out-of-five", prompt: "I'd give Frieren 4.5 out of 5", idealCalls: 1,
    expect: { changes: [{ anime: "Sousou no Frieren", score: 9 }] } },

  // Adding.
  { id: "add-plan", prompt: "add re:zero to my plan to watch", idealCalls: 1,
    expect: { changes: [{ anime: "Re:Zero kara Hajimeru Isekai Seikatsu", added: true, status: "PLANNING" }] } },
  { id: "add-season", prompt: "Can you add Frieren season 2 to my list?", idealCalls: 1,
    expect: { changes: [{ anime: "Sousou no Frieren 2nd Season", added: true, status: "PLANNING" }] } },
  { id: "add-english-title", prompt: "add That Time I Got Reincarnated as a Slime", idealCalls: 1,
    expect: { changes: [{ anime: "Tensei Shitara Slime Datta Ken", added: true, status: "PLANNING" }] } },
  { id: "add-fmab", prompt: "put FMAB on my list", idealCalls: 1,
    expect: { changes: [{ anime: "Hagane no Renkinjutsushi: FULLMETAL ALCHEMIST", added: true, status: "PLANNING" }] } },
  { id: "add-already", prompt: "add Haikyuu to my list", idealCalls: 1,
    expect: { readOnly: true } },
  { id: "add-remake", prompt: "add hunter x hunter to my list",
    expect: [{ asks: true }, { changes: [{ anime: "HUNTER×HUNTER (2011)", added: true }] }] },
  { id: "add-movie", prompt: "add the chainsaw man movie", idealCalls: 1,
    expect: { changes: [{ anime: "Chainsaw Man: Reze-hen", added: true }] } },
  { id: "add-several", prompt: "Add Demon Slayer and Mushoku Tensei to my plan to watch",
    expect: { changes: [
      { anime: "Kimetsu no Yaiba", added: true, status: "PLANNING" },
      { anime: "Mushoku Tensei: Isekai Ittara Honki Dasu", added: true, status: "PLANNING" },
    ] } },

  // Removing.
  { id: "remove", prompt: "remove haikyuu from my list", idealCalls: 1,
    expect: [{ changes: [{ anime: "Haikyuu!!", removed: true }] }, { asks: true }] },

  // Reading the list.
  { id: "read-watching", prompt: "what am I watching right now?", idealCalls: 1,
    expect: { readOnly: true, mentions: ["Dandadan", "One Piece", "Jujutsu Kaisen"] } },
  { id: "read-planned", prompt: "Is the second season of Spy x Family on my list?",
    expect: { readOnly: true, mentions: ["plan"] } },

  // Browsing AniList with filters (R0.13).
  { id: "browse-season", prompt: "What anime is airing this season?", idealCalls: 1,
    expect: { readOnly: true, tools: ["search_anime"], mentions: ["Apothecary Diaries"] } },
  { id: "browse-genre", prompt: "What's the best-rated romance anime from 2025?", idealCalls: 1,
    expect: { readOnly: true, tools: ["search_anime"], mentions: ["Chainsaw Man"] } },

  // What to watch next (R4).
  { id: "next-free-time", prompt: "I've got a free evening, what should I watch?", idealCalls: 1,
    expect: { readOnly: true, tools: ["whats_next"] } },
  { id: "next-anything-new", prompt: "anything new out for the stuff I'm watching?", idealCalls: 1,
    expect: { readOnly: true, tools: ["whats_next"], mentions: ["One Piece"] } },
  { id: "next-air-date", prompt: "When does the next episode of The Apothecary Diaries come out?", idealCalls: 1,
    expect: { readOnly: true, tools: ["whats_next"], mentions: ["episode 8"] } },
  { id: "next-tonight", prompt: "I have about two hours tonight. Which show can I catch up on?", idealCalls: 1,
    expect: { readOnly: true, tools: ["whats_next"], mentions: ["Dandadan"] } },
  { id: "next-behind", prompt: "How far behind am I on One Piece?", idealCalls: 1,
    expect: { readOnly: true, mentions: ["80"] } },
  { id: "next-more-frieren", prompt: "I finished Frieren, is there more?", idealCalls: 1,
    expect: { readOnly: true, mentions: ["season 2"] } },
  { id: "next-where-to-watch", prompt: "where can I watch Frieren?", idealCalls: 1,
    expect: { readOnly: true, tools: ["whats_next"], mentions: ["Crunchyroll"] } },
];
