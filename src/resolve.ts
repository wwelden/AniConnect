/**
 * Turns what a person calls a show ("jjk", "the second season of spy x family",
 * "frieran") into one AniList entry, or a short list of candidates when it is
 * genuinely ambiguous. See docs/REQUIREMENTS.md, R1.
 */
import type { ListStatus, Media, RelationEdge, TitleLanguage } from "./anilist";
import { bothTitles, displayTitle, literalTitle, normalize } from "./logic";

/**
 * What the caller wants to do with the show; it decides which season is most likely meant.
 * "show" reads about a show: ranked like "status", without the extra search a write makes
 * for a title that may not be the listed show's (see `exactOnly`).
 */
export type Intent = "progress" | "status" | "show" | "rate" | "add" | "remove" | "lookup";

export interface AnimeSource {
  /** Everything on the user's list, with `mediaListEntry` set. */
  listMedia(): Promise<Media[]>;
  /** AniList-wide title search; results carry `relations` and the user's `mediaListEntry` when present. */
  search(query: string): Promise<Media[]>;
  /**
   * Fetch anime by ID with `relations`, where each related anime is a full `Media`
   * (with `mediaListEntry`) carrying its own `relations`: two steps of a sequel chain.
   */
  getRelated(ids: number[]): Promise<Media[]>;
  /**
   * Titles `search` leaves out because of the user's settings (adult titles), searched
   * only to explain a miss. Omit, or return nothing, when nothing is hidden.
   */
  searchHidden?(query: string): Promise<Media[]>;
}

export type Resolution =
  | { kind: "match"; media: Media; why: string }
  | { kind: "ambiguous"; candidates: Media[]; why: string }
  | { kind: "none"; why: string; hidden?: boolean };

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
  /** The query as written (see `literalTitle`), to tell apart titles that differ only in punctuation. */
  typed?: string;
  /**
   * Set when "new"/"next" was read as a season word but sits apart from "season"
   * ("the new Frieren season"). The words might instead be part of a title
   * ("New Game", "My Next Life as a Villainess"), so this literal reading is tried first.
   * Also set when an abbreviation was expanded next to other words, holding the unexpanded words.
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
      literal = finish(q.replace(/ (?:season|cour) /, " "), { ...hint }, false);
      if (split[1] === "next") hint.next = true;
      else hint.latest = true;
      q = q.replace(split[0], " ").replace(/ (?:season|cour) /, " ");
    }
  }
  const parsed = finish(q, hint);
  // Both readings kept: "next jjk 0 season" tries "next jjk 0", then "jjk 0" (next season).
  const result = literal ? { ...parsed, literal: { ...literal, literal: parsed.literal } } : parsed;
  // Only readings that compare the whole query, with nothing read as a season or expanded.
  for (let r: ParsedQuery | undefined = result; r; r = r.literal) {
    if (r.exact === normalize(raw)) r.typed = literalTitle(raw);
  }
  return result;
}

const isAlias = (w: string) => Object.hasOwn(ALIASES, w);
const meaningful = (s: string) => s.split(" ").filter((w) => w && !STOPWORDS.has(w));

/** `expand` false keeps abbreviations as written, for a reading that is already literal. */
function finish(q: string, hint: SeasonHint, expand = true): ParsedQuery {
  const raw = q.replace(/\s+/g, " ").trim();
  if (!expand) return { exact: raw, words: meaningful(raw), hint };
  // Expand an abbreviation wherever it stands as a word: "aot final season".
  const exact = raw
    .split(" ")
    .map((w) => (isAlias(w) ? ALIASES[w]! : w))
    .join(" ");
  const parsed: ParsedQuery = { exact, words: meaningful(exact), hint };
  // Some names really contain the short form ("HxH: Phantom Rogue", "JJK 0"), so with
  // other words around it the unexpanded reading is tried first.
  const rawWords = meaningful(raw);
  if (exact !== raw && !rawWords.every(isAlias)) parsed.literal = { exact: raw, words: rawWords, hint: { ...hint } };
  return parsed;
}

/** `own` leaves out AniList's synonyms: only the show's titles (romaji, English, native). */
function rawNames(m: Media, own = false): string[] {
  return [m.title.romaji, m.title.english, m.title.native, ...(own ? [] : m.synonyms)].filter((n): n is string => Boolean(n));
}

/** `names` of each anime, all and own, worked out once: a resolution compares every title many times. */
const NAMES = new WeakMap<Media, [string[], string[]]>();

function names(m: Media, own = false): string[] {
  let known = NAMES.get(m);
  if (!known) {
    known = [rawNames(m).map(normalize).filter(Boolean), rawNames(m, true).map(normalize).filter(Boolean)];
    NAMES.set(m, known);
  }
  return known[own ? 1 : 0];
}

/**
 * A format AniList appends to a title to tell it from another anime of the same name:
 * "SPRIGGAN (ONA)", the 2022 series, beside "SPRIGGAN", the 1998 movie.
 */
const FORMAT_TAG = /\s*\((?:TV|ONA|OVA|OAD|Movie|Special)\)\s*$/i;

