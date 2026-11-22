/**
 * Builds dist/index.js, the stdio server that the npm package's `aniconnect`
 * bin runs under Node (`npx -y aniconnect`) or Bun (`bunx aniconnect`).
 *
 * Dependencies stay external: npm installs them from package.json. The
 * bundler keeps src/index.ts's `#!/usr/bin/env bun` line, and a `banner` would
 * go after it, so the first line is swapped for a node shebang here.
 */
const result = await Bun.build({
  entrypoints: ["src/index.ts"],
  outdir: "dist",
  target: "node",
  packages: "external",
});
if (!result.success) {
  for (const log of result.logs) console.error(log);
  process.exit(1);
}

const out = "dist/index.js";
const code = (await Bun.file(out).text()).replace(/^#!.*\n(\/\/ @bun.*\n)?/, "");
await Bun.write(out, `#!/usr/bin/env node\n${code}`);
// stderr, so `npm pack --json` (which runs this as prepack) keeps clean JSON on stdout.
console.error(`Built ${out}`);
