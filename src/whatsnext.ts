/**
 * "What should I watch next?" (requirement R4): unwatched aired episodes, upcoming air
 * times, shows on hold with episodes left, and the next season of finished shows.
 */
import type { ExternalLink, ListStatus, Media, RelationEdge, TitleLanguage } from "./anilist";
import { displayTitle, statusLabel } from "./logic";
import { AIRED as AIRED_STATUSES, SERIES_FORMATS } from "./resolve";

const WATCHING = new Set<ListStatus>(["CURRENT", "REPEATING"]);

/** Episodes out so far, or null when AniList doesn't know (airing with no schedule). */
export function airedEpisodes(m: Pick<Media, "status" | "episodes" | "nextAiringEpisode">, now: number): number | null {
  const next = m.nextAiringEpisode;
  if (next) {
    // AniList can lag a little behind an episode that just aired.
    return next.airingAt * 1000 <= now ? next.episode : next.episode - 1;
  }
  if (m.status === "FINISHED") return m.episodes;
  return null;
}

/**
 * Progress for "I'm caught up": every aired episode, never lower than where the user is
 * (AniList's schedule can lag). Throws, so nothing is saved, when AniList doesn't know
 * how many episodes are out: the assistant should ask for a number rather than guess.
 */
export function caughtUpProgress(
  m: Pick<Media, "status" | "episodes" | "nextAiringEpisode" | "title">,
  progress: number,
  now: number,
  language: TitleLanguage,
): { episodes: number; note: string } {
  const raw = airedEpisodes(m, now);
  if (raw === null) {
    throw new Error(
      `Nothing was changed. AniList doesn't say how many episodes of ${displayTitle(m.title, language)} are out (no airing schedule or episode count). Ask the user which episode they're on, then call again with that number.`,
    );
  }
  if (raw === 0) throw new Error(`Nothing was changed. ${displayTitle(m.title, language)} hasn't aired any episodes yet.`);
  // The schedule can run past an episode count AniList hasn't updated yet.
  const aired = m.episodes ? Math.min(raw, m.episodes) : raw;
  if (aired < progress) {
    return { episodes: progress, note: ` AniList says only ${aired} episode${aired === 1 ? " has" : "s have"} aired, so progress stays at ${progress}.` };
  }
  const of = m.episodes ? ` of ${m.episodes}` : "";
  return { episodes: aired, note: m.status === "FINISHED" ? " That's every episode." : ` Latest aired episode: ${aired}${of}.` };
}

/** The next episode, if its air time is still ahead (AniList can lag after an episode airs). */
export function upcoming(m: Pick<Media, "nextAiringEpisode">, now: number): Media["nextAiringEpisode"] {
  const next = m.nextAiringEpisode;
  return next && next.airingAt * 1000 > now ? next : null;
}

/** Date and time parts in a zone, assembled by hand so the text doesn't depend on the ICU version. */
export function parts(ms: number, timeZone: string) {
  const fields = new Intl.DateTimeFormat("en-US", {
    timeZone,
    weekday: "short",
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  }).formatToParts(ms);
  const get = (type: Intl.DateTimeFormatPartTypes) => fields.find((f) => f.type === type)?.value ?? "";
  return {
    weekday: get("weekday"),
    month: get("month"),
    day: Number(get("day")),
    year: Number(get("year")),
    time: `${get("hour")}:${get("minute")} ${get("dayPeriod")}`,
  };
}

/**
 * "Fri, Nov 20 at 2:00 PM (in 3 days)", in the given time zone. A fixed offset follows no
 * daylight-saving rules, so the time names it: "at 2:00 PM UTC-05:00"; so does UTC itself.
 */
