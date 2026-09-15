# Vixel deployment architecture

Vixel runs on a persistent Docker host on the same private network as the IP cameras. It is not a serverless workload.

```mermaid
flowchart LR
  cameras[IP cameras\nRTSP / RTSPS] -->|private LAN or camera VLAN| capture
  subgraph host[Local PC or on-premises server]
    subgraph docker[Docker]
      api[Fastify dashboard + API]
      capture[Capture worker\nFFmpeg stream copy]
      compress[Compression worker\nFFmpeg + FFprobe]
      db[(SQLite configuration\nand job metadata)]
      api --> db
      capture --> compress
    end
    staging[(Local SSD staging\n/raw + compressed segments/)]
    capture --> staging
    compress --> staging
  end
  staging -->|duration check + measured savings| archive
  archive[NAS or SAN mount\n/archive/camera-id/] 
  api -->|HTTPS or VPN only| operators[Operators]
```

## Recording path

1. The capture worker writes an RTSP segment to local staging storage.
2. The compression worker encodes a VFR MP4 and validates that its duration matches the source segment.
3. The upload step records measured input/output sizes, then copies the validated MP4 to every enabled target.
4. The local target writes to `/archive/<camera-id>/`. Docker bind-mounts `/archive` from `VIXEL_ARCHIVE_HOST_PATH` on the host.

Keep staging on a local SSD. Do not capture or transcode directly on NAS/SAN storage: a storage outage or network latency should not interrupt FFmpeg.

## NAS and SAN

Mount the storage on the Docker host first, then expose the mount to the container.

- **NAS:** mount SMB/NFS on the host and set `VIXEL_ARCHIVE_HOST_PATH` to that mounted directory.
- **SAN:** present it to the host as a block device, format/mount it, then use that mount as `VIXEL_ARCHIVE_HOST_PATH`.
- **S3/MinIO or SFTP:** configure those targets in Vixel instead of mounting them.

For Windows Docker Desktop, use a local directory that is backed by a host-mounted SMB share. Confirm Docker Desktop can access the directory before enabling cameras.

## Capacity and safety

- Reserve local staging capacity for at least two segments per concurrently active camera.
- Start with one concurrent compression job per available CPU core; H.265 and AV1 are CPU intensive.
- Treat 80% as a measured goal for static scenes, not a guarantee. Motion-heavy or already-efficient streams will save less.
- Keep RTSP inside the private network. Publish the dashboard only through a VPN or authenticated reverse proxy.
- Back up `/data` (SQLite configuration) separately from `/archive` (recordings).

## Hardware-accelerated encoding

Software x265/x264/AV1 at slow presets gives the best compression efficiency but
costs real CPU. Once a host runs more than a handful of concurrent camera jobs,
Vixel can offload encoding to a GPU:

| Path | Encoder(s) | Quality control | Notes |
|---|---|---|---|
| Intel Quick Sync | `hevc_qsv`, `h264_qsv` | `-global_quality` (ICQ) | Needs `/dev/dri` passed into the container |
| NVIDIA NVENC | `hevc_nvenc`, `h264_nvenc` | `-rc vbr -cq` | Needs the NVIDIA Container Toolkit |
| VAAPI (Intel iGPU / AMD) | `hevc_vaapi`, `h264_vaapi` | `-qp` | CPU-side filters run first, then `hwupload` moves frames to the device surface |

Vixel never assumes a GPU exists just because a codec name is selected. On
every camera create/update, and via `GET /api/system/encoders`, it probes
`ffmpeg -encoders` on the actual host/container and rejects a hardware codec
that isn't really available there — a bad camera config should fail at save
time, not three hours into an overnight recording loop. Scene-aware temporal
filtering (`select`/`mpdecimate`) is identical across software and hardware
paths; only the final encode stage differs.
