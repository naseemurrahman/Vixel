import { FormEvent, useState } from "react";
import { Navigate } from "react-router-dom";
import { useAuth } from "../auth";

export function LoginPage() {
  const { token, login } = useAuth();
  const [username, setUsername] = useState("admin");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  if (token) return <Navigate to="/" replace />;

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError("");
    try {
      await login(username, password);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Login failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="login-wrap">
      <form className="login-card" onSubmit={onSubmit}>
        <h1>
          Vi<span style={{ color: "var(--accent)" }}>xel</span>
        </h1>
        <p className="sub">Secure IP camera compression for your servers.</p>
        <div className="row" style={{ flexDirection: "column", alignItems: "stretch" }}>
          <label>
            Username
            <input value={username} onChange={(e) => setUsername(e.target.value)} autoComplete="username" />
          </label>
          <label>
            Password
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete="current-password"
            />
          </label>
          <button type="submit" disabled={busy}>
            {busy ? "Signing in…" : "Sign in"}
          </button>
        </div>
        {error ? <p className="error">{error}</p> : null}
      </form>
    </div>
  );
}
