import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { actorOf } from "./auth.js";
import {
  CameraInputSchema,
  createCamera,
  deleteCamera,
  getCamera,
  listCameras,
  toPublicCamera,
  updateCamera,
  resolveCameraStreamUrl,
} from "./cameras.js";
import {
  compressSegment,
  detectHardwareEncoders,
  getActiveJobs,
  listRecordings,
  startCameraLoop,
  stopCameraLoop,
  syncCameraLoops,
} from "./compress.js";
import { config } from "./config.js";
import { audit, db } from "./db.js";
import {
  acknowledgeAlert,
  createAlert,
  getSettings,
  listAlerts,
  listAuditLogs,
  listSystemLogs,
  setSetting,
  systemLog,
} from "./logs.js";
import { isHardwareCodec, listStrategyDocs, STREAM_DESCRIPTIONS, predictCompressionRatio } from "./compression-strategy.js";
import {
  effectiveEntitlements,
  getInstalledLicense,
  installLicense,
} from "./license.js";
import {
  getLatestSample,
  getRecentSamples,
  getHostSnapshot,
  getUsageSummary,
} from "./metrics.js";
import {
  createStorageTarget,
  deleteStorageTarget,
  listStorageTargets,
  StorageInputSchema,
  toPublicStorage,
} from "./storage.js";
import {
  authenticateUser,
  createUser,
  CreateUserSchema,
  deleteUser,
  getUserById,
  getUserByUsername,
  listUsers,
  ProfileUpdateSchema,
  toPublicUser,
  updateProfile,
  updateUser,
  UpdateUserSchema,
} from "./users.js";

const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const LOGIN_MAX_ATTEMPTS = 5;
const LOGIN_BLOCK_MS = 15 * 60 * 1000;

type LoginAttempt = { failures: number[]; blockedUntil: number };
const loginAttempts = new Map<string, LoginAttempt>();

function loginAttemptKey(req: { ip: string }, username: string): string {
  // Both values are only used as an in-memory throttle key, never for
  // authorization. Username is normalized to prevent trivial bypasses.
  return `${req.ip}:${username.trim().toLowerCase()}`;
}

function isLoginBlocked(key: string, now: number): boolean {
  const attempt = loginAttempts.get(key);
  if (!attempt) return false;
  if (attempt.blockedUntil > now) return true;
  attempt.failures = attempt.failures.filter((time) => time > now - LOGIN_WINDOW_MS);
  if (attempt.failures.length === 0) loginAttempts.delete(key);
  return false;
}

function registerFailedLogin(key: string, now: number): void {
  const attempt = loginAttempts.get(key) ?? { failures: [], blockedUntil: 0 };
  attempt.failures = attempt.failures.filter((time) => time > now - LOGIN_WINDOW_MS);
  attempt.failures.push(now);
  if (attempt.failures.length >= LOGIN_MAX_ATTEMPTS) {
    attempt.blockedUntil = now + LOGIN_BLOCK_MS;
    attempt.failures = [];
  }
  loginAttempts.set(key, attempt);
}

function clearFailedLogins(key: string): void {
  loginAttempts.delete(key);
}

