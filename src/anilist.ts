import { AsyncLocalStorage } from "node:async_hooks";
import { tokenExpiry } from "./token";

export const ANILIST_ENDPOINT = "https://graphql.anilist.co";

export const LIST_STATUSES = [
  "CURRENT",
  "PLANNING",
  "COMPLETED",
  "DROPPED",
  "PAUSED",
  "REPEATING",
] as const;
export type ListStatus = (typeof LIST_STATUSES)[number];

/** AniList keeps two lists per user: anime, and manga (which takes in light novels and one-shots). */
export const MEDIA_TYPES = ["ANIME", "MANGA"] as const;
export type MediaType = (typeof MEDIA_TYPES)[number];

/** A media's type; ANIME when it wasn't fetched (AniConnect's default). */
export function typeOf(m: { type?: string | null }): MediaType {
  return m.type === "MANGA" ? "MANGA" : "ANIME";
}

export type ScoreFormat =
  | "POINT_100"
  | "POINT_10_DECIMAL"
  | "POINT_10"
  | "POINT_5"
  | "POINT_3";

/** AniList's title language setting (Settings > Anime & Manga > Title language). */
export type TitleLanguage =
  | "ROMAJI"
  | "ENGLISH"
  | "NATIVE"
  | "ROMAJI_STYLISED"
  | "ENGLISH_STYLISED"
  | "NATIVE_STYLISED";

export interface FuzzyDate {
  year: number | null;
  month: number | null;
  day: number | null;
}

export interface MediaTitle {
  romaji: string | null;
  english: string | null;
  native: string | null;
}

export interface ListEntry {
  id: number;
  status: ListStatus;
  /** Episodes watched, or for a manga, chapters read. */
  progress: number;
  /** Volumes read (manga only; 0 or null for anime). */
  progressVolumes?: number | null;
  /** Score out of 10 (one decimal). 0 means unrated. */
  score: number;
  /** Score in the user's own scoring format, as AniList shows it. */
  displayScore: number;
  startedAt: FuzzyDate;
  completedAt: FuzzyDate;
  /** How many times the user has rewatched it. */
  repeat?: number;
  /** The user's private notes on the entry. */
  notes?: string | null;
  private?: boolean | null;
  hiddenFromStatusLists?: boolean | null;
  /** Every custom list the user has, and whether this entry is on it. */
  customLists?: { name: string; enabled: boolean }[] | null;
}

export interface Media {
  id: number;
  /** ANIME or MANGA; see typeOf. Absent in hand-made test data, which is anime. */
  type?: string | null;
  title: MediaTitle;
  synonyms: string[];
  episodes: number | null;
  /** A manga's chapter and volume counts: null while it's still releasing. */
  chapters?: number | null;
  volumes?: number | null;
  /** Minutes per episode. */
  duration: number | null;
  format: string | null;
  status: string | null;
  seasonYear: number | null;
  startDate: FuzzyDate | null;
  averageScore: number | null;
  /** How many AniList users have it on their list; the resolver weighs a synonym against it. */
  popularity?: number | null;
  siteUrl: string;
  /** Present while a show is airing on a known schedule. `airingAt` is in Unix seconds. */
  nextAiringEpisode: { episode: number; airingAt: number } | null;
  mediaListEntry: ListEntry | null;
  /** Present when fetched with getMany, getRelated or searchAnime. */
  relations?: { edges: RelationEdge[] };
  /** The fields below are present when fetched with `{ oneShow: true }`. */
  externalLinks?: ExternalLink[] | null;
  /** AniList's synopsis: HTML (`<br>`, `<i>`) with markdown spoilers (`~!...!~`); see plainSynopsis. */
  description?: string | null;
  genres?: string[] | null;
  /** What it adapts: MANGA, LIGHT_NOVEL, ORIGINAL, ... (AniList's version 3 list). */
  source?: string | null;
  /** WINTER, SPRING, SUMMER or FALL. */
  season?: string | null;
  /** Only the main studios: the ones that animated it, not the producers. */
  studios?: { nodes: { name: string }[] } | null;
  tags?: MediaTag[] | null;
}

export interface MediaTag {
  name: string;
  /** How relevant the tag is to the show, 0-100. */
  rank: number | null;
  /** An 18+ tag, which AniList hides unless the user's settings show adult content. */
  isAdult: boolean | null;
  /** Spoils this show, or spoils anything (a plot twist as a tag). */
  isMediaSpoiler: boolean | null;
  isGeneralSpoiler: boolean | null;
}

/** A link from AniList's "External & Streaming links" section of a show. */
export interface ExternalLink {
  site: string;
  url: string | null;
  /** STREAMING, INFO (official site) or SOCIAL. */
  type: string | null;
  /** Free text such as a channel or region ("Muse Asia", "EN"). */
  notes: string | null;
  isDisabled: boolean | null;
}

/**
 * Asks a media query for the fields only an answer about one show uses: where it streams
 * and what it's about. Never for the list or for batches of searches, where they'd cost
 * bytes and query complexity for shows nobody asked about.
 */
export interface MediaOptions {
  oneShow?: boolean;
}

function oneShowFields(options: MediaOptions): string {
  return options.oneShow
    ? `externalLinks { site url type notes isDisabled }
      description
      genres
      source(version: 3)
      season
      studios(isMain: true) { nodes { name } }
      tags { name rank isAdult isMediaSpoiler isGeneralSpoiler }`
    : "";
}

export interface RelationEdge {
  relationType: string;
  node: {
    id: number;
    type: string;
    /** Only present when fetched with browseAnime. */
    mediaListEntry?: { status: ListStatus } | null;
    format: string | null;
    status?: string | null;
    episodes?: number | null;
    title?: MediaTitle;
    startDate?: FuzzyDate | null;
  };
}

export const SEASONS = ["WINTER", "SPRING", "SUMMER", "FALL"] as const;
export type Season = (typeof SEASONS)[number];

