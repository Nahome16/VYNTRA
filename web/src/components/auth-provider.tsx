"use client";

import { createContext, FormEvent, ReactNode, useCallback, useContext, useEffect, useMemo, useState } from "react";
import { AdminUser } from "@/lib/types";

type AuthContextValue = {
  token: string;
  user: AdminUser | null;
  ready: boolean;
  login: (email: string, password: string) => Promise<void>;
  changePassword: (currentPassword: string, newPassword: string) => Promise<void>;
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
      if (!storedToken) {
        window.localStorage.removeItem(userKey);
        setReady(true);
        return;
      }

      requestJson<{ user: AdminUser }>("/api/admin/me", storedToken)
        .then((payload) => {
          setToken(storedToken);
          setUser(payload.user);
          window.localStorage.setItem(userKey, JSON.stringify(payload.user));
        })
        .catch(() => {
          setToken("");
          setUser(null);
          window.localStorage.removeItem(tokenKey);
          window.localStorage.removeItem(userKey);
        })
        .finally(() => {
          if (storedUser) {
            try {
              JSON.parse(storedUser);
            } catch {
              window.localStorage.removeItem(userKey);
            }
          }
          setReady(true);
        });
    }, 0);

    return () => window.clearTimeout(timer);
  }, []);

  const login = useCallback(async (email: string, password: string) => {
    const cleanEmail = email.trim().toLowerCase();
    if (!cleanEmail || !password) {
      throw new ApiError(400);
    }
    const payload = await requestJson<{
      access_token: string;
      user: AdminUser;
    }>("/api/admin/login", "", {
      method: "POST",
      body: JSON.stringify({ email: cleanEmail, password }),
    });
    setToken(payload.access_token);
    setUser(payload.user);
    window.localStorage.setItem(tokenKey, payload.access_token);
    window.localStorage.setItem(userKey, JSON.stringify(payload.user));
  }, []);

  const changePassword = useCallback(async (currentPassword: string, newPassword: string) => {
    const payload = await requestJson<{ user: AdminUser }>("/api/admin/password/change", token, {
      method: "POST",
      body: JSON.stringify({
        current_password: currentPassword,
        new_password: newPassword,
      }),
    });
    setUser(payload.user);
    window.localStorage.setItem(userKey, JSON.stringify(payload.user));
  }, [token]);

  const logout = useCallback(() => {
    const currentToken = window.localStorage.getItem(tokenKey) || token;
    if (currentToken) {
      void fetch("/api/admin/logout", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${currentToken}`,
        },
      }).catch(() => undefined);
    }
    setToken("");
    setUser(null);
    window.localStorage.removeItem(tokenKey);
    window.localStorage.removeItem(userKey);
  }, [token]);

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
      changePassword,
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
    [changePassword, login, logout, ready, requestAuthorized, token, user],
  );

  return (
    <AuthContext.Provider value={value}>
      {children}
      {ready && token && user?.password_change_required ? <PasswordChangeGate /> : null}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const value = useContext(AuthContext);
  if (!value) throw new Error("useAuth must be used inside AuthProvider");
  return value;
}

function passwordPolicyOk(password: string) {
  const signs = "!@#$%*?_-.";
  return (
    password.length >= 8
    && /[a-z]/.test(password)
    && /[A-Z]/.test(password)
    && /\d/.test(password)
    && Array.from(password).some((char) => signs.includes(char))
  );
}

function PasswordChangeGate() {
  const { changePassword } = useAuth();
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [statusText, setStatusText] = useState("");
  const [saving, setSaving] = useState(false);
  const canSubmit = Boolean(currentPassword) && passwordPolicyOk(newPassword) && newPassword === confirmation && !saving;

  async function submitPasswordChange(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!canSubmit) {
      setStatusText("La nueva contrasena debe cumplir la politica y coincidir.");
      return;
    }
    setSaving(true);
    setStatusText("Actualizando contrasena...");
    try {
      await changePassword(currentPassword, newPassword);
      setStatusText("Contrasena actualizada.");
    } catch {
      setStatusText("No se pudo cambiar. Revisa la contrasena temporal.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="password-gate" role="dialog" aria-modal="true">
      <form className="password-gate-panel" onSubmit={submitPasswordChange}>
        <header>
          <span>Credencial temporal</span>
          <h2>Cambia tu contrasena para continuar</h2>
          <p>Tu acceso fue creado con una contrasena temporal. Define una nueva contrasena antes de usar el panel.</p>
        </header>
        <label>
          Contrasena temporal
          <input
            type="password"
            value={currentPassword}
            onChange={(event) => setCurrentPassword(event.target.value)}
            autoComplete="current-password"
            required
          />
        </label>
        <label>
          Nueva contrasena
          <input
            type="password"
            value={newPassword}
            onChange={(event) => setNewPassword(event.target.value)}
            autoComplete="new-password"
            required
          />
        </label>
        <label>
          Confirmar nueva contrasena
          <input
            type="password"
            value={confirmation}
            onChange={(event) => setConfirmation(event.target.value)}
            autoComplete="new-password"
            required
          />
        </label>
        <small>Minimo 8 caracteres, mayuscula, minuscula, numero y signo.</small>
        {statusText ? <p className="password-gate-status">{statusText}</p> : null}
        <button type="submit" disabled={!canSubmit}>
          {saving ? "Guardando..." : "Guardar y continuar"}
        </button>
      </form>
    </div>
  );
}
