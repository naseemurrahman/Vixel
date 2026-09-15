import { useEffect, useRef, useState } from "react";
import { api } from "../api";

type Dash = {
  cameras: { total: number; enabled: number };
  recordings: { recent: number; uploaded: number; failed: number };
  compression: { averagePercent: number };
  activeJobs: { cameraId: string; recordingId: string }[];
  openAlerts: number;
  latestMetrics: {
    ts: string;
    cpuPct: number;
    memUsedMb: number;
    activeJobs: number;
    diskRecordingsMb: number;
    compressionPct: number;
    bytesOutRate: number;
  } | null;
};

function formatRate(mbPerSecond: number) {
  return mbPerSecond >= 1 ? `${mbPerSecond.toFixed(1)} MB/s` : `${(mbPerSecond * 1024).toFixed(0)} KB/s`;
}

export function DashboardPage() {
  const [data, setData] = useState<Dash | null>(null);
  const [error, setError] = useState("");
  const [liveMetric, setLiveMetric] = useState<Dash["latestMetrics"]>(null);
  const [streamState, setStreamState] = useState<"connecting" | "live" | "offline">("connecting");
  const retryRef = useRef<number | null>(null);

  useEffect(() => {
    let alive = true;
    const load = () =>
      api<Dash>("/api/dashboard")
        .then((d) => alive && setData(d))
        .catch((e) => alive && setError(e.message));
    load();
    const t = setInterval(load, 15000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, []);

  useEffect(() => {
    const token = localStorage.getItem("vixel_token");
    if (!token) return;
    const controller = new AbortController();
    const connect = async () => {
      try {
        setStreamState("connecting");
        const response = await fetch("/api/metrics/stream", {
          headers: { Authorization: `Bearer ${token}` },
          signal: controller.signal,
        });
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
            if (line) setLiveMetric(JSON.parse(line.slice(6)) as Dash["latestMetrics"]);
          }
        }
      } catch {
        if (controller.signal.aborted) return;
        setStreamState("offline");
        retryRef.current = window.setTimeout(connect, 5000);
      }
    };
    connect();
    return () => {
      controller.abort();
      if (retryRef.current) window.clearTimeout(retryRef.current);
    };
  }, []);

  const metrics = liveMetric ?? data?.latestMetrics;

  return (
    <>
      <h1>Dashboard</h1>
      <div className="page-heading">
        <p className="sub">Live status for recording, compression, and host resources.</p>
        <span className={`live-state ${streamState}`}>{streamState === "live" ? "Live" : streamState === "connecting" ? "Connecting" : "Reconnecting"}</span>
      </div>
      {error ? <p className="error">{error}</p> : null}
      {data ? (
        <>
          <div className="grid">
            <div className="stat">
              <div className="label">Cameras</div>
              <div className="value">
                {data.cameras.enabled}/{data.cameras.total}
              </div>
            </div>
            <div className="stat">
              <div className="label">Compression</div>
              <div className="value">{metrics?.compressionPct ?? data.compression.averagePercent}%</div>
            </div>
            <div className="stat">
              <div className="label">Active jobs</div>
              <div className="value">{data.activeJobs.length}</div>
            </div>
            <div className="stat">
              <div className="label">Host CPU</div>
              <div className="value">{metrics?.cpuPct ?? 0}%</div>
            </div>
            <div className="stat">
              <div className="label">Memory</div>
              <div className="value">{metrics?.memUsedMb ?? 0} MB</div>
            </div>
          </div>

          <div className="panel live-summary">
            <div>
              <span className="label">Current output rate</span>
              <strong>{formatRate(metrics?.bytesOutRate ?? 0)}</strong>
            </div>
            <div>
              <span className="label">Compression status</span>
              <strong>{(metrics?.activeJobs ?? data.activeJobs.length) > 0 ? `${metrics?.activeJobs ?? data.activeJobs.length} encoder active` : "Standing by"}</strong>
            </div>
            <div>
              <span className="label">Recording storage</span>
              <strong>{metrics?.diskRecordingsMb ?? 0} MB</strong>
            </div>
          </div>

        </>
      ) : (
        <p className="sub">Loading…</p>
      )}
    </>
  );
}