export async function registerRoutes(app: FastifyInstance): Promise<void> {
  app.get("/api/health", async () => ({
    ok: true,
    name: "Vixel",
    version: "1.1.0",
  }));

  app.post("/api/auth/login", async (req, reply) => {
    const parsed = z
      .object({
        username: z.string().trim().min(1).max(64),
        password: z.string().min(1).max(128),
      })
      .safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "Enter a username and password" });
    }
    const body = parsed.data;
    const key = loginAttemptKey(req, body.username);
    const now = Date.now();
    if (isLoginBlocked(key, now)) {
      return reply.code(429).header("Retry-After", String(LOGIN_BLOCK_MS / 1000)).send({
        error: "Too many sign-in attempts. Try again later.",
      });
    }
    const user = authenticateUser(body.username, body.password);
    if (!user) {
      registerFailedLogin(key, now);
      systemLog("warn", "auth", "Failed login", { username: body.username, ip: req.ip });
      return reply.code(401).send({ error: "Invalid credentials" });
    }
    clearFailedLogins(key);
    const token = await reply.jwtSign({
      sub: user.username,
      role: user.role,
      uid: user.id,
    });
    audit(user.username, "auth.login");
    systemLog("info", "auth", `User signed in: ${user.username}`);
    return { token, user: toPublicUser(user) };
  });

  app.get("/api/me", { preHandler: [app.authenticate] }, async (req, reply) => {
    const user = getUserById(req.user.uid) ?? getUserByUsername(req.user.sub);
    if (!user || !user.active) {
      return reply.code(401).send({ error: "User inactive or missing" });
    }
    return { user: toPublicUser(user) };
  });

  app.patch("/api/me", { preHandler: [app.authenticate] }, async (req, reply) => {
    try {
      const input = ProfileUpdateSchema.parse(req.body);
      const user = updateProfile(req.user.uid, input);
      return toPublicUser(user);
    } catch (e) {
      return reply.code(400).send({ error: e instanceof Error ? e.message : "Bad request" });
    }
  });

  // —— Users (admin) ——
  app.get("/api/users", { preHandler: [app.requireRole("admin")] }, async () => ({
    users: listUsers().map(toPublicUser),
    roles: ["admin", "operator", "viewer"],
  }));

  app.post("/api/users", { preHandler: [app.requireRole("admin")] }, async (req, reply) => {
    try {
      const input = CreateUserSchema.parse(req.body);
      return toPublicUser(createUser(input, actorOf(req)));
    } catch (e) {
      return reply.code(400).send({ error: e instanceof Error ? e.message : "Bad request" });
    }
  });

  app.patch("/api/users/:id", { preHandler: [app.requireRole("admin")] }, async (req, reply) => {
    const { id } = req.params as { id: string };
    try {
      const input = UpdateUserSchema.parse(req.body);
      return toPublicUser(updateUser(id, input, actorOf(req)));
    } catch (e) {
      return reply.code(400).send({ error: e instanceof Error ? e.message : "Bad request" });
    }
  });

  app.delete("/api/users/:id", { preHandler: [app.requireRole("admin")] }, async (req, reply) => {
    const { id } = req.params as { id: string };
    if (id === req.user.uid) {
      return reply.code(400).send({ error: "Cannot delete your own account" });
    }
    try {
      deleteUser(id, actorOf(req));
      return { ok: true };
    } catch (e) {
      return reply.code(400).send({ error: e instanceof Error ? e.message : "Bad request" });
    }
  });

  // —— License ——
  app.get("/api/license", { preHandler: [app.requireRole("operator")] }, async () => {
    const installed = getInstalledLicense();
    return {
      installed: installed
        ? {
            valid: installed.valid,
            reason: installed.reason,
            installedAt: installed.installedAt,
            entitlements: installed.entitlements,
          }
        : null,
      effective: effectiveEntitlements(),
    };
  });

  app.post("/api/license", { preHandler: [app.requireRole("admin")] }, async (req, reply) => {
    const body = z.object({ license: z.string().min(20) }).parse(req.body);
    try {
      const installed = installLicense(body.license, actorOf(req));
      systemLog("info", "license", "License installed", {
        licenseId: installed.entitlements.licenseId,
      });
      return { ok: true, entitlements: installed.entitlements, valid: installed.valid };
    } catch (e) {
      return reply.code(400).send({ error: e instanceof Error ? e.message : "Invalid license" });
    }
  });

  // —— Cameras ——
  app.get("/api/cameras", { preHandler: [app.authenticate] }, async () => ({
    cameras: listCameras().map(toPublicCamera),
    limits: {
      used: listCameras().length,
      max: effectiveEntitlements().maxCameras,
    },
  }));

  app.get("/api/system/encoders", { preHandler: [app.authenticate] }, async () => ({
    available: await detectHardwareEncoders(),
    note: "Software encoders (libx265/libx264/libsvtav1) always work. Hardware encoders require a matching GPU/driver in the Vixel host or container.",
  }));

  app.post("/api/cameras", { preHandler: [app.requireRole("operator")] }, async (req, reply) => {
    try {
      const input = CameraInputSchema.parse(req.body);
      if (isHardwareCodec(input.codec)) {
        const available = await detectHardwareEncoders();
        if (!available.includes(input.codec)) {
          return reply.code(400).send({
            error: `Hardware encoder ${input.codec} is not available on this Vixel host. Available: ${available.join(", ") || "none"}.`,
          });
        }
      }
      const cam = createCamera(input, actorOf(req));
      if (cam.enabled) startCameraLoop(cam.id);
      systemLog("info", "cameras", `Camera added: ${cam.name}`);
      return toPublicCamera(cam);
    } catch (e) {
      return reply.code(400).send({ error: e instanceof Error ? e.message : "Bad request" });
    }
  });

  app.patch("/api/cameras/:id", { preHandler: [app.requireRole("operator")] }, async (req, reply) => {
    const { id } = req.params as { id: string };
    try {
      const input = CameraInputSchema.partial().parse(req.body);
      if (input.codec && isHardwareCodec(input.codec)) {
        const available = await detectHardwareEncoders();
        if (!available.includes(input.codec)) {
          return reply.code(400).send({
            error: `Hardware encoder ${input.codec} is not available on this Vixel host. Available: ${available.join(", ") || "none"}.`,
          });
        }
      }
      const cam = updateCamera(id, input, actorOf(req));
      stopCameraLoop(id);
      if (cam.enabled) startCameraLoop(id);
      return toPublicCamera(cam);
    } catch (e) {
      return reply.code(400).send({ error: e instanceof Error ? e.message : "Bad request" });
    }
  });

  app.delete("/api/cameras/:id", { preHandler: [app.requireRole("operator")] }, async (req) => {
    const { id } = req.params as { id: string };
    stopCameraLoop(id);
    deleteCamera(id, actorOf(req));
    systemLog("info", "cameras", `Camera deleted: ${id}`);
    return { ok: true };
  });

  app.get("/api/cameras/:id/streams", { preHandler: [app.authenticate] }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const cam = getCamera(id);
    if (!cam) return reply.code(404).send({ error: "Camera not found" });
    const s1 = resolveCameraStreamUrl(cam, "stream1");
    const s2 = resolveCameraStreamUrl(cam, "stream2");
    const s3 = resolveCameraStreamUrl(cam, "stream3");
    return {
      cameraId: cam.id,
      cameraName: cam.name,
      activeStream: cam.active_stream,
      streams: [
        {
          id: "stream1",
          label: STREAM_DESCRIPTIONS.stream1.label,
          resolution: STREAM_DESCRIPTIONS.stream1.resolution,
          url: s1.url,
          typicalBitrate: STREAM_DESCRIPTIONS.stream1.typicalBitrate,
          purpose: STREAM_DESCRIPTIONS.stream1.purpose,
          expectedSavings: "80% - 92%",
          fidelity: "Forensic (SSIM >= 0.965)",
        },
        {
          id: "stream2",
          label: STREAM_DESCRIPTIONS.stream2.label,
          resolution: STREAM_DESCRIPTIONS.stream2.resolution,
          url: s2.url,
          typicalBitrate: STREAM_DESCRIPTIONS.stream2.typicalBitrate,
          purpose: STREAM_DESCRIPTIONS.stream2.purpose,
          expectedSavings: "80% - 88%",
          fidelity: "High (SSIM >= 0.950)",
        },
        {
          id: "stream3",
          label: STREAM_DESCRIPTIONS.stream3.label,
          resolution: STREAM_DESCRIPTIONS.stream3.resolution,
          url: s3.url,
          typicalBitrate: STREAM_DESCRIPTIONS.stream3.typicalBitrate,
          purpose: STREAM_DESCRIPTIONS.stream3.purpose,
          expectedSavings: "82% - 94%",
          fidelity: "Edge Analytics (SSIM >= 0.930)",
        },
      ],
    };
  });

  app.post(
    "/api/cameras/:id/capture",
    { preHandler: [app.requireRole("operator")] },
    async (req, reply) => {
      const { id } = req.params as { id: string };
      const body = (req.body as { stream?: "stream1" | "stream2" | "stream3" }) || {};
      const targetStream = body.stream;
      const cam = getCamera(id);
      if (!cam) return reply.code(404).send({ error: "Camera not found" });
      try {
        const result = await compressSegment(cam, targetStream);
        return {
          recordingId: result.recordingId,
          outputPath: result.outputPath,
          bytesIn: result.bytesIn,
          bytesOut: result.bytesOut,
          compressionPercent: Math.round(result.ratio * 1000) / 10,
          profile: result.profile,
          strategy: result.strategy,
          formula: "savings = 1 - (bytes_out / bytes_in); bytes_in = camera bitstream (-c copy)",
          stream: result.stream,
          inputDuration: result.inputDuration,
          outputDuration: result.outputDuration,
          durationDelta: result.durationDelta,
          qualitySsim: result.qualitySsim,
          formula: "savings = 1 - (bytes_out / bytes_in); temporal reduction preserves source PTS (VFR)",
          target: "80%+ savings on suitable static/low-motion sources; actual savings are measured",
        };
      } catch (e) {
        const msg = e instanceof Error ? e.message : "Capture failed";
        systemLog("error", "compress", msg, { cameraId: id, stream: targetStream });
        createAlert("warning", "Capture failed", msg);
        return reply.code(500).send({ error: msg });
      }
    }
  );

  // —— Storage ——
  app.get("/api/storage", { preHandler: [app.authenticate] }, async () => ({
    targets: listStorageTargets().map(toPublicStorage),
    limits: {
      used: listStorageTargets().length,
      max: effectiveEntitlements().maxStorageTargets,
    },
  }));

  app.post("/api/storage", { preHandler: [app.requireRole("operator")] }, async (req, reply) => {
    try {
      const input = StorageInputSchema.parse(req.body);
      return toPublicStorage(createStorageTarget(input, actorOf(req)));
    } catch (e) {
      return reply.code(400).send({ error: e instanceof Error ? e.message : "Bad request" });
    }
  });

  app.delete("/api/storage/:id", { preHandler: [app.requireRole("admin")] }, async (req) => {
    const { id } = req.params as { id: string };
    deleteStorageTarget(id, actorOf(req));
    return { ok: true };
  });

  app.get("/api/recordings", { preHandler: [app.authenticate] }, async (req) => {
    const q = req.query as { limit?: string };
    const limit = Math.min(Number(q.limit ?? 50), 200);
    return { recordings: listRecordings(limit), activeJobs: getActiveJobs() };
  });

  app.get("/api/dashboard", { preHandler: [app.authenticate] }, async () => {
    const cams = listCameras();
    const recs = listRecordings(100);
    const activeJobs = getActiveJobs();
    const activeCameraIds = new Set(activeJobs.map((job) => job.cameraId));
    const latestByCamera = new Map<string, (typeof recs)[number]>();
    for (const recording of recs) {
      const cameraId = (recording as { camera_id: string }).camera_id;
      if (!latestByCamera.has(cameraId)) latestByCamera.set(cameraId, recording);
    }
    const uploaded = recs.filter((r) => (r as { status: string }).status === "uploaded").length;
    const failed = recs.filter((r) => (r as { status: string }).status === "failed").length;
    const ratios = recs
      .map((r) => (r as { compression_ratio: number | null }).compression_ratio)
      .filter((x): x is number => typeof x === "number");
    const avgRatio = ratios.length ? ratios.reduce((a, b) => a + b, 0) / ratios.length : 0;
    const openAlerts = listAlerts(false).length;
    return {
      cameras: { total: cams.length, enabled: cams.filter((c) => c.enabled).length },
      recordings: { recent: recs.length, uploaded, failed },
      compression: { averagePercent: Math.round(avgRatio * 1000) / 10 },
      license: effectiveEntitlements(),
      activeJobs,
      openAlerts,
      latestMetrics: getLatestSample(),
      host: getHostSnapshot(),
      cameraStatus: cams.map((camera) => {
        const latest = latestByCamera.get(camera.id) as
          | { status: string; started_at: string; finished_at: string | null; compression_ratio: number | null }
          | undefined;
        return {
          id: camera.id,
          name: camera.name,
          enabled: Boolean(camera.enabled),
          state: activeCameraIds.has(camera.id)
            ? "compressing"
            : camera.enabled
              ? "waiting"
              : "paused",
          lastActivityAt: latest?.finished_at ?? latest?.started_at ?? null,
          lastResult: latest?.status ?? null,
          compressionPercent:
            latest?.compression_ratio != null
              ? Math.round(latest.compression_ratio * 1000) / 10
              : null,
        };
      }),
    };
  });

  // —— Logs ——
  app.get("/api/logs", { preHandler: [app.authenticate] }, async (req) => {
    const q = req.query as { type?: string; limit?: string; level?: string; actor?: string };
    const limit = Math.min(Number(q.limit ?? 100), 500);
    if (q.type === "audit") {
      return { type: "audit", entries: listAuditLogs(limit, q.actor) };
    }
    return { type: "system", entries: listSystemLogs(limit, q.level) };
  });

  // —— Usage ——
  app.get("/api/usage", { preHandler: [app.authenticate] }, async () => getUsageSummary());

  // —— Performance / metrics ——
  app.get("/api/metrics", { preHandler: [app.authenticate] }, async (req) => {
    const q = req.query as { limit?: string };
    const limit = Math.min(Number(q.limit ?? 90), 180);
    return { samples: getRecentSamples(limit), latest: getLatestSample() };
  });

  app.get("/api/metrics/stream", { preHandler: [app.authenticate] }, async (req, reply) => {
    reply.hijack();
    reply.raw.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });
    const send = () => {
      const latest = getLatestSample();
      if (latest) {
        reply.raw.write(`data: ${JSON.stringify(latest)}\n\n`);
      }
    };
    send();
    const iv = setInterval(send, 2000);
    req.raw.on("close", () => {
      clearInterval(iv);
    });
  });

  // —— Alerts ——
  app.get("/api/alerts", { preHandler: [app.authenticate] }, async (req) => {
    const q = req.query as { open?: string };
    return { alerts: listAlerts(q.open !== "1") };
  });

  app.post("/api/alerts/:id/ack", { preHandler: [app.requireRole("operator")] }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const ok = acknowledgeAlert(id, actorOf(req));
    if (!ok) return reply.code(404).send({ error: "Alert not found or already acknowledged" });
    return { ok: true };
  });

  app.post("/api/alerts/test", { preHandler: [app.requireRole("admin")] }, async (req) => {
    createAlert("info", "Test alert", `Raised by ${actorOf(req)} at ${new Date().toISOString()}`);
    return { ok: true };
  });

  // —— Settings ——
  app.get("/api/settings", { preHandler: [app.requireRole("admin")] }, async () => ({
    settings: getSettings(),
    runtime: {
      host: config.host,
      port: config.port,
      dataDir: config.dataDir,
      recordingsDir: config.recordingsDir,
      version: "1.1.0",
    },
  }));

  app.put("/api/settings", { preHandler: [app.requireRole("admin")] }, async (req, reply) => {
    const body = z.record(z.string()).parse(req.body);
    const allowed = new Set([
      "retention_days",
      "alert_on_failure",
      "org_name",
      "timezone",
    ]);
    for (const [k, v] of Object.entries(body)) {
      if (!allowed.has(k)) {
        return reply.code(400).send({ error: `Setting not allowed: ${k}` });
      }
      setSetting(k, v);
    }
    audit(actorOf(req), "settings.update", body);
    return { settings: getSettings() };
  });

  app.post("/api/system/sync-loops", { preHandler: [app.requireRole("admin")] }, async () => {
    syncCameraLoops();
    systemLog("info", "system", "Camera loops synced");
    return { ok: true, active: getActiveJobs() };
  });

  app.get("/api/about", { preHandler: [app.authenticate] }, async () => ({
    name: "Vixel",
    version: "1.2.0",
    description:
      "Open, brand-agnostic IP camera compressor using Zipstream-inspired GoV / I-P-B / static decimation.",
    roles: [
      { id: "admin", description: "Full control: users, license, settings, all operations" },
      { id: "operator", description: "Manage cameras, storage, captures, acknowledge alerts" },
      { id: "viewer", description: "Read-only dashboards, usage, logs, and recordings" },
    ],
    compression: listStrategyDocs(),
  }));

  app.get("/api/compression/math", { preHandler: [app.authenticate] }, async () => ({
    title: "Vixel 80%+ Adaptive Compression Mathematical Architecture",
    theorems: [
      {
        name: "Rate-Distortion Optimization with Temporal Redundancy Saliency",
        formula: "R(D) = min_{p(\\hat{X}|X): E[d(X,\\hat{X})] <= D} I(X; \\hat{X})",
        explanation: "Surveillance footage has high temporal correlation where stationary background entropy H(X_t | X_{t-1}) approaches zero. Dropping redundant frames in static segments while preserving motion intervals reduces bitrate by >80% with minimal distortion D.",
      },
      {
        name: "Scene-Aware Temporal Filtering",
        formula: "S(t) = (1 / (W * H)) * sum_{x,y} |Y_t(x,y) - Y_{t-1}(x,y)|; Keep frame if S(t) > tau_motion or n mod k == 0",
        explanation: "Dynamic motion thresholding samples static frames at stride k (5-6) while retaining all frames during motion events. PTS timestamps are strictly preserved via VFR (Variable Frame Rate).",
      },
      {
        name: "Decoded Video Fidelity Invariant",
        formula: "Delta PTS = PTS_out - PTS_in = 0; Video Duration Delta <= 0.02 * Duration",
        explanation: "Because decoders hold previous frames during static intervals, the timeline matches the source exactly. Forensic detail (faces, license plates) occurs during motion where 100% of frames are coded with low CRF (26-30).",
      },
      {
        name: "Hierarchical Group of Video (GoV) with Psychovisual AQ",
        formula: "N_GOP = 300..360, B_frames = 8..10, AQ_mode = 3 (dark/shadow bias)",
        explanation: "Eliminates redundant intra-keyframes (which consume 10-20x the bits of B-frames) and redistributes quantization parameters to contrast-critical surveillance regions.",
      }
    ],
    predictions: {
      stream1: predictCompressionRatio("stream1", "extreme_80plus", 0.85, 4000),
      stream2: predictCompressionRatio("stream2", "extreme_80plus", 0.85, 1500),
      stream3: predictCompressionRatio("stream3", "extreme_80plus", 0.85, 384),
    },
    streamProfiles: STREAM_DESCRIPTIONS,
    profiles: listStrategyDocs(),
  }));

  app.get("/api/compression/strategies", { preHandler: [app.authenticate] }, async () => ({
    strategies: listStrategyDocs(),
    math: {
      savingsRatio: "1 - (bytes_out / bytes_in)",
      bytesIn: "Remuxed camera RTSP segment (-c copy) — vendor-agnostic baseline",
      bytesOut: "Re-encoded MP4 after GoV + P/B + mpdecimate + AQ",
      staticTarget: "≥80% on static / low-motion scenes with profile=zipstream",
    },
  }));
}
