"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { ReactNode, useEffect, useState } from "react";
import { useAuth } from "@/components/auth-provider";
import { usePreferences } from "@/components/preferences-provider";

const iconProps = {
  viewBox: "0 0 24 24",
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 1.7,
  strokeLinecap: "round" as const,
  strokeLinejoin: "round" as const,
  "aria-hidden": true,
};

const navItems = [
  {
    href: "/sistema",
    label: "Sistema",
    permission: "system:manage",
    icon: (
      <svg {...iconProps}>
        <path d="M12 3 4 7v6c0 4 3.2 7.1 8 8 4.8-.9 8-4 8-8V7z" />
        <path d="M9 12h6M12 9v6" />
      </svg>
    ),
  },
  {
    href: "/dashboard",
    label: "Dashboard",
    permission: "dashboard:read",
    icon: (
      <svg {...iconProps}>
        <path d="M3 13h7V3H3zM14 21h7V11h-7zM14 8h7V3h-7zM3 21h7v-5H3z" />
      </svg>
    ),
  },
  {
    href: "/empleados",
    label: "Empleados",
    permission: "employees:read",
    icon: (
      <svg {...iconProps}>
        <path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" />
        <circle cx="9" cy="7" r="4" />
        <path d="M22 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75" />
      </svg>
    ),
  },
  {
    href: "/asistencia",
    label: "Asistencia",
    permission: "attendance:read",
    icon: (
      <svg {...iconProps}>
        <rect x="3" y="4" width="18" height="18" rx="2" />
        <path d="M16 2v4M8 2v4M3 10h18M9 16l2 2 4-4" />
      </svg>
    ),
  },
  {
    href: "/dispositivos",
    label: "Dispositivos",
    permission: "devices:read",
    icon: (
      <svg {...iconProps}>
        <rect x="4" y="5" width="16" height="12" rx="2" />
        <path d="M8 21h8M12 17v4M9 9h6" />
      </svg>
    ),
  },
  {
    href: "/descargas",
    label: "Descargas",
    permission: "devices:manage",
    icon: (
      <svg {...iconProps}>
        <path d="M12 3v11" />
        <path d="m7 10 5 5 5-5" />
        <path d="M5 21h14" />
      </svg>
    ),
  },
  {
    href: "/incidencias",
    label: "Incidencias",
    permission: "incidents:read",
    icon: (
      <svg {...iconProps}>
        <path d="M12 9v4M12 17h.01" />
        <path d="M10.3 4.3 2.8 17.2A2 2 0 0 0 4.5 20h15a2 2 0 0 0 1.7-2.8L13.7 4.3a2 2 0 0 0-3.4 0z" />
      </svg>
    ),
  },
  {
    href: "/auditoria",
    label: "Auditoria",
    permission: "audit:read",
    icon: (
      <svg {...iconProps}>
        <path d="M9 11h6M9 15h6" />
        <path d="M8 3h8l3 3v15H5V3z" />
        <path d="M16 3v4h4" />
      </svg>
    ),
  },
  {
    href: "/ajustes",
    label: "Ajustes",
    permission: "settings:manage",
    icon: (
      <svg {...iconProps}>
        <circle cx="12" cy="12" r="3" />
        <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.6a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
      </svg>
    ),
  },
];

