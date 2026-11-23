// Restore drill, second check after row counts: the first rows of every table, as written in the SQL export,
// must come back from the restored database with the same values. Both sides are normalized (numbers as
// numbers, blobs as hex, NULL as null) and hashed per table.

export type SqlValue = string | number | null;

const SAMPLE = 20;

/**
 * Parse the value tuple of one export statement, `INSERT INTO "t" VALUES(1,'it''s',NULL,X'00ff',2.5);`.
 * Returns null for anything that isn't plain literals (function calls such as replace(...), unistr(...)), so the
 * caller can skip the table rather than report a false mismatch.
 */
export function parseValues(stmt: string): SqlValue[] | null {
  const open = stmt.indexOf("VALUES(");
  if (open < 0) return null;
  const out: SqlValue[] = [];
  let i = open + 7;
  const s = stmt;
  for (;;) {
    while (s[i] === " ") i++;
    const c = s[i];
    if (c === "'") {
      let v = "";
      i++;
      for (;;) {
        const k = s.indexOf("'", i);
        if (k < 0) return null;
        v += s.slice(i, k);
        if (s[k + 1] === "'") {
          v += "'";
          i = k + 2;
        } else {
          i = k + 1;
          break;
        }
      }
      out.push(v);
    } else if ((c === "X" || c === "x") && s[i + 1] === "'") {
      const k = s.indexOf("'", i + 2);
      if (k < 0) return null;
      out.push(`x:${s.slice(i + 2, k).toLowerCase()}`);
      i = k + 1;
    } else if (s.startsWith("NULL", i)) {
      out.push(null);
      i += 4;
    } else {
      const m = /^[-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?/.exec(s.slice(i, i + 64));
      if (!m) return null;
      out.push(Number(m[0]));
      i += m[0].length;
    }
    while (s[i] === " ") i++;
    if (s[i] === ",") {
      i++;
      continue;
    }
    if (s[i] === ")") return out;
    return null;
  }
}

/** The first `n` rows of each table in an export, parsed. Tables with a row the parser can't read map to null. */
export function sampleExport(sql: string, n = SAMPLE): Record<string, SqlValue[][] | null> {
  const out: Record<string, SqlValue[][] | null> = {};
  const re = /^INSERT INTO "?([^"\s(]+)"?\s/gm;
  for (let m = re.exec(sql); m; m = re.exec(sql)) {
    const t = m[1]!;
    const rows = out[t];
    if (rows === null || (rows && rows.length >= n)) continue;
    // A statement ends at ");" followed by a newline (strings may hold newlines and ");").
    let end = sql.indexOf(");\n", m.index);
    while (end >= 0) {
      const v = parseValues(sql.slice(m.index, end + 2));
      if (v) {
        (out[t] ??= []).push(v);
        break;
      }
      end = sql.indexOf(");\n", end + 3);
      if (end < 0 || end - m.index > 1_000_000) {
        out[t] = null;
        break;
      }
    }
    if (end < 0) out[t] = null;
  }
  return out;
}

/** A value from the D1 REST API in the export's normal form. */
export function normalizeApiValue(v: unknown): SqlValue {
  if (v === null || v === undefined) return null;
  if (typeof v === "number" || typeof v === "string") return v;
  if (typeof v === "boolean") return v ? 1 : 0;
  // Blobs: an array of bytes, a typed array, or (a typed array that went through JSON) {"0": 1, "1": 2, …}.
  const hex = (bytes: ArrayLike<unknown>) => `x:${Array.from(bytes, (b) => Number(b).toString(16).padStart(2, "0")).join("")}`;
  if (Array.isArray(v)) return hex(v);
  if (ArrayBuffer.isView(v)) return hex(new Uint8Array(v.buffer, v.byteOffset, v.byteLength));
  if (typeof v === "object") {
    const o = v as Record<string, unknown>;
    const keys = Object.keys(o);
    if (keys.every((k, i) => k === String(i))) return hex(keys.map((k) => o[k]));
  }
  return String(v);
}

export async function rowsChecksum(rows: SqlValue[][]): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify(rows)));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
