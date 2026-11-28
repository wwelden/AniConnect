/**
 * An in-memory stand-in for AniList's GraphQL API, backed by a snapshot of real AniList
 * metadata (test/fixtures/media.json, and a few manga in test/fixtures/manga.json). Used by
 * the unit tests and by the eval harness.
 *
 * Every request runs through a real GraphQL engine against AniList's own schema
 * (test/fixtures/anilist.graphql), so any query AniList would accept works here, whoever
 * wrote it: a query AniList would reject fails here too. Fields the fake has no data for
 * come back null and are logged in `unmodeled`.
 */
import { readFileSync } from "node:fs";
import {
  buildSchema,
  defaultFieldResolver,
  execute,
  getNullableType,
  GraphQLError,
  isEnumType,
  isListType,
  isNonNullType,
  isObjectType,
  isScalarType,
  parse,
  validate,
  type DocumentNode,
  type GraphQLFieldResolver,
  type GraphQLObjectType,
  type GraphQLOutputType,
} from "graphql";
import type { ListStatus, ScoreFormat, TitleLanguage } from "../../src/anilist";
import { normalize } from "../../src/logic";
import mangaJson from "../fixtures/manga.json";
import catalogJson from "../fixtures/media.json";
import recommendationsJson from "../fixtures/recommendations.json";

/** A show (or manga) the fake knows. Anime have no `type` in the fixture; manga have no episodes. */
export type CatalogMedia = (typeof catalogJson)[number] & {
  type?: string;
  chapters?: number | null;
  volumes?: number | null;
};
/** The anime. Tests may add to it. */
export const catalog: CatalogMedia[] = catalogJson;

/**
 * The manga, kept apart so tests that take a slice of `catalog` get anime only. Cast: the
 * anime fixture's inferred types say every show has a duration and a season.
 */
export const mangaCatalog = mangaJson.map((m) => ({
  ...m,
  episodes: null,
  duration: null,
  season: null,
  seasonYear: null,
  nextAiringEpisode: null,
  externalLinks: [],
  studios: { edges: [] },
  franchise: m.title.romaji,
})) as unknown as CatalogMedia[];

/** Everything AniList has, as far as the fake knows: anime, then manga. */
function everything(): CatalogMedia[] {
  return catalog.concat(mangaCatalog);
}

function mediaType(m: { type?: string }): string {
  return m.type ?? "ANIME";
}

const EMPTY_DATE = { year: null, month: null, day: null };

/** AniList fills in relations only two levels deep; deeper `relations` come back empty. */
const RELATION_LEVELS = 2;

/** AniList's page size when a query doesn't give one, and its maximum. */
const PER_PAGE = 50;

/** The signed-in user's AniList ID. */
const VIEWER_ID = 1;

/** Favorites AniList gives per page, its default and its most (checked live 2026-11-28). */
const FAVORITES_PER_PAGE = 25;

export interface StoredEntry {
  id: number;
  mediaId: number;
  status: ListStatus;
  progress: number;
  /** A manga's volumes read. */
  progressVolumes?: number;
  /** Raw 0-100 score. */
  scoreRaw: number;
  startedAt: { year: number | null; month: number | null; day: number | null };
  completedAt: { year: number | null; month: number | null; day: number | null };
  repeat?: number;
  notes?: string | null;
  private?: boolean;
  hiddenFromStatusLists?: boolean;
  /** Names of the custom lists the entry is on. */
  customLists?: string[];
}

export interface SeedEntry {
  /** Exact romaji title from the fixture (an anime's, else a manga's), or an AniList ID. */
  anime: string | number;
  status: ListStatus;
  progress?: number;
  progressVolumes?: number;
  score?: number;
}

/** A list activity as AniList stores it (see FakeAniList.recordActivity). */
export interface StoredActivity {
  id: number;
  mediaId: number;
  /** ANIME_LIST or MANGA_LIST; ANIME_LIST when absent. */
  type?: string;
  status: string;
  progress: string | null;
  /** Unix seconds. */
  createdAt: number;
}

export interface SeedActivity {
  anime: string | number;
  status: string;
  progress?: string;
  /** ISO time. */
  at: string;
}

/** AniList folds a progress update into the previous activity for the same show if it came this soon after. */
const MERGE_SECONDS = 60 * 60;

/** A fixture show by ID or exact title: an anime's title before a manga's, since many are both. */
export function findMedia(anime: string | number): CatalogMedia {
  const all = everything();
  const m =
    typeof anime === "number"
      ? all.find((c) => c.id === anime)
      : all.find((c) => c.title.romaji === anime) ?? all.find((c) => c.title.english === anime);
  if (!m) throw new Error(`Fixture has no anime or manga "${anime}"`);
  return m;
}

/** AniList shows raw scores in the user's format; this mirrors that for each format. */
function displayScore(raw: number, format: ScoreFormat): number {
  switch (format) {
    case "POINT_100":
      return raw;
    case "POINT_10_DECIMAL":
      return raw / 10;
    case "POINT_10":
      return Math.round(raw / 10);
    case "POINT_5":
      return raw === 0 ? 0 : Math.max(1, Math.round(raw / 20));
    case "POINT_3":
      return raw === 0 ? 0 : raw >= 70 ? 3 : raw >= 40 ? 2 : 1;
  }
}

/** The other way: a score given in the user's format (SaveMediaListEntry's `score`), as 0-100. */
function rawScore(score: number, format: ScoreFormat): number {
  switch (format) {
    case "POINT_100":
      return Math.round(score);
    case "POINT_10_DECIMAL":
    case "POINT_10":
      return Math.round(score * 10);
    case "POINT_5":
      return Math.round(score * 20);
    case "POINT_3":
      return score <= 0 ? 0 : score < 1.5 ? 35 : score < 2.5 ? 60 : 85;
  }
}

/** Filters for browsing, in AniConnect's own words (see FakeAniList.search). */
interface SearchVariables {
  season?: string;
  seasonYear?: number;
  genres?: string[];
  formats?: string[];
  status?: string;
  sort?: string[];
  /** Like AniList's argument: false hides adult titles, true keeps only them. */
  isAdult?: boolean;
}