/** Titles with a format tag, without it: the name the show goes by. */
function untagged(m: Media, own = false): string[] {
  return rawNames(m, own).filter((n) => FORMAT_TAG.test(n)).map((n) => n.replace(FORMAT_TAG, ""));
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

/** `inside` also counts a Latin word found inside a word of the name ("bocchi" in "hitoribocchi"). */
function wordHit(word: string, name: string, nameWords: string[], inside = true): boolean {
  if (NUMBERISH.test(word)) return nameWords.some((nw) => nw === word || nw === `${word}st` || nw === `${word}nd` || nw === `${word}rd` || nw === `${word}th`);
  if (nameWords.some((nw) => nw.startsWith(word))) return true;
  // Scripts without spaces (Japanese), or words run together ("spyxfamily", "rezero").
  if (!LATIN.test(word)) return name.includes(word);
  if (word.length < 4) return false;
  if (inside) return name.replace(/ /g, "").includes(word);
  return nameWords.some((_, i) => nameWords.slice(i).join("").startsWith(word));
}

function typoHit(word: string, nameWords: string[]): boolean {
  if (word.length < 4 || !LATIN.test(word)) return false;
  const allowed = word.length >= 8 ? 2 : 1;
  // The distance is at least the difference in length: skip the words that can't be in reach.
  return nameWords.some((nw) => Math.abs(nw.length - word.length) <= allowed && levenshtein(word, nw) <= allowed);
}

/**
 * The query respelled from the titles of the listed shows it only matches with typos
 * ("frieran" -> "frieren"), so it resolves as the right spelling would: AniList's search has
 * no typo tolerance, so the sequels and same-named shows the guards weigh never come back for
 * the misspelling. Each mistyped word takes the closest word of the shows' own titles, else of
 * their synonyms. Undefined when the shows disagree on a word (R1.2).
 */
function correction(q: ParsedQuery, listed: Media[]): ParsedQuery | undefined {
  const fixes = new Map<string, string>();
  for (const word of q.words) {
    if (listed.some((m) => names(m).some((n) => wordHit(word, n, n.split(" "))))) continue;
    let closest = new Set<string>();
    for (const own of [true, false]) {
      let best = Number.POSITIVE_INFINITY;
      for (const nw of listed.flatMap((m) => names(m, own)).flatMap((n) => n.split(" "))) {
        if (!typoHit(word, [nw])) continue;
        const d = levenshtein(word, nw);
        if (d < best) [best, closest] = [d, new Set([nw])];
        else if (d === best) closest.add(nw);
      }
      if (closest.size) break;
    }
    if (closest.size !== 1) return undefined;
    fixes.set(word, [...closest][0]!);
  }
  if (!fixes.size) return undefined;
  const exact = q.exact.split(" ").map((w) => fixes.get(w) ?? w).join(" ");
  return { exact, words: meaningful(exact), hint: q.hint };
}

/**
 * 4 = exact title or synonym, 3 = acronym of a title, 2 = every word appears,
 * 1 = every word appears allowing small typos, 0 = no match.
 * `own` scores the show's titles alone, by whole words: no synonyms, no match inside a word.
 */
export function matchScore(m: Media, q: ParsedQuery, own = false): number {
  if (q.words.length === 0) return 0;
  if (untagged(m, own).some((n) => normalize(n) === q.exact)) return 4;
  let best = 0;
  for (const name of names(m, own)) {
    if (name === q.exact) return 4;
    const nameWords = name.split(" ");
    if (nameWords.length >= 2 && !q.exact.includes(" ") && nameWords.map((w) => w[0]).join("") === q.exact) {
      best = Math.max(best, 3);
    }
    if (best >= 2) continue;
    if (q.words.every((w) => wordHit(w, name, nameWords, !own))) best = 2;
    else if (best < 1 && q.words.every((w) => wordHit(w, name, nameWords, !own) || typoHit(w, nameWords))) best = 1;
  }
  return best;
}

export const SERIES_FORMATS = new Set(["TV", "TV_SHORT", "ONA"]);
const FORMAT_ORDER: Record<string, number> = { TV: 0, ONA: 1, TV_SHORT: 2, MOVIE: 3, OVA: 3, SPECIAL: 3, MUSIC: 4 };

function isSeries(m: Pick<Media, "format">): boolean {
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
  show: { CURRENT: 0, REPEATING: 0, PAUSED: 1, PLANNING: 2, DROPPED: 3, COMPLETED: 4, NONE: 5 },
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

function dateKey(m: Pick<Media, "startDate">): number {
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
  const all = items.map((m) => names(m));
  return all.every((ns) => all.every((other) => ns.some((a) => other.some((b) => sharedLead(a, b) >= 6))));
}

const YEAR_SUFFIX = / (19|20)\d\d$/;

/** Joined directly by a sequel or prequel edge, from the relations either one carries. */
function seasonsOf(a: Media, b: Media): boolean {
  const joined = (x: Media, y: Media) =>
    (x.relations?.edges ?? []).some((e) => (e.relationType === "SEQUEL" || e.relationType === "PREQUEL") && e.node.id === y.id);
  return joined(a, b) || joined(b, a);
}

/** True when both popularities are known and `a`'s is the higher. */
function morePopular(a: Media, b: Media): boolean {
  return a.popularity != null && b.popularity != null && a.popularity > b.popularity;
}

/**
 * A remake shares its original's title plus a year ("Hunter x Hunter" / "Hunter x Hunter (2011)").
 * Unless the two share a title, a less popular show's synonyms don't make it a version of the
 * other: "NARUTO (2026)" is a synonym of NARUTO×NINKU, a different show.
 */
function isRemake(a: Media, b: Media): boolean {
  if (a.id === b.id || !isSeries(a) || !isSeries(b)) return false;
  const shared = names(a, true).some((n) => names(b, true).includes(n));
  return names(a, !shared && morePopular(b, a)).some((na) =>
    names(b, !shared && morePopular(a, b)).some(
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
  /** matchScore of the show's own titles (see `matchScore`). */
  own: number;
  /** Set when the score fell to `own`, giving way to a more popular show titled with the words (see `score`). */
  yielded?: boolean;
  /** Set when it would give way, but to a show neither copy carries relations for (both from the list). */
  unsure?: boolean;
  /**
   * Titled exactly as written, beside shows that match only once normalized and lack a mark
   * the query has ("Love is War?" beside "Love is War"): that show is the one meant (#73).
   */
  asTyped?: boolean;
}

/** Punctuation and symbols in a title as written (see `literalTitle`), counted. */
function marks(literal: string): Map<string, number> {
  const counts = new Map<string, number>();
  for (const c of literal.replace(/[\p{L}\p{N}]/gu, "")) counts.set(c, (counts.get(c) ?? 0) + 1);
  return counts;
}

/** The titles of `m` that are written as `typed` (see `literalTitle`). */
function writtenAs(m: Media, typed: string): boolean {
  return [...rawNames(m), ...untagged(m)].some((n) => literalTitle(n) === typed);
}

function dedupe(items: Media[]): Media[] {
  const byId = new Map<number, Media>();
  for (const m of items) {
    const existing = byId.get(m.id);
    // Prefer the copy that knows about the user's list entry, with relations from either.
    const keep = !existing || (!existing.mediaListEntry && m.mediaListEntry) ? m : existing;
    const relations = keep.relations ?? (keep === m ? existing?.relations : m.relations);
    byId.set(m.id, relations === keep.relations ? keep : { ...keep, relations });
  }
  return [...byId.values()];
}

function score(items: Media[], q: ParsedQuery): Scored[] {
  const scored: Scored[] = items.map((media) => ({ media, score: matchScore(media, q), own: matchScore(media, q, true) }));
  // A show that matches only through a synonym or inside a word ("Demon Slayer" is a synonym of
  // Onigiri; "bocchi" is inside "Hitoribocchi") gives way to a more popular show whose own title
  // has the words, and keeps only what its titles match. Not to its own prequel or sequel, and
  // when a movie is asked for, only to a movie.
  for (const s of scored) {
    if (s.own >= s.score) continue;
    const over = scored.filter(
      (o) =>
        o.own >= 2 && o.own > s.own && morePopular(o.media, s.media) && (!q.hint.movie || o.media.format === "MOVIE") &&
        // A music video not on the list only counts when nothing else matches (`preferSeries`).
        !(o.media.format === "MUSIC" && !o.media.mediaListEntry),
    );
    const known = (o: Scored) => Boolean(o.media.relations || s.media.relations);
    if (over.some((o) => known(o) && !seasonsOf(o.media, s.media))) {
      s.score = s.own;
      s.yielded = true;
    } else if (over.some((o) => !known(o))) s.unsure = true;
  }
  // "Kaguya-sama: Love is War?" and "Kaguya-sama: Love is War" normalize alike (#61): when a
  // title is written exactly as asked, the others that only match once normalized rank below it.
  if (q.typed) {
    const typed = q.typed;
    const exact = scored.filter((s) => s.score === EXACT).map((s) => ({ s, typed: writtenAs(s.media, typed) }));
    if (exact.some((e) => e.typed)) for (const e of exact) if (!e.typed) e.s.score = NORMALIZED_EXACT;
    // The others' titles that read as the query lack one of its marks: the one titled as written
    // is meant whatever the list says. Not the other way round: "Love is War" against "Love is
    // War?" names the first season, which may mean the season being watched (R1.4).
    const asked = marks(typed);
    const lacks = (m: Media) =>
      [...rawNames(m), ...untagged(m)]
        .filter((n) => normalize(n) === q.exact)
        .every((n) => {
          const has = marks(literalTitle(n));
          return [...asked].some(([c, k]) => (has.get(c) ?? 0) < k);
        });
    const others = exact.filter((e) => !e.typed);
    if (others.length && others.every((e) => lacks(e.s.media))) for (const e of exact) if (e.typed) e.s.asTyped = true;
  }
  const strong = scored.filter((s) => s.score >= 2);
  if (!strong.length) return scored.filter((s) => s.score === 1);
  // A show on the list that gave way stays: its list status may still settle it (see `keepNamedShow`).
  return [...strong, ...scored.filter((s) => s.yielded && s.score < 2 && s.media.mediaListEntry)];
}

/**
 * Drop movies/OVAs/specials unless asked for, or unless they match clearly better than any
 * series. Music videos not on the list only count when nothing else matches: an MV titled
 * after its song ("Idol") is never the show someone means when a show matches too.
 */
function preferSeries(items: Scored[], hint: SeasonHint): Scored[] {
  if (hint.movie) return items.filter((s) => s.media.format === "MOVIE");
  // One on the user's list is theirs to name, so it stays.
  const music = (s: Scored) => s.media.format === "MUSIC" && !s.media.mediaListEntry;
  if (items.some((s) => !music(s))) items = items.filter((s) => !music(s));
  const bestSeries = Math.max(-1, ...items.filter((s) => isSeries(s.media)).map((s) => s.score));
  if (bestSeries < 0) return items;
  // A listed show that gave way stays whatever its format, for `keepNamedShow` to weigh; not
  // when a season is named, which `keepNamedShow` doesn't see.
  const seasonal = hint.season !== undefined || hint.part !== undefined || hint.latest || hint.next;
  return items.filter((s) => isSeries(s.media) || s.score > bestSeries || (s.yielded && !seasonal));
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
    getRelated: (ids) => source.getRelated(ids),
    ...(source.searchHidden && { searchHidden: (query: string) => source.searchHidden!(query) }),
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
  let hidden: Resolution | undefined;
  const skipped: ParsedQuery[] = [];
  for (let literal = q.literal; literal; literal = literal.literal) {
    if (!(await matchesStrongly(literal, intent, src))) {
      skipped.push(literal);
      continue;
    }
    // A name can match yet miss the hint ("aot final season movie" against a TV synonym):
    // then the next reading gets its turn.
    const r = await resolveParsed(query, literal, intent, src, language);
    if (r.kind !== "none") return r;
    if (r.hidden) hidden ??= r;
  }
  const r = await resolveParsed(query, q, intent, src, language);
  if (r.kind !== "none" || r.hidden) return r;
  // Keep "only adult titles match" over a plain "couldn't find", including for an
  // adult title named with the short form as written ("JJK 0").
  if (hidden) return hidden;
  for (const literal of skipped) {
    const l = await resolveParsed(query, literal, intent, src, language);
    if (l.kind === "none" && l.hidden) return l;
  }
  return r;
}

async function matchesStrongly(q: ParsedQuery, intent: Intent, source: AnimeSource): Promise<boolean> {
  if (q.words.length === 0) return false;
  const strong = (items: Media[]) => items.some((m) => matchScore(m, q) >= 2);
  if (strong(await source.listMedia())) return true;
  return intent !== "remove" && strong(await source.search(q.words.join(" ")));
}

/** `corrected` is set when `q` is already a typo's correction (see `correction`). */
async function resolveParsed(
  query: string,
  q: ParsedQuery,
  intent: Intent,
  source: AnimeSource,
  language: TitleLanguage,
  corrected = false,
): Promise<Resolution> {
  if (q.words.length === 0) return { kind: "none", why: `"${query}" doesn't name a show.` };

  const list = await source.listMedia();
  let pool = score(list, q);
  // Everything fetched so far, unscored: sequels with unrelated titles still help walk a chain.
  let fetched = list;
  let searched = false;
  const searchAll = async () => {
    if (searched) return;
    searched = true;
    const results = await source.search(q.words.join(" "));
    fetched = [...list, ...results];
    pool = score(dedupe(fetched), q);
  };

  const typoOnly = () => pool.length > 0 && pool.every((s) => s.score === 1);
  if (intent !== "remove" && !corrected && typoOnly()) {
    // Matched only with typos, and only on the list. The name may be a real title one letter
    // off a listed one ("kaiji" beside Kaiju No. 8): search it as written first. If nothing
    // matches better, resolve the spelling the listed titles give, sequels and all (R1.2).
    await searchAll();
    const listed = pool.filter((s) => s.media.mediaListEntry).map((s) => s.media);
    const fixed = typoOnly() && listed.length ? correction(q, listed) : undefined;
    if (fixed) return resolveParsed(query, fixed, intent, source, language, true);
  }

  // A listed title reads as the query only once normalized, and the query has a mark it lacks
  // ("Kaguya-sama: Love is War?" with only "Kaguya-sama: Love is War" listed): the show titled
  // as written may be another season, off the list (#73). One search.
  const twin = () => {
    const exact = pool.filter((s) => s.media.mediaListEntry && s.score === EXACT);
    const typed = q.typed;
    return Boolean(typed && marks(typed).size && exact.length && !exact.some((s) => writtenAs(s.media, typed)));
  };

  const named =
    q.hint.season !== undefined || q.hint.part !== undefined || q.hint.latest || q.hint.next || q.hint.movie;
  if (intent === "remove") {
    // Removing only ever targets the list, so AniList-wide results can't change the answer,
    // except to tell that the title written is a show the list doesn't have.
    if (twin()) {
      await searchAll();
      const typed = pool.filter((s) => s.asTyped);
      if (typed.length) {
        const listed = pool.filter((s) => s.media.mediaListEntry && s.score >= NORMALIZED_EXACT);
        return {
          kind: "ambiguous",
          candidates: [...typed, ...listed].slice(0, MAX_CANDIDATES).map((s) => s.media),
          why: `"${query}" is the title of a show that isn't on your list, and shows with that name in their title are.`,
        };
      }
    }
  } else if (intent === "add" || named) {
    await searchAll();
  } else {
    const ranks = STATUS_RANK[intent];
    const listed = pool.filter((s) => s.media.mediaListEntry);
    // Look beyond the list when nothing there is a likely target, or, for a status or a
    // rating, when nothing there is titled exactly that: "Naruto" may be a show the user
    // hasn't listed, not the Shippuden they have. Also when every listed match comes only
    // through a synonym or inside a word: a more popular show may have the words in its title
    // (`score`), or when one would give way to another listed show and the search brings the
    // relations that tell whether the two are seasons of one show.
    if (
      !listed.some((s) => ranks[status(s.media)] < ranks.NONE) ||
      (exactOnly(intent) && !listed.some((s) => s.score === EXACT)) ||
      (listed.length && listed.every((s) => s.own < 2 && s.own < s.score)) ||
      listed.some((s) => s.unsure) ||
      twin()
    ) {
      await searchAll();
    }
  }

  pool = preferSeries(pool, q.hint);
  if (intent === "remove") pool = pool.filter((s) => s.media.mediaListEntry);

  if (pool.length === 0) {
    if (intent !== "remove" && source.searchHidden) {
      // Say why rather than "not found", so the assistant doesn't report that the show doesn't exist.
      const hidden = preferSeries(score(await source.searchHidden(q.words.join(" ")), q), q.hint);
      if (hidden.length) {
        return {
          kind: "none",
          hidden: true,
          why: `Only adult (18+) titles match "${query}", and they're hidden because 18+ content is off in the user's AniList settings.`,
        };
      }
    }
    const where = intent === "remove" ? "on your list" : "on AniList";
    return { kind: "none", why: `Couldn't find "${query}" ${where}.` };
  }

  if (q.hint.latest || q.hint.next) return resolveRelative(query, q, pool, source, fetched, language);
  if (q.hint.season !== undefined || q.hint.part !== undefined) {
    return resolveSeason(q, intent, pool, source, fetched);
  }
  if (intent === "progress") pool = await keepCompleted(pool, source, fetched);
  if (exactOnly(intent)) {
    // A show titled exactly as asked that isn't on the list, beside listed ones that only
    // contain the words: either could be meant, so ask rather than change the listed one.
    const exact = pool.filter((s) => s.score === EXACT);
    const listed = pool.filter((s) => s.media.mediaListEntry);
    if (exact.length && listed.length && !exact.some((s) => s.media.mediaListEntry)) {
      const ranks = STATUS_RANK[intent];
      listed.sort((a, b) => ranks[status(a.media)] - ranks[status(b.media)] || b.score - a.score || dateKey(a.media) - dateKey(b.media));
      return {
        kind: "ambiguous",
        candidates: [...exact, ...listed].slice(0, MAX_CANDIDATES).map((s) => s.media),
        why: `"${query}" is the title of a show that isn't on your list, and shows with that name in their title are.`,
      };
    }
  }
  // A season titled exactly as written, beside one that lacks its mark, is the one meant,
  // whatever either's list status (#73). Adding already goes by the title (see `pick`).
  const typed = pool.filter((s) => s.asTyped);
  if (intent !== "add" && typed.length === 1) {
    return { kind: "match", media: typed[0]!.media, why: "its title is written exactly that way" };
  }
  const { planned, ...picked } = pick(query, intent, pool);
  let r: Resolution = picked;
  if (planned) r = (await nextPlanned(q, planned, source, fetched, language)) ?? r;
  return r.kind === "match" ? keepNamedShow(query, q, intent, r, pool, source, fetched) : r;
}

/** matchScore for an exact title or synonym. */
const EXACT = 4;

/** Below EXACT: an exact match only once normalized, when another title matches as written (see `score`). */
const NORMALIZED_EXACT = EXACT - 0.5;

/** Intents that, without a season named, mean the show titled as asked over listed shows that only contain the words. */
function exactOnly(intent: Intent): boolean {
  return intent === "status" || intent === "rate";
}

/**
 * After finishing a show, an episode update means its next season, but only a sequel that
 * has started airing. Shows not on the list that match no better than the completed one
 * (a show sharing a word, an unaired sequel, the other version of a remake) are dropped,
 * so the update goes to the completed show and the episode rules say what happens (#35).
 */
async function keepCompleted(pool: Scored[], source: AnimeSource, fetched: Media[]): Promise<Scored[]> {
  const ranks = STATUS_RANK.progress;
  const completed = pool.filter((s) => status(s.media) === "COMPLETED");
  if (!completed.length || pool.some((s) => ranks[status(s.media)] < ranks.NONE)) return pool;
  const best = Math.max(...completed.map((s) => s.score));
  const remake = (s: Scored) => completed.some((c) => isRemake(s.media, c.media));
  const rivals = pool.filter((s) => status(s.media) === "NONE" && (s.score <= best || remake(s)));
  // Only an aired rival that isn't another version could be the next season: walk chains just for those.
  if (!rivals.some((s) => hasAired(s.media) && !remake(s))) return pool.filter((s) => !rivals.includes(s));
  // Only the best completed matches vouch for a sequel: a weaker one ("Alpha Side Story" when
  // "Alpha" is exact) can't hand the update to its own sequel.
  const anchors = completed.filter((s) => s.score === best).map((s) => s.media);
  const wanted = rivals.filter((s) => hasAired(s.media) && !remake(s)).map((s) => s.media.id);
  const sequels = await sequelsReached(anchors, wanted, source, fetched);
  return pool.filter((s) => !rivals.includes(s) || sequels.has(s.media.id));
}

/** Formats a sequel chain passes through when checking what follows what: series and movies. */
const CHAIN_FORMATS = new Set([...SERIES_FORMATS, "MOVIE"]);

/** Intents whose pick rests on list status, so a listed spin-off can outrank the show named (see `keepNamedShow`). */
const BY_STATUS = new Set<Intent>(["progress", "status", "show", "rate"]);

/** How many anime `showOf` takes in, and how many requests it may make for their relations. */
const SHOW_LIMIT = 25;
const SHOW_FETCHES = 2;

/**
 * List status chooses a season within one show, not between shows (R1.10). When the pick only
 * has the name in its title and isn't joined by sequels or prequels to the show titled exactly
 * as asked (a spin-off or side story: "KONOSUBA -An Explosion on This Wonderful World!" for
 * "konosuba"), its status settles it only when the named show has nothing left to watch, or when
 * the pick is the one being watched and the request isn't a rating. Otherwise ask. The same goes
 * for a pick that gave way to a show titled with the words (R1.11: "bocchi" for Loner Life in
 * Another World, "Hitoribocchi no Isekai Kouryaku").
 */
async function keepNamedShow(
  query: string,
  q: ParsedQuery,
  intent: Intent,
  r: Extract<Resolution, { kind: "match" }>,
  pool: Scored[],
  source: AnimeSource,
  fetched: Media[],
): Promise<Resolution> {
  if (!BY_STATUS.has(intent)) return r;
  const best = Math.max(...pool.map((s) => s.score));
  const chosen = pool.find((s) => s.media.id === r.media.id);
  if (!chosen || chosen.score === best || (best < NORMALIZED_EXACT && !chosen.yielded)) return r;
  // Settled without a look at relations: the season being watched takes an episode or a status
  // change (R1.4), and a title that is the name plus a season or part is that show's season.
  const watching = status(chosen.media) === "CURRENT" || status(chosen.media) === "REPEATING";
  // A pick that gave way has the name in a synonym, not a title: only its titles count.
  if ((watching && intent !== "rate") || titledAs(chosen.media, q, chosen.yielded)) return r;
  const named = pool.filter((s) => s.score === best).map((s) => s.media);
  // The list carries no relations; one search does, for every anime with the name in its title.
  const lookup = relationLookup(source, [...fetched, ...(await source.search(q.words.join(" ")))]);
  const show = await showOf(named, lookup);
  // A walk cut short can't tell what the named show has left, so the pick stands.
  if (!show || show.some((m) => m.id === chosen.media.id)) return r;
  const listed = new Map((await source.listMedia()).map((m) => [m.id, status(m)]));
  const left = leftToWatch(show, (m) => listed.get(m.id) ?? status(m), intent);
  if (!left) return r;
  return {
    kind: "ambiguous",
    candidates: [left, chosen.media],
    why: chosen.yielded
      ? `"${query}" is in the title of a show with more to watch, and a different show on your list only has it in another name or inside a word.`
      : `"${query}" is the title of a show with more to watch, and a different show on your list has that name in its title.`,
  };
}

/**
 * The named show: `named` and every aired anime joined to it through SEQUEL and PREQUEL edges
 * (its seasons, parts, movies, OVAs and specials, not its spin-offs). Relations come from what
 * this call already fetched, else one request per step of the walk that lacks them. Undefined
 * when the walk would take in more than SHOW_LIMIT anime or SHOW_FETCHES requests. `unaired`
 * collects the IDs of the unaired anime the walk reached and didn't walk past.
 */
async function showOf(named: Media[], lookup: ReturnType<typeof relationLookup>, unaired?: Set<number>): Promise<Media[] | undefined> {
  const seen = new Set(named.map((m) => m.id));
  let frontier = named.map((m) => m.id);
  const show: Media[] = [];
  let fetches = 0;
  while (frontier.length) {
    const missing = frontier.filter((id) => !lookup.known.get(id)?.relations);
    if (missing.length) {
      if (fetches++ >= SHOW_FETCHES) return undefined;
      await lookup.load(missing);
    }
    const next: number[] = [];
    for (const id of frontier) {
      const m = lookup.known.get(id);
      if (!m) continue;
      show.push(m);
      for (const e of m.relations?.edges ?? []) {
        if ((e.relationType !== "SEQUEL" && e.relationType !== "PREQUEL") || e.node.type !== "ANIME") continue;
        if (seen.has(e.node.id)) continue;
        seen.add(e.node.id);
        // Nothing past an unaired entry has aired either; status unknown counts as aired.
        if (e.node.status !== undefined && !hasAired({ status: e.node.status, startDate: e.node.startDate ?? null })) {
          unaired?.add(e.node.id);
          continue;
        }
        if (seen.size > SHOW_LIMIT) return undefined;
        next.push(e.node.id);
      }
    }
    frontier = next;
  }
  return show;
}

/**
 * Several planned seasons tie (R1.12). When they're seasons of one show, the next one to watch
 * is the earliest in sequel order, as long as every aired season before it is completed (or being
 * rewatched) on the list (a gap may be a season the user is watching but never logged). Only aired seasons are
 * taken; one that hasn't aired counts when the walk reaches it, and comes after them. Undefined,
 * so the caller asks, when none has aired, the walk can't join them all or reach every season
 * of the show, or the sequel order
 * doesn't put them in one line that agrees with the air dates (a prequel made later). Costs one
 * search (none when the call already made it) and at most SHOW_FETCHES relation fetches.
 */
async function nextPlanned(
  q: ParsedQuery,
  tied: Media[],
  source: AnimeSource,
  fetched: Media[],
  language: TitleLanguage,
): Promise<Extract<Resolution, { kind: "match" }> | undefined> {
  const aired = tied.filter(hasAired);
  if (!aired.length) return undefined;
  // The list carries no relations; one search does, for every anime with the name in its title.
  const lookup = relationLookup(source, [...fetched, ...(await source.search(q.words.join(" ")))]);
  const unaired = new Set<number>();
  const show = await showOf([aired[0]!], lookup, unaired);
  if (!show) return undefined;
  // A member whose relations didn't load (a list copy carries none) could hide a season before it.
  if (show.some((m) => !m.relations)) return undefined;
  const members = new Map(show.map((m) => [m.id, m]));
  if (!tied.every((m) => members.has(m.id) || unaired.has(m.id))) return undefined;
  // What follows what within the show, from the SEQUEL and PREQUEL edges either side carries.
  const sequels = new Map<number, Set<number>>(show.map((m) => [m.id, new Set<number>()]));
  for (const m of show) {
    for (const e of m.relations?.edges ?? []) {
      if ((e.relationType !== "SEQUEL" && e.relationType !== "PREQUEL") || e.node.type !== "ANIME") continue;
      // An anime the walk reached but couldn't load: a season there could be a gap, unseen.
      if (!members.has(e.node.id) && !unaired.has(e.node.id)) return undefined;
      if (!members.has(e.node.id)) continue;
      if (e.relationType === "SEQUEL") sequels.get(m.id)!.add(e.node.id);
      if (e.relationType === "PREQUEL") sequels.get(e.node.id)!.add(m.id);
    }
  }
  const after = (id: number): Set<number> => {
    const reached = new Set<number>();
    const stack = [...(sequels.get(id) ?? [])];
    while (stack.length) {
      const next = stack.pop()!;
      if (reached.has(next)) continue;
      reached.add(next);
      stack.push(...(sequels.get(next) ?? []));
    }
    return reached;
  };
  // One line: of every two, one follows the other and not back (no branch, no loop), and the
  // later one in sequel order didn't air first. The earliest is then the one with no other before it.
  const reach = new Map(aired.map((m) => [m.id, after(m.id)]));
  const follows = (a: Media, b: Media) => reach.get(b.id)!.has(a.id) && !reach.get(a.id)!.has(b.id) && dateKey(a) >= dateKey(b);
  if (!aired.every((a) => aired.every((b) => a === b || follows(a, b) || follows(b, a)))) return undefined;
  const first = aired.find((m) => aired.every((o) => o === m || follows(o, m)));
  if (!first) return undefined;
  const listed = new Map((await source.listMedia()).map((m) => [m.id, status(m)]));
  const before = show.filter((m) => m.id !== first.id && after(m.id).has(first.id) && isSeries(m) && hasAired(m));
  // A season before it that isn't watched (skipped in the list, dropped, or planned but not
  // tied): the user may be watching that one.
  if (before.some((m) => listed.get(m.id) !== "COMPLETED" && listed.get(m.id) !== "REPEATING")) return undefined;
  // The one right before it in sequel order, which isn't always the latest to air.
  const last = before.find((b) => !before.some((o) => o !== b && after(b.id).has(o.id)));
  return {
    kind: "match",
    media: first,
    why: last
      ? `it's on your plan-to-watch list and comes next after ${displayTitle(last.title, language)}`
      : "it's on your plan-to-watch list and comes first in the show",
  };
}

/**
 * What the named show has left to watch, the likeliest for `intent` first: an aired entry of it
 * on the list that isn't completed, else the first aired season that isn't on the list and
 * started after every entry that is (a gap in the list isn't a season left). Undefined when
 * everything that has aired is watched.
 */
function leftToWatch(show: Media[], statusOf: (m: Media) => Status, intent: Intent): Media | undefined {
  const aired = show.filter(hasAired);
  const ranks = STATUS_RANK[intent];
  const listed = aired.filter((m) => statusOf(m) !== "NONE");
  const unfinished = listed.filter((m) => statusOf(m) !== "COMPLETED");
  if (unfinished.length) return unfinished.sort((a, b) => ranks[statusOf(a)] - ranks[statusOf(b)] || dateKey(a) - dateKey(b))[0];
  const after = Math.max(-1, ...listed.map(dateKey));
  return aired.filter((m) => statusOf(m) === "NONE" && isSeries(m) && dateKey(m) > after).sort((a, b) => dateKey(a) - dateKey(b))[0];
}

/**
 * Which of `wanted` follow `from` through SEQUEL edges, movies included (season 1, the movie,
 * season 2). Stops once all are found or after 15 anime, fetching only what isn't known yet.
 */
async function sequelsReached(from: Media[], wanted: number[], source: AnimeSource, fetched: Media[]): Promise<Set<number>> {
  const { learn, full } = relationLookup(source, fetched);
  from.forEach(learn);
  const found = new Set<number>();
  const seen = new Set(from.map((m) => m.id));
  const queue = from.map((m) => m.id);
  while (queue.length && found.size < wanted.length && seen.size < 15) {
    const edges: RelationEdge[] = (await full(queue.shift()!))?.relations?.edges ?? [];
    for (const e of edges) {
      if (e.relationType !== "SEQUEL" || e.node.type !== "ANIME" || !CHAIN_FORMATS.has(e.node.format ?? "")) continue;
      if (seen.has(e.node.id)) continue;
      seen.add(e.node.id);
      queue.push(e.node.id);
      if (wanted.includes(e.node.id)) found.add(e.node.id);
    }
  }
  return found;
}

/** A pick, or a question; `planned` holds a tie between plan-to-watch entries that `nextPlanned` may settle. */
type Picked = Resolution & { planned?: Media[] };

/** Intents for which a tie between planned seasons of one show means the next one to watch (see `nextPlanned`). */
const NEXT_PLANNED = new Set<Intent>(["progress", "status", "show"]);

function pick(query: string, intent: Intent, pool: Scored[]): Picked {
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
    // A rating ignores the score between listed shows (which one was finished decides), but a
    // show that gave way still ranks after the one it gave way to. Between shows not on the
    // list, nothing else tells them apart: the better match is the one meant. A removal keeps asking.
    useScore || (intent === "rate" && status(s.media) === "NONE") ? -s.score : intent === "rate" ? Number(Boolean(s.yielded)) : 0,
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
  // Only a full tie (status, match and format) between planned seasons: never a remake, and
  // not between movies, OVAs or music videos.
  const planned =
    NEXT_PLANNED.has(intent) && status(top.media) === "PLANNING" && tied.length > 1 && tied.every((s) => isSeries(s.media))
      ? tied.map((s) => s.media)
      : undefined;

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

  // Shows that only contain the words, equally likely but for their format, are different
  // shows when they aren't one franchise ("Idol Jihen" and "Idol Ace" for "idol"): the format
  // decides between seasons and a movie of one show, not between shows.
  if (useScore && top.score < NORMALIZED_EXACT) {
    const alike = sorted.filter((s) => ranks[status(s.media)] === ranks[status(top.media)] && s.score === top.score);
    if (alike.length > 1 && !sameFranchise(alike.map((s) => s.media))) {
      return {
        kind: "ambiguous",
        candidates: alike.slice(0, MAX_CANDIDATES).map((s) => s.media),
        why: `"${query}" matches ${alike.length} shows equally well.`,
        // Titles that don't start alike may still be seasons of one show; not when formats differ.
        ...(planned && alike.length === tied.length && { planned }),
      };
    }
  }

  if (tied.length === 1) return { kind: "match", media: top.media, why: STATUS_WHY[status(top.media)] };

  // Several equally likely seasons of one franchise, none of them in progress on the list:
  // the earliest is the natural reading ("add Frieren" means season 1; after finishing
  // season 1, "watched episode 2 of Frieren" means season 2).
  if ((intent === "add" || status(top.media) === "NONE") && sameFranchise(tied.map((s) => s.media))) {
    const first = tied[0]!.media;
    // Only an episode update means "the next one to watch"; otherwise it's simply the earliest, season 1.
    const why = intent === "progress" ? "it's the next season, and not on your list yet" : "it's the first season";
    return { kind: "match", media: first, why };
  }

  return {
    kind: "ambiguous",
    candidates: tied.slice(0, MAX_CANDIDATES).map((s) => s.media),
    why: `"${query}" matches ${tied.length} shows equally well.`,
    ...(planned && { planned }),
  };
}

/** AniList statuses for something that has started airing. */
export const AIRED = new Set(["RELEASING", "FINISHED", "HIATUS"]);

function hasAired(m: Pick<Media, "status" | "startDate">): boolean {
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
  fetched: Media[],
  language: TitleLanguage,
): Promise<Resolution> {
  const picked = pickRoot(pool, query);
  if (!("root" in picked)) return picked;
  const { root } = picked;

  const entries = await seasonChain(root, Number.POSITIVE_INFINITY, source, fetched);
  const chain = entries.map((e) => e.media);

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
  const why = anchor >= 0 ? `it's the season after ${displayTitle(chain[anchor]!.title, language)}` : "it's the sequel to the first season";
  const part = q.hint.part;
  if (part === undefined) {
    const next = chain[anchor >= 0 ? anchor + 1 : 1];
    if (!next) {
      const after = anchor >= 0 ? chain[anchor]! : root;
      return { kind: "none", why: `AniList doesn't list a season after ${displayTitle(after.title, language)} yet.` };
    }
    return { kind: "match", media: next, why };
  }
  // "Next season part 2": that part of the season after the one started, or after season 1,
  // never another part or season (#63).
  const from = entries[Math.max(anchor, 0)]!;
  const next = entries.find((e, i) => i > Math.max(anchor, 0) && e.season > from.season);
  if (!next) return { kind: "none", why: `AniList doesn't list a season after ${displayTitle(from.media.title, language)} yet.` };
  const wanted = entries.find((e) => e.season === next.season && e.part === part);
  if (!wanted) {
    return { kind: "none", why: `AniList doesn't list a part ${part} of ${displayTitle(next.media.title, language)}.` };
  }
  return { kind: "match", media: wanted.media, why: part === next.part ? why : `${why}, part ${part}` };
}

interface SeasonEntry {
  media: Media;
  season: number;
  part: number;
}

/**
 * Anime with their relations: what this call already fetched (the list and search results,
 * which carry relations), fetching only the anime it lacks, two sequel steps per request.
 */
function relationLookup(source: AnimeSource, fetched: Media[]) {
  const known = new Map<number, Media>();
  const learn = (m: Media) => {
    const had = known.get(m.id);
    // Keep the copy that has relations, and the list entry from whichever copy has one.
    const keep = had?.relations && !m.relations ? had : m;
    known.set(m.id, { ...keep, mediaListEntry: m.mediaListEntry ?? had?.mediaListEntry ?? null });
  };
  fetched.forEach(learn);
  /** Fetches anime with their relations, and their related anime in full, in one request. */
  const load = async (ids: number[]) => {
    for (const m of await source.getRelated(ids)) {
      learn(m);
      for (const edge of m.relations?.edges ?? []) {
        const node = edge.node as RelationEdge["node"] & Partial<Media>;
        if (node.type === "ANIME" && node.relations) learn(node as Media);
      }
    }
  };
  /** The anime with its relations, fetching it (and its related anime, in full) if needed. */
  const full = async (id: number): Promise<Media | undefined> => {
    if (!known.get(id)?.relations) await load([id]);
    return known.get(id)?.relations ? known.get(id) : undefined;
  };
  return { known, learn, full, load };
}

/**
 * Seasons in sequel order from `root`, stopping after the first one past season `upTo`.
 * Walks what this call already fetched (`fetched`: the list and search results, which carry
 * relations) and fetches only the anime it lacks, two sequel steps per request.
 */
async function seasonChain(root: Media, upTo: number, source: AnimeSource, fetched: Media[]): Promise<SeasonEntry[]> {
  const { known, learn, full } = relationLookup(source, fetched);
  learn(root);

  const chain: SeasonEntry[] = [];
  let current: Media | undefined = known.get(root.id);
  let season = titleSeason(root) ?? 1;
  let part = titlePart(root) ?? 1;
  const seen = new Set<number>();
  while (current && !seen.has(current.id) && chain.length < 15) {
    seen.add(current.id);
    chain.push({ media: current, season, part });
    if (season > upTo) break;
    const edges: RelationEdge[] = (await full(current.id))?.relations?.edges ?? [];
    const sequel = edges.find(
      (e) => e.relationType === "SEQUEL" && e.node.type === "ANIME" && SERIES_FORMATS.has(e.node.format ?? ""),
    );
    if (!sequel) break;
    current = known.get(sequel.node.id) ?? (await full(sequel.node.id));
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
  fetched: Media[],
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
  // Seasons from the sequel chain are one show's by construction; titles may name different shows.
  let oneShow = false;

  // 2. Otherwise walk the sequel chain from season 1 ("Shingeki no Kyojin: The Final Season" is season 4).
  if (matches.length === 0 || wantSeason === 1) {
    const picked = pickRoot(pool, q.exact);
    if (!("root" in picked) && picked.kind === "ambiguous") return picked;
    const root = "root" in picked ? picked.root : undefined;
    if (root) {
      const chain = await seasonChain(root, wantSeason, source, fetched);
      const fromChain = chain.filter((e) => fits(e.season, e.part));
      if (fromChain.length) {
        matches = fromChain;
        how = "the sequel order on AniList";
        oneShow = true;
      }
    }
  }

  // 3. A part with no season ("the final season part 2"): titles like "The Final Season Part 2"
  // carry no season number (AniList's fan tags call it season 4), so match the part among the
  // titles that fit the words.
  if (matches.length === 0 && q.hint.season === undefined && q.hint.part !== undefined) {
    const part = q.hint.part;
    const ranks = STATUS_RANK[intent];
    const withPart = pool.filter((s) => titlePart(s.media) === part);
    const bestScore = Math.max(...withPart.map((s) => s.score));
    // Best word match first, then the list status the intent points at; a tie is ambiguous.
    const parts = withPart.filter((s) => s.score === bestScore).map((s) => s.media);
    const bestRank = Math.min(...parts.map((m) => ranks[status(m)]));
    const top = parts.filter((m) => ranks[status(m)] === bestRank);
    if (top.length === 1) {
      const m = top[0]!;
      const why = parts.length === 1 ? "going by its title" : `and ${STATUS_WHY[status(m)]}`;
      return { kind: "match", media: m, why: `it's part ${part}, ${why}` };
    }
    if (top.length > 1) {
      return {
        kind: "ambiguous",
        candidates: top.slice(0, MAX_CANDIDATES),
        why: `"${q.exact}" part ${part} matches ${top.length} shows.`,
      };
    }
  }

  // Name only what was asked: "part 5" alone is not "season 1 part 5".
  const label = [
    q.hint.season !== undefined ? `season ${q.hint.season}` : "",
    q.hint.part !== undefined ? `part ${q.hint.part}` : "",
  ].filter(Boolean).join(" ") || `season ${wantSeason}`;
  // "the part of part 2" and "the first part of part 2" read wrong: a part-only request already names the part.
  const partOnly = q.hint.season === undefined && q.hint.part !== undefined;
  if (matches.length === 0) {
    return { kind: "none", why: `Couldn't find ${label} of "${q.exact}" on AniList.` };
  }
  if (matches.length === 1) {
    return { kind: "match", media: matches[0]!.media, why: `it's ${label}, going by ${how}` };
  }

  // Removing deletes a list entry, so it never guesses between listed parts of one season:
  // "season 1" doesn't say whether Part 1 or Part 2 should go.
  if (intent === "remove") {
    const listed = matches.filter((e) => e.media.mediaListEntry);
    if (listed.length === 1) {
      return { kind: "match", media: listed[0]!.media, why: partOnly ? `it's ${label}, the one on your list` : `it's the part of ${label} on your list` };
    }
    if (listed.length > 1) {
      listed.sort((a, b) => a.part - b.part || dateKey(a.media) - dateKey(b.media));
      return {
        kind: "ambiguous",
        candidates: listed.slice(0, MAX_CANDIDATES).map((e) => e.media),
        why: `${label[0]!.toUpperCase()}${label.slice(1)} of "${q.exact}" matches ${listed.length} entries on your list.`,
      };
    }
  }

  // Several parts of the same season: prefer the one the intent points at, else the first part.
  const ranks = STATUS_RANK[intent];
  matches.sort((a, b) => ranks[status(a.media)] - ranks[status(b.media)] || a.part - b.part || dateKey(a.media) - dateKey(b.media));
  let best = matches[0]!;
  // "Love Live! 2nd Season" and "Love Live! Sunshine!! 2nd Season" are both season 2 of
  // something, not two parts of one season: ask which show (#62), unless only one is
  // titled as asked ("Sword Art Online II", not "Sword Art Online Alternative: ... II").
  if (!oneShow) {
    const likeliest = matches.filter((e) => ranks[status(e.media)] === ranks[status(best.media)]).map((e) => e.media);
    const shows = likeliest.length > 1 ? await showGroups(likeliest, source, fetched) : [];
    const titled = shows.filter((g) => g.some((m) => titledAs(m, q)));
    if (titled.length === 1) best = matches.find((e) => e.media === titled[0]![0])!;
    else if (shows.length > 1) {
      return {
        kind: "ambiguous",
        candidates: shows.slice(0, MAX_CANDIDATES).map((g) => g[0]!),
        why: `${label[0]!.toUpperCase()}${label.slice(1)} of "${q.exact}" matches ${shows.length} shows.`,
      };
    }
  }
  const why =
    status(best.media) === "NONE"
      ? partOnly
        ? `it's ${label}, the earliest that fits`
        : `it's the first part of ${label}`
      : `it's ${label} and ${STATUS_WHY[status(best.media)]}`;
  return { kind: "match", media: best.media, why };
}

/** Relations that keep two anime within one show: its seasons and parts, and side stories of them. */
const SAME_SHOW = new Set(["SEQUEL", "PREQUEL", "SIDE_STORY", "PARENT"]);

/**
 * `items` grouped by show: anime joined, directly or through each other, by `SAME_SHOW` edges
 * (the parts of one season, a season's side story), in the order each group first appears.
 * Each group's anime keep their order in `items`. A remake or spin-off is a different show.
 */
async function showGroups(items: Media[], source: AnimeSource, fetched: Media[]): Promise<Media[][]> {
  const { full } = relationLookup(source, fetched);
  const ids = new Set(items.map((m) => m.id));
  const linked = new Map<number, Set<number>>(items.map((m) => [m.id, new Set<number>()]));
  for (const m of items) {
    for (const e of (await full(m.id))?.relations?.edges ?? []) {
      if (!SAME_SHOW.has(e.relationType) || !ids.has(e.node.id)) continue;
      linked.get(m.id)!.add(e.node.id);
      linked.get(e.node.id)!.add(m.id);
    }
  }
  const group = new Map<number, number>();
  for (const m of items) {
    if (group.has(m.id)) continue;
    const stack = [m.id];
    while (stack.length) {
      const id = stack.pop()!;
      if (group.has(id)) continue;
      group.set(id, m.id);
      stack.push(...linked.get(id)!);
    }
  }
  const groups = new Map<number, Media[]>();
  for (const m of items) {
    const key = group.get(m.id)!;
    if (groups.has(key)) groups.get(key)!.push(m);
    else groups.set(key, [m]);
  }
  return [...groups.values()];
}

/**
 * A title with the query's words once season and part words are left out ("My Hero Academia
 * Season 2", "Mob Psycho 100 II"). Words, not `exact`, so "the second season of sword art
 * online" compares like "sword art online season 2". `own` leaves out synonyms.
 */
function titledAs(m: Media, q: ParsedQuery, own = false): boolean {
  const asked = q.words.join(" ");
  return names(m, own).some((name) => parseQuery(name.replace(/ (?:ii|iii|iv|v|vi)$/, "")).words.join(" ") === asked);
}

/** True when one of the show's titles is, or starts with, this number ("86", "86 Part 2"), not just contains it. */
export function titledWithNumber(m: Media, digits: string): boolean {
  return names(m).some((name) => name === digits || name.startsWith(`${digits} `));
}

/** A candidate as the user would tell it apart: "Attack on Titan (Shingeki no Kyojin) (TV, 2013), on your list: completed". */
export function candidateLabel(m: Media, language: TitleLanguage): string {
  const meta = [m.format, m.seasonYear].filter(Boolean).join(", ");
  const entry = m.mediaListEntry ? `on your list: ${m.mediaListEntry.status.toLowerCase()}` : "not on your list";
  return `${bothTitles(m.title, language)}${meta ? ` (${meta})` : ""}, ${entry}`;
}

/** Candidates keep a second title: the user may know the show by either name. */
export function describeCandidates(candidates: Media[], language: TitleLanguage): string {
  return candidates.map((m) => `[${m.id}] ${candidateLabel(m, language)}`).join("\n");
}
