import crypto from "node:crypto";
import { nanoid } from "nanoid";
import { z } from "zod";
import { config } from "./config.js";
import { audit, db, nowIso } from "./db.js";

export const ROLES = ["admin", "operator", "viewer"] as const;
export type Role = (typeof ROLES)[number];

export type UserRow = {
  id: string;
  username: string;
  display_name: string;
  email: string | null;
  role: Role;
  password_hash: string;
  active: number;
  created_at: string;
  updated_at: string;
  last_login_at: string | null;
};

export const CreateUserSchema = z.object({
  username: z
    .string()
    .min(3)
    .max(64)
    .regex(/^[a-zA-Z0-9._-]+$/, "Username may contain letters, numbers, . _ -"),
  displayName: z.string().min(1).max(120),
  email: z.string().email().optional().nullable(),
  role: z.enum(ROLES),
  password: z.string().min(8).max(128),
  active: z.boolean().default(true),
});

export const UpdateUserSchema = z.object({
  displayName: z.string().min(1).max(120).optional(),
  email: z.string().email().nullable().optional(),
  role: z.enum(ROLES).optional(),
  password: z.string().min(8).max(128).optional(),
  active: z.boolean().optional(),
});

export const ProfileUpdateSchema = z.object({
  displayName: z.string().min(1).max(120).optional(),
  email: z.string().email().nullable().optional(),
  currentPassword: z.string().optional(),
  newPassword: z.string().min(8).max(128).optional(),
});

export function hashPassword(password: string): string {
  const salt = crypto.randomBytes(16).toString("hex");
  const hash = crypto.scryptSync(password, salt, 64).toString("hex");
  return `${salt}:${hash}`;
}

export function verifyPassword(password: string, stored: string): boolean {
  const [salt, hash] = stored.split(":");
  if (!salt || !hash) return false;
  const next = crypto.scryptSync(password, salt, 64);
  const prev = Buffer.from(hash, "hex");
  if (prev.length !== next.length) return false;
  return crypto.timingSafeEqual(prev, next);
}

export function ensureUsersSchema(): void {
  db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  username TEXT NOT NULL UNIQUE,
  display_name TEXT NOT NULL,
  email TEXT,
  role TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  last_login_at TEXT
);

CREATE TABLE IF NOT EXISTS system_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  level TEXT NOT NULL,
  source TEXT NOT NULL,
  message TEXT NOT NULL,
  detail TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS alerts (
  id TEXT PRIMARY KEY,
  severity TEXT NOT NULL,
  title TEXT NOT NULL,
  message TEXT NOT NULL,
  acknowledged INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  acknowledged_at TEXT,
  acknowledged_by TEXT
);

CREATE TABLE IF NOT EXISTS metric_samples (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts TEXT NOT NULL,
  cpu_pct REAL NOT NULL,
  mem_used_mb REAL NOT NULL,
  mem_rss_mb REAL NOT NULL,
  active_jobs INTEGER NOT NULL,
  cameras_enabled INTEGER NOT NULL,
  bytes_out_rate REAL NOT NULL,
  compression_pct REAL NOT NULL,
  disk_recordings_mb REAL NOT NULL
);
`);
}

export function ensureAdminUser(): void {
  const count = db.prepare(`SELECT COUNT(*) AS c FROM users`).get() as { c: number };
  if (count.c > 0) return;
  const id = nanoid(12);
  const ts = nowIso();
  db.prepare(
    `INSERT INTO users (id, username, display_name, email, role, password_hash, active, created_at, updated_at)
     VALUES (?, ?, ?, NULL, 'admin', ?, 1, ?, ?)`
  ).run(id, config.adminUser, "Administrator", hashPassword(config.adminPassword), ts, ts);
}

export function getUserByUsername(username: string): UserRow | undefined {
  return db.prepare(`SELECT * FROM users WHERE username = ?`).get(username) as UserRow | undefined;
}

export function getUserById(id: string): UserRow | undefined {
  return db.prepare(`SELECT * FROM users WHERE id = ?`).get(id) as UserRow | undefined;
}

export function listUsers(): UserRow[] {
  return db.prepare(`SELECT * FROM users ORDER BY username`).all() as UserRow[];
}

export function toPublicUser(u: UserRow) {
  return {
    id: u.id,
    username: u.username,
    displayName: u.display_name,
    email: u.email,
    role: u.role,
    active: Boolean(u.active),
    createdAt: u.created_at,
    updatedAt: u.updated_at,
    lastLoginAt: u.last_login_at,
  };
}

export function authenticateUser(
  username: string,
  password: string
): UserRow | null {
  const user = getUserByUsername(username);
  if (!user || !user.active) return null;
  if (!verifyPassword(password, user.password_hash)) return null;
  db.prepare(`UPDATE users SET last_login_at = ? WHERE id = ?`).run(nowIso(), user.id);
  return user;
}

export function createUser(
  input: z.infer<typeof CreateUserSchema>,
  actor: string
): UserRow {
  if (getUserByUsername(input.username)) {
    throw new Error("Username already exists");
  }
  const id = nanoid(12);
  const ts = nowIso();
  db.prepare(
    `INSERT INTO users (id, username, display_name, email, role, password_hash, active, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    id,
    input.username,
    input.displayName,
    input.email ?? null,
    input.role,
    hashPassword(input.password),
    input.active ? 1 : 0,
    ts,
    ts
  );
  audit(actor, "user.create", { id, username: input.username, role: input.role });
  return getUserById(id)!;
}

