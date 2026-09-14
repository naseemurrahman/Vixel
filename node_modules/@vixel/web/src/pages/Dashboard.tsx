import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { api } from "../api";

type Dash = {
  cameras: { total: number; enabled: number };
  recordings: { recent: number; uploaded: number; failed: number };
  compression: { averagePercent: number };
  license: {
    customer: string;
    maxCameras: number;
    maxStorageTargets: number;
    maxConcurrentJobs: number;
    features: string[];
    licenseId: string;
  };
  activeJobs: { cameraId: string; recordingId: string }[];
  openAlerts: number;
  users: number;
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
      <p className="sub">Live overview — compression, jobs, alerts, and license.</p>
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
              <div className="label">Open alerts</div>
              <div className="value">{data.openAlerts}</div>
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

          <div className="panel">
            <h2>Quick actions</h2>
            <div className="row">
              <Link className="btn-link" to="/performance">
                Live performance
              </Link>
              <Link className="btn-link" to="/usage">
                Usage graphs
              </Link>
              <Link className="btn-link" to="/cameras">
                Cameras
              </Link>
              <Link className="btn-link" to="/alerts">
                Alerts
              </Link>
              <Link className="btn-link" to="/logs">
                Logs
              </Link>
            </div>
          </div>

          <div className="panel">
            <h2>License entitlements</h2>
            <p className="sub" style={{ marginBottom: "0.75rem" }}>
              {data.license.customer} · {data.license.licenseId} · {data.users} user(s)
            </p>
            <table>
              <tbody>
                <tr>
                  <td>Max cameras</td>
                  <td className="mono">{data.license.maxCameras}</td>
                </tr>
                <tr>
                  <td>Max storage targets</td>
                  <td className="mono">{data.license.maxStorageTargets}</td>
                </tr>
                <tr>
                  <td>Max concurrent jobs</td>
                  <td className="mono">{data.license.maxConcurrentJobs}</td>
                </tr>
                <tr>
                  <td>Features</td>
                  <td className="mono">{data.license.features.join(", ") || "—"}</td>
                </tr>
              </tbody>
            </table>
          </div>
        </>
      ) : (
        <p className="sub">Loading…</p>
      )}
    </>
  );
}