/** Sort keys for the AniList media sorts the fake knows, ascending. SEARCH_MATCH and TRENDING are imitated by popularity. */
const SORT_KEYS: Record<string, (m: CatalogMedia) => number | string> = {
  ID: (m) => m.id,
  SEARCH_MATCH: (m) => -(m.popularity ?? 0),
  POPULARITY: (m) => m.popularity ?? 0,
  TRENDING: (m) => m.popularity ?? 0,
  FAVOURITES: (m) => m.popularity ?? 0,
  SCORE: (m) => m.averageScore ?? 0,
  EPISODES: (m) => m.episodes ?? 0,
  DURATION: (m) => m.duration ?? 0,
  TITLE_ROMAJI: (m) => m.title.romaji ?? "",
  TITLE_ENGLISH: (m) => m.title.english ?? "",
  TITLE_NATIVE: (m) => m.title.native ?? "",
  FORMAT: (m) => m.format ?? "",
  STATUS: (m) => m.status ?? "",
  // Shows with no start date yet count as the newest.
  START_DATE: (m) =>
    m.startDate?.year ? m.startDate.year * 10000 + (m.startDate.month ?? 0) * 100 + (m.startDate.day ?? 0) : Infinity,
};

function sortMedia(list: CatalogMedia[], sort: string | undefined): CatalogMedia[] {
  if (!sort) return list;
  const desc = sort.endsWith("_DESC");
  const key = SORT_KEYS[desc ? sort.slice(0, -5) : sort];
  if (!key) throw new FakeError(`The fake AniList can't sort media by ${sort}.`, 400);
  return [...list].sort((a, b) => {
    const x = key(a);
    const y = key(b);
    const order = x < y ? -1 : x > y ? 1 : 0;
    return desc ? -order : order;
  });
}

/** Every word of `text` somewhere in one of a show's titles. */
function titleMatches(m: CatalogMedia, text: string): boolean {
  const words = normalize(text).split(" ").filter(Boolean);
  const hay = [m.title.romaji, m.title.english, m.title.native, ...(m.synonyms ?? [])]
    .filter(Boolean)
    .map((n) => normalize(n!))
    .join(" | ");
  return words.every((w) => hay.includes(w));
}

/** A FuzzyDate as AniList's FuzzyDateInt (YYYYMMDD, missing parts as 0). */
function dateInt(d: { year: number | null; month: number | null; day: number | null } | null | undefined): number | null {
  return d?.year ? d.year * 10000 + (d.month ?? 0) * 100 + (d.day ?? 0) : null;
}

/** An error AniList would answer with this HTTP status (and, for bad input, a `validation` map). */
class FakeError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly validation?: Record<string, string[]>,
  ) {
    super(message);
  }
}

const notFound = () => new FakeError("Not Found.", 404);

interface Context {
  fake: FakeAniList;
  /** Whether the request carried a token. */
  authed: boolean;
}

type Resolver = GraphQLFieldResolver<any, Context, any>;

const schema = buildSchema(readFileSync(new URL("../fixtures/anilist.graphql", import.meta.url), "utf8"));

function resolveFields(type: string, resolvers: Record<string, Resolver>) {
  const fields = (schema.getType(type) as GraphQLObjectType).getFields();
  for (const [name, resolve] of Object.entries(resolvers)) {
    if (!fields[name]) throw new Error(`AniList's schema has no ${type}.${name}`);
    fields[name].resolve = resolve;
  }
}

/** A show as the resolvers pass it around: catalog data plus how deep in `relations` it sits. */
type MediaValue = Partial<CatalogMedia> & { id: number; type: string; level: number };

function mediaValue(m: CatalogMedia, level: number): MediaValue {
  // An anime has no chapters or volumes: AniList answers null.
  return { chapters: null, volumes: null, ...m, type: mediaType(m), level };
}

function requireAuth(ctx: Context) {
  if (!ctx.authed) throw new FakeError("Unauthorized.", 401);
}

/** Whether a user ID and name (either may be absent) name the signed-in user. */
function isViewer(id: number | null | undefined, name: string | null | undefined, ctx: Context) {
  return (id == null || id === VIEWER_ID) && (name == null || name.toLowerCase() === ctx.fake.viewerName.toLowerCase());
}

/** Paged list fields record their full length here, for `pageInfo`. */
interface PageValue {
  page: number;
  perPage: number;
  total?: number;
}

function paginate<T>(page: PageValue, all: T[]): T[] {
  page.total = all.length;
  return all.slice((page.page - 1) * page.perPage, page.page * page.perPage);
}

const STATUS_LISTS: [ListStatus, string][] = [
  ["CURRENT", "Watching"],
  ["REPEATING", "Rewatching"],
  ["COMPLETED", "Completed"],
  ["PAUSED", "Paused"],
  ["DROPPED", "Dropped"],
  ["PLANNING", "Planning"],
];

/**
 * Whether a show carries a tag (any case, as AniList matches it) ranked at least `floor`. The
 * fixture keeps each show's top 10 tags only, so a low-ranked tag can be missing here.
 */
function hasTag(m: CatalogMedia, name: string, floor: number | undefined): boolean {
  return (m.tags ?? []).some((t) => t.name.toLowerCase() === name.toLowerCase() && (t.rank ?? 0) >= (floor ?? 0));
}

