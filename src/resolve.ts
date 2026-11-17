/**
 * Turns what a person calls a show ("jjk", "the second season of spy x family",
 * "frieran") into one AniList entry, or a short list of candidates when it is
 * genuinely ambiguous. See docs/REQUIREMENTS.md, R1.
 */
import type { ListStatus, Media, RelationEdge, TitleLanguage } from "./anilist";
import { bothTitles, displayTitle, normalize } from "./logic";

/** What the caller wants to do with the show; it decides which season is most likely meant. */
export type Intent = "progress" | "status" | "rate" | "add" | "remove" | "lookup";

export interface AnimeSource {
  /** Everything on the user's list, with `mediaListEntry` set. */
  listMedia(): Promise<Media[]>;
  /** AniList-wide title search; results carry the user's `mediaListEntry` when present. */
  search(query: string): Promise<Media[]>;
  /** Fetch anime by ID with `relations`. */
  getMany(ids: number[]): Promise<Media[]>;
}

export type Resolution =
  | { kind: "match"; media: Media; why: string }
  | { kind: "ambiguous"; candidates: Media[]; why: string }
  | { kind: "none"; why: string };

export interface SeasonHint {
  season?: number;
  part?: number;
  movie?: boolean;
  /** "the new season", "latest season": the most recent season that has aired. */
  latest?: boolean;
  /** "the next season": the one after the furthest season the user has started. */
  next?: boolean;
}

export interface ParsedQuery {
  /** Normalized query with season words removed, for exact comparisons. */
  exact: string;
  /** Meaningful words, for containment matching. */
  words: string[];
  hint: SeasonHint;
  /**
   * Set when "new"/"next" was read as a season word but sits apart from "season"
   * ("the new Frieren season"). The words might instead be part of a title
   * ("New Game", "My Next Life as a Villainess"), so this literal reading is tried first.
   */
  literal?: ParsedQuery;
}

/** Common fan abbreviations AniList's synonyms don't reliably cover. */
const ALIASES: Record<string, string> = {
  jjk: "jujutsu kaisen",
  aot: "attack on titan",
  snk: "shingeki no kyojin",
  mha: "my hero academia",
  bnha: "boku no hero academia",
  fma: "fullmetal alchemist",
  fmab: "fullmetal alchemist brotherhood",
  hxh: "hunter x hunter",
  kny: "demon slayer",
  csm: "chainsaw man",
  sxf: "spy x family",
  opm: "one punch man",
  sao: "sword art online",
  ngnl: "no game no life",
  mp100: "mob psycho 100",
  tensura: "tensei shitara slime datta ken",
  rezero: "re zero",
  dbz: "dragon ball z",
  eva: "neon genesis evangelion",
  jojo: "jojo no kimyou na bouken",
};

const STOPWORDS = new Set(["the", "of", "a", "an", "ep", "eps", "episode", "episodes", "anime", "show", "series", "my"]);

const ORDINALS: Record<string, number> = {
  first: 1, second: 2, third: 3, fourth: 4, fifth: 5, sixth: 6, seventh: 7, eighth: 8,
};
const ROMAN: Record<string, number> = { i: 1, ii: 2, iii: 3, iv: 4, v: 5, vi: 6, vii: 7 };
const ORDINAL_WORD = `(${Object.keys(ORDINALS).join("|")})`;

function num(token: string): number {
  return ORDINALS[token] ?? ROMAN[token] ?? Number.parseInt(token, 10);
}

