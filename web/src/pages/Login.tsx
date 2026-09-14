import { FormEvent, useState } from "react";
import { Navigate } from "react-router-dom";
import { useAuth } from "../auth";

export function LoginPage() {
  const { token, login } = useAuth();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  if (token) return <Navigate to="/" replace />;

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError("");
    try {
      await login(username.trim(), password);
    } catch (err) {
      const message = err instanceof Error ? err.message : "";
      setError(
        message.includes("Too many sign-in attempts")
          ? message
          : "Sign-in failed. Check your username and password, then try again."
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="login-wrap">
      <form className="login-card" onSubmit={onSubmit}>
        <div className="login-mark" aria-hidden="true">V</div>
        <p className="login-eyebrow">Vixel Control Center</p>
        <h1 className="login-title">
          Vi<span style={{ color: "var(--accent)" }}>xel</span>
        </h1>
        <p className="sub login-copy">Sign in to manage your secure camera-compression server.</p>
        <div className="login-fields">
          <label>
            Username
            <input
              name="username"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              autoComplete="username"
              autoCapitalize="none"
              autoCorrect="off"
              spellCheck={false}
              maxLength={64}
              required
              disabled={busy}
            />
          </label>
          <label>
            Password
            <span className="password-field">
              <input
                name="password"
                type={showPassword ? "text" : "password"}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                autoComplete="current-password"
                minLength={1}
                maxLength={128}
                required
                disabled={busy}
                aria-invalid={Boolean(error)}
                aria-describedby={error ? "login-error" : undefined}
              />
              <button
                type="button"
                className="password-toggle"
                onClick={() => setShowPassword((visible) => !visible)}
                aria-label={showPassword ? "Hide password" : "Show password"}
                disabled={busy}
              >
                {showPassword ? "Hide" : "Show"}
              </button>
            </span>
          </label>
          <button className="login-submit" type="submit" disabled={busy}>
            {busy ? "Signing in…" : "Sign in"}
          </button>
        </div>
        {error ? <p id="login-error" className="error" role="alert">{error}</p> : null}
        <p className="login-security-note">Protected sign-in · Attempts are rate limited</p>
      </form>
    </div>
  );
}
