// Pure helpers for D1 SQL exports (no Worker bindings), shared by the restore drill and scripts/restore-order.ts.

/**
 * Reorder a D1 export so it imports: every CREATE TABLE first, then the rows table by table with parents
 * before children (from each table's REFERENCES), then indexes and the rest. D1 writes tables in creation
 * order, so a table rebuilt later (e.g. one recreated by a migration) comes after rows that
 * reference it, and D1's import runs in batches, so a foreign key can't wait for a later batch either.
 * A real restore needs the same step.
 */
export function restoreOrder(sql: string): string {
  const pragma = sql.match(/^(?:PRAGMA[^\n]*\n)*/)![0];
  const lines = sql.slice(pragma.length).split(/(?<=\n)/);
  const statements: string[] = [];
  for (const line of lines) {
    if (statements.length && !/^(?:CREATE |INSERT INTO |PRAGMA |DELETE FROM |ALTER |DROP )/.test(line)) statements[statements.length - 1] += line;
    else statements.push(line);
  }
  const name = (s: string, re: RegExp) => s.match(re)?.[1]?.replace(/"/g, "");
  const tables: string[] = [];
  const parents = new Map<string, Set<string>>();
  const rows = new Map<string, string[]>();
  const rest: string[] = [];
  for (const s of statements) {
    const created = name(s, /^CREATE TABLE (?:IF NOT EXISTS )?("?[^"\s(]+"?)/);
    const inserted = name(s, /^INSERT INTO ("?[^"\s(]+"?)/);
    if (created) {
      tables.push(s);
      parents.set(created, new Set([...s.matchAll(/REFERENCES\s+"?([^"\s(]+)"?/gi)].map((m) => m[1]!).filter((p) => p !== created)));
    } else if (inserted) (rows.get(inserted) ?? rows.set(inserted, []).get(inserted)!).push(s);
    else rest.push(s);
  }
  const ordered: string[] = [];
  const seen = new Set<string>();
  const visit = (t: string, path: Set<string>) => {
    if (seen.has(t) || path.has(t)) return;
    path.add(t);
    for (const p of parents.get(t) ?? []) visit(p, path);
    seen.add(t);
    ordered.push(t);
  };
  for (const t of rows.keys()) visit(t, new Set());
  return pragma + tables.join("") + ordered.flatMap((t) => rows.get(t) ?? []).join("") + rest.join("");
}

/** Count INSERT statements per table in a D1 SQL export. */
export function countInserts(sql: string): Record<string, number> {
  const out: Record<string, number> = {};
  const re = /^INSERT INTO "?([^"\s(]+)"?\s/gm;
  for (let m = re.exec(sql); m; m = re.exec(sql)) out[m[1]!] = (out[m[1]!] ?? 0) + 1;
  return out;
}
