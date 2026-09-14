# Vixel

Vixel is an open, vendor-neutral IP-camera recording compressor for Linux servers. It ingests RTSP streams from cameras of different brands and produces standards-based recordings with content-aware temporal and spatial compression.

The design target is **80%+ storage reduction on suitable static/low-motion scenes**, while measuring the actual result for every recording. It does not depend on Axis Zipstream or a proprietary camera API.

## Compression model

Vixel uses a layered model:

1. **Same-window baseline** — capture the camera bitstream with FFmpeg stream copy. This establishes `bytes_in` for the exact recording interval.
2. **Scene-aware temporal reduction** — quiet scenes are sampled less frequently; motion/scene changes retain the full cadence. The source presentation timestamps are preserved.
3. **Near-duplicate removal** — FFmpeg `mpdecimate` removes frames that are materially redundant.
4. **GoV / GOP optimization** — long keyframe intervals reduce expensive I-frames; scene cuts can still force an I-frame.
5. **I/P/B prediction** — adaptive B-frames and reference frames reuse spatial and temporal information.
6. **Adaptive quantization** — more bits are allocated where detail and motion matter.
7. **Standards-based output** — H.265, H.264, or AV1 can be selected.

### Storage-savings equation

```text
savings_ratio = 1 - (bytes_out / bytes_in)
savings_percent = savings_ratio × 100
```

The application records the measured result; it does not report an estimated percentage as if it were guaranteed.

### Why 80% is a target, not a promise

Compression is bounded by the source. If a camera is already using an efficient low-bitrate H.265 stream, another 80% reduction may require either lower visual quality or lower temporal resolution. Vixel therefore uses an adaptive strategy and exposes the real measured savings.

For static scenes, temporal redundancy is the strongest opportunity. For moving scenes, Vixel automatically preserves more frames and relies more heavily on inter-frame prediction and adaptive quantization.

## Timestamp correctness

A previous implementation used:

```text
setpts=N/FRAME_RATE/TB
```

after frame decimation. That is unsafe for surveillance because removing frames and then rebuilding timestamps from frame count can shorten the apparent recording.

Vixel now keeps the original PTS and writes the compressed video as **VFR**. A post-encode FFprobe check compares input and output duration and rejects materially shortened recordings.

## Profiles

| Profile | Purpose | Default GoV | B-frames | CRF | Static sampling |
|---|---|---:|---:|---:|---:|
| `zipstream` | Maximum storage efficiency | 300 | 8 | 30 | 1/5 + motion recovery |
| `balanced` | Mixed activity | 150 | 5 | 28 | 1/3 + motion recovery |
| `forensic` | Detail-first evidence | 60 | 3 | 24 | Full cadence |

The `zipstream` name means **Zipstream-inspired**, not Axis Zipstream. Vixel is an independent open implementation using FFmpeg primitives.

## Architecture

- **Server:** Node.js 20, TypeScript, Fastify, SQLite
- **Media:** FFmpeg + FFprobe
- **UI:** React + Vite
- **Deployment:** Linux/Docker
- **Storage:** local/NAS, S3/MinIO, SFTP
- **Input:** RTSP / RTSPS
- **Output:** MP4, H.265/H.264/AV1

See [the production architecture](PRODUCTION_ARCHITECTURE.md) for the edge
pipeline, mathematically defined compression constraints, storage/NVR delivery
semantics, and the safe role of optional AI inference.

## Linux deployment

Requirements:

- Linux host
- Docker Engine + Docker Compose
- Network access from the Vixel host/container to the camera VLAN
- FFmpeg/FFprobe are included in the production container

### Docker

```bash
cp .env.example .env
# Set a strong VIXEL_ADMIN_PASSWORD and VIXEL_JWT_SECRET.

docker compose up -d --build
```

Open:

```text
http://SERVER_IP:8080
```

The initial administrator is created only on the first start, so changing
`VIXEL_ADMIN_PASSWORD` later does not overwrite an existing account. If that
password is lost, reset it deliberately from the server host (this requires
access to the Docker host):

