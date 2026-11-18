/**
 * The hosted server (R7.2) over real HTTP: the MCP SDK's own OAuth client discovers it,
 * registers, signs in through a stand-in for AniList's sign-in page, and calls tools.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { UnauthorizedError, type OAuthClientProvider } from "@modelcontextprotocol/sdk/client/auth.js";
import type { OAuthClientInformationMixed, OAuthTokens } from "@modelcontextprotocol/sdk/shared/auth.js";
import { configFromEnv, createHttpApp, IDLE_MS, MAX_SESSIONS } from "../src/http";
import { ANILIST_AUTHORIZE, ANILIST_TOKEN } from "../src/oauth";
import { PERSONA } from "./fixtures/persona";
import { FakeAniList, findMedia } from "./support/fake-anilist";

const START = Date.UTC(2026, 10, 17, 12);
const YEAR_S = 365 * 24 * 3600;
const REDIRECT = "http://localhost:9999/callback";
const DANDADAN = findMedia("Dandadan").id;

/** An AniList-style token: a JWT whose `exp` says when it expires. */
function anilistToken(user: string, expSeconds = START / 1000 + YEAR_S): string {
  const part = (o: object) => Buffer.from(JSON.stringify(o)).toString("base64url");
  return `${part({ alg: "RS256" })}.${part({ sub: user, exp: expSeconds })}.sig`;
}

let fake: FakeAniList;
let clock: number;
let server: ReturnType<typeof Bun.serve>;
let app: Awaited<ReturnType<typeof createHttpApp>>;
let base: string;
/** AniList's side of sign-in: which code gives which token, and the exchanges it saw. */
let anilistCodes: Map<string, string>;
let exchanges: Record<string, string>[];
/** AniList tokens AniList no longer accepts (the user revoked the app). */
let revoked: Set<string>;
/** Delays AniList's answer to writes, so two of them overlap. */
let slowWrites: boolean;

beforeEach(async () => {
  clock = START;
  fake = new FakeAniList("POINT_10_DECIMAL").seed(PERSONA);
  fake.clock = () => clock;
  anilistCodes = new Map([
    ["code-alice", anilistToken("alice")],
    ["code-bob", anilistToken("bob")],
  ]);
  exchanges = [];
  revoked = new Set();
  slowWrites = false;
  const fetchFn = async (url: string, init: RequestInit) => {
    if (url === ANILIST_TOKEN) {
      const body = JSON.parse(init.body as string) as Record<string, string>;
      exchanges.push(body);
      const token = anilistCodes.get(body.code!);
      if (!token) return Response.json({ error: "invalid_request", message: "The authorization code is invalid." }, { status: 400 });
      return Response.json({ token_type: "Bearer", expires_in: YEAR_S, access_token: token, refresh_token: "unused" });
    }
    if (revoked.has(new Headers(init.headers).get("Authorization")!.slice(7))) {
      return Response.json({ errors: [{ message: "Invalid token", status: 401 }], data: null }, { status: 401 });
    }
    if (slowWrites && /^\s*mutation/.test(JSON.parse(init.body as string).query)) await Bun.sleep(50);
    return fake.fetch(url, init);
  };
  // Bind first so PUBLIC_URL can name the real port.
  let handler: (req: Request) => Promise<Response> = async () => new Response(null, { status: 503 });
  server = Bun.serve({ port: 0, fetch: (req) => handler(req) });
  base = `http://localhost:${server.port}`;
  app = await createHttpApp(
    {
      publicUrl: base,
      anilistClientId: "4242",
      anilistClientSecret: "anilist-secret",
      authSecret: "test-secret-that-is-at-least-32-characters",
    },
    { fetch: fetchFn, now: () => clock },
  );
  handler = app.fetch;
});

afterEach(() => {
  server.stop(true);
});