/** Media arguments the fake applies; any other one is logged in `unmodeled` and ignored. */
const MEDIA_FILTERS: Record<string, (m: CatalogMedia, value: any, ctx: Context, args: Record<string, any>) => boolean> = {
  id: (m, v) => m.id === v,
  id_in: (m, v: number[]) => v.includes(m.id),
  id_not: (m, v) => m.id !== v,
  id_not_in: (m, v: number[]) => !v.includes(m.id),
  search: (m, v: string) => titleMatches(m, v),
  type: (m, v) => mediaType(m) === v,
  season: (m, v) => m.season === v,
  seasonYear: (m, v) => m.seasonYear === v,
  format: (m, v) => m.format === v,
  format_in: (m, v: string[]) => m.format !== null && v.includes(m.format),
  format_not: (m, v) => m.format !== v,
  format_not_in: (m, v: string[]) => m.format === null || !v.includes(m.format),
  status: (m, v) => m.status === v,
  status_in: (m, v: string[]) => m.status !== null && v.includes(m.status),
  status_not: (m, v) => m.status !== v,
  status_not_in: (m, v: string[]) => m.status === null || !v.includes(m.status),
  genre: (m, v: string) => (m.genres ?? []).includes(v),
  // Like AniList: every one of the genres.
  genre_in: (m, v: string[]) => v.every((g) => (m.genres ?? []).includes(g)),
  genre_not_in: (m, v: string[]) => !v.some((g) => (m.genres ?? []).includes(g)),
  // Like AniList: every one of the tags; `minimumTagRank` gates the exclusions too (checked live).
  tag_in: (m, v: string[], _ctx, args) => v.every((t) => hasTag(m, t, args.minimumTagRank)),
  tag_not_in: (m, v: string[], _ctx, args) => !v.some((t) => hasTag(m, t, args.minimumTagRank)),
  isAdult: (m, v) => m.isAdult === v,
  // Without a token there is no list to be on, so the filter does nothing.
  onList: (m, v, ctx) => !ctx.authed || ctx.fake.entries.has(m.id) === v,
  episodes: (m, v) => m.episodes === v,
  episodes_greater: (m, v) => (m.episodes ?? 0) > v,
  episodes_lesser: (m, v) => m.episodes !== null && m.episodes < v,
  averageScore_greater: (m, v) => (m.averageScore ?? 0) > v,
  averageScore_lesser: (m, v) => m.averageScore !== null && m.averageScore < v,
  popularity_greater: (m, v) => (m.popularity ?? 0) > v,
  popularity_lesser: (m, v) => (m.popularity ?? 0) < v,
  startDate_greater: (m, v) => (dateInt(m.startDate) ?? 0) > v,
  startDate_lesser: (m, v) => (dateInt(m.startDate) ?? Infinity) < v,
  startDate_like: (m, v: string) => String(dateInt(m.startDate) ?? "").startsWith(v.replace(/%/g, "")),
};

function findMediaBy(args: Record<string, any>, ctx: Context): CatalogMedia[] {
  const { sort, minimumTagRank: _rank, ...filters } = args;
  let list = everything();
  for (const [name, value] of Object.entries(filters)) {
    if (value == null) continue;
    const test = MEDIA_FILTERS[name];
    if (!test) {
      ctx.fake.unmodeled.add(`Media(${name})`);
      continue;
    }
    list = list.filter((m) => test(m, value, ctx, args));
  }
  // AniList answers id_in in its own order; the request's order is as good a stand-in as any.
  if (filters.id_in && !sort) list = [...list].sort((a, b) => filters.id_in.indexOf(a.id) - filters.id_in.indexOf(b.id));
  return sortMedia(list, sort?.[0] ?? (filters.search ? "SEARCH_MATCH" : undefined));
}

function entryFilter(args: Record<string, any>, ctx: Context): (e: StoredEntry) => boolean {
  const known = new Set(["id", "userId", "userName", "type", "status", "status_in", "status_not", "status_not_in", "mediaId", "mediaId_in", "sort", "notes_like"]);
  for (const [name, value] of Object.entries(args)) if (value != null && !known.has(name)) ctx.fake.unmodeled.add(`MediaList(${name})`);
  return (e) =>
    isViewer(args.userId, args.userName, ctx) &&
    (args.type == null || args.type === mediaType(findMedia(e.mediaId))) &&
    (args.id == null || e.id === args.id) &&
    (args.mediaId == null || e.mediaId === args.mediaId) &&
    (args.mediaId_in == null || args.mediaId_in.includes(e.mediaId)) &&
    (args.status == null || e.status === args.status) &&
    (args.status_in == null || args.status_in.includes(e.status)) &&
    (args.status_not == null || e.status !== args.status_not) &&
    (args.status_not_in == null || !args.status_not_in.includes(e.status)) &&
    (args.notes_like == null || (e.notes ?? "").toLowerCase().includes(args.notes_like.replace(/%/g, "").toLowerCase()));
}

function sortEntries(entries: StoredEntry[], sort: string[] | undefined): StoredEntry[] {
  const by = sort?.[0];
  if (!by) return entries;
  const desc = by.endsWith("_DESC");
  const keys: Record<string, (e: StoredEntry) => number | string> = {
    MEDIA_ID: (e) => e.mediaId,
    SCORE: (e) => e.scoreRaw,
    STATUS: (e) => e.status,
    PROGRESS: (e) => e.progress,
    // The fake doesn't keep edit times; newer entries have higher IDs.
    UPDATED_TIME: (e) => e.id,
    ADDED_TIME: (e) => e.id,
    STARTED_ON: (e) => dateInt(e.startedAt) ?? 0,
    FINISHED_ON: (e) => dateInt(e.completedAt) ?? 0,
    MEDIA_TITLE_ROMAJI: (e) => findMedia(e.mediaId).title.romaji ?? "",
    MEDIA_TITLE_ENGLISH: (e) => findMedia(e.mediaId).title.english ?? "",
    MEDIA_POPULARITY: (e) => findMedia(e.mediaId).popularity ?? 0,
  };
  const key = keys[desc ? by.slice(0, -5) : by];
  if (!key) throw new FakeError(`The fake AniList can't sort lists by ${by}.`, 400);
  return [...entries].sort((a, b) => {
    const x = key(a);
    const y = key(b);
    const order = x < y ? -1 : x > y ? 1 : 0;
    return desc ? -order : order;
  });
}

