/**
 * "Sign in with AniList" for the hosted server (requirement R7.2).
 *
 * MCP clients (claude.ai, Claude Code, ...) speak OAuth 2.1 to AniConnect: they discover it from
 * the metadata documents, register themselves (RFC 7591), and sign the user in with PKCE.
 * AniConnect sends the user on to AniList's own sign-in page, swaps AniList's code for the
 * user's AniList token, and hands the client an access token of its own that wraps it.
 *
 * Nothing is stored. Client registrations, sign-ins in progress, codes and access tokens are
 * sealed with AES-GCM under AUTH_SECRET, each kind under its own label so one can't be passed
 * off as another. A restart or a second instance signs nobody out. The memory it keeps is the
 * set of codes already used, so a code works once per instance, and when each client address
 * last had codes swapped with AniList, so sign-ins can't use up AniList's limit.
 *
 * Since access tokens are stateless, one user is signed out by listing their AniList user ID in
 * `revokedUsers`: their access tokens are refused, and they can't sign in again while listed.
 * AUTH_SECRET can be changed without signing everyone out by keeping the old one in
 * `authSecretPrevious` for a while: what it sealed still opens.
 */
import type { FetchFn } from "./anilist";
import { tokenExpiry, tokenUser } from "./token";

export const ANILIST_AUTHORIZE = "https://anilist.co/api/v2/oauth/authorize";
const ANILIST_ORIGIN = new URL(ANILIST_AUTHORIZE).origin;
export const ANILIST_TOKEN = "https://anilist.co/api/v2/oauth/token";

/**
 * AniList codes swapped for tokens per client address in a minute. Anyone can start a sign-in,
 * and each one that comes back from AniList makes a request to AniList's token endpoint, which
 * counts against the server IP's limit (it reports `X-RateLimit-Limit`), so unthrottled they
 * could use up the limit every user's tool calls share. Real sign-ins come far slower than this.
 */
export const SIGNIN_EXCHANGES_PER_MINUTE = 10;
const MINUTE_MS = 60_000;

/** How long the user has to finish signing in on AniList. */
const PENDING_MS = 10 * 60_000;
/** The longest `state` a client may send; it rides along to AniList and back. */
const MAX_STATE = 1024;
/** How long the client has to swap our code for a token. */
const CODE_MS = 5 * 60_000;
/** AniList's tokens last a year; used when one doesn't say when it expires. */
const YEAR_MS = 365 * 24 * 60 * 60_000;

export interface OAuthConfig {
  /** Where the server is reached, e.g. https://aniconnect.example.com. Only the origin is used. */
  publicUrl: string;
  /** The AniList API client (anilist.co/settings/developer) whose redirect URL is `<publicUrl>/oauth/callback`. */
  anilistClientId: string;
  anilistClientSecret: string;
  /** Seals everything the server hands out. Changing it signs everyone out, unless the old one is kept in `authSecretPrevious`. */
  authSecret: string;
  /** The secret before `authSecret`, while rotating: what it sealed still opens, and nothing new is sealed with it. */
  authSecretPrevious?: string;
  /**
   * The header the proxy in front of the server sets to the client's address, for throttling
   * sign-ins per address; default `X-Real-IP` (Railway's). In a list (X-Forwarded-For) the last
   * address, the one the proxy added, is used. Without the header the connection's own address
   * is. A client that sets it itself, with no proxy to replace it, gets past the throttle; a
   * proxy's address would instead make every sign-in share one allowance, which anyone could use up.
   */
  clientIpHeader?: string;
  /** AniList user IDs refused access: their access tokens stop working and they can't sign in. */
  revokedUsers?: readonly string[];
}

const enc = new TextEncoder();
const dec = new TextDecoder();

function b64url(bytes: Uint8Array | ArrayBuffer): string {
  return Buffer.from(bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes)).toString("base64url");
}

export async function sha256(text: string): Promise<string> {
  return b64url(await crypto.subtle.digest("SHA-256", enc.encode(text)));
}

/**
 * Seals small JSON values so only this server can read them; `kind` keeps the kinds apart.
 * Values sealed with a previous secret still open, so the secret can be changed without
 * signing everyone out.
 */
