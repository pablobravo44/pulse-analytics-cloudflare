// The dashboard speaks English and Spanish: every t("…") / tn(n, "…", "…") string must have a Spanish entry.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ES } from "../../src/dashboard/src/lib/i18n/es.ts";

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    return statSync(p).isDirectory() ? files(p) : /\.tsx?$/.test(f) ? [p] : [];
  });
}

const LIT = String.raw`"((?:[^"\\]|\\.)*)"`;
const T_CALL = new RegExp(String.raw`\bt\(\s*` + LIT, "g");
const TN_CALL = new RegExp(String.raw`\btn\([^,]+,\s*` + LIT + String.raw`\s*,\s*` + LIT, "g");
const unquote = (s: string) => JSON.parse(`"${s}"`) as string;

/** String literals passed to t() and tn() (double-quoted; template literals are not allowed as keys). */
function keys(src: string): string[] {
  const out: string[] = [];
  for (const m of src.matchAll(T_CALL)) out.push(unquote(m[1]!));
  for (const m of src.matchAll(TN_CALL)) out.push(unquote(m[1]!), unquote(m[2]!));
  return out;
}

describe("dashboard translations", () => {
  const all = files("src/dashboard/src")
    .filter((f) => !f.split(/[\\/]/).join("/").endsWith("lib/i18n.ts"))
    .flatMap((f) => keys(readFileSync(f, "utf8")).map((k) => ({ f, k })));

  it("every interface string has a Spanish entry", () => {
    const missing = all.filter(({ k }) => !(k in ES)).map(({ f, k }) => `${f}: ${k}`);
    expect(missing).toEqual([]);
  });

  it("placeholders survive translation", () => {
    const ph = (s: string) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();
    for (const [en, es] of Object.entries(ES)) expect(ph(es), en).toEqual(ph(en));
  });
});
