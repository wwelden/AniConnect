/**
 * "What did I watch this week?" (requirement R0.14): the user's own list activity from
 * AniList's activity feed, for a time range in plain words, in the user's time zone.
 */
import type { FuzzyDate, ListActivity, ListItem, TitleLanguage } from "./anilist";
import { displayTitle, formatDate } from "./logic";
import { parts } from "./whatsnext";

interface Day {
  year: number;
  /** 1-12 */
  month: number;
  day: number;
}

/** How far a zone's wall clock is ahead of UTC at an instant, in ms. */
function zoneOffset(ms: number, timeZone: string): number {
  const fields = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "numeric",
    day: "numeric",
    hour: "numeric",
    minute: "numeric",
    second: "numeric",
    hourCycle: "h23",
  }).formatToParts(ms);
  const n = (type: Intl.DateTimeFormatPartTypes) => Number(fields.find((f) => f.type === type)?.value);
  const wall = Date.UTC(n("year"), n("month") - 1, n("day"), n("hour") % 24, n("minute"), n("second"));
  return wall - Math.floor(ms / 1000) * 1000;
}

/** The calendar date of an instant in a zone. */
function dayOf(ms: number, timeZone: string): Day {
  const d = new Date(ms + zoneOffset(ms, timeZone));
  return { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate() };
}

/** A date moved by whole months or years, then days ("a month before Mar 31" is Feb 28 or 29). */
function shift(d: Day, by: { days?: number; months?: number; years?: number }): Day {
  const month = d.month - 1 + (by.months ?? 0) + 12 * (by.years ?? 0);
  const monthLength = new Date(Date.UTC(d.year, month + 1, 0)).getUTCDate();
  const x = new Date(Date.UTC(d.year, month, Math.min(d.day, monthLength) + (by.days ?? 0)));
  return { year: x.getUTCFullYear(), month: x.getUTCMonth() + 1, day: x.getUTCDate() };
}

/** The instant a date starts (local midnight) in a zone. */
function startOf(d: Day, timeZone: string): number {
  const utc = Date.UTC(d.year, d.month - 1, d.day);
  // Two passes settle the offset when midnight is near a daylight-saving change.
  const first = utc - zoneOffset(utc, timeZone);
  const start = utc - zoneOffset(first, timeZone);
  // Where clocks jump forward at midnight (America/Santiago), midnight doesn't exist and
  // `start` lands on the day before; the day starts when the clocks jump.
  const got = dayOf(start, timeZone);
  return got.day === d.day && got.month === d.month ? start : utc - zoneOffset(start, timeZone);
}

export interface Range {
  /** Inclusive, ms. */
  start: number;
  /** Exclusive, ms. */
  end: number;
}

const MONTHS = [
  "january", "february", "march", "april", "may", "june",
  "july", "august", "september", "october", "november", "december",
];

const WEEKDAYS = ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"];

/** 0 (Monday) to 6 (Sunday). */
function weekdayOf(d: Day): number {
  return (new Date(Date.UTC(d.year, d.month - 1, d.day)).getUTCDay() + 6) % 7;
}

const NUMBERS = ["one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten", "eleven", "twelve"];
/** A count in words or digits: "3", "a", "two", "a couple of", "a few". */
const COUNT = `(\\d+|an?|${NUMBERS.join("|")}|(?:a )?couple(?: of)?|(?:a )?few)`;
const AGO = new RegExp(`^${COUNT} (day|week|month|year)s? ago$`);
const LAST_N = new RegExp(`^(?:the )?(?:last|past) (?:${COUNT} )?(day|week|month|year)s?$`);
const LAST_HOURS = new RegExp(`^(?:the )?(?:last|past) (?:${COUNT} )?hours?$`);

/** The number a COUNT match stands for (none is 1). */
function count(word: string | undefined): number {
  const w = (word ?? "1").replace(/^a /, "").replace(/ of$/, "");
  if (/^\d+$/.test(w)) return Number(w);
  if (w === "couple") return 2;
  if (w === "few") return 3;
  return NUMBERS.indexOf(w) + 1 || 1;
}

/** 1-12 for a month name or its abbreviation ("mar", "sept"), else 0. */
function monthNumber(word: string): number {
  return word.length >= 3 ? MONTHS.findIndex((name) => name.startsWith(word)) + 1 : 0;
}

