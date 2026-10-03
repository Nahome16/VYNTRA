"use client";

import { FormEvent, KeyboardEvent, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { useAuth } from "@/components/auth-provider";
import { VyntraWordmark } from "@/components/brand";
import { usePreferences } from "@/components/preferences-provider";
import { classifyLoginError, isApiError, retryAfterMinutes } from "@/lib/api";
import styles from "./login-screen.module.css";

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
  const timestamp = `${dateText.charAt(0).toUpperCase()}${dateText.slice(1)}`;
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

function formatClock(date: Date) {
  return [date.getHours(), date.getMinutes(), date.getSeconds()].map((part) => String(part).padStart(2, "0")).join(":");
}

function cx(...names: Array<string | false | null | undefined>) {
  return names.filter(Boolean).join(" ");
}

function MailIcon() {
  return (
    <svg aria-hidden="true" viewBox="0 0 24 24" focusable="false">
      <rect x="3.5" y="5.5" width="17" height="13" rx="2.5" />
      <path d="m4.5 7.5 7.5 5.5 7.5-5.5" />
    </svg>
  );
}

function LockIcon() {
  return (
    <svg aria-hidden="true" viewBox="0 0 24 24" focusable="false">
      <rect x="5" y="10.5" width="14" height="9.5" rx="2.5" />
      <path d="M8.5 10.5V8a3.5 3.5 0 0 1 7 0v2.5" />
    </svg>
  );
}

function EyeIcon({ open }: { open: boolean }) {
  return (
    <svg aria-hidden="true" viewBox="0 0 24 24" focusable="false">
      <path d="M2.5 12s3.5-6 9.5-6 9.5 6 9.5 6-3.5 6-9.5 6-9.5-6-9.5-6Z" />
      <circle cx="12" cy="12" r="2.75" />
      {open ? null : <path d="M4 4l16 16" />}
    </svg>
  );
}

function SunIcon() {
  return (
    <svg aria-hidden="true" viewBox="0 0 24 24" focusable="false">
      <circle cx="12" cy="12" r="4" />
      <path d="M12 2.5v2M12 19.5v2M4.6 4.6 6 6M18 18l1.4 1.4M2.5 12h2M19.5 12h2M4.6 19.4 6 18M18 6l1.4-1.4" />
    </svg>
  );
}

function MoonIcon() {
  return (
    <svg aria-hidden="true" viewBox="0 0 24 24" focusable="false">
      <path d="M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5Z" />
    </svg>
  );
}

function GlobeIcon() {
  return (
    <svg aria-hidden="true" viewBox="0 0 24 24" focusable="false">
      <circle cx="12" cy="12" r="8.5" />
      <path d="M3.5 12h17M12 3.5c2.4 2.4 3.5 5.2 3.5 8.5s-1.1 6.1-3.5 8.5c-2.4-2.4-3.5-5.2-3.5-8.5s1.1-6.1 3.5-8.5Z" />
    </svg>
  );
}

function ClockInIcon() {
  return (
    <svg aria-hidden="true" viewBox="0 0 24 24" focusable="false">
      <circle cx="12" cy="13" r="7.5" />
      <path d="M12 9.5V13l2.5 1.5M9.5 2.5h5" />
    </svg>
  );
}

function ArrowIcon() {
  return (
    <svg aria-hidden="true" viewBox="0 0 24 24" focusable="false">
      <path d="M5 12h14M13 6l6 6-6 6" />
    </svg>
  );
}

function AlertIcon({ tone }: { tone: LoginAlert["tone"] }) {
  if (tone === "success") {
    return (
      <svg aria-hidden="true" viewBox="0 0 24 24" focusable="false">
        <circle cx="12" cy="12" r="8.5" />
        <path d="m8.5 12.5 2.5 2.5 4.5-5" />
      </svg>
    );
  }
  return (
    <svg aria-hidden="true" viewBox="0 0 24 24" focusable="false">
      <circle cx="12" cy="12" r="8.5" />
      <path d={tone === "info" ? "M12 11v5M12 8h.01" : "M12 7.5v5M12 16h.01"} />
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
  const [liveClock, setLiveClock] = useState("");
  const [loading, setLoading] = useState(false);
  const emailRef = useRef<HTMLInputElement>(null);
  const passwordRef = useRef<HTMLInputElement>(null);
  const refocusPassword = useRef(false);

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

  // Reloj en vivo del panel de marca; también alimenta la cuenta regresiva del bloqueo.
  useEffect(() => {
    const tick = () => {
      const now = new Date();
      setClockNow(now.getTime());
      setLiveClock(formatClock(now));
    };
    tick();
    const interval = window.setInterval(tick, 1000);
    return () => window.clearInterval(interval);
  }, []);

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

  // Los campos se deshabilitan mientras se valida; el foco se devuelve al reactivarse.
  useEffect(() => {
    if (busy || !refocusPassword.current) return;
    refocusPassword.current = false;
    passwordRef.current?.focus();
  }, [busy]);

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
        refocusPassword.current = true;
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
        refocusPassword.current = true;
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

  const themeLabel = theme === "dark" ? t("Cambiar a modo claro") : t("Cambiar a modo oscuro");

  return (
    <main className={styles.shell}>
      <aside className={styles.brand} aria-hidden>
        <div className={styles.glow} />
        <div className={styles.grid} />
        <div className={styles.brandTop}>
          <VyntraWordmark className={styles.logo} />
          <small>{t("Control administrativo")}</small>
        </div>

        <div className={styles.brandCopy}>
          <span className={styles.date}>{greeting.timestamp}</span>
          <h2>
            {greeting.first} <em>{greeting.second}</em>
          </h2>
          <p>{t("Revisa la jornada de tu equipo, las incidencias pendientes y los reportes de tu empresa.")}</p>
          <ul className={styles.features}>
            <li>{t("Asistencia en tiempo real")}</li>
            <li>{t("Incidencias y horas extra")}</li>
            <li>{t("Reportes por empresa")}</li>
          </ul>
        </div>

        <div className={styles.brandFoot}>
          <span className={styles.clock}>{liveClock || "--:--:--"}</span>
          <span className={styles.clockLabel}>
            <i className={styles.liveDot} />
            {t("Hora local")}
          </span>
        </div>
      </aside>

      <section className={styles.panel} aria-label={t("Acceso administrativo")}>
        <header className={styles.panelTop}>
          <div className={styles.mobileBrand}>
            <VyntraWordmark className={styles.mobileLogo} title="VYNTRA" />
          </div>
          <div className={styles.prefs} aria-label={t("Preferencias")}>
            <button type="button" className={styles.prefButton} onClick={toggleTheme} title={themeLabel} aria-label={themeLabel}>
              {theme === "dark" ? <SunIcon /> : <MoonIcon />}
            </button>
            <button
              type="button"
              className={cx(styles.prefButton, styles.prefLang)}
              onClick={toggleLanguage}
              title={t("Cambiar idioma")}
              aria-label={t("Cambiar idioma")}
            >
              <GlobeIcon />
              <span>{language === "es" ? "EN" : "ES"}</span>
            </button>
          </div>
        </header>

        <div className={styles.formWrap}>
          <div className={styles.heading}>
            <h1>{t("Inicia sesión")}</h1>
            <p>{t("Usa el correo con el que te invitaron al panel.")}</p>
          </div>

          {alert ? (
            <div
              className={cx(styles.alert, styles[alert.tone])}
              id="login-alert"
              role={alert.tone === "error" || alert.tone === "warning" ? "alert" : "status"}
              aria-live={alert.tone === "error" || alert.tone === "warning" ? "assertive" : "polite"}
            >
              <AlertIcon tone={alert.tone} />
              <div>
                <strong>{alert.title}</strong>
                <span>{alertMessage}</span>
              </div>
            </div>
          ) : null}

          <form onSubmit={handleLogin} className={styles.form} noValidate>
            <div className={styles.field}>
              <label htmlFor="login-email">{t("Correo")}</label>
              <div className={styles.control}>
                <span className={styles.controlIcon}>
                  <MailIcon />
                </span>
                <input
                  ref={emailRef}
                  id="login-email"
                  type="email"
                  name="email"
                  value={email}
                  onChange={(event) => {
                    setEmail(event.target.value);
                    if (alert?.field === "email") setAlert(null);
                  }}
                  autoComplete="username"
                  autoCapitalize="none"
                  spellCheck={false}
                  inputMode="email"
                  placeholder="nombre@empresa.com"
                  disabled={busy}
                  aria-invalid={alert?.field === "email" ? "true" : undefined}
                  aria-describedby={alert?.field === "email" ? "login-alert" : undefined}
                  required
                />
              </div>
            </div>

            <div className={styles.field}>
              <div className={styles.labelRow}>
                <label htmlFor="login-password">{t("Contraseña")}</label>
                <button
                  type="button"
                  className={styles.textButton}
                  onClick={() => setShowPasswordHelp((current) => !current)}
                  aria-expanded={showPasswordHelp}
                  aria-controls="login-password-help"
                >
                  {t("¿Olvidaste tu contraseña?")}
                </button>
              </div>
              <div className={styles.control}>
                <span className={styles.controlIcon}>
                  <LockIcon />
                </span>
                <input
                  ref={passwordRef}
                  id="login-password"
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
                  className={styles.reveal}
                  onClick={() => setShowPassword((current) => !current)}
                  disabled={busy}
                  aria-pressed={showPassword}
                  aria-label={showPassword ? t("Ocultar contraseña") : t("Mostrar contraseña")}
                  title={showPassword ? t("Ocultar contraseña") : t("Mostrar contraseña")}
                >
                  <EyeIcon open={!showPassword} />
                </button>
              </div>
              {capsLock ? (
                <p className={styles.caps} id="caps-lock-warning" role="status">
                  {t("Bloq Mayús está activado.")}
                </p>
              ) : null}
            </div>

            {showPasswordHelp ? (
              <div className={styles.help} id="login-password-help">
                <strong>{t("Recuperación administrada")}</strong>
                <p>{t("Pide a un administrador del sistema que genere una contraseña temporal nueva desde Sistema.")}</p>
              </div>
            ) : null}

            <label className={styles.remember}>
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

            <button type="submit" className={styles.submit} disabled={busy} aria-busy={loading || undefined}>
              {loading ? (
                <>
                  <span className={styles.spinner} aria-hidden />
                  {t("Validando...")}
                </>
              ) : locked ? (
                `${t("Disponible en")} ${formatCountdown(lockSeconds)}`
              ) : (
                t("Iniciar sesión")
              )}
            </button>
          </form>

          <div className={styles.divider}>
            <span>{t("¿No eres administrador?")}</span>
          </div>

          <a className={styles.station} href="/estacion">
            <span className={styles.stationIcon}>
              <ClockInIcon />
            </span>
            <span className={styles.stationCopy}>
              <strong>{t("Marcar jornada en la Estación web")}</strong>
              <small>{t("Registra tu entrada y salida sin entrar al panel.")}</small>
            </span>
            <span className={styles.stationArrow}>
              <ArrowIcon />
            </span>
          </a>
        </div>

        <footer className={styles.footer}>
          <span>{t("Sesión protegida por empresa y rol")}</span>
          <nav aria-label={t("Enlaces legales")}>
            <a href="/privacidad">{t("Privacidad")}</a>
            <span>© {new Date().getFullYear()} VYNTRA</span>
          </nav>
        </footer>
      </section>
    </main>
  );
}
