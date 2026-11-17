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
| R0.7 | Episode changes keep status and dates in sync: watching moves planned/paused/dropped to watching and sets the start date; the last episode completes the show and sets the finish date; shows with an unknown episode count never auto-complete. "Today" is the date in the user's AniList time zone (the server's when AniList has none). | Done |
| R0.8 | Remove a show from the list. | Done |
| R0.9 | Finishing a rewatch increments AniList's rewatch count. | Planned |
| R0.10 | Set or correct start and finish dates ("I actually finished it last March"). | Planned |
| R0.11 | Read and write private notes on an entry. | Planned |
| R0.12 | "I'm caught up" in one call: set progress to the latest aired episode, never lowering it; when AniList has no airing schedule, change nothing and ask for a number. | Done (`set_progress` with `"latest"`) |
| R0.13 | Browse AniList by season, year, genre, format and airing status, sorted by popularity, score or start date, in the same tool as title search (the title becomes optional). A season needs a year, and the result names the season used. Results flag shows that continue one the user completed, at no extra request. Browsing only: no recommendations. | Done (`search_anime`; 2 requests per call) |
| R0.14 | Watch history: what the user logged in a time range given in plain words ("this week", "last month", "in March"), or when something happened to one show ("when did I finish Frieren?"), in the user's time zone. Reads only the user's own list activity; an empty result says the feed may be incomplete (activity can be turned off per status or deleted). | Done (`watch_history`; 2 AniList requests, 3 when a show is named) |

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
| R1.9 | Understand relative seasons: "the new season" (latest that has aired) and "next season" (after the furthest season started), following the sequel chain; titles that contain "new" or "next" are read literally first. | Done (resolver tests; found by the eval) |

### R2: Tool design

| ID | Requirement | Status |
|---|---|---|
| R2.1 | Keep the tool set small (target ≤ 12) with clear, non-overlapping descriptions. | Done |
| R2.2 | Common requests take one tool call. | Done: on 31 cases with an ideal call count, Opus 5.5 27/31, Sonnet 5.5 28/31, and Haiku 5.5 27/31 and 30/31 over two runs (2026-11-17). Extra calls are mostly helpful follow-ups (suggesting what to watch after finishing a season, a lookup before deleting); baseline was 15/26 |
| R2.3 | Results are short, readable text that states exactly what changed (before → after). | Done |
| R2.4 | Errors say what went wrong and what to do next (expired token, rate limit, unknown show). | Done |
| R2.5 | Destructive tools are annotated as such and ask the assistant to confirm first. | Done |
| R2.6 | Log several shows in one request with one tool call ("watched eps 3–5 of JJK and the Dandadan finale"), resolving each title. | Planned |
| R2.7 | Where the client supports MCP elicitation, ask the user directly to pick between ambiguous candidates and to confirm deletions; otherwise fall back to R1.7. | Planned |
| R2.8 | Return structured results alongside the text, so clients can render lists and entries. | Planned |
| R2.9 | Print one title per show, in the title language the user picked on AniList (English, romaji or native), falling back to another when a show has none in that language. Lists of ambiguous candidates (R1.7) add a second name, since the user may know the show by either. Names in any language still match (R1.1). | Done |
| R2.10 | Say guidance that several tools share once, in the server's instructions, not in full in every tool description; each write tool keeps a short hint so clients that don't show instructions still take one call. | Done: `tools/list` 11,091 → 9,977 characters; in Claude Code the server costs 4,435 → 4,316 input tokens per conversation, instructions included. Sonnet 5.5, every run fully correct: on the current 41 cases, ideal calls 34/36 on both master and with instructions; on the earlier 36 cases, 26–30/31 on master (4 runs), 28–30/31 with instructions (5 runs), and 27–29/31 with instructions off (3 runs; 20/31 without the short per-tool hint) |

### R3: Safety

| ID | Requirement | Status |
|---|---|---|
| R3.1 | Undo recent changes exactly, including deleting an entry that was just added and restoring one that was just removed. | Planned |
| R3.2 | Never overwrite data the user didn't ask to change (e.g. keep existing start/finish dates and rewatch completion dates). | Done |
| R3.3 | Keep adult (18+) titles out of AniList-wide search and name resolution unless the user's AniList setting (`displayAdultContent`) allows them. Shows already on the list and direct AniList IDs always work. When only adult titles match, say so in one line rather than "not found". | Done (tool tests) |

### R4: Airing awareness

