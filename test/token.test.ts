import { describe, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { AniListClient } from "../src/anilist";
import { createServer } from "../src/server";
import { tokenExpiry } from "../src/token";
import { FakeAniList } from "./support/fake-anilist";

const NOW = Date.parse("2026-11-17T12:00:00Z");
const DAY = 24 * 60 * 60 * 1000;

const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
/** A made-up JWT shaped like AniList's (unsigned; only the payload matters here). */
const jwt = (payload: Record<string, unknown>) => `${b64({ typ: "JWT", alg: "RS256" })}.${b64(payload)}.c2ln`;
const expiringIn = (ms: number) => jwt({ aud: "1", sub: "1", exp: Math.floor((NOW + ms) / 1000) });

async function setup(token: string) {
  const fake = new FakeAniList();
  let at = NOW;
  const server = createServer(new AniListClient(token, fake.fetch), { now: () => at });
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "t", version: "0" });
  await Promise.all([server.connect(b), client.connect(a)]);
  const call = async () => {
    const r = (await client.callTool({ name: "search_anime", arguments: { query: "titan" } })) as {
      content: { text: string }[];
      isError?: boolean;
    };
    return { text: r.content.map((c) => c.text).join("\n"), isError: Boolean(r.isError) };
  };
  return { fake, call, advance: (ms: number) => (at += ms) };
}

describe("tokenExpiry", () => {
  test("reads exp from a JWT", () => {
    expect(tokenExpiry(jwt({ exp: 1800000000 }))).toBe(1800000000 * 1000);
  });

  test("null when the token can't be decoded", () => {
    expect(tokenExpiry("test-token")).toBeNull();
    expect(tokenExpiry("a.b.c")).toBeNull();
    expect(tokenExpiry(jwt({ sub: "1" }))).toBeNull();
    expect(tokenExpiry(jwt({ exp: "soon" }))).toBeNull();
  });
});

describe("token expiry in tool results", () => {
  test("far from expiry: no warning", async () => {
    const { call } = await setup(expiringIn(200 * DAY));
    const r = await call();
    expect(r.isError).toBe(false);
    expect(r.text).toContain("Attack on Titan");
    expect(r.text).not.toContain("token");
  });

  test("inside the warning window: one line on the first call, then once a day", async () => {
    const { call, advance } = await setup(expiringIn(10 * DAY));
    let r = await call();
    expect(r.isError).toBe(false);
    expect(r.text).toContain("Attack on Titan");
    expect(r.text).toContain("Heads-up: the AniList token expires on 2026-11-27 (in 10 days).");
    expect(r.text).toContain("https://anilist.co/api/v2/oauth/authorize?client_id=YOUR_CLIENT_ID&response_type=token");
    expect(r.text.split("\n").filter((l) => l.includes("token expires")).length).toBe(1);

    advance(60 * 60 * 1000);
    r = await call();
    expect(r.text).not.toContain("token expires");

    advance(DAY);
    r = await call();
    expect(r.text).toContain("expires on 2026-11-27 (in 9 days)");
  });

  test("expired: fails with a clear message and sends no request", async () => {
    const { call, fake } = await setup(expiringIn(-3 * DAY));
    const r = await call();
    expect(r.isError).toBe(true);
    expect(r.text).toContain("AniList token expired on 2026-11-14, so nothing was sent.");
    expect(r.text).toContain("ANILIST_TOKEN");
    expect(fake.calls.length).toBe(0);
  });

  test("expires mid-session: later calls fail without a request", async () => {
    const { call, fake, advance } = await setup(expiringIn(DAY));
    expect((await call()).text).toContain("(in 1 day)");
    const sent = fake.calls.length;
    advance(2 * DAY);
    const r = await call();
    expect(r.isError).toBe(true);
    expect(fake.calls.length).toBe(sent);
  });

  test("undecodable token: behaves as before", async () => {
    for (const token of ["test-token", "a.b.c", jwt({ sub: "1" })]) {
      const { call, fake } = await setup(token);
      const r = await call();
      expect(r.isError).toBe(false);
      expect(r.text).not.toContain("token");
      expect(fake.calls.length).toBeGreaterThan(0);
    }
  });
});
