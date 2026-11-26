import { AsyncLocalStorage } from "node:async_hooks";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ElicitRequestFormParams, ElicitResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import pkg from "../package.json" with { type: "json" };
import {
  AIRING_PAGES,
  AniListClient,
  CALL_WAIT_MS,
  LIST_STATUSES,
  SEASONS,
  searchBatch,
  typeOf,
  type BrowseFilters,
  type FuzzyDate,
  type MediaOptions,
  type ListEntry,
  type ListStatus,
  type Media,
  type MediaType,
  type TitleLanguage,
  type Viewer,
  withWaitDeadline,
} from "./anilist";
import {
  after,
  checkDateOrder,
  NO_DATE,
  parseFuzzyDate,
  showDate,
  describeEntry,
  describePlanDates,
  displayTitle,
  formatScore,
  matchesTitle,
  planProgress,
  planStatus,
  planUpdate,
  planVolumes,
  statusLabel,
  todayFuzzy,
  total,
  toRawScore,
  unit,
  type EntryPlan,
} from "./logic";
import {
  airingRange,
  checkTags,
  formatAiring,
  leftOut,
  pickRecommendations,
  splitGenres,
  yearRange,
  zoneLabel,
  type AiringWhen,
} from "./browse";
import {
  candidateLabel,
  describeCandidates,
  matchScore,
  memo,
  parseQuery,
  resolveAnime,
  titledWithNumber,
  type AnimeSource,
  type Intent,
  type ParsedQuery,
  type Resolution,
} from "./resolve";
import { formatFinished, formatHistory, isPlanAdd, parsePeriod } from "./history";
import { tokenWatch } from "./token";
import { Journal, snapshot, undoGroups, type EntryChange } from "./undo";
import {
  airedEpisodes,
  buildReport,
  caughtUpProgress,
  checkTimeZone,
  formatReport,
  formatShow,
  moviesBesideSeries,
  nextSeasons,
  upcoming,
  watchTime,
} from "./whatsnext";

const anime = z
  .union([z.string().min(1), z.number().int().positive()])
  .describe(
    'The show (or manga): any title, abbreviation or season ("jjk", "spy x family season 2", "the new Frieren season"), or an AniList ID as a number or its anilist.co link.',
  );

/** On the tools that take a show: which of the user's two AniList lists it's on. */
const mediaType = z
  .enum(["anime", "manga"])
  .optional()
  .describe(
    '"manga" when the user means the manga or light novel (they talk about chapters, volumes or reading it); "anime" when they clearly mean the anime. Default anime.',
  );
type TypeArg = z.infer<typeof mediaType>;

const status = z
  .enum(LIST_STATUSES)
  .describe(
    "CURRENT = watching (reading, for a manga), PLANNING = plan to watch, COMPLETED, DROPPED, PAUSED, REPEATING = rewatching (rereading)",
  );

/** On the tools that can fill in today's date as a start or finish date (#38). */
const userTimeZone = z
  .string()
  .optional()
  .describe('IANA time zone for today\'s date ("America/New_York"). Defaults to the user\'s AniList one.');

/** Tools that take the show by name and change the list. */
export const WRITE_TOOLS = [
  "add_to_list",
  "set_status",
  "rate_anime",
  "mark_episodes_watched",
  "set_progress",
  "remove_from_list",
  "update_shows",
] as const;

/**
 * Guidance several tools share, sent once as the server's instructions instead of being
 * repeated in each tool description (requirement R2.10). It keeps requests to one call (R2.2).
 */
export const INSTRUCTIONS = `AniConnect manages the user's AniList anime list.

The tools that change the list (${WRITE_TOOLS.join(", ")}) take the show as the user named it ("jjk", "spy x family season 2") and pick the right entry and season from the user's list themselves, so don't search first. If a name is ambiguous, nothing changes and the candidates come back: ask the user which one they mean, then call again with its ID.

For several shows in one request, or several changes to one show ("finished Frieren, 9/10"), make one update_shows call instead of one call per change.

To take back a change (the user says "undo that" or that you got it wrong), call undo rather than writing the old values back: it restores the entry exactly, dates and all.

To add many shows (an import from a spreadsheet or another site), use update_shows with addOnly, so shows already on the list are never changed, and call it with dryRun first to check what each name matches. In a call about several shows, names that need a choice come back with their candidates while the rest are saved: ask the user about them together.

The same tools manage the user's AniList manga list. When the user is talking about a manga or light novel (they say manga, chapter, volume, or that they read it), pass type "manga", and chapters and volumes rather than episodes ("I read chapter 74 of Chainsaw Man" is set_progress with chapters 74). Without a type a name means the anime, except that a name only on the user's manga list comes back with both to choose from.`;

/** The short form of INSTRUCTIONS on each write tool, for clients that don't show instructions (R2.2). */
const BY_NAME = " Takes the show's name; don't search first.";

type ToolResult = { content: { type: "text"; text: string }[]; isError?: boolean };

function text(body: string): ToolResult {
  return { content: [{ type: "text", text: body }] };
}

/** An entry line, then any sentences about the change (" Start date set to ..."), with a full stop between. */
function entryThen(entry: string, after: string): string {
  return after ? `${entry}.${after}` : entry;
}

/**
 * The tool call being handled, so a form it shows the user goes out with it (see `ask`).
 * Tracked across awaits, since the form is asked for deep inside the call.
 */
const currentCall = new AsyncLocalStorage<string | number | undefined>();

/**
 * Makes the wrapper for every tool handler: it turns thrown errors into tool errors the model
 * can read and recover from, fails before any request once the token has expired, and adds a
 * one-line warning when it expires soon.
 */
function safeFor(client: AniListClient, now: () => number, user: UserState) {
  let watch = user.watches.get(client);
  if (!watch) user.watches.set(client, (watch = tokenWatch(client.tokenExpiresAt, client.renew ?? undefined)));
  return <A>(fn: (args: A) => Promise<ToolResult>) =>
    async (args: A, extra?: { requestId?: string | number }): Promise<ToolResult> =>
      currentCall.run(extra?.requestId, async () => {
        const token = watch(now());
        if (token && "expired" in token) return { content: [{ type: "text", text: token.expired }], isError: true };
        let result: ToolResult;
        try {
          // However many requests the call makes, its waits for the rate limit end in time.
          result = await withWaitDeadline(now() + CALL_WAIT_MS, () => fn(args));
        } catch (err) {
          result = { content: [{ type: "text", text: (err as Error).message }], isError: true };
        }
        if (token) result.content.push({ type: "text", text: token.warning });
        return result;
      });
}

/**
 * Adult titles stay out of AniList-wide search unless the user's AniList settings allow them:
 * the `isAdult` argument for searchAnime and searchMany (false hides them, undefined returns everything).
 */
function adultFilter(viewer: Viewer): false | undefined {
  return viewer.displayAdultContent ? undefined : false;
}

/**
 * Title searches asked for together go to AniList together: update_shows resolves all its
 * shows at once, and one request per `size` searches spares AniList's rate limit.
 * Searches are collected until the work in progress settles (a timer turn), then sent, each
 * request at once and on its own, so one that fails fails only its own searches.
 */
function batched<Q, R>(size: number, run: (queries: Q[]) => Promise<R[]>): (query: Q) => Promise<R> {
  let waiting: { query: Q; resolve: (result: R) => void; reject: (err: unknown) => void }[] = [];
  return (query) =>
    new Promise((resolve, reject) => {
      if (waiting.length === 0) {
        setTimeout(() => {
          const all = waiting;
          waiting = [];
          for (let i = 0; i < all.length; i += size) {
            const batch = all.slice(i, i + size);
            run(batch.map((w) => w.query)).then(
              (results) => batch.forEach((w, j) => w.resolve(results[j]!)),
              (err) => batch.forEach((w) => w.reject(err)),
            );
          }
        }, 0);
      }
      waiting.push({ query, resolve, reject });
    });
}

/** The user's anime (or with `type`, manga) list and AniList's search of them, for the resolver. */
export function clientSource(client: AniListClient, options: MediaOptions = {}, type: MediaType = "ANIME"): AnimeSource {
  const search = batched(searchBatch(options), async (queries: string[]) =>
    client.searchMany(queries, 15, options, adultFilter(await client.getViewer()), type),
  );
  return {
    // Shows already on the list come from here, so they resolve whatever the 18+ setting.
    listMedia: async () =>
      (await client.getMyList(undefined, type)).map(({ media, ...entry }) => ({ ...media, mediaListEntry: entry })),
    search,
    getRelated: (ids) => client.getRelated(ids, options),
    searchHidden: async (query) =>
      adultFilter(await client.getViewer()) === false ? client.searchAnime(query, 15, {}, true, type) : [],
  };
}

/**
 * The type a tool call names: its `type`, MANGA when it counts chapters or volumes, ANIME when it
 * counts episodes. Undefined: not said (anime, with a look at the manga list; see `MANGA_CHECK`).
 */
function namedType(type: TypeArg, units: { episodes?: unknown; chapters?: unknown; volumes?: unknown } = {}): MediaType | undefined {
  const byManga = units.chapters !== undefined || units.volumes !== undefined;
  if (byManga && units.episodes !== undefined) {
    throw new Error("Give episodes (for an anime) or chapters and volumes (for a manga), not both.");
  }
  if (byManga && type === "anime") throw new Error("An anime has episodes, not chapters or volumes: pass episodes, or type \"manga\" for the manga.");
  if (units.episodes !== undefined && type === "manga") throw new Error("A manga counts chapters: pass chapters (and volumes) instead of episodes.");
  if (byManga || type === "manga") return "MANGA";
  return type === "anime" || units.episodes !== undefined ? "ANIME" : undefined;
}

/** "an anime" or "a manga". */
function kindName(type: MediaType): string {
  return type === "MANGA" ? "a manga" : "an anime";
}

/** Refuses a show of the other type than the call named (an anime's ID with chapters, say). */
function checkType(media: Media, type: MediaType | undefined, language: TitleLanguage): void {
  if (!type || typeOf(media) === type) return;
  throw new Error(
    `${displayTitle(media.title, language)} [${media.id}] is ${kindName(typeOf(media))}, not ${kindName(type)}. Pass its name with type "${type.toLowerCase()}" for the ${type.toLowerCase()}, or the ${typeOf(media).toLowerCase()}'s units (${typeOf(media) === "MANGA" ? "chapters" : "episodes"}).`,
  );
}

/** Refuses a tool that works on anime only being given a manga (by its ID or link). */
function animeOnly(media: Media, what: string, language: TitleLanguage): void {
  if (typeOf(media) === "MANGA") {
    throw new Error(`${displayTitle(media.title, language)} is a manga, and ${what} covers anime only.`);
  }
}

/** Next step when only adult titles matched and the user's settings hide them. */
const ADULT_HIDDEN =
  "turn on 18+ content in the user's AniList settings, or use the show's AniList ID (the number in its anilist.co URL).";

/**
 * Shows the user a form through their MCP client (elicitation, R2.7). null when the client
 * can't show one or the request failed, so the caller falls back to asking through the assistant.
 */
type Ask = (params: ElicitRequestFormParams) => Promise<ElicitResult | null>;

/**
 * Asks the user to pick one of several equally likely shows. undefined when they couldn't be
 * asked: no form, or one closed without an answer ("cancel"), which is also what clients that
 * can't show forms right now (Claude Code's non-interactive mode) send back.
 */
