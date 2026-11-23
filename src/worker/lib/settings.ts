// Admin-editable instance settings (table `settings`). Every field has a default, so nothing needs setting up.
import { z } from "zod";

export const opsSettingsSchema = z.object({
  /** D1 databases exported weekly to the ops-backups bucket (names as in the Cloudflare account). */
  backup_databases: z.array(z.string().min(1).max(64)).max(20),
  /**
   * Databases restored into the scratch database by the monthly drill. `pulse` is not in the default: the drill
   * holds a decompressed export in memory several times over, and Pulse's own database (17.5 MB, growing about
   * 6 MB a week in October 2026) would reach the Worker's 128 MB memory limit. Its weekly SQL and NDJSON backups
   * are still checked for age every day.
   */
  drill_databases: z.array(z.string().min(1).max(64)).max(10),
  /** Email a warning when any D1 database reaches this size. */
  d1_warn_gb: z.number().min(0.1).max(10),
  /**
   * Email only for errors: new JavaScript errors and Pulse's own failed or stale backups. Traffic, event and no-data
   * alerts, status checks and the size/ingest warnings still show in Pulse and reach the other channels, but send no
   * email. Scheduled reports are opt-in and keep their own schedule (Settings → Reports).
   */
  email_only_errors: z.boolean(),
});
export type OpsSettings = z.infer<typeof opsSettingsSchema>;

export const DEFAULT_OPS: OpsSettings = {
  // A new install backs up its own database (named "pulse" in wrangler.jsonc); others are added in Settings → Backups.
  backup_databases: ["pulse"],
  drill_databases: [],
  d1_warn_gb: 6,
  email_only_errors: true,
};

export async function getSetting<T>(db: D1Database, key: string, fallback: T): Promise<T> {
  const row = await db.prepare("SELECT value_json FROM settings WHERE key = ?").bind(key).first<{ value_json: string }>();
  if (!row) return fallback;
  try {
    return { ...fallback, ...(JSON.parse(row.value_json) as T) };
  } catch {
    return fallback;
  }
}

export async function putSetting(db: D1Database, key: string, value: unknown, actor: string): Promise<void> {
  await db
    .prepare(
      "INSERT INTO settings (key, value_json, updated_at, updated_by) VALUES (?, ?, ?, ?) ON CONFLICT (key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at, updated_by = excluded.updated_by",
    )
    .bind(key, JSON.stringify(value), Date.now(), actor)
    .run();
}

export async function getOpsSettings(db: D1Database): Promise<OpsSettings> {
  // Old rows may still hold a `digest` key (now in the reports table, migration 0005); drop it.
  const { digest: _moved, ...s } = await getSetting<OpsSettings & { digest?: unknown }>(db, "ops", DEFAULT_OPS);
  return s;
}
