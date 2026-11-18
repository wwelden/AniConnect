/**
 * "What did I watch this week?" (requirement R0.14): the user's own list activity from
 * AniList's activity feed, for a time range in plain words, in the user's time zone.
 */
import type { ListActivity, TitleLanguage } from "./anilist";
import { displayTitle } from "./logic";
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

export interface HistoryOptions {
  range: Range;
  now: number;
  timeZone: string;
  /** The show the history was filtered to, if any. */
  show?: string;
  /** More activity exists in the range than was fetched. */
  truncated: boolean;
  language: TitleLanguage;
}

const INCOMPLETE =
  "AniList's activity feed can be incomplete: users can turn off activity for some list statuses, and old activity can be deleted.";

/** Activity newest first, grouped by day in the user's time zone. */
export function formatHistory(activities: ListActivity[], o: HistoryOptions): string {
  const first = dayLabel(o.range.start, o.timeZone);
  const last = dayLabel(Math.min(o.range.end, o.now) - 1, o.timeZone);
  const span = o.range.start <= 0 ? "all time" : first === last ? first : `${first} to ${last}`;
  const about = o.show ? ` for ${o.show}` : "";
  if (activities.length === 0) {
    return `No list activity${about} found (${span}, ${o.timeZone}). That doesn't prove nothing was watched: ${INCOMPLETE}`;
  }
  const lines = [`List activity${about}, ${span} (${o.timeZone}), newest first:`];
  let currentDay = "";
  for (const a of activities) {
    const ms = a.createdAt * 1000;
    const day = dayLabel(ms, o.timeZone, parts(ms, o.timeZone).year !== parts(o.now, o.timeZone).year);
    if (day !== currentDay) {
      lines.push(day);
      currentDay = day;
    }
    const title = a.media ? displayTitle(a.media.title, o.language) : "(deleted show)";
    lines.push(`- ${parts(ms, o.timeZone).time} ${title}: ${describeActivity(a)}`);
  }
  if (o.truncated) {
    lines.push(`Showing the ${activities.length} most recent updates; ask about a shorter range to see earlier ones.`);
  }
  lines.push(`Episodes logged in one sitting show as one range. ${INCOMPLETE}`);
  return lines.join("\n");
}
