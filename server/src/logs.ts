import { nanoid } from "nanoid";
import { db, nowIso } from "./db.js";

export type LogLevel = "debug" | "info" | "warn" | "error";

const memoryRing: {
  id: number;
  level: LogLevel;
  source: string;
  message: string;
  detail: string | null;
  created_at: string;
}[] = [];
let memId = 0;

export function systemLog(
  level: LogLevel,
  source: string,
  message: string,
  detail?: unknown
): void {
  const created_at = nowIso();
  const detailStr = detail != null ? JSON.stringify(detail) : null;
  memId += 1;
  const entry = {
    id: memId,
    level,
    source,
    message,
    detail: detailStr,
    created_at,
  };
  memoryRing.push(entry);
  if (memoryRing.length > 500) memoryRing.shift();

  try {
    db.prepare(
      `INSERT INTO system_logs (level, source, message, detail, created_at) VALUES (?, ?, ?, ?, ?)`
    ).run(level, source, message, detailStr, created_at);
    db.prepare(
      `DELETE FROM system_logs WHERE id NOT IN (SELECT id FROM system_logs ORDER BY id DESC LIMIT 2000)`
    ).run();
  } catch {
    /* ignore until schema ready */
  }
}

export function listSystemLogs(limit = 100, level?: string) {
  if (level) {
    return db
      .prepare(
        `SELECT * FROM system_logs WHERE level = ? ORDER BY id DESC LIMIT ?`
      )
      .all(level, limit);
  }
  return db.prepare(`SELECT * FROM system_logs ORDER BY id DESC LIMIT ?`).all(limit);
}

export function listAuditLogs(limit = 100, actor?: string) {
  if (actor) {
    return db
      .prepare(`SELECT * FROM audit_log WHERE actor = ? ORDER BY id DESC LIMIT ?`)
      .all(actor, limit);
  }
  return db.prepare(`SELECT * FROM audit_log ORDER BY id DESC LIMIT ?`).all(limit);
}

export function createAlert(
  severity: "info" | "warning" | "critical",
  title: string,
  message: string
): void {
  db.prepare(
    `INSERT INTO alerts (id, severity, title, message, acknowledged, created_at)
     VALUES (?, ?, ?, ?, 0, ?)`
  ).run(nanoid(12), severity, title, message, nowIso());
  systemLog(severity === "critical" ? "error" : severity === "warning" ? "warn" : "info", "alerts", title, {
    message,
  });
}

export function listAlerts(includeAcked = true) {
  if (includeAcked) {
    return db.prepare(`SELECT * FROM alerts ORDER BY created_at DESC LIMIT 100`).all();
  }
  return db
    .prepare(`SELECT * FROM alerts WHERE acknowledged = 0 ORDER BY created_at DESC LIMIT 100`)
    .all();
}

export function acknowledgeAlert(id: string, by: string): boolean {
  const r = db
    .prepare(
      `UPDATE alerts SET acknowledged = 1, acknowledged_at = ?, acknowledged_by = ? WHERE id = ? AND acknowledged = 0`
    )
    .run(nowIso(), by, id);
  return r.changes > 0;
}

export function getSettings(): Record<string, string> {
  const rows = db.prepare(`SELECT key, value FROM settings`).all() as {
    key: string;
    value: string;
  }[];
  const out: Record<string, string> = {};
  for (const r of rows) out[r.key] = r.value;
  return out;
}

export function setSetting(key: string, value: string): void {
  db.prepare(
    `INSERT INTO settings (key, value) VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`
  ).run(key, value);
}
