import type { FuzzyDate, ListEntry, ListStatus, Media, MediaTitle, ScoreFormat } from "./anilist";

export function normalize(text: string): string {
  return text
    .replace(/[×✕]/g, " x ")
    .normalize("NFKD")
    // Strip Latin accents, then recompose so Japanese voiced kana (ば, ガ) stay whole.
    .replace(/[\u0300-\u036f]/g, "")
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

/** True when every word of the query appears in one of the media's titles or synonyms. */
export function matchesTitle(media: Pick<Media, "title" | "synonyms">, query: string): boolean {
  const words = normalize(query).split(" ").filter(Boolean);
  if (words.length === 0) return true;
  const names = [media.title.romaji, media.title.english, media.title.native, ...media.synonyms]
    .filter((n): n is string => Boolean(n))
    .map(normalize);
  return names.some((name) => words.every((w) => name.includes(w)));
}

export function displayTitle(title: MediaTitle): string {
  const main = title.english ?? title.romaji ?? title.native ?? "Untitled";
  return title.romaji && title.romaji !== main ? `${main} (${title.romaji})` : main;
}

export function todayFuzzy(now = new Date()): FuzzyDate {
  return { year: now.getFullYear(), month: now.getMonth() + 1, day: now.getDate() };
}

function isSet(date: FuzzyDate | undefined | null): boolean {
  return Boolean(date?.year);
}

export interface ProgressPlan {
  progress: number;
  status?: ListStatus;
  startedAt?: FuzzyDate;
  completedAt?: FuzzyDate;
}

/**
 * Works out what to save when the user's episode count changes:
 * reaching the last episode completes the show, and watching an episode of
 * something planned, paused or dropped moves it to watching.
 */
export function planProgress(
  media: Pick<Media, "episodes">,
  entry: Pick<ListEntry, "status" | "startedAt" | "completedAt"> | null,
  progress: number,
  today: FuzzyDate = todayFuzzy(),
): ProgressPlan {
  if (!Number.isInteger(progress) || progress < 0) {
    throw new Error(`Episode count must be a whole number of 0 or more (got ${progress}).`);
  }
  if (media.episodes != null && progress > media.episodes) {
    throw new Error(`This show only has ${media.episodes} episodes (got ${progress}).`);
  }

  const plan: ProgressPlan = { progress };
  const current = entry?.status;
  const finished = media.episodes != null && media.episodes > 0 && progress === media.episodes;

  if (finished && current !== "COMPLETED") {
    plan.status = "COMPLETED";
    // A rewatch finishing keeps the original completion date.
    if (current !== "REPEATING" || !isSet(entry?.completedAt)) plan.completedAt = today;
    if (!isSet(entry?.startedAt)) plan.startedAt = today;
  } else if (
    progress > 0 &&
    !finished &&
    (current === undefined || current === "PLANNING" || current === "PAUSED" || current === "DROPPED")
  ) {
    plan.status = "CURRENT";
    if (!isSet(entry?.startedAt)) plan.startedAt = today;
  }
  return plan;
}

/** Converts a 0–10 score (half points and decimals allowed) to AniList's raw 0–100 score. */
export function toRawScore(score: number): number {
  if (!Number.isFinite(score) || score < 0 || score > 10) {
    throw new Error(`Score must be between 0 and 10 (got ${score}). Use 0 to clear a rating.`);
  }
  return Math.round(score * 10);
}

const FORMAT_LABEL: Record<ScoreFormat, string> = {
  POINT_100: "/100",
  POINT_10_DECIMAL: "/10",
  POINT_10: "/10",
  POINT_5: " stars (of 5)",
  POINT_3: " (smiley, of 3)",
};

export function formatScore(displayScore: number, format: ScoreFormat): string {
  if (!displayScore) return "unrated";
  return `${displayScore}${FORMAT_LABEL[format]}`;
}

const STATUS_LABEL: Record<ListStatus, string> = {
  CURRENT: "Watching",
  PLANNING: "Plan to watch",
  COMPLETED: "Completed",
  DROPPED: "Dropped",
  PAUSED: "Paused",
  REPEATING: "Rewatching",
};

export function statusLabel(status: ListStatus): string {
  return STATUS_LABEL[status];
}

export function describeEntry(
  media: Media,
  entry: Pick<ListEntry, "status" | "progress" | "displayScore"> | null,
  scoreFormat: ScoreFormat,
): string {
  const episodes = media.episodes ?? "?";
  const meta = [media.format, media.seasonYear].filter(Boolean).join(", ");
  const head = `[${media.id}] ${displayTitle(media.title)}${meta ? ` (${meta})` : ""}`;
  if (!entry) return `${head}: not on your list, ${episodes} episodes`;
  return `${head}: ${statusLabel(entry.status)}, ${entry.progress}/${episodes} episodes, ${formatScore(entry.displayScore, scoreFormat)}`;
}