resolveFields("Query", {
  Viewer: (_root, _args, ctx) => {
    requireAuth(ctx);
    return ctx.fake.viewer();
  },
  User: (_root, args, ctx) => {
    if (!isViewer(args.id, args.name, ctx) || (args.search && !ctx.fake.viewerName.toLowerCase().includes(args.search.toLowerCase()))) {
      throw notFound();
    }
    return ctx.fake.viewer();
  },
  Media: (_root, args, ctx) => {
    const [m] = findMediaBy(args, ctx);
    if (!m) throw notFound();
    return mediaValue(m, 1);
  },
  Page: (_root, args): PageValue => ({ page: Math.max(1, args.page ?? 1), perPage: Math.min(PER_PAGE, Math.max(1, args.perPage ?? PER_PAGE)) }),
  MediaList: (_root, args, ctx) => {
    const entry = [...ctx.fake.entries.values()].find(entryFilter(args, ctx));
    if (!entry) throw notFound();
    return entry;
  },
  MediaListCollection: (_root, args, ctx) => {
    if (args.userId == null && args.userName == null) {
      throw new FakeError("validation", 400, { userId: ["The user id field is required when user name is not present."] });
    }
    if (!isViewer(args.userId, args.userName, ctx)) throw notFound();
    const entries = [...ctx.fake.entries.values()].filter(entryFilter(args, ctx));
    const lists: { name: string; isCustomList: boolean; isSplitCompletedList: boolean; status: ListStatus | null; entries: StoredEntry[] }[] = [];
    for (const [status, name] of STATUS_LISTS) {
      const these = entries.filter((e) => e.status === status && !e.hiddenFromStatusLists);
      if (these.length) lists.push({ name, isCustomList: false, isSplitCompletedList: false, status, entries: these });
    }
    // An entry on a custom list comes back again in that list.
    for (const name of ctx.fake.customListNames()) {
      const these = entries.filter((e) => e.customLists?.includes(name));
      if (these.length) lists.push({ name, isCustomList: true, isSplitCompletedList: false, status: null, entries: these });
    }
    return { lists, user: ctx.fake.viewer(), hasNextChunk: false };
  },
  GenreCollection: () => [...new Set(catalog.flatMap((m) => m.genres ?? []))].sort(),
  // Every tag the snapshot's shows carry (AniList has 430; the snapshot keeps each show's top 10).
  MediaTagCollection: () => {
    const tags = new Map<string, boolean>();
    for (const t of catalog.flatMap((m) => m.tags ?? [])) tags.set(t.name, Boolean(t.isAdult));
    return [...tags].sort(([a], [b]) => a.localeCompare(b)).map(([name, isAdult], i) => ({ id: i + 1, name, isAdult }));
  },
  AiringSchedule: (_root, args, ctx) => {
    const schedule = ctx.fake.airingSchedules(args)[0];
    if (!schedule) throw notFound();
    return schedule;
  },
});

resolveFields("Page", {
  pageInfo: async (page: PageValue) => {
    // Resolved after the page's list field, which records the total.
    await Promise.resolve();
    await Promise.resolve();
    const total = page.total ?? 0;
    const lastPage = Math.max(1, Math.ceil(total / page.perPage));
    return { total, perPage: page.perPage, currentPage: page.page, lastPage, hasNextPage: page.page < lastPage };
  },
  media: (page: PageValue, args, ctx) => paginate(page, findMediaBy(args, ctx)).map((m) => mediaValue(m, 1)),
  mediaList: (page: PageValue, args, ctx) =>
    paginate(page, sortEntries([...ctx.fake.entries.values()].filter(entryFilter(args, ctx)), args.sort)),
  activities: (page: PageValue, args, ctx) => {
    const known = new Set(["userId", "mediaId", "type", "type_in", "createdAt_greater", "createdAt_lesser", "sort"]);
    for (const [name, value] of Object.entries(args)) if (value != null && !known.has(name)) ctx.fake.unmodeled.add(`Activity(${name})`);
    // MEDIA_LIST is either kind of list update.
    const listTypes = (a: StoredActivity) => [a.type ?? "ANIME_LIST", "MEDIA_LIST"];
    const matching = ctx.fake.activities.filter(
      (a) =>
        (args.userId == null || args.userId === VIEWER_ID) &&
        (args.mediaId == null || a.mediaId === args.mediaId) &&
        (args.type == null || listTypes(a).includes(args.type)) &&
        (args.type_in == null || args.type_in.some((t: string) => listTypes(a).includes(t))) &&
        (args.createdAt_greater == null || a.createdAt > args.createdAt_greater) &&
        (args.createdAt_lesser == null || a.createdAt < args.createdAt_lesser),
    );
    const ascending = args.sort?.[0] === "ID";
    const sorted = [...matching].sort((a, b) => (ascending ? a.id - b.id : b.id - a.id));
    return paginate(page, sorted).map((a) => ({
      __typename: "ListActivity",
      ...a,
      userId: VIEWER_ID,
      type: a.type ?? "ANIME_LIST",
      replyCount: 0,
      likeCount: 0,
      isLocked: false,
      siteUrl: `https://anilist.co/activity/${a.id}`,
      mediaId: a.mediaId,
    }));
  },
  airingSchedules: (page: PageValue, args, ctx) => paginate(page, ctx.fake.airingSchedules(args)),
  users: (page: PageValue, args, ctx) =>
    paginate(page, args.search == null || ctx.fake.viewerName.toLowerCase().includes(args.search.toLowerCase()) ? [ctx.fake.viewer()] : []),
});