/** What the MCP client app keeps between runs, in memory. */
class MemoryProvider implements OAuthClientProvider {
  info?: OAuthClientInformationMixed;
  saved?: OAuthTokens;
  verifier = "";
  authorizationUrl?: URL;
  get redirectUrl() {
    return REDIRECT;
  }
  get clientMetadata() {
    return { client_name: "Test client", redirect_uris: [REDIRECT], token_endpoint_auth_method: "none" };
  }
  state() {
    return "client-state-1";
  }
  clientInformation() {
    return this.info;
  }
  saveClientInformation(info: OAuthClientInformationMixed) {
    this.info = info;
  }
  tokens() {
    return this.saved;
  }
  saveTokens(tokens: OAuthTokens) {
    this.saved = tokens;
  }
  redirectToAuthorization(url: URL) {
    this.authorizationUrl = url;
  }
  saveCodeVerifier(verifier: string) {
    this.verifier = verifier;
  }
  codeVerifier() {
    return this.verifier;
  }
}

/** The consent page for an /authorize URL: its sealed sign-in and the cookie that goes with it. */
async function consent(authorizationUrl: URL | string) {
  const res = await fetch(authorizationUrl, { redirect: "manual" });
  expect(res.status).toBe(200);
  const html = await res.text();
  const pending = /name="pending" value="([^"]+)"/.exec(html)![1]!;
  const cookie = res.headers.get("Set-Cookie")!.split(";")[0]!;
  return { html, pending, cookie, res };
}

function answer(pending: string, action: string, cookie?: string) {
  return fetch(`${base}/authorize`, {
    method: "POST",
    redirect: "manual",
    headers: { "Content-Type": "application/x-www-form-urlencoded", ...(cookie ? { Cookie: cookie } : {}) },
    body: new URLSearchParams({ pending, action }),
  });
}

/** The browser approves AniConnect and is sent on to AniList: the state AniList carries, and the browser's cookie. */
async function toAniList(authorizationUrl: URL | string) {
  const { pending, cookie } = await consent(authorizationUrl);
  const res = await answer(pending, "approve", cookie);
  expect(res.status).toBe(302);
  const at = new URL(res.headers.get("Location")!);
  return { state: at.searchParams.get("state")!, cookie: res.headers.get("Set-Cookie")!.split(";")[0]!, pending };
}

/** AniList sending the browser back to AniConnect. */
function fromAniList(state: string, params: Record<string, string>, cookie?: string) {
  return fetch(`${base}/oauth/callback?${new URLSearchParams({ state, ...params })}`, {
    redirect: "manual",
    headers: cookie ? { Cookie: cookie } : {},
  });
}

/** The browser: approves AniConnect, goes on to AniList, "approves" with `anilistCode`, and comes back. */
async function approve(authorizationUrl: URL | string, anilistCode: string | null): Promise<URL> {
  const { pending, cookie } = await consent(authorizationUrl);
  const toAniList = await answer(pending, "approve", cookie);
  const signInCookie = toAniList.headers.get("Set-Cookie")!.split(";")[0]!;
  expect(toAniList.status).toBe(302);
  const atAniList = new URL(toAniList.headers.get("Location")!);
  expect(`${atAniList.origin}${atAniList.pathname}`).toBe(ANILIST_AUTHORIZE);
  expect(atAniList.searchParams.get("client_id")).toBe("4242");
  expect(atAniList.searchParams.get("redirect_uri")).toBe(`${base}/oauth/callback`);
  expect(atAniList.searchParams.get("response_type")).toBe("code");
  const back = new URL(`${base}/oauth/callback`);
  back.searchParams.set("state", atAniList.searchParams.get("state")!);
  if (anilistCode) back.searchParams.set("code", anilistCode);
  else back.searchParams.set("error", "access_denied");
  const toClient = await fetch(back, { redirect: "manual", headers: { Cookie: signInCookie } });
  expect(toClient.status).toBe(302);
  return new URL(toClient.headers.get("Location")!);
}