export function formatAirTime(airingAt: number, now: number, timeZone: string): string {
  const at = parts(airingAt * 1000, timeZone);
  const today = parts(now, timeZone);
  // Whole calendar days between the two local dates.
  const dayNumber = (p: ReturnType<typeof parts>) =>
    Date.UTC(p.year, ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"].indexOf(p.month), p.day);
  const days = Math.round((dayNumber(at) - dayNumber(today)) / 86_400_000);
  const relative = days <= 0 ? "today" : days === 1 ? "tomorrow" : `in ${days} days`;
  // UTC is named too: it's what the hosted server falls back to when the user's zone is unknown.
  const offset = /^[+-]/.test(timeZone) ? ` UTC${timeZone}` : timeZone === "UTC" ? " UTC" : "";
  return `${at.weekday}, ${at.month} ${at.day} at ${at.time}${offset} (${relative})`;
}

/** Throws a readable error for an unknown time zone (IANA name or offset like "-05:00"). */
export function checkTimeZone(timeZone: string): string {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone });
    return timeZone;
  } catch {
    throw new Error(`Unknown time zone "${timeZone}". Use an IANA name like "America/New_York".`);
  }
}

function edgeTitle(node: RelationEdge["node"], language: TitleLanguage): string {
  return node.title ? displayTitle(node.title, language) : `AniList ${node.id}`;
}

export interface NextSeason {
  after: Media;
  next: RelationEdge["node"];
  planned: boolean;
  /** A movie that tells the same story as `next` (AniList calls them ALTERNATIVE versions). */
  sameStoryAs?: RelationEdge["node"];
  sameStoryPlanned?: boolean;
}

const isMovie = (node: RelationEdge["node"]) => node.format === "MOVIE";

/** SEQUEL edges to series and movies that aren't cancelled. Recaps, specials and OVAs don't count. */
function sequelEdges(m: Media): RelationEdge[] {
  return (m.relations?.edges ?? []).filter(
    (e) =>
      e.relationType === "SEQUEL" &&
      e.node.type === "ANIME" &&
      e.node.status !== "CANCELLED" &&
      (SERIES_FORMATS.has(e.node.format ?? "") || isMovie(e.node)),
  );
}

/**
 * Movie sequels that sit beside a series sequel of the same show, and aren't in `finished`.
 * Their relations (fetch them with getMany) say whether the movie retells the series.
 */
export function moviesBesideSeries(finished: Media[]): number[] {
  const known = new Set(finished.map((m) => m.id));
  const ids = new Set<number>();
  for (const m of finished) {
    const edges = sequelEdges(m);
    if (!edges.some((e) => !isMovie(e.node))) continue;
    for (const e of edges) if (isMovie(e.node) && !known.has(e.node.id)) ids.add(e.node.id);
  }
  return [...ids];
}

/**
 * Sequels (series or movie) of finished shows that the user hasn't started. `finished` must
 * carry relations; `listStatus` maps every media ID on the list to its status; `movies` are
 * the moviesBesideSeries, with relations.
 *
 * A movie that retells a series sequel (Demon Slayer's Mugen Train) is one step, not two:
 * the series is listed and names the movie, and watching either one counts for both.
 */