/** Filters for browsing AniList. Every field is optional except the sort. */
export interface BrowseFilters {
  search?: string;
  season?: Season;
  seasonYear?: number;
  genres?: string[];
  formats?: string[];
  status?: string;
  sort: "SEARCH_MATCH" | "POPULARITY_DESC" | "SCORE_DESC" | "START_DATE_DESC";
  /** As for searchAnime: false hides adult (18+) titles, true returns only them, unset returns both. */
  isAdult?: boolean;
  /** Tags the show must all have, at `minimumTagRank` or above. */
  tags?: string[];
  /** A floor on tag rank (0-100). AniList applies it to `excludeTags` too, so a low-ranked excluded tag slips past. */
  minimumTagRank?: number;
  excludeGenres?: string[];
  excludeTags?: string[];
  /** false: only shows not on the user's list. */
  onList?: boolean;
  /** Start dates as FuzzyDateInt (YYYYMMDD, a year alone as YYYY0000), both bounds exclusive. */
  startAfter?: number;
  startBefore?: number;
  /** Fewer episodes than this; shows with no episode count are left out. */
  episodesBelow?: number;
}

/** An AniList tag, from MediaTagCollection. */
export interface TagName {
  name: string;
  isAdult: boolean | null;
}

/** One episode on AniList's airing schedule. */
export interface Airing {
  episode: number;
  /** Unix seconds. */
  airingAt: number;
  media: Media & { genres: string[] | null; isAdult: boolean | null };
}

/** One of AniList users' recommendations for a show. */
export interface Recommendation {
  /** Net votes for it. */
  rating: number | null;
  /** null when AniList has lost the show (seen live). */
  mediaRecommendation: (Media & { type: string | null; genres: string[] | null; isAdult: boolean | null }) | null;
}

/** One list update from the user's activity feed. */
export interface ListActivity {
  id: number;
  /** AniList's phrase: "watched episode", "completed", "plans to watch", "paused watching", ... */
  status: string | null;
  /** An episode ("7") or, when AniList merged consecutive updates, a range ("3 - 5"). */
  progress: string | null;
  /** Unix seconds. */
  createdAt: number;
  media: { id: number; title: MediaTitle } | null;
}

export interface Viewer {
  id: number;
  name: string;
  scoreFormat: ScoreFormat;
  /** The language the user reads titles in on AniList. */
  titleLanguage: TitleLanguage;
  /** Time zone from the user's AniList settings: an offset like "-05:00" or an IANA name. Null when unset or unreadable. */
  timeZone: string | null;
  /** The account's 18+ content setting. When off, AniList-wide search leaves adult titles out. */
  displayAdultContent: boolean;
}

export class AniListError extends Error {
  /** AniList's own status for the error (404 for an unknown ID), when it gave one. */
  constructor(message: string, readonly status?: number) {
    super(message);
  }
}

export type ListItem = ListEntry & { media: Media };

/**
 * How long the user's list is reused before it is fetched again (requirement R5.4).
 * Our own writes patch it, so this only bounds how long changes made elsewhere
 * (anilist.co, a scrobbler) take to show up in reads. A write reads its show again
 * when the list is older than a few seconds (FRESH_LIST_MS in server.ts).
 */
export const LIST_TTL_MS = 60_000;

/**
 * How long one AniList request may take before it is abandoned. Without a limit a stalled
 * connection hangs for Bun's built-in 5 minutes, and the cached viewer and list promises
 * make every other tool call wait on it too.
 */
export const REQUEST_TIMEOUT_MS = 15_000;

/**
 * AniList's limit, per IP: 30 requests a minute while its API is degraded, 90 normally (its
 * rate-limiting guide, 2026-11-20). Each response's `X-RateLimit-Limit` says which applies,
 * and the limiter follows it.
 */
export const RATE_LIMIT = 30;
export const RATE_WINDOW_MS = 60_000;

/**
 * The longest a request waits for the rate limit, for a free slot or after AniList's
 * `Retry-After`. A short wait lets a large update_shows call finish instead of failing the
 * shows left (R5.1); a longer one is reported instead, since MCP clients commonly give a tool
 * call 60 seconds.
 */
export const RATE_LIMIT_WAIT_MS = 30_000;
const RATE_LIMIT_RETRIES = 1;

/**
 * How long after a tool call starts its requests may still be sent after waiting for the rate
 * limit, so a call of several requests that each wait still answers within that minute.
 */
export const CALL_WAIT_MS = 40_000;
const callDeadline = new AsyncLocalStorage<number>();

/** Runs a tool call, whose requests' rate-limit waits must end by `deadline` (the client's clock). */
export function withWaitDeadline<T>(deadline: number, fn: () => Promise<T>): Promise<T> {
  return callDeadline.run(deadline, fn);
}

/**
 * Reads that fail with a 5xx or a network error are sent once more after this pause, which
 * hides AniList's brief blips. Writes never are: the change may have been saved. Nor are
 * timeouts: a second 15-second wait would take most of a tool call's minute, and an AniList
 * that slow is rarely back a second later.
 */
const RETRY_PAUSE_MS = 1_000;
const SERVER_ERROR_RETRIES = 1;

const isWrite = (query: string) => /^\s*mutation/.test(query);

/**
 * Keeps the AniList clients that share it under AniList's limit: each request books the next
 * free slot in a sliding window, in the order requests arrive (so one user's burst waits its
 * turn behind requests already made, rather than jumping ahead), and waits for it. While
 * another user has a request in the window, one user holds at most half of it, so a burst
 * (an import) can't take a whole minute from someone else; a user alone has all of it. A 429
 * seen by any client pauses them all. It has no clock of its own: callers pass theirs, so
 * tests control time.
 */
export class RateLimiter {
  /** When each request in the window was or will be sent, and whose it is, ascending (booked slots included). */
  private sent: { at: number; owner: string | undefined }[] = [];
  private pausedUntil = Number.NEGATIVE_INFINITY;
  /** Requests turned away with "try again in N seconds", since the process started. */
  refused = 0;
  /** 429s from AniList, since the process started. */
  rateLimited = 0;

  /** `Infinity` for no limit of its own (a fake AniList), so only 429s pause it. */
  constructor(public limit = RATE_LIMIT) {}

