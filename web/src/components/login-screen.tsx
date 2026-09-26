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

  const previewRows = [
    { name: "Ana L.", work: 62, brk: 8, lunch: 12, idle: 6 },
    { name: "Luis G.", work: 70, brk: 6, lunch: 12, idle: 4 },
    { name: "Marta R.", work: 48, brk: 10, lunch: 12, idle: 14 },
  ];

  return (
    <main className="login-shell">
      <aside className="login-aside" aria-hidden>
        <div className="login-aside-brand">
          <span className="brand-mark">V</span>
          <strong>VYNTRA</strong>
        </div>
        <div className="login-aside-copy">
          <h2>{t("La jornada de tu equipo, clara y verificable.")}</h2>
          <ul>
            <li>{t("Registro de jornada igual para modalidad presencial, remota e hibrida")}</li>
            <li>{t("Productividad medida con reglas por departamento y rol")}</li>
            <li>{t("Privacidad por diseno: sin teclas, sin camara, sin titulos de ventana")}</li>
          </ul>
        </div>
        <div className="login-aside-preview">
          <div className="login-aside-preview-head">
            <span className="live-dot" />
            <span>{t("Jornada de hoy")}</span>
          </div>
          {previewRows.map((row) => (
            <div className="login-aside-row" key={row.name}>
              <span>{row.name}</span>
              <div className="shift-bar">
                <i className="seg-work" style={{ width: `${row.work}%` }} />
                <i className="seg-break" style={{ width: `${row.brk}%` }} />
                <i className="seg-lunch" style={{ width: `${row.lunch}%` }} />
                <i className="seg-idle" style={{ width: `${row.idle}%` }} />
              </div>
            </div>
          ))}
        </div>
      </aside>

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
        <h1>{t("Inicia sesion")}</h1>
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
              placeholder="nombre@empresa.com"
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
