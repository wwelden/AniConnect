# AniConnect requirements

## Goal

Be the best MCP server for managing an AniList anime list: the one where a plain-language request ("I watched episode 3 of JJK", "rate the second season of Spy x Family an 8") changes the right entry, in one step, without the user ever seeing an ID.

"Better" is measured, not claimed: the eval suite (R6) scores us and the alternatives on the same requests.

## Baseline: existing AniList MCP servers

Surveyed 2026-11-16 from their READMEs (not yet run by us).

| | [yuna0x0/anilist-mcp](https://github.com/yuna0x0/anilist-mcp) | [gavxm/ani-mcp](https://www.npmjs.com/package/ani-mcp) |
|---|---|---|
| Tools | ~44, thin wrappers over the API | 52, incl. taste profiles, picks, analytics |
| Identifying a show | AniList ID | AniList ID |
| List writes | generic add / update / remove | progress, rate, add, delete, undo, batch (dry-run) |
| Auth | paste a token into config | paste a token into config |
| Transport | stdio, HTTP | stdio, HTTP |

Where we aim to win: name and season resolution (R1), a small and accurate tool set (R2), hosted sign-in that works in claude.ai and on mobile (R7), and evidence (R6).

## Requirements

Status: **Done**, **In progress**, **Planned**, **Later**.

### Core list management

| ID | Requirement | Status |
|---|---|---|
| R0.1 | Search AniList for anime by title. | Done |
| R0.2 | Search the user's own list by title words and status. | Done |
| R0.3 | Add a show to the list (plan to watch by default) without overwriting an existing entry. | Done |
| R0.4 | Change a show's status. | Done |
| R0.5 | Rate a show out of 10; report the score in the user's own scoring format. | Done |
| R0.6 | Mark the next episode(s) watched, or set an exact episode count. | Done |
| R0.7 | Episode changes keep status and dates in sync: watching moves planned/paused/dropped to watching and sets the start date; the last episode completes the show and sets the finish date; shows with an unknown episode count never auto-complete. | Done |
| R0.8 | Remove a show from the list. | Done |

### R1: Name and season resolution

Every tool that targets a show accepts a title (or an ID) and picks the right AniList entry itself.

| ID | Requirement | Status |
|---|---|---|
| R1.1 | Match any title form: English, romaji, native, AniList synonyms, common acronyms (JJK, AoT, MHA), ignoring case, punctuation and accents. | Done (resolver tests) |
| R1.2 | Tolerate small typos ("frieran"). | Done (resolver tests) |
| R1.3 | Prefer shows already on the user's list over the rest of AniList. | Done (resolver tests) |
| R1.4 | Season-aware: with no season given, episode updates go to the season the user is currently watching (not season 1). | Done (resolver tests) |
| R1.5 | Understand season phrasing: "season 2", "S2", "2nd season", "second season", "part 2", and map it to the right entry even when AniList's title doesn't contain the number. | Done (resolver tests) |
| R1.6 | Intent-aware defaults: episode updates prefer in-progress entries; ratings prefer completed ones; adding prefers the first season. | Done (resolver tests) |
| R1.7 | When the request is truly ambiguous, change nothing and return the short list of candidates so the assistant can ask. Never guess between equally likely shows. | Done (resolver tests) |
| R1.8 | Prefer TV seasons over movies, OVAs and specials unless the request names one. | Done (resolver tests) |

### R2: Tool design

| ID | Requirement | Status |
|---|---|---|
| R2.1 | Keep the tool set small (target ≤ 12) with clear, non-overlapping descriptions. | Done |
| R2.2 | Common requests take one tool call. | In progress (tools take names; eval measures it) |
| R2.3 | Results are short, readable text that states exactly what changed (before → after). | Done |
| R2.4 | Errors say what went wrong and what to do next (expired token, rate limit, unknown show). | Done |
| R2.5 | Destructive tools are annotated as such and ask the assistant to confirm first. | Done |

### R3: Safety

| ID | Requirement | Status |
|---|---|---|
| R3.1 | Undo the last change. | Planned |
| R3.2 | Never overwrite data the user didn't ask to change (e.g. keep existing start/finish dates and rewatch completion dates). | Done |

### R4: Airing awareness

| ID | Requirement | Status |
|---|---|---|
| R4.1 | "What's out that I haven't watched?": compare progress with aired episodes for shows being watched. | Planned |
| R4.2 | Show when the next episode airs. | Planned |

### R5: Reliability

| ID | Requirement | Status |
|---|---|---|
| R5.1 | Handle AniList's rate limit (about 90 requests/minute) by reporting the wait, never retry-looping. | Done |
| R5.2 | Stay within a few AniList requests per tool call. | Done (2–3 typical; season lookups walk sequels, about 1 per season) |
| R5.3 | Work with large lists (1,000+ entries). | Planned |

### R6: Evaluation

| ID | Requirement | Status |
|---|---|---|
| R6.1 | A fixture of real AniList data for franchises that are hard to resolve (many seasons, split cours, movies, sequels with unrelated titles). | Done (196 entries, 24 franchises) |
| R6.2 | Deterministic resolver tests: request text + user list → expected entry or "ambiguous". Run in `bun test`. | Done (65 cases) |
| R6.3 | End-to-end evals with a real model: natural-language request → tool calls → final list state, scored on correctness and number of calls. | Built (31 cases), not yet run |
| R6.4 | Run the same evals against competing servers for a side-by-side score. | Later |

### R7: Distribution

| ID | Requirement | Status |
|---|---|---|
| R7.1 | Run locally over stdio with a personal access token. | Done |
| R7.2 | Hosted remote server with "Sign in with AniList" (OAuth), usable from claude.ai and mobile with no config files. | Later |
| R7.3 | Published so others can install it in one command. | Later |

## Non-goals (for now)

- Manga lists. Anime first; manga can follow the same design.
- Social features (activity posts, follows, threads, favourites).
- Recommendations and taste profiling. ani-mcp already covers this; we would need a clear edge to compete here.

## Milestones

1. **Resolution and evals**: R1, R6.1–R6.3.
2. **Daily use**: R2.2, R3.1, R4, R5.
3. **Hosted**: R7.2, R7.3, R6.4.