  /**
   * Books the first slot at or after `now` for `owner` (a user; requests without one count as
   * one user), unless it is after `deadline`. Returns the slot's time, or how long to wait
   * (nothing booked).
   */
  book(now: number, deadline = now + RATE_LIMIT_WAIT_MS, owner?: string): { at: number } | { waitMs: number } {
    while (this.sent.length && this.sent[0]!.at <= now - RATE_WINDOW_MS) this.sent.shift();
    let at = Math.max(now, this.pausedUntil, this.fairTurn(owner));
    // No minute may hold more than the limit. A capped user's slots are booked ahead of others',
    // so the latest `limit` slots aren't always the ones to check: check every run of them.
    for (let i = 0; i + this.limit <= this.sent.length; i++) {
      const first = this.sent[i]!.at;
      const last = this.sent[i + this.limit - 1]!.at;
      if (last - first < RATE_WINDOW_MS && at > last - RATE_WINDOW_MS && at < first + RATE_WINDOW_MS) at = first + RATE_WINDOW_MS;
    }
    // A request that needn't wait goes, however late its tool call is.
    if (at > now && at > deadline) return { waitMs: at - now };
    if (Number.isFinite(this.limit)) this.insert(at, owner);
    return { at };
  }

  /**
   * The earliest `owner` may book while another user has a slot in the window and `owner` holds
   * half of it or more: when its oldest slot over half leaves the window.
   */
  private fairTurn(owner: string | undefined): number {
    const share = Math.ceil(this.limit / 2);
    const mine = this.sent.filter((s) => s.owner === owner).map((s) => s.at);
    if (mine.length < share || mine.length === this.sent.length) return Number.NEGATIVE_INFINITY;
    return mine[mine.length - share]! + RATE_WINDOW_MS;
  }

  /** The limit, what is booked in the minute up to `now`, and how long a 429 still pauses requests. */
  snapshot(now: number): { limit: number; used: number; pausedForMs: number } {
    return {
      limit: this.limit,
      used: this.sent.filter((s) => s.at > now - RATE_WINDOW_MS && s.at <= now).length,
      pausedForMs: Math.max(0, this.pausedUntil - now),
    };
  }

  /** When requests may be sent again after a 429; later than `at` when one came since. */
  resumesAt(at: number): number {
    return Math.max(at, this.pausedUntil);
  }

  /**
   * A booked request goes at `to` instead (it waited out a 429), or, with null, not at all
   * (it gave up, or AniList refused it with a 429 and so didn't run it): so the window counts
   * requests when they are really sent.
   */
  move(from: number, to: number | null, owner?: string): void {
    if (!Number.isFinite(this.limit)) return;
    const i = this.sent.findIndex((s) => s.at === from && s.owner === owner);
    if (i >= 0) this.sent.splice(i, 1);
    if (to !== null) this.insert(to, owner);
  }

  /** AniList answered 429: nothing is sent until `until`. */
  pause(until: number): void {
    this.rateLimited++;
    this.pausedUntil = Math.max(this.pausedUntil, until);
  }

  /**
   * Follows the limit AniList states. `X-RateLimit-Remaining` isn't used: it can't say when
   * requests this process didn't send (another app on the IP) leave AniList's window, so
   * counting them would block slots on a guess; a 429 pauses everyone instead.
   */
  follow(headers: Headers): void {
    const limit = Number(headers.get("X-RateLimit-Limit") ?? Number.NaN);
    if (Number.isFinite(this.limit) && Number.isInteger(limit) && limit > 0) this.limit = limit;
  }

  private insert(at: number, owner: string | undefined): void {
    let i = this.sent.length;
    while (i > 0 && this.sent[i - 1]!.at > at) i--;
    this.sent.splice(i, 0, { at, owner });
  }
}

/** Shared by every client in the process that reaches AniList itself (see the constructor). */
export const ANILIST_LIMITER = new RateLimiter();

/** How long AniList's tag list is trusted: it changes a few times a year. */
const TAG_TTL_MS = 24 * 60 * 60_000;

/** AniList's tag list (430 tags), shared by every user of the process: it's public. */
let tagCollection: { at: number; tags: TagName[] } | null = null;

/** Drops the cached tag list (for tests). */
export function forgetTagCollection(): void {
  tagCollection = null;
}

/** Schedule pages of 50 read for an airing range: three in one request, then one more. */
export const AIRING_PAGES = 4;

/**
 * Title searches sent in one request (aliased Page queries). AniList refuses a query over 500
 * complexity; each search of 15 results with relations counts 59, or 78 with the one-show
 * fields (streaming links 6, details 13; measured 2026-11-20, with popularity), so 7 fit, or 6 with them.
 */
const SEARCH_BATCH = 7;
const ONE_SHOW_SEARCH_BATCH = 6;

/** How many title searches one request carries, with these options. */
export function searchBatch(options: MediaOptions): number {
  return options.oneShow ? ONE_SHOW_SEARCH_BATCH : SEARCH_BATCH;
}

/**
 * Reads AniList's time zone setting, documented as an offset ("-05:00", "+05:30"), into a
 * zone `Intl` accepts: a canonical "+HH:MM" offset, or an IANA name if that's what is stored.
 * Returns null for an empty or unreadable value, so callers fall back to the server's zone.
 */
export function parseTimeZone(raw: string | null | undefined): string | null {
  const value = raw?.trim();
  if (!value) return null;
  const offset = /^(?:UTC|GMT)?\s*([+-]?)(\d{1,2})(?::?(\d{2}))?$/i.exec(value);
  if (offset) {
    const [, sign, h, m = "00"] = offset;
    if (Number(h) > 14 || Number(m) > 59) return null;
    return `${sign === "-" ? "-" : "+"}${h!.padStart(2, "0")}:${m}`;
  }
  try {
    return new Intl.DateTimeFormat("en-US", { timeZone: value }).resolvedOptions().timeZone;
  } catch {
    return null;
  }
}

/**
 * How long a 429 says to wait: `Retry-After` (seconds), else `X-RateLimit-Reset` (a Unix time),
 * else the minute AniList's guide says it locks a client out for.
 */