async function pick(
  ask: Ask,
  why: string,
  candidates: Media[],
  language: TitleLanguage,
): Promise<{ media: Media } | { declined: true } | undefined> {
  const answer = await ask({
    message: `${why} Which one do you mean?`,
    requestedSchema: {
      type: "object",
      properties: {
        anime: {
          type: "string",
          title: "Show",
          oneOf: candidates.map((m) => ({ const: String(m.id), title: candidateLabel(m, language) })),
        },
      },
      required: ["anime"],
    },
  });
  if (!answer || answer.action === "cancel") return undefined;
  if (answer.action === "decline") return { declined: true };
  const media = candidates.find((m) => String(m.id) === answer.content?.anime);
  return media ? { media } : undefined;
}

/**
 * The show a tool call is about. `fresh` when it was just read from AniList by ID rather than
 * taken from the (possibly cached) list; `loose` when its title matched the name only allowing
 * for a typo, so it may not be the show the user meant.
 */
type Found = { media: Media; note: string; fresh?: boolean; loose?: boolean };

/**
 * Whether a show's titles match a name only allowing for a typo, by every reading of the name.
 * 0 (no match) isn't a typo: a later season reached through its sequel chain can have a title of its own.
 */
function typoOnly(media: Media, input: string): boolean {
  let best = 0;
  for (let q: ParsedQuery | undefined = parseQuery(input); q; q = q.literal) best = Math.max(best, matchScore(media, q));
  return best === 1;
}

