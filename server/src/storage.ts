import fs from "node:fs";
import path from "node:path";
import { nanoid } from "nanoid";
import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";
import SftpClient from "ssh2-sftp-client";
import { z } from "zod";
import { audit, db, nowIso } from "./db.js";
import { effectiveEntitlements, hasFeature } from "./license.js";
import { config } from "./config.js";

export const StorageInputSchema = z.object({
  name: z.string().min(1).max(120),
  type: z.enum(["local", "s3", "sftp"]),
  enabled: z.boolean().default(true),
  config: z.record(z.unknown()),
});

export type StorageTarget = {
  id: string;
  name: string;
  type: string;
  config_json: string;
  enabled: number;
  created_at: string;
};

function featureForType(type: string): string {
  if (type === "local") return "local-storage";
  if (type === "s3") return "s3";
  if (type === "sftp") return "sftp";
  return type;
}

export function listStorageTargets(): StorageTarget[] {
  return db.prepare(`SELECT * FROM storage_targets ORDER BY name`).all() as StorageTarget[];
}

export function getStorageTarget(id: string): StorageTarget | undefined {
  return db
    .prepare(`SELECT * FROM storage_targets WHERE id = ?`)
    .get(id) as StorageTarget | undefined;
}

export function countStorageTargets(): number {
  const row = db.prepare(`SELECT COUNT(*) AS c FROM storage_targets`).get() as { c: number };
  return row.c;
}

export function createStorageTarget(
  input: z.infer<typeof StorageInputSchema>,
  actor: string
): StorageTarget {
  const entitlements = effectiveEntitlements();
  if (countStorageTargets() >= entitlements.maxStorageTargets) {
    throw new Error(`License limit reached: max ${entitlements.maxStorageTargets} storage target(s).`);
  }
  if (!hasFeature(featureForType(input.type))) {
    throw new Error(`License does not include feature "${featureForType(input.type)}"`);
  }
  validateConfig(input.type, input.config);
  const id = nanoid(12);
  db.prepare(
    `INSERT INTO storage_targets (id, name, type, config_json, enabled, created_at) VALUES (?, ?, ?, ?, ?, ?)`
  ).run(id, input.name, input.type, JSON.stringify(input.config), input.enabled ? 1 : 0, nowIso());
  audit(actor, "storage.create", { id, type: input.type });
  return getStorageTarget(id)!;
}

export function deleteStorageTarget(id: string, actor: string): void {
  db.prepare(`DELETE FROM storage_targets WHERE id = ?`).run(id);
  audit(actor, "storage.delete", { id });
}

function validateConfig(type: string, cfg: Record<string, unknown>): void {
  if (type === "local") {
    if (typeof cfg.path !== "string" || !cfg.path) throw new Error("local storage requires path");
  } else if (type === "s3") {
    for (const k of ["bucket", "region", "accessKeyId", "secretAccessKey"]) {
      if (typeof cfg[k] !== "string" || !cfg[k]) throw new Error(`s3 storage requires ${k}`);
    }
  } else if (type === "sftp") {
    for (const k of ["host", "username", "remoteDir"]) {
      if (typeof cfg[k] !== "string" || !cfg[k]) throw new Error(`sftp storage requires ${k}`);
    }
  }
}

export function toPublicStorage(s: StorageTarget) {
  const cfg = JSON.parse(s.config_json) as Record<string, unknown>;
  const redacted = { ...cfg };
  for (const secret of ["secretAccessKey", "password", "privateKey"]) {
    if (secret in redacted) redacted[secret] = "***";
  }
  return {
    id: s.id,
    name: s.name,
    type: s.type,
    enabled: Boolean(s.enabled),
    config: redacted,
    createdAt: s.created_at,
  };
}

export async function uploadRecordingFile(
  storage: StorageTarget,
  localFile: string,
  remoteName: string
): Promise<string> {
  const cfg = JSON.parse(storage.config_json) as Record<string, unknown>;
  if (storage.type === "local") {
    const destDir = path.resolve(String(cfg.path));
    const dest = path.join(destDir, remoteName);
    // remoteName includes the camera id to keep recordings separated. Create
    // its parent as well as the archive root before copying to NAS/SAN mounts.
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(localFile, dest);
    return dest;
  }
  if (storage.type === "s3") {
    const client = new S3Client({
      region: String(cfg.region),
      endpoint: cfg.endpoint ? String(cfg.endpoint) : undefined,
      forcePathStyle: Boolean(cfg.forcePathStyle),
      credentials: {
        accessKeyId: String(cfg.accessKeyId),
        secretAccessKey: String(cfg.secretAccessKey),
      },
    });
    const keyPrefix = cfg.prefix ? String(cfg.prefix).replace(/\/?$/, "/") : "";
    const key = `${keyPrefix}${remoteName}`;
    const body = fs.readFileSync(localFile);
    await client.send(
      new PutObjectCommand({
        Bucket: String(cfg.bucket),
        Key: key,
        Body: body,
        ContentType: "video/mp4",
      })
    );
    return `s3://${cfg.bucket}/${key}`;
  }
  if (storage.type === "sftp") {
    const sftp = new SftpClient();
    try {
      await sftp.connect({
        host: String(cfg.host),
        port: Number(cfg.port ?? 22),
        username: String(cfg.username),
        password: cfg.password ? String(cfg.password) : undefined,
        privateKey: cfg.privateKey ? String(cfg.privateKey) : undefined,
      });
      const remoteDir = String(cfg.remoteDir).replace(/\/?$/, "/");
      const remotePath = `${remoteDir}${remoteName}`;
      await sftp.put(localFile, remotePath);
      return remotePath;
    } finally {
      await sftp.end().catch(() => undefined);
    }
  }
  throw new Error(`Unsupported storage type ${storage.type}`);
}

export function ensureDefaultLocalStorage(): void {
  if (countStorageTargets() > 0) return;
  const dest = config.archiveDir;
  fs.mkdirSync(dest, { recursive: true });
  db.prepare(
    `INSERT INTO storage_targets (id, name, type, config_json, enabled, created_at) VALUES (?, ?, ?, ?, 1, ?)`
  ).run("local-default", "Local archive", "local", JSON.stringify({ path: dest }), nowIso());
}

export function recordUpload(
  recordingId: string,
  storageId: string,
  status: string,
  remotePath?: string,
  error?: string
): void {
  db.prepare(
    `INSERT INTO uploads (id, recording_id, storage_id, status, remote_path, error, created_at, finished_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    nanoid(12),
    recordingId,
    storageId,
    status,
    remotePath ?? null,
    error ?? null,
    nowIso(),
    status === "pending" ? null : nowIso()
  );
}
