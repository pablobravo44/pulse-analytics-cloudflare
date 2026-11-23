// Fails when the tracker exceeds the gzip budget.
import { readFileSync } from "node:fs";
import { gzipSync } from "node:zlib";

const BUDGET = 2560;
const src = readFileSync("dist/public/p.js");
const gz = gzipSync(src, { level: 9 }).length;
console.log(`p.js: ${src.length} B raw, ${gz} B gzipped (budget ${BUDGET} B)`);
if (gz > BUDGET) {
  console.error("tracker over budget");
  process.exit(1);
}