function retryAfter(headers: Headers, now: number): number {
  const seconds = Number(headers.get("Retry-After") ?? Number.NaN);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
  const reset = Number(headers.get("X-RateLimit-Reset") ?? Number.NaN);
  if (Number.isFinite(reset) && reset > 0) return Math.max(0, reset * 1000 - now);
  return RATE_WINDOW_MS;
}

export type FetchFn = (input: string, init: RequestInit) => Promise<Response>;

const MEDIA_FIELDS = `
  id
  type
  title { romaji english native }
  synonyms
  episodes
  chapters
  volumes
  duration
  format
  status
  seasonYear
  startDate { year month day }
  averageScore
  popularity
  siteUrl
  nextAiringEpisode { episode airingAt }
`;

/** What each related anime carries, wherever relations are fetched. */
const RELATION_EDGE = `
  relationType
  node { id type format status episodes title { romaji english native } startDate { year month day } }
`;

const ENTRY_FIELDS = `
  id
  status
  progress
  progressVolumes
  score(format: POINT_10_DECIMAL)
  displayScore: score
  startedAt { year month day }
  completedAt { year month day }
  repeat
  notes
  private
  hiddenFromStatusLists
  customLists(asArray: true)
`;

/** How long account settings (such as the 18+ content setting) are trusted before being read again. */
const VIEWER_TTL_MS = 5 * 60_000;

/**
 * What a client caches about the user: their settings and list, and the writes in flight. The
 * hosted server gives each of a user's sign-ins its own client (each with its own token) and
 * lets them share one of these, so a write through one is seen by the others.
 */
interface CachedList {
  fetchedAt: number;
  entries: Promise<Map<number, ListItem>>;
}

export class UserCache {
  viewer: Promise<Viewer> | null = null;
  viewerAt = 0;
  /** Each of the user's lists (anime, manga) keyed by media ID, shared by calls that start while it loads. */
  lists: Partial<Record<MediaType, CachedList>> = {};
  /** Writes in flight, by media ID (null: any); each is flagged if another write to it overlapped. */
  readonly writes = new Set<{ mediaId: number | null; overlapped: boolean }>();
  /**
   * How many clients have shared this cache. Never lowered: a sign-in left on its own may still
   * hold data another one fetched, so it goes on being checked (see `confirm`).
   */
  clients = 0;
}

export class AniListClient {
  /** When the token expires (ms), read from the JWT; null if it can't be decoded. */
  readonly tokenExpiresAt: number | null;
  /** Clock for the list cache; createServer sets it so tests control expiry. */
  now: () => number = Date.now;
  /** How long one request may take; tests shorten it. */
  requestTimeoutMs = REQUEST_TIMEOUT_MS;
  /** How waits for the rate limit, and before a retry, pass; tests replace it. */
  sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
  private readonly fetchFn: FetchFn;
  /** How to get a new token: set by the hosted server, which signs users in itself (R7.2). */
  renew: string | null = null;
  /** Whose requests these are, so the limiter can share AniList's limit fairly: set by the hosted server to the AniList account. */
  owner: string | undefined;
  /** Set once AniList has rejected the token (revoked, or expired early). */
  rejected = false;
  /** When AniList last accepted this client's own token. */
  private acceptedAt = Number.NEGATIVE_INFINITY;
  /** A check of the token in flight (see `confirm`). */
  private confirming: Promise<void> | null = null;

  /**
   * `limiter` defaults to the one every client reaching AniList itself shares, since AniList's
   * limit is per IP. A client given its own `fetchFn` (a fake AniList) gets one with no limit,
   * which still pauses on a 429, unless it is given a limiter.
   */
  constructor(
    private readonly token: string,
    fetchFn?: FetchFn,
    private readonly cache: UserCache = new UserCache(),
    readonly limiter: RateLimiter = fetchFn ? new RateLimiter(Number.POSITIVE_INFINITY) : ANILIST_LIMITER,
  ) {
    this.fetchFn = fetchFn ?? ((input, init) => fetch(input, init));
    this.tokenExpiresAt = tokenExpiry(token);
    cache.clients++;
  }

  /**
   * With a cache shared by several sign-ins, makes sure AniList has accepted this one's own
   * token lately (as often as the list is refetched) before it is answered from the cache, so a
   * sign-in AniList has stopped accepting can't keep reading what the others fetched. The
   * check isn't shared, so its failure is never another sign-in's.
   */
  private confirm(): Promise<void> {
    if (this.cache.clients < 2 || this.now() - this.acceptedAt < LIST_TTL_MS) return Promise.resolve();
    return (this.confirming ??= this.fetchViewer()
      .then((viewer) => {
        this.cache.viewer = Promise.resolve(viewer);
        this.cache.viewerAt = this.now();
      })
      .finally(() => {
        this.confirming = null;
      }));
  }

  async request<T>(query: string, variables: Record<string, unknown> = {}): Promise<T> {
    let rateLimited = 0;
    let failed = 0;
    for (;;) {
      const sentAt = await this.waitForSlot();
      const result = await this.attempt<T>(query, variables);
      if ("data" in result) return result.data;
      if ("failed" in result) {
        if (isWrite(query) || failed++ >= SERVER_ERROR_RETRIES) throw result.failed;
        await this.sleep(RETRY_PAUSE_MS);
        continue;
      }
      // A rate-limited request wasn't run: it gives its slot back, and even a write is safe to
      // send again, after the pause that every client sharing the limiter now waits out.
      this.limiter.move(sentAt, null, this.owner);
      const now = this.now();
      this.limiter.pause(now + result.retryAfterMs);
      if (rateLimited++ >= RATE_LIMIT_RETRIES) throw this.rateLimitError(this.limiter.resumesAt(now) - now);
    }
  }

