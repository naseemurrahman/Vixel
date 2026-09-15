import { useEffect, useRef, useState } from "react";
import { api } from "../api";

type Metrics = { ts: string; cpuPct: number; memUsedMb: number; activeJobs: number; diskRecordingsMb: number; compressionPct: number; bytesOutRate: number };
type Dashboard = {
  cameras: { total: number; enabled: number };
  compression: { averagePercent: number };
  activeJobs: { cameraId: string; recordingId: string }[];
  latestMetrics: Metrics | null;
  host: { hostname: string; platform: string; architecture: string; cpuModel: string; cpuCores: number; memoryTotalMb: number; memoryFreeMb: number; uptimeSeconds: number };
  cameraStatus: { id: string; name: string; state: "compressing" | "waiting" | "paused"; lastActivityAt: string | null; lastResult: string | null; compressionPercent: number | null }[];
};

function formatRate(rate: number) { return rate >= 1 ? `${rate.toFixed(1)} MB/s` : `${(rate * 1024).toFixed(0)} KB/s`; }
function formatUptime(seconds: number) { const days = Math.floor(seconds / 86400); const hours = Math.floor((seconds % 86400) / 3600); const minutes = Math.floor((seconds % 3600) / 60); return days ? `${days}d ${hours}h` : `${hours}h ${minutes}m`; }

export function DashboardPage() {
  const [data, setData] = useState<Dashboard | null>(null);
  const [error, setError] = useState("");
  const [liveMetric, setLiveMetric] = useState<Metrics | null>(null);
  const [streamState, setStreamState] = useState<"connecting" | "live" | "offline">("connecting");
  const retryRef = useRef<number | null>(null);

  useEffect(() => {
    let alive = true;
    const load = () => api<Dashboard>("/api/dashboard").then((result) => alive && setData(result)).catch((reason) => alive && setError(reason.message));
    load();
    const interval = window.setInterval(load, 15000);
    return () => { alive = false; window.clearInterval(interval); };
  }, []);

  useEffect(() => {
    const token = localStorage.getItem("vixel_token");
    if (!token) return;
    const controller = new AbortController();
    const connect = async () => {
      try {
        setStreamState("connecting");
        const response = await fetch("/api/metrics/stream", { headers: { Authorization: `Bearer ${token}` }, signal: controller.signal });
        if (!response.ok || !response.body) throw new Error("Live metrics unavailable");
        setStreamState("live");
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";
        while (!controller.signal.aborted) {
          const { done, value } = await reader.read();
          if (done) throw new Error("Live metrics stream ended");
          buffer += decoder.decode(value, { stream: true });
          const events = buffer.split("\n\n");
          buffer = events.pop() ?? "";
          for (const event of events) {
            const line = event.split("\n").find((item) => item.startsWith("data: "));
            if (!line) continue;
            try { setLiveMetric(JSON.parse(line.slice(6)) as Metrics); } catch { /* wait for the next sample */ }
          }
        }
      } catch {
        if (controller.signal.aborted) return;
        setStreamState("offline");
        retryRef.current = window.setTimeout(connect, 5000);
      }
    };
    connect();
    return () => { controller.abort(); if (retryRef.current) window.clearTimeout(retryRef.current); };
  }, []);

  const metrics = liveMetric ?? data?.latestMetrics;
  return <>
    <h1>Operations</h1>
    <div className="page-heading"><p className="sub">Live server, camera, and compression status.</p><span className={`live-state ${streamState}`}>{streamState === "live" ? "Live" : streamState === "connecting" ? "Connecting" : "Reconnecting"}</span></div>
    {error ? <p className="error">{error}</p> : null}
    {!data ? <p className="sub loading-state">Loading operational data…</p> : null}
    {data ? <>
      <div className="metric-grid">
        <div className="stat"><div className="label">Cameras online</div><div className="value">{data.cameras.enabled}/{data.cameras.total}</div></div>
        <div className="stat"><div className="label">Compression</div><div className="value">{metrics?.compressionPct ?? data.compression.averagePercent}%</div></div>
        <div className="stat"><div className="label">Active encoders</div><div className="value">{metrics?.activeJobs ?? data.activeJobs.length}</div></div>
        <div className="stat"><div className="label">Host CPU</div><div className="value">{metrics?.cpuPct ?? 0}%</div></div>
        <div className="stat"><div className="label">Vixel memory</div><div className="value">{metrics?.memUsedMb ?? 0} MB</div></div>
      </div>
      <div className="panel live-summary">
        <div><span className="label">Current output rate</span><strong>{formatRate(metrics?.bytesOutRate ?? 0)}</strong></div>
        <div><span className="label">Compression status</span><strong>{(metrics?.activeJobs ?? data.activeJobs.length) > 0 ? `${metrics?.activeJobs ?? data.activeJobs.length} encoder active` : "Standing by"}</strong></div>
        <div><span className="label">Recording storage</span><strong>{metrics?.diskRecordingsMb ?? 0} MB</strong></div>
      </div>
      <section className="content-section">
        <div className="section-heading"><div><h2>Host server</h2><p>{data.host.hostname} · {data.host.platform}</p></div><span className="badge">{data.host.architecture}</span></div>
        <div className="host-grid">
          <div><span>Processor</span><strong>{data.host.cpuModel}</strong></div><div><span>CPU cores</span><strong>{data.host.cpuCores}</strong></div>
          <div><span>Host memory</span><strong>{data.host.memoryFreeMb.toLocaleString()} MB free of {data.host.memoryTotalMb.toLocaleString()} MB</strong></div><div><span>Host uptime</span><strong>{formatUptime(data.host.uptimeSeconds)}</strong></div>
        </div>
      </section>
      <section className="content-section">
        <div className="section-heading"><div><h2>Connected cameras</h2><p>State is reported from configured workers and actual recording history.</p></div></div>
        <div className="table-wrap"><table><thead><tr><th>Camera</th><th>State</th><th>Latest activity</th><th>Last result</th></tr></thead><tbody>
          {data.cameraStatus.map((camera) => <tr key={camera.id}><td><strong>{camera.name}</strong></td><td><span className={`badge ${camera.state === "compressing" ? "ok" : ""}`}>{camera.state}</span></td><td>{camera.lastActivityAt ? new Date(camera.lastActivityAt).toLocaleString() : "No recordings yet"}</td><td>{camera.compressionPercent != null ? `${camera.compressionPercent}% saved` : camera.lastResult ?? "—"}</td></tr>)}
          {!data.cameraStatus.length ? <tr><td colSpan={4} className="empty-state">No cameras configured.</td></tr> : null}
        </tbody></table></div>
      </section>
    </> : null}
  </>;
}
