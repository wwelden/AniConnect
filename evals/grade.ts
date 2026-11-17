/** Grades an eval run by comparing list state before and after. */
import { findMedia, type StoredEntry } from "../test/support/fake-anilist";
import type { Change, EvalCase, Outcome } from "./cases";

export type Changes = Map<number, { before?: StoredEntry; after?: StoredEntry }>;

/** What changed between two list states, keyed by AniList media ID. */
export function diff(before: StoredEntry[], after: StoredEntry[]) {
  const b = new Map(before.map((e) => [e.mediaId, e]));
  const a = new Map(after.map((e) => [e.mediaId, e]));
  const changed = new Map<number, { before?: StoredEntry; after?: StoredEntry }>();
  for (const id of new Set([...b.keys(), ...a.keys()])) {
    const x = b.get(id);
    const y = a.get(id);
    if (!x || !y || x.status !== y.status || x.progress !== y.progress || x.scoreRaw !== y.scoreRaw) {
      changed.set(id, { before: x, after: y });
    }
  }
  return changed;
}

function checkChange(want: Change, got: { before?: StoredEntry; after?: StoredEntry } | undefined): string | null {
  const title = typeof want.anime === "number" ? want.anime : `"${want.anime}"`;
  if (!got) return `${title} was not changed`;
  if (want.removed) return got.after ? `${title} was not removed` : null;
  if (!got.after) return `${title} was removed`;
  if (want.added && got.before) return `${title} was already on the list`;
  if (want.status && got.after.status !== want.status) return `${title} status ${got.after.status}, wanted ${want.status}`;
  if (want.progress !== undefined && got.after.progress !== want.progress)
    return `${title} progress ${got.after.progress}, wanted ${want.progress}`;
  if (want.score !== undefined && got.after.scoreRaw !== Math.round(want.score * 10))
    return `${title} score ${got.after.scoreRaw / 10}, wanted ${want.score}`;
  return null;
}

export function grade(outcome: Outcome, changed: Changes, reply: string): string | null {
  if ("asks" in outcome) {
    if (changed.size) return `changed ${changed.size} entries instead of asking`;
    return reply.includes("?") ? null : "didn't ask the user anything";
  }
  if ("readOnly" in outcome) {
    if (changed.size) return `changed ${changed.size} entries on a read-only request`;
    const missing = (outcome.mentions ?? []).filter((m) => !reply.toLowerCase().includes(m.toLowerCase()));
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
export function gradeCase(c: EvalCase, changed: Changes, reply: string): string | null {
  const outcomes = Array.isArray(c.expect) ? c.expect : [c.expect];
  const problems = outcomes.map((o) => grade(o, changed, reply));
  return problems.some((p) => p === null) ? null : problems.filter(Boolean).join(" / ");
}
