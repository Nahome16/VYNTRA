"use client";

import { FormEvent, KeyboardEvent, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { useAuth } from "@/components/auth-provider";
import { usePreferences } from "@/components/preferences-provider";
import { classifyLoginError, isApiError, retryAfterMinutes } from "@/lib/api";

const rememberEmailKey = "vyntra.admin.rememberEmail";

type LoginAlert = {
  tone: "info" | "warning" | "error" | "success";
  title: string;
  message: string;
  field?: "email" | "password";
};

function loginGreeting(t: (text: string) => string, language: "es" | "en") {
  const now = new Date();
  const hour = now.getHours();
  const locale = language === "en" ? "en-US" : "es";
  const dateText = new Intl.DateTimeFormat(locale, {
    weekday: "long",
    day: "numeric",
    month: "long",
  })
    .format(now)
    .replace(",", "");
  const time = new Intl.DateTimeFormat(locale, { hour: "2-digit", minute: "2-digit", hour12: false }).format(now);
  const timestamp = `${dateText.charAt(0).toUpperCase()}${dateText.slice(1)} · ${time}`;
  if (hour < 12) {
    return { full: t("Buenos días."), first: t("Buenos"), second: t("días."), timestamp };
  }
  if (hour < 19) {
    return { full: t("Buenas tardes."), first: t("Buenas"), second: t("tardes."), timestamp };
  }
  return { full: t("Buenas noches."), first: t("Buenas"), second: t("noches."), timestamp };
}

function defaultLoginGreeting(t: (text: string) => string) {
  return { full: t("Buenas tardes."), first: t("Buenas"), second: t("tardes."), timestamp: "" };
}

function formatCountdown(seconds: number) {
  const minutes = Math.floor(seconds / 60);
  return `${minutes}:${String(seconds % 60).padStart(2, "0")}`;
}

function MailIcon() {
  return (
    <svg aria-hidden="true" viewBox="0 0 24 24" focusable="false">
      <path d="M4 7.5h16v9H4z" />
      <path d="m4.5 8 7.5 5.5L19.5 8" />
    </svg>
  );
}

function LockIcon() {
  return (
    <svg aria-hidden="true" viewBox="0 0 24 24" focusable="false">
      <path d="M7 10h10v9H7z" />
      <path d="M9 10V7a3 3 0 0 1 6 0v3" />
    </svg>
  );
}

function EyeIcon() {
  return (
    <svg aria-hidden="true" viewBox="0 0 24 24" focusable="false">
      <path d="M3.5 12s3-5 8.5-5 8.5 5 8.5 5-3 5-8.5 5-8.5-5-8.5-5Z" />
      <path d="M12 10a2 2 0 1 1 0 4 2 2 0 0 1 0-4Z" />
    </svg>
  );
}

function CalendarIcon() {
  return (
    <svg aria-hidden="true" viewBox="0 0 24 24" focusable="false">
      <path d="M5 7h14v12H5z" />
      <path d="M8 5v4M16 5v4M5 11h14" />
      <path d="m8.5 15 2 2 4-4" />
    </svg>
  );
}

export function LoginScreen() {
  const router = useRouter();
  const { login } = useAuth();
  const { t, theme, toggleTheme, language, toggleLanguage } = usePreferences();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [alert, setAlert] = useState<LoginAlert | null>(null);
  const [rememberEmail, setRememberEmail] = useState(true);
  const [showPassword, setShowPassword] = useState(false);
  const [capsLock, setCapsLock] = useState(false);
  const [showPasswordHelp, setShowPasswordHelp] = useState(false);
  const [greeting, setGreeting] = useState(() => defaultLoginGreeting(t));
  const [lockedUntil, setLockedUntil] = useState<number | null>(null);
  const [clockNow, setClockNow] = useState(() => Date.now());
  const [loading, setLoading] = useState(false);
  const emailRef = useRef<HTMLInputElement>(null);
  const passwordRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      try {
        const rememberedEmail = window.localStorage.getItem(rememberEmailKey) || "";
        if (rememberedEmail) {
          setEmail(rememberedEmail);
          setRememberEmail(true);
        }
      } catch {
        /* almacenamiento no disponible */
      }

      setGreeting(loginGreeting(t, language));
    }, 0);

    return () => window.clearTimeout(timer);
  }, [language, t]);

  useEffect(() => {
    if (!lockedUntil) return undefined;
    const interval = window.setInterval(() => setClockNow(Date.now()), 1000);
    return () => window.clearInterval(interval);
  }, [lockedUntil]);

  const lockSeconds = lockedUntil ? Math.max(0, Math.ceil((lockedUntil - clockNow) / 1000)) : 0;
  const locked = lockSeconds > 0;
  const busy = loading || locked;
  const alertMessage =
    locked && alert?.tone === "warning"
      ? `${t("Espera antes de volver a intentar.")} ${formatCountdown(lockSeconds)}`
      : alert?.message;

  useEffect(() => {
    if (!lockedUntil || locked) return;
    const timer = window.setTimeout(() => {
      setLockedUntil(null);
      setAlert(null);
    }, 0);
    return () => window.clearTimeout(timer);
  }, [locked, lockedUntil]);

  function persistRememberedEmail(cleanEmail: string) {
    try {
      if (rememberEmail) window.localStorage.setItem(rememberEmailKey, cleanEmail);
      else window.localStorage.removeItem(rememberEmailKey);
    } catch {
      /* almacenamiento no disponible */
    }
  }

  function updateCapsLock(event: KeyboardEvent<HTMLInputElement>) {
    setCapsLock(event.getModifierState("CapsLock"));
  }

  async function handleLogin(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    const cleanEmail = email.trim().toLowerCase();
    if (!cleanEmail) {
      setAlert({
        tone: "warning",
        title: t("Falta el correo"),
        message: t("Escribe el correo con el que te invitaron al panel."),
        field: "email",
      });
      emailRef.current?.focus();
      return;
    }
    if (!password) {
      setAlert({
        tone: "warning",
        title: t("Falta la contraseña"),
        message: t("Escribe tu contraseña para continuar."),
        field: "password",
      });
      passwordRef.current?.focus();
      return;
    }
    setLoading(true);
    setAlert({
      tone: "info",
      title: t("Validando credenciales"),
      message: t("Estamos comprobando tu acceso de administrador."),
    });
    try {
      await login(cleanEmail, password);
      persistRememberedEmail(cleanEmail);
      setAlert({
        tone: "success",
        title: t("Sesión activa"),
        message: t("Acceso confirmado. Abriendo el panel..."),
      });
      router.replace("/dashboard");
    } catch (error) {
      const kind = classifyLoginError(error);
      if (kind === "rate_limited") {
        const seconds = isApiError(error) ? error.retryAfter || 0 : 0;
        const minutes = retryAfterMinutes(error);
        if (seconds > 0) {
          setLockedUntil(Date.now() + seconds * 1000);
          setClockNow(Date.now());
        }
        setAlert({
          tone: "warning",
          title: t("Demasiados intentos"),
          message: seconds
            ? `${t("Espera antes de volver a intentar.")} ${formatCountdown(seconds)}`
            : minutes
            ? `${t("Espera antes de volver a intentar.")} ${t("Tiempo estimado")}: ${minutes} min.`
            : t("Espera unos minutos antes de volver a intentar."),
          field: "password",
        });
        passwordRef.current?.focus();
      } else if (kind === "server") {
        setAlert({
          tone: "error",
          title: t("Servidor no disponible"),
          message: t("El servidor no está disponible. Intenta de nuevo en unos minutos."),
        });
      } else if (kind === "network") {
        setAlert({
          tone: "error",
          title: t("Sin conexión"),
          message: t("Sin conexión con el servidor. Revisa tu red e intenta de nuevo."),
        });
      } else if (kind === "credentials") {
        setAlert({
          tone: "error",
          title: t("Credenciales incorrectas"),
          message: t("Revisa el correo y la contraseña. El correo se conserva para que puedas corregir solo lo necesario."),
          field: "password",
        });
        passwordRef.current?.focus();
      } else {
        setAlert({
          tone: "error",
          title: t("No se pudo iniciar sesión"),
          message: t("Intenta de nuevo. Si el problema continúa, contacta a soporte."),
        });
      }
    } finally {
      setLoading(false);
    }
  }

  return (
    <main className="login-shell">
      <div className="login-aurora" aria-hidden />
      <div className="login-floating-prefs" aria-label={t("Preferencias")}>
        <button
          type="button"
          className="pref-button icon"
          onClick={toggleTheme}
          title={theme === "dark" ? t("Cambiar a modo claro") : t("Cambiar a modo oscuro")}
          aria-label={theme === "dark" ? t("Cambiar a modo claro") : t("Cambiar a modo oscuro")}
        >
          {theme === "dark" ? "CL" : "OS"}
        </button>
        <button
          type="button"
          className="pref-button icon lang"
          onClick={toggleLanguage}
          title={t("Cambiar idioma")}
          aria-label={t("Cambiar idioma")}
        >
          {language === "es" ? "EN" : "ES"}
        </button>
      </div>
      <section className="login-card" aria-label={t("Acceso administrativo")}>
      <aside className="login-aside" aria-hidden>
        <div className="login-aside-aurora" aria-hidden>
          <i />
          <i />
          <i />
        </div>
        <svg className="login-ridges" viewBox="0 0 470 560" preserveAspectRatio="xMidYMid slice" aria-hidden>
          <defs>
            <linearGradient id="vyntra-login-hill" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0" stopColor="#1b6f77" stopOpacity="0.85" />
              <stop offset="1" stopColor="#081d20" stopOpacity="0" />
            </linearGradient>
            <filter id="vyntra-login-glow">
              <feGaussianBlur stdDeviation="3" />
            </filter>
          </defs>
          <path d="M-20 190 C70 170 120 150 180 138 C230 128 262 104 300 112 C350 122 400 170 490 178 L490 560 L-20 560Z" fill="url(#vyntra-login-hill)" opacity="0.75" />
          <path d="M-30 250 C80 230 150 214 220 200 C290 186 330 200 380 226 C420 246 450 250 500 252 L500 560 L-30 560Z" fill="url(#vyntra-login-hill)" opacity="0.55" />
          <path d="M0 190 C70 170 120 150 180 138 C230 128 262 104 300 112 C350 122 400 170 470 178" fill="none" stroke="#2ec4cb" strokeWidth="3" filter="url(#vyntra-login-glow)" opacity="0.8" />
          <path d="M0 190 C70 170 120 150 180 138 C230 128 262 104 300 112 C350 122 400 170 470 178" fill="none" stroke="#b8f1f3" strokeWidth="1.2" opacity="0.9" />
        </svg>
        <div className="login-aside-brand">
          <span className="brand-mark">V</span>
          <div>
            <strong>VYNTRA</strong>
            <small>{t("Control administrativo")}</small>
          </div>
        </div>
        <div className="login-wave" aria-hidden />
        <div className="login-aside-copy">
          <span>{greeting.timestamp}</span>
          <h2 aria-label={greeting.full}>
            {greeting.first}
            <strong>{greeting.second}</strong>
          </h2>
          <p>{t("Revisa la jornada de tu equipo, las incidencias pendientes y los reportes de tu empresa.")}</p>
        </div>
      </aside>

      <section className="login-panel">
        <div className="login-pref-row">
          <button
            type="button"
            className="pref-button icon"
            onClick={toggleTheme}
            title={theme === "dark" ? t("Cambiar a modo claro") : t("Cambiar a modo oscuro")}
            aria-label={theme === "dark" ? t("Cambiar a modo claro") : t("Cambiar a modo oscuro")}
          >
            {theme === "dark" ? "CL" : "OS"}
          </button>
          <button
            type="button"
            className="pref-button icon lang"
            onClick={toggleLanguage}
            title={t("Cambiar idioma")}
            aria-label={t("Cambiar idioma")}
          >
            {language === "es" ? "EN" : "ES"}
          </button>
        </div>
        <div className="login-mobile-brand">
          <span className="brand-mark">V</span>
          <div>
            <strong>VYNTRA</strong>
            <small>{t("Control administrativo")}</small>
          </div>
        </div>
        <h1>{t("Inicia sesión")}</h1>
        <p>{t("Usa el correo con el que te invitaron al panel.")}</p>
        {alert ? (
          <div
            className={`login-alert ${alert.tone}`}
            id="login-alert"
            role={alert.tone === "error" || alert.tone === "warning" ? "alert" : "status"}
            aria-live={alert.tone === "error" || alert.tone === "warning" ? "assertive" : "polite"}
          >
            <strong>{alert.title}</strong>
            <span>{alertMessage}</span>
          </div>
        ) : null}
        <form onSubmit={handleLogin} className="login-form" noValidate>
          <label className="login-field">
            <span className="login-input-icon"><MailIcon /></span>
            <span className="login-field-copy">
              <span>{t("Correo")}</span>
            <input
              ref={emailRef}
              type="email"
              name="email"
              value={email}
              onChange={(event) => {
                setEmail(event.target.value);
                if (alert?.field === "email") setAlert(null);
              }}
              autoComplete="username"
              inputMode="email"
              placeholder="nombre@empresa.com"
              disabled={busy}
              aria-invalid={alert?.field === "email" ? "true" : undefined}
              aria-describedby={alert?.field === "email" ? "login-alert" : undefined}
              required
            />
            </span>
          </label>
          <label className="login-field">
            <span className="login-input-icon"><LockIcon /></span>
            <span className="login-field-copy">
              <span>{t("Contraseña")}</span>
            <div className="login-password-wrap">
              <input
                ref={passwordRef}
                type={showPassword ? "text" : "password"}
                name="password"
                value={password}
                onChange={(event) => {
                  setPassword(event.target.value);
                  if (alert?.field === "password") setAlert(null);
                }}
                onKeyDown={updateCapsLock}
                onKeyUp={updateCapsLock}
                onBlur={() => setCapsLock(false)}
                autoComplete="current-password"
                placeholder={t("Tu contraseña")}
                disabled={busy}
                aria-invalid={alert?.field === "password" ? "true" : undefined}
                aria-describedby={alert?.field === "password" ? "login-alert" : capsLock ? "caps-lock-warning" : undefined}
                required
              />
              <button
                type="button"
                className="password-toggle"
                onClick={() => setShowPassword((current) => !current)}
                disabled={busy}
                aria-label={showPassword ? t("Ocultar contraseña") : t("Mostrar contraseña")}
              >
                <EyeIcon />
              </button>
            </div>
            </span>
          </label>
          {capsLock ? (
            <p className="caps-warning" id="caps-lock-warning" role="status">
              {t("Bloq Mayús está activado.")}
            </p>
          ) : null}
          <div className="login-options">
            <label className="remember-row">
              <input
                type="checkbox"
                checked={rememberEmail}
                onChange={(event) => {
                  setRememberEmail(event.target.checked);
                  if (!event.target.checked) {
                    try {
                      window.localStorage.removeItem(rememberEmailKey);
                    } catch {
                      /* almacenamiento no disponible */
                    }
                  }
                }}
              />
              <span>{t("Recordar mi correo")}</span>
            </label>
            <button type="button" onClick={() => setShowPasswordHelp((current) => !current)}>
              {t("¿Olvidaste tu contraseña?")}
            </button>
          </div>
          {showPasswordHelp ? (
            <div className="login-help-box">
              <strong>{t("Recuperación administrada")}</strong>
              <p>{t("Pide a un administrador del sistema que genere una contraseña temporal nueva desde Sistema.")}</p>
            </div>
          ) : null}
          <button type="submit" disabled={busy}>
            {loading ? (
              <>
                <span className="login-spinner" aria-hidden />
                {t("Validando...")}
              </>
            ) : locked ? (
              `${t("Disponible en")} ${formatCountdown(lockSeconds)}`
            ) : (
              t("Iniciar sesión")
            )}
          </button>
        </form>
        <div className="login-station-cta">
          <span>{t("¿No eres administrador?")}</span>
          <a href="/estacion">
            <CalendarIcon />
            {t("Marcar jornada en la Estación web")}
          </a>
        </div>
      </section>
      </section>
      <footer className="login-footer-links">
        <a href="/privacidad">{t("Privacidad")}</a>
        <span>© VYNTRA</span>
      </footer>
    </main>
  );
}
