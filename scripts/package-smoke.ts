#!/usr/bin/env bun
/**
 * Checks the npm package the way a user gets it: packs the tarball (which builds
 * dist/index.js), installs it into an empty directory with install scripts off, and
 * starts the installed `aniconnect` bin through its own shebang, so the `node` on PATH
 * runs it, as `npx -y aniconnect` would. Over stdio it must:
 *   - report this package's name and version, and list the same tools as the source;
 *   - answer a tool call, with its AniList requests sent to the fake AniList;
 *   - exit 1, saying so, when ANILIST_TOKEN is not set.
 * It also lists the tools with the bin run by Bun, as `bunx aniconnect` would.
 *
 *   bun run smoke:package
 */
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { serveFake } from "../evals/fake-http";
import { personaFake } from "../evals/persona";
import pkg from "../package.json" with { type: "json" };
import { AniListClient } from "../src/anilist";
import { createServer } from "../src/server";

const root = join(import.meta.dir, "..");
const REDIRECT = join(root, "evals", "anilist-redirect.cjs");
const TOKEN = "smoke-test-token";

function check(ok: unknown, message: string): asserts ok {
  if (!ok) {
    console.error(`FAIL: ${message}`);
    process.exit(1);
  }
  console.log(`ok: ${message}`);
}

/** Tool names the source server lists, to compare the packed one against. */
async function sourceTools(): Promise<string[]> {
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await createServer(new AniListClient(TOKEN, async () => new Response("{}"))).connect(serverSide);
  const client = new Client({ name: "smoke", version: "0" });
  await client.connect(clientSide);
  const { tools } = await client.listTools();
  await client.close();
  return tools.map((t) => t.name).sort();
}

const work = mkdtempSync(join(tmpdir(), "aniconnect-pack-"));
try {
  // npm pack runs prepack, which builds dist/index.js.
  const packed = (JSON.parse(
    execFileSync("npm", ["pack", "--json", "--pack-destination", work], { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] }),
  ) as { filename: string; files: { path: string }[] }[])[0]!;
  const files = packed.files.map((f) => f.path).sort();
  check(
    JSON.stringify(files) === JSON.stringify(["LICENSE", "README.md", "dist/index.js", "package.json"]),
    `tarball holds only the bundle, README, LICENSE and package.json (${files.join(", ")})`,
  );

  const app = join(work, "app");
  mkdirSync(app);
  execFileSync("npm", ["init", "-y"], { cwd: app, stdio: "ignore" });
  execFileSync("npm", ["install", "--ignore-scripts", "--no-audit", "--no-fund", join(work, packed.filename)], {
    cwd: app,
    stdio: ["ignore", "inherit", "inherit"],
  });
  const bin = join(app, "node_modules", ".bin", "aniconnect");
  check(existsSync(bin), "npm install created node_modules/.bin/aniconnect");
  check(!existsSync(join(app, "node_modules", "aniconnect", "src")), "the installed package has no TypeScript source");

  const nodeVersion = execFileSync("node", ["--version"], { encoding: "utf8" }).trim();
  const expected = await sourceTools();
  const fake = personaFake();
  const http = serveFake(fake);
  try {
    // Started through its shebang, so `node` from PATH runs it.
    const client = new Client({ name: "smoke", version: "0" });
    await client.connect(
      new StdioClientTransport({
        command: bin,
        env: {
          ANILIST_TOKEN: TOKEN,
          FAKE_ANILIST_URL: http.url,
          NODE_OPTIONS: `--require ${JSON.stringify(REDIRECT)}`,
          PATH: process.env.PATH ?? "",
          HOME: process.env.HOME ?? work,
        },
        stderr: "inherit",
      }),
    );
    try {
      const info = client.getServerVersion();
      check(info?.name === "aniconnect" && info.version === pkg.version, `under Node ${nodeVersion}: serverInfo is aniconnect ${info?.version}`);
      const { tools } = await client.listTools();
      const names = tools.map((t) => t.name).sort();
      check(JSON.stringify(names) === JSON.stringify(expected), `under Node: tools/list has the source's ${expected.length} tools`);
      const result = (await client.callTool({ name: "search_my_list", arguments: { query: "frieren" } })) as {
        content: { text?: string }[];
        isError?: boolean;
      };
      const text = result.content.map((c) => c.text ?? "").join("\n");
      check(!result.isError && text.includes("Frieren") && fake.calls.length > 0, "under Node: search_my_list answers from the fake AniList");
    } finally {
      await client.close();
    }
  } finally {
    http.stop();
  }

  const noToken = spawnSync(bin, [], { env: { PATH: process.env.PATH ?? "" }, encoding: "utf8", timeout: 20_000 });
  check(noToken.status === 1 && noToken.stderr.includes("ANILIST_TOKEN is not set"), "without ANILIST_TOKEN the bin exits 1 and says why");

  // As `bunx aniconnect` runs it.
  const bunClient = new Client({ name: "smoke", version: "0" });
  await bunClient.connect(
    new StdioClientTransport({ command: process.execPath, args: [bin], env: { ANILIST_TOKEN: TOKEN, PATH: process.env.PATH ?? "" }, stderr: "inherit" }),
  );
  try {
    const { tools } = await bunClient.listTools();
    check(tools.length === expected.length, `under Bun ${Bun.version}: tools/list has ${tools.length} tools`);
  } finally {
    await bunClient.close();
  }
  console.log(`\nPackage smoke test passed (${readdirSync(work).find((f) => f.endsWith(".tgz"))}).`);
} finally {
  rmSync(work, { recursive: true, force: true });
}
