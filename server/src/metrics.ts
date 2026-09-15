import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { config } from "./config.js";
import { getActiveJobs, getActiveOutputBytes, listRecordings } from "./compress.js";
import { listCameras } from "./cameras.js";
import { db, nowIso } from "./db.js";

export type MetricSample = {
  ts: string;
  cpuPct: number;
  memUsedMb: number;
  memRssMb: number;
  activeJobs: number;
  camerasEnabled: number;
  bytesOutRate: number;
  compressionPct: number;
  diskRecordingsMb: number;
};

export type HostSnapshot = {
  hostname: string;
  platform: string;
  architecture: string;
  cpuModel: string;
  cpuCores: number;
  memoryTotalMb: number;
  memoryFreeMb: number;
  uptimeSeconds: number;
  nodeVersion: string;
};

const MAX_SAMPLES = 180; // ~6 min at 2s
const samples: MetricSample[] = [];
let lastCpu = process.cpuUsage();
let lastHr = process.hrtime.bigint();
let lastBytesOutTotal = 0;
let timer: NodeJS.Timeout | null = null;

type CpuTotals = { idle: number; total: number };

function cpuTotals(): CpuTotals {
  return os.cpus().reduce(
    (total, cpu) => {
      const times = cpu.times;
      total.idle += times.idle;
      total.total += times.user + times.nice + times.sys + times.idle + times.irq;
      return total;
    },
    { idle: 0, total: 0 }
  );
}

let lastHostCpu = cpuTotals();

function dirSizeMb(dir: string): number {
  let total = 0;
  const walk = (p: string) => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(p, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const full = path.join(p, e.name);
      if (e.isDirectory()) walk(full);
      else {
        try {
          total += fs.statSync(full).size;
        } catch {
          /* ignore */
        }
      }
    }
  };
  if (fs.existsSync(dir)) walk(dir);
  return Math.round((total / (1024 * 1024)) * 10) / 10;
}

function bytesOutSum(): number {
  const row = db
    .prepare(`SELECT COALESCE(SUM(bytes_out), 0) AS s FROM recordings WHERE bytes_out IS NOT NULL`)
    .get() as { s: number };
  return (Number(row.s) || 0) + getActiveOutputBytes();
}

function avgCompressionPct(): number {
  const row = db
    .prepare(
      `SELECT AVG(compression_ratio) AS a FROM recordings
       WHERE compression_ratio IS NOT NULL AND started_at > datetime('now', '-1 hour')`
    )
    .get() as { a: number | null };
  return row.a != null ? Math.round(row.a * 1000) / 10 : 0;
}

