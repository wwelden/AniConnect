#!/usr/bin/env bun
/**
 * The real AniConnect MCP server, wired to the fake AniList instead of the network.
 * The eval runner starts one per case; list state lives in the JSON file named by
 * EVAL_STATE so the runner can inspect it afterwards.
 */
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { AniListClient } from "../src/anilist";
import { createServer } from "../src/server";
import { FakeAniList } from "../test/support/fake-anilist";

const statePath = process.env.EVAL_STATE;
if (!statePath) {
  console.error("EVAL_STATE must point at a state file written by evals/run.ts");
  process.exit(1);
}

const state = await Bun.file(statePath).json();
const fake = new FakeAniList(state.scoreFormat, state.viewerName);
fake.importState(state);

const fetchAndPersist = async (url: string, init: RequestInit) => {
  const res = await fake.fetch(url, init);
  if (/^\s*mutation/.test(JSON.parse(init.body as string).query)) {
    await Bun.write(statePath, JSON.stringify({ ...state, ...fake.exportState() }, null, 1));
  }
  return res;
};

const server = createServer(new AniListClient("eval", fetchAndPersist));
await server.connect(new StdioServerTransport());
