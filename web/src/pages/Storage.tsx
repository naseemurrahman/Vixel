import { FormEvent, useEffect, useState } from "react";
import { api } from "../api";
import { useAuth } from "../auth";
import { roleAtLeast } from "../roles";

type Target = {
  id: string;
  name: string;
  type: string;
  enabled: boolean;
  config: Record<string, unknown>;
};

export function StoragePage() {
  const { user } = useAuth();
  const canEdit = roleAtLeast(user?.role, "operator");
  const canDelete = roleAtLeast(user?.role, "admin");
  const [targets, setTargets] = useState<Target[]>([]);
  const [limits, setLimits] = useState({ used: 0, max: 1 });
  const [error, setError] = useState("");
  const [type, setType] = useState<"local" | "s3" | "sftp">("local");
  const [name, setName] = useState("");
  const [pathVal, setPathVal] = useState("./recordings/archive");
  const [s3, setS3] = useState({
    bucket: "",
    region: "us-east-1",
    accessKeyId: "",
    secretAccessKey: "",
    endpoint: "",
    prefix: "vixel/",
  });
  const [sftp, setSftp] = useState({
    host: "",
    port: "22",
    username: "",
    password: "",
    remoteDir: "/recordings",
  });

  async function refresh() {
    const res = await api<{ targets: Target[]; limits: { used: number; max: number } }>(
      "/api/storage"
    );
    setTargets(res.targets);
    setLimits(res.limits);
  }

  useEffect(() => {
    refresh().catch((e) => setError(e.message));
  }, []);

  async function onCreate(e: FormEvent) {
    e.preventDefault();
    setError("");
    let config: Record<string, unknown> = {};
    if (type === "local") config = { path: pathVal };
    if (type === "s3") {
      config = { ...s3, forcePathStyle: Boolean(s3.endpoint) };
      if (!s3.endpoint) delete (config as { endpoint?: string }).endpoint;
    }
    if (type === "sftp") {
      config = {
        host: sftp.host,
        port: Number(sftp.port),
        username: sftp.username,
        password: sftp.password,
        remoteDir: sftp.remoteDir,
      };
    }
    try {
      await api("/api/storage", {
        method: "POST",
        body: JSON.stringify({ name, type, enabled: true, config }),
      });
      setName("");
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed");
    }
  }

  async function remove(id: string) {
    if (!confirm("Remove this storage target?")) return;
    await api(`/api/storage/${id}`, { method: "DELETE" });
    await refresh();
  }

  return (
    <>
      <h1>Storage</h1>
      <p className="sub">
        Compressed recordings upload to every enabled target · {limits.used}/{limits.max}
      </p>
      {error ? <p className="error">{error}</p> : null}

      {canEdit ? (
        <div className="panel">
          <h2>Add target</h2>
          <form onSubmit={onCreate}>
            <div className="row">
              <label>
                Name
                <input required value={name} onChange={(e) => setName(e.target.value)} />
              </label>
              <label>
                Type
                <select value={type} onChange={(e) => setType(e.target.value as typeof type)}>
                  <option value="local">Local disk / NAS mount</option>
                  <option value="s3">S3 / MinIO</option>
                  <option value="sftp">SFTP</option>
                </select>
              </label>
            </div>
            {type === "local" ? (
              <div className="row">
                <label>
                  Path
                  <input value={pathVal} onChange={(e) => setPathVal(e.target.value)} />
                </label>
              </div>
            ) : null}
            {type === "s3" ? (
              <div className="row">
                <label>
                  Bucket
                  <input value={s3.bucket} onChange={(e) => setS3({ ...s3, bucket: e.target.value })} />
                </label>
                <label>
                  Region
                  <input value={s3.region} onChange={(e) => setS3({ ...s3, region: e.target.value })} />
                </label>
                <label>
                  Access key
                  <input
                    value={s3.accessKeyId}
                    onChange={(e) => setS3({ ...s3, accessKeyId: e.target.value })}
                  />
                </label>
                <label>
                  Secret
                  <input
                    type="password"
                    value={s3.secretAccessKey}
                    onChange={(e) => setS3({ ...s3, secretAccessKey: e.target.value })}
                  />
                </label>
                <label>
                  Endpoint (MinIO)
                  <input
                    value={s3.endpoint}
                    onChange={(e) => setS3({ ...s3, endpoint: e.target.value })}
                    placeholder="optional"
                  />
                </label>
                <label>
                  Prefix
                  <input value={s3.prefix} onChange={(e) => setS3({ ...s3, prefix: e.target.value })} />
                </label>
              </div>
            ) : null}
            {type === "sftp" ? (
              <div className="row">
                <label>
                  Host
                  <input value={sftp.host} onChange={(e) => setSftp({ ...sftp, host: e.target.value })} />
                </label>
                <label>
                  Port
                  <input value={sftp.port} onChange={(e) => setSftp({ ...sftp, port: e.target.value })} />
                </label>
                <label>
                  Username
                  <input
                    value={sftp.username}
                    onChange={(e) => setSftp({ ...sftp, username: e.target.value })}
                  />
                </label>
                <label>
                  Password
                  <input
                    type="password"
                    value={sftp.password}
                    onChange={(e) => setSftp({ ...sftp, password: e.target.value })}
                  />
                </label>
                <label>
                  Remote dir
                  <input
                    value={sftp.remoteDir}
                    onChange={(e) => setSftp({ ...sftp, remoteDir: e.target.value })}
                  />
                </label>
              </div>
            ) : null}
            <div className="row" style={{ marginTop: "0.75rem" }}>
              <button type="submit">Add storage</button>
            </div>
          </form>
        </div>
      ) : null}

      <div className="panel">
        <h2>Targets</h2>
        <table>
          <thead>
            <tr>
              <th>Name</th>
              <th>Type</th>
              <th>Config</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {targets.map((t) => (
              <tr key={t.id}>
                <td>{t.name}</td>
                <td>
                  <span className="badge ok">{t.type}</span>
                </td>
                <td className="mono">{JSON.stringify(t.config)}</td>
                <td>
                  {t.id !== "local-default" && canDelete ? (
                    <button type="button" className="danger" onClick={() => remove(t.id)}>
                      Delete
                    </button>
                  ) : null}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}
