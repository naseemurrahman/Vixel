import { useEffect, useState } from "react";
import { api } from "../api";
import { useAuth } from "../auth";
import { roleAtLeast } from "../roles";

type Alert = {
  id: string;
  severity: string;
  title: string;
  message: string;
  acknowledged: number;
  created_at: string;
  acknowledged_at: string | null;
  acknowledged_by: string | null;
};

export function AlertsPage() {
  const { user } = useAuth();
  const [alerts, setAlerts] = useState<Alert[]>([]);
  const [openOnly, setOpenOnly] = useState(false);
  const [error, setError] = useState("");
  const canAck = roleAtLeast(user?.role, "operator");
  const canTest = roleAtLeast(user?.role, "admin");

  async function refresh() {
    const q = openOnly ? "?open=1" : "";
    const res = await api<{ alerts: Alert[] }>(`/api/alerts${q}`);
    setAlerts(res.alerts);
  }

  useEffect(() => {
    let alive = true;
    const load = () =>
      refresh().catch((e) => alive && setError(e.message));
    load();
    const t = setInterval(load, 5000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [openOnly]);

  async function ack(id: string) {
    await api(`/api/alerts/${id}/ack`, { method: "POST" });
    await refresh();
  }

  async function testAlert() {
    await api("/api/alerts/test", { method: "POST" });
    await refresh();
  }

  return (
    <>
      <h1>Alerts</h1>
      <p className="sub">Failures and system notifications.</p>
      {error ? <p className="error">{error}</p> : null}

      <div className="row" style={{ marginBottom: "1rem" }}>
        <button
          type="button"
          className={openOnly ? "" : "secondary"}
          onClick={() => setOpenOnly(true)}
        >
          Open only
        </button>
        <button
          type="button"
          className={!openOnly ? "" : "secondary"}
          onClick={() => setOpenOnly(false)}
        >
          All
        </button>
        {canTest ? (
          <button type="button" className="secondary" onClick={testAlert}>
            Raise test alert
          </button>
        ) : null}
      </div>

      <div className="panel">
        <table>
          <thead>
            <tr>
              <th>When</th>
              <th>Severity</th>
              <th>Title</th>
              <th>Status</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {alerts.map((a) => (
              <tr key={a.id}>
                <td className="mono">{new Date(a.created_at).toLocaleString()}</td>
                <td>
                  <span
                    className={`badge ${
                      a.severity === "critical" ? "fail" : a.severity === "warning" ? "" : "ok"
                    }`}
                  >
                    {a.severity}
                  </span>
                </td>
                <td>
                  <div>{a.title}</div>
                  <div className="sub">{a.message}</div>
                </td>
                <td>
                  {a.acknowledged ? (
                    <span className="badge ok">acked</span>
                  ) : (
                    <span className="badge fail">open</span>
                  )}
                </td>
                <td>
                  {!a.acknowledged && canAck ? (
                    <button type="button" className="secondary" onClick={() => ack(a.id)}>
                      Acknowledge
                    </button>
                  ) : null}
                </td>
              </tr>
            ))}
            {!alerts.length ? (
              <tr>
                <td colSpan={5} className="sub">
                  No alerts.
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </div>
    </>
  );
}
