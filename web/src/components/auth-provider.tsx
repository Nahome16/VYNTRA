"use client";

import { createContext, ReactNode, useCallback, useContext, useEffect, useMemo, useState } from "react";
import { AdminUser } from "@/lib/types";

type AuthContextValue = {
  token: string;
  user: AdminUser | null;
  ready: boolean;
  login: (email: string, password: string) => Promise<void>;
  logout: () => void;
  apiGet: <T,>(path: string) => Promise<T>;
  apiPost: <T,>(path: string, body: unknown) => Promise<T>;
  apiPatch: <T,>(path: string, body: unknown) => Promise<T>;
};

const AuthContext = createContext<AuthContextValue | null>(null);

const tokenKey = "vyntra.admin.token";
const userKey = "vyntra.admin.user";

class ApiError extends Error {
  status: number;

  constructor(status: number) {
    super(`HTTP ${status}`);
    this.status = status;
  }
}

async function requestJson<T>(path: string, token: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(path, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(init.headers || {}),
    },
    cache: "no-store",
  });
  if (!response.ok) throw new ApiError(response.status);
  return response.json();
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [token, setToken] = useState("");
  const [user, setUser] = useState<AdminUser | null>(null);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      const storedToken = window.localStorage.getItem(tokenKey) || "";
      const storedUser = window.localStorage.getItem(userKey);
      setToken(storedToken);
      if (storedUser) {
        try {
          setUser(JSON.parse(storedUser));
        } catch {
          window.localStorage.removeItem(userKey);
        }
      }
      setReady(true);
    }, 0);

    return () => window.clearTimeout(timer);
  }, []);

  const login = useCallback(async (email: string, password: string) => {
    const payload = await requestJson<{
      access_token: string;
      user: AdminUser;
    }>("/api/admin/login", "", {
      method: "POST",
      body: JSON.stringify({ email, password }),
    });
    setToken(payload.access_token);
    setUser(payload.user);
    window.localStorage.setItem(tokenKey, payload.access_token);
    window.localStorage.setItem(userKey, JSON.stringify(payload.user));
  }, []);

  const logout = useCallback(() => {
    setToken("");
    setUser(null);
    window.localStorage.removeItem(tokenKey);
    window.localStorage.removeItem(userKey);
  }, []);

  const requestAuthorized = useCallback(
    async <T,>(path: string, init: RequestInit = {}) => {
      try {
        return await requestJson<T>(path, token, init);
      } catch (error) {
        if (error instanceof ApiError && (error.status === 401 || error.status === 403)) {
          logout();
        }
        throw error;
      }
    },
    [logout, token],
  );

  const value = useMemo<AuthContextValue>(
    () => ({
      token,
      user,
      ready,
      login,
      logout,
      apiGet: <T,>(path: string) => requestAuthorized<T>(path),
      apiPost: <T,>(path: string, body: unknown) =>
        requestAuthorized<T>(path, {
          method: "POST",
          body: JSON.stringify(body),
        }),
      apiPatch: <T,>(path: string, body: unknown) =>
        requestAuthorized<T>(path, {
          method: "PATCH",
          body: JSON.stringify(body),
        }),
    }),
    [login, logout, ready, requestAuthorized, token, user],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const value = useContext(AuthContext);
  if (!value) throw new Error("useAuth must be used inside AuthProvider");
  return value;
}
