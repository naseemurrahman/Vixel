import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { nanoid } from "nanoid";
import type { Camera } from "./cameras.js";
import { getCamera, listCameras } from "./cameras.js";
import {
  buildEncodeArgs,
  buildStrategy,
  compressionRatio,
  type CompressionProfile,
} from "./compression-strategy.js";
import { config } from "./config.js";
import { db, nowIso } from "./db.js";
import { effectiveEntitlements } from "./license.js";
import { systemLog } from "./logs.js";
import {
  listStorageTargets,
  recordUpload,
  uploadRecordingFile,
} from "./storage.js";

type ActiveJob = {
  cameraId: string;
  recordingId: string;
  outputPath: string;
  procs: Set<ReturnType<typeof spawn>>;
};

const active = new Map<string, ActiveJob>();

function fileSize(p: string): number {
  try {
    return fs.statSync(p).size;
  } catch {
    return 0;
  }
}

function runFfmpeg(
  args: string[],
  onProc?: (proc: ReturnType<typeof spawn>) => void
): Promise<void> {
  return new Promise((resolve, reject) => {
    const proc = spawn(config.ffmpegPath, args, { windowsHide: true });
    onProc?.(proc);
    let stderr = "";
    proc.stderr?.on("data", (d) => {
      stderr += d.toString();
      if (stderr.length > 12000) stderr = stderr.slice(-6000);
    });
    proc.on("error", reject);
    proc.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`ffmpeg exited ${code}: ${stderr || "no output"}`));
    });
  });
}

function strategyFromCamera(camera: Camera) {
  const profile = (camera.compression_profile || "zipstream") as CompressionProfile;
  return {
    codec: camera.codec,
    preset: camera.preset,
    crf: camera.crf,
    profile,
    gopSize: camera.gop_size || 300,
    bframes: camera.bframes ?? 8,
    mpdecimate: camera.mpdecimate == null ? true : Boolean(camera.mpdecimate),
    audio: Boolean(camera.audio),
  };
}

/**
 * Two-stage Zipstream-inspired pipeline (brand-agnostic RTSP):
 * 1) Remux camera bitstream with -c copy → authentic bytes_in baseline
 * 2) Re-encode with GoV / P/B / mpdecimate / AQ → bytes_out
 * Savings % = (1 - bytes_out/bytes_in) * 100
 */