/** Signs in the way an MCP client app does, then returns a connected client. */
async function connectSignedIn(anilistCode = "code-alice") {
  const provider = new MemoryProvider();
  const first = new Client({ name: "test", version: "0" });
  const transport = new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { authProvider: provider });
  await expect(first.connect(transport)).rejects.toBeInstanceOf(UnauthorizedError);
  const back = await approve(provider.authorizationUrl!, anilistCode);
  expect(back.searchParams.get("state")).toBe("client-state-1");
  await transport.finishAuth(back.searchParams.get("code")!);
  const client = new Client({ name: "test", version: "0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { authProvider: provider }));
  return { client, provider };
}

async function call(client: Client, name: string, args: Record<string, unknown> = {}) {
  const result = (await client.callTool({ name, arguments: args })) as { content: { text: string }[]; isError?: boolean };
  return { text: result.content.map((c) => c.text).join("\n"), isError: Boolean(result.isError) };
}

/** Registration plus sign-in by hand, for the cases the SDK client won't produce. */
async function register(metadata: Record<string, unknown> = {}) {
  const res = await fetch(`${base}/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ redirect_uris: [REDIRECT], token_endpoint_auth_method: "none", ...metadata }),
  });
  return { status: res.status, body: (await res.json()) as Record<string, string> };
}

async function challengeFor(verifier: string) {
  return Buffer.from(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier))).toString("base64url");
}

async function codeFor(clientId: string, verifier = "verifier-0123456789-0123456789-0123456789", anilistCode = "code-alice") {
  const url = new URL(`${base}/authorize`);
  url.search = new URLSearchParams({
    client_id: clientId,
    redirect_uri: REDIRECT,
    response_type: "code",
    code_challenge: await challengeFor(verifier),
    code_challenge_method: "S256",
  }).toString();
  return (await approve(url, anilistCode)).searchParams.get("code")!;
}

function swap(params: Record<string, string>, headers: Record<string, string> = {}) {
  return fetch(`${base}/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", ...headers },
    body: new URLSearchParams({ grant_type: "authorization_code", redirect_uri: REDIRECT, ...params }),
  });
}

