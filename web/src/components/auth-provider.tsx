"use client";

import { createContext, FormEvent, ReactNode, useCallback, useContext, useEffect, useMemo, useState } from "react";
import { ApiError, isApiError, requestJson } from "@/lib/api";
import { AdminUser } from "@/lib/types";

type AuthContextValue = {
  token: string;
  user: AdminUser | null;
  ready: boolean;
  activeCompanyId: string;
  setActiveCompanyId: (companyId: string) => void;
  login: (email: string, password: string) => Promise<void>;
  changePassword: (currentPassword: string, newPassword: string) => Promise<void>;
  logout: () => void;
  /** true si el usuario actual tiene el permiso indicado. */
  hasPermission: (permission: string) => boolean;
  /** Mensaje visible cuando el backend respondio 403 a una accion del usuario. */
  accessNotice: string;
  clearAccessNotice: () => void;
  apiGet: <T,>(path: string) => Promise<T>;
  apiPost: <T,>(path: string, body: unknown) => Promise<T>;
  apiPatch: <T,>(path: string, body: unknown) => Promise<T>;
};

const AuthContext = createContext<AuthContextValue | null>(null);

const tokenKey = "vyntra.admin.token";
const userKey = "vyntra.admin.user";
const activeCompanyKey = "vyntra.admin.activeCompanyId";

const companyScopedReadPrefixes = [
  "/api/productivity/catalogs",
  "/api/productivity/rules",
  "/api/productivity/uncategorized",
  "/api/productivity/dashboard",
  "/api/settings/access-codes",
  "/api/settings/restore-codes",
  "/api/devices",
  "/api/attendance/overview",
  "/api/reports/operations.pdf",
];

const companyScopedWritePaths = new Set([
  "/api/settings/employees",
  "/api/settings/departments",
  "/api/settings/access-codes",
  "/api/settings/restore-codes",
  "/api/productivity/rules",
  "/api/productivity/reclassify",
  "/api/devices",
  "/api/attendance/shifts",
]);

export const ACCESS_RESTRICTED_MESSAGE = "Acceso restringido: tu rol no tiene permiso para esta accion o recurso.";

function hasCompanyId(path: string) {
  return /(?:\?|&)company_id=/.test(path);
}

function shouldScopeRead(path: string) {
  return companyScopedReadPrefixes.some((prefix) => path.startsWith(prefix));
}

function shouldScopeWrite(path: string) {
  return companyScopedWritePaths.has(path);
}

function appendCompanyId(path: string, companyId: string) {
  if (!companyId || hasCompanyId(path)) return path;
  const [base, hash = ""] = path.split("#");
  const separator = base.includes("?") ? "&" : "?";
  return `${base}${separator}company_id=${encodeURIComponent(companyId)}${hash ? `#${hash}` : ""}`;
}

function scopedReadPath(path: string, user: AdminUser | null, activeCompanyId: string) {
  if (user?.role !== "system_admin" || !activeCompanyId || !shouldScopeRead(path)) return path;
  return appendCompanyId(path, activeCompanyId);
}

