#!/usr/bin/env bun
/**
 * The hosted server (requirement R7.2): AniConnect over MCP's Streamable HTTP transport, with
 * "Sign in with AniList" instead of a pasted token, so it works as a remote connector in
 * claude.ai and on mobile. Run it with `bun src/http.ts`; see the README for the settings.
 *
 * Each signed-in user gets one AniList client (so the list cache serves all their
 * conversations) and one undo history. Each MCP session gets its own server on top.
 */
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { AniListClient } from "./anilist";
import { OAuthServer, type OAuthConfig } from "./oauth";
import { createServer } from "./server";
import { HOSTED_RENEW } from "./token";
import { Journal } from "./undo";

type FetchFn = (input: string, init: RequestInit) => Promise<Response>;

/** Sessions and users idle this long are dropped (the client starts a new session if it comes back). */
export const IDLE_MS = 60 * 60_000;

export interface HttpOptions {
  /** For AniList's GraphQL API and its token endpoint; tests pass a fake. */
  fetch?: FetchFn;
  now?: () => number;
}

interface Account {
  client: AniListClient;
  journal: Journal;
  lastUsed: number;
}

interface Session {
  transport: WebStandardStreamableHTTPServerTransport;
  server: McpServer;
  account: string;
  lastUsed: number;
}

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Authorization, Content-Type, Mcp-Session-Id, Mcp-Protocol-Version, Last-Event-ID",
  "Access-Control-Expose-Headers": "Mcp-Session-Id, WWW-Authenticate",
  "Access-Control-Max-Age": "86400",
};

/** Bearer tokens travel in headers, never cookies, so any origin may call (browser-based clients need this). */
function withCors(res: Response): Response {
  const headers = new Headers(res.headers);
  for (const [k, v] of Object.entries(CORS)) headers.set(k, v);
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
}

function rpcError(status: number, message: string, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify({ jsonrpc: "2.0", error: { code: -32000, message }, id: null }), {
    status,
    headers: { "Content-Type": "application/json", ...headers },
  });
}

async function hash(text: string): Promise<string> {
  return Buffer.from(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text))).toString("base64url");
}

