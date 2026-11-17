import type { FuzzyDate, ListEntry, ListStatus, Media, MediaTitle, ScoreFormat, TitleLanguage } from "./anilist";

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

/** Which title to show for each language setting, then what to fall back to when AniList has none. */
const TITLE_ORDER: Record<TitleLanguage, (keyof MediaTitle)[]> = {
  ROMAJI: ["romaji", "english", "native"],
  ROMAJI_STYLISED: ["romaji", "english", "native"],
  ENGLISH: ["english", "romaji", "native"],
  ENGLISH_STYLISED: ["english", "romaji", "native"],
  NATIVE: ["native", "romaji", "english"],
  NATIVE_STYLISED: ["native", "romaji", "english"],
};

/** One title, in the language the user reads titles in on AniList. */
export function displayTitle(title: MediaTitle, language: TitleLanguage): string {
  for (const key of TITLE_ORDER[language]) {
    if (title[key]) return title[key];
  }
  return "Untitled";
}

/**
 * The display title plus one other name the user may know the show by, for lists of
 * candidates to choose between: "JUJUTSU KAISEN Season 2 (Jujutsu Kaisen 2nd Season)".
 */
export function bothTitles(title: MediaTitle, language: TitleLanguage): string {
  const main = displayTitle(title, language);
  const other = [title.english, title.romaji].find((t) => t && t !== main);
  return other ? `${main} (${other})` : main;
}

/** Today's date in `timeZone` (an IANA name or an offset like "-05:00"), or in the server's zone. */
export function todayFuzzy(now = new Date(), timeZone?: string): FuzzyDate {
  if (!timeZone) return { year: now.getFullYear(), month: now.getMonth() + 1, day: now.getDate() };
  const fields = new Intl.DateTimeFormat("en-US", { timeZone, year: "numeric", month: "numeric", day: "numeric" })
    .formatToParts(now);
  const get = (type: Intl.DateTimeFormatPartTypes) => Number(fields.find((f) => f.type === type)?.value);
  return { year: get("year"), month: get("month"), day: get("day") };
}

/** Any part counts: AniList lets users enter a month or day without a year, and that's still theirs. */
function isSet(date: FuzzyDate | undefined | null): boolean {
  return Boolean(date?.year || date?.month || date?.day);
}

/** What to save on an entry; fields left out are not changed. */
export interface EntryPlan {
  progress?: number;
  status?: ListStatus;
  startedAt?: FuzzyDate;
  completedAt?: FuzzyDate;
  /** AniList's rewatch count. */
  repeat?: number;
}

export interface ProgressPlan extends EntryPlan {
  progress: number;
}

/** The parts of a list entry the planners read. */
export type PriorEntry = Pick<ListEntry, "status" | "startedAt" | "completedAt"> &
  Partial<Pick<ListEntry, "progress" | "repeat">>;

/**
 * Dates and rewatch count for a move to `next`, shared by every tool that changes status
 * (R0.7, R0.9). Only empty dates are filled in, never overwritten (R3.2).
 */
function transition(entry: PriorEntry | null, next: ListStatus, today: FuzzyDate): EntryPlan {
  const plan: EntryPlan = {};
  const prev = entry?.status;
  if (next === prev) return plan;
  // Coming back from Completed or a rewatch isn't starting the show.
  const starting = prev !== "COMPLETED" && prev !== "REPEATING";
  if ((next === "CURRENT" || next === "COMPLETED") && starting && !isSet(entry?.startedAt)) plan.startedAt = today;
  if (next === "COMPLETED") {
    // A rewatch finishing keeps the original completion date (it's already set) and counts the rewatch.
    if (!isSet(entry?.completedAt)) plan.completedAt = today;
    if (prev === "REPEATING") plan.repeat = (entry?.repeat ?? 0) + 1;
  }
  return plan;
}

/**
 * Works out what to save when the user's episode count changes:
 * reaching the last episode completes the show, watching an episode of
 * something planned, paused or dropped moves it to watching, and going back
 * below the last episode of a completed show moves it back to watching.
 */
export function planProgress(
  media: Pick<Media, "episodes">,
  entry: PriorEntry | null,
  progress: number,
  today: FuzzyDate = todayFuzzy(),
): ProgressPlan {
  if (!Number.isInteger(progress) || progress < 0) {
    throw new Error(`Episode count must be a whole number of 0 or more (got ${progress}).`);
  }
  if (media.episodes != null && progress > media.episodes) {
    throw new Error(`This show only has ${media.episodes} episodes (got ${progress}).`);
  }

  const current = entry?.status;
  const finished = media.episodes != null && media.episodes > 0 && progress === media.episodes;
  // Lowered, not just below the full count: a show marked completed at 0 episodes stays completed.
  const lowered =
    entry?.progress != null ? progress < entry.progress : media.episodes != null && progress < media.episodes;

  let next: ListStatus | undefined;
  if (finished && current !== "COMPLETED") {
    next = "COMPLETED";
  } else if (
    progress > 0 &&
    !finished &&
    (current === undefined || current === "PLANNING" || current === "PAUSED" || current === "DROPPED")
  ) {
    next = "CURRENT";
  } else if (current === "COMPLETED" && !finished && lowered) {
    next = "CURRENT";
  }
  return next ? { progress, status: next, ...transition(entry, next, today) } : { progress };
}

/**
 * Works out what to save when the user sets a status directly: the same date rules as
 * episode changes, all episodes for Completed, and episode 0 when a rewatch starts.
 */
