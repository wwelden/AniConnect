/**
 * The MCP servers the evals can run against (R6.4): AniConnect, and other AniList servers
 * for a side-by-side score. Each is started by the `claude` CLI with its AniList requests
 * sent to the fake AniList at `anilistUrl`.
 */
import { join } from "node:path";

export interface EvalServer {
  /** The MCP server's name in the client, so its tools are `mcp__<key>__<tool>`. */
  key: string;
  command: string;
  args: string[];
  env: (anilistUrl: string) => Record<string, string>;
}

const REDIRECT = join(import.meta.dir, "anilist-redirect.cjs");

/** The fake accepts any token; this one is long enough to pass servers' "looks like a real token" checks. */
const TOKEN = `eval-${"0".repeat(120)}`;

/** Env for a Node server that reaches AniList on its own: a token, and its requests redirected to the fake. */
function nodeEnv(anilistUrl: string, extra: Record<string, string> = {}) {
  return {
    ANILIST_TOKEN: TOKEN,
    FAKE_ANILIST_URL: anilistUrl,
    NODE_OPTIONS: `--require ${REDIRECT}`,
    PATH: process.env.PATH ?? "",
    HOME: process.env.HOME ?? "",
    ...extra,
  };
}

export const SERVERS: Record<string, EvalServer> = {
  aniconnect: {
    key: "aniconnect",
    command: "bun",
    args: [join(import.meta.dir, "fake-server.ts")],
    env: (anilistUrl) => ({ ANILIST_URL: anilistUrl }),
  },
  // github.com/gavxm/ani-mcp
  "ani-mcp": {
    key: "animcp",
    command: "npx",
    args: ["-y", "ani-mcp@0.15.7"],
    env: (anilistUrl) => nodeEnv(anilistUrl, { ANILIST_USERNAME: "tester" }),
  },
  // github.com/yuna0x0/anilist-mcp
  "anilist-mcp": {
    key: "anilistmcp",
    command: "npx",
    args: ["-y", "anilist-mcp@1.4.0"],
    env: (anilistUrl) => nodeEnv(anilistUrl),
  },
};
