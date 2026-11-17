#!/usr/bin/env bun
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { AniListClient } from "./anilist";
import { createServer } from "./server";

const token = process.env.ANILIST_TOKEN?.trim();
if (!token) {
  console.error(
    "ANILIST_TOKEN is not set. See the README for how to get a personal access token from AniList.",
  );
  process.exit(1);
}

const server = createServer(new AniListClient(token));
await server.connect(new StdioServerTransport());
