import { Navigate, NavLink, Route, Routes } from "react-router-dom";
import { useAuth } from "./auth";
import { roleAtLeast, type Role } from "./roles";
import { CamerasPage } from "./pages/Cameras";
import { DashboardPage } from "./pages/Dashboard";
import { LoginPage } from "./pages/Login";
import { RecordingsPage } from "./pages/Recordings";
import { SettingsPage } from "./pages/Settings";
import { StoragePage } from "./pages/Storage";
import { UsersPage } from "./pages/Users";

function NavItem({
  to,
  end,
  minRole,
  children,
}: {
  to: string;
  end?: boolean;
  minRole?: Role;
  children: React.ReactNode;
}) {
  const { user } = useAuth();
  if (minRole && !roleAtLeast(user?.role, minRole)) return null;
  return (
    <NavLink to={to} end={end} className={({ isActive }) => (isActive ? "active" : "")}>
      {children}
    </NavLink>
  );
}

function Shell({ children }: { children: React.ReactNode }) {
  const { logout, user } = useAuth();
  return (
    <div className="shell">
      <aside className="nav">
        <div className="brand">
          Vi<span>xel</span>
        </div>
        <div className="nav-user">
          <strong>{user?.displayName || user?.username}</strong>
        </div>
        <NavItem to="/" end>
          Dashboard
        </NavItem>
        <NavItem to="/cameras">Cameras</NavItem>
        <NavItem to="/recordings">Recordings</NavItem>
        <NavItem to="/storage">Storage</NavItem>
        <NavItem to="/users" minRole="admin">
          Users
        </NavItem>
        <NavItem to="/settings" minRole="admin">
          Settings
        </NavItem>
        <div className="spacer" />
        <button className="secondary" type="button" onClick={logout}>
          Sign out
        </button>
      </aside>
      <main className="main">{children}</main>
    </div>
  );
}

function Private({
  children,
  minRole,
}: {
  children: React.ReactNode;
  minRole?: Role;
}) {
  const { token, user, loading } = useAuth();
  if (loading) return <div className="login-wrap"><p className="sub">Loading…</p></div>;
  if (!token) return <Navigate to="/login" replace />;
  if (minRole && !roleAtLeast(user?.role, minRole)) {
    return (
      <Shell>
        <h1>Forbidden</h1>
        <p className="sub">Your role ({user?.role}) cannot access this page.</p>
      </Shell>
    );
  }
  return <Shell>{children}</Shell>;
}

export function App() {
  return (
    <Routes>
      <Route path="/login" element={<LoginPage />} />
      <Route path="/" element={<Private><DashboardPage /></Private>} />
      <Route path="/cameras" element={<Private><CamerasPage /></Private>} />
      <Route path="/storage" element={<Private><StoragePage /></Private>} />
      <Route path="/recordings" element={<Private><RecordingsPage /></Private>} />
      <Route path="/users" element={<Private minRole="admin"><UsersPage /></Private>} />
      <Route path="/settings" element={<Private minRole="admin"><SettingsPage /></Private>} />
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}