export function nextSeasons(finished: Media[], listStatus: Map<number, ListStatus>, movies: Media[] = []): NextSeason[] {
  const versions = new Map<number, Set<number>>();
  // Recap movies can be each other's SEQUEL (Bocchi the Rock! Re: and Re:Re:); the show they recap lists them as SUMMARY.
  const recaps = new Set<number>();
  for (const m of [...finished, ...movies]) {
    for (const e of m.relations?.edges ?? []) {
      if (e.relationType === "SUMMARY") recaps.add(e.node.id);
      if (e.relationType !== "ALTERNATIVE") continue;
      for (const [a, b] of [[m.id, e.node.id], [e.node.id, m.id]] as const) {
        versions.set(a, (versions.get(a) ?? new Set()).add(b));
      }
    }
  }
  const started = (id: number) => {
    const status = listStatus.get(id);
    return status !== undefined && status !== "PLANNING";
  };
  const out = new Map<number, NextSeason>();
  for (const m of finished) {
    const edges = sequelEdges(m);
    const sameStory = (movie: RelationEdge, series: RelationEdge) =>
      isMovie(movie.node) && !isMovie(series.node) && Boolean(versions.get(movie.node.id)?.has(series.node.id));
    for (const edge of edges) {
      if (recaps.has(edge.node.id) || edges.some((series) => sameStory(edge, series))) continue;
      const movie = edges.find((e) => sameStory(e, edge))?.node;
      // Any version the user has started (as AniList links them) counts.
      if (started(edge.node.id) || [...(versions.get(edge.node.id) ?? [])].some(started)) continue;
      if (out.has(edge.node.id)) continue;
      const planned = (id: number) => listStatus.get(id) === "PLANNING";
      out.set(edge.node.id, {
        after: m,
        next: edge.node,
        planned: planned(edge.node.id),
        ...(movie ? { sameStoryAs: movie, sameStoryPlanned: planned(movie.id) } : {}),
      });
    }
  }
  return [...out.values()];
}

interface Behind {
  media: Media;
  progress: number;
  aired: number;
}

export interface Report {
  newEpisodes: Behind[];
  /** Watching and caught up on something still airing (with or without a scheduled next episode). */
  waiting: Media[];
  /** Watching something airing where AniList doesn't say how many episodes are out. */
  unknown: Media[];
  onHold: Behind[];
  nextSeasons: NextSeason[];
}

export function buildReport(list: Media[], sequels: NextSeason[], now: number): Report {
  const newEpisodes: Behind[] = [];
  const waiting: Media[] = [];
  const unknown: Media[] = [];
  const onHold: Behind[] = [];
  for (const m of list) {
    const entry = m.mediaListEntry;
    if (!entry) continue;
    const aired = airedEpisodes(m, now);
    const behind = aired !== null && aired > entry.progress;
    if (WATCHING.has(entry.status)) {
      if (behind) newEpisodes.push({ media: m, progress: entry.progress, aired: aired! });
      // No schedule means no aired count: that's not the same as being caught up.
      else if (aired === null) {
        if (m.status === "RELEASING" || m.status === "HIATUS") unknown.push(m);
      } else if (upcoming(m, now) || m.status === "RELEASING" || m.status === "HIATUS") waiting.push(m);
    } else if (entry.status === "PAUSED" && behind) {
      onHold.push({ media: m, progress: entry.progress, aired: aired! });
    }
  }
  // Shows still airing first (they keep piling up), then fewest episodes to go.
  const byUrgency = (a: Behind, b: Behind) =>
    Number(!a.media.nextAiringEpisode) - Number(!b.media.nextAiringEpisode) ||
    a.aired - a.progress - (b.aired - b.progress);
  newEpisodes.sort(byUrgency);
  onHold.sort(byUrgency);
  const airsAt = (m: Media) => upcoming(m, now)?.airingAt ?? Number.POSITIVE_INFINITY;
  waiting.sort((a, b) => airsAt(a) - airsAt(b));
  return { newEpisodes, waiting, unknown, onHold, nextSeasons: sequels };
}

/**
 * ", about 2 hours" for `episodes` episodes of `duration` minutes each, or "" when the
 * duration is unknown. Minutes (to the nearest 5) under an hour, then hours to the
 * nearest half, and whole hours from 10 up.
 */
export function watchTime(episodes: number, duration: number | null): string {
  if (!duration || episodes <= 0) return "";
  const minutes = episodes * duration;
  if (minutes < 5) return ", a few minutes";
  const roundedMinutes = Math.round(minutes / 5) * 5;
  if (roundedMinutes < 60) return `, about ${roundedMinutes} minutes`;
  const half = Math.round(minutes / 30) / 2;
  const hours = half >= 10 ? Math.round(minutes / 60) : half;
  return `, about ${hours} hour${hours === 1 ? "" : "s"}`;
}