function scopedWriteBody(path: string, body: unknown, user: AdminUser | null, activeCompanyId: string) {
  if (user?.role !== "system_admin" || !activeCompanyId || !shouldScopeWrite(path)) return body;
  if (!body || Array.isArray(body) || typeof body !== "object") return body;
  return { ...(body as Record<string, unknown>), company_id: (body as Record<string, unknown>).company_id || activeCompanyId };
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [token, setToken] = useState("");
  const [user, setUser] = useState<AdminUser | null>(null);
  const [activeCompanyId, setActiveCompanyIdState] = useState("");
  const [ready, setReady] = useState(false);
  const [accessNotice, setAccessNotice] = useState("");

  useEffect(() => {
    const timer = window.setTimeout(() => {
      const storedToken = window.localStorage.getItem(tokenKey) || "";
      const storedUser = window.localStorage.getItem(userKey);
      const storedActiveCompanyId = window.localStorage.getItem(activeCompanyKey) || "";
      setActiveCompanyIdState(storedActiveCompanyId);
      if (!storedToken) {
        window.localStorage.removeItem(userKey);
        window.localStorage.removeItem(activeCompanyKey);
        setActiveCompanyIdState("");
        setReady(true);
        return;
      }

      requestJson<{ user: AdminUser }>("/api/admin/me", { token: storedToken })
        .then((payload) => {
          setToken(storedToken);
          setUser(payload.user);
          window.localStorage.setItem(userKey, JSON.stringify(payload.user));
          if (payload.user.role !== "system_admin") {
            window.localStorage.removeItem(activeCompanyKey);
            setActiveCompanyIdState("");
          }
        })
        .catch((error: unknown) => {
          setToken("");
          setUser(null);
          setActiveCompanyIdState("");
          // Solo se descarta la sesion guardada si el backend la rechaza. Ante
          // errores de red o 5xx se conserva para reintentar al recargar.
          if (isApiError(error) && (error.status === 401 || error.status === 403)) {
            window.localStorage.removeItem(tokenKey);
            window.localStorage.removeItem(userKey);
            window.localStorage.removeItem(activeCompanyKey);
          }
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
    }>("/api/admin/login", {
      method: "POST",
      body: JSON.stringify({ email: cleanEmail, password }),
    });
    setToken(payload.access_token);
    setUser(payload.user);
    setAccessNotice("");
    setActiveCompanyIdState("");
    window.localStorage.setItem(tokenKey, payload.access_token);
    window.localStorage.setItem(userKey, JSON.stringify(payload.user));
    window.localStorage.removeItem(activeCompanyKey);
  }, []);

  const setActiveCompanyId = useCallback((companyId: string) => {
    const cleanCompanyId = companyId.trim();
    setActiveCompanyIdState(cleanCompanyId);
    if (cleanCompanyId) {
      window.localStorage.setItem(activeCompanyKey, cleanCompanyId);
    } else {
      window.localStorage.removeItem(activeCompanyKey);
    }
  }, []);

  const changePassword = useCallback(async (currentPassword: string, newPassword: string) => {
    const payload = await requestJson<{ user: AdminUser }>("/api/admin/password/change", {
      token,
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
    setAccessNotice("");
    setActiveCompanyIdState("");
    window.localStorage.removeItem(tokenKey);
    window.localStorage.removeItem(userKey);
    window.localStorage.removeItem(activeCompanyKey);
  }, [token]);

  const requestAuthorized = useCallback(
    async <T,>(path: string, init: { method?: string; body?: string } = {}) => {
      try {
        return await requestJson<T>(scopedReadPath(path, user, activeCompanyId), { ...init, token });
      } catch (error) {
        // 401: la sesion ya no es valida -> cerrar sesion.
        // 403: la sesion es valida pero el rol (o la IP) no tiene acceso a este
        // recurso -> avisar sin expulsar al usuario del panel.
        if (error instanceof ApiError && error.status === 401) {
          logout();
        } else if (error instanceof ApiError && error.status === 403) {
          setAccessNotice(ACCESS_RESTRICTED_MESSAGE);
        } else if (error instanceof ApiError && error.status === 428) {
          // 428: el backend exige cambiar la contrasena temporal antes de
          // continuar -> mostrar el formulario obligatorio de cambio.
          setUser((current) => (current ? { ...current, password_change_required: true } : current));
        }
        throw error;
      }
    },
    [activeCompanyId, logout, token, user],
  );

  const hasPermission = useCallback(
    (permission: string) => Boolean(user?.permissions?.includes(permission)),
    [user],
  );

  const clearAccessNotice = useCallback(() => setAccessNotice(""), []);

  const value = useMemo<AuthContextValue>(
    () => ({
      token,
      user,
      ready,
      activeCompanyId,
      setActiveCompanyId,
      login,
      changePassword,
      logout,
      hasPermission,
      accessNotice,
      clearAccessNotice,
      apiGet: <T,>(path: string) => requestAuthorized<T>(path),
      apiPost: <T,>(path: string, body: unknown) =>
        requestAuthorized<T>(path, {
          method: "POST",
          body: JSON.stringify(scopedWriteBody(path, body, user, activeCompanyId)),
        }),
      // Mismo alcance por empresa que apiPost (solo afecta rutas de companyScopedWritePaths).
      apiPatch: <T,>(path: string, body: unknown) =>
        requestAuthorized<T>(path, {
          method: "PATCH",
          body: JSON.stringify(scopedWriteBody(path, body, user, activeCompanyId)),
        }),
    }),
    [
      accessNotice,
      activeCompanyId,
      changePassword,
      clearAccessNotice,
      hasPermission,
      login,
      logout,
      ready,
      requestAuthorized,
      setActiveCompanyId,
      token,
      user,
    ],
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
    <div className="password-gate" role="dialog" aria-modal="true" aria-labelledby="password-gate-title">
      <form className="password-gate-panel" onSubmit={submitPasswordChange}>
        <header>
          <span>Credencial temporal</span>
          <h2 id="password-gate-title">Cambia tu contrasena para continuar</h2>
          <p>Tu acceso fue creado con una contrasena temporal. Define una nueva contrasena antes de usar el panel.</p>
        </header>
        <label>
          Contrasena temporal
          <input
            type="password"
            value={currentPassword}
            onChange={(event) => setCurrentPassword(event.target.value)}
            autoComplete="current-password"
            autoFocus
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
        <p className="password-gate-status" role="status" aria-live="polite" hidden={!statusText}>{statusText}</p>
        <button type="submit" disabled={!canSubmit}>
          {saving ? "Guardando..." : "Guardar y continuar"}
        </button>
      </form>
    </div>
  );
}
