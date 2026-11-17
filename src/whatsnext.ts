/**
 * "What should I watch next?" (requirement R4): unwatched aired episodes, upcoming air
 * times, shows on hold with episodes left, and the next season of finished shows.
 */
import type { ListStatus, Media, RelationEdge, TitleLanguage } from "./anilist";
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
function parts(ms: number, timeZone: string) {
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

/** "Fri, Nov 20 at 2:00 PM (in 3 days)", in the given time zone. */
export function formatAirTime(airingAt: number, now: number, timeZone: string): string {
  const at = parts(airingAt * 1000, timeZone);
  const today = parts(now, timeZone);
  // Whole calendar days between the two local dates.
  const dayNumber = (p: ReturnType<typeof parts>) =>
    Date.UTC(p.year, ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"].indexOf(p.month), p.day);
  const days = Math.round((dayNumber(at) - dayNumber(today)) / 86_400_000);
  const relative = days <= 0 ? "today" : days === 1 ? "tomorrow" : `in ${days} days`;
  return `${at.weekday}, ${at.month} ${at.day} at ${at.time} (${relative})`;
}

/** Throws a readable error for an unknown IANA time zone. */
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
  for (const m of [...finished, ...movies]) {
    for (const e of m.relations?.edges ?? []) {
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
      if (edges.some((series) => sameStory(edge, series))) continue;
      const movie = edges.find((e) => sameStory(e, edge))?.node;
      if (started(edge.node.id) || (movie && started(movie.id))) continue;
      if (out.has(edge.node.id)) continue;
      const planned = listStatus.get(edge.node.id) === "PLANNING";
      out.set(edge.node.id, { after: m, next: edge.node, planned, ...(movie ? { sameStoryAs: movie } : {}) });
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

function behindLine(b: Behind, now: number, timeZone: string, language: TitleLanguage): string {
  const n = b.aired - b.progress;
  const next = upcoming(b.media, now);
  const airing = next ? ` Episode ${next.episode} airs ${formatAirTime(next.airingAt, now, timeZone)}.` : "";
  return `- ${displayTitle(b.media.title, language)}: ${n} episode${n === 1 ? "" : "s"} to watch (on ${b.progress} of ${b.aired} aired).${airing}`;
}

function sequelDetail(s: NextSeason, language: TitleLanguage): string {
  const aired = AIRED_STATUSES.has(s.next.status ?? "");
  const year = s.next.startDate?.year;
  const movie = isMovie(s.next);
  const availability = aired
    ? `${movie ? "movie" : s.next.episodes ? `${s.next.episodes} episodes` : "airing now"}${year ? `, ${year}` : ""}`
    : `${movie ? "movie, " : ""}not out yet${year ? `, expected ${year}` : ""}`;
  const where = s.planned ? "on your plan-to-watch list" : "not on your list";
  const same = s.sameStoryAs ? ` Same story as the movie [${s.sameStoryAs.id}] ${edgeTitle(s.sameStoryAs, language)}; watch either.` : "";
  return `[${s.next.id}] ${edgeTitle(s.next, language)} (${availability}), ${where}.${same}`;
}

function sequelLine(s: NextSeason, language: TitleLanguage): string {
  return `- After ${displayTitle(s.after.title, language)}: ${sequelDetail(s, language)}`;
}

export function formatReport(r: Report, now: number, timeZone: string, language: TitleLanguage): string {
  const title = (m: Media) => displayTitle(m.title, language);
  const sections: string[] = [];
  if (r.newEpisodes.length) {
    sections.push(["New episodes to watch:", ...r.newEpisodes.map((b) => behindLine(b, now, timeZone, language))].join("\n"));
  }
  if (r.waiting.length) {
    sections.push(
      [
        "Caught up, waiting for new episodes:",
        ...r.waiting.map((m) => {
          const next = upcoming(m, now);
          return next
            ? `- ${title(m)}: episode ${next.episode} airs ${formatAirTime(next.airingAt, now, timeZone)}.`
            : `- ${title(m)}: still airing, no date announced for the next episode.`;
        }),
      ].join("\n"),
    );
  }
  if (r.unknown.length) {
    sections.push(
      [
        "Airing, but AniList doesn't say how many episodes are out:",
        ...r.unknown.map((m) => `- ${title(m)}: you're on episode ${m.mediaListEntry!.progress}.`),
      ].join("\n"),
    );
  }
  const readySequels = r.nextSeasons.filter((s) => AIRED_STATUSES.has(s.next.status ?? ""));
  const comingSequels = r.nextSeasons.filter((s) => !AIRED_STATUSES.has(s.next.status ?? ""));
  if (readySequels.length) {
    sections.push(["Next seasons of shows you finished:", ...readySequels.map((s) => sequelLine(s, language))].join("\n"));
  }
  if (r.onHold.length) {
    sections.push(["On hold, with episodes left:", ...r.onHold.map((b) => behindLine(b, now, timeZone, language))].join("\n"));
  }
  if (comingSequels.length) {
    sections.push(["Announced sequels:", ...comingSequels.map((s) => sequelLine(s, language))].join("\n"));
  }
  return sections.length ? sections.join("\n\n") : "Nothing new: you're caught up on everything you're watching.";
}

/** One show: where the user is, what's out, when the next episode airs, and what comes before and after. */
export function formatShow(
  m: Media,
  sequels: NextSeason[],
  listStatus: Map<number, ListStatus>,
  now: number,
  timeZone: string,
  language: TitleLanguage,
): string {
  const entry = m.mediaListEntry;
  const aired = airedEpisodes(m, now);
  const lines = [`${displayTitle(m.title, language)} [${m.id}]`];
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
      `You: ${statusLabel(entry.status)}, watched ${entry.progress}${left && left > 0 ? `, ${left} aired episode${left === 1 ? "" : "s"} to go` : ""}.`,
    );
  } else {
    lines.push("Not on your list.");
  }
  const next = upcoming(m, now);
  if (next) lines.push(`Next: episode ${next.episode} airs ${formatAirTime(next.airingAt, now, timeZone)}.`);
  for (const s of sequels) lines.push(`Comes next: ${sequelDetail(s, language)}`);
  return lines.join("\n");
}
