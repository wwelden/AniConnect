import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { AniListClient, LIST_STATUSES, type ListStatus, type Media } from "./anilist";
import {
  describeEntry,
  displayTitle,
  formatScore,
  matchesTitle,
  planProgress,
  statusLabel,
  toRawScore,
} from "./logic";
import { describeCandidates, resolveAnime, type AnimeSource, type Intent } from "./resolve";

const anime = z
  .union([z.string().min(1), z.number().int().positive()])
  .describe(
    'The show, as the user said it: any title, abbreviation or season ("jjk", "spy x family season 2", "Frieren"), or an AniList ID. No need to search first.',
  );

const status = z
  .enum(LIST_STATUSES)
  .describe(
    "CURRENT = watching, PLANNING = plan to watch, COMPLETED, DROPPED, PAUSED, REPEATING = rewatching",
  );

/** Appended to every tool that changes the list (requirement R2.2: one call per request). */
const BY_NAME =
  " Pass the show the way the user said it (\"jjk\", \"spy x family season 2\"): this tool works out the right AniList entry and season from the user's list, so don't search first. If the name is ambiguous, nothing changes and the candidates come back to ask about.";

type ToolResult = { content: { type: "text"; text: string }[]; isError?: boolean };

function text(body: string): ToolResult {
  return { content: [{ type: "text", text: body }] };
}

/** Turns thrown errors into tool errors the model can read and recover from. */
function safe<A>(fn: (args: A) => Promise<ToolResult>) {
  return async (args: A): Promise<ToolResult> => {
    try {
      return await fn(args);
    } catch (err) {
      return { content: [{ type: "text", text: (err as Error).message }], isError: true };
    }
  };
}

export function clientSource(client: AniListClient): AnimeSource {
  return {
    listMedia: async () =>
      (await client.getMyList()).map(({ media, ...entry }) => ({ ...media, mediaListEntry: entry })),
    search: (query) => client.searchAnime(query, 15),
    getMany: (ids) => client.getMany(ids),
  };
}

/** Finds the show a tool call is about, or throws a message that tells the assistant what to do. */
async function target(
  client: AniListClient,
  input: string | number,
  intent: Intent,
): Promise<{ media: Media; note: string }> {
  if (typeof input === "number" || /^\d+$/.test(input.trim())) {
    return { media: await client.getAnime(Number(input)), note: "" };
  }
  const r = await resolveAnime(input, intent, clientSource(client));
  if (r.kind === "match") {
    return { media: r.media, note: `Matched "${input}" to ${displayTitle(r.media.title)}: ${r.why}.\n` };
  }
  if (r.kind === "ambiguous") {
    throw new Error(
      `Nothing was changed. ${r.why} Ask the user which one they mean, then call again with its ID:\n${describeCandidates(r.candidates)}`,
    );
  }
  throw new Error(`Nothing was changed. ${r.why} Try search_anime with a different spelling.`);
}

