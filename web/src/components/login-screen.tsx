"use client";

import { FormEvent, useState } from "react";
import { useRouter } from "next/navigation";
import { useAuth } from "@/components/auth-provider";
import { usePreferences } from "@/components/preferences-provider";

export function LoginScreen() {
  const router = useRouter();
  const { login } = useAuth();
  const { t, theme, toggleTheme, language, toggleLanguage } = usePreferences();
  const [email, setEmail] = useState("admin@vyntra.local");
  const [password, setPassword] = useState("Vyntra2026");
  const [statusText, setStatusText] = useState("");
  const [loading, setLoading] = useState(false);

  async function handleLogin(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setLoading(true);
    setStatusText(t("Validando credenciales..."));
    try {
      await login(email, password);
      setStatusText(t("Sesion activa"));
      router.replace("/dashboard");
    } catch {
      setStatusText(t("Credenciales incorrectas"));
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
            <input value={email} onChange={(event) => setEmail(event.target.value)} />
          </label>
          <label>
            {t("Contrasena")}
            <input
              type="password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
            />
          </label>
          <button type="submit" disabled={loading}>
            {loading ? t("Validando...") : t("Iniciar sesion")}
          </button>
        </form>
        <span className="status-line">{statusText || t("Sesion protegida por empresa y rol")}</span>
      </section>
    </main>
  );
}
