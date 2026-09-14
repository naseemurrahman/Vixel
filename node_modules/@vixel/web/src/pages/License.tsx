import { FormEvent, useEffect, useState } from "react";
import { api } from "../api";

type LicenseInfo = {
  installed: null | {
    valid: boolean;
    reason?: string;
    installedAt: string;
    entitlements: Record<string, unknown>;
  };
  effective: {
    licenseId: string;
    customer: string;
    maxCameras: number;
    maxStorageTargets: number;
    maxConcurrentJobs: number;
    features: string[];
    expiresAt: string | null;
    notes?: string;
  };
};

export function LicensePage() {
  const [info, setInfo] = useState<LicenseInfo | null>(null);
  const [raw, setRaw] = useState("");
  const [error, setError] = useState("");
  const [ok, setOk] = useState("");

  async function refresh() {
    setInfo(await api<LicenseInfo>("/api/license"));
  }

  useEffect(() => {
    refresh().catch((e) => setError(e.message));
  }, []);

  async function onInstall(e: FormEvent) {
    e.preventDefault();
    setError("");
    setOk("");
    try {
      await api("/api/license", { method: "POST", body: JSON.stringify({ license: raw }) });
      setOk("License installed");
      setRaw("");
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Install failed");
    }
  }

  const e = info?.effective;

  return (
    <>
      <h1>License</h1>
      <p className="sub">
        Flexible entitlements — set any camera count, storage limits, and feature flags per customer.
      </p>
      {error ? <p className="error">{error}</p> : null}
      {ok ? <p style={{ color: "var(--accent)" }}>{ok}</p> : null}

      {e ? (
        <div className="panel">
          <h2>Effective entitlements</h2>
          <table>
            <tbody>
              <tr>
                <td>Customer</td>
                <td>{e.customer}</td>
              </tr>
              <tr>
                <td>License ID</td>
                <td className="mono">{e.licenseId}</td>
              </tr>
              <tr>
                <td>Max cameras</td>
                <td className="mono">{e.maxCameras}</td>
              </tr>
              <tr>
                <td>Max storage targets</td>
                <td className="mono">{e.maxStorageTargets}</td>
              </tr>
              <tr>
                <td>Max concurrent jobs</td>
                <td className="mono">{e.maxConcurrentJobs}</td>
              </tr>
              <tr>
                <td>Expires</td>
                <td className="mono">{e.expiresAt || "never"}</td>
              </tr>
              <tr>
                <td>Features</td>
                <td className="mono">{e.features.join(", ")}</td>
              </tr>
              {e.notes ? (
                <tr>
                  <td>Notes</td>
                  <td>{e.notes}</td>
                </tr>
              ) : null}
            </tbody>
          </table>
          {info?.installed && !info.installed.valid ? (
            <p className="error">Installed license invalid: {info.installed.reason}</p>
          ) : null}
        </div>
      ) : null}

      <div className="panel">
        <h2>Install license key</h2>
        <form onSubmit={onInstall}>
          <label>
            Paste VIXEL1 key
            <textarea
              value={raw}
              onChange={(e) => setRaw(e.target.value)}
              placeholder="VIXEL1...."
              required
            />
          </label>
          <div className="row" style={{ marginTop: "0.75rem" }}>
            <button type="submit">Install</button>
          </div>
        </form>
        <p className="sub" style={{ marginTop: "0.75rem", marginBottom: 0 }}>
          Generate keys with <span className="mono">npm run license:gen</span> using your signing
          private key. Entitlements are arbitrary — e.g. 7 cameras + S3 only, or 500 cameras with
          all features.
        </p>
      </div>
    </>
  );
}
