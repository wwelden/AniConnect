import type { AniListClient, FuzzyDate, ListEntry, ListStatus, MediaTitle, MediaType, Viewer } from "./anilist";
import { describeEntry, displayTitle } from "./logic";

/** Everything AniConnect can change on an entry, so undoing a change restores it exactly (R3.1). */
export interface Snapshot {
  status: ListStatus;
  progress: number;
  /** A manga's volumes read; 0 for an anime. */
  progressVolumes: number;
  /** Out of 10, one decimal (AniList's raw score / 10). */
  score: number;
  startedAt: FuzzyDate;
  completedAt: FuzzyDate;
  repeat: number;
  notes: string | null;
  /** Kept so an entry that was removed comes back with its settings, though no tool changes these. */
  private: boolean;
  hiddenFromStatusLists: boolean;
  customLists: string[];
}

/** One show's change: its entry before and after. null means it wasn't on the list. */
export interface EntryChange {
  mediaId: number;
  title: MediaTitle;
  before: Snapshot | null;
  after: Snapshot | null;
}

/** A show added to or taken out of the user's AniList favorites, which are kept apart from the list. */
export interface FavoriteChange {
  mediaId: number;
  /** Which favorites it's among: AniList toggles anime and manga favorites apart. */
  type: MediaType;
  title: MediaTitle;
  favorite: { before: boolean; after: boolean };
}

export type Change = EntryChange | FavoriteChange;

function isFavoriteChange(c: Change): c is FavoriteChange {
  return "favorite" in c;
}

/** The changes one tool call made, undone together. */
export interface ChangeGroup {
  tool: string;
  changes: Change[];
}

export function snapshot(entry: Partial<ListEntry> | null | undefined): Snapshot | null {
  if (!entry?.status) return null;
  return {
    status: entry.status,
    progress: entry.progress ?? 0,
    progressVolumes: entry.progressVolumes ?? 0,
    score: entry.score ?? 0,
    startedAt: date(entry.startedAt),
    completedAt: date(entry.completedAt),
    repeat: entry.repeat ?? 0,
    notes: entry.notes || null,
    private: entry.private ?? false,
    hiddenFromStatusLists: entry.hiddenFromStatusLists ?? false,
    customLists: (entry.customLists ?? [])
      .filter((l) => l.enabled)
      .map((l) => l.name)
      .sort(),
  };
}

function date(d: FuzzyDate | null | undefined): FuzzyDate {
  return { year: d?.year ?? null, month: d?.month ?? null, day: d?.day ?? null };
}

function same(a: Snapshot | null, b: Snapshot | null): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/** How many tool calls' worth of changes are kept. */
export const JOURNAL_LIMIT = 50;

/** Changes made through this server, newest last, so they can be undone. Lives as long as the process. */
export class Journal {
  private groups: ChangeGroup[] = [];

  record(tool: string, changes: Change[]): void {
    const real = changes.filter((c) => (isFavoriteChange(c) ? c.favorite.before !== c.favorite.after : !same(c.before, c.after)));
    if (real.length === 0) return;
    this.groups.push({ tool, changes: real });
    if (this.groups.length > JOURNAL_LIMIT) this.groups.shift();
  }

  /** Takes the newest `count` groups off the journal, newest first. */
  take(count: number): ChangeGroup[] {
    return this.groups.splice(Math.max(0, this.groups.length - count)).reverse();
  }

  /** Returns groups (newest first, as `take` gave them) that weren't undone after all. */
  putBack(groups: ChangeGroup[]): void {
    this.groups.push(...[...groups].reverse());
  }

  get size(): number {
    return this.groups.length;
  }
}

/** Runs a write on its show's turn, after the other writes to that show (see `inTurn` in server.ts). */
export type OnTurn = <T>(mediaId: number, fn: () => Promise<T>) => Promise<T>;

/**
 * Puts each show back the way it was before the changes, newest first. A show changed
 * since (on anilist.co, or by another app) is left alone, so undo never overwrites
 * something the user did elsewhere. If AniList fails partway, the changes not yet undone
 * go back on the journal and the error says what was.
 */
