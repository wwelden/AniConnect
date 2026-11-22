/**
 * search_anime's wider modes: tag names checked against AniList's tag list, the airing
 * calendar ("what airs today?"), and AniList users' recommendations for a show (similarTo).
 */
import type { Airing, Media, Recommendation, TagName, Viewer } from "./anilist";
import { dayOf, shift, startOf, type Day } from "./history";
import { describeEntry } from "./logic";
import { parts } from "./whatsnext";

function distance(a: string, b: string): number {
  const prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let diag = prev[0]!;
    prev[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const tmp = prev[j]!;
      prev[j] = Math.min(prev[j]! + 1, prev[j - 1]! + 1, diag + (a[i - 1] === b[j - 1] ? 0 : 1));
      diag = tmp;
    }
  }
  return prev[b.length]!;
}

/** Splits names given as tags or exclusions into genres (AniList's spelling) and the rest. */
export function splitGenres(names: string[] | undefined, genres: readonly string[]): { genres: string[]; tags: string[] } {
  const out = { genres: [] as string[], tags: [] as string[] };
  for (const name of names ?? []) {
    const genre = genres.find((g) => g.toLowerCase() === name.trim().toLowerCase());
    if (genre) out.genres.push(genre);
    else out.tags.push(name.trim());
  }
  return out;
}

/**
 * The tags in AniList's spelling, or an error naming the closest tags for any it doesn't
 * have ("Time Travel" isn't a tag; Time Loop, Time Manipulation and Time Skip are).
 * Adult tags are only suggested when the user's 18+ setting is on.
 */
export function checkTags(names: string[], known: TagName[], showAdult: boolean): string[] {
  const byName = new Map(known.map((t) => [t.name.toLowerCase(), t.name]));
  const unknown = names.filter((n) => !byName.has(n.toLowerCase()));
  if (unknown.length) {
    const lines = unknown.map((name) => {
      const want = name.toLowerCase();
      const words = want.split(/[\s-]+/).filter((w) => w.length > 2);
      const close = known
        .filter((t) => showAdult || !t.isAdult)
        .map((t) => {
          const tag = t.name.toLowerCase();
          const shared = words.filter((w) => tag.split(/[\s-]+/).some((tw) => tw.startsWith(w))).length;
          return { name: t.name, shared, d: distance(want, tag) };
        })
        .filter((c) => c.shared > 0 || c.d <= Math.max(2, Math.floor(want.length / 3)))
        .sort((a, b) => b.shared - a.shared || a.d - b.d || a.name.localeCompare(b.name))
        .slice(0, 5);
      return `No AniList tag "${name}". ${close.length ? `Closest: ${close.map((c) => c.name).join(", ")}.` : "Check the spelling."}`;
    });
    throw new Error(`${lines.join(" ")} Call again with tags AniList has.`);
  }
  return names.map((n) => byName.get(n.toLowerCase())!);
}

/** "2020-2024", "2024", "2020 or later", "up to 2024", or "" for no range; refuses one that runs backwards. */
export function yearRange(from: number | undefined, to: number | undefined): string {
  if (from && to && from > to) throw new Error(`\`yearFrom\` ${from} is after \`yearTo\` ${to}: swap them.`);
  if (from && to) return from === to ? String(from) : `${from}-${to}`;
  return from ? `${from} or later` : to ? `up to ${to}` : "";
}

export type AiringWhen = "today" | "tomorrow" | "week" | number;

/** "Tue, Nov 17": a calendar day, the same wherever it's read. */
function dayLabel(d: Day): string {
  const p = parts(Date.UTC(d.year, d.month - 1, d.day, 12), "UTC");
  return `${p.weekday}, ${p.month} ${p.day}`;
}