/** Formats an air time, and notes that one was printed. */
type AirTime = (airingAt: number) => string;

function behindLine(b: Behind, now: number, airTime: AirTime, language: TitleLanguage): string {
  const n = b.aired - b.progress;
  const next = upcoming(b.media, now);
  const airing = next ? ` Episode ${next.episode} airs ${airTime(next.airingAt)}.` : "";
  const time = watchTime(n, b.media.duration);
  return `- ${displayTitle(b.media.title, language)}: ${n} episode${n === 1 ? "" : "s"} to watch${time} (on ${b.progress} of ${b.aired} aired).${airing}`;
}

function sequelDetail(s: NextSeason, language: TitleLanguage): string {
  const aired = AIRED_STATUSES.has(s.next.status ?? "");
  const year = s.next.startDate?.year;
  const movie = isMovie(s.next);
  const availability = aired
    ? `${movie ? "movie" : s.next.episodes ? `${s.next.episodes} episodes` : "airing now"}${year ? `, ${year}` : ""}`
    : `${movie ? "movie, " : ""}not out yet${year ? `, expected ${year}` : ""}`;
  const where = s.planned ? "on your plan-to-watch list" : "not on your list";
  const same = s.sameStoryAs ? ` Same story as the movie [${s.sameStoryAs.id}] ${edgeTitle(s.sameStoryAs, language)}${s.sameStoryPlanned ? " (on your plan-to-watch list)" : ""}; watch either.` : "";
  return `[${s.next.id}] ${edgeTitle(s.next, language)} (${availability}), ${where}.${same}`;
}

function sequelLine(s: NextSeason, language: TitleLanguage): string {
  return `- After ${displayTitle(s.after.title, language)}: ${sequelDetail(s, language)}`;
}

/**
 * How many shows each section of the whole-list report lists before it's cut short, so a
 * long list still reads at a glance; `all` lists everything. Unknown shows are in list order.
 */
export const SECTION_LIMITS = {
  newEpisodes: 8,
  waiting: 5,
  unknown: 3,
  readySequels: 3,
  onHold: 3,
  comingSequels: 3,
} as const;

/** Episodes behind on an airing show that count as "just aired": about three weeks of a weekly show. */
const JUST_AIRED = 3;

/**
 * Which episode-list shows a cut keeps: what just aired first, then the shows closest to
 * done, so a long backlog ("134 episodes to watch", airing or not) is what drops out.
 */
const keepFirst = (a: Behind, b: Behind) => {
  const left = (x: Behind) => x.aired - x.progress;
  const justAired = (x: Behind) => Boolean(x.media.nextAiringEpisode) && left(x) <= JUST_AIRED;
  return (
    Number(justAired(b)) - Number(justAired(a)) ||
    left(a) - left(b) ||
    Number(!a.media.nextAiringEpisode) - Number(!b.media.nextAiringEpisode)
  );
};

interface Section {
  heading: string;
  lines: string[];
  /** How many more the section has than it shows. */
  more: number;
}

/**
 * One section, cut to `limit` unless `all`. With `keep`, the cut keeps the items `keep`
 * ranks first but lists them in their report order, so a list that fits reads the same.
 */
function section<T>(heading: string, items: T[], limit: number | null, line: (item: T) => string, keep?: (a: T, b: T) => number): Section {
  let shown = items;
  if (limit !== null && items.length > limit) {
    const kept = new Set(keep ? [...items].sort(keep).slice(0, limit) : items.slice(0, limit));
    shown = items.filter((x) => kept.has(x));
  }
  return { heading, lines: shown.map(line), more: items.length - shown.length };
}

export interface ReportOptions {
  /** List every show instead of cutting long sections. */
  all?: boolean;
  /** Added at the end when the report prints an air time (a note about the time zone). */
  zoneNote?: string;
}

