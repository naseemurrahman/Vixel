import { FormEvent, useEffect, useState } from "react";
import { api } from "../api";
import { useAuth } from "../auth";

export function ProfilePage() {
  const { user, refreshUser } = useAuth();
  const [displayName, setDisplayName] = useState("");
  const [email, setEmail] = useState("");
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [error, setError] = useState("");
  const [ok, setOk] = useState("");

  useEffect(() => {
    if (!user) return;
    setDisplayName(user.displayName);
    setEmail(user.email ?? "");
  }, [user]);

  async function onSave(e: FormEvent) {
    e.preventDefault();
    setError("");
    setOk("");
    try {
      await api("/api/me", {
        method: "PATCH",
        body: JSON.stringify({
          displayName,
          email: email || null,
          ...(newPassword
            ? { currentPassword, newPassword }
            : {}),
        }),
      });
      await refreshUser();
      setCurrentPassword("");
      setNewPassword("");
      setOk("Profile updated");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Update failed");
    }
  }

  if (!user) return <p className="sub">Loading…</p>;

  return (
    <>
      <h1>Profile</h1>
      <p className="sub">Manage your account details and password.</p>
      {error ? <p className="error">{error}</p> : null}
      {ok ? <p style={{ color: "var(--accent)" }}>{ok}</p> : null}

      <div className="panel">
        <h2>Account</h2>
        <table>
          <tbody>
            <tr>
              <td>Username</td>
              <td className="mono">{user.username}</td>
            </tr>
            <tr>
              <td>Role</td>
              <td>
                <span className="badge ok">{user.role}</span>
              </td>
            </tr>
            <tr>
              <td>Member since</td>
              <td className="mono">{new Date(user.createdAt).toLocaleString()}</td>
            </tr>
          </tbody>
        </table>
      </div>

      <div className="panel">
        <h2>Edit profile</h2>
        <form onSubmit={onSave}>
          <div className="row">
            <label>
              Display name
              <input value={displayName} onChange={(e) => setDisplayName(e.target.value)} required />
            </label>
            <label>
              Email
              <input
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
              />
            </label>
          </div>
          <h2 style={{ marginTop: "1.25rem" }}>Change password</h2>
          <div className="row">
            <label>
              Current password
              <input
                type="password"
                value={currentPassword}
                onChange={(e) => setCurrentPassword(e.target.value)}
                autoComplete="current-password"
              />
            </label>
            <label>
              New password
              <input
                type="password"
                minLength={8}
                value={newPassword}
                onChange={(e) => setNewPassword(e.target.value)}
                autoComplete="new-password"
              />
            </label>
          </div>
          <div className="row" style={{ marginTop: "0.85rem" }}>
            <button type="submit">Save changes</button>
          </div>
        </form>
      </div>
    </>
  );
}
