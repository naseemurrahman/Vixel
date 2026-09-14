import { useEffect, useState } from "react";
import {
  Bar,
  BarChart,
  CartesianGrid,
  Legend,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { api } from "../api";

type Usage = {
  cameras: { total: number; enabled: number };
  recordings: {
    total: number;
    uploaded: number;
    failed: number;
    bytesIn: number;
    bytesOut: number;
    savedBytes: number;
    avgCompressionPct: number;
  };
  disk: { recordingsMb: number; hostFreeMb: number; hostTotalMb: number };
  byDay: { day: string; recordings: number; bytesOut: number; avgRatio: number | null }[];
  byCamera: { camera: string; recordings: number; bytesOut: number; avgRatio: number | null }[];
  uploads: { status: string; c: number }[];
};

function mb(n: number) {
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

export function UsagePage() {
  const [data, setData] = useState<Usage | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    let alive = true;
    const load = () =>
      api<Usage>("/api/usage")
        .then((d) => alive && setData(d))
        .catch((e) => alive && setError(e.message));
    load();
    const t = setInterval(load, 8000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, []);

  const dayChart =
    data?.byDay.map((d) => ({
      day: d.day.slice(5),
      recordings: d.recordings,
      outMb: Math.round((d.bytesOut / (1024 * 1024)) * 10) / 10,
      compression: d.avgRatio != null ? Math.round(d.avgRatio * 1000) / 10 : 0,
    })) ?? [];

  const camChart =
    data?.byCamera.map((c) => ({
      camera: c.camera,
      outMb: Math.round((c.bytesOut / (1024 * 1024)) * 10) / 10,
      recordings: c.recordings,
    })) ?? [];

  return (
    <>
      <h1>Usage</h1>
      <p className="sub">Storage savings, volume by day, and per-camera output.</p>
      {error ? <p className="error">{error}</p> : null}
      {data ? (
        <>
          <div className="grid">
            <div className="stat">
              <div className="label">Bytes saved</div>
              <div className="value">{mb(data.recordings.savedBytes)}</div>
            </div>
            <div className="stat">
              <div className="label">Avg compression</div>
              <div className="value">{data.recordings.avgCompressionPct}%</div>
            </div>
            <div className="stat">
              <div className="label">Recordings on disk</div>
              <div className="value">{data.disk.recordingsMb} MB</div>
            </div>
            <div className="stat">
              <div className="label">Host free RAM</div>
              <div className="value">{data.disk.hostFreeMb} MB</div>
            </div>
          </div>

          <div className="panel">
            <h2>Output volume (14 days)</h2>
            <div className="chart-box">
              <ResponsiveContainer width="100%" height={260}>
                <LineChart data={dayChart}>
                  <CartesianGrid stroke="var(--line)" strokeDasharray="3 3" />
                  <XAxis dataKey="day" stroke="var(--muted)" />
                  <YAxis stroke="var(--muted)" />
                  <Tooltip
                    contentStyle={{ background: "#121a17", border: "1px solid #2a3b34" }}
                  />
                  <Legend />
                  <Line type="monotone" dataKey="outMb" name="Output MB" stroke="#3ecf8e" strokeWidth={2} dot={false} />
                  <Line type="monotone" dataKey="recordings" name="Segments" stroke="#e8b84a" strokeWidth={2} dot={false} />
                </LineChart>
              </ResponsiveContainer>
            </div>
          </div>

          <div className="panel">
            <h2>Per-camera output</h2>
            <div className="chart-box">
              <ResponsiveContainer width="100%" height={260}>
                <BarChart data={camChart}>
                  <CartesianGrid stroke="var(--line)" strokeDasharray="3 3" />
                  <XAxis dataKey="camera" stroke="var(--muted)" />
                  <YAxis stroke="var(--muted)" />
                  <Tooltip
                    contentStyle={{ background: "#121a17", border: "1px solid #2a3b34" }}
                  />
                  <Bar dataKey="outMb" name="Output MB" fill="#3ecf8e" radius={[6, 6, 0, 0]} />
                </BarChart>
              </ResponsiveContainer>
            </div>
          </div>

          <div className="panel">
            <h2>Upload status</h2>
            <table>
              <thead>
                <tr>
                  <th>Status</th>
                  <th>Count</th>
                </tr>
              </thead>
              <tbody>
                {data.uploads.map((u) => (
                  <tr key={u.status}>
                    <td>{u.status}</td>
                    <td className="mono">{u.c}</td>
                  </tr>
                ))}
                {!data.uploads.length ? (
                  <tr>
                    <td colSpan={2} className="sub">
                      No uploads yet.
                    </td>
                  </tr>
                ) : null}
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