export function planStatus(
  media: Pick<Media, "episodes">,
  entry: PriorEntry | null,
  status: ListStatus,
  today: FuzzyDate = todayFuzzy(),
): EntryPlan {
  const plan: EntryPlan = { status, ...transition(entry, status, today) };
  if (status === "COMPLETED" && media.episodes) plan.progress = media.episodes;
  if (status === "REPEATING" && entry && entry.status !== "REPEATING") {
    const watchedAll =
      entry.status === "COMPLETED" || (media.episodes != null && (entry.progress ?? 0) >= media.episodes);
    if (watchedAll && entry.progress !== 0) plan.progress = 0;
  }
  return plan;
}

export const NO_DATE: FuzzyDate = { year: null, month: null, day: null };

/**
 * Several changes to one entry in one save (R2.6): the episode count first, with the usual
 * status and date rules, then a status from the request on top of it, as if the two had been
 * saved one after the other. An episode count given explicitly wins over the one a status
 * implies (all episodes for Completed, 0 for a rewatch).
 */
export function planUpdate(
  media: Pick<Media, "episodes">,
  entry: PriorEntry | null,
  change: { progress?: number; status?: ListStatus },
  today: FuzzyDate = todayFuzzy(),
): EntryPlan {
  let plan: EntryPlan = change.progress !== undefined ? planProgress(media, entry, change.progress, today) : {};
  if (change.status && change.status !== "COMPLETED" && plan.status === "COMPLETED") {
    // The last episode would complete it, but the user named another status: no finish date or rewatch count.
    delete plan.completedAt;
    delete plan.repeat;
  }
  if (change.status) {
    const status = plan.status ?? entry?.status;
    const afterProgress: PriorEntry | null = status
      ? {
          status,
          startedAt: plan.startedAt ?? entry?.startedAt ?? NO_DATE,
          completedAt: plan.completedAt ?? entry?.completedAt ?? NO_DATE,
          progress: plan.progress ?? entry?.progress,
          repeat: plan.repeat ?? entry?.repeat,
        }
      : null;
    plan = { ...plan, ...planStatus(media, afterProgress, change.status, today) };
    if (change.progress !== undefined) plan.progress = change.progress;
  }
  return plan;
}

/** Whether `a` is after `b`, comparing only the parts both have: 2025-03 isn't after 2025-03-14. */
export function after(a: FuzzyDate, b: FuzzyDate): boolean {
  if (!a.year || !b.year) return false;
  if (a.year !== b.year) return a.year > b.year;
  if (!a.month || !b.month) return false;
  if (a.month !== b.month) return a.month > b.month;
  return Boolean(a.day && b.day && a.day > b.day);
}

/**
 * Reads a start or finish date the user gave (R0.10): "2025-03-14", "2025-03" when they only
 * remember the month, or "2025". Dates in the future are refused.
 */
export function parseFuzzyDate(text: string, today: FuzzyDate): FuzzyDate {
  const m = /^(\d{4})(?:-(\d{1,2})(?:-(\d{1,2}))?)?$/.exec(text.trim());
  if (!m) throw new Error(`Give dates as YYYY-MM-DD, YYYY-MM or YYYY (got "${text}").`);
  const year = Number(m[1]);
  const month = m[2] ? Number(m[2]) : null;
  const day = m[3] ? Number(m[3]) : null;
  if (month !== null && (month < 1 || month > 12)) throw new Error(`There's no month ${month} (got "${text}").`);
  if (day !== null && (day < 1 || day > new Date(Date.UTC(year, month!, 0)).getUTCDate())) {
    throw new Error(`There's no day ${day} in ${year}-${String(month).padStart(2, "0")} (got "${text}").`);
  }
  const date = { year, month, day };
  if (after(date, today)) throw new Error(`${text} is in the future (today is ${formatDate(today)}).`);
  return date;
}

/** Refuses a start date after the finish date. */
export function checkDateOrder(startedAt: FuzzyDate | undefined | null, completedAt: FuzzyDate | undefined | null): void {
  if (startedAt && completedAt && after(startedAt, completedAt)) {
    throw new Error(`The start date (${formatDate(startedAt)}) is after the finish date (${formatDate(completedAt)}).`);
  }
}

/** A date for results: "2025-03-14", "2025-03", "2025", or "none". */
export function showDate(d: FuzzyDate | null | undefined): string {
  return d?.year ? formatDate(d) : "none";
}

export function formatDate(d: FuzzyDate): string {
  const pad = (n: number | null) => String(n ?? 0).padStart(2, "0");
  return d.month ? `${d.year}-${pad(d.month)}${d.day ? `-${pad(d.day)}` : ""}` : String(d.year);
}

/** The side effects of a plan worth telling the user about (R2.3): dates written, rewatch count. */
export function describePlanDates(plan: EntryPlan): string {
  const parts = [
    plan.startedAt && `start date set to ${formatDate(plan.startedAt)}`,
    plan.completedAt && `finish date set to ${formatDate(plan.completedAt)}`,
    plan.repeat !== undefined && `rewatch count is now ${plan.repeat}`,
  ].filter(Boolean) as string[];
  if (parts.length === 0) return "";
  const sentence = parts.join(", ");
  return ` ${sentence[0]!.toUpperCase()}${sentence.slice(1)}.`;
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
  viewer: { scoreFormat: ScoreFormat; titleLanguage: TitleLanguage },
): string {
  const episodes = media.episodes ?? "?";
  const meta = [media.format, media.seasonYear].filter(Boolean).join(", ");
  const head = `[${media.id}] ${displayTitle(media.title, viewer.titleLanguage)}${meta ? ` (${meta})` : ""}`;
  if (!entry) return `${head}: not on your list, ${episodes} episodes`;
  return `${head}: ${statusLabel(entry.status)}, ${entry.progress}/${episodes} episodes, ${formatScore(entry.displayScore, viewer.scoreFormat)}`;
}
