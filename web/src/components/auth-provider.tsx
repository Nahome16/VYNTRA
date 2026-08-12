"use client";

import { createContext, ReactNode, useContext, useEffect, useMemo, useState } from "react";
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
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.json();
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [token, setToken] = useState("");
  const [user, setUser] = useState<AdminUser | null>(null);
  const [ready, setReady] = useState(false);

  useEffect(() => {
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
  }, []);

  async function login(email: string, password: string) {
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
  }

  function logout() {
    setToken("");
    setUser(null);
    window.localStorage.removeItem(tokenKey);
    window.localStorage.removeItem(userKey);
  }

  const value = useMemo<AuthContextValue>(
    () => ({
      token,
      user,
      ready,
      login,
      logout,
      apiGet: <T,>(path: string) => requestJson<T>(path, token),
      apiPost: <T,>(path: string, body: unknown) =>
        requestJson<T>(path, token, {
          method: "POST",
          body: JSON.stringify(body),
        }),
      apiPatch: <T,>(path: string, body: unknown) =>
        requestJson<T>(path, token, {
          method: "PATCH",
          body: JSON.stringify(body),
        }),
    }),
    [ready, token, user],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const value = useContext(AuthContext);
  if (!value) throw new Error("useAuth must be used inside AuthProvider");
  return value;
}
