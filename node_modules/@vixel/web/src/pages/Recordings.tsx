import { useEffect, useState } from "react";
import { api } from "../api";

type Rec = {
  id: string;
  camera_id: string;
  camera_name?: string;
  status: string;
  bytes_in: number | null;
  bytes_out: number | null;
  compression_ratio: number | null;
  error: string | null;
  started_at: string;
  finished_at: string | null;
  output_path: string | null;
};

export function RecordingsPage() {
  const [recordings, setRecordings] = useState<Rec[]>([]);
  const [error, setError] = useState("");

  useEffect(() => {
    let alive = true;
    const load = () =>
      api<{ recordings: Rec[] }>("/api/recordings")
        .then((r) => alive && setRecordings(r.recordings))
        .catch((e) => alive && setError(e.message));
    load();
    const t = setInterval(load, 4000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, []);

  return (
    <>
      <h1>Recordings</h1>
      <p className="sub">Compressed segments and upload status.</p>
      {error ? <p className="error">{error}</p> : null}
      <div className="panel">
        <table>
          <thead>
            <tr>
              <th>Camera</th>
              <th>Started</th>
              <th>Status</th>
              <th>Saved</th>
              <th>Out</th>
            </tr>
          </thead>
          <tbody>
            {recordings.map((r) => (
              <tr key={r.id}>
                <td>{r.camera_name || r.camera_id}</td>
                <td className="mono">{new Date(r.started_at).toLocaleString()}</td>
                <td>
                  <span
                    className={`badge ${
                      r.status === "failed" ? "fail" : r.status === "uploaded" ? "ok" : ""
                    }`}
                  >
                    {r.status}
                  </span>
                  {r.error ? <div className="error">{r.error}</div> : null}
                </td>
                <td className="mono">
                  {r.compression_ratio != null
                    ? `${Math.round(r.compression_ratio * 1000) / 10}%`
                    : "—"}
                </td>
                <td className="mono">
                  {r.bytes_out != null ? `${(r.bytes_out / 1e6).toFixed(2)} MB` : "—"}
                </td>
              </tr>
            ))}
            {!recordings.length ? (
              <tr>
                <td colSpan={5} className="sub">
                  No recordings yet. Add a camera and start capture.
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </div>
    </>
  );
}
