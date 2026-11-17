import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import pkg from "../package.json" with { type: "json" };
import { AniListClient, LIST_STATUSES, SEASONS, type BrowseFilters, type LinkOptions, type ListStatus, type Media, type TitleLanguage, type Viewer } from "./anilist";
import {
  describeEntry,
  describePlanDates,
  displayTitle,
  formatScore,
  matchesTitle,
  planProgress,
  planStatus,
  statusLabel,
  todayFuzzy,
  toRawScore,
} from "./logic";
import {
  describeCandidates,
  memo,
  resolveAnime,
  titledWithNumber,
  type AnimeSource,
  type Intent,
  type Resolution,
} from "./resolve";
import { formatHistory, parsePeriod } from "./history";
import { tokenWatch } from "./token";
import {
  airedEpisodes,
  buildReport,
  caughtUpProgress,
  checkTimeZone,
  formatReport,
  formatShow,
  moviesBesideSeries,
  nextSeasons,
} from "./whatsnext";

const anime = z
  .union([z.string().min(1), z.number().int().positive()])
  .describe(
    'The show: any title, abbreviation or season ("jjk", "spy x family season 2", "the new Frieren season"), or an AniList ID as a number.',
  );

const status = z
  .enum(LIST_STATUSES)
  .describe(
    "CURRENT = watching, PLANNING = plan to watch, COMPLETED, DROPPED, PAUSED, REPEATING = rewatching",
  );

/** Tools that take the show by name and change the list. */
export const WRITE_TOOLS = [
  "add_to_list",
  "set_status",
  "rate_anime",
  "mark_episodes_watched",
  "set_progress",
  "remove_from_list",
] as const;

/**
 * Guidance several tools share, sent once as the server's instructions instead of being
 * repeated in each tool description (requirement R2.10). It keeps requests to one call (R2.2).
 */
export const INSTRUCTIONS = `AniConnect manages the user's AniList anime list.

The tools that change the list (${WRITE_TOOLS.join(", ")}) take the show as the user named it ("jjk", "spy x family season 2") and pick the right entry and season from the user's list themselves, so don't search first. If a name is ambiguous, nothing changes and the candidates come back: ask the user which one they mean, then call again with its ID.`;

/** The short form of INSTRUCTIONS on each write tool, for clients that don't show instructions (R2.2). */
const BY_NAME = " Takes the show's name; don't search first.";

type ToolResult = { content: { type: "text"; text: string }[]; isError?: boolean };

function text(body: string): ToolResult {
  return { content: [{ type: "text", text: body }] };
}

/**
 * Makes the wrapper for every tool handler: it turns thrown errors into tool errors the model
 * can read and recover from, fails before any request once the token has expired, and adds a
 * one-line warning when it expires soon.
 */
function safeFor(client: AniListClient, now: () => number) {
  const watch = tokenWatch(client.tokenExpiresAt);
  return <A>(fn: (args: A) => Promise<ToolResult>) =>
    async (args: A): Promise<ToolResult> => {
      const token = watch(now());
      if (token && "expired" in token) return { content: [{ type: "text", text: token.expired }], isError: true };
      let result: ToolResult;
      try {
        result = await fn(args);
      } catch (err) {
        result = { content: [{ type: "text", text: (err as Error).message }], isError: true };
      }
      if (token) result.content.push({ type: "text", text: token.warning });
      return result;
    };
}

/**
 * Adult titles stay out of AniList-wide search unless the user's AniList settings allow them:
 * the `isAdult` argument for searchAnime (false hides them, undefined returns everything).
 */
function adultFilter(viewer: Viewer): false | undefined {
  return viewer.displayAdultContent ? undefined : false;
}

export function clientSource(client: AniListClient, options: LinkOptions = {}): AnimeSource {
  return {
    // Shows already on the list come from here, so they resolve whatever the 18+ setting.
    listMedia: async () =>
      (await client.getMyList()).map(({ media, ...entry }) => ({ ...media, mediaListEntry: entry })),
    search: async (query) => client.searchAnime(query, 15, options, adultFilter(await client.getViewer())),
    getRelated: (ids) => client.getRelated(ids, options),
    searchHidden: async (query) =>
      adultFilter(await client.getViewer()) === false ? client.searchAnime(query, 15, {}, true) : [],
  };
}