/**
 * Days as [first, last] (both inclusive), from one phrase that names a single span.
 * A month or day named without a year is the latest one not in the future or, at the end
 * of a range, the first one on or after the range's start (`after`): "Dec 20 to Jan 5".
 * At the start of a range whose end names a year (`before`), it's in the end's year, or the
 * year before when its month comes later: "Dec 20 to Jan 5, 2025" starts in 2024.
 */
function span(text: string, today: Day, after?: Day, before?: Day): [Day, Day] | null {
  const t = text.trim();
  let m: RegExpMatchArray | null;
  if (t === "today") return [today, today];
  if (t === "yesterday") {
    const y = shift(today, { days: -1 });
    return [y, y];
  }
  if (t === "tonight") return [today, today];
  // Watching last night often runs past midnight.
  if (t === "last night") return [shift(today, { days: -1 }), today];
  if ((m = t.match(/^(this|last|past) weekend$/))) {
    // The weekend before this week ("last", "past"), or the latest one that has started ("this").
    const weekday = weekdayOf(today);
    if (m[1] === "this" && weekday >= 5) return [shift(today, { days: 5 - weekday }), today];
    const sunday = shift(today, { days: -weekday - 1 });
    return [shift(sunday, { days: -1 }), sunday];
  }
  if ((m = t.match(/^(?:last )?([a-z]+day)$/)) && WEEKDAYS.includes(m[1]!)) {
    const weekday = WEEKDAYS.indexOf(m[1]!);
    // At the end of a range, the first one on or after its start: "monday to wednesday".
    if (after) {
      const d = shift(after, { days: (weekday - weekdayOf(after) + 7) % 7 });
      return [d, d];
    }
    // Otherwise the latest one before today: "last friday" asked on a Friday is a week ago.
    const d = shift(today, { days: -((weekdayOf(today) - weekday + 7) % 7 || 7) });
    return [d, d];
  }
  if ((m = t.match(AGO))) {
    const n = count(m[1]);
    const unit = m[2]!;
    const d =
      unit === "day" || unit === "week"
        ? shift(today, { days: -n * (unit === "week" ? 7 : 1) })
        : shift(today, { [unit === "month" ? "months" : "years"]: -n });
    return [d, d];
  }
  if ((m = t.match(/^(this|last) week$/))) {
    const last = m[1] === "last";
    // Weeks start on Monday.
    const weekday = weekdayOf(today);
    const monday = shift(today, { days: -weekday - (last ? 7 : 0) });
    return [monday, last ? shift(monday, { days: 6 }) : today];
  }
  if ((m = t.match(/^(this|last) month$/))) {
    const last = m[1] === "last";
    const first = shift({ ...today, day: 1 }, { months: last ? -1 : 0 });
    return [first, last ? shift(first, { months: 1, days: -1 }) : today];
  }
  if ((m = t.match(/^(this|last) year$/))) {
    const year = today.year - (m[1] === "last" ? 1 : 0);
    return [{ year, month: 1, day: 1 }, m[1] === "last" ? { year, month: 12, day: 31 } : today];
  }
  if ((m = t.match(LAST_N))) {
    const n = count(m[1]);
    const unit = m[2]!;
    const first =
      unit === "day" || unit === "week"
        ? shift(today, { days: 1 - n * (unit === "week" ? 7 : 1) })
        : shift(today, { [unit === "month" ? "months" : "years"]: -n, days: 1 });
    return [first, today];
  }
  if ((m = t.match(/^(\d{4})$/))) {
    const year = Number(m[1]);
    return [{ year, month: 1, day: 1 }, { year, month: 12, day: 31 }];
  }
  if ((m = t.match(/^(\d{4})-(\d{1,2})$/))) {
    const first = { year: Number(m[1]), month: Number(m[2]), day: 1 };
    return first.month >= 1 && first.month <= 12 ? [first, shift(first, { months: 1, days: -1 })] : null;
  }
  if ((m = t.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/))) {
    const d = { year: Number(m[1]), month: Number(m[2]), day: Number(m[3]) };
    const check = shift(d, {});
    return check.month === d.month && check.day === d.day ? [d, d] : null;
  }
  // "5th of March 2025" reads as "March 5 2025".
  if ((m = t.match(/^(?:the )?(\d{1,2})(?:st|nd|rd|th)? (?:of )?([a-z]{3,9})\.?(,? \d{4})?$/))) {
    return span(`${m[2]} ${m[1]}${m[3] ?? ""}`, today, after, before);
  }
  if ((m = t.match(/^([a-z]{3,9})\.?(?: (\d{1,2})(?:st|nd|rd|th)?)?,? ?(\d{4})?$/))) {
    const month = monthNumber(m[1]!);
    if (month === 0) return null;
    const day = m[2] ? Number(m[2]) : null;
    const limit = before ?? today;
    let year = m[3] ? Number(m[3]) : (after ?? limit).year;
    if (!m[3] && after) {
      if (month < after.month || (month === after.month && day !== null && day < after.day)) year += 1;
    } else if (!m[3] && (month > limit.month || (!before && month === limit.month && day !== null && day > limit.day))) {
      year -= 1;
    }
    if (day !== null) {
      const d = { year, month, day };
      const check = shift(d, {});
      return check.day === day ? [d, d] : null;
    }
    const first = { year, month, day: 1 };
    return [first, shift(first, { months: 1, days: -1 })];
  }
  return null;
}