export function updateUser(
  id: string,
  input: z.infer<typeof UpdateUserSchema>,
  actor: string
): UserRow {
  const existing = getUserById(id);
  if (!existing) throw new Error("User not found");

  if (input.role && existing.role === "admin" && input.role !== "admin") {
    const admins = db
      .prepare(`SELECT COUNT(*) AS c FROM users WHERE role = 'admin' AND active = 1 AND id != ?`)
      .get(id) as { c: number };
    if (admins.c === 0) throw new Error("Cannot demote the last active admin");
  }
  if (input.active === false && existing.role === "admin") {
    const admins = db
      .prepare(`SELECT COUNT(*) AS c FROM users WHERE role = 'admin' AND active = 1 AND id != ?`)
      .get(id) as { c: number };
    if (admins.c === 0) throw new Error("Cannot disable the last active admin");
  }

  const displayName = input.displayName ?? existing.display_name;
  const email = input.email !== undefined ? input.email : existing.email;
  const role = input.role ?? existing.role;
  const active = input.active !== undefined ? (input.active ? 1 : 0) : existing.active;
  const passwordHash = input.password
    ? hashPassword(input.password)
    : existing.password_hash;

  db.prepare(
    `UPDATE users SET display_name=?, email=?, role=?, password_hash=?, active=?, updated_at=? WHERE id=?`
  ).run(displayName, email, role, passwordHash, active, nowIso(), id);
  audit(actor, "user.update", { id });
  return getUserById(id)!;
}

export function deleteUser(id: string, actor: string): void {
  const existing = getUserById(id);
  if (!existing) throw new Error("User not found");
  if (existing.role === "admin") {
    const admins = db
      .prepare(`SELECT COUNT(*) AS c FROM users WHERE role = 'admin' AND active = 1 AND id != ?`)
      .get(id) as { c: number };
    if (admins.c === 0) throw new Error("Cannot delete the last active admin");
  }
  db.prepare(`DELETE FROM users WHERE id = ?`).run(id);
  audit(actor, "user.delete", { id, username: existing.username });
}

export function updateProfile(
  userId: string,
  input: z.infer<typeof ProfileUpdateSchema>
): UserRow {
  const existing = getUserById(userId);
  if (!existing) throw new Error("User not found");

  let passwordHash = existing.password_hash;
  if (input.newPassword) {
    if (!input.currentPassword || !verifyPassword(input.currentPassword, existing.password_hash)) {
      throw new Error("Current password is incorrect");
    }
    passwordHash = hashPassword(input.newPassword);
  }

  db.prepare(
    `UPDATE users SET display_name=?, email=?, password_hash=?, updated_at=? WHERE id=?`
  ).run(
    input.displayName ?? existing.display_name,
    input.email !== undefined ? input.email : existing.email,
    passwordHash,
    nowIso(),
    userId
  );
  audit(existing.username, "profile.update", {});
  return getUserById(userId)!;
}

/** Role hierarchy for permission checks */
const RANK: Record<Role, number> = { viewer: 1, operator: 2, admin: 3 };

export function roleAtLeast(role: Role, minimum: Role): boolean {
  return RANK[role] >= RANK[minimum];
}
