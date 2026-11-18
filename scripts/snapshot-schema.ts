#!/usr/bin/env bun
/**
 * Saves AniList's GraphQL schema (by introspection, no token needed) to
 * test/fixtures/anilist.graphql. The fake AniList runs every query against it, so a query
 * AniList would reject fails in the tests too.
 *
 *   bun run snapshot:schema
 */
import { buildClientSchema, getIntrospectionQuery, printSchema } from "graphql";
import { ANILIST_ENDPOINT } from "../src/anilist";

const res = await fetch(ANILIST_ENDPOINT, {
  method: "POST",
  headers: { "Content-Type": "application/json", Accept: "application/json" },
  body: JSON.stringify({ query: getIntrospectionQuery({ descriptions: false }) }),
});
const body = (await res.json()) as { data?: any; errors?: { message: string }[] };
if (!body.data) throw new Error(body.errors?.map((e) => e.message).join("; ") ?? `HTTP ${res.status}`);
const out = new URL("../test/fixtures/anilist.graphql", import.meta.url);
await Bun.write(out, `# AniList's GraphQL schema, saved by scripts/snapshot-schema.ts on ${new Date().toISOString().slice(0, 10)}.\n\n${printSchema(buildClientSchema(body.data))}\n`);
console.error(`Wrote ${out.pathname}`);