export function parseQuery(raw: string): ParsedQuery {
  let q = ` ${normalize(raw)} `;
  const hint: SeasonHint = {};
  const take = (re: RegExp, set: (m: RegExpExecArray) => void) => {
    const m = re.exec(q);
    if (!m) return;
    set(m);
    q = q.replace(m[0], " ");
  };

  take(/ season (\d{1,2}|ii|iii|iv|v|vi) /, (m) => (hint.season = num(m[1]!)));
  take(/ (\d{1,2})(?:st|nd|rd|th) season /, (m) => (hint.season = num(m[1]!)));
  take(new RegExp(` ${ORDINAL_WORD} season `), (m) => (hint.season = num(m[1]!)));
  take(/ s(\d{1,2}) /, (m) => (hint.season = num(m[1]!)));
  take(/ (?:part|cour) (\d+|ii|iii|iv) /, (m) => (hint.part = num(m[1]!)));
  take(/ (\d+)(?:st|nd|rd|th) (?:part|cour|half) /, (m) => (hint.part = num(m[1]!)));
  take(new RegExp(` ${ORDINAL_WORD} (?:part|cour|half) `), (m) => (hint.part = num(m[1]!)));
  take(/ (?:movie|film) /, () => (hint.movie = true));
  take(/ (?:new|newest|latest|most recent|recent|current) (?:season|cour) /, () => (hint.latest = true));
  take(/ next (?:season|cour) /, () => (hint.next = true));

  // Split around the title: "the new Frieren season", "next oshi no ko season".
  let literal: ParsedQuery | undefined;
  if (hint.season === undefined && !hint.latest && !hint.next && / (?:season|cour) /.test(q)) {
    const split = / (new|newest|latest|recent|current|next) /.exec(q);
    if (split) {
      literal = finish(q.replace(/ (?:season|cour) /, " "), { ...hint });
      if (split[1] === "next") hint.next = true;
      else hint.latest = true;
      q = q.replace(split[0], " ").replace(/ (?:season|cour) /, " ");
    }
  }
  return { ...finish(q, hint), ...(literal && { literal }) };
}

function finish(q: string, hint: SeasonHint): ParsedQuery {
  let exact = q.replace(/\s+/g, " ").trim();
  if (ALIASES[exact]) exact = ALIASES[exact]!;
  const words = exact.split(" ").filter((w) => w && !STOPWORDS.has(w));
  return { exact, words, hint };
}

function names(m: Media): string[] {
  return [m.title.romaji, m.title.english, m.title.native, ...m.synonyms]
    .filter((n): n is string => Boolean(n))
    .map(normalize)
    .filter(Boolean);
}