export async function undoGroups(
  client: AniListClient,
  journal: Journal,
  groups: ChangeGroup[],
  viewer: Viewer,
  onTurn: OnTurn = (_id, fn) => fn(),
): Promise<string> {
  const lines: string[] = [];
  let pending = groups.map((g) => ({ ...g, changes: [...g.changes] }));
  try {
    const ids = [...new Set(groups.flatMap((g) => g.changes).filter((c) => !isFavoriteChange(c)).map((c) => c.mediaId))];
    // The current state of every show involved: one request per 50, AniList's page size.
    const current = new Map<number, ListEntry | null>();
    for (let i = 0; i < ids.length; i += 50) {
      for (const m of await client.getMany(ids.slice(i, i + 50))) current.set(m.id, m.mediaListEntry);
    }
    while (pending.length) {
      const group = pending[0]!;
      // Newest first within a group too: one update_shows call can change a show twice.
      const change = group.changes.at(-1);
      if (!change) {
        pending = pending.slice(1);
        continue;
      }
      lines.push(
        isFavoriteChange(change)
          ? await undoFavorite(client, change, viewer, onTurn)
          : await undoOne(client, change, current, viewer),
      );
      group.changes.pop();
    }
  } catch (err) {
    journal.putBack(pending.filter((g) => g.changes.length));
    const done = lines.length ? `Undone so far:\n${lines.join("\n")}\n` : "";
    throw new Error(`${done}${(err as Error).message} The rest can still be undone: call undo again.`);
  }
  return lines.join("\n");
}

/**
 * Toggles a favorite back, unless it has been changed since (on anilist.co, or by another app).
 * On the show's turn, reading the state then: AniList only toggles, so a set_favorite reading
 * it at the same time would toggle it a second time.
 */
function undoFavorite(client: AniListClient, change: FavoriteChange, viewer: Viewer, onTurn: OnTurn): Promise<string> {
  const title = displayTitle(change.title, viewer.titleLanguage);
  return onTurn(change.mediaId, async () => {
    const now = (await client.favoriteStates([change.mediaId])).get(change.mediaId)?.isFavorite;
    if (now !== change.favorite.after) {
      return `${title}: not undone, its favorite has changed since (on anilist.co or in another app).`;
    }
    await client.toggleFavorite(change.mediaId, change.type);
    return `${title}: ${change.favorite.before ? "back among" : "taken out of"} your favorites.`;
  });
}

async function undoOne(
  client: AniListClient,
  change: EntryChange,
  current: Map<number, ListEntry | null>,
  viewer: Viewer,
): Promise<string> {
  const title = displayTitle(change.title, viewer.titleLanguage);
  const now = current.get(change.mediaId) ?? null;
  if (!same(snapshot(now), change.after)) {
    return `${title}: not undone, it has changed since (on anilist.co or in another app).`;
  }
  const before = change.before;
  if (!before) {
    // Thrown, so the change stays on the journal and the next undo can try again.
    if (now && !(await client.deleteEntry(now.id))) throw new Error(`AniList did not remove ${title}.`);
    current.set(change.mediaId, null);
    return `${title}: removed from your list again.`;
  }
  const saved = await client.saveEntry({
    mediaId: change.mediaId,
    status: before.status,
    progress: before.progress,
    // Only where volumes were counted (a manga's), so an anime's save stays as it always was.
    ...(Boolean(before.progressVolumes || change.after?.progressVolumes) && { progressVolumes: before.progressVolumes }),
    scoreRaw: Math.round(before.score * 10),
    startedAt: before.startedAt,
    completedAt: before.completedAt,
    repeat: before.repeat,
    notes: before.notes ?? "",
    private: before.private,
    hiddenFromStatusLists: before.hiddenFromStatusLists,
    customLists: before.customLists,
  });
  current.set(change.mediaId, saved);
  return `${now ? "Restored" : "Put back on your list"}: ${describeEntry(saved.media, saved, viewer)}`;
}