| ID | Requirement | Status |
|---|---|---|
| R4.1 | "What's out that I haven't watched?": compare progress with aired episodes for shows being watched. | Done (`whats_next`) |
| R4.2 | Show when the next episode airs, in the user's time zone. | Done (`whats_next`: the time zone from the user's AniList settings, read with the viewer at no extra request; a `timeZone` argument overrides it; the server's zone when AniList has none. AniList stores an offset, which has no daylight saving, so times name it: "2:00 PM UTC-05:00") |
| R4.3 | "What should I watch next?": combine unwatched aired episodes (R4.1) with the next entry in each franchise relative to the user's list ("you finished seasons 1–3; next is The Final Season, paused at episode 10"). The next entry is a direct sequel (AniList `SEQUEL`) that is a series or a movie, and movies are labeled as movies; recaps, specials and OVAs don't count. Sequels the user has started or finished aren't next; planned ones say so. When a movie and a series sequel tell the same story (AniList links them as `ALTERNATIVE`, like Demon Slayer's Mugen Train movie and TV arc), the series is listed once and names the movie ("watch either"), and having watched either one counts for both. | Done (`whats_next`; checks the 50 most recently finished shows in one request, plus one more only when a show has both a series and a movie sequel) |
| R4.4 | Say how long the unwatched episodes take ("5 episodes to watch, about 2 hours"), from AniList's episode length, so "what can I finish tonight?" needs no arithmetic. Left out when AniList doesn't know the length. | Done (`whats_next`) |
| R4.5 | "Where can I watch X?": list the sites streaming one show, with links, from AniList's streaming links; say availability varies by region, and say nothing when AniList has none. | Done (`whats_next` with `anime`; no extra request) |

### R5: Reliability

| ID | Requirement | Status |
|---|---|---|
| R5.1 | Handle AniList's rate limit (about 90 requests/minute) by reporting the wait, never retry-looping. | Done |
| R5.2 | Stay within a few AniList requests per tool call. | Done (1–2 typical while the list is cached (R5.4), 3–4 when it is fetched. Season lookups walk the sequel chain through the search results, which carry relations, and fetch any seasons search missed two per request: "the new season of my hero academia" takes list, search and write, down from 9) |
| R5.3 | Work with large lists (1,000+ entries). | Planned |
| R5.4 | Cache the user's list briefly and refresh it after writes, to cut AniList requests (needed once hosted, where the rate limit is shared per IP). | Done: the list is reused for 60 seconds; our own writes and deletes patch it, so a read after a write is never stale; changes made elsewhere show up once it expires |
| R5.5 | Warn before the AniList token expires: read the expiry from the token (a JWT) with no request, add a one-line warning with the date and renewal steps to tool results in the last 14 days (on the first call of each server process, then at most once a day), and once expired fail without calling AniList. Tokens that can't be decoded behave as before. | Done |

### R6: Evaluation

| ID | Requirement | Status |
|---|---|---|
| R6.1 | A fixture of real AniList data for franchises that are hard to resolve (many seasons, split cours, movies, sequels with unrelated titles). | Done (197 entries, 25 franchises, one adult title) |
| R6.2 | Deterministic resolver tests: request text + user list → expected entry or "ambiguous". Run in `bun test`. | Done (65 cases) |
| R6.3 | End-to-end evals with a real model: natural-language request → tool calls → final list state, scored on correctness and number of calls. | Done. 2026-11-17, 36 cases: 36/36 correct on Opus 5.5 and Sonnet 5.5, 1.14 and 1.11 tool calls per request, $0.68 and $0.35 per run. Haiku 5.5, two runs on 2026-11-17: 34/36 and 36/36 correct, 1.17 and 1.06 tool calls per request, $0.02 per run. Its misses were its own: it searched first and rated the wrong Kaguya-sama season by ID, and it listed the Attack on Titan candidates without asking a question. Earlier Haiku runs found that "finished the season" requests logged one episode or took two calls; the progress tools now point those to `set_status` COMPLETED |
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
- Recommendations, taste profiling and stats. ani-mcp already covers these; we would need a clear edge to compete here.
- Importing from MyAnimeList or Kitsu.

## Milestones

1. **Resolution and evals**: R1, R6.1–R6.3.
2. **Daily use**: R4 (watch next, done), R2.6 + R3.1 (several shows per request, undo), R2.7 (elicitation), R0.9–R0.11 (rewatches, dates, notes), R2.2, R5.
3. **Hosted**: R7.2, R7.3, R2.8, R6.4.