export class Sealer {
  private constructor(
    private readonly key: CryptoKey,
    private readonly previous: CryptoKey | null,
  ) {}

  static async create(secret: string, previous?: string): Promise<Sealer> {
    const key = async (s: string) => {
      const raw = await crypto.subtle.digest("SHA-256", enc.encode(`aniconnect:${s}`));
      return crypto.subtle.importKey("raw", raw, "AES-GCM", false, ["encrypt", "decrypt"]);
    };
    return new Sealer(await key(secret), previous ? await key(previous) : null);
  }

  async seal(kind: string, data: object): Promise<string> {
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const body = await crypto.subtle.encrypt(
      { name: "AES-GCM", iv, additionalData: enc.encode(kind) },
      this.key,
      enc.encode(JSON.stringify(data)),
    );
    const out = new Uint8Array(iv.length + body.byteLength);
    out.set(iv);
    out.set(new Uint8Array(body), iv.length);
    return b64url(out);
  }

  /** The sealed value, or null if it isn't one of ours, is another kind, or has expired (`exp`, ms). */
  async open<T extends object>(kind: string, sealed: string | null | undefined, now: number): Promise<T | null> {
    if (!sealed || sealed.length > 8192) return null;
    try {
      const bytes = Buffer.from(sealed, "base64url");
      if (bytes.length < 29) return null;
      const decrypt = (key: CryptoKey) =>
        crypto.subtle.decrypt({ name: "AES-GCM", iv: bytes.subarray(0, 12), additionalData: enc.encode(kind) }, key, bytes.subarray(12));
      const previous = this.previous;
      const plain = await decrypt(this.key).catch((err) => (previous ? decrypt(previous) : Promise.reject(err)));
      const data = JSON.parse(dec.decode(plain)) as T & { exp?: unknown };
      if (typeof data.exp === "number" && data.exp <= now) return null;
      return data;
    } catch {
      return null;
    }
  }
}

/** A registered client, as sealed into its client_id. */
interface ClientInfo {
  /** Redirect URIs. */
  r: string[];
  /** Token endpoint auth method: "none" for public clients, else it was given a secret. */
  m: string;
  /** Name, shown nowhere yet but kept for the registration response. */
  n?: string;
}

/** A sign-in in progress, sealed into the `state` sent to AniList. */
interface Pending {
  /** Hash of the client_id. */
  c: string;
  /** The client's redirect URI. */
  r: string;
  /** The client's own state, if it sent one. */
  s?: string;
  /** PKCE code challenge (S256). */
  cc: string;
  /**
   * Names the browser's cookie: on the consent page, the one that proves the approval came from
   * the page itself; in the state sent to AniList, the one that proves it's the same browser.
   */
  x?: string;
  exp: number;
}

/** Our authorization code. */
interface Code extends Pending {
  /** The user's AniList token. */
  t: string;
  /** When the AniList token expires (ms). */
  te: number;
  /** Unique, so the code works once. */
  j: string;
}

/** Our access token: the user's AniList token, for this server only. */
interface Access {
  t: string;
  exp: number;
}

/** OAuth errors, sent as JSON (token, register) or as a redirect back to the client (authorize). */
class OAuthError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status = 400,
  ) {
    super(message);
  }
}

function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store", ...headers },
  });
}

function errorJson(err: OAuthError): Response {
  return json(
    { error: err.code, error_description: err.message },
    err.status,
    err.status === 401 ? { "WWW-Authenticate": 'Basic realm="aniconnect"' } : {},
  );
}

/** A page for the person in the browser when there is no client to send them back to. */
function page(message: string, status = 400): Response {
  return new Response(`AniConnect: ${message}\n`, { status, headers: { "Content-Type": "text/plain; charset=utf-8" } });
}

function redirect(location: string): Response {
  return new Response(null, { status: 302, headers: { Location: location, "Cache-Control": "no-store" } });
}

const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]"]);

/**
 * Redirect URIs clients may register: https, http on this machine only (RFC 8252 loopback),
 * or an app's own scheme (cursor://, vscode://). Never one that runs code in the browser.
 */
