import { FormEvent, useEffect, useState } from "react";
import { api } from "../api";
import { useAuth } from "../auth";
import { roleAtLeast, type PublicUser, type Role } from "../roles";

export function UsersPage() {
  const { user: me } = useAuth();
  const [users, setUsers] = useState<PublicUser[]>([]);
  const [error, setError] = useState("");
  const [form, setForm] = useState({
    username: "",
    displayName: "",
    email: "",
    role: "operator" as Role,
    password: "",
  });

  async function refresh() {
    const res = await api<{ users: PublicUser[] }>("/api/users");
    setUsers(res.users);
  }

  useEffect(() => {
    refresh().catch((e) => setError(e.message));
  }, []);

  async function onCreate(e: FormEvent) {
    e.preventDefault();
    setError("");
    try {
      await api("/api/users", {
        method: "POST",
        body: JSON.stringify({
          ...form,
          email: form.email || null,
        }),
      });
      setForm({ username: "", displayName: "", email: "", role: "operator", password: "" });
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed");
    }
  }

  async function setRole(id: string, role: Role) {
    await api(`/api/users/${id}`, { method: "PATCH", body: JSON.stringify({ role }) });
    await refresh();
  }

  async function toggleActive(u: PublicUser) {
    await api(`/api/users/${u.id}`, {
      method: "PATCH",
      body: JSON.stringify({ active: !u.active }),
    });
    await refresh();
  }

  async function remove(id: string) {
    if (!confirm("Delete this user?")) return;
    setError("");
    try {
      await api(`/api/users/${id}`, { method: "DELETE" });
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed");
    }
  }

  return (
    <>
      <h1>Users & roles</h1>
      <p className="sub">
        Admin · Operator · Viewer — signed in as {me?.username} ({me?.role})
      </p>
      {error ? <p className="error">{error}</p> : null}

      <div className="panel">
        <h2>Create user</h2>
        <form className="row" onSubmit={onCreate}>
          <label>
            Username
            <input
              required
              value={form.username}
              onChange={(e) => setForm({ ...form, username: e.target.value })}
            />
          </label>
          <label>
            Display name
            <input
              required
              value={form.displayName}
              onChange={(e) => setForm({ ...form, displayName: e.target.value })}
            />
          </label>
          <label>
            Email
            <input
              type="email"
              value={form.email}
              onChange={(e) => setForm({ ...form, email: e.target.value })}
            />
          </label>
          <label>
            Role
            <select
              value={form.role}
              onChange={(e) => setForm({ ...form, role: e.target.value as Role })}
            >
              <option value="admin">admin</option>
              <option value="operator">operator</option>
              <option value="viewer">viewer</option>
            </select>
          </label>
          <label>
            Password
            <input
              type="password"
              required
              minLength={8}
              value={form.password}
              onChange={(e) => setForm({ ...form, password: e.target.value })}
            />
          </label>
          <button type="submit">Create</button>
        </form>
      </div>

      <div className="panel">
        <h2>Accounts</h2>
        <table>
          <thead>
            <tr>
              <th>User</th>
              <th>Role</th>
              <th>Status</th>
              <th>Last login</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {users.map((u) => (
              <tr key={u.id}>
                <td>
                  <div>{u.displayName}</div>
                  <div className="mono sub">{u.username}</div>
                </td>
                <td>
                  <select
                    value={u.role}
                    disabled={!roleAtLeast(me?.role, "admin")}
                    onChange={(e) => setRole(u.id, e.target.value as Role)}
                  >
                    <option value="admin">admin</option>
                    <option value="operator">operator</option>
                    <option value="viewer">viewer</option>
                  </select>
                </td>
                <td>
                  <span className={`badge ${u.active ? "ok" : "fail"}`}>
                    {u.active ? "active" : "disabled"}
                  </span>
                </td>
                <td className="mono">
                  {u.lastLoginAt ? new Date(u.lastLoginAt).toLocaleString() : "—"}
                </td>
                <td>
                  <div className="row" style={{ justifyContent: "flex-end" }}>
                    <button type="button" className="secondary" onClick={() => toggleActive(u)}>
                      {u.active ? "Disable" : "Enable"}
                    </button>
                    <button type="button" className="danger" onClick={() => remove(u.id)}>
                      Delete
                    </button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}