/**
 * Reads a time range a model can copy from the user's words: "this week", "last month",
 * "March", "March 2025", "last 30 days", "2026-03-14", "March 1 to March 15", "since June",
 * "all time", "this weekend", "last night", "two days ago", "past few weeks", "5th of March".
 * Throws a readable error for anything else.
 */
export function parsePeriod(period: string, now: number, timeZone: string): Range {
  const text = period
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^(in|during|from|over|for|on) /, "");
  const today = dayOf(now, timeZone);
  const end = (d: Day) => startOf(shift(d, { days: 1 }), timeZone);
  const checked = (r: Range): Range => {
    if (r.start > now) throw new Error(`"${period}" hasn't started yet; history only covers the past.`);
    if (r.start >= r.end) throw new Error(`"${period}" ends before it starts.`);
    return r;
  };

  if (/^(all|all time|ever|anytime|any time)$/.test(text)) return { start: 0, end: end(today) };
  const hours = text.match(LAST_HOURS);
  if (hours) {
    const n = count(hours[1]);
    if (n === 0) throw new Error(`"${period}" is an empty range.`);
    return checked({ start: now - n * 3_600_000, end: end(today) });
  }
  const since = text.match(/^since (.+)$/);
  if (since) {
    const s = span(since[1]!, today);
    if (s) return checked({ start: startOf(s[0], timeZone), end: end(today) });
  }
  const whole = span(text, today);
  if (whole) return checked({ start: startOf(whole[0], timeZone), end: end(whole[1]) });
  const between = text.match(/^(?:between )?(.+?)(?: to | until | through | and | - | – |\.\.)(.+)$/);
  if (between) {
    const [from, to] = [between[1]!, between[2]!];
    // A year written once, at the end, covers the start too: "March 1 to March 15, 2025".
    const yearAtEnd = /\d{4}/.test(to) && !/\d{4}/.test(from) ? span(to, today) : null;
    const a = span(from, today, undefined, yearAtEnd?.[1]);
    const b = yearAtEnd ?? (a && span(to, today, a[0]));
    if (a && b) return checked({ start: startOf(a[0], timeZone), end: end(b[1]) });
  }
  throw new Error(
    `Couldn't read the time range "${period}". Use words like "this week", "this weekend", "last friday", "3 days ago", "last month", "March", "March 5th", "March 2025", "last 30 days", "since June", or dates like "2026-03-01 to 2026-03-15".`,
  );
}

/** "Tue, Nov 17, 2026" */
function dayLabel(ms: number, timeZone: string, withYear = true): string {
  const p = parts(ms, timeZone);
  return `${p.weekday}, ${p.month} ${p.day}${withYear ? `, ${p.year}` : ""}`;
}

/** What an activity says, in plain words: "watched episodes 3-5", "completed", "added to plan to watch". */
export function describeActivity(a: Pick<ListActivity, "status" | "progress">): string {
  const progress = a.progress?.replace(/\s*-\s*/, "-") ?? "";
  const status = a.status ?? "updated";
  if (/^(re)?watched episode$/.test(status) && progress.includes("-")) return `${status}s ${progress}`;
  if (status === "plans to watch") return "added to plan to watch";
  const at = progress ? ` at episode ${progress}` : "";
  if (status === "paused watching") return `put on hold${at}`;
  if (status === "dropped") return `dropped${at}`;
  return progress ? `${status} ${progress}` : status;
}

/** An update that put a show in Plan to watch: a list import makes hundreds in minutes. */
export function isPlanAdd(a: Pick<ListActivity, "status">): boolean {
  return a.status === "plans to watch";
}

/** Plan-to-watch adds in a row that read as one line ("added 135 shows to plan to watch"). */
const BULK_ADDS = 5;
/** Adds further apart than this (seconds) start a new run. */
const BULK_GAP = 30 * 60;
/** A collapsed run of adds up to this long names every show; a longer one names 3. */
const BULK_ALL_TITLES = 8;

