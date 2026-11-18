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
import { AniListClient, type FetchFn } from "./anilist";
import { OAuthServer, sha256, type OAuthConfig } from "./oauth";
import { createServer, UserState } from "./server";
import { HOSTED_RENEW } from "./token";

/** Sessions and users idle this long are dropped (the client starts a new session if it comes back). */
export const IDLE_MS = 60 * 60_000;

/** Open sessions one user may have; opening another closes their least recently used. */
export const MAX_SESSIONS = 20;

/**
 * Largest request body accepted. Real requests (registration, token exchange, consent, MCP
 * messages) are a few kilobytes; Bun's default of 128 MB would let anyone, signed in or not,
 * make the server buffer huge requests. Larger bodies get 413.
 */
export const MAX_BODY_BYTES = 1024 * 1024;

/** Options for `Bun.serve`. */
export const SERVE_OPTIONS = {
  // Refuses a body whose Content-Length is too large before reading it.
  maxRequestBodySize: MAX_BODY_BYTES,
  // Streams send a keep-alive every 15 seconds; Bun's default of 10 would cut them off.
  idleTimeout: 60,
};

export interface HttpOptions {
  /** For AniList's GraphQL API and its token endpoint; tests pass a fake. */
  fetch?: FetchFn;
  now?: () => number;
}

interface Account {
  client: AniListClient;
  user: UserState;
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

/**
 * Reads the body into memory, keeping at most MAX_BODY_BYTES; null if it was larger. Bun's
 * maxRequestBodySize doesn't apply to chunked bodies, which have no Content-Length. An oversized
 * body is still read to its end (and dropped): answering mid-upload lets the client reuse the
 * connection with the rest of the body unsent, and its next request then gets a 400.
 */
async function capBody(req: Request): Promise<Request | null> {
  if (!req.body) return req;
  const chunks: Uint8Array[] = [];
  let size = 0;
  for await (const chunk of req.body) {
    size += chunk.byteLength;
    if (size <= MAX_BODY_BYTES) chunks.push(chunk);
    else chunks.length = 0;
  }
  if (size > MAX_BODY_BYTES) return null;
  // Framing headers described the original stream, not this buffer.
  const headers = new Headers(req.headers);
  headers.delete("content-length");
  headers.delete("transfer-encoding");
  return new Request(req.url, { method: req.method, headers, body: Buffer.concat(chunks), signal: req.signal });
}

function rpcError(status: number, message: string, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify({ jsonrpc: "2.0", error: { code: -32000, message }, id: null }), {
    status,
    headers: { "Content-Type": "application/json", ...headers },
  });
}

export async function createHttpApp(config: OAuthConfig, options: HttpOptions = {}) {
  const now = options.now ?? Date.now;
  const oauth = await OAuthServer.create(config, { fetch: options.fetch, now });
  const accounts = new Map<string, Account>();
  const sessions = new Map<string, Session>();
  /**
   * Users whose AniList token AniList has rejected, with when it first did: their access
   * token is refused, so the client signs in again. Forgotten after IDLE_MS, after which a
   * retry asks AniList again.
   */
  const rejected = new Map<string, number>();

  function account(key: string, token: string): Account {
    let found = accounts.get(key);
    if (!found) {
      const client = new AniListClient(token, options.fetch);
      client.renew = HOSTED_RENEW;
      found = { client, user: new UserState(), lastUsed: now() };
      accounts.set(key, found);
    }
    found.lastUsed = now();
    return found;
  }

  async function close(id: string): Promise<void> {
    const session = sessions.get(id);
    sessions.delete(id);
    await session?.transport.close().catch(() => {});
  }

  /** Closes idle sessions and forgets idle users. */
  async function sweep(): Promise<void> {
    const cutoff = now() - IDLE_MS;
    for (const [id, s] of sessions) {
      if (s.lastUsed <= cutoff) await close(id);
    }
    const active = new Set([...sessions.values()].map((s) => s.account));
    for (const [key, a] of accounts) if (a.lastUsed <= cutoff && !active.has(key)) accounts.delete(key);
    for (const [key, since] of rejected) if (since <= cutoff) rejected.delete(key);
  }

  async function mcp(req: Request): Promise<Response> {
    const auth = req.headers.get("Authorization");
    const bearer = auth?.match(/^Bearer\s+(.+)$/i)?.[1]?.trim() ?? null;
    const token = await oauth.anilistToken(bearer);
    const key = token && (await sha256(token));
    if (key && (rejected.has(key) || accounts.get(key)?.client.rejected)) {
      // Sign the user out here too, so the client asks them to sign in again.
      // Kept from the first refusal, so a client that keeps retrying still gets a fresh check after IDLE_MS.
      if (!rejected.has(key)) rejected.set(key, now());
      accounts.delete(key);
      for (const [id, s] of sessions) if (s.account === key) await close(id);
    }
    if (!token || !key || rejected.has(key)) {
      return rpcError(401, bearer ? "Invalid or expired access token; sign in again." : "Sign in with AniList first.", {
        "WWW-Authenticate": oauth.challenge(bearer ? "invalid_token" : undefined),
      });
    }
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
    const server = createServer(user.client, { now, user: user.user, hosted: true });
    const transport: WebStandardStreamableHTTPServerTransport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: () => crypto.randomUUID(),
      onsessioninitialized: (id) => {
        sessions.set(id, { transport, server, account: key, lastUsed: now() });
        // Counted when the session joins, with no wait in between, so parallel requests can't all slip under the cap.
        const open = [...sessions].filter(([, s]) => s.account === key).sort(([, a], [, b]) => a.lastUsed - b.lastUsed);
        for (const [old] of open.slice(0, Math.max(0, open.length - MAX_SESSIONS))) void close(old);
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
        case "/favicon.svg":
          return new Response(Bun.file(new URL("../assets/icon.svg", import.meta.url)), {
            headers: { "Content-Type": "image/svg+xml" },
          });
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
      if (pathname === "/authorize") return oauth.approve(req);
      if (pathname === "/token") return oauth.token(req);
    }
    return new Response("Not found\n", { status: 404 });
  }

  return {
    oauth,
    /** Open sessions, signed-in users and refused tokens, for tests. */
    stats: () => ({ sessions: sessions.size, accounts: accounts.size, rejected: rejected.size }),
    sweep,
    async fetch(req: Request): Promise<Response> {
      try {
        const capped = await capBody(req);
        if (!capped) return withCors(new Response("Request body too large\n", { status: 413 }));
        return withCors(await route(capped));
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
  if (url.protocol !== "https:" && !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)) {
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
    ...SERVE_OPTIONS,
    port: Number(process.env.PORT) || 3000,
    fetch: app.fetch,
  });
  console.error(`AniConnect listening on port ${server.port}; MCP endpoint ${app.oauth.resource}`);
  console.error(`AniList client redirect URL must be ${app.oauth.callbackUrl}`);
}
