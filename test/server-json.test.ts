/**
 * server.json describes AniConnect to the official MCP registry. It repeats facts from
 * package.json that must move together on every release.
 */
import { expect, test } from "bun:test";
import pkg from "../package.json" with { type: "json" };
import server from "../server.json" with { type: "json" };

test("server.json matches package.json", () => {
  expect(server.name).toBe(pkg.mcpName);
  expect(server.version).toBe(pkg.version);
  const npm = server.packages.find((p) => p.registryType === "npm");
  expect(npm?.identifier).toBe(pkg.name);
  expect(npm?.version).toBe(pkg.version);
  expect(npm?.environmentVariables.map((v) => v.name)).toEqual(["ANILIST_TOKEN"]);
  // The registry caps the description at 100 characters.
  expect(server.description.length).toBeLessThanOrEqual(100);
});

test("server.json's remote is the hosted server's MCP endpoint", () => {
  expect(server.remotes).toEqual([{ type: "streamable-http", url: expect.stringMatching(/^https:\/\/[^/]+\/mcp$/) }]);
});
