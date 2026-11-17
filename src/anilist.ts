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
}

export interface Media {
  id: number;
  title: MediaTitle;
  synonyms: string[];
  episodes: number | null;
  format: string | null;
  status: string | null;
  seasonYear: number | null;
  startDate: FuzzyDate | null;
  averageScore: number | null;
  siteUrl: string;
  mediaListEntry: ListEntry | null;
  /** Only present when fetched with getMany. */
  relations?: { edges: { relationType: string; node: { id: number; type: string; format: string | null } }[] };
}

export interface Viewer {
  id: number;
  name: string;
  scoreFormat: ScoreFormat;
}

export class AniListError extends Error {}

type FetchFn = (input: string, init: RequestInit) => Promise<Response>;

const MEDIA_FIELDS = `
  id
  title { romaji english native }
  synonyms
  episodes
  format
  status
  seasonYear
  startDate { year month day }
  averageScore
  siteUrl
`;

const ENTRY_FIELDS = `
  id
  status
  progress
  score(format: POINT_10_DECIMAL)
  displayScore: score
  startedAt { year month day }
  completedAt { year month day }
`;

export class AniListClient {
  private viewer: Viewer | null = null;

  constructor(
    private readonly token: string,
    private readonly fetchFn: FetchFn = (input, init) => fetch(input, init),
  ) {}

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
        `AniList rate limit hit (about 90 requests/minute).${retry ? ` Try again in ${retry} seconds.` : ""}`,
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

  async getViewer(): Promise<Viewer> {
    if (this.viewer) return this.viewer;
    const data = await this.request<{
      Viewer: { id: number; name: string; mediaListOptions: { scoreFormat: ScoreFormat } };
    }>(`query { Viewer { id name mediaListOptions { scoreFormat } } }`);
    this.viewer = {
      id: data.Viewer.id,
      name: data.Viewer.name,
      scoreFormat: data.Viewer.mediaListOptions.scoreFormat,
    };
    return this.viewer;
  }

  async searchAnime(search: string, perPage: number): Promise<Media[]> {
    const data = await this.request<{ Page: { media: Media[] } }>(
      `query ($search: String, $perPage: Int) {
        Page(perPage: $perPage) {
          media(search: $search, type: ANIME, sort: SEARCH_MATCH) {
            ${MEDIA_FIELDS}
            mediaListEntry { ${ENTRY_FIELDS} }
          }
        }
      }`,
      { search, perPage },
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
  async getMany(ids: number[]): Promise<Media[]> {
    if (ids.length === 0) return [];
    const data = await this.request<{ Page: { media: Media[] } }>(
      `query ($ids: [Int]) {
        Page(perPage: 50) {
          media(id_in: $ids, type: ANIME) {
            ${MEDIA_FIELDS}
            mediaListEntry { ${ENTRY_FIELDS} }
            relations { edges { relationType node { id type format } } }
          }
        }
      }`,
      { ids },
    );
    return data.Page.media;
  }

  async getMyList(status?: ListStatus): Promise<(ListEntry & { media: Media })[]> {
    const viewer = await this.getViewer();
    const data = await this.request<{
      MediaListCollection: { lists: { entries: (ListEntry & { media: Media })[] }[] };
    }>(
      `query ($userId: Int, $status: MediaListStatus) {
        MediaListCollection(userId: $userId, type: ANIME, status: $status) {
          lists {
            entries {
              ${ENTRY_FIELDS}
              media { ${MEDIA_FIELDS} }
            }
          }
        }
      }`,
      { userId: viewer.id, status },
    );
    // An entry can appear in more than one list (e.g. a status list and a custom list).
    const seen = new Set<number>();
    const entries: (ListEntry & { media: Media })[] = [];
    for (const list of data.MediaListCollection.lists) {
      for (const entry of list.entries) {
        if (seen.has(entry.id)) continue;
        seen.add(entry.id);
        entries.push(entry);
      }
    }
    return entries;
  }

  async saveEntry(input: {
    mediaId: number;
    status?: ListStatus;
    progress?: number;
    scoreRaw?: number;
    startedAt?: FuzzyDate;
    completedAt?: FuzzyDate;
  }): Promise<ListEntry & { media: Media }> {
    const data = await this.request<{ SaveMediaListEntry: ListEntry & { media: Media } }>(
      `mutation (
        $mediaId: Int, $status: MediaListStatus, $progress: Int, $scoreRaw: Int,
        $startedAt: FuzzyDateInput, $completedAt: FuzzyDateInput
      ) {
        SaveMediaListEntry(
          mediaId: $mediaId, status: $status, progress: $progress, scoreRaw: $scoreRaw,
          startedAt: $startedAt, completedAt: $completedAt
        ) {
          ${ENTRY_FIELDS}
          media { ${MEDIA_FIELDS} }
        }
      }`,
      input,
    );
    return data.SaveMediaListEntry;
  }

  async deleteEntry(entryId: number): Promise<boolean> {
    const data = await this.request<{ DeleteMediaListEntry: { deleted: boolean } }>(
      `mutation ($id: Int) { DeleteMediaListEntry(id: $id) { deleted } }`,
      { id: entryId },
    );
    return data.DeleteMediaListEntry.deleted;
  }
}
