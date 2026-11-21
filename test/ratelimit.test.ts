/**
 * The rate limiter shared by AniList clients (one per sign-in on the hosted server), and the
 * retry of reads that fail on AniList's side. Time is a fake clock: sleeps resolve only when
 * the test moves it to them, so a minute passes at once.
 */
import { describe, expect, test } from "bun:test";
import { AniListClient, RateLimiter } from "../src/anilist";

class FakeClock {
  t = 0;
  private timers: { at: number; resolve: () => void }[] = [];
  now = () => this.t;
  sleep = (ms: number) => new Promise<void>((resolve) => this.timers.push({ at: this.t + ms, resolve }));

  /** Runs `work` to its end, moving the clock to each sleep in turn, earliest first. */
  async run<T>(work: Promise<T>): Promise<T> {
    let done = false;
    work.then(
      () => (done = true),
      () => (done = true),
    );
    for (;;) {
      for (let i = 0; i < 20 && !done; i++) await new Promise((r) => setImmediate(r));
      if (done) return work;
      this.timers.sort((a, b) => a.at - b.at);
      const next = this.timers.shift();
      if (!next) throw new Error("stuck: nothing to wait for");
      this.t = Math.max(this.t, next.at);
      next.resolve();
    }
  }
}

const QUERY = "query { Viewer { id } }";
const WRITE = "mutation { SaveMediaListEntry(mediaId: 1) { id } }";
const ok = () => Response.json({ data: { Viewer: { id: 1 } } });

/** Clients on one clock and one limiter, and what reached the fake AniList: who, and when. */
function setup(limiter: RateLimiter, answer: (name: string, n: number, init: RequestInit) => Response | Promise<Response> = ok) {
  const clock = new FakeClock();
  const sent: { name: string; at: number }[] = [];
  const client = (name: string) => {
    const c = new AniListClient(
      name,
      async (_url, init) => {
        sent.push({ name, at: clock.t });
        return answer(name, sent.filter((s) => s.name === name).length, init);
      },
      undefined,
      limiter,
    );
    c.now = clock.now;
    c.sleep = clock.sleep;
    return c;
  };
  const outcome = (p: Promise<unknown>) => p.then(() => "ok", (e: Error) => e.message);
  return { clock, sent, client, outcome };
}

/** The most requests sent in any 60 seconds. */
function busiestMinute(times: number[]): number {
  return Math.max(...times.map((t) => times.filter((u) => u >= t && u < t + 60_000).length));
}