export function collectSample(): MetricSample {
  const processCpu = process.cpuUsage(lastCpu);
  const hr = process.hrtime.bigint();
  const elapsedUs = Number(hr - lastHr) / 1000;
  lastCpu = process.cpuUsage();
  lastHr = hr;
  const processCpuPct =
    elapsedUs > 0
      ? Math.min(100, Math.round(((processCpu.user + processCpu.system) / elapsedUs) * 1000) / 10)
      : 0;

  const hostCpu = cpuTotals();
  const hostTotalDelta = hostCpu.total - lastHostCpu.total;
  const hostIdleDelta = hostCpu.idle - lastHostCpu.idle;
  lastHostCpu = hostCpu;
  const cpuPct =
    hostTotalDelta > 0
      ? Math.round((1 - hostIdleDelta / hostTotalDelta) * 1000) / 10
      : processCpuPct;

  const mem = process.memoryUsage();
  const memUsedMb = Math.round((mem.heapUsed / (1024 * 1024)) * 10) / 10;
  const memRssMb = Math.round((mem.rss / (1024 * 1024)) * 10) / 10;

  const totalOut = bytesOutSum();
  const delta = Math.max(0, totalOut - lastBytesOutTotal);
  lastBytesOutTotal = totalOut;
  // approx MB/s over ~2s interval
  const bytesOutRate = Math.round((delta / 2 / (1024 * 1024)) * 1000) / 1000;

  const cams = listCameras();
  const sample: MetricSample = {
    ts: nowIso(),
    cpuPct,
    memUsedMb,
    memRssMb,
    activeJobs: getActiveJobs().length,
    camerasEnabled: cams.filter((c) => c.enabled).length,
    bytesOutRate,
    compressionPct: avgCompressionPct(),
    diskRecordingsMb: dirSizeMb(config.recordingsDir),
  };

  samples.push(sample);
  if (samples.length > MAX_SAMPLES) samples.shift();

  try {
    db.prepare(
      `INSERT INTO metric_samples
       (ts, cpu_pct, mem_used_mb, mem_rss_mb, active_jobs, cameras_enabled, bytes_out_rate, compression_pct, disk_recordings_mb)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      sample.ts,
      sample.cpuPct,
      sample.memUsedMb,
      sample.memRssMb,
      sample.activeJobs,
      sample.camerasEnabled,
      sample.bytesOutRate,
      sample.compressionPct,
      sample.diskRecordingsMb
    );
    db.prepare(
      `DELETE FROM metric_samples WHERE id NOT IN (SELECT id FROM metric_samples ORDER BY id DESC LIMIT ?)`
    ).run(MAX_SAMPLES);
  } catch {
    /* schema may not be ready yet on first tick */
  }

  return sample;
}

export function getRecentSamples(limit = 90): MetricSample[] {
  if (samples.length) return samples.slice(-limit);
  const rows = db
    .prepare(
      `SELECT ts, cpu_pct AS cpuPct, mem_used_mb AS memUsedMb, mem_rss_mb AS memRssMb,
              active_jobs AS activeJobs, cameras_enabled AS camerasEnabled,
              bytes_out_rate AS bytesOutRate, compression_pct AS compressionPct,
              disk_recordings_mb AS diskRecordingsMb
       FROM metric_samples ORDER BY id DESC LIMIT ?`
    )
    .all(limit) as MetricSample[];
  return rows.reverse();
}

export function getLatestSample(): MetricSample | null {
  return samples[samples.length - 1] ?? getRecentSamples(1)[0] ?? null;
}

export function getHostSnapshot(): HostSnapshot {
  const cpus = os.cpus();
  return {
    hostname: os.hostname(),
    platform: `${os.type()} ${os.release()}`,
    architecture: os.arch(),
    cpuModel: cpus[0]?.model ?? "Unknown processor",
    cpuCores: cpus.length,
    memoryTotalMb: Math.round(os.totalmem() / (1024 * 1024)),
    memoryFreeMb: Math.round(os.freemem() / (1024 * 1024)),
    uptimeSeconds: Math.round(os.uptime()),
    nodeVersion: process.version,
  };
}

export function startMetricsCollector(intervalMs = 2000): void {
  if (timer) return;
  lastBytesOutTotal = bytesOutSum();
  collectSample();
  timer = setInterval(() => {
    try {
      collectSample();
    } catch (e) {
      console.error("[vixel] metrics collect failed", e);
    }
  }, intervalMs);
  timer.unref?.();
}

export function getUsageSummary() {
  const cams = listCameras();
  const recStats = db
    .prepare(
      `SELECT
         COUNT(*) AS total,
         SUM(CASE WHEN status = 'uploaded' THEN 1 ELSE 0 END) AS uploaded,
         SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) AS failed,
         COALESCE(SUM(bytes_in), 0) AS bytesIn,
         COALESCE(SUM(bytes_out), 0) AS bytesOut,
         AVG(compression_ratio) AS avgRatio
       FROM recordings`
    )
    .get() as {
    total: number;
    uploaded: number;
    failed: number;
    bytesIn: number;
    bytesOut: number;
    avgRatio: number | null;
  };

  const byDay = db
    .prepare(
      `SELECT date(started_at) AS day,
              COUNT(*) AS recordings,
              COALESCE(SUM(bytes_out), 0) AS bytesOut,
              AVG(compression_ratio) AS avgRatio
       FROM recordings
       WHERE started_at > datetime('now', '-14 days')
       GROUP BY date(started_at)
       ORDER BY day`
    )
    .all() as { day: string; recordings: number; bytesOut: number; avgRatio: number | null }[];

  const byCamera = db
    .prepare(
      `SELECT c.name AS camera, COUNT(r.id) AS recordings,
              COALESCE(SUM(r.bytes_out), 0) AS bytesOut,
              AVG(r.compression_ratio) AS avgRatio
       FROM cameras c
       LEFT JOIN recordings r ON r.camera_id = c.id
       GROUP BY c.id
       ORDER BY bytesOut DESC`
    )
    .all() as {
    camera: string;
    recordings: number;
    bytesOut: number;
    avgRatio: number | null;
  }[];

  const uploads = db
    .prepare(
      `SELECT status, COUNT(*) AS c FROM uploads GROUP BY status`
    )
    .all() as { status: string; c: number }[];

  const disk = dirSizeMb(config.recordingsDir);
  const freeMb = Math.round((os.freemem() / (1024 * 1024)) * 10) / 10;
  const totalMb = Math.round((os.totalmem() / (1024 * 1024)) * 10) / 10;

  return {
    cameras: {
      total: cams.length,
      enabled: cams.filter((c) => c.enabled).length,
    },
    recordings: {
      total: recStats.total,
      uploaded: recStats.uploaded,
      failed: recStats.failed,
      bytesIn: recStats.bytesIn,
      bytesOut: recStats.bytesOut,
      savedBytes: Math.max(0, recStats.bytesIn - recStats.bytesOut),
      avgCompressionPct:
        recStats.avgRatio != null ? Math.round(recStats.avgRatio * 1000) / 10 : 0,
    },
    disk: {
      recordingsMb: disk,
      hostFreeMb: freeMb,
      hostTotalMb: totalMb,
    },
    uploads,
    byDay,
    byCamera,
    recent: listRecordings(10),
  };
}
