"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { ReactNode, useEffect, useState } from "react";
import { useAuth } from "@/components/auth-provider";
import { usePreferences } from "@/components/preferences-provider";
import { requiredPermissionFor } from "@/lib/permissions";
import { SystemCompany, SystemOverviewResponse } from "@/lib/types";

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
    icon: (
      <svg {...iconProps}>
        <path d="M3 13h7V3H3zM14 21h7V11h-7zM14 8h7V3h-7zM3 21h7v-5H3z" />
      </svg>
    ),
  },
  {
    href: "/empleados",
    label: "Empleados",
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
    icon: (
      <svg {...iconProps}>
        <rect x="3" y="4" width="18" height="18" rx="2" />
        <path d="M16 2v4M8 2v4M3 10h18M9 16l2 2 4-4" />
      </svg>
    ),
  },
  {
    href: "/incidencias",
    label: "Incidencias",
    icon: (
      <svg {...iconProps}>
        <path d="M12 9v4" />
        <path d="M12 17h.01" />
        <path d="M10.3 3.9 2.4 17.5A2 2 0 0 0 4.1 20h15.8a2 2 0 0 0 1.7-2.5L13.7 3.9a2 2 0 0 0-3.4 0z" />
      </svg>
    ),
  },
  {
    href: "/dispositivos",
    label: "Dispositivos",
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
    icon: (
      <svg {...iconProps}>
        <path d="M12 3v11" />
        <path d="m7 10 5 5 5-5" />
        <path d="M5 21h14" />
      </svg>
    ),
  },
  {
    href: "/auditoria",
    label: "Auditoria",
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
    icon: (
      <svg {...iconProps}>
        <circle cx="12" cy="12" r="3" />
        <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.6a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
      </svg>
    ),
  },
];

const operationRoutes = new Set(["/dashboard", "/asistencia", "/empleados", "/incidencias", "/dispositivos"]);
const configRoutes = new Set(["/ajustes", "/descargas"]);
const consoleRoutes = new Set(["/sistema", "/auditoria"]);

const roleLabels: Record<string, string> = {
  system_admin: "Admin del sistema",
  owner: "Propietario",
  admin: "Administrador",
  rrhh: "RR. HH.",
  supervisor: "Supervisor",
  viewer: "Solo lectura",
};

function initials(name: string) {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  return ((parts[0]?.[0] || "") + (parts[1]?.[0] || "")).toUpperCase() || "V";
}