/** The calendar days `when` covers in a zone, as Unix seconds (end exclusive), and how to name them. */
export function airingRange(when: AiringWhen, now: number, zone: string): { from: number; to: number; label: string; days: number } {
  const today = dayOf(now, zone);
  const first = when === "tomorrow" ? shift(today, { days: 1 }) : today;
  const count = when === "week" ? 7 : typeof when === "number" ? when : 1;
  const last = shift(first, { days: count - 1 });
  const label =
    count > 1 ? `in the next ${count} days (${dayLabel(first)} to ${dayLabel(last)})` : `${when === "tomorrow" ? "tomorrow" : "today"} (${dayLabel(first)})`;
  return {
    from: Math.floor(startOf(first, zone) / 1000),
    to: Math.floor(startOf(shift(first, { days: count }), zone) / 1000),
    label,
    days: count,
  };
}

/** How a zone reads in a header: offsets name UTC ("UTC-05:00"), as whats_next's air times do. */
export function zoneLabel(zone: string): string {
  return /^[+-]/.test(zone) ? `UTC${zone}` : zone;
}

/**
 * The calendar, one heading per local day, episodes in air-time order. A day with more than
 * `limit` episodes keeps the most popular ones and every show on the user's list.
 */
export function formatAiring(
  airings: Airing[],
  options: { zone: string; limit: number; maxLimit: number; viewer: Viewer },
): string[] {
  const days = new Map<string, { label: string; airings: Airing[] }>();
  for (const a of airings) {
    const day = dayOf(a.airingAt * 1000, options.zone);
    const key = `${day.year}-${day.month}-${day.day}`;
    if (!days.has(key)) days.set(key, { label: dayLabel(day), airings: [] });
    days.get(key)!.airings.push(a);
  }
  const lines: string[] = [];
  for (const { label, airings: today } of days.values()) {
    const popular = new Set([...today].sort((a, b) => (b.media.popularity ?? 0) - (a.media.popularity ?? 0)).slice(0, options.limit));
    const shown = today.filter((a) => popular.has(a) || (a.media.mediaListEntry && a.media.mediaListEntry.status !== "DROPPED"));
    lines.push(`${label}:`);
    for (const a of shown) {
      lines.push(`- ${parts(a.airingAt * 1000, options.zone).time}, episode ${a.episode}: ${describeEntry(a.media, a.media.mediaListEntry, options.viewer)}`);
    }
    const more = today.length - shown.length;
    if (more) {
      const hint = options.limit < options.maxLimit ? `: pass limit (up to ${options.maxLimit}) to see them` : "";
      lines.push(`- ${more} more, less popular${hint}`);
    }
  }
  return lines;
}

type Recommended = NonNullable<Recommendation["mediaRecommendation"]>;

/** Relations that make two shows parts of one franchise: one continues the other, or both adapt the same work. */
const SEASON_LINKS = new Set(["SEQUEL", "PREQUEL"]);
const SOURCE_LINKS = new Set(["ADAPTATION", "SOURCE"]);

function sourceIds(m: Pick<Media, "relations">): number[] {
  return (m.relations?.edges ?? []).filter((e) => SOURCE_LINKS.has(e.relationType) && e.node.type !== "ANIME").map((e) => e.node.id);
}

/** Whether a show links to one of `ids` by anything but a crossover (CHARACTER, OTHER): a season, spin-off or shared source. */
function linksInto(m: Pick<Media, "relations">, ids: Set<number>): boolean {
  return (m.relations?.edges ?? []).some((e) => e.relationType !== "CHARACTER" && e.relationType !== "OTHER" && ids.has(e.node.id));
}

function startNum(m: Media): number {
  const d = m.startDate;
  return d?.year ? d.year * 10000 + (d.month ?? 0) * 100 + (d.day ?? 0) : Number.POSITIVE_INFINITY;
}

export interface PickedRecommendations {
  shown: { media: Recommended; rating: number; others: number }[];
  /** Shows recommended, before any were left out. */
  total: number;
  seen: number;
  sameFranchise: number;
  /** Left out by the call's filters. */
  filtered: number;
}

