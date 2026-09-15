import path from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";

dotenv.config({ path: path.resolve(process.cwd(), ".env") });
dotenv.config({ path: path.resolve(process.cwd(), "../.env") });

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "../..");

function env(name: string, fallback?: string): string {
  const v = process.env[name] ?? fallback;
  if (v === undefined) throw new Error(`Missing env ${name}`);
  return v;
}

export const config = {
  host: env("VIXEL_HOST", "0.0.0.0"),
  port: Number(env("VIXEL_PORT", "8080")),
  dataDir: path.resolve(root, env("VIXEL_DATA_DIR", "./data")),
  recordingsDir: path.resolve(root, env("VIXEL_RECORDINGS_DIR", "./recordings")),
  jwtSecret: env("VIXEL_JWT_SECRET", "dev-only-change-me"),
  adminUser: env("VIXEL_ADMIN_USER", "admin"),
  adminPassword: env("VIXEL_ADMIN_PASSWORD", "changeme"),
  corsOrigin: env("VIXEL_CORS_ORIGIN", "http://localhost:5173"),
  licensePublicKeyPem: process.env.VIXEL_LICENSE_PUBLIC_KEY?.replace(/\\n/g, "\n") ?? "",
  webDist: path.resolve(root, "web/dist"),
  ffmpegPath: env("VIXEL_FFMPEG_PATH", "ffmpeg"),
  ffprobePath: env("VIXEL_FFPROBE_PATH", "ffprobe"),
};
