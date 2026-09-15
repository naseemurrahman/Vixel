import path from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";

dotenv.config({ path: path.resolve(process.cwd(), ".env") });
dotenv.config({ path: path.resolve(process.cwd(), "../.env") });

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "../..");

function env(name: string, fallback?: string): string {
  const v = process.env[name] ?? fallback;
  if (v === undefined || v.trim() === "") throw new Error(`Missing env ${name}`);
  return v;
}

function requiredRuntimeValue(name: string): string {
  if (process.env.NODE_ENV === "test" || !process.env[name]) {
    if (process.env.NODE_ENV === "test") {
      return process.env[name]?.trim() || "test_dummy_secret_value_at_least_32_characters_long";
    }
  }
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Missing required runtime value ${name}`);
  if (value.length < 32) throw new Error(`${name} must be at least 32 characters`);
  return value;
}

export const config = {
  host: env("VIXEL_HOST", "0.0.0.0"),
  port: Number(env("VIXEL_PORT", "8080")),
  dataDir: path.resolve(root, env("VIXEL_DATA_DIR", "./data")),
  recordingsDir: path.resolve(root, env("VIXEL_RECORDINGS_DIR", "./recordings")),
  archiveDir: path.resolve(root, env("VIXEL_ARCHIVE_DIR", "./recordings/archive")),
  jwtSecret: requiredRuntimeValue("VIXEL_JWT_SECRET"),
  adminUser: env("VIXEL_ADMIN_USER", "admin"),
  adminPassword: requiredRuntimeValue("VIXEL_ADMIN_PASSWORD"),
  corsOrigin: env("VIXEL_CORS_ORIGIN", "http://localhost:5173"),
  licensePublicKeyPem: process.env.VIXEL_LICENSE_PUBLIC_KEY?.replace(/\\n/g, "\n") ?? "",
  webDist: path.resolve(root, "web/dist"),
  ffmpegPath: env("VIXEL_FFMPEG_PATH", "ffmpeg"),
  ffprobePath: env("VIXEL_FFPROBE_PATH", "ffprobe"),
};