export function createServer(client: AniListClient): McpServer {
  const server = new McpServer({ name: "aniconnect", version: "0.2.0" });

  server.registerTool(
    "search_anime",
    {
      title: "Search AniList",
      description:
        "Search all of AniList for anime by title, for when the user wants to find or compare shows. Returns IDs, and whether each show is already on the user's list. Tools that change the list take names directly and don't need this first.",
      inputSchema: {
        query: z.string().min(1).describe("Title to search for, in English, romaji or Japanese"),
        limit: z.number().int().min(1).max(25).default(5),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    safe(async ({ query, limit }) => {
      const [viewer, results] = await Promise.all([
        client.getViewer(),
        client.searchAnime(query, limit),
      ]);
      if (results.length === 0) return text(`No anime found for "${query}".`);
      return text(results.map((m) => describeEntry(m, m.mediaListEntry, viewer.scoreFormat)).join("\n"));
    }),
  );

  server.registerTool(
    "search_my_list",
    {
      title: "Search my list",
      description:
        "Answer questions about the user's own AniList anime list (what they're watching, whether something is on it). Filter by title words and/or list status; leave query empty to list everything in a status. Tools that change the list take names directly and don't need this first.",
      inputSchema: {
        query: z.string().optional().describe("Words that must all appear in the title"),
        status: status.optional(),
        limit: z.number().int().min(1).max(200).default(50),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    safe(async ({ query, status, limit }) => {
      const viewer = await client.getViewer();
      const entries = (await client.getMyList(status)).filter(
        (e) => !query || matchesTitle(e.media, query),
      );
      const filter = [query && `"${query}"`, status && statusLabel(status)].filter(Boolean).join(", ");
      if (entries.length === 0) {
        return text(`Nothing on ${viewer.name}'s list${filter ? ` matching ${filter}` : ""}.`);
      }
      entries.sort((a, b) => displayTitle(a.media.title).localeCompare(displayTitle(b.media.title)));
      const shown = entries.slice(0, limit);
      const lines = shown.map((e) => describeEntry(e.media, e, viewer.scoreFormat));
      const header = `${entries.length} match${entries.length === 1 ? "" : "es"} on ${viewer.name}'s list${filter ? ` for ${filter}` : ""}${entries.length > limit ? ` (showing ${limit})` : ""}:`;
      return text([header, ...lines].join("\n"));
    }),
  );

  server.registerTool(
    "add_to_list",
    {
      title: "Add to list",
      description:
        "Add an anime to the user's list (plan to watch by default). If it is already on the list, nothing changes; use set_status to move it." + BY_NAME,
      inputSchema: { anime, status: status.default("PLANNING") },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    safe(async ({ anime, status }) => {
      const [viewer, { media, note }] = await Promise.all([client.getViewer(), target(client, anime, "add")]);
      if (media.mediaListEntry) {
        return text(
          `${note}Already on your list, unchanged: ${describeEntry(media, media.mediaListEntry, viewer.scoreFormat)}`,
        );
      }
      const saved = await client.saveEntry({
        mediaId: media.id,
        status,
        ...(status === "COMPLETED" && media.episodes ? { progress: media.episodes } : {}),
      });
      return text(`${note}Added: ${describeEntry(saved.media, saved, viewer.scoreFormat)}`);
    }),
  );

  server.registerTool(
    "set_status",
    {
      title: "Set list status",
      description:
        "Change an anime's status on the user's list (watching, completed, dropped, ...). Adds it to the list if it isn't there yet." + BY_NAME,
      inputSchema: { anime, status },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    safe(async ({ anime, status }) => {
      const [viewer, { media, note }] = await Promise.all([client.getViewer(), target(client, anime, "status")]);
      const markCompleted = status === "COMPLETED" && media.episodes;
      const saved = await client.saveEntry({
        mediaId: media.id,
        status,
        ...(markCompleted ? { progress: media.episodes! } : {}),
      });
      const before = media.mediaListEntry ? statusLabel(media.mediaListEntry.status) : "not on list";
      return text(
        `${note}${before} -> ${statusLabel(status as ListStatus)}: ${describeEntry(saved.media, saved, viewer.scoreFormat)}`,
      );
    }),
  );

  server.registerTool(
    "rate_anime",
    {
      title: "Rate anime",
      description:
        "Rate an anime on the user's list. The score is always out of 10 (decimals like 7.5 allowed; 0 clears the rating), and AniList shows it in the user's own scoring format. Adds the show to the list if needed." + BY_NAME,
      inputSchema: {
        anime,
        score: z.number().min(0).max(10).describe("Score out of 10. 0 removes the rating."),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    safe(async ({ anime, score }) => {
      const scoreRaw = toRawScore(score);
      const [viewer, { media, note }] = await Promise.all([client.getViewer(), target(client, anime, "rate")]);
      const saved = await client.saveEntry({ mediaId: media.id, scoreRaw });
      return text(
        `${note}Rated ${displayTitle(saved.media.title)}: ${formatScore(saved.displayScore, viewer.scoreFormat)}`,
      );
    }),
  );

  const applyProgress = async (input: string | number, next: (current: number) => number) => {
    const [viewer, { media, note }] = await Promise.all([client.getViewer(), target(client, input, "progress")]);
    const entry = media.mediaListEntry;
    const before = entry?.progress ?? 0;
    const plan = planProgress(media, entry, next(before));
    const saved = await client.saveEntry({ mediaId: media.id, ...plan });
    const statusNote = plan.status ? ` Status is now ${statusLabel(plan.status)}.` : "";
    return text(
      `${note}${displayTitle(saved.media.title)}: episode ${before} -> ${saved.progress}.${statusNote}\n${describeEntry(saved.media, saved, viewer.scoreFormat)}`,
    );
  };

  server.registerTool(
    "mark_episodes_watched",
    {
      title: "Mark episodes watched",
      description:
        "Mark the next episode(s) of an anime as watched, counting up from the user's current progress. Finishing the last episode marks the show completed; watching something planned, paused or dropped moves it to watching." + BY_NAME,
      inputSchema: {
        anime,
        count: z.number().int().min(1).default(1).describe("How many more episodes were watched"),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    safe(async ({ anime, count }) => applyProgress(anime, (current) => current + count)),
  );

  server.registerTool(
    "set_progress",
    {
      title: "Set episode progress",
      description:
        "Set exactly how many episodes of an anime the user has watched (e.g. 'I'm on episode 7' -> 7). Same completion rules as mark_episodes_watched." + BY_NAME,
      inputSchema: {
        anime,
        episodes: z.number().int().min(0).describe("Total episodes watched so far"),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    safe(async ({ anime, episodes }) => applyProgress(anime, () => episodes)),
  );

  server.registerTool(
    "remove_from_list",
    {
      title: "Remove from list",
      description:
        "Delete an anime from the user's list, including its progress, score and dates. Confirm with the user first." + BY_NAME,
      inputSchema: { anime },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
    },
    safe(async ({ anime }) => {
      const { media } = await target(client, anime, "remove");
      if (!media.mediaListEntry) return text(`${displayTitle(media.title)} isn't on your list.`);
      const deleted = await client.deleteEntry(media.mediaListEntry.id);
      return text(
        deleted
          ? `Removed ${displayTitle(media.title)} from your list.`
          : `AniList did not delete ${displayTitle(media.title)}.`,
      );
    }),
  );

  return server;
}
