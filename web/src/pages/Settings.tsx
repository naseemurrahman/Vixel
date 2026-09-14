import { FormEvent, useEffect, useState } from "react";
import { api } from "../api";

export function SettingsPage() {
  const [settings, setSettings] = useState<Record<string, string>>({});
  const [runtime, setRuntime] = useState<Record<string, string | number>>({});
  const [error, setError] = useState("");
  const [ok, setOk] = useState("");

  useEffect(() => {
    api<{ settings: Record<string, string>; runtime: Record<string, string | number> }>(
      "/api/settings"
    )
      .then((r) => {
        setSettings({
          org_name: r.settings.org_name ?? "Vixel Site",
          retention_days: r.settings.retention_days ?? "30",
          alert_on_failure: r.settings.alert_on_failure ?? "1",
          timezone: r.settings.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone,
        });
        setRuntime(r.runtime);
      })
      .catch((e) => setError(e.message));
  }, []);

  async function onSave(e: FormEvent) {
    e.preventDefault();
    setError("");
    setOk("");
    try {
      const res = await api<{ settings: Record<string, string> }>("/api/settings", {
        method: "PUT",
        body: JSON.stringify(settings),
      });
      setSettings({ ...settings, ...res.settings });
      setOk("Settings saved");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Save failed");
    }
  }

  async function syncLoops() {
    await api("/api/system/sync-loops", { method: "POST" });
    setOk("Camera loops synced");
  }

  return (
    <>
      <h1>Settings</h1>
      <p className="sub">Site configuration (admin only).</p>
      {error ? <p className="error">{error}</p> : null}
      {ok ? <p style={{ color: "var(--accent)" }}>{ok}</p> : null}

      <div className="panel">
        <h2>Runtime</h2>
        <table>
          <tbody>
            {Object.entries(runtime).map(([k, v]) => (
              <tr key={k}>
                <td>{k}</td>
                <td className="mono">{String(v)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="panel">
        <h2>Site</h2>
        <form onSubmit={onSave}>
          <div className="row">
            <label>
              Organization name
              <input
                value={settings.org_name ?? ""}
                onChange={(e) => setSettings({ ...settings, org_name: e.target.value })}
              />
            </label>
            <label>
              Retention (days)
              <input
                type="number"
                min={1}
                value={settings.retention_days ?? "30"}
                onChange={(e) => setSettings({ ...settings, retention_days: e.target.value })}
              />
            </label>
            <label>
              Timezone
              <input
                value={settings.timezone ?? ""}
                onChange={(e) => setSettings({ ...settings, timezone: e.target.value })}
              />
            </label>
            <label>
              Alert on failure
              <select
                value={settings.alert_on_failure ?? "1"}
                onChange={(e) => setSettings({ ...settings, alert_on_failure: e.target.value })}
              >
                <option value="1">Enabled</option>
                <option value="0">Disabled</option>
              </select>
            </label>
          </div>
          <div className="row" style={{ marginTop: "0.85rem" }}>
            <button type="submit">Save</button>
            <button type="button" className="secondary" onClick={syncLoops}>
              Sync camera loops
            </button>
          </div>
        </form>
      </div>
    </>
  );
}
