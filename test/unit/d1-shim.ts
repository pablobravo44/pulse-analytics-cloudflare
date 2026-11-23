// Minimal D1Database shim over node:sqlite for unit tests (workerd doesn't run on every machine).
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

type Val = string | number | null | bigint | Uint8Array;

function norm(v: unknown): Val {
  if (v === undefined || v === null) return null;
  if (typeof v === "boolean") return v ? 1 : 0;
  if (typeof v === "number" || typeof v === "string" || typeof v === "bigint" || v instanceof Uint8Array) return v;
  return String(v);
}

export const D1_MAX_PARAMS = 100;
export const D1_MAX_COMPOUND = 5;

/** The most terms in any one compound SELECT of `sql` (UNION/INTERSECT/EXCEPT at the same nesting level). */
export function maxCompoundTerms(sql: string): number {
  const counts = [0];
  let max = 0;
  for (let i = 0; i < sql.length; i++) {
    const c = sql[i]!;
    if (c === "'" || c === '"') {
      const q = c;
      for (i++; i < sql.length && !(sql[i] === q && sql[i + 1] !== q); i++) if (sql[i] === q) i++;
    } else if (c === "(") counts.push(0);
    else if (c === ")") counts.pop();
    else if (/[a-z]/i.test(c) && !/[a-z0-9_]/i.test(sql[i - 1] ?? " ")) {
      const w = /^[a-z_][a-z0-9_]*/i.exec(sql.slice(i))![0];
      if (/^(union|intersect|except)$/i.test(w)) {
        const d = counts.length - 1;
        counts[d] = counts[d]! + 1;
        max = Math.max(max, counts[d]! + 1);
      }
      i += w.length - 1;
    }
  }
  return max;
}

class Stmt {
  private db: DatabaseSync;
  private sql: string;
  private params: Val[];
  constructor(db: DatabaseSync, sql: string, params: Val[] = []) {
    this.db = db;
    this.sql = sql;
    this.params = params;
  }
  bind(...p: unknown[]) {
    // D1 accepts at most 100 bound parameters per statement (node:sqlite takes 32k): fail like D1 does.
    if (p.length > D1_MAX_PARAMS) throw new Error(`D1_ERROR: too many SQL variables (${p.length} > ${D1_MAX_PARAMS}): SQLITE_ERROR`);
    return new Stmt(this.db, this.sql, p.map(norm));
  }
  private exec() {
    // D1 allows at most 5 terms per compound SELECT (SQLite's default is 500): fail like D1 does.
    if (maxCompoundTerms(this.sql) > D1_MAX_COMPOUND) throw new Error("D1_ERROR: too many terms in compound SELECT: SQLITE_ERROR");
    const s = this.db.prepare(this.sql);
    return s;
  }
  async first<T>(col?: string): Promise<T | null> {
    const r = this.exec().get(...this.params) as Record<string, unknown> | undefined;
    if (!r) return null;
    return (col ? r[col] : { ...r }) as T;
  }
  async all<T>() {
    const results = (this.exec().all(...this.params) as Record<string, unknown>[]).map((r) => ({ ...r })) as T[];
    return { results, success: true, meta: {} };
  }
  async run() {
    const r = this.exec().run(...this.params);
    return { success: true, meta: { changes: Number(r.changes), last_row_id: Number(r.lastInsertRowid) }, results: [] };
  }
  async raw<T>() {
    return (this.exec().all(...this.params) as Record<string, unknown>[]).map((r) => Object.values(r)) as T[];
  }
  runSync() {
    const isRead = /^\s*(SELECT|WITH)/i.test(this.sql);
    if (isRead) return { results: (this.exec().all(...this.params) as object[]).map((r) => ({ ...r })), success: true, meta: {} };
    const r = this.exec().run(...this.params);
    return { results: [], success: true, meta: { changes: Number(r.changes) } };
  }
}

/** In-memory by default; pass a file path for a persistent database (the local dev server). */
export function createD1(path = ":memory:"): D1Database & { sqlite: DatabaseSync } {
  const db = new DatabaseSync(path);
  const api = {
    sqlite: db,
    prepare: (sql: string) => new Stmt(db, sql),
    async batch(stmts: Stmt[]) {
      db.exec("BEGIN");
      try {
        const out = stmts.map((s) => s.runSync());
        db.exec("COMMIT");
        return out;
      } catch (e) {
        db.exec("ROLLBACK");
        throw e;
      }
    },
    async exec(sql: string) {
      db.exec(sql);
      return { count: 1, duration: 0 };
    },
    withSession() {
      return api;
    },
    dump() {
      throw new Error("not implemented");
    },
  };
  return api as unknown as D1Database & { sqlite: DatabaseSync };
}

/** Apply every migration (or, with `track`, only the ones not applied yet, recorded in d1_migrations like wrangler does). */
export function migrate(db: D1Database & { sqlite: DatabaseSync }, track = false): string[] {
  const dir = join(import.meta.dirname, "../../migrations");
  if (track) db.sqlite.exec("CREATE TABLE IF NOT EXISTS d1_migrations (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT UNIQUE, applied_at TEXT DEFAULT CURRENT_TIMESTAMP)");
  const done = track ? new Set((db.sqlite.prepare("SELECT name FROM d1_migrations").all() as { name: string }[]).map((r) => r.name)) : new Set<string>();
  const applied: string[] = [];
  for (const f of readdirSync(dir).filter((f) => f.endsWith(".sql")).sort()) {
    if (done.has(f)) continue;
    db.sqlite.exec(readFileSync(join(dir, f), "utf8"));
    if (track) db.sqlite.prepare("INSERT INTO d1_migrations (name) VALUES (?)").run(f);
    applied.push(f);
  }
  return applied;
}
