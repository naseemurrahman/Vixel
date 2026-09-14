import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { api, setToken } from "./api";
import type { PublicUser } from "./roles";

type AuthCtx = {
  token: string | null;
  user: PublicUser | null;
  loading: boolean;
  login: (username: string, password: string) => Promise<void>;
  logout: () => void;
  refreshUser: () => Promise<void>;
};

const Ctx = createContext<AuthCtx | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [token, setTok] = useState<string | null>(() => localStorage.getItem("vixel_token"));
  const [user, setUser] = useState<PublicUser | null>(null);
  const [loading, setLoading] = useState(Boolean(localStorage.getItem("vixel_token")));

  const refreshUser = useCallback(async () => {
    const res = await api<{ user: PublicUser }>("/api/me");
    setUser(res.user);
  }, []);

  useEffect(() => {
    if (!token) {
      setUser(null);
      setLoading(false);
      return;
    }
    setToken(token);
    setLoading(true);
    refreshUser()
      .catch(() => {
        localStorage.removeItem("vixel_token");
        setTok(null);
        setToken(null);
        setUser(null);
      })
      .finally(() => setLoading(false));
  }, [token, refreshUser]);

  const login = useCallback(async (username: string, password: string) => {
    const res = await api<{ token: string; user: PublicUser }>("/api/auth/login", {
      method: "POST",
      body: JSON.stringify({ username, password }),
    }, false);
    localStorage.setItem("vixel_token", res.token);
    setToken(res.token);
    setTok(res.token);
    setUser(res.user);
  }, []);

  const logout = useCallback(() => {
    localStorage.removeItem("vixel_token");
    setToken(null);
    setTok(null);
    setUser(null);
  }, []);

  const value = useMemo(
    () => ({ token, user, loading, login, logout, refreshUser }),
    [token, user, loading, login, logout, refreshUser]
  );
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useAuth(): AuthCtx {
  const v = useContext(Ctx);
  if (!v) throw new Error("AuthProvider missing");
  return v;
}