/** Next step when only adult titles matched and the user's settings hide them. */
const ADULT_HIDDEN =
  "turn on 18+ content in the user's AniList settings, or use the show's AniList ID (the number in its anilist.co URL).";

/** Finds the show a tool call is about, or throws a message that tells the assistant what to do. */
async function target(
  client: AniListClient,
  input: string | number,
  intent: Intent,
  source: AnimeSource = clientSource(client),
  changes = true,
  /** Tried when `intent` finds nothing, e.g. "remove" (the list alone) then all of AniList. */
  fallback?: Intent,
): Promise<{ media: Media; note: string }> {
  const prefix = changes ? "Nothing was changed. " : "";
  const resolve = async (query: string, src: AnimeSource, language: TitleLanguage) => {
    const r = await resolveAnime(query, intent, src, language);
    return r.kind === "none" && fallback ? resolveAnime(query, fallback, src, language) : r;
  };
  if (typeof input === "number") return { media: await client.getAnime(input), note: "" };
  const { titleLanguage } = await client.getViewer();
  const digits = /^\d+$/.test(input.trim()) ? input.trim() : undefined;
  let r: Resolution;
  if (digits) {
    // All digits: a show titled with that number ("86", "86 Part 2") wins; otherwise it's an
    // AniList ID passed as a string. The resolver only sees titled shows, so one that merely
    // contains the number ("Mob Psycho 100" for "100") can't stand in for a search.
    const titled = (shows: Media[]) => shows.filter((m) => titledWithNumber(m, digits));
    const titledSource: AnimeSource = {
      ...source,
      listMedia: async () => titled(await source.listMedia()),
      search: async (query) => titled(await source.search(query)),
    };
    r = await resolve(input, titledSource, titleLanguage);
    if (r.kind === "none") return { media: await client.getAnime(Number(digits)), note: "" };
    if (r.kind === "match") {
      return {
        media: r.media,
        note: `Matched "${input}" to ${displayTitle(r.media.title, titleLanguage)} by title: ${r.why}. To mean AniList ID ${digits}, pass it as a number.\n`,
      };
    }
    // Ambiguous: falls through to ask, listing only the titled shows.
  } else {
    r = await resolve(input, source, titleLanguage);
  }
  if (r.kind === "match") {
    return { media: r.media, note: `Matched "${input}" to ${displayTitle(r.media.title, titleLanguage)}: ${r.why}.\n` };
  }
  if (r.kind === "ambiguous") {
    throw new Error(
      `${prefix}${r.why} Ask the user which one they mean, then call again with its ID as a number:\n${describeCandidates(r.candidates, titleLanguage)}`,
    );
  }
  // The user may turn the setting on after reading this, so read it again next time.
  if (r.hidden) client.forgetViewer();
  const next = r.hidden
    ? `To use one, ${ADULT_HIDDEN}`
    : "Pass just the show's name, or try search_anime with a different spelling.";
  throw new Error(`${prefix}${r.why} ${next}`);
}

/** AniList's genres (GenreCollection), less the adult-only one. */
const GENRES = [
  "Action", "Adventure", "Comedy", "Drama", "Ecchi", "Fantasy", "Horror", "Mahou Shoujo", "Mecha", "Music",
  "Mystery", "Psychological", "Romance", "Sci-Fi", "Slice of Life", "Sports", "Supernatural", "Thriller",
] as const;
const FORMATS = ["TV", "TV_SHORT", "MOVIE", "SPECIAL", "OVA", "ONA", "MUSIC"] as const;
const AIRING_STATUSES = ["RELEASING", "NOT_YET_RELEASED", "FINISHED", "HIATUS", "CANCELLED"] as const;
const AIRING_LABEL: Record<(typeof AIRING_STATUSES)[number], string> = {
  RELEASING: "airing now",
  NOT_YET_RELEASED: "not yet aired",
  FINISHED: "finished airing",
  HIATUS: "on hiatus",
  CANCELLED: "cancelled",
};
const SORTS: Record<"relevance" | "popularity" | "score" | "newest", { sort: BrowseFilters["sort"]; label: string }> = {
  relevance: { sort: "SEARCH_MATCH", label: "best match first" },
  popularity: { sort: "POPULARITY_DESC", label: "most popular first" },
  score: { sort: "SCORE_DESC", label: "highest rated first" },
  newest: { sort: "START_DATE_DESC", label: "newest first" },
};

