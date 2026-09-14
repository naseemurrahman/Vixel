import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { api } from "../api";

type About = {
  name: string;
  version: string;
  description: string;
  roles: { id: string; description: string }[];
  compression?: {
    id: string;
    description: string;
    expectedStaticSavings: string;
  }[];
};

export function HelpPage() {
  const [about, setAbout] = useState<About | null>(null);

  useEffect(() => {
    api<About>("/api/about").then(setAbout).catch(() => undefined);
  }, []);

  return (
    <>
      <h1>Help & about</h1>
      <p className="sub">{about?.description ?? "Loading…"}</p>

      <div className="panel">
        <h2>
          {about?.name ?? "Vixel"} <span className="badge">v{about?.version ?? "…"}</span>
        </h2>
        <p className="sub">
          Access the app at <span className="mono">http://localhost:8080</span> (Docker) or{" "}
          <span className="mono">http://localhost:5173</span> (dev). Default admin is configured via{" "}
          <span className="mono">VIXEL_ADMIN_USER</span> / <span className="mono">VIXEL_ADMIN_PASSWORD</span>.
        </p>
      </div>

      <div className="panel">
        <h2>Quick links</h2>
        <ul className="help-list">
          <li>
            <Link to="/cameras">Add RTSP cameras</Link> — start compression loops
          </li>
          <li>
            <Link to="/storage">Configure storage</Link> — local, S3/MinIO, SFTP
          </li>
          <li>
            <Link to="/performance">Performance</Link> — live CPU / memory / jobs charts
          </li>
          <li>
            <Link to="/usage">Usage</Link> — savings and volume graphs
          </li>
          <li>
            <Link to="/users">Users</Link> — roles (admin only)
          </li>
          <li>
            <Link to="/license">License</Link> — install flexible entitlements
          </li>
        </ul>
      </div>

      <div className="panel">
        <h2>Compression (open Zipstream-class)</h2>
        <p className="sub">
          Brand-agnostic RTSP → measure camera bitstream → re-encode with long GoV, I/P/B structure,
          static-frame decimation, and adaptive quantization. Target ≥80% on quiet scenes.
        </p>
        <ul className="help-list">
          {(about?.compression ?? []).map((c) => (
            <li key={c.id}>
              <strong>{c.id}</strong> — {c.description} ({c.expectedStaticSavings})
            </li>
          ))}
        </ul>
      </div>

      <div className="panel">
        <h2>Roles</h2>
        <table>
          <thead>
            <tr>
              <th>Role</th>
              <th>Access</th>
            </tr>
          </thead>
          <tbody>
            {(about?.roles ?? []).map((r) => (
              <tr key={r.id}>
                <td>
                  <span className="badge ok">{r.id}</span>
                </td>
                <td>{r.description}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}