describe("sign-in", () => {
  test("an MCP client signs in with AniList and uses the tools on the user's list", async () => {
    const { client, provider } = await connectSignedIn();
    // AniConnect swapped AniList's code with its own client credentials and callback.
    expect(exchanges).toEqual([
      {
        grant_type: "authorization_code",
        client_id: "4242",
        client_secret: "anilist-secret",
        redirect_uri: `${base}/oauth/callback`,
        code: "code-alice",
      },
    ]);
    // The client holds AniConnect's token, not the AniList one inside it.
    expect(provider.saved!.access_token).not.toContain(anilistToken("alice"));
    expect(provider.saved!.expires_in).toBe(YEAR_S);

    const tools = await client.listTools();
    expect(tools.tools.map((t) => t.name)).toContain("update_shows");
    const watching = await call(client, "search_my_list", { status: "CURRENT" });
    expect(watching.isError).toBe(false);
    expect(watching.text).toContain("DAN DA DAN");
    // AniList saw the user's own token.
    const write = await call(client, "set_progress", { anime: DANDADAN, episodes: 9 });
    expect(write.isError).toBe(false);
    expect(fake.entries.get(DANDADAN)?.progress).toBe(9);
    await client.close();
  });

  test("advertises how to sign in, and turns away requests without a valid token", async () => {
    const resource = await (await fetch(`${base}/.well-known/oauth-protected-resource/mcp`)).json();
    expect(resource).toMatchObject({ resource: `${base}/mcp`, authorization_servers: [base] });
    const meta = await (await fetch(`${base}/.well-known/oauth-authorization-server`)).json();
    expect(meta).toMatchObject({
      issuer: base,
      registration_endpoint: `${base}/register`,
      code_challenge_methods_supported: ["S256"],
    });

    const anonymous = await fetch(`${base}/mcp`, { method: "POST", body: "{}" });
    expect(anonymous.status).toBe(401);
    expect(anonymous.headers.get("WWW-Authenticate")).toBe(
      `Bearer resource_metadata="${base}/.well-known/oauth-protected-resource/mcp"`,
    );
    // An AniList token isn't accepted directly: only tokens AniConnect issued.
    const passthrough = await fetch(`${base}/mcp`, {
      method: "POST",
      headers: { Authorization: `Bearer ${anilistToken("alice")}` },
      body: "{}",
    });
    expect(passthrough.status).toBe(401);
    expect(passthrough.headers.get("WWW-Authenticate")).toContain('error="invalid_token"');
  });

  test("a cancelled AniList sign-in goes back to the client as access_denied", async () => {
    const { body } = await register();
    const url = new URL(`${base}/authorize`);
    url.search = new URLSearchParams({
      client_id: body.client_id!,
      redirect_uri: REDIRECT,
      response_type: "code",
      code_challenge: await challengeFor("v"),
      code_challenge_method: "S256",
      state: "s1",
    }).toString();
    const back = await approve(url, null);
    expect(`${back.origin}${back.pathname}`).toBe(REDIRECT);
    expect(back.searchParams.get("error")).toBe("access_denied");
    expect(back.searchParams.get("state")).toBe("s1");
    expect(back.searchParams.get("code")).toBeNull();
  });

  test("a failed AniList code exchange goes back to the client as server_error", async () => {
    const { body } = await register();
    const url = new URL(`${base}/authorize`);
    url.search = new URLSearchParams({
      client_id: body.client_id!,
      response_type: "code",
      code_challenge: await challengeFor("v"),
      code_challenge_method: "S256",
    }).toString();
    const result = await approve(url, "code-nobody");
    expect(result.searchParams.get("error")).toBe("server_error");
    expect(result.searchParams.get("error_description")).toContain("The authorization code is invalid.");
  });
});

