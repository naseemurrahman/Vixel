import { nanoid } from "nanoid";
import { z } from "zod";
import {
  ALL_CODECS,
  COMPRESSION_PROFILES,
  STREAM_TYPES,
  profileDefaults,
  type CodecId,
  type CompressionProfile,
  type StreamType,
} from "./compression-strategy.js";
import { audit, db, nowIso } from "./db.js";
import { effectiveEntitlements } from "./license.js";

export const CameraInputSchema = z.object({
  name: z.string().min(1).max(120),
  rtspUrl: z
    .string()
    .min(7)
    .refine((u) => /^rtsps?:\/\//i.test(u), "Must be an rtsp:// or rtsps:// URL"),
  streamType: z.enum(STREAM_TYPES).default("stream1"),
  stream1Url: z.string().optional(),
  stream2Url: z.string().optional(),
  stream3Url: z.string().optional(),
  activeStream: z.enum(["stream1", "stream2", "stream3", "all"]).default("stream1"),
  aiEnabled: z.boolean().default(true),
  aiRoiMode: z.enum(["adaptive", "foreground_faces", "balanced", "disabled"]).default("adaptive"),
  targetCompressionPct: z.number().int().min(50).max(95).default(80),
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
  stream_type: string;
  stream1_url: string | null;
  stream2_url: string | null;
  stream3_url: string | null;
  active_stream: string;
  ai_enabled: number;
  ai_roi_mode: string;
  target_compression_pct: number;
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
  if (!names.has("stream_type")) {
    add(`ALTER TABLE cameras ADD COLUMN stream_type TEXT NOT NULL DEFAULT 'stream1'`);
  }
  if (!names.has("stream1_url")) {
    add(`ALTER TABLE cameras ADD COLUMN stream1_url TEXT`);
  }
  if (!names.has("stream2_url")) {
    add(`ALTER TABLE cameras ADD COLUMN stream2_url TEXT`);
  }
  if (!names.has("stream3_url")) {
    add(`ALTER TABLE cameras ADD COLUMN stream3_url TEXT`);
  }
  if (!names.has("active_stream")) {
    add(`ALTER TABLE cameras ADD COLUMN active_stream TEXT NOT NULL DEFAULT 'stream1'`);
  }
  if (!names.has("ai_enabled")) {
    add(`ALTER TABLE cameras ADD COLUMN ai_enabled INTEGER NOT NULL DEFAULT 1`);
  }
  if (!names.has("ai_roi_mode")) {
    add(`ALTER TABLE cameras ADD COLUMN ai_roi_mode TEXT NOT NULL DEFAULT 'adaptive'`);
  }
  if (!names.has("target_compression_pct")) {
    add(`ALTER TABLE cameras ADD COLUMN target_compression_pct INTEGER NOT NULL DEFAULT 80`);
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

export function resolveCameraStreamUrl(
  camera: Camera,
  targetStream?: "stream1" | "stream2" | "stream3"
): { url: string; stream: "stream1" | "stream2" | "stream3" } {
  const stream = targetStream ?? (
    camera.active_stream === "stream2" ? "stream2" :
    camera.active_stream === "stream3" ? "stream3" : "stream1"
  );

  let url = camera.rtsp_url;
  if (stream === "stream1") {
    url = camera.stream1_url || camera.rtsp_url;
  } else if (stream === "stream2") {
    if (camera.stream2_url) {
      url = camera.stream2_url;
    } else {
      // Auto-derive sub-stream for standard IP cameras (e.g., Hikvision /101 -> /102, Dahua /ch1/main -> /ch1/sub)
      url = camera.rtsp_url
        .replace(/101(\b|_|\/)/, "102$1")
        .replace(/\/main\b/i, "/sub");
    }
  } else if (stream === "stream3") {
    if (camera.stream3_url) {
      url = camera.stream3_url;
    } else {
      // Auto-derive third stream (e.g., /101 -> /103, /ch1/main -> /ch1/third)
      url = camera.rtsp_url
        .replace(/101(\b|_|\/)/, "103$1")
        .replace(/\/main\b/i, "/third");
    }
  }

  return { url, stream };
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
  const stream1 = input.stream1Url || input.rtspUrl;

  db.prepare(
    `INSERT INTO cameras (
       id, name, rtsp_url, stream_type, stream1_url, stream2_url, stream3_url,
       active_stream, ai_enabled, ai_roi_mode, target_compression_pct,
       enabled, segment_seconds, crf, codec, preset, audio,
       compression_profile, gop_size, bframes, mpdecimate, created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    id,
    input.name,
    input.rtspUrl,
    input.streamType ?? "stream1",
    stream1,
    input.stream2Url ?? null,
    input.stream3Url ?? null,
    input.activeStream ?? "stream1",
    input.aiEnabled ? 1 : 0,
    input.aiRoiMode ?? "adaptive",
    input.targetCompressionPct ?? 80,
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

  audit(actor, "camera.create", { id, name: input.name, profile: enc.profile, streamType: input.streamType });
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
    streamType: (input.streamType ?? existing.stream_type) as StreamType,
    stream1Url: input.stream1Url ?? (existing.stream1_url ?? existing.rtsp_url),
    stream2Url: input.stream2Url ?? existing.stream2_url ?? undefined,
    stream3Url: input.stream3Url ?? existing.stream3_url ?? undefined,
    activeStream: input.activeStream ?? (existing.active_stream as "stream1" | "stream2" | "stream3" | "all"),
    aiEnabled: input.aiEnabled ?? Boolean(existing.ai_enabled),
    aiRoiMode: input.aiRoiMode ?? (existing.ai_roi_mode as "adaptive" | "foreground_faces" | "balanced" | "disabled"),
    targetCompressionPct: input.targetCompressionPct ?? existing.target_compression_pct,
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
    streamType: merged.streamType ?? "stream1",
    stream1Url: merged.stream1Url,
    stream2Url: merged.stream2Url,
    stream3Url: merged.stream3Url,
    activeStream: merged.activeStream ?? "stream1",
    aiEnabled: merged.aiEnabled ?? true,
    aiRoiMode: merged.aiRoiMode ?? "adaptive",
    targetCompressionPct: merged.targetCompressionPct ?? 80,
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
       name=?, rtsp_url=?, stream_type=?, stream1_url=?, stream2_url=?, stream3_url=?,
       active_stream=?, ai_enabled=?, ai_roi_mode=?, target_compression_pct=?,
       enabled=?, segment_seconds=?, crf=?, codec=?, preset=?, audio=?,
       compression_profile=?, gop_size=?, bframes=?, mpdecimate=?, updated_at=?
     WHERE id=?`
  ).run(
    merged.name,
    merged.rtspUrl,
    merged.streamType ?? "stream1",
    merged.stream1Url ?? merged.rtspUrl,
    merged.stream2Url ?? null,
    merged.stream3Url ?? null,
    merged.activeStream ?? "stream1",
    merged.aiEnabled ? 1 : 0,
    merged.aiRoiMode ?? "adaptive",
    merged.targetCompressionPct ?? 80,
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

  audit(actor, "camera.update", { id, profile: enc.profile, streamType: merged.streamType });
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
    streamType: c.stream_type || "stream1",
    stream1Url: c.stream1_url || c.rtsp_url,
    stream2Url: c.stream2_url || null,
    stream3Url: c.stream3_url || null,
    activeStream: c.active_stream || "stream1",
    aiEnabled: c.ai_enabled == null ? true : Boolean(c.ai_enabled),
    aiRoiMode: c.ai_roi_mode || "adaptive",
    targetCompressionPct: c.target_compression_pct || 80,
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