function capitalize(word: string): string {
  return word.charAt(0) + word.slice(1).toLowerCase();
}

/** Notes when a search result is the next part of a show the user has completed. */
function continues(media: Media, language: TitleLanguage): string {
  if (media.mediaListEntry && media.mediaListEntry.status !== "PLANNING") return "";
  const done = media.relations?.edges.find(
    (e) =>
      e.relationType === "PREQUEL" &&
      e.node.type === "ANIME" &&
      (e.node.mediaListEntry?.status === "COMPLETED" || e.node.mediaListEntry?.status === "REPEATING"),
  );
  return done?.node.title ? `. Continues ${displayTitle(done.node.title, language)}, which you completed` : "";
}

function dateNum(d: { year: number | null; month: number | null; day: number | null } | null | undefined): number {
  return d?.year ? d.year * 10000 + (d.month ?? 0) * 100 + (d.day ?? 0) : 0;
}

export interface ServerOptions {
  /** Current time in ms; injectable so tests and evals get stable air times. */
  now?: () => number;
}

/** The user's zone from their AniList settings, else the server's (right when it runs on the user's machine). */
function userZone(viewer: Viewer): string {
  return viewer.timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
}

/** How many recently finished shows to check for sequels (one AniList request). */
const SEQUEL_CHECK_LIMIT = 50;

