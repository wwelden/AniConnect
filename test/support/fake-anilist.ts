/**
 * An in-memory stand-in for the parts of AniList's GraphQL API that AniConnect uses,
 * backed by a snapshot of real AniList metadata (test/fixtures/media.json).
 * Used by the unit tests and by the eval harness.
 */
import type { ListStatus, ScoreFormat } from "../../src/anilist";
import { normalize } from "../../src/logic";
import catalogJson from "../fixtures/media.json";

export type CatalogMedia = (typeof catalogJson)[number];
export const catalog: CatalogMedia[] = catalogJson;

const EMPTY_DATE = { year: null, month: null, day: null };

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

export class FakeAniList {
  entries = new Map<number, StoredEntry>();
  nextEntryId = 1000;
  calls: { query: string; variables: Record<string, any> }[] = [];
  rateLimited = false;

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

  /** Writes made so far, i.e. calls that change the list. */
  get writes() {
    return this.calls.filter((c) => /^\s*mutation/.test(c.query));
  }

  exportState() {
    return { entries: [...this.entries.values()], nextEntryId: this.nextEntryId };
  }

  importState(state: { entries: StoredEntry[]; nextEntryId: number }) {
    this.entries = new Map(state.entries.map((e) => [e.mediaId, e]));
    this.nextEntryId = state.nextEntryId;
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

  private mediaView(id: number, withRelations = false) {
    const m = catalog.find((c) => c.id === id);
    if (!m) return null;
    const { relations, franchise, popularity, nextAiringEpisode, ...rest } = m;
    const entry = this.entries.get(id);
    return {
      ...rest,
      mediaListEntry: entry ? this.entryView(entry) : null,
      ...(withRelations ? { relations: this.relationsView(relations) } : {}),
    };
  }

  private relationsView(relations: CatalogMedia["relations"]) {
    return {
      edges: relations.edges.map((e) => ({
        relationType: e.relationType,
        node: { id: e.node.id, type: e.node.type, format: catalog.find((c) => c.id === e.node.id)?.format ?? null },
      })),
    };
  }

  /** Rough imitation of AniList search: every word somewhere in a title, most popular first. */
  search(text: string, perPage: number) {
    const words = normalize(text).split(" ").filter(Boolean);
    return catalog
      .filter((m) => {
        const hay = [m.title.romaji, m.title.english, m.title.native, ...m.synonyms]
          .filter(Boolean)
          .map((n) => normalize(n!))
          .join(" | ");
        return words.every((w) => hay.includes(w));
      })
      .sort((a, b) => (b.popularity ?? 0) - (a.popularity ?? 0))
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
      return json({ Viewer: { id: 1, name: this.viewerName, mediaListOptions: { scoreFormat: this.scoreFormat } } });
    }
    if (query.includes("id_in")) {
      const ids: number[] = variables.ids ?? [];
      return json({ Page: { media: ids.map((id) => this.mediaView(id, true)).filter(Boolean) } });
    }
    if (query.includes("Page(")) {
      const media = this.search(variables.search ?? "", variables.perPage ?? 10).map((m) => this.mediaView(m.id));
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
      const updated: StoredEntry = {
        ...existing,
        ...(status !== undefined && { status }),
        ...(progress !== undefined && { progress }),
        ...(scoreRaw !== undefined && { scoreRaw }),
        ...(startedAt !== undefined && { startedAt }),
        ...(completedAt !== undefined && { completedAt }),
      };
      this.entries.set(mediaId, updated);
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
