/**
 * An in-memory stand-in for the parts of AniList's GraphQL API that AniConnect uses,
 * backed by a snapshot of real AniList metadata (test/fixtures/media.json).
 * Used by the unit tests and by the eval harness.
 */
import type { ListStatus, ScoreFormat, TitleLanguage } from "../../src/anilist";
import { normalize } from "../../src/logic";
import catalogJson from "../fixtures/media.json";

export type CatalogMedia = (typeof catalogJson)[number];
export const catalog: CatalogMedia[] = catalogJson;

const EMPTY_DATE = { year: null, month: null, day: null };

/** AniList fills in relations only two levels deep; deeper `relations` come back empty. */
const RELATION_LEVELS = 2;

/** How many levels of `relations` a query nests. */
function relationDepth(query: string): number {
  return query.match(/\brelations\s*\{/g)?.length ?? 0;
}

export interface StoredEntry {
  id: number;
  mediaId: number;
  status: ListStatus;
  progress: number;
  /** Raw 0-100 score. */
  scoreRaw: number;
  startedAt: { year: number | null; month: number | null; day: number | null };
  completedAt: { year: number | null; month: number | null; day: number | null };
}

export interface SeedEntry {
  /** Exact romaji title from the fixture, or an AniList ID. */
  anime: string | number;
  status: ListStatus;
  progress?: number;
  score?: number;
}

/** A list activity as AniList stores it (see FakeAniList.recordActivity). */
export interface StoredActivity {
  id: number;
  mediaId: number;
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

export function findMedia(anime: string | number): CatalogMedia {
  const m =
    typeof anime === "number"
      ? catalog.find((c) => c.id === anime)
      : catalog.find((c) => c.title.romaji === anime) ??
        catalog.find((c) => c.title.english === anime);
  if (!m) throw new Error(`Fixture has no anime "${anime}"`);
  return m;
}

/** AniList shows raw scores in the user's format; this mirrors that for the formats we test. */
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

/** Descending sort keys for the AniList sorts we use. SEARCH_MATCH is imitated by popularity. */
const SORT_KEYS: Record<string, (m: CatalogMedia) => number> = {
  SEARCH_MATCH: (m) => m.popularity ?? 0,
  POPULARITY_DESC: (m) => m.popularity ?? 0,
  SCORE_DESC: (m) => m.averageScore ?? 0,
  START_DATE_DESC: (m) =>
    m.startDate?.year ? m.startDate.year * 10000 + (m.startDate.month ?? 0) * 100 + (m.startDate.day ?? 0) : Infinity,
};

export class FakeAniList {
  entries = new Map<number, StoredEntry>();
  nextEntryId = 1000;
  calls: { query: string; variables: Record<string, any> }[] = [];
  rateLimited = false;
  /** The viewer's AniList title language setting. */
  titleLanguage: TitleLanguage = "ENGLISH";
  /** The viewer's AniList time zone setting, as AniList returns it (e.g. "-05:00"). */
  timeZone: string | null = null;
  /** The user's list activity, oldest first. */
  activities: StoredActivity[] = [];
  nextActivityId = 1;
  /** Clock for new activity, in ms. */
  clock: () => number = () => Date.now();
  /** The account's 18+ content setting (AniList's default is off). */
  displayAdultContent = false;

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
        progress: s.progress ?? (s.status === "COMPLETED" ? (m.episodes ?? 0) : 0),
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

  /**
   * Logs a save the way AniList's feed does: one activity per status change, and episode
   * updates as "watched episode" with the episode or a range ("3 - 5"). An update right
   * after another for the same show extends that activity's range instead of adding one.
   */
  private recordActivity(before: StoredEntry | undefined, after: StoredEntry) {
    const was = before?.progress ?? 0;
    const statusChanged = before?.status !== after.status;
    const rewatch = after.status === "REPEATING";
    let status: string;
    let progress: string | null = null;
    if (after.progress > was && (after.status === "CURRENT" || rewatch)) {
      status = rewatch ? "rewatched episode" : "watched episode";
      progress = after.progress === was + 1 ? String(after.progress) : `${was + 1} - ${after.progress}`;
    } else if (statusChanged) {
      status = {
        CURRENT: "watching",
        PLANNING: "plans to watch",
        COMPLETED: before?.status === "REPEATING" ? "rewatched" : "completed",
        DROPPED: "dropped",
        PAUSED: "paused watching",
        REPEATING: "rewatching",
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
    this.activities.push({ id: this.nextActivityId++, mediaId: after.mediaId, status, progress, createdAt: now });
  }

  /** Writes made so far, i.e. calls that change the list. */
  get writes() {
    return this.calls.filter((c) => /^\s*mutation/.test(c.query));
  }

  exportState() {
    return {
      entries: [...this.entries.values()],
      nextEntryId: this.nextEntryId,
      activities: this.activities,
      nextActivityId: this.nextActivityId,
    };
  }

  importState(state: {
    entries: StoredEntry[];
    nextEntryId: number;
    activities?: StoredActivity[];
    nextActivityId?: number;
  }) {
    this.entries = new Map(state.entries.map((e) => [e.mediaId, e]));
    this.nextEntryId = state.nextEntryId;
    this.activities = state.activities ?? [];
    this.nextActivityId = state.nextActivityId ?? 1;
  }

  private entryView(e: StoredEntry) {
    return {
      id: e.id,
      status: e.status,
      progress: e.progress,
      score: e.scoreRaw / 10,
      displayScore: displayScore(e.scoreRaw, this.scoreFormat),
      startedAt: e.startedAt,
      completedAt: e.completedAt,
    };
  }

  /** `depth` levels of relations, the way a query nesting `relations` that many times gets them. */
  private mediaView(id: number, depth = 0, level = 1, links = false): Record<string, unknown> | null {
    const m = catalog.find((c) => c.id === id);
    if (!m) return null;
    const { relations, franchise, popularity, externalLinks, ...rest } = m;
    const entry = this.entries.get(id);
    return {
      ...rest,
      mediaListEntry: entry ? this.entryView(entry) : null,
      ...(depth > 0 ? { relations: this.relationsView(relations, depth, level, links) } : {}),
      ...(links ? { externalLinks } : {}),
    };
  }

  /**
   * The innermost level has the short node AniConnect selects there; outer levels have
   * full media (the snapshot can't fill in anime it doesn't hold, so those stay short).
   */
  private relationsView(relations: CatalogMedia["relations"], depth: number, level: number, links: boolean) {
    if (level > RELATION_LEVELS) return { edges: [] };
    return {
      edges: relations.edges.map((e) => ({
        relationType: e.relationType,
        node: (() => {
          const target = catalog.find((c) => c.id === e.node.id);
          if (depth > 1 && target) return { type: e.node.type, ...this.mediaView(target.id, depth - 1, level + 1, links) };
          return {
            id: e.node.id,
            type: e.node.type,
            format: target?.format ?? null,
            status: target?.status ?? null,
            episodes: target?.episodes ?? null,
            title: target?.title ?? { romaji: null, english: null, native: null },
            startDate: target?.startDate ?? null,
            mediaListEntry: this.entries.has(e.node.id) ? { status: this.entries.get(e.node.id)!.status } : null,
          };
        })(),
      })),
    };
  }

  /**
   * Rough imitation of AniList search and filters: every word somewhere in a title, then
   * season, year, genres (all of, like AniList's genre_in), formats (any of) and airing status.
   */
  search(text: string, perPage: number, filters: SearchVariables = {}) {
    const words = normalize(text).split(" ").filter(Boolean);
    const sortKey = SORT_KEYS[filters.sort?.[0] ?? "SEARCH_MATCH"];
    if (!sortKey) throw new Error(`FakeAniList: unsupported sort ${filters.sort}`);
    return catalog
      .filter((m) => {
        const hay = [m.title.romaji, m.title.english, m.title.native, ...m.synonyms]
          .filter(Boolean)
          .map((n) => normalize(n!))
          .join(" | ");
        return words.every((w) => hay.includes(w));
      })
      .filter(
        (m) =>
          (filters.season == null || m.season === filters.season) &&
          (filters.seasonYear == null || m.seasonYear === filters.seasonYear) &&
          (filters.genres == null || filters.genres.every((g) => m.genres.includes(g))) &&
          (filters.formats == null || (m.format !== null && filters.formats.includes(m.format))) &&
          (filters.status == null || m.status === filters.status) &&
          (filters.isAdult == null || m.isAdult === filters.isAdult),
      )
      .sort((a, b) => sortKey(b) - sortKey(a))
      .slice(0, perPage);
  }

  fetch = async (_url: string, init: RequestInit): Promise<Response> => {
    const { query, variables = {} } = JSON.parse(init.body as string) as {
      query: string;
      variables?: Record<string, any>;
    };
    this.calls.push({ query, variables });
    if (this.rateLimited) {
      return new Response(JSON.stringify({ errors: [{ message: "Too Many Requests." }] }), {
        status: 429,
        headers: { "Retry-After": "30" },
      });
    }
    const json = (data: unknown) => new Response(JSON.stringify({ data }));

    if (query.includes("Viewer")) {
      return json({
        Viewer: {
          id: 1,
          name: this.viewerName,
          mediaListOptions: { scoreFormat: this.scoreFormat },
          options: { titleLanguage: this.titleLanguage, timezone: this.timeZone, displayAdultContent: this.displayAdultContent },
        },
      });
    }
    if (query.includes("activities(")) {
      const { userId, mediaId, from, to } = variables;
      const matching = this.activities
        .filter(
          (a) =>
            userId === 1 &&
            (mediaId === undefined || a.mediaId === mediaId) &&
            (from === undefined || a.createdAt > from) &&
            (to === undefined || a.createdAt < to),
        )
        .sort((a, b) => b.id - a.id);
      const activities = matching.slice(0, 50).map((a) => {
        const m = catalog.find((c) => c.id === a.mediaId)!;
        return { id: a.id, status: a.status, progress: a.progress, createdAt: a.createdAt, media: { id: m.id, title: m.title } };
      });
      return json({ Page: { pageInfo: { hasNextPage: matching.length > 50 }, activities } });
    }
    if (query.includes("id_in")) {
      const ids: number[] = variables.ids ?? [];
      const links = query.includes("externalLinks");
      return json({ Page: { media: ids.map((id) => this.mediaView(id, relationDepth(query), 1, links)).filter(Boolean) } });
    }
    if (query.includes("Page(")) {
      const media = this.search(variables.search ?? "", variables.perPage ?? 10, variables).map((m) =>
        this.mediaView(m.id, relationDepth(query), 1, query.includes("externalLinks")),
      );
      return json({ Page: { media } });
    }
    if (query.includes("Media(id")) {
      return json({ Media: this.mediaView(variables.id) });
    }
    if (query.includes("MediaListCollection")) {
      const entries = [...this.entries.values()]
        .filter((e) => !variables.status || e.status === variables.status)
        .map((e) => ({ ...this.entryView(e), media: this.mediaView(e.mediaId) }));
      // AniList can return the same entry in two lists (a status list and a custom list).
      return json({ MediaListCollection: { lists: [{ entries }, { entries: entries.slice(0, 1) }] } });
    }
    if (query.includes("SaveMediaListEntry")) {
      const { mediaId, scoreRaw, status, progress, startedAt, completedAt } = variables;
      if (!catalog.some((c) => c.id === mediaId)) {
        return new Response(
          JSON.stringify({ errors: [{ message: "validation", validation: { mediaId: ["The selected media id is invalid."] } }] }),
          { status: 400 },
        );
      }
      const existing: StoredEntry = this.entries.get(mediaId) ?? {
        id: this.nextEntryId++,
        mediaId,
        status: "PLANNING",
        progress: 0,
        scoreRaw: 0,
        startedAt: EMPTY_DATE,
        completedAt: EMPTY_DATE,
      };
      const before = this.entries.get(mediaId);
      const updated: StoredEntry = {
        ...existing,
        ...(status !== undefined && { status }),
        ...(progress !== undefined && { progress }),
        ...(scoreRaw !== undefined && { scoreRaw }),
        ...(startedAt !== undefined && { startedAt }),
        ...(completedAt !== undefined && { completedAt }),
      };
      this.entries.set(mediaId, updated);
      this.recordActivity(before, updated);
      return json({ SaveMediaListEntry: { ...this.entryView(updated), media: this.mediaView(mediaId) } });
    }
    if (query.includes("DeleteMediaListEntry")) {
      for (const [mediaId, entry] of this.entries) {
        if (entry.id === variables.id) {
          this.entries.delete(mediaId);
          return json({ DeleteMediaListEntry: { deleted: true } });
        }
      }
      return new Response(
        JSON.stringify({ errors: [{ message: "validation", validation: { id: ["The selected id is invalid."] } }] }),
        { status: 400 },
      );
    }
    throw new Error(`FakeAniList: unhandled query: ${query}`);
  };
}