  /**
   * Waits for this request's turn under the rate limit and returns when that was, or fails if
   * it's too far off: more than RATE_LIMIT_WAIT_MS, or past the tool call's deadline.
   */
  private async waitForSlot(): Promise<number> {
    const start = this.now();
    const deadline = Math.min(start + RATE_LIMIT_WAIT_MS, callDeadline.getStore() ?? Number.POSITIVE_INFINITY);
    const slot = this.limiter.book(start, deadline, this.owner);
    if ("waitMs" in slot) throw this.rateLimitError(slot.waitMs);
    // A 429 seen by another client while this one waits pauses it too; `at` is when it last
    // woke (a fake clock may not have moved).
    let at = start;
    for (let until = slot.at; until > at; until = this.limiter.resumesAt(at)) {
      if (until > deadline) {
        this.limiter.move(slot.at, null, this.owner);
        throw this.rateLimitError(until - at);
      }
      await this.sleep(until - at);
      at = Math.max(this.now(), until);
    }
    if (at !== slot.at) this.limiter.move(slot.at, at, this.owner);
    return at;
  }

  private rateLimitError(waitMs: number): AniListError {
    this.limiter.refused++;
    const limit = Number.isFinite(this.limiter.limit) ? this.limiter.limit : RATE_LIMIT;
    return new AniListError(
      `AniList rate limit hit (${limit} requests a minute). Try again in ${Math.ceil(waitMs / 1000)} seconds.`,
    );
  }

