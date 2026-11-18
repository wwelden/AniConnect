#!/usr/bin/env bun
/**
 * The real AniConnect MCP server, sending its AniList requests to the fake AniList that
 * the eval runner serves at ANILIST_URL.
 */
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { AniListClient } from "../src/anilist";
import { createServer } from "../src/server";
import { NOW } from "./clock";

const url = process.env.ANILIST_URL;
if (!url) {
  console.error("ANILIST_URL must point at the fake AniList served by evals/run.ts");
  process.exit(1);
}

const server = createServer(new AniListClient("eval", (_endpoint, init) => fetch(url, init)), { now: () => NOW });
await server.connect(new StdioServerTransport());