function allowedRedirect(uri: string): boolean {
  let url: URL;
  try {
    url = new URL(uri);
  } catch {
    return false;
  }
  if (url.hash) return false;
  if (url.protocol === "https:") return true;
  if (url.protocol === "http:") return LOOPBACK.has(url.hostname);
  return !["javascript:", "data:", "file:", "vbscript:", "blob:", "about:"].includes(url.protocol);
}

function withParams(uri: string, params: Record<string, string | undefined>): string {
  const url = new URL(uri);
  for (const [k, v] of Object.entries(params)) if (v !== undefined) url.searchParams.set(k, v);
  return url.toString();
}

function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

/** Where a redirect URI sends the user, as they'd recognize it. */
function destination(uri: string): string {
  const url = new URL(uri);
  return url.host ? `${url.protocol}//${url.host}` : `${url.protocol}${url.pathname.split("/")[0]}`;
}

/**
 * Where the consent form may send the browser. Chrome checks form-action against the redirect
 * that answers the form too, so this lists where that goes: AniList, or back to the app.
 */
function formAction(redirectUri: string): string {
  const url = new URL(redirectUri);
  // An app scheme (cursor:), or a host CSP can't spell (Chrome ignores [::1]), is allowed by its scheme.
  const app = /^https?:$/.test(url.protocol) && /^[a-z0-9-]+(\.[a-z0-9-]+)*(:\d+)?$/.test(url.host) ? url.origin : url.protocol;
  return `'self' ${ANILIST_ORIGIN} ${app}`;
}

