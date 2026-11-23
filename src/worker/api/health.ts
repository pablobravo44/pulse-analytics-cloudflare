import type { Env } from "../env.ts";
import { utcDay } from "../lib/time.ts";

export const VERSION = "0.1.0";

async function meta(db: D1Database, key: string): Promise<string | null> {
  const r = await db.prepare("SELECT value FROM kv_meta WHERE key = ?").bind(key).first<{ value: string }>();
  return r?.value ?? null;
}

export async function health(env: Env) {
  const now = Date.now();
  const [last, stats, size, backup, dlq] = await Promise.all([
    env.DB.prepare("SELECT site_id, MAX(ts) AS last FROM events WHERE source = 'pulse' AND ts > ? GROUP BY site_id").bind(now - 30 * 86_400_000).all<{ site_id: string; last: number }>(),
    env.DB.prepare("SELECT * FROM ingest_stats WHERE day = ?").bind(utcDay(now)).all(),
    env.DB.prepare("SELECT 1").run().then((r) => (r.meta as { size_after?: number }).size_after ?? null).catch(() => null),
    meta(env.DB, "last_backup"),
    meta(env.DB, "dlq_depth"),
  ]);
  const lastBackup = backup ? (JSON.parse(backup) as { at: number; ok: boolean; key: string }) : null;
  const backupFresh = !!lastBackup && lastBackup.ok && now - lastBackup.at < 8 * 86_400_000;
  const lastPerSite = Object.fromEntries(last.results.map((r) => [r.site_id, new Date(r.last).toISOString()]));
  const newest = Math.max(0, ...last.results.map((r) => r.last));
  return {
    ok: backupFresh || !lastBackup,
    version: VERSION,
    environment: env.ENVIRONMENT,
    generated_at: new Date(now).toISOString(),
    ingest: {
      last_event_per_site: lastPerSite,
      seconds_since_last_event: newest ? Math.round((now - newest) / 1000) : null,
      today: stats.results,
    },
    queue: { dlq_depth: dlq ? Number(dlq) : null },
    d1: { size_mb: size ? Math.round((size / 1048576) * 10) / 10 : null },
    backups: { last: lastBackup ? { at: new Date(lastBackup.at).toISOString(), ok: lastBackup.ok, key: lastBackup.key } : null, fresh: backupFresh },
  };
}