describe("shared rate limit", () => {
  test("clients sharing a limiter wait their turn, and one too far off fails with the wait", async () => {
    const { clock, sent, client, outcome } = setup(new RateLimiter(3));
    const [a, b, c] = [client("a"), client("b"), client("c")];
    const results = await clock.run(
      (async () => {
        await a.request(QUERY);
        await clock.sleep(20_000);
        await a.request(QUERY);
        await clock.sleep(20_000);
        await a.request(QUERY); // t=40s: the window is full until a's first request leaves it at 60s
        await clock.sleep(5_000);
        return Promise.all([outcome(b.request(QUERY)), outcome(c.request(QUERY))]);
      })(),
    );
    // b, first in line, waits 15 seconds for the slot a's first request frees; c's would be
    // 35 seconds off, over the 30-second bound, so it isn't sent and says how long to wait.
    expect(sent).toEqual([
      { name: "a", at: 0 },
      { name: "a", at: 20_000 },
      { name: "a", at: 40_000 },
      { name: "b", at: 60_000 },
    ]);
    expect(results).toEqual(["ok", "AniList rate limit hit (3 requests a minute). Try again in 35 seconds."]);
  });

  test("three busy clients stay under 30 requests a minute between them", async () => {
    const { clock, sent, client } = setup(new RateLimiter());
    const longest: number[] = [];
    // Each sends 25 requests a second apart, and on a rate-limit error waits as told and goes on.
    // `longest` is how long each request took, waiting for its slot included.
    const user = async (name: string) => {
      const c = client(name);
      for (let done = 0; done < 25; ) {
        const start = clock.t;
        const error = await c.request(QUERY).then(() => null, (err: Error) => err);
        longest.push(clock.t - start);
        if (!error) done++;
        else {
          const seconds = /Try again in (\d+) seconds/.exec(error.message);
          if (!seconds) throw error;
          await clock.sleep(Number(seconds[1]) * 1000);
        }
        await clock.sleep(1_000);
      }
    };
    await clock.run(Promise.all(["a", "b", "c"].map(user)));
    expect(sent.length).toBe(75);
    expect(busiestMinute(sent.map((s) => s.at))).toBe(30);
    expect(Math.max(...longest)).toBeLessThanOrEqual(30_000);
    // First come, first served: no client was shut out while another went on.
    const firstMinute = sent.filter((s) => s.at < 60_000).map((s) => s.name);
    expect(["a", "b", "c"].map((n) => firstMinute.filter((x) => x === n).length)).toEqual([10, 10, 10]);
  });

  test("a 429 seen by one client makes the others wait too", async () => {
    const { clock, sent, client } = setup(new RateLimiter(), (name, n) =>
      name === "a" && n === 1 ? Response.json({ data: null }, { status: 429, headers: { "Retry-After": "10" } }) : ok(),
    );
    const [a, b] = [client("a"), client("b")];
    await clock.run(
      Promise.all([
        a.request(QUERY),
        (async () => {
          await clock.sleep(1_000);
          await b.request(QUERY);
        })(),
      ]),
    );
    expect(sent).toEqual([
      { name: "a", at: 0 },
      { name: "a", at: 10_000 },
      { name: "b", at: 10_000 },
    ]);
  });

  test("a 429 that arrives while a request waits for its slot makes it wait longer", async () => {
    const limiter = new RateLimiter(2);
    const { clock, sent, client, outcome } = setup(limiter, async (name, n) => {
      if (name !== "a" || n !== 2) return ok();
      await clock.sleep(35_000); // answered at t=55s
      return Response.json({ data: null }, { status: 429, headers: { "Retry-After": "20" } });
    });
    const [a, b] = [client("a"), client("b")];
    const results = await clock.run(
      (async () => {
        await a.request(QUERY);
        await clock.sleep(20_000);
        const slow = outcome(a.request(QUERY)); // sent at 20s, refused at 55s: wait until 75s
        await clock.sleep(30_000);
        const waiting = outcome(b.request(QUERY)); // booked at 50s for the slot at 60s
        return Promise.all([slow, waiting]);
      })(),
    );
    expect(results).toEqual(["ok", "ok"]);
    expect(sent.map((s) => `${s.name}@${s.at / 1000}`)).toEqual(["a@0", "a@20", "b@75", "a@80"]);
  });

  test("a request counts from when it is really sent, and not at all if it gives up", () => {
    const limiter = new RateLimiter(1);
    expect(limiter.book(0)).toEqual({ at: 0 });
    limiter.move(0, 20_000); // it waited out a 429 until 20s
    expect(limiter.book(50_000)).toEqual({ at: 80_000 });
    limiter.move(80_000, null); // it gave up
    expect(limiter.book(81_000)).toEqual({ at: 81_000 });
  });

  test("follows the limit and the requests left that AniList reports", async () => {
    let headers: Record<string, string> = { "X-RateLimit-Limit": "90", "X-RateLimit-Remaining": "89" };
    const { clock, sent, client, outcome } = setup(new RateLimiter(), () => Response.json({ data: { Viewer: { id: 1 } } }, { headers }));
    const a = client("a");
    // Not degraded: 90 a minute, so once AniList has said so, 40 at once all go.
    await clock.run(a.request(QUERY));
    await clock.run(Promise.all(Array.from({ length: 40 }, () => a.request(QUERY))));
    expect(sent.length).toBe(41);
    // AniList counts requests this process didn't send (another app on the same IP): none left.
    headers = { "X-RateLimit-Limit": "90", "X-RateLimit-Remaining": "0" };
    await clock.run(a.request(QUERY));
    expect(await clock.run(outcome(a.request(QUERY)))).toBe("AniList rate limit hit (90 requests a minute). Try again in 60 seconds.");
    expect(sent.length).toBe(42);
  });
});

describe("retrying AniList's own failures", () => {
  const serverError = () => new Response("<html>502 Bad Gateway</html>", { status: 502 });
  const graphqlError = () => Response.json({ errors: [{ message: "Internal Server Error", status: 500 }], data: null }, { status: 500 });
  const networkError = () => {
    throw new TypeError("The socket connection was closed unexpectedly.");
  };

  test("a read failing with a 5xx or a network error is sent once more after a pause", async () => {
    for (const failure of [serverError, graphqlError, networkError]) {
      const { clock, sent, client } = setup(new RateLimiter(), (_, n) => (n === 1 ? failure() : ok()));
      const a = client("a");
      expect(await clock.run(a.request<{ Viewer: { id: number } }>(QUERY))).toEqual({ Viewer: { id: 1 } });
      expect(sent).toEqual([
        { name: "a", at: 0 },
        { name: "a", at: 1_000 },
      ]);
    }
  });

  test("a read is retried once, then the failure is reported", async () => {
    const { clock, sent, client, outcome } = setup(new RateLimiter(), serverError);
    expect(await clock.run(outcome(client("a").request(QUERY)))).toBe("AniList returned HTTP 502 with a non-JSON body.");
    expect(sent.length).toBe(2);
  });

  test("a write is never retried: it may have been saved", async () => {
    for (const failure of [serverError, graphqlError, networkError]) {
      const { clock, sent, client, outcome } = setup(new RateLimiter(), failure);
      expect(await clock.run(outcome(client("a").request(WRITE)))).toMatch(/AniList|Could not reach/);
      expect(sent.length).toBe(1);
    }
  });

  test("a read that times out isn't retried", async () => {
    const { clock, sent, client, outcome } = setup(
      new RateLimiter(),
      (_, __, init) => new Promise<Response>((_, reject) => init.signal!.addEventListener("abort", () => reject(init.signal!.reason))),
    );
    const a = client("a");
    a.requestTimeoutMs = 20;
    // The timeout is real time (AbortSignal.timeout), so this waits 20 ms for it.
    const result = outcome(a.request(QUERY));
    await Bun.sleep(30);
    expect(await clock.run(result)).toBe("AniList didn't respond within 0.02 seconds; try again.");
    expect(sent.length).toBe(1);
  });
});
