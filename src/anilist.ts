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
  /** Present when fetched with `{ links: true }`. */
  externalLinks?: ExternalLink[] | null;
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

/** Asks a media query for streaming links too: only for answers about one show. */
export interface LinkOptions {
  links?: boolean;
}

function linkFields(options: LinkOptions): string {
  return options.links ? "externalLinks { site url type notes isDisabled }" : "";
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

export class AniListError extends Error {}

export type ListItem = ListEntry & { media: Media };

/**
 * How long the user's list is reused before it is fetched again (requirement R5.4).
 * Our own writes patch it, so this only bounds how long changes made elsewhere
 * (anilist.co, a scrobbler) take to show up, and how stale the progress a write
 * counts up from can be.
 */
export const LIST_TTL_MS = 60_000;

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

type FetchFn = (input: string, init: RequestInit) => Promise<Response>;

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
`;

/** How long account settings (such as the 18+ content setting) are trusted before being read again. */
const VIEWER_TTL_MS = 5 * 60_000;

export class AniListClient {
  private viewer: Promise<Viewer> | null = null;
  private viewerAt = 0;
  /** When the token expires (ms), read from the JWT; null if it can't be decoded. */
  readonly tokenExpiresAt: number | null;
  /** The whole list keyed by media ID, shared by calls that start while it loads. */
  private list: { fetchedAt: number; entries: Promise<Map<number, ListItem>> } | null = null;
  /** Writes in flight, by media ID (null: any); each is flagged if another write to it overlapped. */
  private writes = new Set<{ mediaId: number | null; overlapped: boolean }>();
  /** Clock for the list cache; createServer sets it so tests control expiry. */
  now: () => number = Date.now;

  constructor(
    private readonly token: string,
    private readonly fetchFn: FetchFn = (input, init) => fetch(input, init),
  ) {
    this.tokenExpiresAt = tokenExpiry(token);
  }

  async request<T>(query: string, variables: Record<string, unknown> = {}): Promise<T> {
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
      });
    } catch (err) {
      throw new AniListError(`Could not reach AniList: ${(err as Error).message}`);
    }

    if (res.status === 429) {
      const retry = res.headers.get("Retry-After");
      throw new AniListError(
        `AniList rate limit hit (30 requests a minute).${retry ? ` Try again in ${retry} seconds.` : ""}`,
      );
    }

    let body: {
      data?: T;
      errors?: { message: string; status?: number; validation?: Record<string, string[]> }[];
    };
    try {
      body = (await res.json()) as typeof body;
    } catch {
      throw new AniListError(`AniList returned HTTP ${res.status} with a non-JSON body.`);
    }

    if (body.errors?.length) {
      // Validation errors carry their real reason in `validation`, e.g. {"id": ["The selected id is invalid."]}.
      const messages = body.errors
        .map((e) =>
          e.validation
            ? Object.entries(e.validation)
                .map(([field, reasons]) => `${field}: ${reasons.join(" ")}`)
                .join("; ")
            : e.message,
        )
        .join("; ");
      if (res.status === 401 || /invalid token/i.test(messages)) {
        throw new AniListError(
          `AniList rejected the token (${messages}). Check ANILIST_TOKEN; tokens expire after a year.`,
        );
      }
      throw new AniListError(`AniList error: ${messages}`);
    }
    if (!res.ok || !body.data) {
      throw new AniListError(`AniList returned HTTP ${res.status}.`);
    }
    return body.data;
  }

  /**
   * Re-read every few minutes (settings can change), and cached as a promise so calls
   * that start together share one request.
   */
  getViewer(): Promise<Viewer> {
    if (this.viewer && this.now() - this.viewerAt < VIEWER_TTL_MS) return this.viewer;
    this.viewerAt = this.now();
    const pending: Promise<Viewer> = this.request<{
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
      }),
      (err) => {
        if (this.viewer === pending) this.viewer = null; // Let the next call try again.
        throw err;
      },
    );
    this.viewer = pending;
    return this.viewer;
  }

  /** Drops the cached viewer, so the next call re-reads settings the user may have just changed. */
  forgetViewer(): void {
    this.viewer = null;
  }

  /**
   * `isAdult: false` leaves out adult (18+) titles and `true` returns only them;
   * leaving it out returns both, as AniList does when the argument is omitted.
   */
  async searchAnime(search: string, perPage: number, options: LinkOptions = {}, isAdult?: boolean): Promise<Media[]> {
    const data = await this.request<{ Page: { media: Media[] } }>(
      `query ($search: String, $perPage: Int, $isAdult: Boolean) {
        Page(perPage: $perPage) {
          media(search: $search, type: ANIME, sort: SEARCH_MATCH, isAdult: $isAdult) {
            ${MEDIA_FIELDS}
            ${linkFields(options)}
            mediaListEntry { ${ENTRY_FIELDS} }
            relations { edges { ${RELATION_EDGE} } }
          }
        }
      }`,
      { search, perPage, isAdult },
    );
    return data.Page.media;
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
    );
    if (!data.Media) throw new AniListError(`No anime found with id ${mediaId}.`);
    return data.Media;
  }

  /** Fetches several anime at once, with their relations (sequels, prequels, ...). */
  async getMany(ids: number[], options: LinkOptions = {}): Promise<Media[]> {
    if (ids.length === 0) return [];
    const data = await this.request<{ Page: { media: Media[] } }>(
      `query ($ids: [Int]) {
        Page(perPage: 50) {
          media(id_in: $ids, type: ANIME) {
            ${MEDIA_FIELDS}
            ${linkFields(options)}
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
  async getRelated(ids: number[], options: LinkOptions = {}): Promise<Media[]> {
    if (ids.length === 0) return [];
    const data = await this.request<{ Page: { media: Media[] } }>(
      `query ($ids: [Int]) {
        Page(perPage: 50) {
          media(id_in: $ids, type: ANIME) {
            ${MEDIA_FIELDS}
            ${linkFields(options)}
            mediaListEntry { ${ENTRY_FIELDS} }
            relations {
              edges {
                relationType
                node {
                  type
                  ${MEDIA_FIELDS}
                  ${linkFields(options)}
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
    let list = this.list;
    if (!list || this.now() - list.fetchedAt >= LIST_TTL_MS) {
      const fresh = { fetchedAt: this.now(), entries: this.fetchMyList() };
      this.list = list = fresh;
      fresh.entries.catch(() => {
        if (this.list === fresh) this.list = null;
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
    const startList = this.list;
    for (const other of this.writes) {
      if (other.mediaId === null || mediaId === null || other.mediaId === mediaId) {
        other.overlapped = self.overlapped = true;
      }
    }
    this.writes.add(self);
    let result: T;
    try {
      result = await write;
    } catch (err) {
      this.list = null;
      throw err;
    } finally {
      this.writes.delete(self);
    }
    // A list fetched while the write was in flight may already hold something newer.
    if (self.overlapped || this.list !== startList) this.list = null;
    else if (this.list) {
      const list = this.list;
      list.entries = list.entries.then((entries) => {
        patch(entries, result);
        return entries;
      });
      list.entries.catch(() => {
        if (this.list === list) this.list = null;
      });
    }
    return result;
  }

  /**
   * The user's own anime list activity, newest first: one page of at most 50.
   * `from` and `to` are Unix seconds (from inclusive, to exclusive).
   */
  async getMyActivity(options: {
    from?: number;
    to?: number;
    mediaId?: number;
  }): Promise<{ activities: ListActivity[]; hasNextPage: boolean }> {
    const viewer = await this.getViewer();
    const data = await this.request<{
      Page: { pageInfo: { hasNextPage: boolean }; activities: (ListActivity | Record<string, never>)[] };
    }>(
      `query ($userId: Int, $mediaId: Int, $from: Int, $to: Int) {
        Page(perPage: 50) {
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
      },
    );
    return {
      activities: data.Page.activities.filter((a): a is ListActivity => "id" in a),
      hasNextPage: data.Page.pageInfo.hasNextPage,
    };
  }

  async saveEntry(input: {
    mediaId: number;
    status?: ListStatus;
    progress?: number;
    scoreRaw?: number;
    startedAt?: FuzzyDate;
    completedAt?: FuzzyDate;
    repeat?: number;
  }): Promise<ListItem> {
    const save = this.request<{ SaveMediaListEntry: ListItem }>(
      `mutation (
        $mediaId: Int, $status: MediaListStatus, $progress: Int, $scoreRaw: Int,
        $startedAt: FuzzyDateInput, $completedAt: FuzzyDateInput, $repeat: Int
      ) {
        SaveMediaListEntry(
          mediaId: $mediaId, status: $status, progress: $progress, scoreRaw: $scoreRaw,
          startedAt: $startedAt, completedAt: $completedAt, repeat: $repeat
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
