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
} from "./cameras.js";
import {
  compressSegment,
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
import { listStrategyDocs } from "./compression-strategy.js";
import {
  effectiveEntitlements,
  getInstalledLicense,
  installLicense,
} from "./license.js";
import {
  getLatestSample,
  getRecentSamples,
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

export async function registerRoutes(app: FastifyInstance): Promise<void> {
  app.get("/api/health", async () => ({
    ok: true,
    name: "Vixel",
    version: "1.1.0",
  }));

  app.post("/api/auth/login", async (req, reply) => {
    const body = z
      .object({ username: z.string(), password: z.string() })
      .parse(req.body);
    const user = authenticateUser(body.username, body.password);
    if (!user) {
      systemLog("warn", "auth", "Failed login", { username: body.username });
      return reply.code(401).send({ error: "Invalid credentials" });
    }
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

  app.post("/api/cameras", { preHandler: [app.requireRole("operator")] }, async (req, reply) => {
    try {
      const input = CameraInputSchema.parse(req.body);
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

  app.post(
    "/api/cameras/:id/capture",
    { preHandler: [app.requireRole("operator")] },
    async (req, reply) => {
      const { id } = req.params as { id: string };
      const cam = getCamera(id);
      if (!cam) return reply.code(404).send({ error: "Camera not found" });
      try {
        const result = await compressSegment(cam);
        return {
          recordingId: result.recordingId,
          outputPath: result.outputPath,
          bytesIn: result.bytesIn,
          bytesOut: result.bytesOut,
          compressionPercent: Math.round(result.ratio * 1000) / 10,
          profile: result.profile,
          strategy: result.strategy,
          formula: "savings = 1 - (bytes_out / bytes_in); bytes_in = camera bitstream (-c copy)",
        };
      } catch (e) {
        const msg = e instanceof Error ? e.message : "Capture failed";
        systemLog("error", "compress", msg, { cameraId: id });
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
      activeJobs: getActiveJobs(),
      openAlerts,
      latestMetrics: getLatestSample(),
      users: listUsers().length,
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
