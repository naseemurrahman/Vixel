import { Navigate, NavLink, Route, Routes } from "react-router-dom";
import { useAuth } from "./auth";
import { roleAtLeast, type Role } from "./roles";
import { AlertsPage } from "./pages/Alerts";
import { CamerasPage } from "./pages/Cameras";
import { DashboardPage } from "./pages/Dashboard";
import { HelpPage } from "./pages/Help";
import { LicensePage } from "./pages/License";
import { LoginPage } from "./pages/Login";
import { LogsPage } from "./pages/Logs";
import { PerformancePage } from "./pages/Performance";
import { ProfilePage } from "./pages/Profile";
import { RecordingsPage } from "./pages/Recordings";
import { SettingsPage } from "./pages/Settings";
import { StoragePage } from "./pages/Storage";
import { UsagePage } from "./pages/Usage";
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
          <span className="badge">{user?.role}</span>
        </div>
        <div className="nav-section">Monitor</div>
        <NavItem to="/" end>
          Dashboard
        </NavItem>
        <NavItem to="/performance">Performance</NavItem>
        <NavItem to="/usage">Usage</NavItem>
        <NavItem to="/alerts">Alerts</NavItem>
        <NavItem to="/logs">Logs</NavItem>
        <div className="nav-section">Operations</div>
        <NavItem to="/cameras">Cameras</NavItem>
        <NavItem to="/storage">Storage</NavItem>
        <NavItem to="/recordings">Recordings</NavItem>
        <div className="nav-section">Account</div>
        <NavItem to="/profile">Profile</NavItem>
        <NavItem to="/users" minRole="admin">
          Users
        </NavItem>
        <NavItem to="/license" minRole="operator">
          License
        </NavItem>
        <NavItem to="/settings" minRole="admin">
          Settings
        </NavItem>
        <NavItem to="/help">Help</NavItem>
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
      <Route path="/performance" element={<Private><PerformancePage /></Private>} />
      <Route path="/usage" element={<Private><UsagePage /></Private>} />
      <Route path="/alerts" element={<Private><AlertsPage /></Private>} />
      <Route path="/logs" element={<Private><LogsPage /></Private>} />
      <Route path="/cameras" element={<Private><CamerasPage /></Private>} />
      <Route path="/storage" element={<Private><StoragePage /></Private>} />
      <Route path="/recordings" element={<Private><RecordingsPage /></Private>} />
      <Route path="/profile" element={<Private><ProfilePage /></Private>} />
      <Route path="/users" element={<Private minRole="admin"><UsersPage /></Private>} />
      <Route path="/license" element={<Private minRole="operator"><LicensePage /></Private>} />
      <Route path="/settings" element={<Private minRole="admin"><SettingsPage /></Private>} />
      <Route path="/help" element={<Private><HelpPage /></Private>} />
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}