resolveFields("Media", {
  type: (m: MediaValue) => m.type,
  // The fixture keeps every studio, as edges; `isMain` picks the ones that animated the show.
  studios: (m: MediaValue, args, ctx) => {
    if (!m.studios) {
      ctx.fake.unmodeled.add("Media.studios");
      return null;
    }
    if (args.sort) ctx.fake.unmodeled.add("Media.studios(sort)");
    const edges = m.studios.edges.filter((e) => args.isMain == null || e.isMain === args.isMain);
    return { edges, nodes: edges.map((e) => e.node) };
  },
  // Stored as AniList sends it by default; the HTML form isn't kept.
  description: (m: MediaValue, args, ctx) => {
    if (args.asHtml) ctx.fake.unmodeled.add("Media.description(asHtml)");
    return m.description ?? null;
  },
  mediaListEntry: (m: MediaValue, _args, ctx) => (ctx.authed ? (ctx.fake.entries.get(m.id) ?? null) : null),
  // Whose favorite: the signed-in user's, so false without a token.
  isFavourite: (m: MediaValue, _args, ctx) => ctx.authed && ctx.fake.favorites.includes(m.id),
  isFavouriteBlocked: (m: MediaValue, _args, ctx) => ctx.fake.favoriteBlocked.has(m.id),
  nextAiringEpisode: (m: MediaValue, _args, ctx) => {
    const next = m.nextAiringEpisode;
    return next ? ctx.fake.schedule(m.id, next.episode, next.airingAt) : null;
  },
  // AniList's community recommendations, from test/fixtures/recommendations.json (or set in a test).
  recommendations: (m: MediaValue, args, ctx) => {
    if (args.sort && args.sort[0] !== "RATING_DESC") ctx.fake.unmodeled.add(`Media.recommendations(sort: ${args.sort[0]})`);
    const edges = [...(ctx.fake.recommendations.get(m.id) ?? [])].sort((a, b) => b.rating - a.rating);
    // AniList gives at most 25 recommendations a page, whatever perPage asks (checked live).
    const page = { page: Math.max(1, args.page ?? 1), perPage: Math.min(25, Math.max(1, args.perPage ?? 25)) };
    const nodes = paginate(page, edges).map((e, i) => {
      const target = e.id === null ? undefined : catalog.find((c) => c.id === e.id);
      return { id: m.id * 100 + i, rating: e.rating, media: m, mediaRecommendation: target ? mediaValue(target, m.level + 1) : null };
    });
    const lastPage = Math.max(1, Math.ceil(edges.length / page.perPage));
    return {
      nodes,
      edges: nodes.map((node) => ({ node })),
      pageInfo: { total: edges.length, perPage: page.perPage, currentPage: page.page, lastPage, hasNextPage: page.page < lastPage },
    };
  },
  relations: (m: MediaValue) => {
    if (m.level > RELATION_LEVELS || !m.relations) return { edges: [] };
    return {
      edges: m.relations.edges.map((e) => {
        const target = everything().find((c) => c.id === e.node.id);
        return {
          relationType: e.relationType,
          node: target
            ? { ...mediaValue(target, m.level + 1), type: e.node.type }
            : // Outside the snapshot: AniList would know more, the fake only the ID.
              { id: e.node.id, type: e.node.type, level: m.level + 1, title: { romaji: null, english: null, native: null }, format: null, status: null, episodes: null, startDate: null },
        };
      }),
    };
  },
});

/** The user's favorites, as `User.favourites` and `ToggleFavourite` return them. */
const FAVORITES = {};

/** One type of favorite as a MediaConnection, in the user's order. */
function favoriteConnection(type: string): Resolver {
  return (_root, args, ctx) => {
    const all = ctx.fake.favorites.map((id) => everything().find((c) => c.id === id)!).filter((m) => mediaType(m) === type);
    const page = { page: Math.max(1, args.page ?? 1), perPage: Math.min(FAVORITES_PER_PAGE, Math.max(1, args.perPage ?? FAVORITES_PER_PAGE)) };
    const nodes = paginate(page, all).map((m) => mediaValue(m, 1));
    const lastPage = Math.max(1, Math.ceil(all.length / page.perPage));
    return {
      nodes,
      edges: nodes.map((node, i) => ({ node, favouriteOrder: (page.page - 1) * page.perPage + i + 1 })),
      pageInfo: { total: all.length, perPage: page.perPage, currentPage: page.page, lastPage, hasNextPage: page.page < lastPage },
    };
  };
}

resolveFields("Favourites", { anime: favoriteConnection("ANIME"), manga: favoriteConnection("MANGA") });

resolveFields("User", {
  favourites: (_user, args, ctx) => {
    if (args.page != null) ctx.fake.unmodeled.add("User.favourites(page)");
    return FAVORITES;
  },
});

resolveFields("MediaTitle", {
  userPreferred: (title: CatalogMedia["title"], _args, ctx) => {
    const lang = ctx.fake.titleLanguage;
    return (lang === "ENGLISH" ? title.english : lang === "NATIVE" ? title.native : null) ?? title.romaji;
  },
});

resolveFields("MediaList", {
  userId: () => VIEWER_ID,
  score: (e: StoredEntry, args, ctx) => displayScore(e.scoreRaw, args.format ?? ctx.fake.scoreFormat),
  progressVolumes: (e: StoredEntry) => e.progressVolumes ?? 0,
  repeat: (e: StoredEntry) => e.repeat ?? 0,
  // AniList returns an empty note as null.
  notes: (e: StoredEntry) => e.notes || null,
  private: (e: StoredEntry) => e.private ?? false,
  hiddenFromStatusLists: (e: StoredEntry) => e.hiddenFromStatusLists ?? false,
  // Every custom list the user has, each saying whether this entry is on it.
  customLists: (e: StoredEntry, args, ctx) => {
    const lists = ctx.fake.customListNames().map((name) => ({ name, enabled: e.customLists?.includes(name) ?? false }));
    return args.asArray ? lists : Object.fromEntries(lists.map((l) => [l.name, l.enabled]));
  },
  media: (e: StoredEntry) => {
    const m = everything().find((c) => c.id === e.mediaId);
    return m ? mediaValue(m, 1) : null;
  },
  user: (_e, _args, ctx) => ctx.fake.viewer(),
});

resolveFields("ListActivity", {
  media: (a: StoredActivity) => {
    const m = everything().find((c) => c.id === a.mediaId);
    return m ? mediaValue(m, 1) : null;
  },
  user: (_a, _args, ctx) => ctx.fake.viewer(),
});

(schema.getType("ActivityUnion") as any).resolveType = (value: { __typename?: string }) => value.__typename ?? "ListActivity";