describe("authorization checks", () => {
  test("only safe redirect URIs can be registered", async () => {
    expect((await register({ redirect_uris: ["https://claude.ai/api/mcp/auth_callback"] })).status).toBe(201);
    expect((await register({ redirect_uris: ["http://127.0.0.1:33418/callback"] })).status).toBe(201);
    expect((await register({ redirect_uris: ["cursor://anysphere.cursor-mcp/oauth/callback"] })).status).toBe(201);
    for (const uri of ["http://evil.example/callback", "javascript:alert(1)", "https://x.example/cb#frag", "not a url"]) {
      const { status, body } = await register({ redirect_uris: [uri] });
      expect(status).toBe(400);
      expect(body.error).toBe("invalid_redirect_uri");
    }
    expect((await register({ redirect_uris: [] })).status).toBe(400);
  });

  test("an unregistered redirect URI gets an error page, never a redirect", async () => {
    const { body } = await register();
    const url = new URL(`${base}/authorize`);
    url.search = new URLSearchParams({
      client_id: body.client_id!,
      redirect_uri: "https://evil.example/steal",
      response_type: "code",
      code_challenge: "x",
      code_challenge_method: "S256",
    }).toString();
    const res = await fetch(url, { redirect: "manual" });
    expect(res.status).toBe(400);
    expect(res.headers.get("Location")).toBeNull();

    const forged = await fetch(`${base}/authorize?client_id=made-up&response_type=code`, { redirect: "manual" });
    expect(forged.status).toBe(400);
  });

  test("AniList's return works once, only in the browser that approved, and only after approval", async () => {
    const { body } = await register({ redirect_uris: ["https://evil.example/cb"] });
    const url = `${base}/authorize?${new URLSearchParams({
      client_id: body.client_id!,
      response_type: "code",
      code_challenge: "x",
      code_challenge_method: "S256",
    })}`;
    const { state, cookie, pending } = await toAniList(url);
    expect(cookie).toMatch(/^aniconnect_signin_/);
    // Someone takes the consent page's state, or an approved one, and sends another person to AniList with it.
    expect((await fromAniList(pending, { code: "code-alice" })).status).toBe(400);
    expect((await fromAniList(state, { code: "code-alice" })).status).toBe(403);
    expect((await fromAniList(state, { code: "code-alice" }, "aniconnect_signin_other=1")).status).toBe(403);
    expect(exchanges).toEqual([]);
    // The browser that approved comes back once.
    const ok = await fromAniList(state, { code: "code-alice" }, cookie);
    expect(new URL(ok.headers.get("Location")!).origin).toBe("https://evil.example");
    expect(ok.headers.get("Set-Cookie")).toContain("Max-Age=0");
    expect((await fromAniList(state, { code: "code-alice" }, cookie)).status).toBe(400);
    expect(exchanges.length).toBe(1);
  });

  test("a bad request gets an error page, never a redirect to the registered URI", async () => {
    const { body } = await register();
    const good = {
      client_id: body.client_id!,
      redirect_uri: REDIRECT,
      response_type: "code",
      code_challenge: "x",
      code_challenge_method: "S256",
      state: "s",
    };
    for (const bad of <Record<string, string>[]>[
      { code_challenge: "" }, // PKCE is required
      { code_challenge_method: "plain" },
      { response_type: "token" },
      { resource: "https://elsewhere.example/mcp" },
      { state: "s".repeat(1025) },
    ]) {
      const res = await fetch(`${base}/authorize?${new URLSearchParams({ ...good, ...bad })}`, { redirect: "manual" });
      expect(res.status).toBe(400);
      expect(res.headers.get("Location")).toBeNull();
    }
  });

  test("the user approves the app on AniConnect's own page before AniList", async () => {
    const { body } = await register({ client_name: "<b>Evil</b> app", redirect_uris: ["https://evil.example/cb"] });
    const url = `${base}/authorize?${new URLSearchParams({
      client_id: body.client_id!,
      response_type: "code",
      code_challenge: "x",
      code_challenge_method: "S256",
      state: "s",
    })}`;
    const { html, pending, cookie, res } = await consent(url);
    // Names where the user goes back to; the app's name is escaped.
    expect(html).toContain("https://evil.example");
    expect(html).toContain("&#60;b&#62;Evil&#60;/b&#62; app");
    expect(html).not.toContain("<b>Evil</b>");
    expect(res.headers.get("Content-Security-Policy")).toContain("frame-ancestors 'none'");
    expect(res.headers.get("Set-Cookie")).toContain("SameSite=Strict");

    // Another site posting the form for the user (no cookie, or someone else's) gets nowhere.
    expect((await answer(pending, "approve")).status).toBe(403);
    expect((await answer(pending, "approve", "aniconnect_consent_guess=1")).status).toBe(403);
    // Cancel goes back to the app with access_denied, and forgets this page's cookie.
    const denied = await answer(pending, "deny", cookie);
    expect(denied.headers.getSetCookie()).toContain(`${cookie.split("=")[0]}=; Path=/authorize; Max-Age=0; HttpOnly; SameSite=Strict`);
    const back = new URL(denied.headers.get("Location")!);
    expect(back.origin).toBe("https://evil.example");
    expect(back.searchParams.get("error")).toBe("access_denied");
    expect(back.searchParams.get("state")).toBe("s");
    expect(back.searchParams.get("code")).toBeNull();
  });

  test("the consent page's CSP lets its form go on to AniList or back to the app", async () => {
    // Chrome checks form-action against the redirect that answers the form, not only the form's own target.
    const cases: [string, string][] = [
      ["https://claude.ai/api/mcp/auth_callback", "https://claude.ai"],
      [REDIRECT, "http://localhost:9999"],
      ["http://[::1]:9999/callback", "http:"],
      ["cursor://anysphere.cursor-mcp/oauth/callback", "cursor:"],
      // A host the URL parser allows but CSP can't spell doesn't get to add directives.
      ["https://a;sandbox,x.example/cb", "https:"],
      ["https://a..b/cb", "https:"],
    ];
    for (const [redirectUri, app] of cases) {
      const { body } = await register({ redirect_uris: [redirectUri] });
      const url = `${base}/authorize?${new URLSearchParams({
        client_id: body.client_id!,
        response_type: "code",
        code_challenge: "x",
        code_challenge_method: "S256",
      })}`;
      const { res } = await consent(url);
      expect(res.headers.get("Content-Security-Policy")).toBe(
        `default-src 'none'; style-src 'unsafe-inline'; form-action 'self' https://anilist.co ${app}; frame-ancestors 'none'`,
      );
    }
  });

  test("opening the consent page twice leaves both pages able to approve", async () => {
    const { body } = await register();
    const url = `${base}/authorize?${new URLSearchParams({
      client_id: body.client_id!,
      response_type: "code",
      code_challenge: "x",
      code_challenge_method: "S256",
    })}`;
    const first = await consent(url);
    const second = await consent(url);
    expect(first.cookie).not.toBe(second.cookie);
    // The browser holds both pages' cookies, and each page is checked against its own.
    const jar = `${first.cookie}; ${second.cookie}`;
    const one = await answer(first.pending, "approve", jar);
    expect(one.status).toBe(302);
    expect(new URL(one.headers.get("Location")!).origin).toBe("https://anilist.co");
    expect((await answer(second.pending, "approve", jar)).status).toBe(302);
    // One page's cookie doesn't approve the other page.
    expect((await answer(first.pending, "approve", second.cookie)).status).toBe(403);
  });

  test("a code works once, with the right verifier, for the client it was issued to", async () => {
    const verifier = "verifier-0123456789-0123456789-0123456789";
    const alice = (await register()).body.client_id!;
    const other = (await register()).body.client_id!;
    const code = await codeFor(alice, verifier);

    const wrongVerifier = await swap({ client_id: alice, code, code_verifier: `${verifier}x` });
    expect(wrongVerifier.status).toBe(400);
    expect(((await wrongVerifier.json()) as { error: string }).error).toBe("invalid_grant");
    const wrongClient = await swap({ client_id: other, code, code_verifier: verifier });
    expect(((await wrongClient.json()) as { error: string }).error).toBe("invalid_grant");
    const wrongRedirect = await swap({ client_id: alice, code, code_verifier: verifier, redirect_uri: "http://localhost:1/x" });
    expect(((await wrongRedirect.json()) as { error: string }).error).toBe("invalid_grant");

    const ok = await swap({ client_id: alice, code, code_verifier: verifier });
    expect(ok.status).toBe(200);
    expect(ok.headers.get("Cache-Control")).toBe("no-store");
    expect(((await ok.json()) as { token_type: string }).token_type).toBe("Bearer");
    const again = await swap({ client_id: alice, code, code_verifier: verifier });
    expect(((await again.json()) as { error: string }).error).toBe("invalid_grant");
  });

  test("codes expire after five minutes", async () => {
    const verifier = "verifier-0123456789-0123456789-0123456789";
    const id = (await register()).body.client_id!;
    const code = await codeFor(id, verifier);
    clock += 5 * 60_000 + 1;
    const late = await swap({ client_id: id, code, code_verifier: verifier });
    expect(((await late.json()) as { error: string }).error).toBe("invalid_grant");
  });

  test("a confidential client must send its secret, by Basic auth or in the form", async () => {
    const verifier = "verifier-0123456789-0123456789-0123456789";
    const { body } = await register({ token_endpoint_auth_method: "client_secret_basic" });
    expect(body.client_secret).toBeTruthy();
    const noSecret = await swap({ client_id: body.client_id!, code: await codeFor(body.client_id!, verifier), code_verifier: verifier });
    expect(noSecret.status).toBe(401);
    const otherSecret = (await register({ token_endpoint_auth_method: "client_secret_post" })).body.client_secret!;
    const wrong = await swap({
      client_id: body.client_id!,
      client_secret: otherSecret,
      code: await codeFor(body.client_id!, verifier),
      code_verifier: verifier,
    });
    expect(wrong.status).toBe(401);
    const basic = Buffer.from(`${body.client_id}:${body.client_secret}`).toString("base64");
    const ok = await swap(
      { code: await codeFor(body.client_id!, verifier), code_verifier: verifier },
      { Authorization: `Basic ${basic}` },
    );
    expect(ok.status).toBe(200);
  });

  test("one kind of sealed value can't stand in for another", async () => {
    const verifier = "verifier-0123456789-0123456789-0123456789";
    const id = (await register()).body.client_id!;
    const code = await codeFor(id, verifier);
    // A code (or a client ID) used as an access token.
    for (const bearer of [code, id]) {
      const res = await fetch(`${base}/mcp`, { method: "POST", headers: { Authorization: `Bearer ${bearer}` }, body: "{}" });
      expect(res.status).toBe(401);
    }
    // An access token used as a client ID.
    const token = ((await (await swap({ client_id: id, code, code_verifier: verifier })).json()) as { access_token: string }).access_token;
    const res = await fetch(`${base}/authorize?client_id=${token}&response_type=code`, { redirect: "manual" });
    expect(res.status).toBe(400);
  });

  test("an access token stops working when the AniList token inside it expires", async () => {
    anilistCodes.set("code-short", anilistToken("carol", START / 1000 + 3600));
    const verifier = "verifier-0123456789-0123456789-0123456789";
    const id = (await register()).body.client_id!;
    const res = await swap({ client_id: id, code: await codeFor(id, verifier, "code-short"), code_verifier: verifier });
    const { access_token, expires_in } = (await res.json()) as { access_token: string; expires_in: number };
    expect(expires_in).toBe(3600);
    clock += 3600_000;
    const late = await fetch(`${base}/mcp`, { method: "POST", headers: { Authorization: `Bearer ${access_token}` }, body: "{}" });
    expect(late.status).toBe(401);
    expect(late.headers.get("WWW-Authenticate")).toContain('error="invalid_token"');
  });

  test("when AniList stops accepting the token, the tool says to sign in again and the client is signed out", async () => {
    const { client, provider } = await connectSignedIn();
    revoked.add(anilistToken("alice"));
    const result = await call(client, "search_my_list", { status: "CURRENT" });
    expect(result.isError).toBe(true);
    expect(result.text).toContain("sign in with AniList again: reconnect AniConnect");
    expect(result.text).not.toContain("ANILIST_TOKEN");
    // The next request is refused with invalid_token, which makes the client sign in again.
    const next = await fetch(`${base}/mcp`, {
      method: "POST",
      headers: { Authorization: `Bearer ${provider.saved!.access_token}`, "Content-Type": "application/json" },
      body: "{}",
    });
    expect(next.status).toBe(401);
    expect(next.headers.get("WWW-Authenticate")).toContain('error="invalid_token"');
    expect(app.stats()).toEqual({ sessions: 0, accounts: 0 });
    await client.close().catch(() => {});
  });
});

