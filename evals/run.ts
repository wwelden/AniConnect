#!/usr/bin/env bun
/**
 * Runs the end-to-end evals: each case's request goes to a real model through the
 * `claude` CLI, with only the AniConnect MCP server attached (backed by the fake
 * AniList), and is graded on the list it leaves behind.
 *
 *   bun evals/run.ts                      # all cases, CLI's default model
 *   bun evals/run.ts --model sonnet       # pick a model
 *   bun evals/run.ts --filter progress    # only cases whose id contains "progress"
 *   bun evals/run.ts --concurrency 2 --budget 0.5
 *
 * Each case is a separate model run and uses your Claude usage (or API credits when
 * ANTHROPIC_API_KEY is set, in which case runs also use --bare for full isolation).
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { PERSONA } from "../test/fixtures/persona";
import { FakeAniList } from "../test/support/fake-anilist";
import { CASES, type EvalCase } from "./cases";
import { diff, gradeCase } from "./grade";

const { values: args } = parseArgs({
  options: {
    model: { type: "string" },
    filter: { type: "string" },
    concurrency: { type: "string", default: "4" },
    budget: { type: "string", default: "1" },
    "keep-temp": { type: "boolean", default: false },
  },
});

const SYSTEM_PROMPT =
  "You are a helpful assistant. The user keeps track of the anime they watch on AniList, and you can manage their list with the tools provided. Today is 2026-11-17 and the user is in the UTC time zone.";

const SERVER = join(import.meta.dir, "fake-server.ts");

interface RunResult {
  id: string;
  passed: boolean;
  detail: string;
  toolCalls: string[];
  costUsd: number;
  durationMs: number;
  reply: string;
  model: string;
  /** Tool calls with their inputs and results, for diagnosing failures. */
  transcript: { tool: string; input: unknown; result?: string; isError?: boolean }[];
}

function seedState() {
  const fake = new FakeAniList("POINT_10_DECIMAL", "tester").seed(PERSONA);
  return { scoreFormat: fake.scoreFormat, viewerName: fake.viewerName, ...fake.exportState() };
}

async function runCase(c: EvalCase): Promise<RunResult> {
  const dir = await mkdtemp(join(tmpdir(), "aniconnect-eval-"));
  try {
    const statePath = join(dir, "state.json");
    const initial = seedState();
    await Bun.write(statePath, JSON.stringify(initial));
    const mcpPath = join(dir, "mcp.json");
    await Bun.write(
      mcpPath,
      JSON.stringify({
        mcpServers: { aniconnect: { command: "bun", args: [SERVER], env: { EVAL_STATE: statePath } } },
      }),
    );

    const cmd = [
      "claude", "-p", c.prompt,
      "--output-format", "stream-json", "--verbose",
      "--mcp-config", mcpPath, "--strict-mcp-config",
      "--tools", "",
      "--allowedTools", "mcp__aniconnect",
      "--system-prompt", SYSTEM_PROMPT,
      "--setting-sources", "",
      "--disable-slash-commands",
      "--no-session-persistence",
      "--max-budget-usd", args.budget!,
      ...(process.env.ANTHROPIC_API_KEY ? ["--bare"] : []),
      ...(args.model ? ["--model", args.model] : []),
    ];
    const started = Date.now();
    const proc = Bun.spawn(cmd, { cwd: dir, stdout: "pipe", stderr: "pipe" });
    const [out, err] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
    await proc.exited;

    const toolCalls: string[] = [];
    const transcript: RunResult["transcript"] = [];
    const byId = new Map<string, RunResult["transcript"][number]>();
    let reply = "";
    let costUsd = 0;
    let model = "";
    for (const line of out.split("\n")) {
      if (!line.trim()) continue;
      let event: any;
      try {
        event = JSON.parse(line);
      } catch {
        continue;
      }
      if (event.type === "system" && event.subtype === "init") {
        model = event.model ?? "";
      } else if (event.type === "assistant") {
        for (const block of event.message?.content ?? []) {
          if (block.type !== "tool_use") continue;
          const tool = block.name.replace(/^mcp__aniconnect__/, "");
          toolCalls.push(tool);
          const step = { tool, input: block.input };
          transcript.push(step);
          byId.set(block.id, step);
        }
      } else if (event.type === "user") {
        for (const block of event.message?.content ?? []) {
          const step = block.type === "tool_result" ? byId.get(block.tool_use_id) : undefined;
          if (!step) continue;
          const content = block.content;
          step.result = typeof content === "string" ? content : (content ?? []).map((c: any) => c.text ?? "").join("\n");
          step.isError = Boolean(block.is_error);
        }
      } else if (event.type === "result") {
        reply = event.result ?? "";
        costUsd = event.total_cost_usd ?? 0;
      }
    }
    const base = { id: c.id, toolCalls, costUsd, durationMs: Date.now() - started, reply, model, transcript };
    if (proc.exitCode !== 0) {
      return { ...base, passed: false, detail: `claude exited ${proc.exitCode}: ${err.trim().slice(0, 300)}` };
    }

    const final = await Bun.file(statePath).json();
    const problem = gradeCase(c, diff(initial.entries, final.entries), reply, toolCalls);
    return { ...base, passed: problem === null, detail: problem ?? "" };
  } finally {
    if (!args["keep-temp"]) await rm(dir, { recursive: true, force: true });
  }
}