resolveFields("Mutation", {
  SaveMediaListEntry: (_root, args, ctx) => {
    requireAuth(ctx);
    return ctx.fake.save(args);
  },
  UpdateMediaListEntries: (_root, args, ctx) => {
    requireAuth(ctx);
    const { ids, ...changes } = args;
    const targets = [...ctx.fake.entries.values()].filter((e) => (ids ?? []).includes(e.id));
    return targets.map((e) => ctx.fake.save({ ...changes, mediaId: e.mediaId }));
  },
  ToggleFavourite: (_root, args, ctx) => {
    requireAuth(ctx);
    for (const name of ["characterId", "staffId", "studioId"]) {
      if (args[name] != null) {
        ctx.fake.unmodeled.add(`ToggleFavourite(${name})`);
        throw new FakeError(`The fake AniList doesn't support ToggleFavourite(${name}).`, 400);
      }
    }
    const [field, type] = args.animeId != null ? ["animeId", "ANIME"] : ["mangaId", "MANGA"];
    const id = args[field];
    const m = id == null ? undefined : everything().find((c) => c.id === id && mediaType(c) === type);
    if (!m) throw new FakeError("validation", 400, { [field]: [`The selected ${field.replace("Id", " id")} is invalid.`] });
    if (ctx.fake.favoriteBlocked.has(m.id)) throw new FakeError("This media can't be favourited.", 400);
    const at = ctx.fake.favorites.indexOf(m.id);
    if (at >= 0) ctx.fake.favorites.splice(at, 1);
    else ctx.fake.favorites.push(m.id);
    return FAVORITES;
  },
  DeleteMediaListEntry: (_root, args, ctx) => {
    requireAuth(ctx);
    for (const [mediaId, entry] of ctx.fake.entries) {
      if (entry.id === args.id) {
        ctx.fake.entries.delete(mediaId);
        return { deleted: true };
      }
    }
    throw new FakeError("validation", 400, { id: ["The selected id is invalid."] });
  },
});

// Any other mutation would change something the fake doesn't keep, so it fails loudly instead of pretending.
for (const [name, field] of Object.entries(schema.getMutationType()!.getFields())) {
  field.resolve ??= (_root, _args, ctx: Context) => {
    ctx.fake.unmodeled.add(`Mutation.${name}`);
    throw new FakeError(`The fake AniList doesn't support ${name}.`, 400);
  };
}

/**
 * Object types AniList always fills in, even when there's nothing in them (a show with no
 * characters still has `characters { nodes: [] }`). Other objects, like a trailer, are null when absent.
 */
const ALWAYS_PRESENT =
  /Connection$|^(Favourites|FuzzyDate|MediaTitle|MediaCoverImage|MediaStats|UserAvatar|UserOptions|MediaListOptions|MediaListTypeOptions|UserStatisticTypes|UserStatistics|StaffName|StaffImage|CharacterName|CharacterImage)$/;

/** What a field the fake has no data for holds: what AniList returns for "none", as near as the type says. */
function blank(type: GraphQLOutputType): unknown {
  const inner = getNullableType(type);
  if (isListType(inner)) return [];
  if (isObjectType(inner) && ALWAYS_PRESENT.test(inner.name)) return {};
  if (!isNonNullType(type)) return null;
  if (isEnumType(inner)) return inner.getValues()[0]!.value;
  if (isScalarType(inner)) return ({ Boolean: false, Int: 0, Float: 0, Json: {} } as Record<string, unknown>)[inner.name] ?? "";
  return {};
}

/** Reads a field as stored, logging fields the fake has no data for. */
const fieldResolver: GraphQLFieldResolver<any, Context> = (source, args, ctx, info) => {
  if (source && typeof source === "object" && !(info.fieldName in source)) {
    ctx.fake.unmodeled.add(`${info.parentType.name}.${info.fieldName}`);
    return blank(info.returnType);
  }
  return defaultFieldResolver(source, args, ctx, info);
};

/** Parsed and validated queries, by text: each client sends the same few over and over. */
const documents = new Map<string, DocumentNode | readonly GraphQLError[]>();

function prepare(query: string): DocumentNode | readonly GraphQLError[] {
  let doc = documents.get(query);
  if (!doc) {
    try {
      const parsed = parse(query);
      const errors = validate(schema, parsed);
      doc = errors.length ? errors : parsed;
    } catch (err) {
      doc = [err as GraphQLError];
    }
    documents.set(query, doc);
  }
  return doc;
}

export class FakeAniList {
  entries = new Map<number, StoredEntry>();
  /** The user's favorite anime and manga by media ID, in their profile order (new ones go last). */
  favorites: number[] = [];
  /** Shows AniList doesn't let be a favorite. */
  favoriteBlocked = new Set<number>();
  nextEntryId = 1000;
  calls: { query: string; variables: Record<string, any> }[] = [];
  rateLimited = false;
  /** Retry-After on a rate-limited answer, in seconds. */
  retryAfter = "30";
  /** The viewer's AniList title language setting. */
  titleLanguage: TitleLanguage = "ENGLISH";
  /** The viewer's AniList time zone setting, as AniList returns it (e.g. "-05:00"). */
  timeZone: string | null = null;
  /** The user's list activity, oldest first. */
  activities: StoredActivity[] = [];
  nextActivityId = 1;
  /** Clock for new activity and airing countdowns, in ms. */
  clock: () => number = () => Date.now();
  /** The account's 18+ content setting (AniList's default is off). */
  displayAdultContent = false;
  /** Requests this returns true for never get an answer, like a stalled connection; they end only when aborted. */
  stalls: (query: string) => boolean = () => false;
  /** Fields and arguments that requests used but the fake has no data for ("Media.coverImage", "Media(tag)"). */
  unmodeled = new Set<string>();
  /** Episodes airing besides each show's next one (the only one the snapshot knows), for Page.airingSchedules. */
  airings: { mediaId: number; episode: number; airingAt: number }[] = [];
  /** Each show's recommendations by media ID; `id` null is a recommended show AniList returns as null. */
  recommendations = new Map<number, { id: number | null; rating: number }[]>(
    Object.entries(recommendationsJson as Record<string, { id: number | null; rating: number }[]>).map(([id, edges]) => [Number(id), edges]),
  );

  constructor(
    public scoreFormat: ScoreFormat = "POINT_10_DECIMAL",
    public viewerName = "tester",
  ) {}

