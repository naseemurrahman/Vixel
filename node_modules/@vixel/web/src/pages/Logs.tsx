import { useEffect, useState } from "react";
import { api } from "../api";

type Entry = Record<string, unknown>;

export function LogsPage() {
  const [type, setType] = useState<"system" | "audit">("system");
  const [level, setLevel] = useState("");
  const [entries, setEntries] = useState<Entry[]>([]);
  const [error, setError] = useState("");

  useEffect(() => {
    let alive = true;
    const load = () => {
      const q = new URLSearchParams({ type, limit: "150" });
      if (type === "system" && level) q.set("level", level);
      api<{ entries: Entry[] }>(`/api/logs?${q}`)
        .then((r) => alive && setEntries(r.entries))
        .catch((e) => alive && setError(e.message));
    };
    load();
    const t = setInterval(load, 4000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [type, level]);

  return (
    <>
      <h1>Logs</h1>
      <p className="sub">System events and audit trail — auto-refreshes every 4s.</p>
      {error ? <p className="error">{error}</p> : null}

      <div className="panel">
        <div className="row">
          <label style={{ maxWidth: 180 }}>
            Log type
            <select value={type} onChange={(e) => setType(e.target.value as typeof type)}>
              <option value="system">System</option>
              <option value="audit">Audit</option>
            </select>
          </label>
          {type === "system" ? (
            <label style={{ maxWidth: 180 }}>
              Level
              <select value={level} onChange={(e) => setLevel(e.target.value)}>
                <option value="">All</option>
                <option value="info">info</option>
                <option value="warn">warn</option>
                <option value="error">error</option>
                <option value="debug">debug</option>
              </select>
            </label>
          ) : null}
        </div>
      </div>

      <div className="panel">
        <table>
          <thead>
            <tr>
              <th>Time</th>
              {type === "system" ? (
                <>
                  <th>Level</th>
                  <th>Source</th>
                  <th>Message</th>
                </>
              ) : (
                <>
                  <th>Actor</th>
                  <th>Action</th>
                  <th>Detail</th>
                </>
              )}
            </tr>
          </thead>
          <tbody>
            {entries.map((e) => (
              <tr key={String(e.id)}>
                <td className="mono">{new Date(String(e.created_at)).toLocaleString()}</td>
                {type === "system" ? (
                  <>
                    <td>
                      <span
                        className={`badge ${
                          e.level === "error" ? "fail" : e.level === "warn" ? "" : "ok"
                        }`}
                      >
                        {String(e.level)}
                      </span>
                    </td>
                    <td className="mono">{String(e.source)}</td>
                    <td>
                      {String(e.message)}
                      {e.detail ? <div className="mono sub">{String(e.detail)}</div> : null}
                    </td>
                  </>
                ) : (
                  <>
                    <td>{String(e.actor)}</td>
                    <td className="mono">{String(e.action)}</td>
                    <td className="mono">{e.detail ? String(e.detail) : "—"}</td>
                  </>
                )}
              </tr>
            ))}
            {!entries.length ? (
              <tr>
                <td colSpan={4} className="sub">
                  No log entries yet.
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </div>
    </>
  );
}
