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
  progress: number;
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
  title: MediaTitle;
  synonyms: string[];
  episodes: number | null;
  /** Minutes per episode. */
  duration: number | null;
  format: string | null;
  status: string | null;
  seasonYear: number | null;
  startDate: FuzzyDate | null;
  averageScore: number | null;
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
 * (anilist.co, a scrobbler) take to show up, and how stale the progress a write
 * counts up from can be.
 */
export const LIST_TTL_MS = 60_000;

/**
 * How long one AniList request may take before it is abandoned. Without a limit a stalled
 * connection hangs for Bun's built-in 5 minutes, and the cached viewer and list promises
 * make every other tool call wait on it too.
 */
export const REQUEST_TIMEOUT_MS = 15_000;

/**
 * The longest wait AniList can ask for after a rate-limited request that is still made, once:
 * AniList allows 30 requests a minute (90 when it isn't degraded), so a large update_shows call
 * can hit the limit, and one short wait finishes it instead of failing the shows left (R5.1).
 * Longer waits are reported instead: MCP clients commonly give a tool call 60 seconds.
 */
export const RATE_LIMIT_WAIT_MS = 30_000;
const RATE_LIMIT_RETRIES = 1;

/**
 * Title searches sent in one request (aliased Page queries). AniList refuses a query over 500
 * complexity; each search of 15 results with relations counts 58, or 77 with the one-show
 * fields (streaming links 6, details 13; measured 2026-11-18), so 7 fit, or 6 with them.
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

export type FetchFn = (input: string, init: RequestInit) => Promise<Response>;

const MEDIA_FIELDS = `
  id
  title { romaji english native }
  synonyms
  episodes
  duration
  format
  status
  seasonYear
  startDate { year month day }
  averageScore
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
export class UserCache {
  viewer: Promise<Viewer> | null = null;
  viewerAt = 0;
  /** The whole list keyed by media ID, shared by calls that start while it loads. */
  list: { fetchedAt: number; entries: Promise<Map<number, ListItem>> } | null = null;
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
  /** How waits for the rate limit pass; tests replace it. */
  sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
  /** How to get a new token: set by the hosted server, which signs users in itself (R7.2). */
  renew: string | null = null;
  /** Set once AniList has rejected the token (revoked, or expired early). */
  rejected = false;
  /** When AniList last accepted this client's own token. */
  private acceptedAt = Number.NEGATIVE_INFINITY;
  /** A check of the token in flight (see `confirm`). */
  private confirming: Promise<void> | null = null;

  constructor(
    private readonly token: string,
    private readonly fetchFn: FetchFn = (input, init) => fetch(input, init),
    private readonly cache: UserCache = new UserCache(),
  ) {
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
    for (let retries = 0; ; retries++) {
      const result = await this.attempt<T>(query, variables);
      if (!("retryAfterMs" in result)) return result.data;
      // A rate-limited request wasn't run, so even a write is safe to send again.
      const wait = result.retryAfterMs;
      if (retries >= RATE_LIMIT_RETRIES || wait === null || wait > RATE_LIMIT_WAIT_MS) {
        throw new AniListError(
          `AniList rate limit hit (30 requests a minute).${wait !== null ? ` Try again in ${Math.ceil(wait / 1000)} seconds.` : ""}`,
        );
      }
      await this.sleep(wait);
    }
  }

  /** One try at a request: its data, or how long AniList says to wait when rate-limited. */
  private async attempt<T>(
    query: string,
    variables: Record<string, unknown>,
  ): Promise<{ data: T } | { retryAfterMs: number | null }> {
    const signal = AbortSignal.timeout(this.requestTimeoutMs);
    const timedOut = () =>
      new AniListError(
        `AniList didn't respond within ${this.requestTimeoutMs / 1000} seconds` +
          // A write may have been saved even though the answer never came.
          (/^\s*mutation/.test(query)
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
      throw new AniListError(`Could not reach AniList: ${(err as Error).message}`);
    }

    if (res.status === 429) {
      const header = res.headers.get("Retry-After");
      const seconds = header === null ? Number.NaN : Number(header);
      // Without a usable Retry-After there's no telling how long to wait, so it isn't retried.
      return { retryAfterMs: Number.isFinite(seconds) && seconds >= 0 ? seconds * 1000 : null };
    }

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
      throw new AniListError(`AniList returned HTTP ${res.status} with a non-JSON body.`);
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
      throw new AniListError(`AniList error: ${messages}`, body.errors[0]!.status ?? res.status);
    }
    if (!res.ok || !body.data) {
      throw new AniListError(`AniList returned HTTP ${res.status}.`);
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
  async searchAnime(search: string, perPage: number, options: MediaOptions = {}, isAdult?: boolean): Promise<Media[]> {
    return (await this.searchMany([search], perPage, options, isAdult))[0]!;
  }

  /**
   * Several title searches in one request, as aliased Page queries (searchBatch per request),
   * so resolving a batch of names costs one request instead of one each against AniList's
   * rate limit. Results are in the order of `searches`, each as searchAnime would return it.
   */
  async searchMany(searches: string[], perPage: number, options: MediaOptions = {}, isAdult?: boolean): Promise<Media[][]> {
    const results: Media[][] = [];
    const size = searchBatch(options);
    for (let i = 0; i < searches.length; i += size) {
      const chunk = searches.slice(i, i + size);
      const pages = chunk
        .map(
          (_, j) => `s${j}: Page(perPage: $perPage) {
            media(search: $search${j}, type: ANIME, sort: SEARCH_MATCH, isAdult: $isAdult) {
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
        `query (${params}, $perPage: Int, $isAdult: Boolean) {\n${pages}\n}`,
        { ...Object.fromEntries(chunk.map((search, j) => [`search${j}`, search])), perPage, isAdult },
      );
      results.push(...chunk.map((_, j) => data[`s${j}`]!.media));
    }
    return results;
  }

  /**
   * Searches and filters AniList in one request. Each result carries its prequels and the
   * user's status on them, so "continues a show you completed" costs no extra request.
   */
  async browseAnime(filters: BrowseFilters, perPage: number): Promise<Media[]> {
    const data = await this.request<{ Page: { media: Media[] } }>(
      `query (
        $search: String, $season: MediaSeason, $seasonYear: Int, $genres: [String],
        $formats: [MediaFormat], $status: MediaStatus, $sort: [MediaSort], $perPage: Int, $isAdult: Boolean
      ) {
        Page(perPage: $perPage) {
          media(
            search: $search, type: ANIME, season: $season, seasonYear: $seasonYear,
            genre_in: $genres, format_in: $formats, status: $status, sort: $sort, isAdult: $isAdult
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
      { ...filters, sort: [filters.sort], perPage },
    );
    return data.Page.media;
  }

  async getAnime(mediaId: number): Promise<Media> {
    const data = await this.request<{ Media: Media | null }>(
      `query ($id: Int) {
        Media(id: $id, type: ANIME) {
          ${MEDIA_FIELDS}
          mediaListEntry { ${ENTRY_FIELDS} }
        }
      }`,
      { id: mediaId },
    ).catch((err) => {
      // AniList answers an unknown ID, or a manga ID, with HTTP 404 "Not Found.".
      if (err instanceof AniListError && err.status === 404) return { Media: null };
      throw err;
    });
    if (!data.Media) {
      throw new AniListError(`No anime found with id ${mediaId}. Check the number, or pass the show's name.`);
    }
    return data.Media;
  }

  /** Fetches several anime at once, with their relations (sequels, prequels, ...). */
  async getMany(ids: number[], options: MediaOptions = {}): Promise<Media[]> {
    if (ids.length === 0) return [];
    const data = await this.request<{ Page: { media: Media[] } }>(
      `query ($ids: [Int]) {
        Page(perPage: 50) {
          media(id_in: $ids, type: ANIME) {
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
          media(id_in: $ids, type: ANIME) {
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

  /** The user's list, from a cache that lives for LIST_TTL_MS and is patched by our own writes. */
  async getMyList(status?: ListStatus): Promise<ListItem[]> {
    await this.confirm();
    let list = this.cache.list;
    if (!list || this.now() - list.fetchedAt >= LIST_TTL_MS) {
      const fresh = { fetchedAt: this.now(), entries: this.fetchMyList() };
      this.cache.list = list = fresh;
      fresh.entries.catch(() => {
        if (this.cache.list === fresh) this.cache.list = null;
      });
    }
    const entries = [...(await list.entries).values()];
    return status ? entries.filter((e) => e.status === status) : entries;
  }

  private async fetchMyList(): Promise<Map<number, ListItem>> {
    const viewer = await this.getViewer();
    const data = await this.request<{
      MediaListCollection: { lists: { entries: ListItem[] }[] };
    }>(
      `query ($userId: Int) {
        MediaListCollection(userId: $userId, type: ANIME) {
          lists {
            entries {
              ${ENTRY_FIELDS}
              media { ${MEDIA_FIELDS} }
            }
          }
        }
      }`,
      { userId: viewer.id },
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
   * write's answer, so all of these drop the cache instead.
   */
  private async patchList<T>(
    mediaId: number | null,
    write: Promise<T>,
    patch: (entries: Map<number, ListItem>, result: T) => void,
  ): Promise<T> {
    const self = { mediaId, overlapped: false };
    const startList = this.cache.list;
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
      this.cache.list = null;
      throw err;
    } finally {
      this.cache.writes.delete(self);
    }
    // A list fetched while the write was in flight may already hold something newer.
    if (self.overlapped || this.cache.list !== startList) this.cache.list = null;
    else if (this.cache.list) {
      const list = this.cache.list;
      list.entries = list.entries.then((entries) => {
        patch(entries, result);
        return entries;
      });
      list.entries.catch(() => {
        if (this.cache.list === list) this.cache.list = null;
      });
    }
    return result;
  }

  /**
   * The user's own anime list activity, newest first: up to `pages` pages (default 1) of 50,
   * one request each, stopping at the last. `from` and `to` are Unix seconds (from
   * inclusive, to exclusive).
   */
  async getMyActivity(options: {
    from?: number;
    to?: number;
    mediaId?: number;
    pages?: number;
  }): Promise<{ activities: ListActivity[]; hasNextPage: boolean }> {
    const viewer = await this.getViewer();
    const activities = new Map<number, ListActivity>();
    let hasNextPage = true;
    for (let page = 1; hasNextPage && page <= (options.pages ?? 1); page++) {
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
        $mediaId: Int, $status: MediaListStatus, $progress: Int, $scoreRaw: Int,
        $startedAt: FuzzyDateInput, $completedAt: FuzzyDateInput, $repeat: Int, $notes: String,
        $private: Boolean, $hiddenFromStatusLists: Boolean, $customLists: [String]
      ) {
        SaveMediaListEntry(
          mediaId: $mediaId, status: $status, progress: $progress, scoreRaw: $scoreRaw,
          startedAt: $startedAt, completedAt: $completedAt, repeat: $repeat, notes: $notes,
          private: $private, hiddenFromStatusLists: $hiddenFromStatusLists, customLists: $customLists
        ) {
          ${ENTRY_FIELDS}
          media { ${MEDIA_FIELDS} }
        }
      }`,
      input,
    ).then((data) => data.SaveMediaListEntry);
    return this.patchList(input.mediaId, save, (entries, saved) => entries.set(saved.media.id, saved));
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
