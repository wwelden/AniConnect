#!/usr/bin/env bun
/**
 * Starts one eval server against the fake AniList (seeded with the eval persona) without
 * a model, lists its tools, and optionally calls one. For checking a server works with
 * the fake before spending a model run on it.
 *
 *   bun evals/probe.ts --server ani-mcp
 *   bun evals/probe.ts --server anilist-mcp --call get_user_anime_list --args '{"username":"tester"}'
 */
import { parseArgs } from "node:util";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { HISTORY, PERSONA } from "../test/fixtures/persona";
import { FakeAniList } from "../test/support/fake-anilist";
import { NOW } from "./clock";
import { serveFake } from "./fake-http";
import { SERVERS } from "./servers";

const { values: args } = parseArgs({
  options: { server: { type: "string", default: "aniconnect" }, call: { type: "string" }, args: { type: "string", default: "{}" } },
});
const spec = SERVERS[args.server!];
if (!spec) throw new Error(`Unknown server ${args.server}; pick one of ${Object.keys(SERVERS).join(", ")}`);

const fake = new FakeAniList("POINT_10_DECIMAL", "tester").seed(PERSONA).seedActivity(HISTORY);
fake.clock = () => NOW;
const http = serveFake(fake);
const client = new Client({ name: "probe", version: "0" });
await client.connect(
  new StdioClientTransport({ command: spec.command, args: spec.args, env: { ...process.env, ...spec.env(http.url) } as Record<string, string>, stderr: "inherit" }),
);
try {
  const { tools } = await client.listTools();
  console.log(`${tools.length} tools: ${tools.map((t) => t.name).join(", ")}`);
  if (args.call) {
    const result = (await client.callTool({ name: args.call, arguments: JSON.parse(args.args!) })) as { content: { text?: string }[]; isError?: boolean };
    console.log(`${result.isError ? "ERROR " : ""}${result.content.map((c) => c.text ?? "").join("\n")}`);
  }
  console.log(`\nAniList requests: ${fake.calls.length}; writes: ${fake.writes.length}`);
  if (fake.unmodeled.size) console.log(`Unmodeled: ${[...fake.unmodeled].join(", ")}`);
} finally {
  await client.close();
  http.stop();
}
