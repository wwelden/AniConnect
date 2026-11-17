import type { AniListClient, FuzzyDate, ListEntry, ListStatus, Media, MediaTitle, Viewer } from "./anilist";
import { describeEntry, displayTitle } from "./logic";

/** Everything AniConnect can change on an entry, so undoing a change restores it exactly (R3.1). */
export interface Snapshot {
  status: ListStatus;
  progress: number;
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

/** The changes one tool call made, undone together. */
export interface ChangeGroup {
  tool: string;
  changes: EntryChange[];
}

export function snapshot(entry: Partial<ListEntry> | null | undefined): Snapshot | null {
  if (!entry?.status) return null;
  return {
    status: entry.status,
    progress: entry.progress ?? 0,
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

  record(tool: string, changes: EntryChange[]): void {
    const real = changes.filter((c) => !same(c.before, c.after));
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
): Promise<string> {
  const lines: string[] = [];
  let pending = groups.map((g) => ({ ...g, changes: [...g.changes] }));
  try {
    const ids = [...new Set(groups.flatMap((g) => g.changes.map((c) => c.mediaId)))];
    // One request for the current state of every show involved.
    const current = new Map<number, ListEntry | null>(
      (await client.getMany(ids)).map((m: Media) => [m.id, m.mediaListEntry]),
    );
    while (pending.length) {
      const group = pending[0]!;
      const change = group.changes[0];
      if (!change) {
        pending = pending.slice(1);
        continue;
      }
      lines.push(await undoOne(client, change, current, viewer));
      group.changes.shift();
    }
  } catch (err) {
    journal.putBack(pending.filter((g) => g.changes.length));
    const done = lines.length ? `Undone so far:\n${lines.join("\n")}\n` : "";
    throw new Error(`${done}${(err as Error).message} The rest can still be undone: call undo again.`);
  }
  return lines.join("\n");
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
    const deleted = now ? await client.deleteEntry(now.id) : true;
    if (deleted) current.set(change.mediaId, null);
    return deleted ? `${title}: removed from your list again.` : `${title}: AniList did not remove it.`;
  }
  const saved = await client.saveEntry({
    mediaId: change.mediaId,
    status: before.status,
    progress: before.progress,
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