function levenshtein(a: string, b: string): number {
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

const LATIN = /^[a-z0-9]+$/;

/** Numbers and Roman numerals: "ii" must not match "iii", "1" must not match "100". */
const NUMBERISH = /^(\d+|[ivx]+)$/;

function wordHit(word: string, name: string, nameWords: string[]): boolean {
  if (NUMBERISH.test(word)) return nameWords.some((nw) => nw === word || nw === `${word}st` || nw === `${word}nd` || nw === `${word}rd` || nw === `${word}th`);
  if (nameWords.some((nw) => nw.startsWith(word))) return true;
  // Scripts without spaces (Japanese), or words run together ("spyxfamily", "rezero").
  if (!LATIN.test(word)) return name.includes(word);
  return word.length >= 4 && name.replace(/ /g, "").includes(word);
}

function typoHit(word: string, nameWords: string[]): boolean {
  if (word.length < 4 || !LATIN.test(word)) return false;
  const allowed = word.length >= 8 ? 2 : 1;
  return nameWords.some((nw) => levenshtein(word, nw) <= allowed);
}

/**
 * 4 = exact title or synonym, 3 = acronym of a title, 2 = every word appears,
 * 1 = every word appears allowing small typos, 0 = no match.
 */
export function matchScore(m: Media, q: ParsedQuery): number {
  if (q.words.length === 0) return 0;
  let best = 0;
  for (const name of names(m)) {
    if (name === q.exact) return 4;
    const nameWords = name.split(" ");
    if (nameWords.length >= 2 && !q.exact.includes(" ") && nameWords.map((w) => w[0]).join("") === q.exact) {
      best = Math.max(best, 3);
    }
    if (best >= 2) continue;
    if (q.words.every((w) => wordHit(w, name, nameWords))) best = 2;
    else if (best < 1 && q.words.every((w) => wordHit(w, name, nameWords) || typoHit(w, nameWords))) best = 1;
  }
  return best;
}

export const SERIES_FORMATS = new Set(["TV", "TV_SHORT", "ONA"]);
const FORMAT_ORDER: Record<string, number> = { TV: 0, ONA: 1, TV_SHORT: 2, MOVIE: 3, OVA: 3, SPECIAL: 3, MUSIC: 4 };

function isSeries(m: Media): boolean {
  return SERIES_FORMATS.has(m.format ?? "");
}

/** Season number written in a title ("2nd Season", "Season 3", "Mob Psycho 100 II"). */
export function titleSeason(m: Media): number | undefined {
  for (const name of names(m)) {
    const match =
      / season (\d{1,2})\b/.exec(` ${name}`) ??
      /\b(\d{1,2})(?:st|nd|rd|th) season\b/.exec(name) ??
      new RegExp(`\\b${ORDINAL_WORD} season\\b`).exec(name) ??
      / (ii|iii|iv|v|vi)$/.exec(name);
    if (match) return num(match[1]!);
  }
  // Short fan tags in AniList synonyms ("KnY 2", "AoT 4") number seasons named by arc.
  // Synonyms only: real titles like "Macross 7" aren't season numbers.
  for (const synonym of m.synonyms.map(normalize)) {
    const tag = /^[a-z]{2,8} ([1-9])$/.exec(synonym);
    if (tag) return num(tag[1]!);
  }
  return undefined;
}

/** Split-cour part written in a title ("Part 2", "2nd Cour", "Kouhen"). */
export function titlePart(m: Media): number | undefined {
  for (const name of names(m)) {
    const match =
      /\bpart (\d+|ii|iii|iv)\b/.exec(name) ?? /\b(\d+)(?:st|nd|rd|th) cour\b/.exec(name);
    if (match) return num(match[1]!);
    if (/\bkouhen\b/.test(name)) return 2;
    if (/\bkanketsu hen\b/.test(name)) return 3;
  }
  return undefined;
}

type Status = ListStatus | "NONE";

/** Lower is more likely, per intent. */
const STATUS_RANK: Record<Intent, Record<Status, number>> = {
  // A dropped show might be picked back up; a completed one usually means the next season.
  progress: { CURRENT: 0, REPEATING: 0, PAUSED: 1, PLANNING: 2, DROPPED: 3, NONE: 4, COMPLETED: 5 },
  // Status changes are almost always about something already on the list.
  status: { CURRENT: 0, REPEATING: 0, PAUSED: 1, PLANNING: 2, DROPPED: 3, COMPLETED: 4, NONE: 5 },
  rate: { COMPLETED: 0, REPEATING: 0, CURRENT: 1, PAUSED: 2, DROPPED: 2, PLANNING: 3, NONE: 4 },
  add: { CURRENT: 0, REPEATING: 0, PAUSED: 0, PLANNING: 0, NONE: 0, DROPPED: 0, COMPLETED: 0 },
  remove: { CURRENT: 0, REPEATING: 0, PAUSED: 0, PLANNING: 0, NONE: 9, DROPPED: 0, COMPLETED: 0 },
  lookup: { CURRENT: 0, REPEATING: 0, PAUSED: 0, PLANNING: 0, NONE: 1, DROPPED: 0, COMPLETED: 0 },
};

const STATUS_WHY: Record<Status, string> = {
  CURRENT: "you're watching it",
  REPEATING: "you're rewatching it",
  PAUSED: "it's paused on your list",
  PLANNING: "it's on your plan-to-watch list",
  DROPPED: "it's dropped on your list",
  COMPLETED: "you've completed it",
  NONE: "it's not on your list yet",
};

function status(m: Media): Status {
  return m.mediaListEntry?.status ?? "NONE";
}

function dateKey(m: Media): number {
  const d = m.startDate;
  return d?.year ? d.year * 10000 + (d.month ?? 12) * 100 + (d.day ?? 31) : 99_999_999;
}

function sharedLead(a: string, b: string): number {
  const aw = a.split(" ");
  const bw = b.split(" ");
  let n = 0;
  while (n < aw.length && n < bw.length && aw[n] === bw[n]) n++;
  return aw.slice(0, n).join(" ").length;
}

/** Same franchise when titles start with the same words ("sousou no frieren 2nd season" / "... 3rd season"). */
function sameFranchise(items: Media[]): boolean {
  const all = items.map(names);
  return all.every((ns) => all.every((other) => ns.some((a) => other.some((b) => sharedLead(a, b) >= 6))));
}

const YEAR_SUFFIX = / (19|20)\d\d$/;

/** A remake shares its original's title plus a year ("Hunter x Hunter" / "Hunter x Hunter (2011)"). */
function isRemake(a: Media, b: Media): boolean {
  if (a.id === b.id || !isSeries(a) || !isSeries(b)) return false;
  return names(a).some((na) =>
    names(b).some(
      (nb) => na !== nb && (YEAR_SUFFIX.test(na) || YEAR_SUFFIX.test(nb)) && na.replace(YEAR_SUFFIX, "") === nb.replace(YEAR_SUFFIX, ""),
    ),
  );
}

/** A first season: a series whose title doesn't mark it as a later season or part. */
function isRoot(m: Media): boolean {
  return isSeries(m) && (titleSeason(m) ?? 1) === 1 && (titlePart(m) ?? 1) === 1;
}

interface Scored {
  media: Media;
  score: number;
}

function dedupe(items: Media[]): Media[] {
  const byId = new Map<number, Media>();
  for (const m of items) {
    const existing = byId.get(m.id);
    // Prefer the copy that knows about the user's list entry.
    if (!existing || (!existing.mediaListEntry && m.mediaListEntry)) byId.set(m.id, m);
  }
  return [...byId.values()];
}

function score(items: Media[], q: ParsedQuery): Scored[] {
  const scored = items.map((media) => ({ media, score: matchScore(media, q) }));
  const strong = scored.filter((s) => s.score >= 2);
  return strong.length ? strong : scored.filter((s) => s.score === 1);
}

/** Drop movies/OVAs/specials unless asked for, or unless they match clearly better than any series. */
function preferSeries(items: Scored[], hint: SeasonHint): Scored[] {
  if (hint.movie) return items.filter((s) => s.media.format === "MOVIE");
  const bestSeries = Math.max(-1, ...items.filter((s) => isSeries(s.media)).map((s) => s.score));
  if (bestSeries < 0) return items;
  return items.filter((s) => isSeries(s.media) || s.score > bestSeries);
}

const MAX_CANDIDATES = 8;

/** Fetch the list once and each search once per resolution (or per tool call). */
export function memo(source: AnimeSource): AnimeSource {
  let list: Promise<Media[]> | undefined;
  const searches = new Map<string, Promise<Media[]>>();
  return {
    listMedia: () => (list ??= source.listMedia()),
    search: (query) => {
      if (!searches.has(query)) searches.set(query, source.search(query));
      return searches.get(query)!;
    },
    getMany: (ids) => source.getMany(ids),
  };
}

/** `language` is the user's title language, for titles quoted in `why`; matching ignores it. */
export async function resolveAnime(
  query: string,
  intent: Intent,
  source: AnimeSource,
  language: TitleLanguage,
): Promise<Resolution> {
  const src = memo(source);
  const q = parseQuery(query);
  if (q.literal && (await matchesStrongly(q.literal, intent, src))) {
    return resolveParsed(query, q.literal, intent, src, language);
  }
  return resolveParsed(query, q, intent, src, language);
}

async function matchesStrongly(q: ParsedQuery, intent: Intent, source: AnimeSource): Promise<boolean> {
  if (q.words.length === 0) return false;
  const strong = (items: Media[]) => items.some((m) => matchScore(m, q) >= 2);
  if (strong(await source.listMedia())) return true;
  return intent !== "remove" && strong(await source.search(q.words.join(" ")));
}

async function resolveParsed(
  query: string,
  q: ParsedQuery,
  intent: Intent,
  source: AnimeSource,
  language: TitleLanguage,
): Promise<Resolution> {
  if (q.words.length === 0) return { kind: "none", why: `"${query}" doesn't name a show.` };

  const list = await source.listMedia();
  let pool = score(list, q);
  let searched = false;
  const searchAll = async () => {
    if (searched) return;
    searched = true;
    const results = await source.search(q.words.join(" "));
    pool = score(dedupe([...list, ...results]), q);
  };

  const named =
    q.hint.season !== undefined || q.hint.part !== undefined || q.hint.latest || q.hint.next || q.hint.movie;
  if (intent === "remove") {
    // Removing only ever targets the list, so AniList-wide results can't change the answer.
  } else if (intent === "add" || named) {
    await searchAll();
  } else {
    const ranks = STATUS_RANK[intent];
    const listed = pool.filter((s) => s.media.mediaListEntry);
    // Only look beyond the list when nothing there is a likely target.
    if (!listed.some((s) => ranks[status(s.media)] < ranks.NONE)) await searchAll();
  }

  pool = preferSeries(pool, q.hint);
  if (intent === "remove") pool = pool.filter((s) => s.media.mediaListEntry);

  if (pool.length === 0) {
    const where = intent === "remove" ? "on your list" : "on AniList";
    return { kind: "none", why: `Couldn't find "${query}" ${where}.` };
  }

  if (q.hint.latest || q.hint.next) return resolveRelative(query, q, pool, source, language);
  if (q.hint.season !== undefined || q.hint.part !== undefined) {
    return resolveSeason(q, intent, pool, source);
  }
  return pick(query, intent, pool);
}

function pick(query: string, intent: Intent, pool: Scored[]): Resolution {
  const ranks = STATUS_RANK[intent];
  if (intent === "add") {
    // "Add Frieren" means season 1, unless a later season matches the words clearly better.
    const roots = pool.filter((s) => isRoot(s.media));
    const bestRoot = Math.max(-1, ...roots.map((s) => s.score));
    const bestOther = Math.max(-1, ...pool.filter((s) => !isRoot(s.media)).map((s) => s.score));
    if (roots.length && bestRoot >= bestOther) pool = roots;
  }
  const useScore = intent !== "rate" && intent !== "remove";
  const key = (s: Scored) => [
    ranks[status(s.media)],
    useScore ? -s.score : 0,
    FORMAT_ORDER[s.media.format ?? ""] ?? 5,
  ];
  const cmp = (a: Scored, b: Scored) => {
    const ka = key(a);
    const kb = key(b);
    for (let i = 0; i < ka.length; i++) if (ka[i] !== kb[i]) return ka[i]! - kb[i]!;
    return dateKey(a.media) - dateKey(b.media);
  };
  const sorted = [...pool].sort(cmp);
  const top = sorted[0]!;
  const tied = sorted.filter((s) => key(s).every((v, i) => v === key(top)[i]));

  const remakes = sorted.filter(
    (s) => ranks[status(s.media)] === ranks[status(top.media)] && isRemake(s.media, top.media),
  );
  if (remakes.length) {
    return {
      kind: "ambiguous",
      candidates: [top.media, ...remakes.map((s) => s.media)],
      why: `"${query}" has more than one version.`,
    };
  }

  if (tied.length === 1) return { kind: "match", media: top.media, why: STATUS_WHY[status(top.media)] };

  // Several equally likely seasons of one franchise, none of them in progress on the list:
  // the earliest is the natural reading ("add Frieren" means season 1; after finishing
  // season 1, "watched episode 2 of Frieren" means season 2).
  if ((intent === "add" || status(top.media) === "NONE") && sameFranchise(tied.map((s) => s.media))) {
    const first = tied[0]!.media;
    const why = intent === "add" ? "it's the first season" : "it's the next season, and not on your list yet";
    return { kind: "match", media: first, why };
  }

  return {
    kind: "ambiguous",
    candidates: tied.slice(0, MAX_CANDIDATES).map((s) => s.media),
    why: `"${query}" matches ${tied.length} shows equally well.`,
  };
}

/** AniList statuses for something that has started airing. */
export const AIRED = new Set(["RELEASING", "FINISHED", "HIATUS"]);

function hasAired(m: Media): boolean {
  return AIRED.has(m.status ?? "") && Boolean(m.startDate?.year);
}

/**
 * The first season to count from, or an ambiguity when equally good first seasons
 * belong to different shows or versions ("Hunter x Hunter" 1999 / 2011).
 */
function pickRoot(pool: Scored[], label: string): { root: Media } | Resolution {
  const roots = rootsOf(pool);
  const root = roots[0]?.media;
  if (!root) return { kind: "none", why: `Couldn't find "${label}" on AniList.` };
  const rivals = roots.filter((s) => s.score === roots[0]!.score).map((s) => s.media);
  const versions = roots.filter((s) => isRemake(s.media, root)).map((s) => s.media);
  if (versions.length) {
    const all = [root, ...versions];
    // If only one version is on the user's list, that's the one they mean.
    const listed = all.filter((m) => m.mediaListEntry);
    if (listed.length === 1) return { root: listed[0]! };
    return { kind: "ambiguous", candidates: all.slice(0, MAX_CANDIDATES), why: `"${label}" has more than one version.` };
  }
  if (!sameFranchise(rivals)) {
    return { kind: "ambiguous", candidates: rivals.slice(0, MAX_CANDIDATES), why: `"${label}" matches more than one show.` };
  }
  return { root };
}

/** First seasons that best match the words, sorted best first. */
function rootsOf(pool: Scored[]): Scored[] {
  return pool
    .filter((s) => isRoot(s.media))
    .sort((a, b) => b.score - a.score || dateKey(a.media) - dateKey(b.media));
}

/**
 * "The new season" (the most recent one that has aired) and "the next season" (the one
 * after the furthest the user has started), found by walking the sequel chain from season 1.
 */
async function resolveRelative(
  query: string,
  q: ParsedQuery,
  pool: Scored[],
  source: AnimeSource,
  language: TitleLanguage,
): Promise<Resolution> {
  const picked = pickRoot(pool, query);
  if (!("root" in picked)) return picked;
  const { root } = picked;

  const chain = (await seasonChain(root, Number.POSITIVE_INFINITY, source)).map((e) => e.media);

  if (q.hint.latest) {
    const aired = chain.filter(hasAired).filter((m) => q.hint.part === undefined || (titlePart(m) ?? 1) === q.hint.part);
    const latest = aired.at(-1);
    if (!latest) return { kind: "none", why: `No season of ${displayTitle(root.title, language)} has aired yet.` };
    return { kind: "match", media: latest, why: "it's the latest season that has aired" };
  }

  // Next: after the furthest season the user has started (anything on the list but plan-to-watch).
  let anchor = -1;
  chain.forEach((m, i) => {
    if (m.mediaListEntry && m.mediaListEntry.status !== "PLANNING") anchor = i;
  });
  const next = chain[anchor >= 0 ? anchor + 1 : 1];
  if (!next) {
    const after = anchor >= 0 ? chain[anchor]! : root;
    return { kind: "none", why: `AniList doesn't list a season after ${displayTitle(after.title, language)} yet.` };
  }
  const why = anchor >= 0 ? `it's the season after ${displayTitle(chain[anchor]!.title, language)}` : "it's the sequel to the first season";
  return { kind: "match", media: next, why };
}

interface SeasonEntry {
  media: Media;
  season: number;
  part: number;
}

async function seasonChain(root: Media, upTo: number, source: AnimeSource): Promise<SeasonEntry[]> {
  const chain: SeasonEntry[] = [];
  let current: Media | undefined = root;
  let season = titleSeason(root) ?? 1;
  let part = titlePart(root) ?? 1;
  const seen = new Set<number>();
  while (current && !seen.has(current.id) && chain.length < 15) {
    seen.add(current.id);
    chain.push({ media: current, season, part });
    if (season > upTo) break;
    const withRelations: Media | undefined = current.relations ? current : (await source.getMany([current.id]))[0];
    const edges: RelationEdge[] = withRelations?.relations?.edges ?? [];
    const sequel = edges.find(
      (e) => e.relationType === "SEQUEL" && e.node.type === "ANIME" && SERIES_FORMATS.has(e.node.format ?? ""),
    );
    if (!sequel) break;
    current = (await source.getMany([sequel.node.id]))[0];
    if (!current) break;
    const ts = titleSeason(current);
    const tp = titlePart(current);
    if (ts !== undefined) {
      season = ts;
      part = tp ?? 1;
    } else if (tp !== undefined && tp >= 2) {
      part = tp;
    } else {
      season += 1;
      part = 1;
    }
  }
  return chain;
}

async function resolveSeason(
  q: ParsedQuery,
  intent: Intent,
  pool: Scored[],
  source: AnimeSource,
): Promise<Resolution> {
  const wantSeason = q.hint.season ?? 1;
  const fits = (season: number, part: number) =>
    season === wantSeason && (q.hint.part === undefined || part === q.hint.part);

  // 1. A title that states the season ("Sousou no Frieren 2nd Season").
  let matches = pool
    .map((s) => ({ media: s.media, season: titleSeason(s.media) ?? 1, part: titlePart(s.media) ?? 1 }))
    .filter((e) => titleSeason(e.media) !== undefined || wantSeason === 1)
    .filter((e) => fits(e.season, e.part));
  let how = "its title";

  // 2. Otherwise walk the sequel chain from season 1 ("Shingeki no Kyojin: The Final Season" is season 4).
  if (matches.length === 0 || wantSeason === 1) {
    const picked = pickRoot(pool, q.exact);
    if (!("root" in picked) && picked.kind === "ambiguous") return picked;
    const root = "root" in picked ? picked.root : undefined;
    if (root) {
      const chain = await seasonChain(root, wantSeason, source);
      const fromChain = chain.filter((e) => fits(e.season, e.part));
      if (fromChain.length) {
        matches = fromChain;
        how = "the sequel order on AniList";
      }
    }
  }

  const label = `season ${wantSeason}${q.hint.part ? ` part ${q.hint.part}` : ""}`;
  if (matches.length === 0) {
    return { kind: "none", why: `Couldn't find ${label} of "${q.exact}" on AniList.` };
  }
  if (matches.length === 1) {
    return { kind: "match", media: matches[0]!.media, why: `it's ${label}, going by ${how}` };
  }

  // Several parts of the same season: prefer the one the intent points at, else the first part.
  const ranks = STATUS_RANK[intent];
  matches.sort((a, b) => ranks[status(a.media)] - ranks[status(b.media)] || a.part - b.part || dateKey(a.media) - dateKey(b.media));
  const best = matches[0]!;
  const why =
    status(best.media) === "NONE"
      ? `it's the first part of ${label}`
      : `it's ${label} and ${STATUS_WHY[status(best.media)]}`;
  return { kind: "match", media: best.media, why };
}

/** Candidates keep a second title: the user may know the show by either name. */
export function describeCandidates(candidates: Media[], language: TitleLanguage): string {
  return candidates
    .map((m) => {
      const meta = [m.format, m.seasonYear].filter(Boolean).join(", ");
      const entry = m.mediaListEntry ? `on your list: ${m.mediaListEntry.status.toLowerCase()}` : "not on your list";
      return `[${m.id}] ${bothTitles(m.title, language)}${meta ? ` (${meta})` : ""}, ${entry}`;
    })
    .join("\n");
}
