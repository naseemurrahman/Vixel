import { nanoid } from "nanoid";
import { z } from "zod";
import {
  ALL_CODECS,
  COMPRESSION_PROFILES,
  profileDefaults,
  type CodecId,
  type CompressionProfile,
} from "./compression-strategy.js";
import { audit, db, nowIso } from "./db.js";
import { effectiveEntitlements } from "./license.js";

export const CameraInputSchema = z.object({
  name: z.string().min(1).max(120),
  rtspUrl: z
    .string()
    .min(7)
    .refine((u) => /^rtsps?:\/\//i.test(u), "Must be an rtsp:// or rtsps:// URL"),
  enabled: z.boolean().default(true),
  segmentSeconds: z.number().int().min(30).max(3600).default(300),
  crf: z.number().int().min(18).max(40).optional(),
  codec: z.enum(ALL_CODECS).default("libx265"),
  preset: z.string().default("medium"),
  audio: z.boolean().default(false),
  compressionProfile: z.enum(COMPRESSION_PROFILES).default("zipstream"),
  gopSize: z.number().int().min(15).max(600).optional(),
  bframes: z.number().int().min(0).max(16).optional(),
  mpdecimate: z.boolean().optional(),
});

export type Camera = {
  id: string;
  name: string;
  rtsp_url: string;
  enabled: number;
  segment_seconds: number;
  crf: number;
  codec: string;
  preset: string;
  audio: number;
  compression_profile: string;
  gop_size: number;
  bframes: number;
  mpdecimate: number;
  created_at: string;
  updated_at: string;
};

export function ensureCameraColumns(): void {
  const cols = db.prepare(`PRAGMA table_info(cameras)`).all() as { name: string }[];
  const names = new Set(cols.map((c) => c.name));
  const add = (sql: string) => {
    try {
      db.exec(sql);
    } catch {
      /* already exists */
    }
  };
  if (!names.has("compression_profile")) {
    add(`ALTER TABLE cameras ADD COLUMN compression_profile TEXT NOT NULL DEFAULT 'zipstream'`);
  }
  if (!names.has("gop_size")) {
    add(`ALTER TABLE cameras ADD COLUMN gop_size INTEGER NOT NULL DEFAULT 300`);
  }
  if (!names.has("bframes")) {
    add(`ALTER TABLE cameras ADD COLUMN bframes INTEGER NOT NULL DEFAULT 8`);
  }
  if (!names.has("mpdecimate")) {
    add(`ALTER TABLE cameras ADD COLUMN mpdecimate INTEGER NOT NULL DEFAULT 1`);
  }
}

function resolveEncodeSettings(input: z.infer<typeof CameraInputSchema>) {
  const profile = input.compressionProfile as CompressionProfile;
  const defaults = profileDefaults(profile);
  return {
    profile,
    crf: input.crf ?? defaults.defaultCrf,
    gopSize: input.gopSize ?? defaults.defaultGop,
    bframes: input.bframes ?? defaults.defaultB,
    mpdecimate: input.mpdecimate ?? profile !== "forensic",
  };
}

export function listCameras(): Camera[] {
  return db.prepare(`SELECT * FROM cameras ORDER BY name`).all() as Camera[];
}

export function getCamera(id: string): Camera | undefined {
  return db.prepare(`SELECT * FROM cameras WHERE id = ?`).get(id) as Camera | undefined;
}

export function countCameras(): number {
  const row = db.prepare(`SELECT COUNT(*) AS c FROM cameras`).get() as { c: number };
  return row.c;
}

export function createCamera(input: z.infer<typeof CameraInputSchema>, actor: string): Camera {
  const entitlements = effectiveEntitlements();
  if (countCameras() >= entitlements.maxCameras) {
    throw new Error(
      `License limit reached: max ${entitlements.maxCameras} camera(s). Upgrade entitlements to add more.`
    );
  }
  const enc = resolveEncodeSettings(input);
  const id = nanoid(12);
  const ts = nowIso();
  db.prepare(
    `INSERT INTO cameras (
       id, name, rtsp_url, enabled, segment_seconds, crf, codec, preset, audio,
       compression_profile, gop_size, bframes, mpdecimate, created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    id,
    input.name,
    input.rtspUrl,
    input.enabled ? 1 : 0,
    input.segmentSeconds,
    enc.crf,
    input.codec,
    input.preset,
    input.audio ? 1 : 0,
    enc.profile,
    enc.gopSize,
    enc.bframes,
    enc.mpdecimate ? 1 : 0,
    ts,
    ts
  );
  audit(actor, "camera.create", { id, name: input.name, profile: enc.profile });
  return getCamera(id)!;
}

export function updateCamera(
  id: string,
  input: Partial<z.infer<typeof CameraInputSchema>>,
  actor: string
): Camera {
  const existing = getCamera(id);
  if (!existing) throw new Error("Camera not found");

  const merged = CameraInputSchema.partial().parse({
    name: input.name ?? existing.name,
    rtspUrl: input.rtspUrl ?? existing.rtsp_url,
    enabled: input.enabled ?? Boolean(existing.enabled),
    segmentSeconds: input.segmentSeconds ?? existing.segment_seconds,
    crf: input.crf ?? existing.crf,
    codec: (input.codec ?? existing.codec) as CodecId,
    preset: input.preset ?? existing.preset,
    audio: input.audio ?? Boolean(existing.audio),
    compressionProfile: (input.compressionProfile ??
      existing.compression_profile) as CompressionProfile,
    gopSize: input.gopSize ?? existing.gop_size,
    bframes: input.bframes ?? existing.bframes,
    mpdecimate: input.mpdecimate ?? Boolean(existing.mpdecimate),
  });

  const enc = resolveEncodeSettings({
    name: merged.name!,
    rtspUrl: merged.rtspUrl!,
    enabled: merged.enabled ?? true,
    segmentSeconds: merged.segmentSeconds ?? 300,
    crf: merged.crf,
    codec: merged.codec ?? "libx265",
    preset: merged.preset ?? "medium",
    audio: merged.audio ?? false,
    compressionProfile: merged.compressionProfile ?? "zipstream",
    gopSize: merged.gopSize,
    bframes: merged.bframes,
    mpdecimate: merged.mpdecimate,
  });

  db.prepare(
    `UPDATE cameras SET
       name=?, rtsp_url=?, enabled=?, segment_seconds=?, crf=?, codec=?, preset=?, audio=?,
       compression_profile=?, gop_size=?, bframes=?, mpdecimate=?, updated_at=?
     WHERE id=?`
  ).run(
    merged.name,
    merged.rtspUrl,
    merged.enabled ? 1 : 0,
    merged.segmentSeconds,
    enc.crf,
    merged.codec,
    merged.preset,
    merged.audio ? 1 : 0,
    enc.profile,
    enc.gopSize,
    enc.bframes,
    enc.mpdecimate ? 1 : 0,
    nowIso(),
    id
  );
  audit(actor, "camera.update", { id, profile: enc.profile });
  return getCamera(id)!;
}

export function deleteCamera(id: string, actor: string): void {
  db.prepare(`DELETE FROM cameras WHERE id = ?`).run(id);
  audit(actor, "camera.delete", { id });
}

export function toPublicCamera(c: Camera) {
  const profile = (c.compression_profile || "zipstream") as CompressionProfile;
  return {
    id: c.id,
    name: c.name,
    rtspUrl: c.rtsp_url,
    enabled: Boolean(c.enabled),
    segmentSeconds: c.segment_seconds,
    crf: c.crf,
    codec: c.codec,
    preset: c.preset,
    audio: Boolean(c.audio),
    compressionProfile: profile,
    gopSize: c.gop_size ?? profileDefaults(profile).defaultGop,
    bframes: c.bframes ?? profileDefaults(profile).defaultB,
    mpdecimate: c.mpdecimate == null ? true : Boolean(c.mpdecimate),
    strategyHint: profileDefaults(profile).expectedStaticSavings,
    createdAt: c.created_at,
    updatedAt: c.updated_at,
  };
}