  /**
   * One try at a request: its data; how long AniList says to wait when rate-limited; or, for a
   * 5xx or a network error, the error, which a read may be retried after.
   */
  private async attempt<T>(
    query: string,
    variables: Record<string, unknown>,
  ): Promise<{ data: T } | { retryAfterMs: number } | { failed: AniListError }> {
    const signal = AbortSignal.timeout(this.requestTimeoutMs);
    const timedOut = () =>
      new AniListError(
        `AniList didn't respond within ${this.requestTimeoutMs / 1000} seconds` +
          // A write may have been saved even though the answer never came.
          (isWrite(query)
            ? ", so the change may or may not have been saved; check the list before trying again."
            : "; try again."),
      );
    let res: Response;
    try {
      res = await this.fetchFn(ANILIST_ENDPOINT, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
          Authorization: `Bearer ${this.token}`,
        },
        body: JSON.stringify({ query, variables }),
        signal,
      });
    } catch (err) {
      if (signal.aborted) throw timedOut();
      return { failed: new AniListError(`Could not reach AniList: ${(err as Error).message}`) };
    }
    this.limiter.follow(res.headers);
    if (res.status === 429) return { retryAfterMs: retryAfter(res.headers, this.now()) };
    // A 5xx is AniList's own trouble, which a read may get past by asking again.
    const fail = (err: AniListError) => {
      if (res.status >= 500) return { failed: err };
      throw err;
    };

    let body: {
      data?: T;
      errors?: { message: string; status?: number; validation?: Record<string, string[]> }[];
    };
    try {
      body = (await res.json()) as typeof body;
    } catch {
      // The signal also covers reading the body, so a stall there ends up here.
      if (signal.aborted) throw timedOut();
      if (res.status === 401) return this.rejectToken("HTTP 401");
      return fail(new AniListError(`AniList returned HTTP ${res.status} with a non-JSON body.`));
    }

    // Validation errors carry their real reason in `validation`, e.g. {"id": ["The selected id is invalid."]}.
    const messages = (body.errors ?? [])
      .map((e) =>
        e.validation
          ? Object.entries(e.validation)
              .map(([field, reasons]) => `${field}: ${reasons.join(" ")}`)
              .join("; ")
          : e.message,
      )
      .join("; ");
    // A 401 means the token, whatever the body says (AniList usually sends "Invalid token", but not always).
    if (res.status === 401 || /invalid token/i.test(messages)) return this.rejectToken(messages || "HTTP 401");
    if (body.errors?.length) {
      return fail(new AniListError(`AniList error: ${messages}`, body.errors[0]!.status ?? res.status));
    }
    if (!res.ok || !body.data) {
      return fail(new AniListError(`AniList returned HTTP ${res.status}.`));
    }
    this.acceptedAt = this.now();
    return { data: body.data };
  }

  private rejectToken(reason: string): never {
    this.rejected = true;
    throw new AniListError(
      `AniList rejected the token (${reason}). ${this.renew ?? "Check ANILIST_TOKEN; tokens expire after a year."}`,
    );
  }

  /**
   * Re-read every few minutes (settings can change), and cached as a promise so calls
   * that start together share one request.
   */
  async getViewer(): Promise<Viewer> {
    await this.confirm();
    if (this.cache.viewer && this.now() - this.cache.viewerAt < VIEWER_TTL_MS) return this.cache.viewer;
    this.cache.viewerAt = this.now();
    const pending = this.fetchViewer()
      // After the mapping, so a malformed response isn't cached either.
      .catch((err) => {
        if (this.cache.viewer === pending) this.cache.viewer = null; // Let the next call try again.
        throw err;
      });
    this.cache.viewer = pending;
    return this.cache.viewer;
  }

  private fetchViewer(): Promise<Viewer> {
    return this.request<{
      Viewer: {
        id: number;
        name: string;
        mediaListOptions: { scoreFormat: ScoreFormat };
        options: { titleLanguage: TitleLanguage | null; timezone: string | null; displayAdultContent: boolean | null } | null;
      };
    }>(`query { Viewer { id name mediaListOptions { scoreFormat } options { titleLanguage timezone displayAdultContent } } }`).then(
      (data) => ({
        id: data.Viewer.id,
        name: data.Viewer.name,
        scoreFormat: data.Viewer.mediaListOptions.scoreFormat,
        // AniList's own default for new accounts.
        titleLanguage: data.Viewer.options?.titleLanguage ?? "ROMAJI",
        timeZone: parseTimeZone(data.Viewer.options?.timezone),
        displayAdultContent: data.Viewer.options?.displayAdultContent ?? false,
      }));
  }

  /** Drops the cached viewer, so the next call re-reads settings the user may have just changed. */
  forgetViewer(): void {
    this.cache.viewer = null;
  }

  /**
   * `isAdult: false` leaves out adult (18+) titles and `true` returns only them;
   * leaving it out returns both, as AniList does when the argument is omitted.
   */
  async searchAnime(
    search: string,
    perPage: number,
    options: MediaOptions = {},
    isAdult?: boolean,
    type: MediaType = "ANIME",
  ): Promise<Media[]> {
    return (await this.searchMany([search], perPage, options, isAdult, type))[0]!;
  }

  /**
   * Several title searches in one request, as aliased Page queries (searchBatch per request),
   * so resolving a batch of names costs one request instead of one each against AniList's
   * rate limit. Results are in the order of `searches`, each as searchAnime would return it.
   * `type` searches the manga instead.
   */
  async searchMany(
    searches: string[],
    perPage: number,
    options: MediaOptions = {},
    isAdult?: boolean,
    type: MediaType = "ANIME",
  ): Promise<Media[][]> {
    const results: Media[][] = [];
    const size = searchBatch(options);
    for (let i = 0; i < searches.length; i += size) {
      const chunk = searches.slice(i, i + size);
      const pages = chunk
        .map(
          (_, j) => `s${j}: Page(perPage: $perPage) {
            media(search: $search${j}, type: $type, sort: SEARCH_MATCH, isAdult: $isAdult) {
              ${MEDIA_FIELDS}
              ${oneShowFields(options)}
              mediaListEntry { ${ENTRY_FIELDS} }
              relations { edges { ${RELATION_EDGE} } }
            }
          }`,
        )
        .join("\n");
      const params = chunk.map((_, j) => `$search${j}: String`).join(", ");
      const data = await this.request<Record<string, { media: Media[] }>>(
        `query (${params}, $perPage: Int, $isAdult: Boolean, $type: MediaType) {\n${pages}\n}`,
        { ...Object.fromEntries(chunk.map((search, j) => [`search${j}`, search])), perPage, isAdult, type },
      );
      results.push(...chunk.map((_, j) => data[`s${j}`]!.media));
    }
    return results;
  }

  /**
   * Searches and filters AniList in one request. Each result carries its prequels and the
   * user's status on them, so "continues a show you completed" costs no extra request.
   * With `fetchTags`, AniList's tag list comes back in the same request (and is cached, see
   * cachedTags), so tags can be checked without a request of their own.
   */
  async browseAnime(
    filters: BrowseFilters,
    perPage: number,
    page = 1,
    fetchTags = false,
  ): Promise<{ media: Media[]; hasNextPage: boolean; tags?: TagName[] }> {
    const data = await this.request<{ Page: { pageInfo: { hasNextPage: boolean | null }; media: Media[] }; MediaTagCollection?: TagName[] }>(
      `query (
        $search: String, $season: MediaSeason, $seasonYear: Int, $genres: [String],
        $formats: [MediaFormat], $status: MediaStatus, $sort: [MediaSort], $perPage: Int, $page: Int, $isAdult: Boolean,
        $tags: [String], $minimumTagRank: Int, $excludeGenres: [String], $excludeTags: [String], $onList: Boolean,
        $startAfter: FuzzyDateInt, $startBefore: FuzzyDateInt, $episodesBelow: Int
      ) {
        ${fetchTags ? "MediaTagCollection { name isAdult }" : ""}
        Page(perPage: $perPage, page: $page) {
          pageInfo { hasNextPage }
          media(
            search: $search, type: ANIME, season: $season, seasonYear: $seasonYear,
            genre_in: $genres, format_in: $formats, status: $status, sort: $sort, isAdult: $isAdult,
            tag_in: $tags, minimumTagRank: $minimumTagRank, genre_not_in: $excludeGenres, tag_not_in: $excludeTags,
            onList: $onList, startDate_greater: $startAfter, startDate_lesser: $startBefore, episodes_lesser: $episodesBelow
          ) {
            ${MEDIA_FIELDS}
            mediaListEntry { ${ENTRY_FIELDS} }
            relations {
              edges {
                relationType
                node { id type format title { romaji english native } mediaListEntry { status } }
              }
            }
          }
        }
      }`,
      { ...filters, sort: [filters.sort], perPage, page },
    );
    if (data.MediaTagCollection) tagCollection = { at: this.now(), tags: data.MediaTagCollection };
    return {
      media: data.Page.media,
      hasNextPage: Boolean(data.Page.pageInfo.hasNextPage),
      ...(data.MediaTagCollection && { tags: data.MediaTagCollection }),
    };
  }

  /** AniList's tag list if it was fetched in the last day, else undefined (fetch it with browseAnime). */
  cachedTags(): TagName[] | undefined {
    return tagCollection && this.now() - tagCollection.at < TAG_TTL_MS ? tagCollection.tags : undefined;
  }

  /**
   * Episodes airing from `from` (inclusive) to `to` (exclusive), Unix seconds, in air-time
   * order. Reads up to AIRING_PAGES pages of 50: three as aliases in one request, then the
   * fourth if the third had more. `pageInfo.total` isn't used: AniList answers 5000 for any range.
   */
  async airingBetween(from: number, to: number): Promise<{ airings: Airing[]; truncated: boolean }> {
    const fields = `pageInfo { hasNextPage }
      airingSchedules(airingAt_greater: $after, airingAt_lesser: $before, sort: [TIME]) {
        episode
        airingAt
        media { ${MEDIA_FIELDS} genres isAdult mediaListEntry { ${ENTRY_FIELDS} } }
      }`;
    type SchedulePage = { pageInfo: { hasNextPage: boolean | null }; airingSchedules: Airing[] };
    const read = async (pages: number[]) => {
      const query = pages.map((p) => `p${p}: Page(page: ${p}, perPage: 50) { ${fields} }`).join("\n");
      const data = await this.request<Record<string, SchedulePage>>(
        `query ($after: Int, $before: Int) {\n${query}\n}`,
        { after: from - 1, before: to },
      );
      return pages.map((p) => data[`p${p}`]!);
    };
    const pages = await read([1, 2, 3]);
    if (pages.at(-1)!.pageInfo.hasNextPage && AIRING_PAGES > 3) pages.push(...(await read([4])));
    // A page that says there's no next one ends the range, whatever the later aliases hold.
    const end = pages.findIndex((p) => !p.pageInfo.hasNextPage);
    const used = end === -1 ? pages : pages.slice(0, end + 1);
    // AniList's schema lets a schedule entry lose its show; those are skipped.
    return { airings: used.flatMap((p) => p.airingSchedules).filter((a) => a.media), truncated: end === -1 };
  }

  /**
   * AniList users' recommendations for a show, most voted first (25, the most AniList gives in a page), with
   * the show's own relations, so its sequels and side stories can be told apart.
   */
  async getRecommendations(mediaId: number): Promise<{ relatedIds: number[]; recommendations: Recommendation[] }> {
    const data = await this.request<{
      Media: { relations: { edges: { relationType: string; node: { id: number } }[] }; recommendations: { nodes: Recommendation[] } } | null;
    }>(
      `query ($id: Int) {
        Media(id: $id, type: ANIME) {
          relations { edges { relationType node { id } } }
          recommendations(sort: [RATING_DESC], perPage: 25) {
            nodes {
              rating
              mediaRecommendation {
                ${MEDIA_FIELDS}
                type
                genres
                isAdult
                mediaListEntry { ${ENTRY_FIELDS} }
                relations {
                  edges {
                    relationType
                    node { id type format title { romaji english native } mediaListEntry { status } }
                  }
                }
              }
            }
          }
        }
      }`,
      { id: mediaId },
    );
    if (!data.Media) throw new AniListError(`No anime found with id ${mediaId}.`);
    return {
      // A crossover (CHARACTER, OTHER: Isekai Quartet, another work by the author) isn't the show's franchise.
      relatedIds: data.Media.relations.edges
        .filter((e) => e.relationType !== "CHARACTER" && e.relationType !== "OTHER")
        .map((e) => e.node.id),
      recommendations: data.Media.recommendations.nodes,
    };
  }

  /** An anime or manga by ID (AniList's IDs don't repeat across the two); `type` says which it is. */
  async getMedia(mediaId: number): Promise<Media> {
    const data = await this.request<{ Media: Media | null }>(
      `query ($id: Int) {
        Media(id: $id) {
          ${MEDIA_FIELDS}
          mediaListEntry { ${ENTRY_FIELDS} }
        }
      }`,
      { id: mediaId },
    ).catch((err) => {
      // AniList answers an unknown ID with HTTP 404 "Not Found.".
      if (err instanceof AniListError && err.status === 404) return { Media: null };
      throw err;
    });
    if (!data.Media) {
      throw new AniListError(`No anime or manga found with id ${mediaId}. Check the number, or pass the show's name.`);
    }
    return data.Media;
  }

  /** Fetches several anime (or manga) at once, with their relations (sequels, prequels, ...). */
  async getMany(ids: number[], options: MediaOptions = {}): Promise<Media[]> {
    if (ids.length === 0) return [];
    const data = await this.request<{ Page: { media: Media[] } }>(
      `query ($ids: [Int]) {
        Page(perPage: 50) {
          media(id_in: $ids) {
            ${MEDIA_FIELDS}
            ${oneShowFields(options)}
            mediaListEntry { ${ENTRY_FIELDS} }
            relations { edges { ${RELATION_EDGE} } }
          }
        }
      }`,
      { ids },
    );
    return data.Page.media;
  }

  /**
   * Like getMany, but each related anime comes back in full (with the user's list entry)
   * and with its own relations, so one request covers two steps of a sequel chain.
   * AniList fills in relations only two levels deep; a third level comes back empty.
   */
  async getRelated(ids: number[], options: MediaOptions = {}): Promise<Media[]> {
    if (ids.length === 0) return [];
    const data = await this.request<{ Page: { media: Media[] } }>(
      `query ($ids: [Int]) {
        Page(perPage: 50) {
          media(id_in: $ids) {
            ${MEDIA_FIELDS}
            ${oneShowFields(options)}
            mediaListEntry { ${ENTRY_FIELDS} }
            relations {
              edges {
                relationType
                node {
                  type
                  ${MEDIA_FIELDS}
                  ${oneShowFields(options)}
                  mediaListEntry { ${ENTRY_FIELDS} }
                  relations { edges { ${RELATION_EDGE} } }
                }
              }
            }
          }
        }
      }`,
      { ids },
    );
    return data.Page.media;
  }

  /**
   * The user's anime list (or with `type`, their manga list), from a cache that lives for
   * LIST_TTL_MS and is patched by our own writes.
   */
  async getMyList(status?: ListStatus, type: MediaType = "ANIME"): Promise<ListItem[]> {
    await this.confirm();
    let list = this.cache.lists[type];
    if (!list || this.now() - list.fetchedAt >= LIST_TTL_MS) {
      const fresh = { fetchedAt: this.now(), entries: this.fetchMyList(type) };
      this.cache.lists[type] = list = fresh;
      fresh.entries.catch(() => {
        if (this.cache.lists[type] === fresh) delete this.cache.lists[type];
      });
    }
    const entries = [...(await list.entries).values()];
    return status ? entries.filter((e) => e.status === status) : entries;
  }

  /**
   * How long ago the cached list was fetched, so a write can tell whether a show taken from it
   * may miss a change made elsewhere since. Infinity when none is cached: one dropped after a
   * failed or overlapping write may have been read before it was dropped.
   */
  listAge(type: MediaType = "ANIME"): number {
    const list = this.cache.lists[type];
    return list ? this.now() - list.fetchedAt : Infinity;
  }

  private async fetchMyList(type: MediaType): Promise<Map<number, ListItem>> {
    const viewer = await this.getViewer();
    const data = await this.request<{
      MediaListCollection: { lists: { entries: ListItem[] }[] };
    }>(
      `query ($userId: Int, $type: MediaType) {
        MediaListCollection(userId: $userId, type: $type) {
          lists {
            entries {
              ${ENTRY_FIELDS}
              media { ${MEDIA_FIELDS} }
            }
          }
        }
      }`,
      { userId: viewer.id, type },
    );
    // An entry can appear in more than one list (e.g. a status list and a custom list).
    const entries = new Map<number, ListItem>();
    for (const list of data.MediaListCollection.lists) {
      for (const entry of list.entries) entries.set(entry.media.id, entry);
    }
    return entries;
  }

  /**
   * Applies one of our own writes to the cached list, after it finishes loading if it is
   * still in flight. A failed write may or may not have landed, overlapping writes to the
   * same show can answer out of order, and a list refetched mid-write may be newer than the
   * write's answer, so all of these drop the cache instead. `patch` is given each cached list
   * (anime, manga) and its type.
   */
  private async patchList<T>(
    mediaId: number | null,
    write: Promise<T>,
    patch: (entries: Map<number, ListItem>, result: T, type: MediaType) => void,
  ): Promise<T> {
    const self = { mediaId, overlapped: false };
    const startLists = { ...this.cache.lists };
    for (const other of this.cache.writes) {
      if (other.mediaId === null || mediaId === null || other.mediaId === mediaId) {
        other.overlapped = self.overlapped = true;
      }
    }
    this.cache.writes.add(self);
    let result: T;
    try {
      result = await write;
    } catch (err) {
      this.cache.lists = {};
      throw err;
    } finally {
      this.cache.writes.delete(self);
    }
    // A list fetched while the write was in flight may already hold something newer.
    if (self.overlapped || MEDIA_TYPES.some((t) => this.cache.lists[t] !== startLists[t])) this.cache.lists = {};
    else {
      for (const type of MEDIA_TYPES) {
        const list = this.cache.lists[type];
        if (!list) continue;
        list.entries = list.entries.then((entries) => {
          patch(entries, result, type);
          return entries;
        });
        list.entries.catch(() => {
          if (this.cache.lists[type] === list) delete this.cache.lists[type];
        });
      }
    }
    return result;
  }

  /**
   * The user's own anime list activity, newest first: up to `pages` pages (default 1) of 50,
   * one request each, stopping at the last. `from` and `to` are Unix seconds (from
   * inclusive, to exclusive). Updates `light` is true for (a bulk import's adds) don't use
   * up `pages`: each 50 of them read buys one more page, up to `maxPages` in all.
   */
  async getMyActivity(options: {
    from?: number;
    to?: number;
    mediaId?: number;
    pages?: number;
    maxPages?: number;
    light?: (a: ListActivity) => boolean;
  }): Promise<{ activities: ListActivity[]; hasNextPage: boolean }> {
    const viewer = await this.getViewer();
    const activities = new Map<number, ListActivity>();
    const pages = options.pages ?? 1;
    const maxPages = Math.max(pages, options.maxPages ?? pages);
    const light = options.light;
    const allowed = () => {
      if (!light) return pages;
      let n = 0;
      for (const a of activities.values()) if (light(a)) n++;
      return Math.min(maxPages, pages + Math.floor(n / 50));
    };
    let hasNextPage = true;
    for (let page = 1; hasNextPage && page <= allowed(); page++) {
      const data = await this.request<{
        Page: { pageInfo: { hasNextPage: boolean }; activities: (ListActivity | Record<string, never>)[] };
      }>(
        `query ($userId: Int, $mediaId: Int, $from: Int, $to: Int, $page: Int) {
        Page(page: $page, perPage: 50) {
          pageInfo { hasNextPage }
          activities(
            userId: $userId, mediaId: $mediaId, type: ANIME_LIST, sort: ID_DESC,
            createdAt_greater: $from, createdAt_lesser: $to
          ) {
            ... on ListActivity {
              id status progress createdAt
              media { id title { romaji english native } }
            }
          }
        }
      }`,
        {
          userId: viewer.id,
          mediaId: options.mediaId,
          // AniList's bounds are exclusive on both ends.
          from: options.from !== undefined ? options.from - 1 : undefined,
          to: options.to,
          page,
        },
      );
      // Activity logged while paging pushes older activity down a page; keep each once.
      for (const a of data.Page.activities.filter((a): a is ListActivity => "id" in a)) activities.set(a.id, a);
      hasNextPage = data.Page.pageInfo.hasNextPage;
    }
    return { activities: [...activities.values()], hasNextPage };
  }

  async saveEntry(input: {
    mediaId: number;
    status?: ListStatus;
    progress?: number;
    progressVolumes?: number;
    scoreRaw?: number;
    startedAt?: FuzzyDate;
    completedAt?: FuzzyDate;
    repeat?: number;
    notes?: string;
    private?: boolean;
    hiddenFromStatusLists?: boolean;
    customLists?: string[];
  }): Promise<ListItem> {
    const save = this.request<{ SaveMediaListEntry: ListItem }>(
      `mutation (
        $mediaId: Int, $status: MediaListStatus, $progress: Int, $progressVolumes: Int, $scoreRaw: Int,
        $startedAt: FuzzyDateInput, $completedAt: FuzzyDateInput, $repeat: Int, $notes: String,
        $private: Boolean, $hiddenFromStatusLists: Boolean, $customLists: [String]
      ) {
        SaveMediaListEntry(
          mediaId: $mediaId, status: $status, progress: $progress, progressVolumes: $progressVolumes, scoreRaw: $scoreRaw,
          startedAt: $startedAt, completedAt: $completedAt, repeat: $repeat, notes: $notes,
          private: $private, hiddenFromStatusLists: $hiddenFromStatusLists, customLists: $customLists
        ) {
          ${ENTRY_FIELDS}
          media { ${MEDIA_FIELDS} }
        }
      }`,
      input,
    ).then((data) => data.SaveMediaListEntry);
    return this.patchList(input.mediaId, save, (entries, saved, type) => {
      if (typeOf(saved.media) === type) entries.set(saved.media.id, saved);
    });
  }

  async deleteEntry(entryId: number): Promise<boolean> {
    const remove = this.request<{ DeleteMediaListEntry: { deleted: boolean } }>(
      `mutation ($id: Int) { DeleteMediaListEntry(id: $id) { deleted } }`,
      { id: entryId },
    ).then((data) => data.DeleteMediaListEntry.deleted);
    return this.patchList(null, remove, (entries, deleted) => {
      if (!deleted) return;
      for (const [mediaId, entry] of entries) if (entry.id === entryId) entries.delete(mediaId);
    });
  }
}
