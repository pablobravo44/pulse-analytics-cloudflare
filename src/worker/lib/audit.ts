import { ulid } from "./ids.ts";

export function audit(db: D1Database, actor: string, action: string, target: string | null, meta?: unknown): Promise<unknown> {
  return db
    .prepare("INSERT INTO audit_log (id, ts, actor, action, target, meta_json) VALUES (?, ?, ?, ?, ?, ?)")
    .bind(ulid(), Date.now(), actor, action, target, meta === undefined ? null : JSON.stringify(meta))
    .run();
}