function consentPage(name: string | undefined, redirectUri: string, pending: string): string {
  const app = name ? `<b>${escapeHtml(name)}</b> (as the app calls itself)` : "An app";
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Connect AniConnect</title>
<link rel="icon" type="image/svg+xml" href="/favicon.svg">
<style>body{font:16px/1.5 system-ui,sans-serif;max-width:32rem;margin:3rem auto;padding:0 1rem}code{word-break:break-all}button{font:inherit;padding:.5rem 1rem;margin-right:.5rem}</style>
</head><body>
<h1>Connect AniConnect to your AniList?</h1>
<p>${app} wants to manage your AniList anime list through AniConnect: read it, and add, change and remove shows.</p>
<p>After you sign in on AniList, you'll go back to <code>${escapeHtml(destination(redirectUri))}</code>. Only approve if you just added AniConnect there yourself.</p>
<form method="post" action="/authorize">
<input type="hidden" name="pending" value="${escapeHtml(pending)}">
<button name="action" value="approve">Approve and sign in with AniList</button>
<button name="action" value="deny">Cancel</button>
</form>
</body></html>
`;
}

export class OAuthServer {
  readonly origin: string;
  /** The MCP endpoint, which access tokens are for. */
  readonly resource: string;
  readonly callbackUrl: string;
  /** Codes already swapped for a token, and sign-ins already finished, until they expire. */
  private used = new Map<string, number>();
  /** When each client address had AniList codes swapped in the last minute, oldest first. */
  private exchanges = new Map<string, number[]>();
  private readonly revoked: ReadonlySet<string>;

  private constructor(
    private readonly config: OAuthConfig,
    private readonly sealer: Sealer,
    private readonly fetchFn: FetchFn,
    private readonly now: () => number,
  ) {
    this.origin = new URL(config.publicUrl).origin;
    this.resource = `${this.origin}/mcp`;
    this.callbackUrl = `${this.origin}/oauth/callback`;
    this.revoked = new Set(config.revokedUsers ?? []);
  }

  /** Whether the AniList token belongs to a user listed in `revokedUsers`. */
  private isRevoked(anilistToken: string): boolean {
    const user = tokenUser(anilistToken);
    return user !== null && this.revoked.has(user);
  }

  static async create(
    config: OAuthConfig,
    options: { fetch?: FetchFn; now?: () => number } = {},
  ): Promise<OAuthServer> {
    return new OAuthServer(
      config,
      await Sealer.create(config.authSecret, config.authSecretPrevious),
      options.fetch ?? ((input, init) => fetch(input, init)),
      options.now ?? Date.now,
    );
  }

  /** The cookie flag for an https server. */
  private get secure(): string {
    return this.origin.startsWith("https:") ? "; Secure" : "";
  }

  get resourceMetadataUrl(): string {
    return `${this.origin}/.well-known/oauth-protected-resource/mcp`;
  }

  /** RFC 9728: where clients learn which server signs them in. */
  resourceMetadata(): Response {
    return json({
      resource: this.resource,
      authorization_servers: [this.origin],
      bearer_methods_supported: ["header"],
      resource_name: "AniConnect",
    });
  }

  /** RFC 8414. */
  serverMetadata(): Response {
    return json({
      issuer: this.origin,
      authorization_endpoint: `${this.origin}/authorize`,
      token_endpoint: `${this.origin}/token`,
      registration_endpoint: `${this.origin}/register`,
      response_types_supported: ["code"],
      grant_types_supported: ["authorization_code"],
      code_challenge_methods_supported: ["S256"],
      token_endpoint_auth_methods_supported: ["none", "client_secret_post", "client_secret_basic"],
    });
  }

  /** RFC 7591 dynamic client registration. The registration lives in the client_id itself. */
  async register(req: Request): Promise<Response> {
    try {
      let body: Record<string, unknown>;
      try {
        body = (await req.json()) as Record<string, unknown>;
      } catch {
        throw new OAuthError("invalid_client_metadata", "The body must be JSON client metadata.");
      }
      const uris = body.redirect_uris;
      if (!Array.isArray(uris) || uris.length === 0 || uris.length > 10 || !uris.every((u) => typeof u === "string")) {
        throw new OAuthError("invalid_redirect_uri", "Register 1 to 10 redirect_uris.");
      }
      const bad = uris.find((u) => u.length > 500 || !allowedRedirect(u));
      if (bad !== undefined) {
        throw new OAuthError(
          "invalid_redirect_uri",
          `Redirect URI not allowed: ${bad.slice(0, 100)}. Use https, http on localhost, or an app scheme.`,
        );
      }
      const method = typeof body.token_endpoint_auth_method === "string" ? body.token_endpoint_auth_method : "client_secret_basic";
      if (!["none", "client_secret_post", "client_secret_basic"].includes(method)) {
        throw new OAuthError("invalid_client_metadata", `Unsupported token_endpoint_auth_method: ${method}.`);
      }
      for (const [field, allowed] of [
        ["grant_types", "authorization_code"],
        ["response_types", "code"],
      ] as const) {
        const value = body[field];
        if (Array.isArray(value) && !value.includes(allowed)) {
          throw new OAuthError("invalid_client_metadata", `${field} must include ${allowed}.`);
        }
      }
      const name = typeof body.client_name === "string" ? body.client_name.slice(0, 100) : undefined;
      const info: ClientInfo = { r: uris as string[], m: method, ...(name ? { n: name } : {}) };
      const clientId = await this.sealer.seal("client", info);
      const secret = method === "none" ? undefined : await this.sealer.seal("secret", { c: await sha256(clientId) });
      return json(
        {
          client_id: clientId,
          ...(secret ? { client_secret: secret, client_secret_expires_at: 0 } : {}),
          client_id_issued_at: Math.floor(this.now() / 1000),
          redirect_uris: info.r,
          token_endpoint_auth_method: method,
          grant_types: ["authorization_code"],
          response_types: ["code"],
          ...(name ? { client_name: name } : {}),
        },
        201,
      );
    } catch (err) {
      if (err instanceof OAuthError) return errorJson(err);
      throw err;
    }
  }

  private client(clientId: string | null): Promise<ClientInfo | null> {
    return this.sealer.open<ClientInfo>("client", clientId, this.now());
  }

  /**
   * Checks the request and asks the user to approve the app. Anyone can register a client, so
   * without this step a link from anyone would go straight to AniList, whose page names only
   * AniConnect, and the code would go to whatever redirect URI they registered (the "confused
   * deputy" the MCP spec warns about). Errors here are pages, not redirects, so the server is
   * never an open redirector to a registered URI.
   */
  async authorize(req: Request): Promise<Response> {
    const q = new URL(req.url).searchParams;
    const clientId = q.get("client_id");
    const client = await this.client(clientId);
    if (!client || !clientId) return page("unknown client_id. Add AniConnect to your MCP client again.");
    const asked = q.get("redirect_uri");
    const redirectUri = asked ?? (client.r.length === 1 ? client.r[0] : null);
    if (!redirectUri || !client.r.includes(redirectUri)) {
      return page("the redirect_uri doesn't match the one this client registered.");
    }
    if (q.get("response_type") !== "code") return page("only response_type=code is supported.");
    const challenge = q.get("code_challenge");
    if (!challenge || challenge.length > 128 || q.get("code_challenge_method") !== "S256") {
      return page("PKCE is required: send code_challenge with code_challenge_method=S256.");
    }
    const resource = q.get("resource");
    if (resource && !this.isResource(resource)) return page(`tokens here are for ${this.resource}.`);
    const state = q.get("state") ?? undefined;
    if (state && state.length > MAX_STATE) return page(`state is longer than ${MAX_STATE} characters.`);

    const consent = crypto.randomUUID();
    const pending: Pending = {
      c: await sha256(clientId),
      r: redirectUri,
      ...(state !== undefined ? { s: state } : {}),
      cc: challenge,
      x: consent,
      exp: this.now() + PENDING_MS,
    };
    return new Response(consentPage(client.n, redirectUri, await this.sealer.seal("pending", pending)), {
      headers: {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "no-store",
        // The cookie only comes back on a same-site request, so another site can't post the form for the user.
        // Named after this page, so a second consent page doesn't replace the first one's cookie.
        "Set-Cookie": `aniconnect_consent_${consent}=1; Path=/authorize; Max-Age=${PENDING_MS / 1000}; HttpOnly; SameSite=Strict${this.secure}`,
        "Content-Security-Policy": `default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; form-action ${formAction(redirectUri)}; frame-ancestors 'none'`,
        "X-Frame-Options": "DENY",
      },
    });
  }

  /** The consent form's answer: on to AniList to sign in, or back to the app with access_denied. */
  async approve(req: Request): Promise<Response> {
    const form = new URLSearchParams(await req.text());
    const sealed = form.get("pending");
    const pending = await this.sealer.open<Pending>("pending", sealed, this.now());
    if (!pending || !sealed) return page("this sign-in has expired or isn't valid. Start again from your MCP client.");
    const consent = `aniconnect_consent_${pending.x}`;
    if (!pending.x || !(req.headers.get("Cookie") ?? "").split(/;\s*/).some((c) => c.startsWith(`${consent}=`))) {
      return page("couldn't confirm this approval came from this page. Start again from your MCP client.", 403);
    }
    const forget = (res: Response) => {
      res.headers.append("Set-Cookie", `${consent}=; Path=/authorize; Max-Age=0; HttpOnly; SameSite=Strict${this.secure}`);
      return res;
    };
    if (form.get("action") !== "approve") {
      return forget(
        redirect(
          withParams(pending.r, { error: "access_denied", error_description: "The user didn't approve the app.", state: pending.s }),
        ),
      );
    }
    // The state AniList carries is a new kind, made only here, and it works only in the browser
    // that approved: a consent-page state sent to someone else, or an approved one copied from
    // another browser, gets nowhere. The cookie is Lax so it comes back on AniList's redirect.
    const signIn = crypto.randomUUID();
    const res = redirect(
      withParams(ANILIST_AUTHORIZE, {
        client_id: this.config.anilistClientId,
        redirect_uri: this.callbackUrl,
        response_type: "code",
        state: await this.sealer.seal("signin", { ...pending, x: signIn } satisfies Pending),
      }),
    );
    res.headers.append(
      "Set-Cookie",
      `aniconnect_signin_${signIn}=1; Path=/oauth/callback; Max-Age=${PENDING_MS / 1000}; HttpOnly; SameSite=Lax${this.secure}`,
    );
    return forget(res);
  }

  /**
   * AniList sends the user back here: swap its code for their token, and send them back to the
   * client. `peer` is the address the request came from.
   */
  async callback(req: Request, peer?: string): Promise<Response> {
    const q = new URL(req.url).searchParams;
    const pending = await this.sealer.open<Pending>("signin", q.get("state"), this.now());
    if (!pending?.x) return page("this sign-in has expired or isn't valid. Start again from your MCP client.");
    const cookie = `aniconnect_signin_${pending.x}`;
    if (!(req.headers.get("Cookie") ?? "").split(/;\s*/).some((c) => c.startsWith(`${cookie}=`))) {
      return page("this sign-in was started in another browser. Start again from your MCP client.", 403);
    }
    this.forgetExpired();
    if (this.used.has(pending.x)) return page("this sign-in has already been used. Start again from your MCP client.");
    const code = q.get("code");
    if (code) {
      // Refused before the sign-in is marked used, so reloading finishes it once there's room.
      const waitMs = this.exchangeWait(this.clientAddress(req, peer));
      if (waitMs > 0) {
        const seconds = Math.ceil(waitMs / 1000);
        const res = page(`too many sign-ins from your network in the last minute. Wait ${seconds} seconds, then reload this page.`, 429);
        res.headers.set("Retry-After", String(seconds));
        return res;
      }
    }
    this.used.set(pending.x, pending.exp);
    const back = (params: Record<string, string>) => {
      const res = redirect(withParams(pending.r, { ...params, state: pending.s }));
      res.headers.append("Set-Cookie", `${cookie}=; Path=/oauth/callback; Max-Age=0; HttpOnly; SameSite=Lax${this.secure}`);
      return res;
    };

    if (!code) {
      return back({
        error: "access_denied",
        error_description: q.get("error_description") ?? "AniList sign-in was cancelled.",
      });
    }
    let token: string;
    let expiresAt: number;
    try {
      ({ token, expiresAt } = await this.exchange(code));
    } catch (err) {
      return back({ error: "server_error", error_description: `AniList sign-in failed: ${(err as Error).message}` });
    }
    if (this.isRevoked(token)) {
      return back({ error: "access_denied", error_description: "This AniList account's access to this server has been revoked." });
    }
    const ours: Code = { ...pending, t: token, te: expiresAt, j: crypto.randomUUID(), exp: this.now() + CODE_MS };
    return back({ code: await this.sealer.seal("code", ours) });
  }

  /** The client's address: from the proxy's header (see `clientIpHeader`), else the connection's. */
  private clientAddress(req: Request, peer: string | undefined): string {
    const header = req.headers.get(this.config.clientIpHeader ?? "X-Real-IP")?.split(",").at(-1)?.trim().slice(0, 100);
    return header || peer || "unknown";
  }

  /** Counts a code exchange for `address`, or, when it has had its share this minute, says how long until the next. */
  private exchangeWait(address: string): number {
    const now = this.now();
    const times = (this.exchanges.get(address) ?? []).filter((t) => t > now - MINUTE_MS);
    if (times.length >= SIGNIN_EXCHANGES_PER_MINUTE) return times[0]! + MINUTE_MS - now;
    times.push(now);
    this.exchanges.set(address, times);
    return 0;
  }

  /** AniList's authorization code grant: its code for the user's token. */
  private async exchange(code: string): Promise<{ token: string; expiresAt: number }> {
    const res = await this.fetchFn(ANILIST_TOKEN, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({
        grant_type: "authorization_code",
        client_id: this.config.anilistClientId,
        client_secret: this.config.anilistClientSecret,
        redirect_uri: this.callbackUrl,
        code,
      }),
      signal: AbortSignal.timeout(15_000),
    });
    let body: { access_token?: unknown; expires_in?: unknown; error?: unknown; message?: unknown } = {};
    try {
      body = (await res.json()) as typeof body;
    } catch {
      // Reported below.
    }
    if (!res.ok || typeof body.access_token !== "string" || !body.access_token) {
      const why = typeof body.message === "string" ? body.message : typeof body.error === "string" ? body.error : `HTTP ${res.status}`;
      throw new Error(why);
    }
    const token = body.access_token;
    const expiresAt =
      tokenExpiry(token) ??
      (typeof body.expires_in === "number" ? this.now() + body.expires_in * 1000 : this.now() + YEAR_MS);
    return { token, expiresAt };
  }

  /** The token endpoint: our code for an access token. */
  async token(req: Request): Promise<Response> {
    try {
      const form = await this.form(req);
      if (form.get("grant_type") !== "authorization_code") {
        throw new OAuthError("unsupported_grant_type", "Only the authorization_code grant is supported.");
      }
      // Client authentication: HTTP Basic, a secret in the form, or none for public clients.
      let clientId = form.get("client_id");
      let secret = form.get("client_secret");
      const basic = req.headers.get("Authorization");
      if (basic?.toLowerCase().startsWith("basic ")) {
        const [id, pass] = Buffer.from(basic.slice(6).trim(), "base64").toString("utf8").split(":");
        try {
          clientId = decodeURIComponent(id ?? "");
          secret = decodeURIComponent(pass ?? "");
        } catch {
          throw new OAuthError("invalid_client", "Malformed Basic credentials.", 401);
        }
      }
      const client = await this.client(clientId);
      if (!client || !clientId) throw new OAuthError("invalid_client", "Unknown client_id.", 401);
      const hash = await sha256(clientId);
      if (client.m !== "none") {
        const ok = await this.sealer.open<{ c: string }>("secret", secret, this.now());
        if (ok?.c !== hash) throw new OAuthError("invalid_client", "Wrong or missing client_secret.", 401);
      }

      const code = await this.sealer.open<Code>("code", form.get("code"), this.now());
      if (!code || code.c !== hash) throw new OAuthError("invalid_grant", "The code is invalid or has expired.");
      const redirectUri = form.get("redirect_uri");
      if (redirectUri !== null && redirectUri !== code.r) {
        throw new OAuthError("invalid_grant", "redirect_uri doesn't match the one used to sign in.");
      }
      const verifier = form.get("code_verifier");
      if (!verifier || (await sha256(verifier)) !== code.cc) {
        throw new OAuthError("invalid_grant", "code_verifier doesn't match the code_challenge.");
      }
      const resource = form.get("resource");
      if (resource && !this.isResource(resource)) throw new OAuthError("invalid_target", `Tokens here are for ${this.resource}.`);
      this.forgetExpired();
      if (this.used.has(code.j)) throw new OAuthError("invalid_grant", "The code has already been used.");
      this.used.set(code.j, code.exp);

      const access = await this.sealer.seal("access", { t: code.t, exp: code.te } satisfies Access);
      return json({
        access_token: access,
        token_type: "Bearer",
        expires_in: Math.max(0, Math.floor((code.te - this.now()) / 1000)),
      });
    } catch (err) {
      if (err instanceof OAuthError) return errorJson(err);
      throw err;
    }
  }

  /** The AniList token inside a bearer token we issued, or null if it isn't valid now. */
  async anilistToken(bearer: string | null): Promise<string | null> {
    const token = (await this.sealer.open<Access>("access", bearer, this.now()))?.t;
    return token && !this.isRevoked(token) ? token : null;
  }

  /** The WWW-Authenticate header that points a client at sign-in (RFC 9728). */
  challenge(error?: string): string {
    return `Bearer resource_metadata="${this.resourceMetadataUrl}"${error ? `, error="${error}"` : ""}`;
  }

  private isResource(value: string): boolean {
    // Clients name either the MCP endpoint or the server (RFC 8707); a trailing slash is the same place.
    const strip = (s: string) => s.replace(/\/+$/, "");
    return strip(value) === this.resource || strip(value) === this.origin;
  }

  private async form(req: Request): Promise<URLSearchParams> {
    const type = req.headers.get("Content-Type") ?? "";
    if (type.includes("application/json")) {
      const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
      return new URLSearchParams(
        Object.entries(body).filter((e): e is [string, string] => typeof e[1] === "string"),
      );
    }
    return new URLSearchParams(await req.text());
  }

  private forgetExpired(): void {
    const now = this.now();
    for (const [id, exp] of this.used) if (exp <= now) this.used.delete(id);
    for (const [address, times] of this.exchanges) if (times.at(-1)! <= now - MINUTE_MS) this.exchanges.delete(address);
  }
}