/**
 * The whole-list report. Long sections are cut to SECTION_LIMITS and say how many more
 * they have, with one line at the end saying how to see them all.
 */
export function formatReport(r: Report, now: number, timeZone: string, language: TitleLanguage, options: ReportOptions = {}): string {
  let timed = false;
  const airTime: AirTime = (airingAt) => {
    timed = true;
    return formatAirTime(airingAt, now, timeZone);
  };
  const limit = (n: number) => (options.all ? null : n);
  const title = (m: Media) => displayTitle(m.title, language);
  const behind = (b: Behind) => behindLine(b, now, airTime, language);
  const sequel = (s: NextSeason) => sequelLine(s, language);
  const aired = (s: NextSeason) => AIRED_STATUSES.has(s.next.status ?? "");
  const sections = [
    section("New episodes to watch:", r.newEpisodes, limit(SECTION_LIMITS.newEpisodes), behind, keepFirst),
    section("Caught up, waiting for new episodes:", r.waiting, limit(SECTION_LIMITS.waiting), (m) => {
      const next = upcoming(m, now);
      return next
        ? `- ${title(m)}: episode ${next.episode} airs ${airTime(next.airingAt)}.`
        : `- ${title(m)}: still airing, no date announced for the next episode.`;
    }),
    section(
      "Airing, but AniList doesn't say how many episodes are out:",
      r.unknown,
      limit(SECTION_LIMITS.unknown),
      (m) => `- ${title(m)}: you're on episode ${m.mediaListEntry!.progress}.`,
    ),
    section("Next seasons of shows you finished:", r.nextSeasons.filter(aired), limit(SECTION_LIMITS.readySequels), sequel),
    section("On hold, with episodes left:", r.onHold, limit(SECTION_LIMITS.onHold), behind, keepFirst),
    section("Announced sequels:", r.nextSeasons.filter((s) => !aired(s)), limit(SECTION_LIMITS.comingSequels), sequel),
  ].filter((x) => x.lines.length > 0);
  if (!sections.length) return "Nothing new: you're caught up on everything you're watching.";
  const blocks = sections.map((x) => [x.heading, ...x.lines, ...(x.more ? [`...and ${x.more} more.`] : [])].join("\n"));
  const cut = sections.some((x) => x.more > 0) ? "\n\nLong sections are cut short: to list every show, call again with all: true." : "";
  return `${blocks.join("\n\n")}${cut}${timed ? (options.zoneNote ?? "") : ""}`;
}

/** One show: where the user is, what's out, when the next episode airs, and what comes before and after. */
export function formatShow(
  m: Media,
  sequels: NextSeason[],
  listStatus: Map<number, ListStatus>,
  now: number,
  timeZone: string,
  language: TitleLanguage,
  /** The user's 18+ setting, for which tags to show. */
  adultContent = false,
): string {
  const entry = m.mediaListEntry;
  const aired = airedEpisodes(m, now);
  const lines = [`${displayTitle(m.title, language)} [${m.id}]`, ...aboutLines(m, adultContent)];
  for (const edge of m.relations?.edges ?? []) {
    const status = listStatus.get(edge.node.id);
    if (edge.relationType === "PREQUEL" && status && SERIES_FORMATS.has(edge.node.format ?? "")) {
      lines.push(`Comes after: [${edge.node.id}] ${edgeTitle(edge.node, language)}, ${statusLabel(status).toLowerCase()} on your list.`);
    }
  }
  const total = m.episodes ? ` of ${m.episodes}` : "";
  if (aired !== null) lines.push(`Aired: ${aired}${total} episodes${m.status === "FINISHED" ? " (finished airing)" : ""}.`);
  else if (m.status === "NOT_YET_RELEASED") lines.push("Not out yet.");
  if (entry) {
    const left = aired !== null ? aired - entry.progress : null;
    lines.push(
      `You: ${statusLabel(entry.status)}, watched ${entry.progress}${left && left > 0 ? `, ${left} aired episode${left === 1 ? "" : "s"} to go${watchTime(left, m.duration)}` : ""}.`,
    );
  } else {
    lines.push("Not on your list.");
  }
  const next = upcoming(m, now);
  if (next) lines.push(`Next: episode ${next.episode} airs ${formatAirTime(next.airingAt, now, timeZone)}.`);
  for (const s of sequels) lines.push(`Comes next: ${sequelDetail(s, language)}`);
  lines.push(...streamingLines(m.externalLinks ?? []));
  return lines.join("\n");
}

