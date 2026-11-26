import { beforeEach, describe, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { ElicitRequestSchema, type ElicitRequest, type ElicitResult } from "@modelcontextprotocol/sdk/types.js";
import { AniListClient } from "../src/anilist";
import { createServer } from "../src/server";
import { PERSONA } from "./fixtures/persona";
import { FakeAniList, findMedia } from "./support/fake-anilist";

const NOW = Date.UTC(2026, 10, 17, 12);
const AOT = findMedia("Shingeki no Kyojin").id;
const DANDADAN = findMedia("Dandadan").id;

let fake: FakeAniList;
let client: Client;
/** Forms the server showed, and how the "user" answers the next one. */
let forms: ElicitRequest["params"][];
let answer: (params: ElicitRequest["params"]) => ElicitResult | Promise<ElicitResult>;

async function call(name: string, args: Record<string, unknown> = {}) {
  const result = (await client.callTool({ name, arguments: args })) as {
    content: { text: string }[];
    isError?: boolean;
  };
  return { text: result.content.map((c) => c.text).join("\n"), isError: Boolean(result.isError) };
}

async function connect(capabilities: Record<string, unknown>) {
  const server = createServer(new AniListClient("test-token", fake.fetch), { now: () => NOW });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  client = new Client({ name: "test", version: "0" }, { capabilities });
  forms = [];
  if ("elicitation" in capabilities) {
    client.setRequestHandler(ElicitRequestSchema, async (req) => {
      forms.push(req.params);
      return answer(req.params);
    });
  }
  await Promise.all([server.connect(st), client.connect(ct)]);
}

function optionsOf(params: ElicitRequest["params"]): { const: string; title: string }[] {
  return (params as unknown as { requestedSchema: { properties: { anime: { oneOf: { const: string; title: string }[] } } } })
    .requestedSchema.properties.anime.oneOf;
}

/** Picks the option whose label contains `text`. */
function choose(text: string) {
  return (params: ElicitRequest["params"]): ElicitResult => {
    const options = optionsOf(params);
    const option = options.find((o) => o.title.includes(text));
    if (!option) throw new Error(`No option with "${text}": ${options.map((o) => o.title).join(" | ")}`);
    return { action: "accept", content: { anime: option.const } };
  };
}

beforeEach(async () => {
  fake = new FakeAniList("POINT_10_DECIMAL").seed(PERSONA);
  fake.clock = () => NOW;
  answer = () => ({ action: "cancel" });
  await connect({ elicitation: {} });
});

describe("picking between ambiguous shows (R2.7)", () => {
  test("asks the user and saves the one they pick", async () => {
    answer = choose("(TV, 2013)");
    const r = await call("rate_anime", { anime: "attack on titan", score: 10 });
    expect(forms).toHaveLength(1);
    expect(forms[0]!.message).toContain("Which one do you mean?");
    expect(r.isError).toBe(false);
    expect(r.text).toStartWith('The user picked Attack on Titan from the matches for "attack on titan".\nRated Attack on Titan:');
    expect(fake.entries.get(AOT)!.scoreRaw).toBe(100);
  });

  test("the choices say which are on the list", async () => {
    answer = choose("(TV, 2013)");
    await call("rate_anime", { anime: "attack on titan", score: 10 });
    expect(optionsOf(forms[0]!)[0]!.title).toBe("Attack on Titan (Shingeki no Kyojin) (TV, 2013), on your list: completed");
  });

  test("changes nothing when the user declines, and says not to ask again", async () => {
    answer = () => ({ action: "decline" });
    const r = await call("rate_anime", { anime: "attack on titan", score: 10 });
    expect(r.isError).toBe(true);
    expect(r.text).toContain("didn't pick one, so don't ask them again");
    expect(fake.writes).toHaveLength(0);
  });

  test("falls back to listing the candidates when the form fails or closes without an answer", async () => {
    for (const reply of [
      () => ({ action: "cancel" as const }),
      () => {
        throw new Error("no UI");
      },
    ]) {
      answer = reply;
      const r = await call("rate_anime", { anime: "attack on titan", score: 10 });
      expect(r.isError).toBe(true);
      expect(r.text).toContain("Ask the user which one they mean");
      expect(r.text).toContain(`[${AOT}]`);
    }
    expect(fake.writes).toHaveLength(0);
  });

  test("update_shows asks about one show", async () => {
    answer = (params) => ({ action: "accept", content: { anime: optionsOf(params)[0]!.const } });
    const r = await call("update_shows", { updates: [{ anime: "attack on titan", score: 10 }] });
    expect(r.isError).toBe(false);
    expect(forms).toHaveLength(1);
  });

  test("a batch doesn't stop to ask: the names that need a choice come back together", async () => {
    answer = () => {
      throw new Error("a batch shouldn't show a form");
    };
    const r = await call("update_shows", {
      updates: [
        { anime: "attack on titan", score: 10 },
        { anime: "hunter x hunter", score: 9 },
        { anime: "dandadan", score: 8 },
      ],
    });
    expect(forms).toHaveLength(0);
    expect(r.isError).toBe(false);
    expect(r.text).toContain("Saved 1 of 3 updates.");
    expect(r.text).toContain(`Not changed: "attack on titan"`);
    expect(r.text).toContain(`[${AOT}]`);
    expect(r.text).toContain(`Not changed: "hunter x hunter"`);
    expect(r.text).toContain("Ask the user which one they mean");
  });

  test("a dry run never asks", async () => {
    const r = await call("update_shows", { updates: [{ anime: "attack on titan", score: 10 }], dryRun: true });
    expect(forms).toHaveLength(0);
    expect(r.text).toContain(`[${AOT}]`);
  });

  test("an anime off the list or the manga on it (R0.17): the user picks the manga, and only it changes", async () => {
    fake.seed([{ anime: 105778, status: "CURRENT", progress: 70 }]); // Chainsaw Man (manga)
    answer = choose("MANGA");
    const r = await call("set_status", { anime: "chainsaw man", status: "PAUSED" });
    expect(forms).toHaveLength(1);
    expect(forms[0]!.message).toContain('"chainsaw man" is on your manga list, and the anime it matches isn\'t on your anime list.');
    expect(optionsOf(forms[0]!).map((o) => o.title)).toEqual([
      "Chainsaw Man (TV, 2022), not on your list",
      "Chainsaw Man (MANGA, 2018), on your list: current",
    ]);
    expect(r.text).toContain("Reading -> Paused: [105778] Chainsaw Man (MANGA, 2018)");
    expect(fake.entries.get(105778)!.status).toBe("PAUSED");
    expect(fake.entries.has(127230)).toBe(false);
  });

  test("picking the anime there adds the anime and leaves the manga", async () => {
    fake.seed([{ anime: 105778, status: "CURRENT", progress: 70 }]);
    answer = choose("(TV, 2022)");
    await call("rate_anime", { anime: "chainsaw man", score: 8 });
    expect(fake.entries.get(127230)!.scoreRaw).toBe(80);
    expect(fake.entries.get(105778)!.scoreRaw).toBe(0);
  });
});

describe("confirming removals (R2.7)", () => {
  test("the description says the tool confirms, so the assistant needn't", async () => {
    const { tools } = await client.listTools();
    const remove = tools.find((t) => t.name === "remove_from_list")!;
    expect(remove.description).toContain("confirms in a dialog");
    expect(remove.description).not.toContain("The first call only shows the entry");
  });

  test("removes after the user confirms", async () => {
    answer = () => ({ action: "accept", content: { confirm: true } });
    const r = await call("remove_from_list", { anime: "dandadan" });
    expect(forms[0]!.message).toBe(
      "Remove DAN DA DAN from your AniList list? DAN DA DAN (TV, 2024): Watching, 7/12 episodes, unrated. Its progress, score, dates and notes go with it.",
    );
    expect(r.text).toContain("Removed DAN DA DAN from your list.");
    expect(fake.entries.has(DANDADAN)).toBe(false);
  });

  test("keeps the show when the user says no or unticks the box", async () => {
    for (const reply of [
      () => ({ action: "decline" as const }),
      () => ({ action: "accept" as const, content: { confirm: false } }),
    ]) {
      answer = reply;
      const r = await call("remove_from_list", { anime: "dandadan" });
      expect(r.text).toEndWith("Not removed: the user chose to keep DAN DA DAN.");
      expect(fake.entries.has(DANDADAN)).toBe(true);
    }
  });

  test("a dialog closed without an answer leaves the assistant to confirm with a second call (claude -p cancels every form)", async () => {
    for (const reply of [
      () => ({ action: "cancel" as const }),
      () => {
        throw new Error("timed out");
      },
    ]) {
      answer = reply;
      const r = await call("remove_from_list", { anime: "dandadan" });
      expect(r.text).toContain("Not removed yet. DAN DA DAN (TV, 2024): Watching, 7/12 episodes, unrated");
      expect(r.text).toContain("call again with confirmed: true");
      expect(fake.entries.has(DANDADAN)).toBe(true);
    }
    const r = await call("remove_from_list", { anime: "dandadan", confirmed: true });
    expect(forms).toHaveLength(2);
    expect(r.text).toContain("Removed DAN DA DAN");
  });
});

test("confirmed: true doesn't skip the dialog unless one closed without an answer", async () => {
  answer = () => ({ action: "decline" });
  const r = await call("remove_from_list", { anime: "dandadan", confirmed: true });
  expect(forms).toHaveLength(1);
  expect(r.text).toContain("chose to keep");
  expect(fake.entries.has(DANDADAN)).toBe(true);
});

describe("clients without forms", () => {
  beforeEach(() => connect({}));

  test("ambiguous names come back as candidates, as before", async () => {
    const r = await call("rate_anime", { anime: "attack on titan", score: 10 });
    expect(r.isError).toBe(true);
    expect(r.text).toContain("Ask the user which one they mean");
  });

  test("removal shows the entry first, then removes it on a second call, without a form", async () => {
    const { tools } = await client.listTools();
    expect(tools.find((t) => t.name === "remove_from_list")!.description).toContain("The first call only shows the entry");
    let r = await call("remove_from_list", { anime: "dandadan" });
    expect(r.text).toContain("Not removed yet");
    expect(fake.entries.has(DANDADAN)).toBe(true);
    r = await call("remove_from_list", { anime: "dandadan", confirmed: true });
    expect(r.text).toContain("Removed DAN DA DAN");
    expect(forms).toHaveLength(0);
  });
});
