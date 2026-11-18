/** Serves a fake AniList over HTTP, for MCP servers running in their own process. */
import type { FakeAniList } from "../test/support/fake-anilist";

export function serveFake(fake: FakeAniList) {
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch: async (req) => {
      try {
        return await fake.fetch(req.url, { method: req.method, headers: req.headers, body: await req.text() });
      } catch (err) {
        // A bug in the fake, not something AniList would do: say so where the eval shows it.
        console.error(`Fake AniList failed: ${(err as Error).stack}`);
        return Response.json({ errors: [{ message: `Fake AniList failed: ${(err as Error).message}`, status: 500 }], data: null }, { status: 500 });
      }
    },
  });
  return { url: `http://127.0.0.1:${server.port}`, stop: () => server.stop(true) };
}