/**
 * Where to stream a show, from AniList's streaming links. Nothing when there are none:
 * AniList's data is incomplete, so no links doesn't mean it isn't streaming anywhere.
 */
export function streamingLines(links: ExternalLink[]): string[] {
  const seen = new Set<string>();
  const lines: string[] = [];
  for (const l of links) {
    if (l.type !== "STREAMING" || l.isDisabled || !l.url || seen.has(l.url)) continue;
    seen.add(l.url);
    lines.push(`- ${l.site}${l.notes ? ` (${l.notes})` : ""}: ${l.url}`);
  }
  return lines.length ? ["Stream on (availability varies by region):", ...lines] : [];
}

/** The longest synopsis shown, in characters: most of AniList's fit (the median is about 480). */
export const SYNOPSIS_LENGTH = 600;

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", hellip: "…", mdash: "—", ndash: "–", rsquo: "’", lsquo: "‘", rdquo: "”", ldquo: "“" };

/**
 * AniList's description as plain text, without spoilers, cut to about `max` characters at the
 * end of a sentence. AniList stores HTML (`<br>`, `<i>`) with markdown of its own: spoilers
 * as `~!...!~`, centering, links, images. Credits such as "(Source: Crunchyroll)" and notes
 * about the adaptation aren't the story, so they go too.
 */
