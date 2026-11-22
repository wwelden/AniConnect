/**
 * The rate limiter shared by AniList clients (one per sign-in on the hosted server), and the
 * retry of reads that fail on AniList's side. Time is a fake clock: sleeps resolve only when
 * the test moves it to them, so a minute passes at once.
 */
import { describe, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { AniListClient, CALL_WAIT_MS, RateLimiter, withWaitDeadline } from "../src/anilist";
import { createServer } from "../src/server";
import { FakeAniList } from "./support/fake-anilist";

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
  /** `owner` groups requests by user, as the hosted server does by AniList account. */
  const client = (name: string, owner?: string) => {
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
    c.owner = owner;
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
    // b waited out the pause; a's refused request, which AniList didn't run, gave its slot back.
    expect(sent.map((s) => `${s.name}@${s.at / 1000}`).sort()).toEqual(["a@0", "a@20", "a@75", "b@75"]);
  });

  test("a request counts from when it is really sent, and not at all if it gives up", () => {
    const limiter = new RateLimiter(1);
    expect(limiter.book(0)).toEqual({ at: 0 });
    limiter.move(0, 20_000); // it waited out a 429 until 20s
    expect(limiter.book(50_000)).toEqual({ at: 80_000 });
    limiter.move(80_000, null); // it gave up
    expect(limiter.book(81_000)).toEqual({ at: 81_000 });
  });

  test("follows the limit AniList reports", async () => {
    const { clock, sent, client } = setup(new RateLimiter(), () =>
      Response.json({ data: { Viewer: { id: 1 } } }, { headers: { "X-RateLimit-Limit": "90", "X-RateLimit-Remaining": "89" } }),
    );
    const a = client("a");
    // Not degraded: 90 a minute, so once AniList has said so, 40 at once all go.
    await clock.run(a.request(QUERY));
    await clock.run(Promise.all(Array.from({ length: 40 }, () => a.request(QUERY))));
    expect(sent.length).toBe(41);
    expect(sent.every((s) => s.at === 0)).toBe(true);
  });

  test("a tool call's requests together stop waiting 40 seconds after it starts", async () => {
    const { clock, sent, client, outcome } = setup(new RateLimiter(2));
    const [a, b] = [client("a"), client("b")];
    const result = await clock.run(
      (async () => {
        await a.request(QUERY);
        await clock.sleep(30_000);
        await a.request(QUERY); // the window is full until 60s, then until 90s
        await clock.sleep(5_000);
        // A tool call starting at 35s: its first request waits 25 seconds; its second would
        // wait until 90s, within 30 seconds of asking but past the call's 75s deadline.
        return withWaitDeadline(clock.t + CALL_WAIT_MS, async () => {
          await b.request(QUERY);
          return outcome(b.request(QUERY));
        });
      })(),
    );
    expect(result).toBe("AniList rate limit hit (2 requests a minute). Try again in 30 seconds.");
    expect(sent.map((s) => `${s.name}@${s.at / 1000}`)).toEqual(["a@0", "a@30", "b@60"]);
    // Past its deadline, a call's requests still go when there's room.
    clock.t = 200_000;
    await clock.run(withWaitDeadline(0, () => b.request(QUERY)));
    expect(sent.length).toBe(4);
  });

  test("every tool call gets that deadline", async () => {
    const fake = new FakeAniList();
    const { clock, sent, client } = setup(new RateLimiter(2), (_, __, init) => fake.fetch("", init));
    const [a, b] = [client("a"), client("b")];
    const [ct, st] = InMemoryTransport.createLinkedPair();
    const mcp = new Client({ name: "t", version: "0" });
    await Promise.all([createServer(b, { now: clock.now }).connect(st), mcp.connect(ct)]);
    const text = await clock.run(
      (async () => {
        await a.request(QUERY);
        await clock.sleep(30_000);
        await a.request(QUERY);
        await clock.sleep(5_000);
        // The viewer waits until 60s; the list would go at 90s, past the call's 75s deadline.
        const r = (await mcp.callTool({ name: "search_my_list", arguments: {} })) as { content: { text: string }[] };
        return r.content.map((c) => c.text).join("\n");
      })(),
    );
    expect(text).toContain("AniList rate limit hit (2 requests a minute). Try again in 30 seconds.");
    expect(sent.map((s) => `${s.name}@${s.at / 1000}`)).toEqual(["a@0", "a@30", "b@60"]);
  });
});