/** A link names the show by its ID: https://anilist.co/anime/154587/Sousou-no-Frieren (or /manga/). */
const ANILIST_LINK = /^(?:https?:\/\/)?(?:www\.)?anilist\.co\/(anime|manga)\/(\d+)(?:[/?#]|$)/i;

interface TargetOptions {
  /** Where names are looked up; by default the list and search of `type`. */
  source?: AnimeSource;
  /** Whether the call changes the list, so errors say nothing was changed. */
  changes?: boolean;
  /** Tried when `intent` finds nothing, e.g. "remove" (the list alone) then all of AniList. */
  fallback?: Intent;
  /** Asks the user directly to pick between ambiguous shows, when the client can. */
  ask?: Ask;
  /** The type the call named (see namedType). Unset means anime, with a look at the manga list (see `MANGA_CHECK`). */
  type?: MediaType;
  /** false: no look at the manga list, for a read that covers anime only. */
  mangaCheck?: boolean;
}

/**
 * Intents that, given a name with no type, also look at the user's manga list when the anime it
 * matched isn't on their list: an update to something they only read shouldn't add the anime.
 */
const MANGA_CHECK = new Set<Intent>(["progress", "status", "rate", "remove"]);

/** The manga on the user's manga list a name can mean, if any. */
async function onMangaList(client: AniListClient, query: string, language: TitleLanguage): Promise<Media[]> {
  const r = await resolveAnime(query, "remove", clientSource(client, {}, "MANGA"), language);
  return r.kind === "match" ? [r.media] : r.kind === "ambiguous" ? r.candidates : [];
}

/** Finds the show a tool call is about, or throws a message that tells the assistant what to do. */
async function target(client: AniListClient, input: string | number, intent: Intent, options: TargetOptions = {}): Promise<Found> {
  const { changes = true, fallback, ask, type, mangaCheck = true } = options;
  const source = options.source ?? clientSource(client, {}, type);
  const prefix = changes ? "Nothing was changed. " : "";
  const resolve = async (query: string, src: AnimeSource, language: TitleLanguage) => {
    const r = await resolveAnime(query, intent, src, language);
    return r.kind === "none" && fallback ? resolveAnime(query, fallback, src, language) : r;
  };
  /** A show by its ID, which says by itself whether it's an anime or a manga. */
  const byId = async (id: number, expected = type): Promise<Found> => {
    const media = await client.getMedia(id);
    try {
      checkType(media, expected, (await client.getViewer()).titleLanguage);
    } catch (err) {
      throw new Error(`${prefix}${(err as Error).message}`);
    }
    return { media, note: "", fresh: true };
  };
  if (typeof input === "number") return byId(input);
  const link = ANILIST_LINK.exec(input.trim());
  if (link) {
    const linked: MediaType = link[1]!.toLowerCase() === "manga" ? "MANGA" : "ANIME";
    if (type && type !== linked) throw new Error(`${prefix}That's ${kindName(linked)} link, and the call asked for ${kindName(type)}.`);
    return byId(Number(link[2]), linked);
  }
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
    if (r.kind === "none") return byId(Number(digits));
    if (r.kind === "match") {
      return {
        media: r.media,
        note: `Matched "${input}" to ${displayTitle(r.media.title, titleLanguage)} by title: ${r.why}. To mean AniList ID ${digits}, pass it as a number.\n`,
      };
    }
    // Ambiguous: falls through to ask, listing only the titled shows.
  } else {
    r = await resolve(input, source, titleLanguage);
    // No type named, and the anime matched isn't on the user's list (or none matched): the user may
    // mean a manga they're reading. One request, for the manga list, and only then.
    const anime = r.kind === "match" ? [r.media] : r.kind === "ambiguous" ? r.candidates : [];
    if (!type && mangaCheck && MANGA_CHECK.has(intent) && anime.every((m) => !m.mediaListEntry)) {
      const manga = await onMangaList(client, input, titleLanguage);
      if (manga.length && anime.length) {
        r = {
          kind: "ambiguous",
          candidates: [...anime, ...manga],
          why: `"${input}" is on your manga list, and the anime it matches isn't on your anime list.`,
        };
      } else if (manga.length === 1) {
        // Removing looks at the list alone, so an anime off the list may share the name.
        const missed = intent === "remove" ? "no anime on your list matches" : "no anime matched";
        return {
          media: manga[0]!,
          note: `Matched "${input}" to ${displayTitle(manga[0]!.title, titleLanguage)}, a manga on your list: ${missed}.\n`,
        };
      } else if (manga.length) {
        r = { kind: "ambiguous", candidates: manga, why: `"${input}" matches several manga on your list and no anime.` };
      }
    }
  }
  if (r.kind === "match") {
    return {
      media: r.media,
      note: `Matched "${input}" to ${displayTitle(r.media.title, titleLanguage)}: ${r.why}.\n`,
      loose: typoOnly(r.media, input),
    };
  }
  if (r.kind === "ambiguous") {
    const picked = ask && (await pick(ask, r.why, r.candidates, titleLanguage));
    if (picked && "media" in picked) {
      // The dialog can stay open for minutes, and the list may be refetched meanwhile, so the
      // cache's age says nothing about this show: a write reads it again.
      const media = changes ? await client.getMedia(picked.media.id) : picked.media;
      return { media, note: `The user picked ${displayTitle(media.title, titleLanguage)} from the matches for "${input}".\n`, fresh: changes };
    }
    if (picked) {
      throw new Error(`${prefix}${r.why} The user was shown the matches and didn't pick one, so don't ask them again unless they bring it up.`);
    }
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
/** A manga list's formats: MANGA takes in manhwa and manhua, NOVEL is a light novel. */
const MANGA_FORMATS = ["MANGA", "NOVEL", "ONE_SHOT"] as const;
const AIRING_STATUSES = ["RELEASING", "NOT_YET_RELEASED", "FINISHED", "HIATUS", "CANCELLED"] as const;
const AIRING_LABEL: Record<(typeof AIRING_STATUSES)[number], string> = {
  RELEASING: "airing now",
  NOT_YET_RELEASED: "not yet aired",
  FINISHED: "finished airing",
  HIATUS: "on hiatus",
  CANCELLED: "cancelled",
};
/** Most results search_anime lists at once (per day with `airing`). */
const MAX_RESULTS = 25;
/**
 * Episodes the airing calendar lists by default: 15 for one day, 8 a day for longer ranges. A
 * week held 129 (not adult) on 2026-11-22: about 13,000 characters in full, 9,500 at 15 a day.
 */
const AIRING_ONE_DAY = 15;
const AIRING_PER_DAY = 8;
/** How relevant (0-100) a tag must be to a show to count: Isekai is 50 on the FMA movie, 91 on Mushoku Tensei III. */
const MIN_TAG_RANK = 60;
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

/**
 * Most updates update_shows saves in one call: AniList allows 30 requests a minute, and each
 * show saved is one. A dry run saves nothing, so it checks more names at once.
 */
const UPDATE_LIMIT = 10;
const DRY_RUN_LIMIT = 50;

/** Longest private note AniConnect writes; AniList's own limit is far higher. */
const NOTE_LIMIT = 2000;

/** A note for results, on one line and cut short if long. */
function quoteNote(note: string): string {
  const line = note.replace(/\s*\n\s*/g, " / ");
  return `"${line.length > 300 ? `${line.slice(0, 300)}…` : line}"`;
}

/** One show's change, for the undo journal. */
function change(media: Pick<Media, "id" | "title">, before: Partial<ListEntry> | null, after: Partial<ListEntry> | null): EntryChange {
  return { mediaId: media.id, title: media.title, before: snapshot(before), after: snapshot(after) };
}

/** Activity feed pages (50 updates each) watch_history reads: "last month" for someone logging every episode. */
const HISTORY_PAGES = 3;
/**
 * The most pages it reads when plan-to-watch adds (a list import) fill the feed: each 50 adds
 * read buy one more page, so an import doesn't push the watching out. At most 3 more requests.
 */
const HISTORY_MAX_PAGES = 6;

function dateNum(d: { year: number | null; month: number | null; day: number | null } | null | undefined): number {
  return d?.year ? d.year * 10000 + (d.month ?? 0) * 100 + (d.day ?? 0) : 0;
}

export interface ServerOptions {
  /** Current time in ms; injectable so tests and evals get stable air times. */
  now?: () => number;
  /** State to share between servers for the same user (the hosted server's sessions). */
  user?: UserState;
  /** Set by the hosted server, whose clock's time zone says nothing about the user's (#38). */
  hosted?: boolean;
}

/**
 * What all of one user's servers share: the undo history, the per-show write turns, the undo
 * queue, and when the token warning was last shown. The stdio server has one user; the hosted
 * server makes one per signed-in user, shared by their conversations.
 */
export class UserState {
  readonly journal = new Journal();
  /** Each show's latest write, which the next one waits for. */
  readonly turns = new Map<number, Promise<unknown>>();
  /** Counts saves; a write notes it when it reads the entry. */
  saves = 0;
  /** The count when each show was last saved. */
  readonly lastSave = new Map<number, number>();
  undoing: Promise<unknown> = Promise.resolve();
  /**
   * Removals shown but not yet confirmed, by show: the entry as it was shown, and until when a
   * call with `confirmed: true` may remove it. Here rather than per conversation, so a hosted
   * client that reconnects in between can still confirm.
   */
  readonly pendingRemovals = new Map<number, { entry: string; expires: number }>();
  /** Expiry warnings, one per client: on the hosted server, each sign-in's token expires on its own. */
  readonly watches = new WeakMap<AniListClient, ReturnType<typeof tokenWatch>>();
}

/** After dates filled in as today on the hosted server when the user's time zone is unknown (#38). */
const UTC_NOTE =
  " Today's date was taken in UTC, as the user's time zone is unknown: if theirs differs, fix the dates with update_shows and pass timeZone.";

/** After times and days read in UTC on the hosted server when the user's time zone is unknown. */
const UTC_READ_NOTE =
  "Times and days are in UTC, as the user's time zone is unknown (none is set on AniList): to see them in theirs, call again with timeZone.";

/** How many recently finished shows to check for sequels (one AniList request). */
const SEQUEL_CHECK_LIMIT = 50;

/** How long the user has to answer a form before the tool goes on without them. */
const ASK_TIMEOUT_MS = 10 * 60_000;

const REMOVE_DESCRIPTION =
  "Delete an anime (or manga) from the user's list, including its progress, score, dates and notes.";

/** How long after a removal is shown it can be confirmed with `confirmed: true`. */
const CONFIRM_REMOVAL_MS = 10 * 60_000;

/**
 * A write reads its show again before planning from the cached list when the list is older than
 * this, so a change made on anilist.co or in another app since isn't counted from or overwritten.
 */
const FRESH_LIST_MS = 5_000;

export function createServer(client: AniListClient, options: ServerOptions = {}): McpServer {
  const now = options.now ?? Date.now;
  const user = options.user ?? new UserState();
  const safe = safeFor(client, now, user);
  client.now = now;
  // The user's date in their AniList time zone (or the one the call gave); without one, the
  // server's local date, which is theirs on their own machine. The hosted server takes UTC.
  const today = (viewer: Viewer) => todayFuzzy(new Date(now()), viewer.timeZone ?? (options.hosted ? "UTC" : undefined));
  const zoneUnknown = (viewer: Viewer) => Boolean(options.hosted && !viewer.timeZone);
  /**
   * The zone for times and days the tools read out: the call's, else the user's AniList one,
   * else the server's, which is theirs on their own machine. The hosted server takes UTC and
   * says so (`note`), since its clock's zone says nothing about the user's.
   */
  const readZone = async (timeZone: string | undefined) => {
    const viewer = await client.getViewer();
    if (timeZone) return { zone: checkTimeZone(timeZone), note: "" };
    if (viewer.timeZone) return { zone: checkTimeZone(viewer.timeZone), note: "" };
    if (options.hosted) return { zone: "UTC", note: `\n${UTC_READ_NOTE}` };
    return { zone: Intl.DateTimeFormat().resolvedOptions().timeZone, note: "" };
  };
  /** The latest date the user can mean: with no zone known, the date where it's already tomorrow (UTC+14). */
  const latest = (viewer: Viewer) => (zoneUnknown(viewer) ? todayFuzzy(new Date(now()), "+14:00") : today(viewer));
  /** The viewer, with the time zone the call gave in place of the AniList one. */
  const viewerIn = (timeZone: string | undefined): Promise<Viewer> => {
    const zone = timeZone ? checkTimeZone(timeZone) : undefined;
    return client.getViewer().then((viewer) => (zone ? { ...viewer, timeZone: zone } : viewer));
  };
  /** The dates a plan filled in, saying when "today" was taken in UTC for want of the user's zone. */
  const planDates = (plan: EntryPlan, viewer: Viewer) =>
    `${describePlanDates(plan)}${zoneUnknown(viewer) && (plan.startedAt || plan.completedAt) ? UTC_NOTE : ""}`;
  /**
   * With no zone known, a start date can be a day past today in UTC: a finish date filled in as
   * today moves up to `start`, the one it will be saved with, rather than coming before it.
   */
  const finishFromStart = (viewer: Viewer, plan: EntryPlan, start: FuzzyDate | null | undefined) => {
    if (zoneUnknown(viewer) && start && plan.completedAt && after(start, plan.completedAt)) plan.completedAt = start;
  };
  const server = new McpServer({ name: "aniconnect", version: pkg.version }, { instructions: INSTRUCTIONS });
  /** What this server changed, so it can be undone (R3.1). */
  const { journal, turns, lastSave } = user;

  /** Whether the client can show the user a form (MCP elicitation, R2.7). */
  const canAsk = () => {
    const elicitation = server.server.getClientCapabilities()?.elicitation;
    // An empty capability object means forms, from before URL elicitation existed.
    return Boolean(elicitation && (elicitation.form || !elicitation.url));
  };
  // One form at a time, so update_shows doesn't open several at once.
  let asking: Promise<unknown> = Promise.resolve();
  const ask: Ask = (params) => {
    if (!canAsk()) return Promise.resolve(null);
    // People take a while to choose: allow longer than the usual request timeout. Sent with the
    // tool call: over HTTP, a form not tied to a call goes on the client's separate GET stream,
    // and a client that holds none never gets it while the call waits for an answer.
    const relatedRequestId = currentCall.getStore();
    const answer = asking.then(() =>
      server.server.elicitInput(params, { timeout: ASK_TIMEOUT_MS, relatedRequestId }).catch(() => null),
    );
    asking = answer;
    return answer;
  };
  /** `target` with the user's form at hand for ambiguous names. */
  const find = (input: string | number, intent: Intent, options: Omit<TargetOptions, "ask"> = {}) =>
    target(client, input, intent, { ...options, ask });

  /** Refuses arguments a search_anime mode doesn't take, rather than ignoring them. */
  const onlyWith = (args: Record<string, unknown>, allowed: string[], mode: string) => {
    const extra = Object.keys(args).filter((k) => args[k] !== undefined && !allowed.includes(k));
    if (extra.length) {
      throw new Error(`${mode} takes only ${allowed.slice(1).map((k) => `\`${k}\``).join(", ")}; call again without ${extra.map((k) => `\`${k}\``).join(", ")}.`);
    }
  };

  /** search_anime's `airing`: AniList's schedule for whole days in the user's zone (R4.6). */
  const airingCalendar = async (args: { airing: AiringWhen; timeZone?: string; genres?: string[]; formats?: string[]; limit?: number }) => {
    onlyWith(args, ["airing", "genres", "formats", "limit", "timeZone"], "`airing`");
    const viewer = await client.getViewer();
    const { zone, note } = await readZone(args.timeZone);
    const range = airingRange(args.airing, now(), zone);
    const { airings, truncated } = await client.airingBetween(range.from, range.to);
    // The schedule takes no adult, genre or format argument, so these filter here.
    const kept = airings.filter(
      (a) =>
        (viewer.displayAdultContent || !a.media.isAdult) &&
        (!args.genres || args.genres.every((g) => a.media.genres?.includes(g))) &&
        (!args.formats || (a.media.format !== null && args.formats.includes(a.media.format))),
    );
    const filter = [args.genres?.join(" and "), args.formats?.join(" or ")].filter(Boolean).join(", ");
    const cut = truncated
      ? `\nAniList's schedule has more episodes in this range; only the first ${AIRING_PAGES * 50} were read, so ask for fewer days to see the rest.`
      : "";
    if (kept.length === 0) return text(`Nothing on AniList's schedule airs ${range.label}${filter ? ` (${filter})` : ""}.${cut}${note}`);
    const head = `Episodes airing ${range.label}${filter ? `, ${filter}` : ""}, times in ${zoneLabel(zone)}, from AniList's schedule (it can change):`;
    const perDay = args.limit ?? (range.days === 1 ? AIRING_ONE_DAY : AIRING_PER_DAY);
    const lines = formatAiring(kept, { zone, limit: perDay, maxLimit: MAX_RESULTS, viewer });
    return text(`${[head, ...lines].join("\n")}${cut}${note}`);
  };

  /** search_anime's `similarTo`: AniList users' recommendations for one show, against the user's list. */
  const recommendations = async (args: {
    similarTo: string | number;
    genres?: string[];
    formats?: string[];
    year?: number;
    yearFrom?: number;
    yearTo?: number;
    maxEpisodes?: number;
    limit?: number;
  }) => {
    onlyWith(args, ["similarTo", "genres", "formats", "year", "yearFrom", "yearTo", "maxEpisodes", "limit"], "`similarTo`");
    const viewer = await client.getViewer();
    // Like adding: the first season unless one is named, whatever the user's status on the others,
    // since that's where AniList users leave most recommendations.
    const { media, note } = await find(args.similarTo, "add", { source: memo(clientSource(client)), changes: false });
    animeOnly(media, "similarTo", viewer.titleLanguage);
    const { relatedIds, recommendations } = await client.getRecommendations(media.id);
    // AniList's recommendations take no filters, so the call's apply here.
    const yearOf = (m: Media) => m.seasonYear ?? m.startDate?.year ?? null;
    const matches = (m: Media & { genres: string[] | null }) =>
      (!args.genres || args.genres.every((g) => m.genres?.includes(g))) &&
      (!args.formats || (m.format !== null && args.formats.includes(m.format))) &&
      (!args.year || yearOf(m) === args.year) &&
      (!args.yearFrom || (yearOf(m) ?? 0) >= args.yearFrom) &&
      (!args.yearTo || (yearOf(m) ?? Number.POSITIVE_INFINITY) <= args.yearTo) &&
      (!args.maxEpisodes || (m.episodes !== null && m.episodes <= args.maxEpisodes));
    const picked = pickRecommendations({ id: media.id, relatedIds }, recommendations, viewer.displayAdultContent, matches);
    const title = displayTitle(media.title, viewer.titleLanguage);
    const range = yearRange(args.yearFrom, args.yearTo);
    const filter = [
      args.genres?.join(" and "),
      args.formats?.join(" or "),
      args.year ? String(args.year) : range,
      args.maxEpisodes && `${args.maxEpisodes} episodes or fewer`,
    ]
      .filter(Boolean)
      .join(", ");
    const out = leftOut(picked, filter);
    if (picked.total === 0) {
      // Recommendations with no net votes, lost ones and hidden adult titles don't count.
      const none = recommendations.length ? " with more votes for than against" : "";
      return text(`${note}AniList users haven't recommended anything for ${title}${none}.`);
    }
    if (picked.shown.length === 0) {
      return text(`${note}AniList users recommend ${picked.total} show${picked.total === 1 ? "" : "s"} for ${title}, and none is left: ${out}.`);
    }
    const shown = picked.shown.slice(0, args.limit ?? 10);
    const lines = shown.map(({ media: m, rating, others }) => {
      const score = m.averageScore ? `, AniList score ${m.averageScore}%` : "";
      const seasons = others ? ` (with ${others} other season${others === 1 ? "" : "s"})` : "";
      return `${describeEntry(m, m.mediaListEntry, viewer)}${score}, recommended by ${rating}${seasons}${continues(m, viewer.titleLanguage)}`;
    });
    const more = picked.shown.length - shown.length;
    if (more) lines.push(`${more} more: pass a higher limit.`);
    const head = `AniList users' recommendations for ${title}${filter ? `, ${filter}` : ""}, most recommended first${out ? ` (left out: ${out})` : ""}:`;
    return text(`${note}${[head, ...lines].join("\n")}`);
  };

  server.registerTool(
    "search_anime",
    {
      title: "Search AniList",
      description:
        "Search all of AniList for anime by title, or browse it by season, year, genre, tag, format and airing status (\"what's airing this season?\", \"best-rated isekai from 2023\"). For a title lookup pass just `query`. `airing` lists the episode schedule (\"what airs today?\"); `similarTo`, what AniList users recommend after a show. Returns IDs, AniList scores, whether each show is on the user's list, and which continue one the user completed.",
      inputSchema: {
        query: z.string().min(1).optional().describe("Title to search for, in English, romaji or Japanese"),
        season: z
          .enum(SEASONS)
          .optional()
          .describe(
            "Anime season; needs `year`. WINTER is January-March, SPRING April-June, SUMMER July-September, FALL October-December, so in November \"this winter\" is WINTER of next year.",
          ),
        year: z.number().int().min(1940).max(2100).optional().describe("Year the show aired (with `season`, the season's year)"),
        yearFrom: z.number().int().min(1940).max(2100).optional().describe("Started this year or later"),
        yearTo: z.number().int().min(1940).max(2100).optional().describe("Started this year or earlier"),
        genres: z.array(z.enum(GENRES)).min(1).optional().describe("Shows with all of these genres (Isekai and such are tags)"),
        tags: z.array(z.string().min(1)).min(1).optional().describe('AniList tags, all required ("Isekai", "Iyashikei")'),
        exclude: z.array(z.string().min(1)).min(1).optional().describe("Genres or tags to leave out"),
        formats: z.array(z.enum(FORMATS)).min(1).optional().describe("Shows in any of these formats"),
        airingStatus: z
          .enum(AIRING_STATUSES)
          .optional()
          .describe("RELEASING = airing now, NOT_YET_RELEASED = announced, FINISHED, HIATUS, CANCELLED"),
        maxEpisodes: z.number().int().min(1).max(5000).optional().describe("At most this many episodes"),
        notOnMyList: z.boolean().optional().describe("Leave out shows on the user's list"),
        sort: z
          .enum(["popularity", "score", "newest"])
          .optional()
          .describe(
            "Order of results. newest = latest start date, announced shows included. Default: best title match with `query`, else popularity",
          ),
        airing: z
          .union([z.enum(["today", "tomorrow", "week"]), z.number().int().min(1).max(7)])
          .optional()
          .describe("Episodes airing today, tomorrow, this week or in the next N days; takes genres and formats"),
        timeZone: z.string().optional().describe("IANA time zone for `airing`; defaults to the user's AniList one"),
        similarTo: z
          .union([z.string().min(1), z.number().int().positive()])
          .optional()
          .describe("A show's name or ID: AniList users' recommendations after it, minus shows the user completed or dropped"),
        limit: z.number().int().min(1).max(MAX_RESULTS).optional().describe("Default 5 for a title, 10 when browsing, 8 a day with `airing` (15 for one day)"),
        page: z.number().int().min(1).max(100).optional().describe("For results past `limit`"),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    safe(async (args) => {
      const { airing, similarTo } = args;
      if (airing !== undefined) return airingCalendar({ ...args, airing });
      if (similarTo !== undefined) return recommendations({ ...args, similarTo });
      const { query, season, year, formats, airingStatus, maxEpisodes, notOnMyList, sort, limit, page = 1 } = args;
      // A year inside the range given with it (models send year 2024 with 2024-2024) is that year.
      if (year && ((args.yearFrom && args.yearFrom > year) || (args.yearTo && args.yearTo < year))) {
        throw new Error(`\`year\` ${year} is outside \`yearFrom\`-\`yearTo\`: pass one or the other.`);
      }
      const yearFrom = year ? undefined : args.yearFrom;
      const yearTo = year ? undefined : args.yearTo;
      const browsing = Boolean(
        season || year || yearFrom || yearTo || args.genres || args.tags || args.exclude || formats || airingStatus || maxEpisodes || notOnMyList || sort,
      );
      if (!query && !browsing) throw new Error("Pass a title in `query`, or at least one filter.");
      // "This season" depends on today's date, which only the assistant knows: never guess the year.
      if (season && !year) throw new Error(`Pass \`year\` with \`season\` (${season} of which year?).`);
      // A genre given as a tag is searched as the genre; tags AniList doesn't have come back with the closest ones.
      const wanted = splitGenres(args.tags, GENRES);
      const genres = [...new Set([...(args.genres ?? []), ...wanted.genres])];
      const excluded = splitGenres(args.exclude, GENRES);
      const order = sort ? SORTS[sort] : query ? SORTS.relevance : SORTS.popularity;
      const range = yearRange(yearFrom, yearTo);

      const viewer = await client.getViewer();
      const adult = adultFilter(viewer);
      let tags = wanted.tags;
      let excludeTags = excluded.tags;
      // Tags are checked against AniList's tag list: the cached one, else one fetched with the results.
      const withTags = tags.length > 0 || excludeTags.length > 0;
      const known = withTags ? client.cachedTags() : undefined;
      if (known) {
        tags = checkTags(tags, known, viewer.displayAdultContent);
        excludeTags = checkTags(excludeTags, known, viewer.displayAdultContent);
      }
      const filter = () =>
        [
          query && `"${query}"`,
          season ? `${capitalize(season)} ${year}` : year ? String(year) : range,
          genres.length ? genres.map((g) => (wanted.genres.includes(g) ? `${g} (a genre, so searched as one)` : g)).join(" and ") : "",
          tags.length ? `tagged ${tags.join(" and ")}` : "",
          args.exclude && `without ${[...excluded.genres, ...excludeTags].join(", ")}`,
          formats?.join(" or "),
          airingStatus && AIRING_LABEL[airingStatus],
          maxEpisodes && `${maxEpisodes} episodes or fewer (shows with no episode count left out)`,
          notOnMyList && "not on your list",
        ]
          .filter(Boolean)
          .join(", ");
      const browse = (isAdult: boolean | undefined) =>
        client.browseAnime(
          {
            search: query,
            season,
            seasonYear: year,
            genres: genres.length ? genres : undefined,
            formats,
            status: airingStatus,
            sort: order.sort,
            isAdult,
            tags: tags.length ? tags : undefined,
            // AniList's floor gates exclusions too, so with any, a low-ranked excluded tag would slip past.
            minimumTagRank: tags.length && !excludeTags.length ? MIN_TAG_RANK : undefined,
            excludeGenres: excluded.genres.length ? excluded.genres : undefined,
            excludeTags: excludeTags.length ? excludeTags : undefined,
            onList: notOnMyList ? false : undefined,
            // Both bounds are exclusive, and a start date known only to the year is stored as YYYY0000.
            startAfter: yearFrom ? yearFrom * 10000 - 1 : undefined,
            startBefore: yearTo ? (yearTo + 1) * 10000 : undefined,
            episodesBelow: maxEpisodes ? maxEpisodes + 1 : undefined,
          },
          limit ?? (browsing ? 10 : 5),
          page,
          withTags && !client.cachedTags(),
        );
      const found = await browse(adult);
      if (found.tags) {
        tags = checkTags(tags, found.tags, viewer.displayAdultContent);
        excludeTags = checkTags(excludeTags, found.tags, viewer.displayAdultContent);
      }
      const results = found.media;
      const label = filter() || "All anime";
      if (results.length === 0) {
        // When nothing else matches, adult titles on the user's list still show.
        const hidden = adult === false && page === 1 ? (await browse(true)).media : [];
        const listed = hidden.filter((m) => m.mediaListEntry);
        const lines = listed.map((m) => describeEntry(m, m.mediaListEntry, viewer));
        if (hidden.length > listed.length) {
          client.forgetViewer();
          lines.push(
            `${listed.length ? "Other" : "Only"} adult (18+) titles match ${label}; they're hidden because 18+ content is off in the user's AniList settings. To see them, ${ADULT_HIDDEN}`,
          );
        }
        if (lines.length) return text(lines.join("\n"));
        return text(page > 1 ? `No more results for ${label} past page ${page - 1}.` : `No anime found for ${label}.`);
      }
      const lines = results.map((m) => {
        const line = describeEntry(m, m.mediaListEntry, viewer);
        const score = m.averageScore ? `, AniList score ${m.averageScore}%` : "";
        return `${line}${score}${continues(m, viewer.titleLanguage)}`;
      });
      if (found.hasNextPage) lines.push(`More results: page ${page + 1}.`);
      // Title searches keep their header-less shape; browsing says what was searched.
      const head = `${label}, ${order.label}${page > 1 ? ` (page ${page})` : ""}:`;
      return text((browsing ? [head, ...lines] : lines).join("\n"));
    }),
  );

  server.registerTool(
    "search_my_list",
    {
      title: "Search my list",
      description:
        "Answer questions about the user's own AniList anime list as it is now (what they're watching, whether something is on it, their private notes on a show), or with type \"manga\", their manga list (what they're reading); for when things happened, use watch_history. Filter by title words, list status, score, format (movies: MOVIE) or release year; leave query empty to list everything in a status. Sort plan-to-watch by AniList score or length to pick from it.",
      inputSchema: {
        type: z.enum(["anime", "manga"]).optional().describe('"manga" for the user\'s manga list; default anime'),
        query: z.string().optional().describe("Words that must all appear in the title"),
        status: status.optional(),
        unrated: z.boolean().optional().describe("Only shows without a score (Completed or Rewatching unless `status` is given)"),
        minScore: z.number().min(0).max(10).optional().describe("Lowest score of the user's, out of 10"),
        maxScore: z.number().min(0).max(10).optional().describe("Highest, out of 10"),
        formats: z.array(z.enum([...FORMATS, ...MANGA_FORMATS])).min(1).optional(),
        yearFrom: z.number().int().min(1940).max(2100).optional().describe("Released this year or later"),
        yearTo: z.number().int().min(1940).max(2100).optional().describe("Released this year or earlier"),
        sort: z
          .enum(["title", "score", "finished", "started", "progress", "anilistScore", "length"])
          .optional()
          .describe("score: highest first; finished, started: latest first; progress: most episodes (chapters) first; anilistScore: best on AniList first; length: shortest first"),
        limit: z.number().int().min(1).max(200).default(50),
        offset: z.number().int().min(0).default(0),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    safe(async ({ type, query, status, unrated, minScore, maxScore, formats, yearFrom, yearTo, sort = "title", limit, offset }) => {
      const kind: MediaType = type === "manga" ? "MANGA" : "ANIME";
      const manga = kind === "MANGA";
      const label = (s: ListStatus) => statusLabel(s, { type: kind });
      if (unrated && (minScore !== undefined || maxScore !== undefined)) {
        throw new Error("Pass either `unrated` or a score range (`minScore`, `maxScore`), not both.");
      }
      const viewer = await client.getViewer();
      // Every planned show is unrated, so "unrated" means the ones watched, unless a status says otherwise.
      const unratedStatuses: ListStatus[] = ["COMPLETED", "REPEATING"];
      const year = (m: Media) => m.seasonYear ?? m.startDate?.year ?? null;
      // Scores are compared out of 10 (POINT_10_DECIMAL), whatever the user's own format; unrated is 0.
      const entries = (await client.getMyList(status, kind)).filter(
        (e) =>
          (!query || matchesTitle(e.media, query)) &&
          (!unrated || (e.score === 0 && (status !== undefined || unratedStatuses.includes(e.status)))) &&
          (minScore === undefined || (e.score > 0 && e.score >= minScore)) &&
          (maxScore === undefined || (e.score > 0 && e.score <= maxScore)) &&
          (!formats || (e.media.format !== null && (formats as string[]).includes(e.media.format))) &&
          (yearFrom === undefined || (year(e.media) ?? 0) >= yearFrom) &&
          (yearTo === undefined || (year(e.media) ?? Number.POSITIVE_INFINITY) <= yearTo),
      );
      const scored =
        minScore !== undefined || maxScore !== undefined ? `scored ${minScore ?? 0}-${maxScore ?? 10} out of 10` : "";
      const years = yearRange(yearFrom, yearTo);
      const released = years && `released ${years}`;
      const filter = [
        query && `"${query}"`,
        unrated && "unrated",
        status ? label(status) : unrated && unratedStatuses.map(label).join(" or "),
        scored,
        formats?.join(" or "),
        released,
      ]
        .filter(Boolean)
        .join(", ");
      const listName = `${viewer.name}'s ${manga ? "manga " : ""}list`;
      if (entries.length === 0) {
        return text(`Nothing on ${listName}${filter ? ` matching ${filter}` : ""}.`);
      }
      type Entry = (typeof entries)[number];
      const title = (e: Entry) => displayTitle(e.media.title, viewer.titleLanguage);
      // Largest first; unrated and undated entries (0) go last. Ties fall back to title, then
      // ID, so pages cut from the same list never overlap. Date sorts show the date on each line.
      const dated = (date: FuzzyDate, done: string, noun: string) =>
        date?.year ? `, ${done} ${showDate(date)}` : `, no ${noun} date`;
      const orders = {
        title: { label: "", key: () => 0, show: () => "" },
        score: { label: "highest score first", key: (e: Entry) => e.score, show: () => "" },
        finished: {
          label: "latest finish first",
          key: (e: Entry) => dateNum(e.completedAt),
          show: (e: Entry) => dated(e.completedAt, "finished", "finish"),
        },
        started: {
          label: "latest start first",
          key: (e: Entry) => dateNum(e.startedAt),
          show: (e: Entry) => dated(e.startedAt, "started", "start"),
        },
        progress: { label: `most ${manga ? "chapters" : "episodes"} first`, key: (e: Entry) => e.progress, show: () => "" },
        anilistScore: {
          label: "best AniList score first",
          key: (e: Entry) => e.media.averageScore ?? 0,
          show: (e: Entry) => (e.media.averageScore ? `, AniList score ${e.media.averageScore}%` : ", no AniList score"),
        },
        // Shortest first, so the key is negated; an unknown length goes last. A manga's length is its chapters.
        length: manga
          ? {
              label: "shortest first",
              key: (e: Entry) => (e.media.chapters ? -e.media.chapters : Number.NEGATIVE_INFINITY),
              show: (e: Entry) => (e.media.chapters ? `, ${e.media.chapters} chapters` : ", length unknown"),
            }
          : {
              label: "shortest first",
              key: (e: Entry) => (e.media.episodes && e.media.duration ? -e.media.episodes * e.media.duration : Number.NEGATIVE_INFINITY),
              show: (e: Entry) =>
                e.media.episodes && e.media.duration ? watchTime(e.media.episodes, e.media.duration) : ", length unknown",
            },
      };
      const order = orders[sort];
      // Two unknown lengths subtract to NaN, which falls through to the title like a tie.
      entries.sort(
        (a, b) => order.key(b) - order.key(a) || title(a).localeCompare(title(b)) || a.media.id - b.media.id,
      );
      const shown = entries.slice(offset, offset + limit);
      const lines = shown.map(
        (e) => `${describeEntry(e.media, e, viewer)}${order.show(e)}${e.notes ? `. Note: ${quoteNote(e.notes)}` : ""}`,
      );
      const end = offset + shown.length;
      const head = `${entries.length} match${entries.length === 1 ? "" : "es"} on ${listName}${filter ? ` for ${filter}` : ""}${order.label ? `, ${order.label}` : ""}`;
      if (shown.length === 0) return text(`${head}; offset ${offset} is past the end, so use one below ${entries.length}.`);
      const page =
        offset > 0 || end < entries.length
          ? ` (showing ${offset + 1}-${end}${end < entries.length ? `; offset ${end} for more` : ""})`
          : "";
      const header = `${head}${page}:`;
      return text([header, ...lines].join("\n"));
    }),
  );

  server.registerTool(
    "whats_next",
    {
      title: "What to watch next",
      description:
        "What the user can watch next: aired episodes they haven't seen for each show they're watching and how long they take, when the next episodes air, shows on hold with episodes left, and the next season of shows they've finished. Pass `anime` to ask about one show (\"what's Frieren about?\", \"when's the next Apothecary Diaries episode?\", \"is there more Frieren?\", \"where can I watch it?\"); that answer also gives its synopsis, genres, studio and the sites streaming it.",
      inputSchema: {
        anime: anime.optional(),
        timeZone: z
          .string()
          .optional()
          .describe('IANA time zone for air times, e.g. "America/New_York". Defaults to the user\'s AniList time zone.'),
        all: z.boolean().optional().describe("List every show; by default long sections are cut short"),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    safe(async ({ anime, timeZone, all }) => {
      const { zone, note: zoneNote } = await readZone(timeZone);
      const at = now();
      // Streaming links and what a show is about are only wanted for one show, so only that path's lookups fetch them.
      const source = memo(clientSource(client, { oneShow: anime !== undefined }));
      const list = await source.listMedia();
      const { titleLanguage } = await client.getViewer(); // fetched with the list, so no extra request
      const listStatus = new Map(list.map((m) => [m.id, m.mediaListEntry!.status]));

      if (anime !== undefined) {
        // "show" ranks everything on the list above the rest of AniList, so a finished
        // show is described (with its next season) rather than a similarly named one.
        const { media, note } = await find(anime, "show", { source, changes: false });
        animeOnly(media, "whats_next", titleLanguage);
        const show =
          media.relations && media.externalLinks !== undefined
            ? media
            : ((await client.getMany([media.id], { oneShow: true }))[0] ?? media);
        const sequels = nextSeasons([show], listStatus, await client.getMany(moviesBesideSeries([show])));
        const { displayAdultContent } = await client.getViewer(); // cached
        // The zone note only matters when an air time is printed: formatShow prints one for the next episode alone.
        const timed = Boolean(upcoming(show, at));
        return text(`${note}${formatShow(show, sequels, listStatus, at, zone, titleLanguage, displayAdultContent)}${timed ? zoneNote : ""}`);
      }

      const finished = list
        .filter((m) => m.mediaListEntry!.status === "COMPLETED")
        .sort((a, b) => dateNum(b.mediaListEntry!.completedAt) - dateNum(a.mediaListEntry!.completedAt))
        .slice(0, SEQUEL_CHECK_LIMIT);
      // AniList answers in its own order: put the most recently finished first again, as the report lists them.
      const rank = new Map(finished.map((m, i) => [m.id, i]));
      const withRelations = (await client.getMany(finished.map((m) => m.id))).sort(
        (a, b) => (rank.get(a.id) ?? 0) - (rank.get(b.id) ?? 0),
      );
      // Usually no request: only shows with both a series and a movie sequel need one.
      const sequels = nextSeasons(withRelations, listStatus, await client.getMany(moviesBesideSeries(withRelations)));
      return text(formatReport(buildReport(list, sequels, at), at, zone, titleLanguage, { all, zoneNote }));
    }),
  );

  server.registerTool(
    "watch_history",
    {
      title: "Watch history",
      description:
        "What the user watched and when, from their AniList activity feed: episodes logged, shows finished, started, dropped or put on hold, newest first, in a time range (\"what did I watch this week?\"). Pass `finished: true` for the shows finished in it (\"what did I finish this year?\"), and `anime` for one show's history (\"when did I finish Frieren?\").",
      inputSchema: {
        period: z
          .string()
          .optional()
          .describe(
            'Time range in the user\'s words or as dates: "today", "last night", "this weekend", "last friday", "3 days ago", "this week", "last week", "last month", "March", "March 5th", "March 2025", "last 30 days", "since June", "2026-03-01 to 2026-03-15", "all time". Weeks start on Monday. Defaults to the last 7 days, or all time when `anime` is given.',
          ),
        anime: anime.optional(),
        finished: z
          .boolean()
          .optional()
          .describe("Only the shows finished in the range, from the finish dates on the list and the feed; answers long ranges in one call."),
        timeZone: z
          .string()
          .optional()
          .describe('IANA time zone for dates and times, e.g. "America/New_York". Defaults to the user\'s AniList time zone.'),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    safe(async ({ period, anime, finished, timeZone }) => {
      const { zone, note: zoneNote } = await readZone(timeZone);
      const at = now();
      const range = parsePeriod(period ?? (anime === undefined ? "last 7 days" : "all time"), at, zone);
      // Most history is for shows on the list, so try the list alone first ("remove" searches the
      // rest of AniList only for a title with a mark the listed one lacks, R1.13): one request (R5.2). A show removed from the list still
      // has history in the feed, so a name the list doesn't have is looked up on AniList.
      const show =
        anime === undefined ? undefined : await find(anime, "remove", { changes: false, fallback: "lookup", mangaCheck: false });
      const { titleLanguage } = await client.getViewer(); // cached: getMyActivity needs it too
      if (show) animeOnly(show.media, "watch_history", titleLanguage);
      // Up to HISTORY_PAGES feed pages (HISTORY_MAX_PAGES after a list import), and for
      // finished shows the (usually cached) list, whose finish dates cover any range: a few
      // requests (R5.2).
      const [{ activities, hasNextPage }, list] = await Promise.all([
        client.getMyActivity({
          from: range.start > 0 ? Math.floor(range.start / 1000) : undefined,
          to: Math.ceil(range.end / 1000),
          mediaId: show?.media.id,
          pages: HISTORY_PAGES,
          maxPages: HISTORY_MAX_PAGES,
          light: isPlanAdd,
        }),
        finished ? client.getMyList() : [],
      ]);
      const options = {
        range,
        now: at,
        timeZone: zone,
        show: show && displayTitle(show.media.title, titleLanguage),
        truncated: hasNextPage,
        language: titleLanguage,
        zoneNote,
      };
      const body = finished
        ? formatFinished(show ? list.filter((e) => e.media.id === show.media.id) : list, activities, options)
        : formatHistory(activities, options);
      return text(`${show?.note ?? ""}${body}`);
    }),
  );

  // Writes read the entry, plan from it, save, and record it for undo, so two at once for the
  // same show would both start from the same entry (#28: a lost episode; with undo, a "before"
  // that drops the other write). Writes take turns per show, and one that read the entry
  // before another's save finished reads it again once it has its turn.

  /** Runs `fn` on its show's turn; `stale` says another write to the show finished after `readAt`. */
  const inTurn = async <T>(id: number, readAt: number, fn: (stale: boolean) => Promise<T>): Promise<T> => {
    const turn = (turns.get(id) ?? Promise.resolve())
      .catch(() => {})
      .then(async () => {
        try {
          return await fn((lastSave.get(id) ?? 0) > readAt);
        } finally {
          lastSave.set(id, ++user.saves);
        }
      });
    turns.set(id, turn);
    try {
      return await turn;
    } finally {
      if (turns.get(id) === turn) turns.delete(id);
    }
  };

  /** Whether a show `find` gave came from a list cached long enough to miss changes made elsewhere. */
  const aged = (found: Found) => !found.fresh && client.listAge(typeOf(found.media)) > FRESH_LIST_MS;

  /**
   * Runs `fn` on the show's turn with the show as it is now: read again (with `read`) when
   * another write to it finished in the meantime, or when `found` may be out of date.
   */
  const onTurn = <T>(
    found: Found,
    readAt: number,
    fn: (media: Media) => Promise<T>,
    read = (id: number) => client.getMedia(id),
  ): Promise<T> => {
    const reread = aged(found);
    return inTurn(found.media.id, readAt, async (stale) => fn(stale || reread ? await read(found.media.id) : found.media));
  };

  /** Refuses an episode count (a manga's chapter count) past a show's last, naming the show. */
  const checkEpisodes = (media: Media, progress: number | undefined, language: TitleLanguage) => {
    const last = total(media);
    if (progress === undefined || last == null || progress <= last) return;
    throw new Error(`${displayTitle(media.title, language)} has ${last} ${unit(media, last)}, so ${progress} is past the last one.`);
  };

  /**
   * A name that matched only allowing for a typo may not be the show the user meant, so moving a
   * completed show back to watching on one waits for its ID. A name that matches, an ID, or a
   * rewatch (status REPEATING) writes at once.
   */
  const checkRewind = (
    found: Found,
    media: Media,
    plan: { status?: ListStatus; progress?: number },
    language: TitleLanguage,
  ) => {
    if (!found.loose || media.mediaListEntry?.status !== "COMPLETED" || plan.status !== "CURRENT") return;
    const manga = typeOf(media) === "MANGA";
    throw new Error(
      `${displayTitle(media.title, language)} is completed, and ${unit(media, 1)} ${plan.progress} would move it back to ${statusLabel("CURRENT", media)}. The name matched it only allowing for a typo: check it's the ${manga ? "manga" : "show"} the user meant, and if so, call again with its ID (${media.id}). For a ${manga ? "reread" : "rewatch"}, set the status to REPEATING.`,
    );
  };

  server.registerTool(
    "add_to_list",
    {
      title: "Add to list",
      description:
        "Add an anime (or a manga, with type) to the user's list (plan to watch by default). If it is already on the list, nothing changes; use set_status to move it." + BY_NAME,
      inputSchema: { anime, type: mediaType, status: status.default("PLANNING"), timeZone: userTimeZone },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    safe(async ({ anime, type, status, timeZone }) => {
      const readAt = user.saves;
      const [viewer, resolved] = await Promise.all([viewerIn(timeZone), find(anime, "add", { type: namedType(type) })]);
      const { note } = resolved;
      return onTurn(resolved, readAt, async (media) => {
        if (media.mediaListEntry) {
          return text(
            `${note}Already on your list, unchanged: ${describeEntry(media, media.mediaListEntry, viewer)}`,
          );
        }
        const plan = planStatus(media, null, status, today(viewer));
        const saved = await client.saveEntry({ mediaId: media.id, ...plan });
        journal.record("add_to_list", [change(media, null, saved)]);
        return text(
          `${note}Added: ${entryThen(describeEntry(saved.media, saved, viewer), `${planDates(plan, viewer)}${completedNote(media, status, saved.progress)}`)}`,
        );
      });
    }),
  );

  server.registerTool(
    "set_status",
    {
      title: "Set list status",
      description:
        "Change an anime's (or manga's) status on the user's list (watching, completed, dropped, ...). Adds it to the list if it isn't there yet. COMPLETED also sets progress to the last episode or chapter (when the count is known), so use it when the user finished a show or season or watched its finale." + BY_NAME,
      inputSchema: { anime, type: mediaType, status, timeZone: userTimeZone },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    safe(async ({ anime, type, status, timeZone }) => {
      const readAt = user.saves;
      const [viewer, resolved] = await Promise.all([viewerIn(timeZone), find(anime, "status", { type: namedType(type) })]);
      const { note } = resolved;
      return onTurn(resolved, readAt, async (media) => {
        const entry = media.mediaListEntry;
        const plan = planStatus(media, entry, status, today(viewer));
        finishFromStart(viewer, plan, plan.startedAt ?? entry?.startedAt);
        const saved = await client.saveEntry({ mediaId: media.id, ...plan });
        journal.record("set_status", [change(media, entry, saved)]);
        const before = entry ? statusLabel(entry.status, media) : "not on list";
        const word = unit(media, 1);
        const again = typeOf(media) === "MANGA" ? "reread" : "rewatch";
        const reset =
          plan.progress === 0 && entry ? ` ${word[0]!.toUpperCase()}${word.slice(1)} count reset from ${entry.progress} to 0 for the ${again}.` : "";
        return text(
          `${note}${before} -> ${statusLabel(status as ListStatus, media)}: ${entryThen(describeEntry(saved.media, saved, viewer), `${reset}${planDates(plan, viewer)}${completedNote(media, status, saved.progress)}`)}`,
        );
      });
    }),
  );

  server.registerTool(
    "rate_anime",
    {
      title: "Rate anime",
      description:
        "Rate an anime (or manga) on the user's list. The score is always out of 10 (decimals like 7.5 allowed; 0 clears the rating), and AniList shows it in the user's own scoring format. Adds the show to the list if needed." + BY_NAME,
      inputSchema: {
        anime,
        type: mediaType,
        score: z.number().min(0).max(10).describe("Score out of 10. 0 removes the rating."),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    safe(async ({ anime, type, score }) => {
      const scoreRaw = toRawScore(score);
      const readAt = user.saves;
      const [viewer, resolved] = await Promise.all([client.getViewer(), find(anime, "rate", { type: namedType(type) })]);
      const { note } = resolved;
      return onTurn(resolved, readAt, async (media) => {
        if (score === 0 && !media.mediaListEntry) {
          return text(`${note}${displayTitle(media.title, viewer.titleLanguage)} isn't on your list, so there's no rating to clear.`);
        }
        const saved = await client.saveEntry({ mediaId: media.id, scoreRaw });
        journal.record("rate_anime", [change(media, media.mediaListEntry, saved)]);
        const title = displayTitle(saved.media.title, viewer.titleLanguage);
        const rated = formatScore(saved.displayScore, viewer.scoreFormat);
        // Rating a show that isn't on the list adds it, in whatever status AniList gives it.
        return text(
          media.mediaListEntry
            ? `${note}Rated ${title}: ${rated}`
            : `${note}Added ${title} to your list as ${statusLabel(saved.status, saved.media)} and rated it ${rated}.`,
        );
      });
    }),
  );

  /** Gives the new episode (a manga's chapter) count from the current one, optionally with a note for the result. */
  type ProgressStep = (current: number, media: Media, language: TitleLanguage) => number | { episodes: number; note: string };

  /**
   * Changes a show's progress: its episode or chapter count with `next`, a manga's volume count
   * with `volumes`, or both.
   */
  const applyProgress = async (
    tool: string,
    input: string | number,
    timeZone: string | undefined,
    type: MediaType | undefined,
    next: ProgressStep | undefined,
    volumes?: number,
  ) => {
    const readAt = user.saves;
    const [viewer, resolved] = await Promise.all([viewerIn(timeZone), find(input, "progress", { type })]);
    return onTurn(resolved, readAt, (media) => saveProgress(tool, viewer, resolved, media, next, volumes));
  };

  /**
   * "latest": every episode that has aired, or every chapter of a manga AniList has a count for
   * (it counts a manga's chapters only once it has finished).
   */
  const caughtUp = (media: Media, current: number, language: TitleLanguage) => {
    if (typeOf(media) !== "MANGA") return caughtUpProgress(media, current, now(), language);
    if (media.chapters) return { episodes: media.chapters, note: " That's every chapter." };
    throw new Error(
      `Nothing was changed. AniList doesn't count the chapters of ${displayTitle(media.title, language)} until it has finished, so it can't tell which is the latest. Ask the user which chapter they're on, then call again with that number.`,
    );
  };

  /** Says when progress runs past what has aired. Saved anyway: AniList's schedule can lag, and some people watch early releases. */
  const airedNote = (media: Media, progress: number) => {
    // A manga has no airing schedule, and its chapter count is checked before saving.
    if (typeOf(media) === "MANGA") return "";
    // A show that hasn't premiered has aired nothing, even before AniList lists a schedule.
    const aired = airedEpisodes(media, now()) ?? (media.status === "NOT_YET_RELEASED" ? 0 : null);
    if (aired == null || progress <= aired) return "";
    return aired === 0
      ? " Note: AniList says it hasn't started airing yet."
      : ` Note: AniList says only ${aired} episode${aired === 1 ? " has" : "s have"} aired so far.`;
  };

  /** For a show set Completed: says when that's more episodes than have aired (#40). */
  const completedNote = (media: Media, status: ListStatus, progress: number) =>
    status !== "COMPLETED"
      ? ""
      : // Completing an unreleased show is worth flagging even when its episode count is unknown and progress stays 0.
        airedNote(media, media.status === "NOT_YET_RELEASED" ? Math.max(progress, 1) : progress);

  const saveProgress = async (
    tool: string,
    viewer: Viewer,
    resolved: Found,
    media: Media,
    next: ProgressStep | undefined,
    volumes: number | undefined,
  ) => {
    const { note } = resolved;
    const entry = media.mediaListEntry;
    const before = entry?.progress ?? 0;
    let plan: EntryPlan;
    let stepNote = "";
    try {
      if (next) {
        const step = next(before, media, viewer.titleLanguage);
        let episodes: number;
        ({ episodes, note: stepNote } = typeof step === "number" ? { episodes: step, note: "" } : step);
        checkEpisodes(media, episodes, viewer.titleLanguage);
        plan = planProgress(media, entry, episodes, today(viewer));
        checkRewind(resolved, media, plan, viewer.titleLanguage);
        // Volumes alongside chapters only set the count: the chapters settle the status.
        if (volumes !== undefined) plan.progressVolumes = planVolumes(media, entry, volumes, today(viewer)).progressVolumes;
      } else {
        plan = planVolumes(media, entry, volumes ?? 0, today(viewer));
      }
    } catch (err) {
      // Said with the show it matched, so the assistant can tell when it isn't the one meant.
      throw new Error(`Nothing was changed. ${note}${(err as Error).message.replace(/^Nothing was changed\. /, "")}`);
    }
    finishFromStart(viewer, plan, plan.startedAt ?? entry?.startedAt);
    const saved = await client.saveEntry({ mediaId: media.id, ...plan });
    journal.record(tool, [change(media, entry, saved)]);
    const statusNote = !entry
      ? ` Added to your list as ${statusLabel(saved.status, media)}.`
      : plan.status
        ? ` Status is now ${statusLabel(plan.status, media)} (was ${statusLabel(entry.status, media)}).`
        : "";
    const counts = [
      next && `${unit(media, 1)} ${before} -> ${saved.progress}`,
      volumes !== undefined && `volume ${entry?.progressVolumes ?? 0} -> ${saved.progressVolumes ?? 0}`,
    ]
      .filter(Boolean)
      .join(", ");
    return text(
      `${note}${displayTitle(saved.media.title, viewer.titleLanguage)}: ${counts}.${statusNote}${stepNote}${planDates(plan, viewer)}${airedNote(media, saved.progress)}\n${describeEntry(saved.media, saved, viewer)}`,
    );
  };

  server.registerTool(
    "mark_episodes_watched",
    {
      title: "Mark episodes watched",
      description:
        "Mark the next episode(s) of an anime as watched (or with type \"manga\", the next chapter(s) of a manga as read), counting up from the user's current progress. Finishing the last episode marks the show completed; watching something planned, paused or dropped moves it to watching. If the user finished the show or watched its finale, call set_status with COMPLETED instead." + BY_NAME,
      inputSchema: {
        anime,
        type: mediaType,
        count: z.number().int().min(1).default(1).describe("How many more episodes were watched (chapters read, for a manga)"),
        timeZone: userTimeZone,
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    safe(async ({ anime, type, count, timeZone }) =>
      applyProgress("mark_episodes_watched", anime, timeZone, namedType(type), (current) => current + count),
    ),
  );

  server.registerTool(
    "set_progress",
    {
      title: "Set episode progress",
      description:
        "Set exactly how many episodes of an anime the user has watched (e.g. 'I'm on episode 7' -> 7), or \"latest\" when they say they're caught up, so you don't need to look up how many have aired. For a manga, set chapters and/or volumes instead ('I read chapter 74' -> chapters 74). Same completion rules as mark_episodes_watched." + BY_NAME,
      inputSchema: {
        anime,
        type: mediaType,
        episodes: z
          .union([z.number().int().min(0), z.literal("latest")])
          .optional()
          .describe('Total episodes watched so far, or "latest" for every episode that has aired (the user is caught up)'),
        chapters: z
          .union([z.number().int().min(0), z.literal("latest")])
          .optional()
          .describe('For a manga: total chapters read so far, or "latest" for every chapter of a finished manga'),
        volumes: z.number().int().min(0).optional().describe("For a manga: total volumes read so far"),
        timeZone: userTimeZone,
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    safe(async ({ anime, type, episodes, chapters, volumes, timeZone }) => {
      const kind = namedType(type, { episodes, chapters, volumes });
      const count = episodes ?? chapters;
      if (count === undefined && volumes === undefined) {
        throw new Error("Nothing was changed. Pass episodes (for an anime), or chapters or volumes (for a manga).");
      }
      const next: ProgressStep | undefined =
        count === undefined ? undefined : (current, media, language) => (count === "latest" ? caughtUp(media, current, language) : count);
      return applyProgress("set_progress", anime, timeZone, kind, next, volumes);
    }),
  );

  const date = z
    .string()
    .regex(/^(\d{4}(-\d{1,2}(-\d{1,2})?)?|clear)$/, 'YYYY-MM-DD, YYYY-MM, YYYY or "clear"')
    .describe('YYYY-MM-DD, or YYYY-MM or YYYY when the user only gives the month or year; "clear" removes it');
  const updateItem = z.object({
    anime,
    type: mediaType,
    status: status.optional(),
    episodes: z
      .union([z.number().int().min(0), z.literal("latest")])
      .optional()
      .describe('Total episodes watched so far ("on episode 7" -> 7), or "latest" when the user is caught up'),
    chapters: z
      .union([z.number().int().min(0), z.literal("latest")])
      .optional()
      .describe('For a manga: total chapters read so far ("read chapter 74" -> 74), or "latest" for every chapter of a finished manga'),
    volumes: z.number().int().min(0).optional().describe("For a manga: total volumes read so far"),
    watched: z
      .number()
      .int()
      .min(1)
      .optional()
      .describe('Episodes watched (chapters read, for a manga) since the last update, counted up from current progress ("two more" -> 2)'),
    score: z.number().min(0).max(10).optional().describe("Score out of 10; 0 removes the rating"),
    startedAt: date.optional().describe("When the user started watching, if they say (\"I started it last March\")"),
    completedAt: date.optional().describe("When the user finished it, if they say (\"I actually finished it in 2023\")"),
    notes: z.string().max(NOTE_LIMIT).optional().describe('Replaces the private note on the entry; "" removes it'),
    addNote: z
      .string()
      .min(1)
      .max(NOTE_LIMIT)
      .optional()
      .describe("Added to the end of the private note, on a new line, keeping what's there"),
  });
  type Update = z.infer<typeof updateItem>;

  /** What one update_shows item would write, worked out from the show's entry as it is now. */
  const planItem = (viewer: Viewer, found: Found, media: Media, u: Update) => {
    const entry = media.mediaListEntry;
    // Clearing a score, note or date on a show that isn't on the list would only add it.
    const clearsOnly =
      u.status === undefined && u.episodes === undefined && u.watched === undefined && u.addNote === undefined && u.volumes === undefined &&
      (u.score ?? 0) === 0 && (u.notes ?? "") === "" && (u.startedAt ?? "clear") === "clear" && (u.completedAt ?? "clear") === "clear";
    if (!entry && clearsOnly) {
      throw new Error(`${displayTitle(media.title, viewer.titleLanguage)} isn't on your list, so there's nothing to clear.`);
    }
    const current = entry?.progress ?? 0;
    const day = today(viewer);
    let progress: number | undefined;
    let stepNote = "";
    if (u.watched !== undefined) {
      // Starting a rewatch resets the count to 0, so the episodes watched count up from there.
      const resets = u.status === "REPEATING" && planStatus(media, entry, u.status, day).progress === 0;
      progress = (resets ? 0 : current) + u.watched;
    } else if (u.episodes === "latest") {
      ({ episodes: progress, note: stepNote } = caughtUp(media, current, viewer.titleLanguage));
    } else progress = u.episodes;
    checkEpisodes(media, progress, viewer.titleLanguage);
    const plan = planUpdate(media, entry, { progress, status: u.status }, day);
    if (u.volumes !== undefined) {
      const volumes = planVolumes(media, entry, u.volumes, day);
      // Alone, volumes move a planned manga to reading, as chapters would; otherwise the chapters and status settle it.
      if (progress === undefined && u.status === undefined) Object.assign(plan, volumes);
      else plan.progressVolumes = u.volumes;
    }
    if (u.status === undefined) checkRewind(found, media, plan, viewer.titleLanguage);
    // Dates the user gave replace the ones a status change would fill in, and existing ones too.
    const readDate = (text: string) => (text === "clear" ? NO_DATE : parseFuzzyDate(text, day, latest(viewer)));
    const dates = {
      ...(u.startedAt !== undefined && { startedAt: readDate(u.startedAt) }),
      ...(u.completedAt !== undefined && { completedAt: readDate(u.completedAt) }),
    };
    // "Finished it on the 2nd" with Completed: today would be a start date after the finish, so leave it unset.
    if (dates.completedAt && plan.startedAt && after(plan.startedAt, dates.completedAt)) delete plan.startedAt;
    finishFromStart(viewer, plan, dates.startedAt ?? plan.startedAt ?? entry?.startedAt);
    if (u.startedAt !== undefined || u.completedAt !== undefined) {
      checkDateOrder(
        dates.startedAt ?? plan.startedAt ?? entry?.startedAt,
        dates.completedAt ?? plan.completedAt ?? entry?.completedAt,
      );
    }
    const scoreRaw = u.score === undefined ? undefined : toRawScore(u.score);
    const oldNote = entry?.notes ?? "";
    const notes = u.addNote !== undefined ? (oldNote ? `${oldNote}\n${u.addNote}` : u.addNote) : u.notes;
    if (notes !== undefined && notes.length > NOTE_LIMIT) throw new Error(`The note would be over ${NOTE_LIMIT} characters.`);
    // Dates the user gave are said with the change; only the ones filled in for them are worth a note.
    const filled = { ...plan, ...(u.startedAt !== undefined && { startedAt: undefined }), ...(u.completedAt !== undefined && { completedAt: undefined }) };
    return { media, entry, current, progress, stepNote, plan, dates, scoreRaw, notes, oldNote, filled };
  };
  type ItemPlan = ReturnType<typeof planItem>;

  /** What an update changes, from the entry before and the entry after it (saved, or as it would be). */
  const describeChange = (
    viewer: Viewer,
    u: Update,
    p: ItemPlan,
    next: {
      status?: ListStatus;
      progress: number;
      progressVolumes?: number | null;
      score: string;
      /** The score before, when `score` isn't in the user's own format. */
      scoreBefore?: string;
      startedAt?: FuzzyDate | null;
      completedAt?: FuzzyDate | null;
      notes?: string | null;
    },
  ) => {
    const { media, entry, current } = p;
    return [
      entry?.status !== next.status &&
        `${entry ? statusLabel(entry.status, media) : "not on list"} -> ${next.status ? statusLabel(next.status, media) : "on list"}`,
      (p.progress !== undefined || current !== next.progress) && `${unit(media, 1)} ${current} -> ${next.progress}`,
      (u.volumes !== undefined || (p.plan.progressVolumes ?? entry?.progressVolumes ?? 0) !== (entry?.progressVolumes ?? 0)) &&
        `volume ${entry?.progressVolumes ?? 0} -> ${next.progressVolumes ?? 0}`,
      u.score !== undefined && `score ${next.scoreBefore ?? formatScore(entry?.displayScore ?? 0, viewer.scoreFormat)} -> ${next.score}`,
      u.startedAt !== undefined && `start date ${showDate(entry?.startedAt)} -> ${showDate(next.startedAt)}`,
      u.completedAt !== undefined && `finish date ${showDate(entry?.completedAt)} -> ${showDate(next.completedAt)}`,
      p.notes !== undefined && (next.notes ? `note is now ${quoteNote(next.notes)}` : p.oldNote ? "note removed" : "no note"),
    ]
      .filter(Boolean)
      .join(", ");
  };

  /** One update_shows item, on its show's turn: a line for the result and the change for undo. */
  const saveUpdate = async (viewer: Viewer, resolved: Found, media: Media, u: Update) => {
    const p = planItem(viewer, resolved, media, u);
    const saved = await client.saveEntry({ mediaId: media.id, ...p.plan, ...p.dates, scoreRaw: p.scoreRaw, notes: p.notes });
    const parts = describeChange(viewer, u, p, { ...saved, score: formatScore(saved.displayScore, viewer.scoreFormat) });
    const title = displayTitle(saved.media.title, viewer.titleLanguage);
    return {
      line: `${resolved.note}${title}: ${parts || "no change"}.${p.stepNote}${describePlanDates(p.filled)}${airedNote(media, saved.progress)}\n${describeEntry(saved.media, saved, viewer)}`,
      change: change(media, p.entry, saved),
      filled: Boolean(p.filled.startedAt || p.filled.completedAt),
    };
  };

  /** One update_shows item in a dry run: what it would change, saving nothing. */
  const previewUpdate = (viewer: Viewer, resolved: Found, u: Update) => {
    const { media } = resolved;
    const p = planItem(viewer, resolved, media, u);
    const progress = p.plan.progress ?? p.current;
    const parts = describeChange(viewer, u, p, {
      status: p.plan.status ?? p.entry?.status,
      progress,
      progressVolumes: p.plan.progressVolumes ?? p.entry?.progressVolumes,
      // Out of 10 on both sides: AniList puts it in the user's format only once saved.
      score: u.score ? `${u.score}/10` : "unrated",
      scoreBefore: p.entry?.score ? `${p.entry.score}/10` : "unrated",
      startedAt: p.dates.startedAt ?? p.plan.startedAt ?? p.entry?.startedAt,
      completedAt: p.dates.completedAt ?? p.plan.completedAt ?? p.entry?.completedAt,
      notes: p.notes ?? p.oldNote,
    });
    const title = displayTitle(media.title, viewer.titleLanguage);
    return `${resolved.note}${title}: ${parts || "no change"}.${p.stepNote}${describePlanDates(p.filled)}${airedNote(media, progress)}\n${describeEntry(media, p.entry, viewer)}`;
  };

  server.registerTool(
    "update_shows",
    {
      title: "Update shows",
      description:
        "Make several list changes in one call: to several shows (\"watched eps 3-5 of JJK and the Dandadan finale\") or several things about one show (\"finished Frieren, 9/10\"). Also the only way to set or correct start and finish dates (\"I actually finished it last March\") and to write the user's private notes on a show. Each update names a show plus any of status, episodes (chapters and volumes, for a manga), watched, score, dates and notes, with the same rules as set_status, set_progress, mark_episodes_watched and rate_anime. Updates that are ambiguous or fail are listed with the reason, and the rest are still saved. For adding many shows (an import), pass addOnly, and dryRun first to check what each name matches." +
        BY_NAME,
      inputSchema: {
        updates: z
          .array(updateItem)
          .min(1)
          .max(DRY_RUN_LIMIT)
          .describe(`One per show: up to ${UPDATE_LIMIT}, or ${DRY_RUN_LIMIT} with dryRun`),
        addOnly: z
          .boolean()
          .optional()
          .describe(
            "Only add shows that aren't on the list yet (plan to watch unless a status, episodes or dates say otherwise); shows already on it are left unchanged. Use when adding or importing shows.",
          ),
        dryRun: z
          .boolean()
          .optional()
          .describe("Save nothing: say which show each name matches and what would change, so the matches can be checked first"),
        timeZone: userTimeZone,
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    safe(async ({ updates, addOnly, dryRun, timeZone }) => {
      if (!dryRun && updates.length > UPDATE_LIMIT) {
        throw new Error(
          `Up to ${UPDATE_LIMIT} updates are saved per call (${DRY_RUN_LIMIT} with dryRun, which saves nothing); split them across calls.`,
        );
      }
      const readAt = user.saves;
      const viewer = await viewerIn(timeZone);
      const sources: Record<MediaType, AnimeSource> = {
        ANIME: memo(clientSource(client)),
        MANGA: memo(clientSource(client, {}, "MANGA")),
      };
      // A form for one show only: in a batch, the names that need a choice come back together
      // for the assistant to ask about at once, rather than each stopping the call to ask.
      const askUser = updates.length === 1 && !dryRun ? ask : undefined;
      // A link is its ID; one of the other type than the update names stays as it is, for target to refuse.
      updates = updates.map((u) => {
        const link = typeof u.anime === "string" ? ANILIST_LINK.exec(u.anime.trim()) : null;
        const linked = link?.[1]!.toLowerCase();
        return link && (!u.type || u.type === linked) ? { ...u, anime: Number(link[2]), type: linked as TypeArg } : u;
      });
      // Shows given by ID, fetched together: one request rather than one each.
      const ids = [...new Set(updates.map((u) => u.anime).filter((a): a is number => typeof a === "number"))];
      // If that fails, each show is looked up on its own and reports its own error.
      const fetched = ids.length > 1 ? await client.getMany(ids).catch(() => []) : [];
      const byId = new Map(fetched.map((m) => [m.id, m]));
      // Shows read again before saving (see `onTurn`), fetched together too.
      // If that fails, each show is read on its own, so one failed request doesn't fail them all.
      const reread = batched(50, async (ids: number[]) => {
        const shows = new Map((await client.getMany(ids).catch(() => [])).map((m) => [m.id, m]));
        return ids.map((id) => shows.get(id));
      });
      const read = async (id: number) => (await reread(id)) ?? client.getMedia(id);
      // In the order they were saved, so undo can take them back newest first.
      const changes: EntryChange[] = [];
      type ItemResult = { line: string; change?: EntryChange; filled?: boolean; kept?: boolean; ok?: boolean };
      const results = await Promise.all(
        updates.map(async (u): Promise<ItemResult> => {
          const label = typeof u.anime === "number" ? `ID ${u.anime}` : `"${u.anime}"`;
          try {
            const kind = namedType(u.type, u);
            // A manga's chapters count as its episodes do from here on.
            if (u.chapters !== undefined) u = { ...u, episodes: u.chapters };
            if (u.episodes !== undefined && u.watched !== undefined) {
              throw new Error(`Give ${kind === "MANGA" ? "chapters" : "episodes"} or watched, not both.`);
            }
            const counts = u.episodes !== undefined || u.watched !== undefined || u.volumes !== undefined;
            // A show added with no status or episodes: completed if it has a finish date, watching
            // if it has a start date, else plan to watch, as with add_to_list.
            if (addOnly && u.status === undefined && !counts) {
              u = { ...u, status: u.completedAt ? "COMPLETED" : u.startedAt ? "CURRENT" : "PLANNING" };
            }
            if (u.notes !== undefined && u.addNote !== undefined) throw new Error("Give notes or addNote, not both.");
            const dated = u.startedAt !== undefined || u.completedAt !== undefined;
            const noted = u.notes !== undefined || u.addNote !== undefined;
            if (!counts && !dated && !noted && u.status === undefined && u.score === undefined) {
              throw new Error("Nothing to change: give status, episodes, watched, score, a date or a note.");
            }
            // Adding means season 1 and all of AniList, like add_to_list. A rewatch is of a show
            // already on the list, never the next season (#35).
            const intent: Intent = addOnly
              ? "add"
              : counts && u.status !== "REPEATING"
                ? "progress"
                : u.status || dated || noted
                  ? "status"
                  : "rate";
            const known = typeof u.anime === "number" ? byId.get(u.anime) : undefined;
            if (known) checkType(known, kind, viewer.titleLanguage);
            const resolved: Found = known
              ? { media: known, note: "", fresh: true }
              : await target(client, u.anime, intent, { source: sources[kind ?? "ANIME"], changes: false, ask: askUser, type: kind });
            const kept = (media: Media) => ({
              line: `${resolved.note}Already on your list, unchanged: ${describeEntry(media, media.mediaListEntry, viewer)}`,
              kept: true,
            });
            if (dryRun) {
              if (addOnly && resolved.media.mediaListEntry) return kept(resolved.media);
              return { line: previewUpdate(viewer, resolved, u), ok: true };
            }
            return await onTurn(
              resolved,
              readAt,
              async (media) => {
                if (addOnly && media.mediaListEntry) return kept(media);
                const result = await saveUpdate(viewer, resolved, media, u);
                changes.push(result.change);
                return { ...result, ok: true };
              },
              read,
            );
          } catch (err) {
            return { line: `Not changed: ${label}: ${(err as Error).message.replace(/^Nothing was changed\. /, "")}` };
          }
        }),
      );
      // Said once for the whole batch, not on every line.
      const utc = zoneUnknown(viewer) && results.some((r) => r.filled) ? `\n${UTC_NOTE.trim()}` : "";
      const body = results.map((r) => r.line).join("\n") + utc;
      const done = results.filter((r) => r.ok).length;
      const kept = results.filter((r) => r.kept).length;
      const failed = results.length - done - kept;
      const keptNote = kept ? `; ${kept} already on your list, left unchanged` : "";
      if (dryRun) {
        const header = `Dry run, nothing was saved: ${done} of ${results.length} updates would be saved${keptNote}${failed ? `; ${failed} can't be` : ""}.`;
        const next = done
          ? `\nTo save exactly these matches, call again without dryRun${addOnly ? " but still with addOnly" : ""}, passing the ID (the number in brackets) of each show that would be saved.`
          : "";
        return text(`${header}\n${body}${next}`);
      }
      journal.record("update_shows", changes);
      if (done === 0 && failed > 0) return { ...text(body), isError: true };
      return text(failed || kept ? `Saved ${done} of ${results.length} updates${keptNote}.\n${body}` : body);
    }),
  );

  const { pendingRemovals } = user;
  const removeTool = server.registerTool(
    "remove_from_list",
    {
      title: "Remove from list",
      description: `${REMOVE_DESCRIPTION} The first call only shows the entry; call again with confirmed: true to remove it.${BY_NAME}`,
      inputSchema: {
        anime,
        type: mediaType,
        confirmed: z
          .boolean()
          .optional()
          .describe("true on the second call, to remove the entry the first call showed"),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
    },
    safe(async ({ anime, type, confirmed }) => {
      const readAt = user.saves;
      const resolved = await find(anime, "remove", { type: namedType(type) });
      const { note } = resolved;
      // Cached once fetched (resolving a name fetches it), so this is a request only on first use.
      const viewer = await client.getViewer();
      return onTurn(resolved, readAt, async (media) => {
        const title = displayTitle(media.title, viewer.titleLanguage);
        let entry = media.mediaListEntry;
        const shown = pendingRemovals.get(media.id);
        pendingRemovals.delete(media.id); // a confirmation is used once
        if (!entry) return text(`${title} isn't on your list.`);
        // A deletion goes ahead only once the entry has been put in front of the user or the
        // assistant: in a dialog, or by an earlier call, unchanged since and not long ago.
        const state = JSON.stringify([entry.id, snapshot(entry)]);
        const line = describeEntry(media, entry, viewer).replace(/^\[\d+\] /, "");
        if (!(confirmed && shown && shown.entry === state && now() < shown.expires)) {
          const askedAt = now();
          const answer = canAsk()
            ? await ask({
                message: `Remove ${title} from your AniList list? ${line}. Its progress, score, dates and notes go with it.`,
                requestedSchema: {
                  type: "object",
                  properties: { confirm: { type: "boolean", title: `Remove ${title}`, default: true } },
                  required: [],
                },
              })
            : null;
          if (answer?.action === "decline" || (answer?.action === "accept" && answer.content?.confirm === false)) {
            return text(`${note}Not removed: the user chose to keep ${title}.`);
          }
          // No dialog, or one closed without an answer (some clients can't show one, and
          // claude -p closes every one): the assistant confirms with a second call.
          if (answer?.action !== "accept") {
            for (const [id, p] of pendingRemovals) if (p.expires <= now()) pendingRemovals.delete(id);
            pendingRemovals.set(media.id, { entry: state, expires: now() + CONFIRM_REMOVAL_MS });
            const changed =
              confirmed && shown && shown.entry !== state ? "It changed since it was last shown, so it wasn't removed. " : "";
            return text(
              `${note}Not removed yet. ${changed}${line}; removing it deletes its progress, score, dates and notes. If this is the show the user asked to remove, call again with confirmed: true; if you're not sure, ask them first.`,
            );
          }
          // The user took a while to answer: undo should bring back the entry as it is now.
          if (now() - askedAt > FRESH_LIST_MS) {
            entry = (await client.getMedia(media.id)).mediaListEntry;
            if (!entry) return text(`${note}${title} isn't on your list any more.`);
          }
        }
        const deleted = await client.deleteEntry(entry.id);
        if (deleted) journal.record("remove_from_list", [change(media, entry, null)]);
        return text(`${note}${deleted ? `Removed ${title} from your list.` : `AniList did not delete ${title}.`}`);
      });
    }),
  );
  // Clients that show forms confirm deletions themselves: no need for the assistant to ask too.
  server.server.oninitialized = () => {
    if (canAsk()) {
      removeTool.update({
        description: `${REMOVE_DESCRIPTION} The user confirms in a dialog the tool shows them, so don't ask them first.${BY_NAME}`,
      });
    }
  };

  server.registerTool(
    "undo",
    {
      title: "Undo",
      description:
        "Undo the latest change(s) AniConnect made to the user's list since it started, newest first, restoring each show exactly as it was: a removed show comes back with its progress, score, dates and notes, and a newly added one is removed again. Shows changed since on anilist.co are left alone. AniList's activity feed keeps its posts about the undone change.",
      inputSchema: {
        count: z
          .number()
          .int()
          .min(1)
          .max(10)
          .default(1)
          .describe("How many changes to undo; each earlier tool call that changed the list is one"),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
    },
    safe(async ({ count }) => {
      // One undo at a time, so a second one starts from the list the first left behind.
      const run = user.undoing.then(() => undoLatest(count));
      user.undoing = run.catch(() => {});
      return run;
    }),
  );

  const undoLatest = async (count: number) => {
    if (journal.size === 0) return text("Nothing to undo: AniConnect hasn't changed the list since it started.");
    const viewer = await client.getViewer();
    const groups = journal.take(count);
    const body = await undoGroups(client, journal, groups, viewer);
    const what =
      groups.length === 1 ? `the last change (${groups[0]!.tool})` : `the last ${groups.length} changes (${groups.map((g) => g.tool).join(", ")})`;
    const short = groups.length < count ? ` Only ${groups.length} could be undone; that's every change since AniConnect started.` : "";
    return text(`Undid ${what}:${short}\n${body}`);
  };

  return server;
}