export function createServer(client: AniListClient, options: ServerOptions = {}): McpServer {
  const now = options.now ?? Date.now;
  const safe = safeFor(client, now);
  client.now = now;
  // The user's date in their AniList time zone; without one, the server's local date.
  const today = (viewer: Viewer) => todayFuzzy(new Date(now()), viewer.timeZone ?? undefined);
  const server = new McpServer({ name: "aniconnect", version: pkg.version }, { instructions: INSTRUCTIONS });

  server.registerTool(
    "search_anime",
    {
      title: "Search AniList",
      description:
        "Search all of AniList for anime by title, or browse it by season, year, genre, format and airing status (\"what's airing this season?\", \"best-rated romance from 2023\"). For a title lookup pass just `query`. Returns IDs, whether each show is already on the user's list, and which results continue a show the user completed.",
      inputSchema: {
        query: z.string().min(1).optional().describe("Title to search for, in English, romaji or Japanese"),
        season: z
          .enum(SEASONS)
          .optional()
          .describe(
            "Anime season; needs `year`. WINTER is January-March, SPRING April-June, SUMMER July-September, FALL October-December, so in November \"this winter\" is WINTER of next year.",
          ),
        year: z.number().int().min(1940).max(2100).optional().describe("Year the show aired (with `season`, the season's year)"),
        genres: z.array(z.enum(GENRES)).min(1).optional().describe("Shows with all of these genres"),
        formats: z.array(z.enum(FORMATS)).min(1).optional().describe("Shows in any of these formats"),
        airingStatus: z
          .enum(AIRING_STATUSES)
          .optional()
          .describe("RELEASING = airing now, NOT_YET_RELEASED = announced, FINISHED, HIATUS, CANCELLED"),
        sort: z
          .enum(["popularity", "score", "newest"])
          .optional()
          .describe(
            "Order of results. newest = latest start date, announced shows included. Default: best title match with `query`, else popularity",
          ),
        limit: z.number().int().min(1).max(25).optional().describe("Default 5 for a title search, 10 when browsing"),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    safe(async ({ query, season, year, genres, formats, airingStatus, sort, limit }) => {
      const browsing = Boolean(season || year || genres || formats || airingStatus || sort);
      if (!query && !browsing) throw new Error("Pass a title in `query`, or at least one filter.");
      // "This season" depends on today's date, which only the assistant knows: never guess the year.
      if (season && !year) throw new Error(`Pass \`year\` with \`season\` (${season} of which year?).`);
      const order = sort ? SORTS[sort] : query ? SORTS.relevance : SORTS.popularity;
      const filter = [
        query && `"${query}"`,
        season ? `${capitalize(season)} ${year}` : year && String(year),
        genres?.join(" and "),
        formats?.join(" or "),
        airingStatus && AIRING_LABEL[airingStatus],
      ]
        .filter(Boolean)
        .join(", ");

      const viewer = await client.getViewer();
      const adult = adultFilter(viewer);
      const browse = (isAdult: boolean | undefined) =>
        client.browseAnime(
          { search: query, season, seasonYear: year, genres, formats, status: airingStatus, sort: order.sort, isAdult },
          limit ?? (browsing ? 10 : 5),
        );
      const results = await browse(adult);
      if (results.length === 0) {
        // When nothing else matches, adult titles on the user's list still show.
        const hidden = adult === false ? await browse(true) : [];
        const listed = hidden.filter((m) => m.mediaListEntry);
        const lines = listed.map((m) => describeEntry(m, m.mediaListEntry, viewer));
        if (hidden.length > listed.length) {
          client.forgetViewer();
          lines.push(
            `${listed.length ? "Other" : "Only"} adult (18+) titles match ${filter}; they're hidden because 18+ content is off in the user's AniList settings. To see them, ${ADULT_HIDDEN}`,
          );
        }
        return text(lines.length ? lines.join("\n") : `No anime found for ${filter}.`);
      }
      const lines = results.map((m) => {
        const line = describeEntry(m, m.mediaListEntry, viewer);
        const score = browsing && m.averageScore ? `, AniList score ${m.averageScore}%` : "";
        return `${line}${score}${continues(m, viewer.titleLanguage)}`;
      });
      // Title searches keep their old, header-less shape; browsing says what was searched.
      return text((browsing ? [`${filter}, ${order.label}:`, ...lines] : lines).join("\n"));
    }),
  );

  server.registerTool(
    "search_my_list",
    {
      title: "Search my list",
      description:
        "Answer questions about the user's own AniList anime list as it is now (what they're watching, whether something is on it); for when things happened, use watch_history. Filter by title words and/or list status; leave query empty to list everything in a status.",
      inputSchema: {
        query: z.string().optional().describe("Words that must all appear in the title"),
        status: status.optional(),
        limit: z.number().int().min(1).max(200).default(50),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    safe(async ({ query, status, limit }) => {
      const viewer = await client.getViewer();
      const entries = (await client.getMyList(status)).filter(
        (e) => !query || matchesTitle(e.media, query),
      );
      const filter = [query && `"${query}"`, status && statusLabel(status)].filter(Boolean).join(", ");
      if (entries.length === 0) {
        return text(`Nothing on ${viewer.name}'s list${filter ? ` matching ${filter}` : ""}.`);
      }
      const title = (e: (typeof entries)[number]) => displayTitle(e.media.title, viewer.titleLanguage);
      entries.sort((a, b) => title(a).localeCompare(title(b)));
      const shown = entries.slice(0, limit);
      const lines = shown.map((e) => describeEntry(e.media, e, viewer));
      const header = `${entries.length} match${entries.length === 1 ? "" : "es"} on ${viewer.name}'s list${filter ? ` for ${filter}` : ""}${entries.length > limit ? ` (showing ${limit})` : ""}:`;
      return text([header, ...lines].join("\n"));
    }),
  );

  server.registerTool(
    "whats_next",
    {
      title: "What to watch next",
      description:
        "What the user can watch next: aired episodes they haven't seen for each show they're watching and how long they take, when the next episodes air, shows on hold with episodes left, and the next season of shows they've finished. Pass `anime` to ask about one show (\"when's the next Apothecary Diaries episode?\", \"is there more Frieren?\", \"where can I watch Frieren?\"); that answer also lists the sites streaming it.",
      inputSchema: {
        anime: anime.optional(),
        timeZone: z
          .string()
          .optional()
          .describe('IANA time zone for air times, e.g. "America/New_York". Defaults to the user\'s AniList time zone.'),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    safe(async ({ anime, timeZone }) => {
      const zone = checkTimeZone(timeZone ?? userZone(await client.getViewer()));
      const at = now();
      // Streaming links are only wanted for one show, so only that path's lookups fetch them.
      const source = memo(clientSource(client, { links: anime !== undefined }));
      const list = await source.listMedia();
      const { titleLanguage } = await client.getViewer(); // fetched with the list, so no extra request
      const listStatus = new Map(list.map((m) => [m.id, m.mediaListEntry!.status]));

      if (anime !== undefined) {
        // "status" ranks everything on the list above the rest of AniList, so a finished
        // show is described (with its next season) rather than a similarly named one.
        const { media, note } = await target(client, anime, "status", source, false);
        const show =
          media.relations && media.externalLinks !== undefined
            ? media
            : ((await client.getMany([media.id], { links: true }))[0] ?? media);
        const sequels = nextSeasons([show], listStatus, await client.getMany(moviesBesideSeries([show])));
        return text(`${note}${formatShow(show, sequels, listStatus, at, zone, titleLanguage)}`);
      }

      const finished = list
        .filter((m) => m.mediaListEntry!.status === "COMPLETED")
        .sort((a, b) => dateNum(b.mediaListEntry!.completedAt) - dateNum(a.mediaListEntry!.completedAt))
        .slice(0, SEQUEL_CHECK_LIMIT);
      const withRelations = await client.getMany(finished.map((m) => m.id));
      // Usually no request: only shows with both a series and a movie sequel need one.
      const sequels = nextSeasons(withRelations, listStatus, await client.getMany(moviesBesideSeries(withRelations)));
      return text(formatReport(buildReport(list, sequels, at), at, zone, titleLanguage));
    }),
  );

  server.registerTool(
    "watch_history",
    {
      title: "Watch history",
      description:
        "What the user watched and when, from their AniList activity feed: episodes logged, shows finished, started, dropped or put on hold, newest first, in a time range (\"what did I watch this week?\", \"what did I finish last month?\"). Pass `anime` for one show's history (\"when did I finish Frieren?\").",
      inputSchema: {
        period: z
          .string()
          .optional()
          .describe(
            'Time range in the user\'s words or as dates: "today", "this week", "last week", "last month", "March", "March 2025", "last 30 days", "since June", "2026-03-01 to 2026-03-15", "all time". Weeks start on Monday. Defaults to the last 7 days, or all time when `anime` is given.',
          ),
        anime: anime.optional(),
        timeZone: z
          .string()
          .optional()
          .describe('IANA time zone for dates and times, e.g. "America/New_York". Defaults to the user\'s AniList time zone.'),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    safe(async ({ period, anime, timeZone }) => {
      const zone = checkTimeZone(timeZone ?? userZone(await client.getViewer()));
      const at = now();
      const range = parsePeriod(period ?? (anime === undefined ? "last 7 days" : "all time"), at, zone);
      // Most history is for shows on the list, so try the list alone first ("remove" never
      // searches the rest of AniList): one request (R5.2). A show removed from the list still
      // has history in the feed, so a name the list doesn't have is looked up on AniList.
      const show =
        anime === undefined ? undefined : await target(client, anime, "remove", undefined, false, "lookup");
      const { titleLanguage } = await client.getViewer(); // cached: getMyActivity needs it too
      const { activities, hasNextPage } = await client.getMyActivity({
        from: range.start > 0 ? Math.floor(range.start / 1000) : undefined,
        to: Math.ceil(range.end / 1000),
        mediaId: show?.media.id,
      });
      const body = formatHistory(activities, {
        range,
        now: at,
        timeZone: zone,
        show: show && displayTitle(show.media.title, titleLanguage),
        truncated: hasNextPage,
        language: titleLanguage,
      });
      return text(`${show?.note ?? ""}${body}`);
    }),
  );

  server.registerTool(
    "add_to_list",
    {
      title: "Add to list",
      description:
        "Add an anime to the user's list (plan to watch by default). If it is already on the list, nothing changes; use set_status to move it." + BY_NAME,
      inputSchema: { anime, status: status.default("PLANNING") },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    safe(async ({ anime, status }) => {
      const [viewer, { media, note }] = await Promise.all([client.getViewer(), target(client, anime, "add")]);
      if (media.mediaListEntry) {
        return text(
          `${note}Already on your list, unchanged: ${describeEntry(media, media.mediaListEntry, viewer)}`,
        );
      }
      const plan = planStatus(media, null, status, today(viewer));
      const saved = await client.saveEntry({ mediaId: media.id, ...plan });
      return text(
        `${note}Added: ${describeEntry(saved.media, saved, viewer)}${describePlanDates(plan)}`,
      );
    }),
  );

  server.registerTool(
    "set_status",
    {
      title: "Set list status",
      description:
        "Change an anime's status on the user's list (watching, completed, dropped, ...). Adds it to the list if it isn't there yet. COMPLETED also sets progress to the last episode (when the episode count is known), so use it when the user finished a show or season or watched its finale." + BY_NAME,
      inputSchema: { anime, status },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    safe(async ({ anime, status }) => {
      const [viewer, { media, note }] = await Promise.all([client.getViewer(), target(client, anime, "status")]);
      const entry = media.mediaListEntry;
      const plan = planStatus(media, entry, status, today(viewer));
      const saved = await client.saveEntry({ mediaId: media.id, ...plan });
      const before = entry ? statusLabel(entry.status) : "not on list";
      const reset = plan.progress === 0 && entry ? ` Episode count reset from ${entry.progress} to 0 for the rewatch.` : "";
      return text(
        `${note}${before} -> ${statusLabel(status as ListStatus)}: ${describeEntry(saved.media, saved, viewer)}${reset}${describePlanDates(plan)}`,
      );
    }),
  );

  server.registerTool(
    "rate_anime",
    {
      title: "Rate anime",
      description:
        "Rate an anime on the user's list. The score is always out of 10 (decimals like 7.5 allowed; 0 clears the rating), and AniList shows it in the user's own scoring format. Adds the show to the list if needed." + BY_NAME,
      inputSchema: {
        anime,
        score: z.number().min(0).max(10).describe("Score out of 10. 0 removes the rating."),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    safe(async ({ anime, score }) => {
      const scoreRaw = toRawScore(score);
      const [viewer, { media, note }] = await Promise.all([client.getViewer(), target(client, anime, "rate")]);
      const saved = await client.saveEntry({ mediaId: media.id, scoreRaw });
      return text(
        `${note}Rated ${displayTitle(saved.media.title, viewer.titleLanguage)}: ${formatScore(saved.displayScore, viewer.scoreFormat)}`,
      );
    }),
  );

  // Progress updates read the entry, count from it, and save, so two at once for the same show
  // would both count from the same episode. They take turns per show (#28), and one that read
  // the entry before another's save finished reads it again once it has its turn.
  /** Gives the new episode count from the current one, optionally with a note for the result. */
  type ProgressStep = (current: number, media: Media, language: TitleLanguage) => number | { episodes: number; note: string };
  const progressTurns = new Map<number, Promise<unknown>>();
  let progressSaves = 0;
  const lastProgressSave = new Map<number, number>();

  const applyProgress = async (
    input: string | number,
    next: ProgressStep,
  ) => {
    const readAt = progressSaves;
    const [viewer, resolved] = await Promise.all([client.getViewer(), target(client, input, "progress")]);
    const id = resolved.media.id;
    const turn = (progressTurns.get(id) ?? Promise.resolve())
      .catch(() => {})
      .then(async () => {
        try {
          return await saveProgress(viewer, resolved, readAt, next);
        } finally {
          lastProgressSave.set(id, ++progressSaves);
        }
      });
    progressTurns.set(id, turn);
    try {
      return await turn;
    } finally {
      if (progressTurns.get(id) === turn) progressTurns.delete(id);
    }
  };

  const saveProgress = async (
    viewer: Viewer,
    resolved: { media: Media; note: string },
    readAt: number,
    next: ProgressStep,
  ) => {
    const { note } = resolved;
    // Another update to this show finished (or failed) after this one read it: read it again.
    const stale = (lastProgressSave.get(resolved.media.id) ?? 0) > readAt;
    const media = stale ? await client.getAnime(resolved.media.id) : resolved.media;
    const entry = media.mediaListEntry;
    const before = entry?.progress ?? 0;
    const step = next(before, media, viewer.titleLanguage);
    const { episodes, note: stepNote } = typeof step === "number" ? { episodes: step, note: "" } : step;
    const plan = planProgress(media, entry, episodes, today(viewer));
    const saved = await client.saveEntry({ mediaId: media.id, ...plan });
    const was = entry ? ` (was ${statusLabel(entry.status)})` : "";
    const statusNote = plan.status ? ` Status is now ${statusLabel(plan.status)}${was}.` : "";
    // Saved anyway: AniList's schedule can lag, and some people watch early releases.
    // A show that hasn't premiered has aired nothing, even before AniList lists a schedule.
    const aired = airedEpisodes(media, now()) ?? (media.status === "NOT_YET_RELEASED" ? 0 : null);
    const airedNote =
      aired == null || saved.progress <= aired
        ? ""
        : aired === 0
          ? " Note: AniList says it hasn't started airing yet."
          : ` Note: AniList says only ${aired} episode${aired === 1 ? " has" : "s have"} aired so far.`;
    return text(
      `${note}${displayTitle(saved.media.title, viewer.titleLanguage)}: episode ${before} -> ${saved.progress}.${statusNote}${stepNote}${describePlanDates(plan)}${airedNote}\n${describeEntry(saved.media, saved, viewer)}`,
    );
  };

  server.registerTool(
    "mark_episodes_watched",
    {
      title: "Mark episodes watched",
      description:
        "Mark the next episode(s) of an anime as watched, counting up from the user's current progress. Finishing the last episode marks the show completed; watching something planned, paused or dropped moves it to watching. If the user finished the show or watched its finale, call set_status with COMPLETED instead." + BY_NAME,
      inputSchema: {
        anime,
        count: z.number().int().min(1).default(1).describe("How many more episodes were watched"),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    safe(async ({ anime, count }) => applyProgress(anime, (current) => current + count)),
  );

  server.registerTool(
    "set_progress",
    {
      title: "Set episode progress",
      description:
        "Set exactly how many episodes of an anime the user has watched (e.g. 'I'm on episode 7' -> 7), or \"latest\" when they say they're caught up, so you don't need to look up how many have aired. Same completion rules as mark_episodes_watched." + BY_NAME,
      inputSchema: {
        anime,
        episodes: z
          .union([z.number().int().min(0), z.literal("latest")])
          .describe('Total episodes watched so far, or "latest" for every episode that has aired (the user is caught up)'),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    safe(async ({ anime, episodes }) =>
      applyProgress(anime, (current, media, language) =>
        episodes === "latest" ? caughtUpProgress(media, current, now(), language) : episodes,
      ),
    ),
  );

  server.registerTool(
    "remove_from_list",
    {
      title: "Remove from list",
      description:
        "Delete an anime from the user's list, including its progress, score and dates. Confirm with the user first." + BY_NAME,
      inputSchema: { anime },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
    },
    safe(async ({ anime }) => {
      const { media } = await target(client, anime, "remove");
      // Cached once fetched (resolving a name fetches it), so this is a request only on first use.
      const viewer = await client.getViewer();
      const title = displayTitle(media.title, viewer.titleLanguage);
      if (!media.mediaListEntry) return text(`${title} isn't on your list.`);
      const deleted = await client.deleteEntry(media.mediaListEntry.id);
      return text(deleted ? `Removed ${title} from your list.` : `AniList did not delete ${title}.`);
    }),
  );

  return server;
}
