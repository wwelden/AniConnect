/**
 * "What should I watch next?" (requirement R4): unwatched aired episodes, upcoming air
 * times, shows on hold with episodes left, and the next season of finished shows.
 */
import type { ListStatus, Media, RelationEdge } from "./anilist";
import { displayTitle, statusLabel } from "./logic";

const SERIES_FORMATS = new Set(["TV", "TV_SHORT", "ONA"]);
const AIRED_STATUSES = new Set(["RELEASING", "FINISHED", "HIATUS"]);
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

function localDay(ms: number, timeZone: string): string {
  // en-CA formats as YYYY-MM-DD.
  return new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(ms);
}

/** "Fri, Nov 20, 9:00 AM (in 3 days)". */
export function formatAirTime(airingAt: number, now: number, timeZone: string): string {
  const ms = airingAt * 1000;
  const when = new Intl.DateTimeFormat("en-US", {
    timeZone,
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(ms);
  const days = Math.round((Date.parse(localDay(ms, timeZone)) - Date.parse(localDay(now, timeZone))) / 86_400_000);
  const relative = days <= 0 ? "today" : days === 1 ? "tomorrow" : `in ${days} days`;
  return `${when} (${relative})`;
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

function edgeTitle(node: RelationEdge["node"]): string {
  return node.title ? displayTitle(node.title) : `AniList ${node.id}`;
}

export interface NextSeason {
  after: Media;
  next: RelationEdge["node"];
  planned: boolean;
}

/**
 * Series sequels of finished shows that the user hasn't started. `finished` must carry
 * relations; `listStatus` maps every media ID on the list to its status.
 */
export function nextSeasons(finished: Media[], listStatus: Map<number, ListStatus>): NextSeason[] {
  const out = new Map<number, NextSeason>();
  for (const m of finished) {
    for (const edge of m.relations?.edges ?? []) {
      if (edge.relationType !== "SEQUEL" || edge.node.type !== "ANIME" || !SERIES_FORMATS.has(edge.node.format ?? "")) {
        continue;
      }
      const status = listStatus.get(edge.node.id);
      if (status && status !== "PLANNING") continue;
      if (!out.has(edge.node.id)) out.set(edge.node.id, { after: m, next: edge.node, planned: status === "PLANNING" });
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
  waiting: Media[];
  onHold: Behind[];
  nextSeasons: NextSeason[];
}

export function buildReport(list: Media[], sequels: NextSeason[], now: number): Report {
  const newEpisodes: Behind[] = [];
  const waiting: Media[] = [];
  const onHold: Behind[] = [];
  for (const m of list) {
    const entry = m.mediaListEntry;
    if (!entry) continue;
    const aired = airedEpisodes(m, now);
    const behind = aired !== null && aired > entry.progress;
    if (WATCHING.has(entry.status)) {
      if (behind) newEpisodes.push({ media: m, progress: entry.progress, aired: aired! });
      else if (m.nextAiringEpisode) waiting.push(m);
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
  waiting.sort((a, b) => a.nextAiringEpisode!.airingAt - b.nextAiringEpisode!.airingAt);
  return { newEpisodes, waiting, onHold, nextSeasons: sequels };
}

function behindLine(b: Behind, now: number, timeZone: string): string {
  const n = b.aired - b.progress;
  const next = b.media.nextAiringEpisode;
  const airing = next ? ` Episode ${next.episode} airs ${formatAirTime(next.airingAt, now, timeZone)}.` : "";
  return `- ${displayTitle(b.media.title)}: ${n} episode${n === 1 ? "" : "s"} to watch (on ${b.progress} of ${b.aired} aired).${airing}`;
}

function sequelDetail(s: NextSeason): string {
  const aired = AIRED_STATUSES.has(s.next.status ?? "");
  const year = s.next.startDate?.year;
  const availability = aired
    ? `${s.next.episodes ? `${s.next.episodes} episodes` : "airing now"}${year ? `, ${year}` : ""}`
    : `not out yet${year ? `, expected ${year}` : ""}`;
  const where = s.planned ? "on your plan-to-watch list" : "not on your list";
  return `[${s.next.id}] ${edgeTitle(s.next)} (${availability}), ${where}.`;
}

function sequelLine(s: NextSeason): string {
  return `- After ${displayTitle(s.after.title)}: ${sequelDetail(s)}`;
}

export function formatReport(r: Report, now: number, timeZone: string): string {
  const sections: string[] = [];
  if (r.newEpisodes.length) {
    sections.push(["New episodes to watch:", ...r.newEpisodes.map((b) => behindLine(b, now, timeZone))].join("\n"));
  }
  if (r.waiting.length) {
    sections.push(
      [
        "Caught up, waiting for new episodes:",
        ...r.waiting.map(
          (m) =>
            `- ${displayTitle(m.title)}: episode ${m.nextAiringEpisode!.episode} airs ${formatAirTime(m.nextAiringEpisode!.airingAt, now, timeZone)}.`,
        ),
      ].join("\n"),
    );
  }
  const readySequels = r.nextSeasons.filter((s) => AIRED_STATUSES.has(s.next.status ?? ""));
  const comingSequels = r.nextSeasons.filter((s) => !AIRED_STATUSES.has(s.next.status ?? ""));
  if (readySequels.length) {
    sections.push(["Next seasons of shows you finished:", ...readySequels.map(sequelLine)].join("\n"));
  }
  if (r.onHold.length) {
    sections.push(["On hold, with episodes left:", ...r.onHold.map((b) => behindLine(b, now, timeZone))].join("\n"));
  }
  if (comingSequels.length) {
    sections.push(["Announced sequels:", ...comingSequels.map(sequelLine)].join("\n"));
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
): string {
  const entry = m.mediaListEntry;
  const aired = airedEpisodes(m, now);
  const lines = [`${displayTitle(m.title)} [${m.id}]`];
  for (const edge of m.relations?.edges ?? []) {
    const status = listStatus.get(edge.node.id);
    if (edge.relationType === "PREQUEL" && status && SERIES_FORMATS.has(edge.node.format ?? "")) {
      lines.push(`Comes after: [${edge.node.id}] ${edgeTitle(edge.node)}, ${statusLabel(status).toLowerCase()} on your list.`);
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
  if (m.nextAiringEpisode) {
    lines.push(`Next: episode ${m.nextAiringEpisode.episode} airs ${formatAirTime(m.nextAiringEpisode.airingAt, now, timeZone)}.`);
  }
  for (const s of sequels) lines.push(`Comes next: ${sequelDetail(s)}`);
  return lines.join("\n");
}
