import { typeOf, type FuzzyDate, type ListEntry, type ListStatus, type Media, type MediaTitle, type ScoreFormat, type TitleLanguage } from "./anilist";

/** What the planners and labels read of a show: its episodes, or for a manga, its chapters and volumes. */
export type Counted = Pick<Media, "episodes"> & Partial<Pick<Media, "type" | "chapters" | "volumes">>;

/** How many units (episodes, or a manga's chapters) a show has; null when AniList doesn't know yet. */
export function total(media: Counted): number | null {
  return typeOf(media) === "MANGA" ? (media.chapters ?? null) : media.episodes;
}

/** "episode" or "chapter", plural when `n` isn't 1 (or not given). */
export function unit(media: Counted, n?: number): string {
  const word = typeOf(media) === "MANGA" ? "chapter" : "episode";
  return n === 1 ? word : `${word}s`;
}

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

/**
 * A title as written, ignoring only case, spacing and typographic variants of the same mark
 * (curly quotes, dashes, ×): "Love is War?" stays apart from "Love is War".
 */
export function literalTitle(text: string): string {
  return text
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[‘’ʼ′]/g, "'")
    .replace(/[“”″]/g, '"')
    .replace(/[‐‑‒–—―−]/g, "-")
    .replace(/[×✕]/g, "x")
    .replace(/\s+/g, "");
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
  /** Volumes read, for a manga. */
  progressVolumes?: number;
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
  Partial<Pick<ListEntry, "progress" | "repeat" | "progressVolumes">>;

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
 * Works out what to save when the user's episode count (a manga's chapter count) changes:
 * reaching the last episode completes the show, watching an episode of
 * something planned, paused or dropped moves it to watching, and going back
 * below the last episode of a completed show moves it back to watching.
 */
export function planProgress(
  media: Counted,
  entry: PriorEntry | null,
  progress: number,
  today: FuzzyDate = todayFuzzy(),
): ProgressPlan {
  const last = total(media);
  if (!Number.isInteger(progress) || progress < 0) {
    const word = unit(media, 1);
    throw new Error(`${word[0]!.toUpperCase()}${word.slice(1)} count must be a whole number of 0 or more (got ${progress}).`);
  }
  if (last != null && progress > last) {
    throw new Error(`This ${typeOf(media) === "MANGA" ? "manga" : "show"} only has ${last} ${unit(media)} (got ${progress}).`);
  }

  const current = entry?.status;
  const finished = last != null && last > 0 && progress === last;
  // Lowered, not just below the full count: a show marked completed at 0 episodes stays completed.
  const lowered = entry?.progress != null ? progress < entry.progress : last != null && progress < last;

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
 * A manga's volume count changing on its own ("I'm on volume 5"): reading a volume of something
 * planned, paused or dropped moves it to reading, like a chapter would. Volumes never complete
 * it: AniList's volume count can run ahead of the chapters it knows of.
 */
export function planVolumes(
  media: Counted,
  entry: PriorEntry | null,
  volumes: number,
  today: FuzzyDate = todayFuzzy(),
): EntryPlan {
  if (media.volumes != null && volumes > media.volumes) {
    throw new Error(`This manga only has ${media.volumes} volumes (got ${volumes}).`);
  }
  const current = entry?.status;
  const starts = volumes > 0 && (current === undefined || current === "PLANNING" || current === "PAUSED" || current === "DROPPED");
  return starts ? { progressVolumes: volumes, status: "CURRENT", ...transition(entry, "CURRENT", today) } : { progressVolumes: volumes };
}

/**
 * Works out what to save when the user sets a status directly: the same date rules as
 * episode changes, all episodes (a manga's chapters and volumes) for Completed, and episode 0
 * when a rewatch starts.
 */
export function planStatus(
  media: Counted,
  entry: PriorEntry | null,
  status: ListStatus,
  today: FuzzyDate = todayFuzzy(),
): EntryPlan {
  const plan: EntryPlan = { status, ...transition(entry, status, today) };
  const last = total(media);
  const manga = typeOf(media) === "MANGA";
  if (status === "COMPLETED" && last) plan.progress = last;
  if (status === "COMPLETED" && manga && media.volumes) plan.progressVolumes = media.volumes;
  if (status === "REPEATING" && entry && entry.status !== "REPEATING") {
    const watchedAll = entry.status === "COMPLETED" || (last != null && (entry.progress ?? 0) >= last);
    if (watchedAll && entry.progress !== 0) plan.progress = 0;
    if (watchedAll && manga && entry.progressVolumes) plan.progressVolumes = 0;
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
  media: Counted,
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
          progressVolumes: plan.progressVolumes ?? entry?.progressVolumes,
          repeat: plan.repeat ?? entry?.repeat,
        }
      : null;
    plan = { ...plan, ...planStatus(media, afterProgress, change.status, today) };
    if (change.progress !== undefined) plan.progress = change.progress;
    // A reread from a given chapter still starts the volumes over, judged from the entry as it was.
    if (change.status === "REPEATING" && change.progress !== undefined && planStatus(media, entry, "REPEATING", today).progressVolumes === 0) {
      plan.progressVolumes = 0;
    }
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
 * remember the month, or "2025". Dates in the future (after `latest`) are refused.
 */
export function parseFuzzyDate(text: string, today: FuzzyDate, latest = today): FuzzyDate {
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
  if (after(date, latest)) throw new Error(`${text} is in the future (today is ${formatDate(today)}).`);
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

/** AniList's own words for a manga list's statuses. */
const MANGA_STATUS_LABEL: Record<ListStatus, string> = {
  ...STATUS_LABEL,
  CURRENT: "Reading",
  PLANNING: "Plan to read",
  REPEATING: "Rereading",
};

/** A status as the user's list shows it: "Watching" for an anime, "Reading" for a manga (pass the media, or its type). */
export function statusLabel(status: ListStatus, media?: { type?: string | null } | null): string {
  return (media && typeOf(media) === "MANGA" ? MANGA_STATUS_LABEL : STATUS_LABEL)[status];
}

/** The year to show beside a title: an anime's season year, a manga's start year. */
export function releaseYear(media: Pick<Media, "seasonYear" | "startDate" | "type">): number | null {
  return media.seasonYear ?? (typeOf(media) === "MANGA" ? (media.startDate?.year ?? null) : null);
}

export function describeEntry(
  media: Media,
  entry: Pick<ListEntry, "status" | "progress" | "displayScore" | "progressVolumes"> | null,
  viewer: { scoreFormat: ScoreFormat; titleLanguage: TitleLanguage },
): string {
  const count = total(media) ?? "?";
  const meta = [media.format, releaseYear(media)].filter(Boolean).join(", ");
  const head = `[${media.id}] ${displayTitle(media.title, viewer.titleLanguage)}${meta ? ` (${meta})` : ""}`;
  if (!entry) return `${head}: not on your list, ${count} ${unit(media)}`;
  const volumes = entry.progressVolumes ? `, volume ${entry.progressVolumes}/${media.volumes ?? "?"}` : "";
  return `${head}: ${statusLabel(entry.status, media)}, ${entry.progress}/${count} ${unit(media)}${volumes}, ${formatScore(entry.displayScore, viewer.scoreFormat)}`;
}
