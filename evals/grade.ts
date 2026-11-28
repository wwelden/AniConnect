/** Grades an eval run by comparing list state before and after. */
import { formatDate, normalize } from "../src/logic";
import { findMedia, type StoredEntry } from "../test/support/fake-anilist";
import type { Change, EvalCase, Outcome } from "./cases";

/**
 * Whether the reply mentions a name, starting at a word boundary and ignoring spacing
 * and case: "DAN DA DAN" mentions "Dandadan", "Plan to watch" and "planning" mention
 * "plan", but "explanation" doesn't.
 */
export function mentions(reply: string, name: string): boolean {
  const target = normalize(name).replace(/ /g, "");
  const words = normalize(reply).split(" ");
  return words.some((_, i) => words.slice(i).join("").startsWith(target));
}

function shownDate(d: StoredEntry["startedAt"]): string {
  return d.year ? formatDate(d) : "";
}

function customLists(e: StoredEntry): string {
  return JSON.stringify([...(e.customLists ?? [])].sort());
}

/**
 * One show's change. `entry`: its list entry changed (`before` and `after` are the entry, or
 * absent when it wasn't on the list). `favorite`: it was made a favorite (true) or taken out (false).
 */
export type ShowChange = { before?: StoredEntry; after?: StoredEntry; entry: boolean; favorite?: boolean };
export type Changes = Map<number, ShowChange>;

/**
 * What changed between two states, keyed by AniList media ID: any field of a list entry the user
 * can edit, and with `favorites` (the media IDs before and after), the user's favorites.
 */
export function diff(before: StoredEntry[], after: StoredEntry[], favorites?: { before: number[]; after: number[] }): Changes {
  const b = new Map(before.map((e) => [e.mediaId, e]));
  const a = new Map(after.map((e) => [e.mediaId, e]));
  const changed: Changes = new Map();
  for (const id of new Set([...b.keys(), ...a.keys()])) {
    const x = b.get(id);
    const y = a.get(id);
    if (
      !x ||
      !y ||
      x.status !== y.status ||
      x.progress !== y.progress ||
      (x.progressVolumes ?? 0) !== (y.progressVolumes ?? 0) ||
      x.scoreRaw !== y.scoreRaw ||
      shownDate(x.startedAt) !== shownDate(y.startedAt) ||
      shownDate(x.completedAt) !== shownDate(y.completedAt) ||
      (x.notes || "") !== (y.notes || "") ||
      (x.repeat ?? 0) !== (y.repeat ?? 0) ||
      (x.private ?? false) !== (y.private ?? false) ||
      (x.hiddenFromStatusLists ?? false) !== (y.hiddenFromStatusLists ?? false) ||
      customLists(x) !== customLists(y)
    ) {
      changed.set(id, { before: x, after: y, entry: true });
    }
  }
  if (favorites) {
    const was = new Set(favorites.before);
    const is = new Set(favorites.after);
    for (const id of new Set([...was, ...is])) {
      if (was.has(id) === is.has(id)) continue;
      const show = changed.get(id) ?? { before: b.get(id), after: a.get(id), entry: false };
      changed.set(id, { ...show, favorite: is.has(id) });
    }
  }
  return changed;
}

/** Whether a wanted change asks for anything about the list entry, not just the favorite. */
function wantsEntry(want: Change): boolean {
  return Object.entries(want).some(([k, v]) => k !== "anime" && k !== "favorite" && v !== undefined);
}

function checkChange(want: Change, got: ShowChange | undefined): string | null {
  const title = typeof want.anime === "number" ? want.anime : `"${want.anime}"`;
  if (!got) return `${title} was not changed`;
  if (got.favorite !== want.favorite) {
    if (want.favorite === undefined) return `${title} ${got.favorite ? "was made a favorite" : "was taken out of the favorites"} too`;
    return `${title} ${want.favorite ? "was not made a favorite" : "is still a favorite"}`;
  }
  if (!wantsEntry(want)) return got.entry ? `${title}'s list entry changed too` : null;
  if (!got.entry) return `${title}'s list entry was not changed`;
  if (want.removed) return got.after ? `${title} was not removed` : null;
  if (!got.after) return `${title} was removed`;
  if (want.added && got.before) return `${title} was already on the list`;
  if (want.status && got.after.status !== want.status) return `${title} status ${got.after.status}, wanted ${want.status}`;
  if (want.progress !== undefined && got.after.progress !== want.progress)
    return `${title} progress ${got.after.progress}, wanted ${want.progress}`;
  if (want.volumes !== undefined && (got.after.progressVolumes ?? 0) !== want.volumes)
    return `${title} volumes ${got.after.progressVolumes ?? 0}, wanted ${want.volumes}`;
  if (want.score !== undefined && got.after.scoreRaw !== Math.round(want.score * 10))
    return `${title} score ${got.after.scoreRaw / 10}, wanted ${want.score}`;
  for (const field of ["startedAt", "completedAt"] as const) {
    const want_ = want[field];
    if (want_ !== undefined && shownDate(got.after[field]) !== want_) {
      return `${title} ${field} ${shownDate(got.after[field]) || "none"}, wanted ${want_}`;
    }
  }
  const note = got.after.notes ?? "";
  const missing = (want.noteHas ?? []).filter((w) => !note.toLowerCase().includes(w.toLowerCase()));
  if (missing.length) return `${title} note "${note}" lacks ${missing.join(", ")}`;
  return null;
}

export interface GradeOptions {
  /**
   * For servers other than AniConnect, whose tools have other names: a read-only case's
   * `tools` only require that some tool was called.
   */
  anyTool?: boolean;
}

export function grade(outcome: Outcome, changed: Changes, reply: string, toolCalls: string[] = [], options: GradeOptions = {}): string | null {
  if ("asks" in outcome) {
    if (changed.size) return `changed ${changed.size} entries instead of asking`;
    return reply.includes("?") ? null : "didn't ask the user anything";
  }
  if ("readOnly" in outcome) {
    if (changed.size) return `changed ${changed.size} entries on a read-only request`;
    if (options.anyTool) {
      if (outcome.tools?.length && toolCalls.length === 0) return "didn't call any tool";
    } else {
      const unused = (outcome.tools ?? []).filter((t) => !toolCalls.includes(t));
      if (unused.length) return `didn't call ${unused.join(", ")}`;
    }
    const missing = (outcome.mentions ?? []).filter((m) => !mentions(reply, m));
    return missing.length ? `reply doesn't mention ${missing.join(", ")}` : null;
  }
  const wantIds = new Set(outcome.changes.map((c) => findMedia(c.anime).id));
  for (const c of outcome.changes) {
    const problem = checkChange(c, changed.get(findMedia(c.anime).id));
    if (problem) return problem;
  }
  const extra = [...changed.keys()].filter((id) => !wantIds.has(id));
  if (extra.length) return `also changed ${extra.map((id) => findMedia(id).title.romaji).join(", ")}`;
  return null;
}

/** null when any acceptable outcome matches, else why none did. */
export function gradeCase(
  c: EvalCase,
  changed: Changes,
  reply: string,
  toolCalls: string[] = [],
  options: GradeOptions = {},
): string | null {
  const outcomes = Array.isArray(c.expect) ? c.expect : [c.expect];
  const problems = outcomes.map((o) => grade(o, changed, reply, toolCalls, options));
  return problems.some((p) => p === null) ? null : problems.filter(Boolean).join(" / ");
}