describe("sharing the limit fairly between users", () => {
  test("a user alone has the whole limit", () => {
    const limiter = new RateLimiter(30);
    for (let i = 0; i < 30; i++) expect(limiter.book(0, undefined, "a")).toEqual({ at: 0 });
    expect(limiter.book(0, undefined, "a")).toEqual({ waitMs: 60_000 });
  });

  test("while another user has a request in the window, one user holds at most half of it", () => {
    const limiter = new RateLimiter(30);
    expect(limiter.book(0, undefined, "b")).toEqual({ at: 0 });
    for (let i = 0; i < 15; i++) expect(limiter.book(10_000, undefined, "a")).toEqual({ at: 10_000 });
    // a's 16th waits until a's own first leaves the window, at 70s.
    expect(limiter.book(10_000, undefined, "a")).toEqual({ waitMs: 60_000 });
    expect(limiter.book(10_000, Number.POSITIVE_INFINITY, "a")).toEqual({ at: 70_000 });
    // b still finds room at once.
    expect(limiter.book(11_000, undefined, "b")).toEqual({ at: 11_000 });
  });

  test("slots a capped user books ahead don't hold up another user now", () => {
    const limiter = new RateLimiter(30);
    expect(limiter.book(0, undefined, "b")).toEqual({ at: 0 });
    for (let i = 0; i < 15; i++) limiter.book(0, undefined, "a");
    // At 35s a's next 15 are booked for 60s, when its first 15 leave the window.
    for (let i = 0; i < 15; i++) expect(limiter.book(35_000, undefined, "a")).toEqual({ at: 60_000 });
    expect(limiter.book(35_000, undefined, "a")).toEqual({ waitMs: 25_000 + 60_000 });
    // b, still in the window, goes at once: no minute holds more than 30.
    expect(limiter.book(36_000, undefined, "b")).toEqual({ at: 36_000 });
  });

  test("a capped user can't book past another user's last slot leaving the window", () => {
    const limiter = new RateLimiter(30);
    expect(limiter.book(0, undefined, "b")).toEqual({ at: 0 });
    for (let i = 0; i < 15; i++) expect(limiter.book(35_000, undefined, "a")).toEqual({ at: 35_000 });
    expect(limiter.book(35_000, undefined, "a")).toEqual({ waitMs: 60_000 });
    expect(limiter.book(36_000, undefined, "b")).toEqual({ at: 36_000 });
  });

  test("requests without an owner share one, so a lone local user is never capped", () => {
    const limiter = new RateLimiter(4);
    for (let i = 0; i < 4; i++) expect(limiter.book(0)).toEqual({ at: 0 });
  });

  test("one user's burst leaves room for another user's next call", async () => {
    const { clock, sent, client, outcome } = setup(new RateLimiter(30));
    const [alice, bob] = [client("alice", "user:1"), client("bob", "user:2")];
    const results = await clock.run(
      (async () => {
        await bob.request(QUERY);
        await clock.sleep(1_000);
        const burst = Promise.all(Array.from({ length: 35 }, () => outcome(alice.request(QUERY))));
        await clock.sleep(1_000);
        const next = await outcome(bob.request(QUERY));
        return { burst: await burst, next };
      })(),
    );
    // Alice gets half the minute; the rest of her burst is told to wait until her first
    // requests leave the window. Bob's next call goes at once instead of waiting out the minute.
    expect(results.burst.filter((r) => r === "ok").length).toBe(15);
    expect(new Set(results.burst.filter((r) => r !== "ok"))).toEqual(
      new Set(["AniList rate limit hit (30 requests a minute). Try again in 60 seconds."]),
    );
    expect(results.next).toBe("ok");
    expect(sent.filter((s) => s.name === "bob").map((s) => s.at)).toEqual([0, 2_000]);
  });

  test("a request that gives its slot back gives back its own user's", () => {
    const limiter = new RateLimiter(4);
    expect(limiter.book(0, undefined, "a")).toEqual({ at: 0 });
    expect(limiter.book(0, undefined, "a")).toEqual({ at: 0 });
    expect(limiter.book(0, undefined, "b")).toEqual({ at: 0 });
    limiter.move(0, null, "b");
    // Only a is left in the window, so a has the whole limit again.
    expect(limiter.book(0, undefined, "a")).toEqual({ at: 0 });
    expect(limiter.book(0, undefined, "a")).toEqual({ at: 0 });
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
