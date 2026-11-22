/**
 * Builds dist/index.js, the stdio server that the npm package's `aniconnect`
 * bin runs under Node (`npx -y aniconnect`) or Bun (`bunx aniconnect`).
 *
 * Dependencies stay external: npm installs them from package.json. The target
 * is "bun" because "node" (Bun 1.3 and 1.4) emits parts of src/anilist.ts twice,
 * giving the server two rate limiters and two call deadlines; the "bun" output
 * uses no Bun APIs and runs under Node, which the package smoke test checks.
 * The bundler keeps src/index.ts's `#!/usr/bin/env bun` line (a `banner` would
 * go after it), so the first lines are swapped for a node shebang here.
 */
const result = await Bun.build({
  entrypoints: ["src/index.ts"],
  outdir: "dist",
  target: "bun",
  packages: "external",
});
if (!result.success) {
  for (const log of result.logs) console.error(log);
  process.exit(1);
}

const out = "dist/index.js";
const code = (await Bun.file(out).text()).replace(/^#!.*\n(\/\/ @bun.*\n)?/, "");
// A module emitted twice shows up as a class with a numeric twin (RateLimiter, RateLimiter2).
// Only classes: modules may share a variable name (`status`), which the bundler also numbers.
const names = new Set([...code.matchAll(/^class (\w+)/gm)].map((m) => m[1]!));
const twins = [...names].filter((name) => /\d$/.test(name) && names.has(name.replace(/\d+$/, "")));
if (twins.length) {
  console.error(`The bundle has a module twice (${twins.join(", ")}).`);
  process.exit(1);
}
await Bun.write(out, `#!/usr/bin/env node\n${code}`);
// stderr, so `npm pack --json` (which runs this as prepack) keeps clean JSON on stdout.
console.error(`Built ${out}`);