  seed(list: SeedEntry[]): this {
    for (const s of list) {
      const m = findMedia(s.anime);
      this.entries.set(m.id, {
        id: this.nextEntryId++,
        mediaId: m.id,
        status: s.status,
        progress: s.progress ?? (s.status === "COMPLETED" ? ((mediaType(m) === "MANGA" ? m.chapters : m.episodes) ?? 0) : 0),
        ...(s.progressVolumes !== undefined && { progressVolumes: s.progressVolumes }),
        scoreRaw: Math.round((s.score ?? 0) * 10),
        startedAt: EMPTY_DATE,
        completedAt: EMPTY_DATE,
      });
    }
    return this;
  }

  seedActivity(list: SeedActivity[]): this {
    for (const a of [...list].sort((x, y) => Date.parse(x.at) - Date.parse(y.at))) {
      this.activities.push({
        id: this.nextActivityId++,
        mediaId: findMedia(a.anime).id,
        status: a.status,
        progress: a.progress ?? null,
        createdAt: Date.parse(a.at) / 1000,
      });
    }
    return this;
  }

  /** The signed-in user, as AniList's User type. */
  viewer() {
    return {
      id: VIEWER_ID,
      name: this.viewerName,
      siteUrl: `https://anilist.co/user/${this.viewerName}`,
      mediaListOptions: { scoreFormat: this.scoreFormat },
      options: { titleLanguage: this.titleLanguage, timezone: this.timeZone, displayAdultContent: this.displayAdultContent },
    };
  }

  /** The user's custom list names, in the order they first appear. */
  customListNames(): string[] {
    return [...new Set([...this.entries.values()].flatMap((e) => e.customLists ?? []))];
  }

  schedule(mediaId: number, episode: number, airingAt: number) {
    const m = catalog.find((c) => c.id === mediaId);
    return {
      id: this.scheduleId(mediaId, episode),
      mediaId,
      episode,
      airingAt,
      timeUntilAiring: airingAt - Math.floor(this.clock() / 1000),
      media: m ? mediaValue(m, 1) : null,
    };
  }

  private scheduleIds = new Map<string, number>();

  /** A stable ID for an episode's airing, small enough for GraphQL's 32-bit Int. */
  private scheduleId(mediaId: number, episode: number): number {
    const key = `${mediaId}:${episode}`;
    if (!this.scheduleIds.has(key)) this.scheduleIds.set(key, this.scheduleIds.size + 1);
    return this.scheduleIds.get(key)!;
  }

  /** The snapshot knows each airing show's next episode only; tests add more in `airings`. */
  airingSchedules(args: Record<string, any>) {
    const now = Math.floor(this.clock() / 1000);
    const known = new Set(["mediaId", "mediaId_in", "episode", "notYetAired", "airingAt_greater", "airingAt_lesser", "sort"]);
    for (const [name, value] of Object.entries(args)) if (value != null && !known.has(name)) this.unmodeled.add(`AiringSchedule(${name})`);
    if (args.sort && args.sort[0] !== "TIME") this.unmodeled.add(`AiringSchedule(sort: ${args.sort[0]})`);
    return [
      ...catalog
        .filter((m) => m.nextAiringEpisode)
        .map((m) => this.schedule(m.id, m.nextAiringEpisode!.episode, m.nextAiringEpisode!.airingAt)),
      ...this.airings.map((a) => this.schedule(a.mediaId, a.episode, a.airingAt)),
    ]
      .filter(
        (s) =>
          (args.mediaId == null || s.mediaId === args.mediaId) &&
          (args.mediaId_in == null || args.mediaId_in.includes(s.mediaId)) &&
          (args.episode == null || s.episode === args.episode) &&
          (args.notYetAired == null || (s.airingAt > now) === args.notYetAired) &&
          (args.airingAt_greater == null || s.airingAt > args.airingAt_greater) &&
          (args.airingAt_lesser == null || s.airingAt < args.airingAt_lesser),
      )
      .sort((a, b) => a.airingAt - b.airingAt || a.mediaId - b.mediaId);
  }

  /**
   * Logs a save the way AniList's feed does: one activity per status change, and episode
   * updates as "watched episode" with the episode or a range ("3 - 5"). An update right
   * after another for the same show extends that activity's range instead of adding one.
   */
  private recordActivity(before: StoredEntry | undefined, after: StoredEntry) {
    const was = before?.progress ?? 0;
    const statusChanged = before?.status !== after.status;
    const rewatch = after.status === "REPEATING";
    const manga = mediaType(findMedia(after.mediaId)) === "MANGA";
    let status: string;
    let progress: string | null = null;
    if (after.progress > was && (after.status === "CURRENT" || rewatch)) {
      status = manga ? (rewatch ? "reread chapter" : "read chapter") : rewatch ? "rewatched episode" : "watched episode";
      progress = after.progress === was + 1 ? String(after.progress) : `${was + 1} - ${after.progress}`;
    } else if (statusChanged) {
      status = {
        CURRENT: manga ? "reading" : "watching",
        PLANNING: manga ? "plans to read" : "plans to watch",
        COMPLETED: before?.status === "REPEATING" ? (manga ? "reread" : "rewatched") : "completed",
        DROPPED: "dropped",
        PAUSED: manga ? "paused reading" : "paused watching",
        REPEATING: manga ? "rereading" : "rewatching",
      }[after.status];
    } else {
      return;
    }
    const now = Math.floor(this.clock() / 1000);
    const last = this.activities.at(-1);
    if (
      progress &&
      last?.mediaId === after.mediaId &&
      last.status === status &&
      last.progress &&
      now - last.createdAt <= MERGE_SECONDS
    ) {
      last.progress = `${last.progress.split(" - ")[0]} - ${after.progress}`;
      return;
    }
    this.activities.push({
      id: this.nextActivityId++,
      mediaId: after.mediaId,
      ...(manga && { type: "MANGA_LIST" }),
      status,
      progress,
      createdAt: now,
    });
  }

