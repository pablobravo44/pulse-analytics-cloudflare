// Reorder a D1 SQL export (ops-backups/<db>/<stamp>.sql.gz) so `wrangler d1 execute --file` can import it:
// CREATE TABLEs first, parent rows before child rows. Same function the monthly restore drill uses.
//   node --experimental-strip-types scripts/restore-order.ts backup.sql.gz restore.sql
import { readFileSync, writeFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { countInserts, restoreOrder } from "../src/worker/ops/sqlexport.ts";

const [input, output] = process.argv.slice(2);
if (!input || !output) {
  console.error("usage: node --experimental-strip-types scripts/restore-order.ts <backup.sql[.gz]> <out.sql>");
  process.exit(1);
}
const raw = readFileSync(input);
const sql = (input.endsWith(".gz") ? gunzipSync(raw) : raw).toString("utf8");
writeFileSync(output, restoreOrder(sql));
const counts = countInserts(sql);
console.log(`${output}: ${Object.keys(counts).length} tables, ${Object.values(counts).reduce((a, b) => a + b, 0)} rows`);
for (const [t, n] of Object.entries(counts)) console.log(`  ${t}: ${n}`);