/** "6:16-6:43 AM", "11:50 AM-12:10 PM", or one time when both are the same. */
function timeSpan(from: string, to: string): string {
  if (from === to) return from;
  const [fromClock, fromPeriod] = from.split(" ");
  const [toClock, toPeriod] = to.split(" ");
  return fromPeriod === toPeriod ? `${fromClock}-${toClock} ${toPeriod}` : `${from}-${to}`;
}

export interface HistoryOptions {
  range: Range;
  now: number;
  timeZone: string;
  /** The show the history was filtered to, if any. */
  show?: string;
  /** More activity exists in the range than was fetched. */
  truncated: boolean;
  language: TitleLanguage;
  /**
   * Added at the end when the answer has a day or time read in `timeZone` (a note about the
   * zone): any range but all time, and every feed update's time. Finish dates from the list
   * are the user's own days, the same in any zone.
   */
  zoneNote?: string;
}

const INCOMPLETE =
  "AniList's activity feed can be incomplete: users can turn off activity for some list statuses, and old activity can be deleted.";

/** The range in words: "all time", "Tue, Nov 17, 2026", or "Mon, Nov 16, 2026 to Tue, Nov 17, 2026". */
function rangeLabel(o: HistoryOptions): string {
  const first = dayLabel(o.range.start, o.timeZone);
  const last = dayLabel(Math.min(o.range.end, o.now) - 1, o.timeZone);
  return o.range.start <= 0 ? "all time" : first === last ? first : `${first} to ${last}`;
}

/** Activity newest first, grouped by day in the user's time zone. */
export function formatHistory(activities: ListActivity[], o: HistoryOptions): string {
  const span = rangeLabel(o);
  const about = o.show ? ` for ${o.show}` : "";
  if (activities.length === 0) {
    const note = o.range.start > 0 ? (o.zoneNote ?? "") : "";
    return `No list activity${about} found (${span}, ${o.timeZone}). That doesn't prove nothing was watched: ${INCOMPLETE}${note}`;
  }
  const lines = [`List activity${about}, ${span} (${o.timeZone}), newest first:`];
  const thisYear = parts(o.now, o.timeZone).year;
  const dayOfUpdate = (a: ListActivity) => {
    const ms = a.createdAt * 1000;
    return dayLabel(ms, o.timeZone, parts(ms, o.timeZone).year !== thisYear);
  };
  const titleOf = (a: ListActivity) => (a.media ? displayTitle(a.media.title, o.language) : "(deleted show)");
  const timeOf = (a: ListActivity) => parts(a.createdAt * 1000, o.timeZone).time;
  let currentDay = "";
  let grouped = false;
  for (let i = 0; i < activities.length; i++) {
    const a = activities[i]!;
    const day = dayOfUpdate(a);
    if (day !== currentDay) {
      lines.push(day);
      currentDay = day;
    }
    // Plan-to-watch adds in a row, close together on one day: a list import reads as one
    // line, not hundreds.
    let end = i;
    const joins = (prev: ListActivity, next: ListActivity | undefined) =>
      next !== undefined && isPlanAdd(next) && prev.createdAt - next.createdAt <= BULK_GAP && dayOfUpdate(next) === day;
    while (isPlanAdd(a) && joins(activities[end]!, activities[end + 1])) end++;
    const run = activities.slice(i, end + 1);
    if (run.length >= BULK_ADDS) {
      const titles =
        run.length <= BULK_ALL_TITLES
          ? run.map(titleOf).join(", ")
          : `${run.slice(0, 3).map(titleOf).join(", ")} and ${run.length - 3} more`;
      // Newest first, so the run starts at its last update.
      const when = timeSpan(timeOf(run.at(-1)!), timeOf(a));
      lines.push(`- ${when}: added ${run.length} shows to plan to watch (${titles})`);
      grouped = true;
      i = end;
      continue;
    }
    lines.push(`- ${timeOf(a)} ${titleOf(a)}: ${describeActivity(a)}`);
  }
  if (o.truncated) {
    lines.push(
      `Showing the ${activities.length} most recent updates${grouped ? " (plan-to-watch adds in a row grouped)" : ""}; ask about a shorter range to see earlier ones, or pass finished: true for the shows finished in this range.`,
    );
  }
  lines.push(`Episodes logged in one sitting show as one range. ${INCOMPLETE}`);
  return `${lines.join("\n")}${o.zoneNote ?? ""}`;
}

