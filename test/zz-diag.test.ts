// TEMPORARY diagnostics for PR #50's Linux-only failure. Removed before merge.
import { test } from "bun:test";
import { createHttpApp, SERVE_OPTIONS } from "../src/http";

test("diag: chunked bodies on this platform", async () => {
  const pad = "x".repeat(1024 * 1024);
  const fits = JSON.stringify({ redirect_uris: ["http://localhost:9999/callback"], pad: pad.slice(0, -1000) });
  const big = JSON.stringify({ redirect_uris: ["http://localhost:9999/callback"], pad });
  const chunked = (text: string) =>
    new ReadableStream({
      start(c) {
        for (let i = 0; i < text.length; i += 64 * 1024) c.enqueue(new TextEncoder().encode(text.slice(i, i + 64 * 1024)));
        c.close();
      },
    });
  // A raw echo server: what bytes does a chunked upload deliver?
  const echo = Bun.serve({
    ...SERVE_OPTIONS,
    port: 0,
    async fetch(r) {
      const t = await r.text();
      return Response.json({ len: t.length, ok: t === fits, te: r.headers.get("transfer-encoding"), cl: r.headers.get("content-length") });
    },
  });
  console.log("DIAG echo chunked fits:", JSON.stringify(await (await fetch(`http://localhost:${echo.port}/`, { method: "POST", body: chunked(fits) })).json()), "expected len", fits.length);
  echo.stop(true);

  let handler: (req: Request) => Promise<Response> = async () => new Response(null, { status: 503 });
  const server = Bun.serve({ ...SERVE_OPTIONS, port: 0, fetch: (req) => handler(req) });
  const base = `http://localhost:${server.port}`;
  const app = await createHttpApp(
    { publicUrl: base, anilistClientId: "1", anilistClientSecret: "s", authSecret: "x".repeat(40) },
    { fetch: async () => new Response("{}") },
  );
  handler = app.fetch;
  const post = async (label: string, body: string | ReadableStream) => {
    const res = await fetch(`${base}/register`, { method: "POST", headers: { "Content-Type": "application/json" }, body });
    console.log(`DIAG ${label}:`, res.status, JSON.stringify([...res.headers].filter(([k]) => /connection|content-type/.test(k))), (await res.text()).slice(0, 200));
  };
  await post("1 chunked fits, fresh", chunked(fits));
  await post("2 plain fits", fits);
  await post("3 chunked big", chunked(big));
  await post("4 plain fits after chunked 413", fits);
  await post("5 chunked fits after chunked 413", chunked(fits));
  await post("6 chunked fits again", chunked(fits));
  server.stop(true);
});
