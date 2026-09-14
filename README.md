# Vixel

Secure, lightweight server app that records from IP cameras (RTSP), compresses segments with standards-compliant H.265 / H.264 / AV1 (typically **80%+** size reduction at CRF 28), and uploads to configurable storage (local/NAS, S3/MinIO, SFTP).

Licensing is **entitlement-based**, not fixed SKUs: any camera count, storage-target limit, concurrency, feature flags, and expiry can be signed into a key.

## Stack

- **Server**: Node.js 20 + Fastify + SQLite
- **UI**: React (Vite)
- **Media**: FFmpeg (TCP RTSP ingest → MP4)
- **Deploy**: Docker (Linux servers & Windows via Docker Desktop)

## Quick start (Docker)

```bash
# Linux or Windows (Docker Desktop)
cp .env.example .env
# edit VIXEL_ADMIN_PASSWORD and VIXEL_JWT_SECRET

docker compose up -d --build
```

Open http://localhost:8080 — default login `admin` / `changeme`.

Cameras must be reachable from the container (same LAN / VPN). On Linux you can uncomment `network_mode: host` in `docker-compose.yml` for simplest RTSP access.

## Local development

Requirements: Node 20+, FFmpeg on PATH.

```bash
npm install
cp .env.example .env
npm run dev
```

- API: http://localhost:8080  
- UI (Vite): http://localhost:5173  

## Flexible licenses

Generate a keypair (once per deployment / product line):

```bash
npm run license:gen -- --gen-keypair ./keys/vixel
```

Put the **public** key in `VIXEL_LICENSE_PUBLIC_KEY` (PEM; use `\n` for newlines in `.env`).

Issue any entitlement mix:

```bash
npm run license:gen -- \
  --private-key ./keys/vixel.priv.pem \
  --customer "North Site" \
  --max-cameras 47 \
  --max-storage 5 \
  --max-jobs 8 \
  --features local-storage,s3,sftp,api \
  --days 365 \
  --notes "Custom site pack"
```

Paste the `VIXEL1....` string in **License** in the UI.

Unlicensed evaluation mode allows **1 camera**. Dev mode (no public key set) auto-installs a generous local license.

### Entitlement fields

| Field | Meaning |
|-------|---------|
| `maxCameras` | Hard cap on configured cameras |
| `maxStorageTargets` | Cap on upload destinations |
| `maxConcurrentJobs` | Parallel FFmpeg jobs |
| `features` | `local-storage`, `s3`, `sftp`, `api`, or `*` |
| `expiresAt` | ISO date or null |

## Roles

| Role | Access |
|------|--------|
| **admin** | Users, license install, settings, full operations |
| **operator** | Cameras, storage, capture, acknowledge alerts, view license |
| **viewer** | Dashboards, usage, performance, logs, recordings (read-only) |

Default admin is created from `VIXEL_ADMIN_USER` / `VIXEL_ADMIN_PASSWORD` on first boot.

## UI pages

Dashboard · Performance (live charts) · Usage · Alerts · Logs · Cameras · Storage · Recordings · Profile · Users · License · Settings · Help


- Change admin password and JWT secret before production.
- Prefer RTSP over trusted networks / VLAN; store credentials only in server DB.
- License files are ECDSA P-256 signed; keep the private key offline.
- API routes (except health + login) require JWT Bearer auth.

## Compression (Zipstream-inspired, open)

Works with **any RTSP camera brand**. Pipeline:

1. Capture camera bitstream (`ffmpeg -c copy`) → **bytes_in**
2. Re-encode with open Zipstream-class tools:
   - **GoV / GOP** — long gap between I-frames when still; scenecut inserts I on motion
   - **P/B frames** — adaptive B-frames + refs reuse static background
   - **mpdecimate** — drop near-duplicate frames in static scenes
   - **AQ mode 3** — spend bits on motion/texture, not flat walls
3. **Savings** = `1 - bytes_out / bytes_in` (measured, not estimated)

Profiles: `zipstream` (default, ≥80% on static), `balanced`, `forensic`.

Output is standards **MP4** (H.265/H.264/AV1) so any player can decode it. After each segment, Vixel uploads to all enabled storage targets.

## Project layout

```
server/     API, license, cameras, FFmpeg worker, storage adapters
web/        Admin UI
tools/license-gen/   Entitlement signing CLI
Dockerfile / docker-compose.yml
```
