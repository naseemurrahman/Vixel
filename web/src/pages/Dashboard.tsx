import { useEffect, useState } from "react";
import { api } from "../api";

type Dash = {
  cameras: { total: number; enabled: number };
  recordings: { recent: number; uploaded: number; failed: number };
  compression: { averagePercent: number };
  activeJobs: { cameraId: string; recordingId: string }[];
  openAlerts: number;
  latestMetrics: {
    cpuPct: number;
    memUsedMb: number;
    activeJobs: number;
    diskRecordingsMb: number;
  } | null;
};

export function DashboardPage() {
  const [data, setData] = useState<Dash | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    let alive = true;
    const load = () =>
      api<Dash>("/api/dashboard")
        .then((d) => alive && setData(d))
        .catch((e) => alive && setError(e.message));
    load();
    const t = setInterval(load, 5000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, []);

  return (
    <>
      <h1>Dashboard</h1>
      <p className="sub">A concise live view of your recording system.</p>
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
              <div className="label">Avg compression</div>
              <div className="value">{data.compression.averagePercent}%</div>
            </div>
            <div className="stat">
              <div className="label">Active jobs</div>
              <div className="value">{data.activeJobs.length}</div>
            </div>
            <div className="stat">
              <div className="label">CPU</div>
              <div className="value">{data.latestMetrics?.cpuPct ?? 0}%</div>
            </div>
            <div className="stat">
              <div className="label">Heap</div>
              <div className="value">{data.latestMetrics?.memUsedMb ?? 0} MB</div>
            </div>
          </div>

        </>
      ) : (
        <p className="sub">Loading…</p>
      )}
    </>
  );
}
