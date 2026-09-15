import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { nanoid } from "nanoid";
import type { Camera } from "./cameras.js";
import { getCamera, listCameras } from "./cameras.js";
import { buildEncodeArgs, buildHwAccelArgs, buildStrategy, compressionRatio, HARDWARE_CODECS, type CompressionProfile } from "./compression-strategy.js";
import { config } from "./config.js";
import { db, nowIso } from "./db.js";
import { effectiveEntitlements } from "./license.js";
import { systemLog } from "./logs.js";
import { listStorageTargets, recordUpload, uploadRecordingWithRetry } from "./storage.js";

type ActiveJob = { cameraId: string; recordingId: string; proc: ReturnType<typeof spawn> };
const active = new Map<string, ActiveJob>();

function fileSize(p: string): number { try { return fs.statSync(p).size; } catch { return 0; } }

function runFfmpeg(args: string[], onProc?: (proc: ReturnType<typeof spawn>) => void): Promise<void> {
  return new Promise((resolve, reject) => {
    const proc = spawn(config.ffmpegPath, args, { windowsHide: true });
    onProc?.(proc);
    let stderr = "";
    proc.stderr?.on("data", (d) => { stderr += d.toString(); if (stderr.length > 12000) stderr = stderr.slice(-6000); });
    proc.on("error", reject);
    proc.on("close", (code) => code === 0 ? resolve() : reject(new Error(`ffmpeg exited ${code}: ${stderr || "no output"}`)));
  });
}

function probeDuration(file: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const proc = spawn(config.ffprobePath, ["-v", "error", "-show_entries", "format=duration", "-of", "default=nw=1:nk=1", file], { windowsHide: true });
    let stdout = ""; let stderr = "";
    proc.stdout?.on("data", (d) => { stdout += d.toString(); });
    proc.stderr?.on("data", (d) => { stderr += d.toString(); });
    proc.on("error", reject);
    proc.on("close", (code) => {
      const value = Number.parseFloat(stdout.trim());
      if (code === 0 && Number.isFinite(value)) resolve(value);
      else reject(new Error(`ffprobe duration failed: ${stderr || "unknown error"}`));
    });
  });
}

function strategyFromCamera(camera: Camera) {
  const profile = (camera.compression_profile || "zipstream") as CompressionProfile;
  return {
    codec: camera.codec, preset: camera.preset, crf: camera.crf, profile,
    gopSize: camera.gop_size || 300, bframes: camera.bframes ?? 8,
    mpdecimate: camera.mpdecimate == null ? true : Boolean(camera.mpdecimate),
    audio: Boolean(camera.audio),
  };
}

/**
 * Capture a camera segment, then transcode it using Vixel adaptive compression.
 *
 * The important invariant is temporal correctness: static frames may be dropped,
 * but their original PTS is retained and the output is encoded as VFR. This means
 * a 300-second surveillance segment remains a ~300-second recording.
 */