export async function compressSegment(camera: Camera): Promise<{
  recordingId: string;
  outputPath: string;
  bytesIn: number;
  bytesOut: number;
  ratio: number;
  profile: string;
  strategy: string;
}> {
  const entitlements = effectiveEntitlements();
  if (active.size >= entitlements.maxConcurrentJobs) {
    throw new Error("Max concurrent compression jobs reached for this license");
  }

  const recordingId = nanoid(14);
  const camDir = path.join(config.recordingsDir, camera.id);
  fs.mkdirSync(camDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const rawPath = path.join(camDir, `${stamp}.source.ts`);
  const outPath = path.join(camDir, `${stamp}.zipstream.mp4`);
  const input = strategyFromCamera(camera);
  const plan = buildStrategy(input);

  db.prepare(
    `INSERT INTO recordings (id, camera_id, status, source_path, output_path, started_at)
     VALUES (?, ?, 'capturing', ?, ?, ?)`
  ).run(recordingId, camera.id, rawPath, outPath, nowIso());

  const job: ActiveJob = { cameraId: camera.id, recordingId, outputPath: outPath, procs: new Set() };
  const track = (proc: ReturnType<typeof spawn>) => {
    job.procs.add(proc);
    active.set(camera.id, job);
  };

  try {
    // Record the source baseline and encode at the same time. This keeps the
    // compressor live for the full recording interval instead of waiting for a
    // completed source segment before beginning the encode.
    await Promise.all([
      runFfmpeg(
      [
        "-hide_banner",
        "-loglevel",
        "error",
        "-rtsp_transport",
        "tcp",
        "-i",
        camera.rtsp_url,
        "-t",
        String(camera.segment_seconds),
        "-c",
        "copy",
        "-f",
        "mpegts",
        "-y",
        rawPath,
      ],
      track
      ),
      runFfmpeg(
        [
          "-hide_banner",
          "-loglevel",
          "error",
          "-rtsp_transport",
          "tcp",
          "-i",
          camera.rtsp_url,
          "-t",
          String(camera.segment_seconds),
          ...buildEncodeArgs(input),
          "-y",
          outPath,
        ],
        track
      ),
    ]);

    const bytesIn = fileSize(rawPath);
    if (bytesIn < 1024) {
      throw new Error("Source capture too small — check RTSP URL / camera reachability");
    }

    active.delete(camera.id);

    if (!fs.existsSync(outPath)) {
      throw new Error("Encode produced no output file");
    }

    const bytesOut = fileSize(outPath);
    const ratio = compressionRatio(bytesIn, bytesOut);

    db.prepare(
      `UPDATE recordings SET status='compressed', bytes_in=?, bytes_out=?, compression_ratio=?, finished_at=? WHERE id=?`
    ).run(bytesIn, bytesOut, ratio, nowIso(), recordingId);

    systemLog("info", "compress", `Zipstream segment ${camera.name}`, {
      profile: input.profile,
      bytesIn,
      bytesOut,
      savingsPct: Math.round(ratio * 1000) / 10,
      gop: input.gopSize,
      bframes: input.bframes,
      mpdecimate: input.mpdecimate,
    });

    // Keep source only if forensic profile (debug); else free disk
    if (input.profile !== "forensic") {
      try {
        fs.unlinkSync(rawPath);
      } catch {
        /* ignore */
      }
    }

    await uploadToAllTargets(recordingId, camera.id, outPath);

    return {
      recordingId,
      outputPath: outPath,
      bytesIn,
      bytesOut,
      ratio,
      profile: input.profile,
      strategy: plan.description,
    };
  } catch (e) {
    for (const proc of job.procs) {
      if (!proc.killed) proc.kill("SIGTERM");
    }
    active.delete(camera.id);
    const msg = e instanceof Error ? e.message : String(e);
    db.prepare(
      `UPDATE recordings SET status='failed', error=?, finished_at=? WHERE id=?`
    ).run(msg, nowIso(), recordingId);
    systemLog("error", "compress", msg, { cameraId: camera.id });
    throw e;
  }
}

async function uploadToAllTargets(
  recordingId: string,
  cameraId: string,
  localFile: string
): Promise<void> {
  const targets = listStorageTargets().filter((t) => t.enabled);
  const base = path.basename(localFile);
  const remoteName = `${cameraId}/${base}`;

  for (const target of targets) {
    try {
      const remote = await uploadRecordingFile(target, localFile, remoteName);
      recordUpload(recordingId, target.id, "uploaded", remote);
      db.prepare(`UPDATE recordings SET status='uploaded' WHERE id=?`).run(recordingId);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      recordUpload(recordingId, target.id, "failed", undefined, msg);
    }
  }
}

export function stopCameraJob(cameraId: string): boolean {
  const job = active.get(cameraId);
  if (!job) return false;
  for (const proc of job.procs) proc.kill("SIGTERM");
  active.delete(cameraId);
  return true;
}

export function getActiveJobs() {
  return [...active.values()].map((j) => ({
    cameraId: j.cameraId,
    recordingId: j.recordingId,
  }));
}

export function getActiveOutputBytes(): number {
  return [...active.values()].reduce((total, job) => total + fileSize(job.outputPath), 0);
}

const loops = new Map<string, { stop: boolean }>();

export function startCameraLoop(cameraId: string): void {
  if (loops.has(cameraId)) return;
  const state = { stop: false };
  loops.set(cameraId, state);

  (async () => {
    while (!state.stop) {
      const cam = getCamera(cameraId);
      if (!cam || !cam.enabled) break;
      try {
        await compressSegment(cam);
      } catch (e) {
        console.error(`[vixel] camera ${cameraId} segment failed:`, e);
        await sleep(5000);
      }
    }
    loops.delete(cameraId);
  })();
}

export function stopCameraLoop(cameraId: string): void {
  const state = loops.get(cameraId);
  if (state) state.stop = true;
  stopCameraJob(cameraId);
  loops.delete(cameraId);
}

export function syncCameraLoops(): void {
  const enabled = new Set(listCameras().filter((c) => c.enabled).map((c) => c.id));
  for (const id of enabled) startCameraLoop(id);
  for (const id of [...loops.keys()]) {
    if (!enabled.has(id)) stopCameraLoop(id);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export function listRecordings(limit = 50) {
  return db
    .prepare(
      `SELECT r.*, c.name AS camera_name FROM recordings r
       LEFT JOIN cameras c ON c.id = r.camera_id
       ORDER BY r.started_at DESC LIMIT ?`
    )
    .all(limit);
}
