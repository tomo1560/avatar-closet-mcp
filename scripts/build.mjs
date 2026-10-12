import { build } from "esbuild";

// Bundled CommonJS dependencies call require() for Node built-ins, which ESM output lacks.
const requireShim = "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);";

await build({
  entryPoints: ["src/cli.ts"],
  outfile: "dist/cli.js",
  bundle: true,
  platform: "node",
  target: "node20",
  format: "esm",
  minify: true,
  external: ["playwright-core"],
  banner: { js: requireShim },
});
