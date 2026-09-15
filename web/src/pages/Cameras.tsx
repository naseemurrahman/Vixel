import { FormEvent, useEffect, useState } from "react";
import { api } from "../api";
import { useAuth } from "../auth";
import { roleAtLeast } from "../roles";

type Camera = {
  id: string;
  name: string;
  rtspUrl: string;
  enabled: boolean;
  segmentSeconds: number;
  crf: number;
  codec: string;
  preset: string;
  audio: boolean;
  compressionProfile: string;
  gopSize: number;
  bframes: number;
  mpdecimate: boolean;
  strategyHint?: string;
};
type Strategy = {
  id: string;
  description: string;
  expectedStaticSavings: string;
  defaultGop: number;
  defaultB: number;
  defaultCrf: number;
  staticFrameStride: number;
  motionThreshold: number;
};

export function CamerasPage() {
  const { user } = useAuth();
  const canEdit = roleAtLeast(user?.role, "operator");
  const [cameras, setCameras] = useState<Camera[]>([]);
  const [limits, setLimits] = useState({ used: 0, max: 1 });
  const [error, setError] = useState("");
  const [strategies, setStrategies] = useState<Strategy[]>([]);
  const [captureResult, setCaptureResult] = useState<{ profile: string; savings: number; bytesIn: number; bytesOut: number; durationDelta: number } | null>(null);
  const [form, setForm] = useState({
    name: "",
    rtspUrl: "rtsp://",
    segmentSeconds: 300,
    crf: 30,
    codec: "libx265",
    preset: "medium",
    audio: false,
    compressionProfile: "zipstream",
    gopSize: 300,
    bframes: 8,
    mpdecimate: true,
  });

  async function refresh() {
    const res = await api<{ cameras: Camera[]; limits: { used: number; max: number } }>(
      "/api/cameras"
    );
    setCameras(res.cameras);
    setLimits(res.limits);
  }

  const [hwEncoders, setHwEncoders] = useState<string[]>([]);

  useEffect(() => {
    refresh().catch((e) => setError(e.message));
    api<{ strategies: Strategy[] }>("/api/compression/strategies")
      .then((r) => setStrategies(r.strategies))
      .catch(() => setStrategies([]));
    api<{ available: string[] }>("/api/system/encoders")
      .then((r) => setHwEncoders(r.available))
      .catch(() => setHwEncoders([]));
  }, []);

  function onProfileChange(profile: string) {
    if (profile === "zipstream") {
      setForm((f) => ({
        ...f,
        compressionProfile: profile,
        crf: 30,
        gopSize: 300,
        bframes: 8,
        mpdecimate: true,
      }));
    } else if (profile === "balanced") {
      setForm((f) => ({
        ...f,
        compressionProfile: profile,
        crf: 28,
        gopSize: 120,
        bframes: 4,
        mpdecimate: true,
      }));
    } else {
      setForm((f) => ({
        ...f,
        compressionProfile: profile,
        crf: 24,
        gopSize: 60,
        bframes: 3,
        mpdecimate: false,
      }));
    }
  }

  async function onCreate(e: FormEvent) {
    e.preventDefault();
    setError("");
    try {
      await api("/api/cameras", { method: "POST", body: JSON.stringify({ ...form, enabled: true }) });
      setForm((f) => ({ ...f, name: "", rtspUrl: "rtsp://" }));
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed");
    }
  }

  async function toggle(cam: Camera) {
    await api(`/api/cameras/${cam.id}`, {
      method: "PATCH",
      body: JSON.stringify({ enabled: !cam.enabled }),
    });
    await refresh();
  }

  async function captureOnce(id: string) {
    setError("");
    try {
      const res = await api<{
        compressionPercent: number;
        bytesIn: number;
        bytesOut: number;
        profile: string;
        durationDelta: number;
      }>(`/api/cameras/${id}/capture`, { method: "POST" });
      setCaptureResult({
        profile: res.profile,
        savings: res.compressionPercent,
        bytesIn: res.bytesIn,
        bytesOut: res.bytesOut,
        durationDelta: res.durationDelta,
      });
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Capture failed");
    }
  }

  async function remove(id: string) {
    if (!confirm("Delete this camera?")) return;
    await api(`/api/cameras/${id}`, { method: "DELETE" });
    await refresh();
  }

  return (
    <>
      <h1>Cameras</h1>
      <p className="sub">
        Any RTSP brand · Zipstream-class GoV / I-P-B compression · licensed {limits.used}/
        {limits.max}
      </p>
      {error ? <p className="error">{error}</p> : null}

      {canEdit ? (
        <div className="panel">
          <h2>Add camera</h2>
          <form onSubmit={onCreate}>
            <div className="row">
              <label>
                Name
                <input
                  required
                  value={form.name}
                  onChange={(e) => setForm({ ...form, name: e.target.value })}
                />
              </label>
              <label style={{ flex: 2 }}>
                RTSP URL
                <input
                  required
                  value={form.rtspUrl}
                  onChange={(e) => setForm({ ...form, rtspUrl: e.target.value })}
                  placeholder="rtsp://user:pass@192.168.1.10:554/stream1"
                />
              </label>
            </div>
            <div className="row">
              <label>
                Compression profile
                <select
                  value={form.compressionProfile}
                  onChange={(e) => onProfileChange(e.target.value)}
                >
                  <option value="zipstream">Zipstream (static ≥80%)</option>
                  <option value="balanced">Balanced</option>
                  <option value="forensic">Forensic (more detail)</option>
                </select>
              </label>
              <label>
                Segment (s)
                <input
                  type="number"
                  min={30}
                  max={3600}
                  value={form.segmentSeconds}
                  onChange={(e) => setForm({ ...form, segmentSeconds: Number(e.target.value) })}
                />
              </label>
              <label>
                GoV / GOP
                <input
                  type="number"
                  min={15}
                  max={600}
                  value={form.gopSize}
                  onChange={(e) => setForm({ ...form, gopSize: Number(e.target.value) })}
                />
              </label>
              <label>
                B-frames
                <input
                  type="number"
                  min={0}
                  max={16}
                  value={form.bframes}
                  onChange={(e) => setForm({ ...form, bframes: Number(e.target.value) })}
                />
              </label>
              <label>
                CRF
                <input
                  type="number"
                  min={18}
                  max={40}
                  value={form.crf}
                  onChange={(e) => setForm({ ...form, crf: Number(e.target.value) })}
                />
              </label>
              <label>
                Codec
                <select
                  value={form.codec}
                  onChange={(e) => setForm({ ...form, codec: e.target.value })}
                >
                  <option value="libx265">H.265 (software)</option>
                  <option value="libx264">H.264 (software)</option>
                  <option value="libsvtav1">AV1 (software)</option>
                  {hwEncoders.includes("hevc_qsv") && <option value="hevc_qsv">H.265 (Intel Quick Sync)</option>}
                  {hwEncoders.includes("h264_qsv") && <option value="h264_qsv">H.264 (Intel Quick Sync)</option>}
                  {hwEncoders.includes("hevc_nvenc") && <option value="hevc_nvenc">H.265 (NVIDIA NVENC)</option>}
                  {hwEncoders.includes("h264_nvenc") && <option value="h264_nvenc">H.264 (NVIDIA NVENC)</option>}
                  {hwEncoders.includes("hevc_vaapi") && <option value="hevc_vaapi">H.265 (VAAPI)</option>}
                  {hwEncoders.includes("h264_vaapi") && <option value="h264_vaapi">H.264 (VAAPI)</option>}
                </select>
              </label>
              <label>
                Static decimate
                <select
                  value={form.mpdecimate ? "1" : "0"}
                  onChange={(e) => setForm({ ...form, mpdecimate: e.target.value === "1" })}
                >
                  <option value="1">On (Zipstream temporal)</option>
                  <option value="0">Off</option>
                </select>
              </label>
              <button type="submit">Add</button>
            </div>
          </form>
          <p className="sub" style={{ marginTop: "0.75rem", marginBottom: 0 }}>
            Open model: long GoV (few I-frames when still), adaptive P/B predictors, mpdecimate for
            static frames, AQ for spatial bits. Measured as{" "}
            <span className="mono">1 − out/in</span> against the camera&apos;s own bitstream.
          </p>
        </div>
      ) : null}

      {captureResult ? (
        <div className="panel">
          <h2>Last compression result</h2>
          <div className="grid">
            <div className="stat"><div className="label">Measured savings</div><div className="value">{captureResult.savings}%</div></div>
            <div className="stat"><div className="label">Input</div><div className="value">{(captureResult.bytesIn / 1e6).toFixed(1)} MB</div></div>
            <div className="stat"><div className="label">Output</div><div className="value">{(captureResult.bytesOut / 1e6).toFixed(1)} MB</div></div>
            <div className="stat"><div className="label">Duration delta</div><div className="value">{captureResult.durationDelta.toFixed(2)} s</div></div>
          </div>
          <p className="sub">Measured using 1 − (output bytes / input bytes). Original timestamps are retained; duration is checked after encoding.</p>
        </div>
      ) : null}

      {strategies.length ? (
        <div className="panel">
          <h2>Adaptive compression engine</h2>
          <p className="sub">Vendor-neutral strategy. Static scenes are sampled more aggressively; motion retains temporal detail.</p>
          <table>
            <thead><tr><th>Profile</th><th>Target</th><th>GoV</th><th>B</th><th>Static stride</th><th>Scene threshold</th></tr></thead>
            <tbody>
              {strategies.map((s) => (
                <tr key={s.id}>
                  <td><strong>{s.id}</strong><div className="sub">{s.description}</div></td>
                  <td>{s.expectedStaticSavings}</td>
                  <td className="mono">{s.defaultGop}</td>
                  <td className="mono">{s.defaultB}</td>
                  <td className="mono">1/{s.staticFrameStride}</td>
                  <td className="mono">{s.motionThreshold}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}

      <div className="panel">
        <h2>Configured</h2>
        <table>
          <thead>
            <tr>
              <th>Name</th>
              <th>URL</th>
              <th>Strategy</th>
              <th>Status</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {cameras.map((c) => (
              <tr key={c.id}>
                <td>{c.name}</td>
                <td className="mono">{c.rtspUrl}</td>
                <td className="mono">
                  {c.compressionProfile || "zipstream"} · GoV {c.gopSize ?? "—"} · B
                  {c.bframes ?? "—"} · CRF {c.crf}
                  {c.strategyHint ? <div className="sub">{c.strategyHint}</div> : null}
                </td>
                <td>
                  <span className={`badge ${c.enabled ? "ok" : ""}`}>
                    {c.enabled ? "recording" : "paused"}
                  </span>
                </td>
                <td>
                  {canEdit ? (
                    <div className="row" style={{ justifyContent: "flex-end" }}>
                      <button type="button" className="secondary" onClick={() => toggle(c)}>
                        {c.enabled ? "Pause" : "Start"}
                      </button>
                      <button type="button" className="secondary" onClick={() => captureOnce(c.id)}>
                        Capture once
                      </button>
                      <button type="button" className="danger" onClick={() => remove(c.id)}>
                        Delete
                      </button>
                    </div>
                  ) : (
                    <span className="sub">read-only</span>
                  )}
                </td>
              </tr>
            ))}
            {!cameras.length ? (
              <tr>
                <td colSpan={5} className="sub">
                  No cameras yet — any RTSP camera works (Axis, Hikvision, Dahua, …).
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </div>
    </>
  );
}