```bash
docker compose exec -T \
  -e VIXEL_RESET_ADMIN_PASSWORD='a-new-unique-password-at-least-16-characters' \
  vixel npm run admin:reset
```

Use a password manager to generate a unique value, then remove the temporary
environment variable from your shell history. This command only changes an
existing active administrator; it never creates an account or exposes a
password over the network.

For RTSP camera access on a Linux host, host networking is often the simplest option when Vixel must reach cameras across multiple VLANs/interfaces. If using bridge networking, publish the required ports and ensure the container has routes to the camera networks.

## Vercel dashboard deployment

Vercel can host the React dashboard, but it cannot run the Vixel recorder/API: the API uses SQLite-backed persistent state, FFmpeg, long-running camera processes, and access to the camera network. Those requirements need the Docker deployment above (or another persistent Linux host).

`vercel.json` therefore deploys only the dashboard and deliberately does not create a serverless function. Set `VITE_API_BASE_URL` in the Vercel project to the public HTTPS URL of the separately deployed Vixel API (for example, `https://vixel-api.example.com`). Configure `VIXEL_CORS_ORIGIN` on that API to the Vercel dashboard URL. Do not expose the API publicly without a VPN or authenticated reverse proxy.

## Local development

Requirements:

- Node.js 20+
- FFmpeg
- FFprobe

```bash
npm install
cp .env.example .env
npm run dev
```

API: `http://localhost:8080`

UI: `http://localhost:5173`

## Camera configuration

A camera can be configured with:

- RTSP/RTSPS URL
- Segment length
- Codec
- Encoder preset
- CRF
- Compression profile
- GoV/GOP size
- B-frame count
- Static-frame reduction
- Optional audio

The same compression engine is used regardless of camera vendor. Axis, Hikvision, Dahua, Uniview and other RTSP-capable cameras are treated as standards-based media sources rather than vendor-specific integrations.

## Operational safeguards

Vixel records:

- Input bytes
- Output bytes
- Measured compression percentage
- Input duration
- Output duration
- Duration delta
- Compression profile
- GoV/B-frame settings
- Compression errors

A segment is rejected when its output duration differs materially from the captured source duration.

## Roles

| Role | Access |
|---|---|
| **admin** | Users, license, settings, all operations |
| **operator** | Cameras, storage, capture, alerts |
| **viewer** | Read-only dashboards, usage, performance, logs, recordings |

## Storage targets

Supported targets include:

- Local filesystem
- NAS/local mounted storage
- S3-compatible storage such as MinIO
- SFTP

Compressed recordings can be uploaded after successful validation.

## Production security

Before production:

1. Change the default admin password.
2. Set a long random JWT secret.
3. Restrict CORS to the management UI origin instead of `*`.
4. Keep RTSP camera networks isolated from public networks.
5. Prefer RTSPS where supported.
6. Do not expose the Vixel management API directly to the Internet; place it behind a VPN or reverse proxy with TLS and access controls.
7. Back up the SQLite database and configuration.
8. Monitor CPU, disk, failed jobs and compression savings.

## Project layout

```text
server/
  src/
    cameras.ts
    compress.ts
    compression-strategy.ts
    routes.ts
    storage.ts
    metrics.ts
    users.ts
    license.ts

web/
  src/
    pages/

tools/
  license-gen/

Dockerfile
docker-compose.yml
```

## Roadmap

- Hardware-accelerated H.265/AV1 profiles for Intel, NVIDIA and AMD
- Per-camera adaptive CRF controller
- Motion/ROI maps for high-value regions
- Two-stage analysis mode for long static intervals
- Storage forecasting per camera/site
- Prometheus metrics
- Worker queues for enterprise deployments
- Optional object-aware ROI without requiring a camera vendor SDK
- Automated quality-regression tests using reference surveillance clips

## License

See the repository license and entitlement implementation for deployment-specific licensing.
