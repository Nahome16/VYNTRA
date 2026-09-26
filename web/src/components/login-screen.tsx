"use client";

import { FormEvent, useState } from "react";
import { useRouter } from "next/navigation";
import { useAuth } from "@/components/auth-provider";
import { usePreferences } from "@/components/preferences-provider";
import { classifyLoginError, retryAfterMinutes } from "@/lib/api";

export function LoginScreen() {
  const router = useRouter();
  const { login } = useAuth();
  const { t, theme, toggleTheme, language, toggleLanguage } = usePreferences();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [statusText, setStatusText] = useState("");
  const [loading, setLoading] = useState(false);

  async function handleLogin(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!email.trim() || !password) {
      setStatusText(t("Ingresa correo y contrasena"));
      return;
    }
    setLoading(true);
    setStatusText(t("Validando credenciales..."));
    try {
      await login(email, password);
      setStatusText(t("Sesion activa"));
      router.replace("/dashboard");
    } catch (error) {
      const kind = classifyLoginError(error);
      if (kind === "rate_limited") {
        const minutes = retryAfterMinutes(error);
        setStatusText(
          minutes
            ? `${t("Demasiados intentos. Espera antes de volver a intentar.")} (${minutes} min)`
            : t("Demasiados intentos. Espera antes de volver a intentar."),
        );
      } else if (kind === "server") {
        setStatusText(t("El servidor no esta disponible. Intenta de nuevo en unos minutos."));
      } else if (kind === "network") {
        setStatusText(t("Sin conexion con el servidor. Revisa tu red e intenta de nuevo."));
      } else if (kind === "credentials") {
        setStatusText(t("Credenciales incorrectas"));
      } else {
        setStatusText(t("No se pudo iniciar sesion. Intenta de nuevo."));
      }
    } finally {
      setLoading(false);
    }
  }

  return (
    <main className="login-shell">
      <section className="login-panel">
        <div className="login-pref-row">
          <button
            type="button"
            className="pref-button"
            onClick={toggleTheme}
            title={theme === "dark" ? t("Cambiar a modo claro") : t("Cambiar a modo oscuro")}
          >
            {theme === "dark" ? t("Modo claro") : t("Modo oscuro")}
          </button>
          <button
            type="button"
            className="pref-button lang"
            onClick={toggleLanguage}
            title={t("Cambiar idioma")}
          >
            {language === "es" ? "EN" : "ES"}
          </button>
        </div>
        <div className="brand-mark">V</div>
        <h1>VYNTRA Control</h1>
        <p>{t("Ingreso administrativo por empresa para revisar operaciones, equipos y reporteria.")}</p>
        <form onSubmit={handleLogin} className="login-form">
          <label>
            {t("Correo")}
            <input
              type="email"
              name="email"
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              autoComplete="username"
              inputMode="email"
              required
            />
          </label>
          <label>
            {t("Contrasena")}
            <input
              type="password"
              name="password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              autoComplete="current-password"
              required
            />
          </label>
          <button type="submit" disabled={loading}>
            {loading ? t("Validando...") : t("Iniciar sesion")}
          </button>
        </form>
        <span className="status-line" role="status" aria-live="polite">{statusText || t("Sesion protegida por empresa y rol")}</span>
      </section>
    </main>
  );
}