  /** SaveMediaListEntry: creates or updates the entry named by `id` or `mediaId`. */
  save(args: Record<string, any>): StoredEntry {
    const byId = args.id != null ? [...this.entries.values()].find((e) => e.id === args.id) : undefined;
    if (args.id != null && !byId) throw new FakeError("validation", 400, { id: ["The selected id is invalid."] });
    const mediaId: number | undefined = byId?.mediaId ?? args.mediaId;
    if (mediaId == null || !everything().some((c) => c.id === mediaId)) {
      throw new FakeError("validation", 400, { mediaId: ["The selected media id is invalid."] });
    }
    for (const name of ["priority", "advancedScores"]) {
      if (args[name] != null) this.unmodeled.add(`SaveMediaListEntry(${name})`);
    }
    const before = this.entries.get(mediaId);
    const existing: StoredEntry = before ?? {
      id: this.nextEntryId++,
      mediaId,
      status: "PLANNING",
      progress: 0,
      scoreRaw: 0,
      startedAt: EMPTY_DATE,
      completedAt: EMPTY_DATE,
    };
    const date = (d: any) => ({ year: d?.year ?? null, month: d?.month ?? null, day: d?.day ?? null });
    const scoreRaw = args.scoreRaw ?? (args.score != null ? rawScore(args.score, this.scoreFormat) : undefined);
    const updated: StoredEntry = {
      ...existing,
      ...(args.status != null && { status: args.status }),
      ...(args.progress != null && { progress: args.progress }),
      ...(args.progressVolumes != null && { progressVolumes: args.progressVolumes }),
      ...(scoreRaw != null && { scoreRaw }),
      ...(args.startedAt !== undefined && { startedAt: date(args.startedAt) }),
      ...(args.completedAt !== undefined && { completedAt: date(args.completedAt) }),
      ...(args.repeat != null && { repeat: args.repeat }),
      ...(args.notes !== undefined && { notes: args.notes }),
      ...(args.private != null && { private: args.private }),
      ...(args.hiddenFromStatusLists != null && { hiddenFromStatusLists: args.hiddenFromStatusLists }),
      ...(args.customLists != null && { customLists: args.customLists }),
    };
    this.entries.set(mediaId, updated);
    this.recordActivity(before, updated);
    return updated;
  }

  /** Writes made so far, i.e. calls that change the list. */
  get writes() {
    return this.calls.filter((c) => /^\s*mutation/.test(c.query));
  }

  /** Makes these shows (exact romaji titles, as in `seed`, or IDs) the user's favorites, in this order. */
  seedFavorites(shows: (string | number)[]): this {
    for (const s of shows) {
      const id = findMedia(s).id;
      if (!this.favorites.includes(id)) this.favorites.push(id);
    }
    return this;
  }

  exportState() {
    return {
      favorites: [...this.favorites],
      entries: [...this.entries.values()],
      nextEntryId: this.nextEntryId,
      activities: this.activities,
      nextActivityId: this.nextActivityId,
    };
  }

  importState(state: {
    favorites?: number[];
    entries: StoredEntry[];
    nextEntryId: number;
    activities?: StoredActivity[];
    nextActivityId?: number;
  }) {
    this.favorites = [...(state.favorites ?? [])];
    this.entries = new Map(state.entries.map((e) => [e.mediaId, e]));
    this.nextEntryId = state.nextEntryId;
    this.activities = state.activities ?? [];
    this.nextActivityId = state.nextActivityId ?? 1;
  }

  /** AniConnect's browse filters, run the way Page.media runs them. */
  search(text: string, perPage: number, filters: SearchVariables = {}) {
    const ctx: Context = { fake: this, authed: true };
    return findMediaBy(
      {
        search: text || undefined,
        season: filters.season,
        seasonYear: filters.seasonYear,
        genre_in: filters.genres,
        format_in: filters.formats,
        status: filters.status,
        isAdult: filters.isAdult,
        sort: filters.sort ?? ["SEARCH_MATCH"],
      },
      ctx,
    ).slice(0, perPage);
  }

  /** Answers a GraphQL request the way AniList's endpoint does. */
  fetch = async (_url: string, init: RequestInit): Promise<Response> => {
    let body: { query?: string; variables?: Record<string, any> | null };
    try {
      body = JSON.parse(init.body as string);
    } catch {
      return Response.json({ errors: [{ message: "Invalid JSON.", status: 400 }], data: null }, { status: 400 });
    }
    const query = body.query ?? "";
    const variables = body.variables ?? {};
    this.calls.push({ query, variables });
    if (this.stalls(query)) {
      return new Promise((_, reject) => {
        init.signal?.addEventListener("abort", () => reject(init.signal!.reason), { once: true });
      });
    }
    if (this.rateLimited) {
      return Response.json({ errors: [{ message: "Too Many Requests.", status: 429 }], data: null }, {
        status: 429,
        headers: { "Retry-After": this.retryAfter },
      });
    }

    const doc = prepare(query);
    if (!("kind" in doc)) {
      return Response.json(
        { errors: doc.map((e) => ({ message: e.message, status: 400, locations: e.locations })), data: null },
        { status: 400 },
      );
    }
    const authed = /^Bearer\s+\S/i.test(new Headers(init.headers).get("Authorization") ?? "");
    const context: Context = { fake: this, authed };
    const result = await execute({ schema, document: doc, variableValues: variables, contextValue: context, fieldResolver });
    if (!result.errors?.length) return Response.json({ data: result.data });

    const errors = result.errors.map((e) => {
      const original = e.originalError;
      if (original instanceof FakeError) {
        return { message: original.message, status: original.status, locations: e.locations, ...(original.validation && { validation: original.validation }) };
      }
      // Bad variables come back like this from AniList too.
      if (!original) return { message: e.message, status: 400, locations: e.locations };
      // Anything else is a bug in the fake: answer like a server error, and say so.
      console.error(`Fake AniList failed at ${e.path?.join(".")}: ${original.stack}`);
      return { message: `Fake AniList failed: ${original.message}`, status: 500, locations: e.locations };
    });
    return Response.json({ errors, data: result.data ?? null }, { status: errors[0]!.status });
  };
}