export function plainSynopsis(raw: string | null | undefined, max = SYNOPSIS_LENGTH): string {
  if (!raw) return "";
  const text = raw
    // A spoiler left open runs to the end, so it's dropped whole.
    .replace(/~!([\s\S]*?)(!~|$)/g, "")
    .replace(/<span class=["']markdown_spoiler["']>[\s\S]*?<\/span><\/span>/gi, "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/?(p|div|h\d)\b[^>]*>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/\b(img|youtube|webm)\d*%?\([^)]*\)/gi, "")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/~~~|__|\*\*|~~/g, "")
    .replace(/^[ \t]*#+[ \t]*/gm, "")
    // _italic_ and *italic*, only around words, so "5 * 3" or snake_case stay.
    .replace(/(^|[\s("“])[_*](?=\S)([^_*\n]*?\S)[_*](?=[\s.,;:!?)"”]|$)/g, "$1$2")
    .replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, code: string) => {
      if (code[0] !== "#") return ENTITIES[code.toLowerCase()] ?? whole;
      const n = code[1] === "x" || code[1] === "X" ? parseInt(code.slice(2), 16) : Number(code.slice(1));
      return Number.isFinite(n) && n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : whole;
    })
    .replace(/\(\s*(?:sources?\s*:|written by\b)[^)]*\)|\[\s*(?:sources?\s*:|written by\b)[^\]]*\]/gi, "");
  const paragraphs = text
    .split(/\n/)
    .map((p) => p.replace(/\s+/g, " ").trim())
    .filter(Boolean);
  // Notes about the adaptation ("Note: Episodes 11 and 12 ...") come after the story and can
  // run over several lines ("Notes:" then a line per bullet), so everything from one on goes.
  const notes = paragraphs.findIndex((p) => /^(notes?|sources?)\s*:/i.test(p));
  const story = (notes < 0 ? paragraphs : paragraphs.slice(0, notes)).join(" ");
  if (story.length <= max) return story;
  const cut = story.slice(0, max + 1);
  // The last sentence that ends within the limit, if that keeps at least half of it. "Mr." and "J." don't end one.
  const ends = [...cut.matchAll(/(\S*?)([.!?…]["”’)]?)(?=\s)/g)]
    .filter((e) => !(e[2]!.startsWith(".") && (ABBREVIATIONS.has(e[1]!.toLowerCase()) || /^[A-Z]$/.test(e[1]!))))
    .map((e) => e.index! + e[0].length);
  const end = Math.max(...ends);
  if (end >= max / 2) return story.slice(0, end);
  const space = cut.lastIndexOf(" ");
  return `${cut.slice(0, space > 0 ? space : max).replace(/[\s,;:]+$/, "")}…`;
}

/** Words ending in "." that don't end a sentence. */
const ABBREVIATIONS = new Set(["mr", "mrs", "ms", "dr", "st", "jr", "sr", "prof", "vs", "lt", "sgt", "capt", "gen", "col", "no", "vol", "ep", "etc", "e.g", "i.e"]);

/** AniList's sources (version 3 of its list) as a phrase; OTHER and unknown ones say nothing. */
const SOURCES: Record<string, string> = {
  ORIGINAL: "original story",
  MANGA: "based on a manga",
  LIGHT_NOVEL: "based on a light novel",
  WEB_NOVEL: "based on a web novel",
  NOVEL: "based on a novel",
  VISUAL_NOVEL: "based on a visual novel",
  VIDEO_GAME: "based on a video game",
  GAME: "based on a game",
  DOUJINSHI: "based on a doujinshi",
  COMIC: "based on a comic",
  PICTURE_BOOK: "based on a picture book",
  ANIME: "based on an anime",
  LIVE_ACTION: "based on a live-action work",
  MULTIMEDIA_PROJECT: "part of a multimedia project",
};

/** "A", "A and B", "A, B and C". */
function andList(items: string[]): string {
  return items.length < 2 ? (items[0] ?? "") : `${items.slice(0, -1).join(", ")} and ${items.at(-1)}`;
}

/** Tags shown for a show: the few that best describe it, leaving out spoilers. */
const TAGS_SHOWN = 5;

/**
 * What the show is: format, season, studio, source and genres, its top tags, and the synopsis.
 * Nothing for a show fetched without the one-show fields. Adult tags only with `adultContent`
 * (the user's 18+ setting), as on AniList.
 */
export function aboutLines(m: Media, adultContent = false): string[] {
  const lines: string[] = [];
  const season = m.season ? `${m.season[0]}${m.season.slice(1).toLowerCase()} ${m.seasonYear ?? ""}`.trim() : m.seasonYear;
  const studios = (m.studios?.nodes ?? []).map((s) => s.name);
  const facts = [
    m.format?.replace(/_/g, " "),
    season,
    studios.length ? `by ${andList(studios)}` : "",
    SOURCES[m.source ?? ""] ?? "",
  ].filter(Boolean);
  const genres = m.genres?.length ? `Genres: ${m.genres.join(", ")}.` : "";
  // Only when one-show fields came back: the list's own copy of a show has none of these.
  if (m.description !== undefined || m.genres !== undefined) {
    const line = [facts.length ? `${facts.join(", ")}.` : "", genres].filter(Boolean).join(" ");
    if (line) lines.push(line);
  }
  const tags = (m.tags ?? [])
    .filter((t) => !t.isMediaSpoiler && !t.isGeneralSpoiler && (adultContent || !t.isAdult))
    .sort((a, b) => (b.rank ?? 0) - (a.rank ?? 0))
    .slice(0, TAGS_SHOWN)
    .map((t) => t.name);
  if (tags.length) lines.push(`Tags: ${tags.join(", ")}.`);
  const synopsis = plainSynopsis(m.description);
  if (synopsis) lines.push(`About: ${synopsis}`);
  return lines;
}