describe("sessions", () => {
  test("a user's conversations share one undo history", async () => {
    const first = await connectSignedIn();
    expect((await call(first.client, "set_progress", { anime: DANDADAN, episodes: 9 })).isError).toBe(false);
    await first.client.close();
    // A second conversation (new session, same sign-in) can undo it.
    const second = new Client({ name: "test", version: "0" });
    await second.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { authProvider: first.provider }));
    const undone = await call(second, "undo");
    expect(undone.isError).toBe(false);
    expect(fake.entries.get(DANDADAN)?.progress).toBe(7);
    await second.close();
  });

  test("parallel writes from two conversations take turns, so no episode is lost", async () => {
    const first = await connectSignedIn();
    const second = new Client({ name: "test", version: "0" });
    await second.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { authProvider: first.provider }));
    await call(first.client, "search_my_list", { status: "CURRENT" }); // both start from the cached list
    slowWrites = true;
    const results = await Promise.all([
      call(first.client, "mark_episodes_watched", { anime: "dandadan" }),
      call(second, "mark_episodes_watched", { anime: "dandadan" }),
    ]);
    expect(results.map((r) => r.isError)).toEqual([false, false]);
    expect(fake.entries.get(DANDADAN)?.progress).toBe(9);
    await first.client.close();
    await second.close();
  });

  test("a user's oldest session closes when they open too many", async () => {
    const { client, provider } = await connectSignedIn();
    const others: Client[] = [];
    for (let i = 0; i < MAX_SESSIONS; i++) {
      clock += 1000;
      const c = new Client({ name: "test", version: "0" });
      await c.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { authProvider: provider }));
      others.push(c);
    }
    expect(app.stats().sessions).toBe(MAX_SESSIONS);
    await expect(client.listTools()).rejects.toThrow();
    expect((await others.at(-1)!.listTools()).tools.length).toBeGreaterThan(0);
    await Promise.all(others.map((c) => c.close()));
    await client.close().catch(() => {});
  });

  test("one user can't use another user's session", async () => {
    const alice = await connectSignedIn("code-alice");
    const bob = await connectSignedIn("code-bob");
    expect(app.stats()).toEqual({ sessions: 2, accounts: 2 });
    const aliceSession = (alice.client.transport as StreamableHTTPClientTransport).sessionId!;
    const res = await fetch(`${base}/mcp`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${bob.provider.saved!.access_token}`,
        "Mcp-Session-Id": aliceSession,
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 9, method: "tools/call", params: { name: "undo", arguments: {} } }),
    });
    expect(res.status).toBe(404);
    await alice.client.close();
    await bob.client.close();
  });

  test("idle sessions and users are dropped", async () => {
    const { client } = await connectSignedIn();
    expect(app.stats()).toEqual({ sessions: 1, accounts: 1 });
    clock += IDLE_MS;
    await app.sweep();
    expect(app.stats()).toEqual({ sessions: 0, accounts: 0 });
    await client.close().catch(() => {});
  });

  test("a request with no session must be an initialize request", async () => {
    const { provider } = await connectSignedIn();
    const res = await fetch(`${base}/mcp`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${provider.saved!.access_token}`,
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });
    expect(res.status).toBe(400);
  });
});

