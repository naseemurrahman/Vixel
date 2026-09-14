import { useEffect, useRef, useState } from "react";
import {
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

type Sample = {
  ts: string;
  cpuPct: number;
  memUsedMb: number;
  memRssMb: number;
  activeJobs: number;
  camerasEnabled: number;
  bytesOutRate: number;
  compressionPct: number;
  diskRecordingsMb: number;
};

const MAX = 90;

function label(ts: string) {
  return new Date(ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

export function PerformancePage() {
  const [samples, setSamples] = useState<Sample[]>([]);
  const [error, setError] = useState("");
  const [live, setLive] = useState(true);
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    api<{ samples: Sample[] }>("/api/metrics?limit=90")
      .then((r) => setSamples(r.samples))
      .catch((e) => setError(e.message));
  }, []);

  useEffect(() => {
    if (!live) return;
    const token = localStorage.getItem("vixel_token");
    if (!token) return;

    const ac = new AbortController();
    abortRef.current = ac;

    (async () => {
      try {
        const res = await fetch("/api/metrics/stream", {
          headers: { Authorization: `Bearer ${token}` },
          signal: ac.signal,
        });
        if (!res.ok || !res.body) throw new Error("Stream unavailable");
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buf = "";
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buf += decoder.decode(value, { stream: true });
          const parts = buf.split("\n\n");
          buf = parts.pop() ?? "";
          for (const part of parts) {
            const line = part.split("\n").find((l) => l.startsWith("data: "));
            if (!line) continue;
            try {
              const sample = JSON.parse(line.slice(6)) as Sample;
              setSamples((prev) => [...prev.slice(-(MAX - 1)), sample]);
            } catch {
              /* ignore partial */
            }
          }
        }
      } catch (e) {
        if (ac.signal.aborted) return;
        // fallback polling
        setError(e instanceof Error ? e.message : "Live stream failed — polling");
        const iv = setInterval(() => {
          api<{ latest: Sample | null }>("/api/metrics?limit=1")
            .then((r) => {
              if (r.latest) setSamples((prev) => [...prev.slice(-(MAX - 1)), r.latest!]);
            })
            .catch(() => undefined);
        }, 2000);
        ac.signal.addEventListener("abort", () => clearInterval(iv));
      }
    })();

    return () => ac.abort();
  }, [live]);

  const chart = samples.map((s) => ({
    ...s,
    t: label(s.ts),
  }));
  const latest = samples[samples.length - 1];

  return (
    <>
      <h1>Performance</h1>
      <p className="sub">Real-time CPU, memory, jobs, and compression throughput.</p>
      {error ? <p className="error">{error}</p> : null}

      <div className="row" style={{ marginBottom: "1rem" }}>
        <button type="button" className={live ? "" : "secondary"} onClick={() => setLive(true)}>
          Live on
        </button>
        <button type="button" className={!live ? "" : "secondary"} onClick={() => setLive(false)}>
          Pause
        </button>
        {latest ? (
          <span className="badge ok">Updated {label(latest.ts)}</span>
        ) : null}
      </div>

      <div className="grid">
        <div className="stat">
          <div className="label">CPU</div>
          <div className="value">{latest?.cpuPct ?? 0}%</div>
        </div>
        <div className="stat">
          <div className="label">Heap</div>
          <div className="value">{latest?.memUsedMb ?? 0} MB</div>
        </div>
        <div className="stat">
          <div className="label">Active jobs</div>
          <div className="value">{latest?.activeJobs ?? 0}</div>
        </div>
        <div className="stat">
          <div className="label">Compression</div>
          <div className="value">{latest?.compressionPct ?? 0}%</div>
        </div>
      </div>

      <div className="panel">
        <h2>CPU & memory</h2>
        <div className="chart-box">
          <ResponsiveContainer width="100%" height={280}>
            <LineChart data={chart}>
              <CartesianGrid stroke="var(--line)" strokeDasharray="3 3" />
              <XAxis dataKey="t" stroke="var(--muted)" minTickGap={40} />
              <YAxis stroke="var(--muted)" />
              <Tooltip contentStyle={{ background: "#121a17", border: "1px solid #2a3b34" }} />
              <Legend />
              <Line type="monotone" dataKey="cpuPct" name="CPU %" stroke="#3ecf8e" dot={false} strokeWidth={2} isAnimationActive={false} />
              <Line type="monotone" dataKey="memUsedMb" name="Heap MB" stroke="#6ec8ff" dot={false} strokeWidth={2} isAnimationActive={false} />
              <Line type="monotone" dataKey="memRssMb" name="RSS MB" stroke="#e8b84a" dot={false} strokeWidth={1.5} isAnimationActive={false} />
            </LineChart>
          </ResponsiveContainer>
        </div>
      </div>

      <div className="panel">
        <h2>Jobs & disk</h2>
        <div className="chart-box">
          <ResponsiveContainer width="100%" height={280}>
            <LineChart data={chart}>
              <CartesianGrid stroke="var(--line)" strokeDasharray="3 3" />
              <XAxis dataKey="t" stroke="var(--muted)" minTickGap={40} />
              <YAxis stroke="var(--muted)" />
              <Tooltip contentStyle={{ background: "#121a17", border: "1px solid #2a3b34" }} />
              <Legend />
              <Line type="monotone" dataKey="activeJobs" name="Jobs" stroke="#e86a5a" dot={false} strokeWidth={2} isAnimationActive={false} />
              <Line type="monotone" dataKey="camerasEnabled" name="Cameras on" stroke="#3ecf8e" dot={false} strokeWidth={2} isAnimationActive={false} />
              <Line type="monotone" dataKey="diskRecordingsMb" name="Disk MB" stroke="#c9a0ff" dot={false} strokeWidth={2} isAnimationActive={false} />
            </LineChart>
          </ResponsiveContainer>
        </div>
      </div>
    </>
  );
}