async function main() {
  const cases = CASES.filter((c) => !args.filter || c.id.includes(args.filter));
  if (cases.length === 0) {
    console.error(`No cases match "${args.filter}".`);
    process.exit(1);
  }
  const concurrency = Math.max(1, Number(args.concurrency));
  console.error(`Running ${cases.length} cases, ${concurrency} at a time${args.model ? ` on ${args.model}` : ""}...`);

  const results: RunResult[] = [];
  const queue = [...cases];
  await Promise.all(
    Array.from({ length: concurrency }, async () => {
      for (let c = queue.shift(); c; c = queue.shift()) {
        const r = await runCase(c);
        results.push(r);
        console.error(`${r.passed ? "PASS" : "FAIL"}  ${r.id}  [${r.toolCalls.join(", ")}]${r.detail ? `  ${r.detail}` : ""}`);
      }
    }),
  );

  results.sort((a, b) => cases.findIndex((c) => c.id === a.id) - cases.findIndex((c) => c.id === b.id));
  const passed = results.filter((r) => r.passed).length;
  const ideal = cases.filter((c) => c.idealCalls !== undefined);
  const efficient = ideal.filter((c) => {
    const r = results.find((x) => x.id === c.id)!;
    return r.passed && r.toolCalls.length <= c.idealCalls!;
  }).length;
  const cost = results.reduce((s, r) => s + r.costUsd, 0);
  const calls = results.reduce((s, r) => s + r.toolCalls.length, 0) / results.length;

  console.log(`\nPassed ${passed}/${results.length} (${Math.round((100 * passed) / results.length)}%)`);
  console.log(`In the ideal number of tool calls: ${efficient}/${ideal.length}`);
  console.log(`Average tool calls: ${calls.toFixed(2)}   Total cost: $${cost.toFixed(2)}`);
  for (const r of results.filter((x) => !x.passed)) {
    console.log(`\nFAIL ${r.id}: ${r.detail}\n  calls: ${r.toolCalls.join(", ") || "none"}\n  reply: ${r.reply.slice(0, 400).replace(/\n/g, " ")}`);
  }

  const outDir = join(import.meta.dir, "results");
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  await Bun.write(
    join(outDir, `${stamp}.json`),
    JSON.stringify({ model: results[0]?.model || args.model || "default", passed, total: results.length, efficient, results }, null, 2),
  );
  console.log(`\nSaved to evals/results/${stamp}.json`);
  process.exit(passed === results.length ? 0 : 1);
}

await main();