describe("settings", () => {
  const env = {
    PUBLIC_URL: "https://aniconnect.example.com",
    ANILIST_CLIENT_ID: "1",
    ANILIST_CLIENT_SECRET: "s",
    AUTH_SECRET: "x".repeat(32),
  };
  test("reads the environment", () => {
    expect(configFromEnv(env)).toEqual({
      publicUrl: "https://aniconnect.example.com",
      anilistClientId: "1",
      anilistClientSecret: "s",
      authSecret: "x".repeat(32),
    });
  });
  test("names what's missing or unsafe", () => {
    expect(() => configFromEnv({ ...env, ANILIST_CLIENT_SECRET: "", AUTH_SECRET: undefined })).toThrow(
      "Set ANILIST_CLIENT_SECRET, AUTH_SECRET",
    );
    expect(() => configFromEnv({ ...env, AUTH_SECRET: "short" })).toThrow("at least 32 characters");
    expect(() => configFromEnv({ ...env, PUBLIC_URL: "http://aniconnect.example.com" })).toThrow("must be https");
    expect(() => configFromEnv({ ...env, PUBLIC_URL: "http://localhost:3000" })).not.toThrow();
    expect(() => configFromEnv({ ...env, PUBLIC_URL: "http://[::1]:3000" })).not.toThrow();
  });
});