/** A finish "completed" or "rewatched" in the feed; other updates aren't finishes. */
const FINISH = /^(completed|rewatched)$/;

/** The time a finish date on the list could mean, as a Range: a day, a month, or a year. */
function dateRange(d: FuzzyDate, timeZone: string): Range | null {
  if (!d.year) return null;
  const first = { year: d.year, month: d.month ?? 1, day: (d.month && d.day) || 1 };
  const last = shift(first, d.month && d.day ? { days: 1 } : d.month ? { months: 1 } : { years: 1 });
  return { start: startOf(first, timeZone), end: startOf(last, timeZone) };
}

/**
 * Shows finished in a range (#42), newest first: from the finish dates on the list, which
 * cover any range in one request, and from "completed" or "rewatched" updates in the feed,
 * which catch shows with no finish date and shows removed from the list since.
 */
export function formatFinished(list: ListItem[], activities: ListActivity[], o: HistoryOptions): string {
  const span = rangeLabel(o);
  const about = o.show ? ` (${o.show})` : "";
  const thisYear = parts(o.now, o.timeZone).year;
  const endOfToday = startOf(shift(dayOf(o.now, o.timeZone), { days: 1 }), o.timeZone);
  /** `fromFeed`: the day was read in the zone, rather than being a date from the list. */
  const finishes = new Map<number, { title: string; when: string; at: number; fromFeed?: boolean }>();
  /** When each dated show on the list was finished, by the list. */
  const dated = new Map<number, Range>();
  for (const e of list) {
    // A finish date counts whatever the status now: status changes keep it, so a show
    // finished and then rewatched and paused or dropped, or put back in Plan to watch for
    // a rewatch, was still finished then.
    const d = e.completedAt;
    const r = d ? dateRange(d, o.timeZone) : null;
    if (!r) continue;
    dated.set(e.media.id, r);
    // A full date counts when its day overlaps the range; a month or year only when all of
    // it is in the range ("2026" is in "this year", not "last month"). Finishes aren't in
    // the future, so that time ends today.
    const inRange =
      d.month && d.day
        ? r.start < o.range.end && r.end > o.range.start
        : r.start >= o.range.start && Math.min(r.end, endOfToday) <= o.range.end;
    if (!inRange) continue;
    const when = d.month && d.day ? dayLabel(r.start, o.timeZone, d.year !== thisYear) : formatDate(d);
    finishes.set(e.media.id, { title: displayTitle(e.media.title, o.language), when, at: r.start });
  }
  // The feed has the exact time. A finish date on the list is the user's word for when they
  // finished (they may have corrected it), so a "completed" update counts for a show with
  // one only when it agrees with it; a rewatch finished is a finish of its own.
  const exact = new Set<number>();
  for (const a of activities) {
    if (!a.media || !FINISH.test(a.status ?? "") || exact.has(a.media.id)) continue;
    const at = a.createdAt * 1000;
    const r = dated.get(a.media.id);
    if (a.status === "completed" && r && !(at >= r.start && at < r.end)) continue;
    // Activities are newest first, so a show finished twice in the range keeps its latest.
    exact.add(a.media.id);
    const when = dayLabel(at, o.timeZone, parts(at, o.timeZone).year !== thisYear);
    const title = `${displayTitle(a.media.title, o.language)}${a.status === "rewatched" ? " (rewatch)" : ""}`;
    finishes.set(a.media.id, { title, when, at, fromFeed: true });
  }
  const sorted = [...finishes.values()].sort((x, y) => y.at - x.at);
  const lines =
    sorted.length === 0
      ? [
          `No finished shows${about} found (${span}, ${o.timeZone}). That doesn't prove nothing was finished: a show without a finish date on the list only shows up here through the feed. ${INCOMPLETE}`,
        ]
      : [
          `Shows finished${about}, ${span} (${o.timeZone}), newest first:`,
          ...sorted.map((f) => `- ${f.when}: ${f.title}`),
          "Dates are from the activity feed, or the finish date on the list when the feed has none.",
        ];
  const readBack = o.truncated && activities.length > 0;
  if (readBack) {
    const oldest = dayLabel(activities.at(-1)!.createdAt * 1000, o.timeZone);
    lines.push(
      `The feed was read back to ${oldest}: a show finished before that with no finish date on the list, or removed from the list since, isn't included.`,
    );
  }
  const zoned = o.range.start > 0 || readBack || sorted.some((f) => f.fromFeed);
  return `${lines.join("\n")}${zoned ? (o.zoneNote ?? "") : ""}`;
}