export function AppShell({
  title,
  description,
  actions,
  children,
}: {
  title: string;
  description: string;
  actions?: ReactNode;
  children: ReactNode;
}) {
  const pathname = usePathname();
  const router = useRouter();
  const { ready, user, logout, apiGet } = useAuth();
  const { t, theme, toggleTheme, language, toggleLanguage } = usePreferences();
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [noticeMessages, setNoticeMessages] = useState<Array<{ type: string; message: string }>>([]);
  const darkOn = theme === "dark";

  useEffect(() => {
    if (ready && !user) router.replace("/login");
  }, [ready, router, user]);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      if (!ready || !user || user.role === "system_admin") {
        setNoticeMessages([]);
        return;
      }
      apiGet<{ messages: Array<{ type: string; message: string }> }>("/api/admin/company-notice")
        .then((response) => setNoticeMessages(response.messages))
        .catch(() => setNoticeMessages([]));
    }, 0);
    return () => window.clearTimeout(timer);
  }, [apiGet, ready, user]);

  if (!ready || !user) {
    return (
      <main className="loading-shell">
        <div className="brand-mark">V</div>
      </main>
    );
  }

  return (
    <main className={`app-shell ${sidebarOpen ? "sidebar-open" : ""}`}>
      <button
        type="button"
        className="sidebar-backdrop"
        aria-label={t("Cerrar menu")}
        onClick={() => setSidebarOpen(false)}
      />

      <aside className="sidebar" aria-label={t("Navegacion principal")}>
        <div className="sidebar-head">
          <div className="brand-row">
            <div className="brand-mark">V</div>
            <div>
              <strong>VYNTRA</strong>
              <span>Control</span>
            </div>
          </div>

          <button
            type="button"
            className="shell-icon-button sidebar-close"
            aria-label={t("Cerrar menu")}
            onClick={() => setSidebarOpen(false)}
          >
            <svg {...iconProps}>
              <path d="M18 6 6 18M6 6l12 12" />
            </svg>
          </button>
        </div>

        <nav>
          {navItems
            .filter((item) => (user.permissions || []).includes(item.permission))
            .map((item) => (
            <Link
              href={item.href}
              key={item.href}
              aria-current={pathname.startsWith(item.href) ? "page" : undefined}
              className={pathname.startsWith(item.href) ? "active" : ""}
              onClick={() => setSidebarOpen(false)}
            >
              {item.icon}
              {t(item.label)}
            </Link>
          ))}
        </nav>

        <div className="user-box">
          <span>{user.company}</span>
          <strong>{user.full_name}</strong>
          <small>{user.email} · {user.role}</small>
          <button className="ghost-button" onClick={logout}>{t("Salir")}</button>
        </div>
      </aside>

      <section className="content">
        <header className="topbar">
          <div className="topbar-heading">
            <button
              type="button"
              className="shell-icon-button mobile-menu-button"
              aria-label={t("Abrir menu")}
              aria-expanded={sidebarOpen}
              onClick={() => setSidebarOpen(true)}
            >
              <svg {...iconProps}>
                <path d="M4 7h16M4 12h16M4 17h16" />
              </svg>
            </button>
            <div>
              <h1>{title}</h1>
              <p>{description}</p>
            </div>
          </div>

          <div className="topbar-actions">
            <button
              type="button"
              className="shell-icon-button"
              onClick={toggleTheme}
              aria-pressed={darkOn}
              aria-label={darkOn ? t("Cambiar a modo claro") : t("Cambiar a modo oscuro")}
              title={darkOn ? t("Cambiar a modo claro") : t("Cambiar a modo oscuro")}
            >
              {darkOn ? (
                <svg {...iconProps}>
                  <circle cx="12" cy="12" r="4.2" />
                  <path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" />
                </svg>
              ) : (
                <svg {...iconProps}>
                  <path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z" />
                </svg>
              )}
            </button>

            <button
              type="button"
              className="shell-icon-button lang"
              onClick={toggleLanguage}
              title={t("Cambiar idioma")}
              aria-label={t("Cambiar idioma")}
            >
              <svg {...iconProps}>
                <circle cx="12" cy="12" r="9" />
                <path d="M3 12h18M12 3a15 15 0 0 1 0 18M12 3a15 15 0 0 0 0 18" />
              </svg>
              <span>{language === "es" ? "ES" : "EN"}</span>
            </button>

            {actions ? <div className="page-actions">{actions}</div> : null}
          </div>
        </header>
        {noticeMessages.length ? (
          <div className="system-notice-stack" role="status" aria-live="polite">
            {noticeMessages.map((notice, index) => (
              <p className={`system-notice system-notice-${notice.type}`} key={`${notice.type}-${index}`}>
                {notice.message}
              </p>
            ))}
          </div>
        ) : null}
        {children}
      </section>
    </main>
  );
}