export async function createHttpApp(config: OAuthConfig, options: HttpOptions = {}) {
  const now = options.now ?? Date.now;
  const oauth = await OAuthServer.create(config, { fetch: options.fetch, now });
  const accounts = new Map<string, Account>();
  const sessions = new Map<string, Session>();

  function account(key: string, token: string): Account {
    let found = accounts.get(key);
    if (!found) {
      const client = new AniListClient(token, options.fetch);
      client.renew = HOSTED_RENEW;
      found = { client, journal: new Journal(), lastUsed: now() };
      accounts.set(key, found);
    }
    found.lastUsed = now();
    return found;
  }

  /** Closes idle sessions and forgets idle users. */
  async function sweep(): Promise<void> {
    const cutoff = now() - IDLE_MS;
    for (const [id, s] of sessions) {
      if (s.lastUsed > cutoff) continue;
      sessions.delete(id);
      await s.transport.close().catch(() => {});
    }
    const active = new Set([...sessions.values()].map((s) => s.account));
    for (const [key, a] of accounts) if (a.lastUsed <= cutoff && !active.has(key)) accounts.delete(key);
  }

  async function mcp(req: Request): Promise<Response> {
    const auth = req.headers.get("Authorization");
    const bearer = auth?.match(/^Bearer\s+(.+)$/i)?.[1]?.trim() ?? null;
    const token = await oauth.anilistToken(bearer);
    if (!token) {
      return rpcError(401, bearer ? "Invalid or expired access token; sign in again." : "Sign in with AniList first.", {
        "WWW-Authenticate": oauth.challenge(bearer ? "invalid_token" : undefined),
      });
    }
    const key = await hash(token);
    const sessionId = req.headers.get("Mcp-Session-Id");

    if (sessionId) {
      const session = sessions.get(sessionId);
      // Another user's session looks the same as an unknown one.
      if (!session || session.account !== key) return rpcError(404, "Session not found; start a new one.");
      session.lastUsed = now();
      account(key, token);
      return session.transport.handleRequest(req);
    }

    if (req.method !== "POST") return rpcError(400, "Start a session with an initialize request first.");
    let body: unknown;
    try {
      body = await req.json();
    } catch {
      return new Response(JSON.stringify({ jsonrpc: "2.0", error: { code: -32700, message: "Parse error" }, id: null }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      });
    }
    const messages = Array.isArray(body) ? body : [body];
    if (!messages.some((m) => isInitializeRequest(m))) {
      return rpcError(400, "Start a session with an initialize request first.");
    }

    const user = account(key, token);
    const server = createServer(user.client, { now, journal: user.journal });
    const transport: WebStandardStreamableHTTPServerTransport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: () => crypto.randomUUID(),
      onsessioninitialized: (id) => {
        sessions.set(id, { transport, server, account: key, lastUsed: now() });
      },
      onsessionclosed: (id) => {
        sessions.delete(id);
      },
    });
    transport.onclose = () => {
      if (transport.sessionId) sessions.delete(transport.sessionId);
    };
    await server.connect(transport);
    return transport.handleRequest(req, { parsedBody: body });
  }

  async function route(req: Request): Promise<Response> {
    const { pathname } = new URL(req.url);
    if (req.method === "OPTIONS") return new Response(null, { status: 204 });
    if (pathname === "/mcp") return mcp(req);
    if (req.method === "GET") {
      switch (pathname) {
        case "/.well-known/oauth-protected-resource":
        case "/.well-known/oauth-protected-resource/mcp":
          return oauth.resourceMetadata();
        case "/.well-known/oauth-authorization-server":
          return oauth.serverMetadata();
        case "/authorize":
          return oauth.authorize(req);
        case "/oauth/callback":
          return oauth.callback(req);
        case "/":
          return new Response(
            `AniConnect: an MCP server for your AniList anime list.\nAdd ${oauth.resource} to your MCP client as a remote (custom) connector, then sign in with AniList.\n`,
            { headers: { "Content-Type": "text/plain; charset=utf-8" } },
          );
      }
    }
    if (req.method === "POST") {
      if (pathname === "/register") return oauth.register(req);
      if (pathname === "/token") return oauth.token(req);
    }
    return new Response("Not found\n", { status: 404 });
  }

  return {
    oauth,
    /** Open sessions and signed-in users, for tests. */
    stats: () => ({ sessions: sessions.size, accounts: accounts.size }),
    sweep,
    async fetch(req: Request): Promise<Response> {
      try {
        return withCors(await route(req));
      } catch (err) {
        // Never echo request data (it may hold tokens); the message is enough to debug.
        console.error(`AniConnect: ${req.method} ${new URL(req.url).pathname} failed:`, (err as Error).message);
        return withCors(new Response("Internal error\n", { status: 500 }));
      }
    },
  };
}

/** Reads the settings from the environment, with a message naming whatever is missing. */
export function configFromEnv(env: Record<string, string | undefined> = process.env): OAuthConfig {
  const missing: string[] = [];
  const get = (name: string) => {
    const value = env[name]?.trim();
    if (!value) missing.push(name);
    return value ?? "";
  };
  const config: OAuthConfig = {
    publicUrl: get("PUBLIC_URL"),
    anilistClientId: get("ANILIST_CLIENT_ID"),
    anilistClientSecret: get("ANILIST_CLIENT_SECRET"),
    authSecret: get("AUTH_SECRET"),
  };
  if (missing.length) throw new Error(`Set ${missing.join(", ")} (see the README, "Hosting").`);
  if (config.authSecret.length < 32) throw new Error("AUTH_SECRET must be at least 32 characters (try `openssl rand -base64 32`).");
  let url: URL;
  try {
    url = new URL(config.publicUrl);
  } catch {
    throw new Error(`PUBLIC_URL isn't a URL: ${config.publicUrl}`);
  }
  if (url.protocol !== "https:" && !["localhost", "127.0.0.1"].includes(url.hostname)) {
    throw new Error("PUBLIC_URL must be https (http is allowed only for localhost).");
  }
  return config;
}

if (import.meta.main) {
  let config: OAuthConfig;
  try {
    config = configFromEnv();
  } catch (err) {
    console.error(`AniConnect: ${(err as Error).message}`);
    process.exit(1);
  }
  const app = await createHttpApp(config);
  setInterval(() => void app.sweep(), 10 * 60_000).unref();
  const server = Bun.serve({
    port: Number(process.env.PORT) || 3000,
    // Streams send a keep-alive every 15 seconds; Bun's default of 10 would cut them off.
    idleTimeout: 60,
    fetch: app.fetch,
  });
  console.error(`AniConnect listening on port ${server.port}; MCP endpoint ${app.oauth.resource}`);
  console.error(`AniList client redirect URL must be ${app.oauth.callbackUrl}`);
}
