import fs from "node:fs";
import Fastify from "fastify";
import cors from "@fastify/cors";
import fastifyStatic from "@fastify/static";
import { registerAuth } from "./auth.js";
import { config } from "./config.js";
import { syncCameraLoops } from "./compress.js";
import { ensureDevLicense } from "./license.js";
import { systemLog } from "./logs.js";
import { startMetricsCollector } from "./metrics.js";
import { registerRoutes } from "./routes.js";
import { ensureDefaultLocalStorage } from "./storage.js";
import { ensureCameraColumns } from "./cameras.js";
import { ensureAdminUser, ensureUsersSchema } from "./users.js";
import "./db.js";

async function main() {
  ensureUsersSchema();
  ensureCameraColumns();
  ensureAdminUser();
  ensureDevLicense();
  ensureDefaultLocalStorage();
  startMetricsCollector(2000);
  systemLog("info", "system", "Vixel starting");

  const app = Fastify({
    logger: true,
    // Do not trust client-supplied X-Forwarded-* headers by default. Set a
    // specific trusted reverse-proxy address here if the API is later placed
    // behind one.
    trustProxy: false,
  });

  await app.register(cors, {
    origin: config.corsOrigin === "*" ? true : config.corsOrigin,
    credentials: true,
  });

  await registerAuth(app);
  await registerRoutes(app);

  if (fs.existsSync(config.webDist)) {
    await app.register(fastifyStatic, {
      root: config.webDist,
      prefix: "/",
    });
    app.setNotFoundHandler((req, reply) => {
      if (req.url.startsWith("/api/")) {
        return reply.code(404).send({ error: "Not found" });
      }
      return reply.sendFile("index.html");
    });
  }

  syncCameraLoops();

  await app.listen({ host: config.host, port: config.port });
  systemLog("info", "system", `Listening on http://${config.host}:${config.port}`);
  console.log(`Vixel listening on http://${config.host}:${config.port}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
