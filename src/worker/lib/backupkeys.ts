// Backup object names. The backup buckets have retention locks (no overwrite, no delete for 30 days), so a
// writer never reuses a key: the first run of a UTC day writes `<date>`, a second one `<date>T<HHMM>`, then
// `<date>T<HHMMSS>`. Readers accept every shape (and the plain `<date>` keys written before this change).

/** Stamps to try for a run at `now`, in order. */
export function backupStamps(now: number): string[] {
  const iso = new Date(now).toISOString(); // 2026-10-18T04:00:12.345Z
  const day = iso.slice(0, 10);
  return [day, `${day}T${iso.slice(11, 13)}${iso.slice(14, 16)}`, `${day}T${iso.slice(11, 13)}${iso.slice(14, 16)}${iso.slice(17, 19)}`];
}

/** The first stamp whose key doesn't exist yet. Throws when all of them do (several runs in the same second). */
export async function freeBackupStamp(now: number, exists: (stamp: string) => Promise<boolean>): Promise<string> {
  for (const stamp of backupStamps(now)) if (!(await exists(stamp))) return stamp;
  throw new Error("a backup with this timestamp already exists");
}

const STAMP = /^(\d{4}-\d{2}-\d{2})(?:T(\d{2})(\d{2})(\d{2})?)?/;

/** The time a stamp stands for ("2026-10-18" → that midnight UTC), or null when it isn't a stamp. */
export function stampTime(stamp: string): number | null {
  const m = STAMP.exec(stamp);
  if (!m) return null;
  const t = Date.parse(`${m[1]}T${m[2] ?? "00"}:${m[3] ?? "00"}:${m[4] ?? "00"}Z`);
  return Number.isFinite(t) ? t : null;
}

/**
 * Newest of a list of keys under `prefix` by their stamp. "2026-10-18" sorts before "2026-10-18T0412" in plain
 * string order, which is also time order, so this is a code-unit compare (never localeCompare).
 */
export function newestBackupKey<T extends { key: string }>(objects: T[], prefix: string): T | undefined {
  let best: T | undefined;
  for (const o of objects) {
    if (stampTime(o.key.slice(prefix.length)) === null) continue;
    if (!best || o.key > best.key) best = o;
  }
  return best;
}
