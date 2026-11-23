// Bundles src/tracker/pulse.ts into dist/public/p.js (+ immutable p.v1.js).
import { build } from "esbuild";
import { copyFileSync, mkdirSync } from "node:fs";

mkdirSync("dist/public", { recursive: true });
await build({
  entryPoints: ["src/tracker/pulse.ts"],
  outfile: "dist/public/p.js",
  bundle: true,
  minify: true,
  format: "iife",
  target: ["es2019"],
  legalComments: "none",
});
copyFileSync("dist/public/p.js", "dist/public/p.v1.js");
console.log("tracker built: dist/public/p.js");