export function AppShell({
  title,
  description,
  actions,
  status,
  children,
}: {
  title: string;
  description: string;
  actions?: ReactNode;
  status?: ReactNode;
  children: ReactNode;
}) {
  const pathname = usePathname();
  const router = useRouter();
  const {
    ready,
    user,
    logout,
    apiGet,
    accessNotice,
    clearAccessNotice,
    activeCompanyId,
    activeCompanyName,
    setActiveCompanyId,
  } = useAuth();
  const { t, theme, toggleTheme, language, toggleLanguage } = usePreferences();
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [noticeMessages, setNoticeMessages] = useState<Array<{ type: string; message: string }>>([]);
  const [companies, setCompanies] = useState<SystemCompany[]>([]);
  const darkOn = theme === "dark";

  useEffect(() => {
    if (ready && !user) router.replace("/login");
  }, [ready, router, user]);

  // El aviso de "Acceso restringido" (403) pertenece a la vista donde ocurrio.
  useEffect(() => {
    const timer = window.setTimeout(() => clearAccessNotice(), 0);
    return () => window.clearTimeout(timer);
  }, [clearAccessNotice, pathname]);

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

  useEffect(() => {
    if (!ready || !user || user.role !== "system_admin") return;
    const timer = window.setTimeout(() => {
      apiGet<SystemOverviewResponse>("/api/system/overview")
        .then((response) => {
          const activeCompanies = response.companies.filter((company) => company.status === "active");
          setCompanies(activeCompanies);
          const current = activeCompanies.find((company) => company.id === activeCompanyId);
          if (current) {
            setActiveCompanyId(current.id, current.name);
            return;
          }
          const first = activeCompanies[0];
          if (first) setActiveCompanyId(first.id, first.name);
        })
        .catch(() => setCompanies([]));
    }, 0);
    return () => window.clearTimeout(timer);
  }, [activeCompanyId, apiGet, ready, setActiveCompanyId, user]);

  if (!ready || !user) {
    return (
      <main className="loading-shell">
        <div className="brand-mark">V</div>
      </main>
    );
  }

  const allowed = navItems.filter((item) => {
    const permission = requiredPermissionFor(item.href);
    return !permission || (user.permissions || []).includes(permission);
  });
  const isSystemAdmin = user.role === "system_admin";
  const operationGroup = { label: "Operacion", items: allowed.filter((item) => operationRoutes.has(item.href)) };
  const configGroup = { label: "Configuracion", items: allowed.filter((item) => configRoutes.has(item.href)) };
  const consoleGroup = { label: isSystemAdmin ? "Consola" : "Administracion", items: allowed.filter((item) => consoleRoutes.has(item.href)) };
  const navGroups = (isSystemAdmin ? [operationGroup, configGroup, consoleGroup] : [operationGroup, configGroup, consoleGroup]).filter(
    (group) => group.items.length,
  );
  const scopeName = isSystemAdmin ? activeCompanyName : user.company;
  const scope = pathname.startsWith("/sistema") ? "system" : "company";
  const breadcrumbRoot = scopeName || (isSystemAdmin ? "Sistema" : user.company);
  const breadcrumb = breadcrumbRoot ? `${breadcrumbRoot} / ${title}` : title;

  return (
    <main className={`app-shell ${sidebarOpen ? "sidebar-open" : ""}`} data-scope={scope}>
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

        {isSystemAdmin ? (
          <label className="scope-selector">
            <span>{t("Empresa activa")}</span>
            <select
              value={activeCompanyId}
              onChange={(event) => {
                const company = companies.find((item) => item.id === event.target.value);
                setActiveCompanyId(event.target.value, company?.name);
              }}
              disabled={!companies.length}
              aria-label={t("Empresa activa")}
            >
              {companies.length ? companies.map((company) => (
                <option key={company.id} value={company.id}>
                  {company.name} · {company.controls.subscription_status === "past_due" ? t("Vencida") : `${company.employees_count}/${company.controls.employee_limit} ${t("licencias")}`}
                </option>
              )) : <option value="">{t("Cargando empresas")}</option>}
            </select>
          </label>
        ) : null}

        <nav>
          {navGroups.map((group) => (
            <div className="nav-group" key={group.label}>
              <span className="nav-group-label">{t(group.label)}</span>
              {group.label === "Operacion" && scopeName ? (
                <div className="scope-chip" title={scopeName}>
                  <i aria-hidden />
                  <span>{scopeName}</span>
                </div>
              ) : null}
              {group.items.map((item) => (
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
            </div>
          ))}
        </nav>

        <div className="sidebar-footer">
          <div className="user-chip">
            <span className="avatar" aria-hidden>{initials(user.full_name || user.email)}</span>
            <div>
              <strong title={user.full_name}>{user.full_name}</strong>
              <small title={user.email}>{t(roleLabels[user.role] || user.role)}</small>
            </div>
          </div>
          <div className="sidebar-tools">
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
            <button
              type="button"
              className="shell-icon-button logout"
              onClick={logout}
              title={t("Salir")}
              aria-label={t("Salir")}
              style={{ marginLeft: "auto" }}
            >
              <svg {...iconProps}>
                <path d="M15 4h3a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2h-3M10 17l5-5-5-5M15 12H4" />
              </svg>
            </button>
          </div>
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
              <span className="topbar-breadcrumb">{breadcrumb}</span>
              <h1>{title}</h1>
              <p>{description}</p>
            </div>
          </div>

          <div className="topbar-actions">
            {status ? <span className="sync-status">{status}</span> : null}
            {actions ? <div className="page-actions">{actions}</div> : null}
          </div>
        </header>
        {accessNotice ? (
          <div className="system-notice-stack" role="status" aria-live="polite">
            <p className="system-notice system-notice-warning">
              {t(accessNotice)}{" "}
              <button type="button" className="system-notice-dismiss" onClick={clearAccessNotice} aria-label={t("Cerrar aviso")}>
                ×
              </button>
            </p>
          </div>
        ) : null}
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
