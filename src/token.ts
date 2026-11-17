/**
 * AniList access tokens are JWTs whose `exp` claim is the expiry time
 * (https://anilist.gitbook.io/anilist-apiv2-docs/docs/guide/auth/authenticated-requests),
 * so the expiry can be read locally. Nothing here logs the token or its payload.
 */

const DAY_MS = 24 * 60 * 60 * 1000;

/** Warn when the token expires within this many days. */
export const WARN_DAYS = 14;

/** Show the warning again after this long, for servers that run for weeks. */
const REPEAT_MS = DAY_MS;

const RENEW =
  'Get a new one: open https://anilist.co/api/v2/oauth/authorize?client_id=YOUR_CLIENT_ID&response_type=token with your client ID from anilist.co/settings/developer, approve, and put the token in ANILIST_TOKEN (README, "Get an AniList token").';

/** The token's expiry in ms, or null if it isn't a JWT with a numeric `exp`. */
export function tokenExpiry(token: string): number | null {
  const parts = token.split(".");
  if (parts.length !== 3 || !parts[1]) return null;
  try {
    const exp = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"))?.exp;
    return typeof exp === "number" && Number.isFinite(exp) && exp > 0 ? exp * 1000 : null;
  } catch {
    return null;
  }
}

/** e.g. "2026-11-27 03:00 UTC": a date alone can read as the wrong day outside UTC. */
function day(ms: number): string {
  return `${new Date(ms).toISOString().slice(0, 16).replace("T", " ")} UTC`;
}

/**
 * Decides, for each tool call, whether the token has expired (fail before any request)
 * or expires soon (add a one-line warning: on the first call, then at most once a day).
 */
export function tokenWatch(expiresAt: number | null) {
  let warnedAt: number | null = null;
  return (at: number): { expired: string } | { warning: string } | null => {
    if (expiresAt === null) return null;
    if (expiresAt <= at) {
      return { expired: `AniList token expired on ${day(expiresAt)}, so nothing was sent. ${RENEW}` };
    }
    if (expiresAt - at > WARN_DAYS * DAY_MS) return null;
    if (warnedAt !== null && at - warnedAt < REPEAT_MS) return null;
    warnedAt = at;
    const days = Math.ceil((expiresAt - at) / DAY_MS);
    return {
      warning: `Heads-up: the AniList token expires on ${day(expiresAt)} (in ${days} day${days === 1 ? "" : "s"}). ${RENEW}`,
    };
  };
}