/**
 * What to list from a show's recommendations: none with no net votes, no lost (null) or adult shows (unless 18+ is
 * on), none the user completed, is rewatching or dropped, none of the show's own franchise
 * (its relations and anything linked to them, such as a sequel of a related show or another adaptation of its source),
 * only ones `matches` keeps; then
 * several seasons of one recommended franchise fold into the earliest, most voted first.
 */
export function pickRecommendations(
  source: { id: number; relatedIds: number[] },
  recommendations: Recommendation[],
  showAdult: boolean,
  matches: (m: Recommended) => boolean,
): PickedRecommendations {
  const valid = recommendations.filter(
    (r): r is Recommendation & { mediaRecommendation: Recommended } =>
      // Net-downvoted or unvoted ones aren't recommendations anyone stands behind.
      (r.rating ?? 0) > 0 &&
      Boolean(r.mediaRecommendation) &&
      (r.mediaRecommendation!.type ?? "ANIME") === "ANIME" &&
      (showAdult || !r.mediaRecommendation!.isAdult),
  );
  const related = new Set(source.relatedIds);
  const result: PickedRecommendations = { shown: [], total: valid.length, seen: 0, sameFranchise: 0, filtered: 0 };
  const kept: { media: Recommended; rating: number }[] = [];
  for (const r of valid) {
    const m = r.mediaRecommendation;
    const status = m.mediaListEntry?.status;
    if (m.id === source.id || related.has(m.id) || linksInto(m, related)) result.sameFranchise++;
    else if (status === "COMPLETED" || status === "REPEATING" || status === "DROPPED") result.seen++;
    else if (!matches(m)) result.filtered++;
    else kept.push({ media: m, rating: r.rating ?? 0 });
  }
  // Group the kept shows that continue one another or adapt the same work.
  const group = new Map<number, number>(kept.map((k) => [k.media.id, k.media.id]));
  const root = (id: number): number => (group.get(id) === id ? id : root(group.get(id)!));
  const join = (a: number, b: number) => group.set(root(a), root(b));
  const bySource = new Map<number, Recommended>();
  // A remake (FMA and Brotherhood, linked as ALTERNATIVE) adapts the same source but is its own show.
  const remake = (a: Recommended, b: Recommended) =>
    [[a, b], [b, a]].some(([x, y]) => (x!.relations?.edges ?? []).some((e) => e.relationType === "ALTERNATIVE" && e.node.id === y!.id));
  for (const { media } of kept) {
    for (const e of media.relations?.edges ?? []) if (SEASON_LINKS.has(e.relationType) && group.has(e.node.id)) join(media.id, e.node.id);
    for (const id of sourceIds(media)) {
      const other = bySource.get(id);
      if (!other) bySource.set(id, media);
      else if (!remake(media, other)) join(media.id, other.id);
    }
  }
  const groups = new Map<number, { media: Recommended; rating: number }[]>();
  for (const k of kept) {
    const g = root(k.media.id);
    if (!groups.has(g)) groups.set(g, []);
    groups.get(g)!.push(k);
  }
  result.shown = [...groups.values()]
    .map((g) => ({
      media: [...g].sort((a, b) => startNum(a.media) - startNum(b.media))[0]!.media,
      rating: Math.max(...g.map((k) => k.rating)),
      others: g.length - 1,
    }))
    .sort((a, b) => b.rating - a.rating);
  return result;
}

/** "1 you completed or dropped, 2 of the same franchise, 3 not MOVIE": what a recommendation list left out. */
export function leftOut(picked: PickedRecommendations, filter: string): string {
  return [
    picked.seen && `${picked.seen} you completed or dropped`,
    picked.sameFranchise && `${picked.sameFranchise} of the same franchise`,
    picked.filtered && `${picked.filtered} not ${filter}`,
  ]
    .filter(Boolean)
    .join(", ");
}