export async function compressSegment(camera: Camera): Promise<{
  recordingId: string; outputPath: string; bytesIn: number; bytesOut: number;
  ratio: number; profile: string; strategy: string; inputDuration: number;
  outputDuration: number; durationDelta: number;
}> {
  const entitlements = effectiveEntitlements();
  if (active.size >= entitlements.maxConcurrentJobs) throw new Error("Max concurrent compression jobs reached for this license");

  const recordingId = nanoid(14);
  const camDir = path.join(config.recordingsDir, camera.id);
  fs.mkdirSync(camDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const rawPath = path.join(camDir, `${stamp}.source.mkv`);
  const outPath = path.join(camDir, `${stamp}.vixel.mp4`);
  const input = strategyFromCamera(camera);
  const plan = buildStrategy(input);

  db.prepare(`INSERT INTO recordings (id, camera_id, status, source_path, output_path, started_at) VALUES (?, ?, "capturing", ?, ?, ?)`).run(recordingId, camera.id, rawPath, outPath, nowIso());
  const track = (proc: ReturnType<typeof spawn>) => active.set(camera.id, { cameraId: camera.id, recordingId, proc });

  try {
    // Stage A: preserve the camera bitstream for an honest, same-window baseline.
    await runFfmpeg(["-hide_banner", "-loglevel", "error", "-rtsp_transport", "tcp", "-i", camera.rtsp_url, "-t", String(camera.segment_seconds), "-map", "0", "-c", "copy", "-f", "matroska", "-y", rawPath], track);
    const bytesIn = fileSize(rawPath);
    if (bytesIn < 1024) throw new Error("Source capture too small — check RTSP URL / camera reachability");
    const inputDuration = await probeDuration(rawPath);

    db.prepare(`UPDATE recordings SET status="compressing" WHERE id=?`).run(recordingId);

    // Stage B: scene-aware temporal reduction + I/P/B GoV + adaptive quantization.
    // Hardware encoders (QSV/NVENC/VAAPI) need any device-init args before -i.
    await runFfmpeg([
      "-hide_banner", "-loglevel", "error", ...buildHwAccelArgs(input), "-i", rawPath,
      ...buildEncodeArgs(input), "-y", outPath,
    ], track);
    active.delete(camera.id);
    if (!fs.existsSync(outPath)) throw new Error("Encode produced no output file");

    const bytesOut = fileSize(outPath);
    const ratio = compressionRatio(bytesIn, bytesOut);
    const outputDuration = await probeDuration(outPath);
    const durationDelta = outputDuration - inputDuration;

    // A dropped-frame compressor must never silently accelerate a recording.
    // Allow a small container timestamp tolerance, but reject a materially short file.
    if (Math.abs(durationDelta) > Math.max(2, inputDuration * 0.02)) {
      throw new Error(`Output duration mismatch: input=${inputDuration.toFixed(3)}s output=${outputDuration.toFixed(3)}s`);
    }

    db.prepare(`UPDATE recordings SET status="compressed", bytes_in=?, bytes_out=?, compression_ratio=?, finished_at=? WHERE id=?`).run(bytesIn, bytesOut, ratio, nowIso(), recordingId);

    systemLog("info", "compress", `Adaptive segment ${camera.name}`, {
      profile: input.profile, bytesIn, bytesOut, savingsPct: Math.round(ratio * 1000) / 10,
      gop: input.gopSize, bframes: input.bframes, mpdecimate: input.mpdecimate,
      staticFrameStride: plan.staticFrameStride, motionThreshold: plan.motionThreshold,
      inputDuration, outputDuration, durationDelta,
    });

    if (input.profile !== "forensic") { try { fs.unlinkSync(rawPath); } catch { /* ignore */ } }
    await uploadToAllTargets(recordingId, camera.id, outPath);

    return { recordingId, outputPath: outPath, bytesIn, bytesOut, ratio, profile: input.profile, strategy: plan.description, inputDuration, outputDuration, durationDelta };
  } catch (e) {
    active.delete(camera.id);
    const msg = e instanceof Error ? e.message : String(e);
    db.prepare(`UPDATE recordings SET status="failed", error=?, finished_at=? WHERE id=?`).run(msg, nowIso(), recordingId);
    systemLog("error", "compress", msg, { cameraId: camera.id });
    throw e;
  }
}

async function uploadToAllTargets(recordingId: string, cameraId: string, localFile: string): Promise<void> {
  const targets = listStorageTargets().filter((t) => t.enabled);
  if (targets.length === 0) {
    systemLog("warn", "storage", "No enabled storage targets; compressed output remains in staging", { recordingId });
    return;
  }
  const base = path.basename(localFile);
  const remoteName = `${cameraId}/${base}`;
  let failures = 0;
  for (const target of targets) {
    try {
      const remote = await uploadRecordingWithRetry(target, localFile, remoteName);
      recordUpload(recordingId, target.id, "uploaded", remote);
    } catch (e) {
      failures += 1;
      const msg = e instanceof Error ? e.message : String(e);
      recordUpload(recordingId, target.id, "failed", undefined, msg);
      systemLog("error", "storage", "Recording upload failed after retries", {
        recordingId, targetId: target.id, target: target.name, error: msg,
      });
    }
  }
  // "uploaded" means every configured target confirmed the file. A partial
  // delivery must remain visible to operators instead of being marked healthy.
  db.prepare(`UPDATE recordings SET status=? WHERE id=?`).run(
    failures === 0 ? "uploaded" : "upload_failed",
    recordingId
  );
}

let hwEncoderCache: { at: number; encoders: string[] } | null = null;

/**
 * Probes `ffmpeg -encoders` for which hardware encoders this host can actually
 * use. Vixel never assumes a GPU/driver is present just because a codec name
 * exists — an unavailable hardware encoder should be rejected by the API
 * before a camera is misconfigured, not discovered as a runtime failure.
 * Cached briefly since the host's encoder set doesn't change at runtime.
 */
export function detectHardwareEncoders(maxAgeMs = 60_000): Promise<string[]> {
  if (hwEncoderCache && Date.now() - hwEncoderCache.at < maxAgeMs) {
    return Promise.resolve(hwEncoderCache.encoders);
  }
  return new Promise((resolve) => {
    const proc = spawn(config.ffmpegPath, ["-hide_banner", "-encoders"], { windowsHide: true });
    let stdout = "";
    proc.stdout?.on("data", (d) => { stdout += d.toString(); });
    proc.on("error", () => resolve([]));
    proc.on("close", () => {
      const found = HARDWARE_CODECS.filter((name) => stdout.includes(name));
      hwEncoderCache = { at: Date.now(), encoders: found };
      resolve(found);
    });
  });
}

export function stopCameraJob(cameraId: string): boolean {
  const job = active.get(cameraId);
  if (!job) return false;
  job.proc.kill("SIGTERM");
  active.delete(cameraId);
  return true;
}
export function getActiveJobs() { return [...active.values()].map((j) => ({ cameraId: j.cameraId, recordingId: j.recordingId })); }

const loops = new Map<string, { stop: boolean }>();
export function startCameraLoop(cameraId: string): void {
  if (loops.has(cameraId)) return;
  const state = { stop: false }; loops.set(cameraId, state);
  (async () => {
    while (!state.stop) {
      const cam = getCamera(cameraId); if (!cam || !cam.enabled) break;
      try { await compressSegment(cam); }
      catch (e) { console.error(`[vixel] camera ${cameraId} segment failed:`, e); await sleep(5000); }
    }
    loops.delete(cameraId);
  })();
}
export function stopCameraLoop(cameraId: string): void { const state = loops.get(cameraId); if (state) state.stop = true; stopCameraJob(cameraId); loops.delete(cameraId); }
export function syncCameraLoops(): void {
  const enabled = new Set(listCameras().filter((c) => c.enabled).map((c) => c.id));
  for (const id of enabled) startCameraLoop(id);
  for (const id of [...loops.keys()]) if (!enabled.has(id)) stopCameraLoop(id);
}
function sleep(ms: number): Promise<void> { return new Promise((r) => setTimeout(r, ms)); }
export function listRecordings(limit = 50) {
  return db.prepare(`SELECT r.*, c.name AS camera_name FROM recordings r LEFT JOIN cameras c ON c.id = r.camera_id ORDER BY r.started_at DESC LIMIT ?`).all(limit);
}
