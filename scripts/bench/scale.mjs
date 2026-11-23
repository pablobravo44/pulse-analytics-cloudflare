// Multiplies demo-blog in a copy of the dev database by <factor> (unique ids per copy) for 10x benchmarks.
//   cp .data/dev.sqlite .data/x10.sqlite && node scripts/bench/scale.mjs .data/x10.sqlite 10
import { DatabaseSync } from "node:sqlite";
const [, , path, factor] = process.argv;
const db = new DatabaseSync(path);
const cols = (t) => db.prepare(`pragma table_info(${t})`).all().map((r) => r.name);
const ec = cols("events"), sc = cols("sessions");
const sub = (cs, map) => cs.map((c) => map[c] ?? c).join(",");
db.exec("BEGIN");
for (let k = 1; k < Number(factor); k++) {
  const sfx = `'#${k}'`;
  db.exec(`INSERT INTO events (${ec.join(",")}) SELECT ${sub(ec, { id: `id||${sfx}`, session_id: `session_id||${sfx}`, visitor_id: `visitor_id||${sfx}`, pageview_id: `pageview_id||${sfx}` })} FROM events WHERE instr(id,'#')=0 AND site_id='demo-blog'`);
  db.exec(`INSERT INTO sessions (${sc.join(",")}) SELECT ${sub(sc, { id: `id||${sfx}`, visitor_id: `visitor_id||${sfx}` })} FROM sessions WHERE instr(id,'#')=0 AND site_id='demo-blog'`);
}
db.exec("COMMIT");
db.exec("ANALYZE");
console.log(db.prepare("select count(*) n from events where site_id='demo-blog'").get(), db.prepare("select count(*) n from sessions where site_id='demo-blog'").get());
