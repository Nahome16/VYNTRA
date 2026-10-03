"use client";

import { FormEvent, KeyboardEvent, ReactNode, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AppShell } from "@/components/app-shell";
import {
  AttentionList,
  Chip,
  Drawer,
  EmptyBlock,
  MenuItem,
  MetricBand,
  RefreshButton,
  RowMenu,
  StatusLine,
  Tabs,
  UsageBar,
} from "@/components/ui";
import { useAuth } from "@/components/auth-provider";
import { usePreferences } from "@/components/preferences-provider";
import { todayISO } from "@/lib/dates";
import { PanelUser, SystemCompany, SystemOverviewResponse } from "@/lib/types";
import styles from "./sistema.module.css";

type PanelRole = "system_admin" | "owner" | "admin" | "rrhh" | "supervisor" | "viewer";
type SubscriptionStatus = SystemCompany["controls"]["subscription_status"];
type Tone = "plain" | "good" | "warn" | "bad" | "accent" | "info";
type Translate = (text: string) => string;
type Credential = {
  email: string;
  password?: string;
  delivery_status?: string;
  password_change_required?: boolean;
};
type CompanyFilter = "all" | "active" | "attention" | "archived";
type DetailTab = "summary" | "users" | "plan" | "risk";
type DrawerKind = "company" | "invite" | "user" | null;

const roleLabels: Record<string, string> = {
  system_admin: "Administrador del sistema",
  owner: "Owner de empresa",
  admin: "Administrador de empresa",
  rrhh: "RR. HH.",
  supervisor: "Supervisor",
  viewer: "Solo lectura",
};

const roleHelp: Record<PanelRole, string> = {
  system_admin: "Control global multitenant. Solo para proveedor del sistema.",
  owner: "Control total dentro de su empresa, sin acceso a la consola sistema.",
  admin: "Administra usuarios monitoreados, reglas, asistencia, incidencias y accesos.",
  rrhh: "Gestiona empleados, asistencia, incidencias y codigos operativos.",
  supervisor: "Consulta dashboard, empleados, asistencia e incidencias sin modificar.",
  viewer: "Solo lectura para auditoria operativa.",
};

const subscriptionLabels: Record<SubscriptionStatus, string> = {
  active: "Activa",
  trial: "Prueba",
  past_due: "Pago pendiente",
  suspended: "Suspendida",
  cancelled: "Cancelada",
};

const timezoneOptions = [
  "America/Managua",
  "America/Costa_Rica",
  "America/Guatemala",
  "America/Tegucigalpa",
  "America/El_Salvador",
  "America/Panama",
  "America/Bogota",
  "America/Lima",
  "America/Guayaquil",
  "America/Mexico_City",
  "America/Cancun",
  "America/Monterrey",
  "America/Santo_Domingo",
  "America/Puerto_Rico",
  "America/Caracas",
  "America/La_Paz",
  "America/Santiago",
  "America/Argentina/Buenos_Aires",
  "America/Montevideo",
  "America/Asuncion",
  "America/New_York",
  "America/Chicago",
  "America/Denver",
  "America/Los_Angeles",
  "America/Phoenix",
  "America/Anchorage",
  "Pacific/Honolulu",
  "UTC",
  "Europe/Madrid",
];

/** Días del ciclo de suscripción a partir de los cuales se avisa del vencimiento. */
const EXPIRY_WARNING_DAYS = 30;

function deliveryText(status?: string) {
  if (status === "sent") return "Credencial enviada por correo.";
  if (status === "queued") return "Credencial creada. El correo se enviara en segundo plano.";
  if (status === "failed") return "Credencial creada, pero el correo fallo.";
  return "Credencial creada. Entrega pendiente de configuracion SMTP.";
}

/** Sustituye `{clave}` en un texto ya traducido. */
function fill(text: string, values: Record<string, string | number>) {
  return text.replace(/\{(\w+)\}/g, (_, key: string) => String(values[key] ?? ""));
}

function initials(name: string) {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return "?";
  return `${parts[0][0] || ""}${parts.length > 1 ? parts[parts.length - 1][0] : ""}`.toUpperCase();
}

function normalize(value: string) {
  return value
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase();
}

/** Días naturales entre hoy y una fecha YYYY-MM-DD (negativo si ya pasó). */
function daysUntil(date: string, today: string) {
  if (!date) return null;
  const target = Date.parse(`${date.slice(0, 10)}T00:00:00Z`);
  const base = Date.parse(`${today}T00:00:00Z`);
  if (!Number.isFinite(target) || !Number.isFinite(base)) return null;
  return Math.round((target - base) / 86_400_000);
}

function formatDay(date: string, locale: string) {
  if (!date) return "";
  const value = new Date(`${date.slice(0, 10)}T12:00:00`);
  if (!Number.isFinite(value.getTime())) return date;
  return value.toLocaleDateString(locale, { day: "numeric", month: "short", year: "numeric" });
}

function formatDateTime(value: string | null, locale: string) {
  if (!value) return "";
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return value;
  return date.toLocaleString(locale, { day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" });
}

function isArchived(company: SystemCompany) {
  return company.status === "archived";
}

/** Estado comercial legible de una empresa: chip + detalle. */
function subscriptionState(company: SystemCompany, today: string, t: Translate): { tone: Tone; label: string; attention: boolean } {
  if (isArchived(company)) return { tone: "plain", label: t("Archivada"), attention: false };
  const status = company.controls.subscription_status || "active";
  if (status === "suspended") return { tone: "bad", label: t("Suspendida"), attention: true };
  if (status === "cancelled") return { tone: "bad", label: t("Cancelada"), attention: true };
  const days = daysUntil(company.controls.subscription_ends_at, today);
  if (days !== null && days < 0) return { tone: "bad", label: t("Vencida"), attention: true };
  if (status === "past_due") return { tone: "warn", label: t("Pago pendiente"), attention: true };
  if (days !== null && days <= EXPIRY_WARNING_DAYS) {
    const label = days === 0 ? t("Vence hoy") : days === 1 ? t("Vence mañana") : fill(t("Vence en {n} días"), { n: days });
    return { tone: "warn", label, attention: true };
  }
  if (status === "trial") return { tone: "info", label: t("Prueba"), attention: false };
  return { tone: "good", label: t("Activa"), attention: false };
}

function planText(company: SystemCompany, t: Translate) {
  const limit = company.controls.employee_limit;
  if (!limit) return fill(t("{n} empleados · sin límite"), { n: company.employees_count });
  return fill(t("{n} de {limit} empleados"), { n: company.employees_count, limit });
}

const icons = {
  plus: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" aria-hidden>
      <path d="M12 5v14M5 12h14" />
    </svg>
  ),
  userPlus: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <circle cx="9" cy="8" r="3.5" />
      <path d="M3 19.5a6 6 0 0 1 12 0M18 8v6M15 11h6" />
    </svg>
  ),
  search: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden>
      <circle cx="11" cy="11" r="6.5" />
      <path d="m16 16 4 4" />
    </svg>
  ),
};

function Field({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <label className={styles.field}>
      <span>{label}</span>
      {children}
      {hint ? <small className="field-hint">{hint}</small> : null}
    </label>
  );
}

function CredentialBox({ credential, t }: { credential: Credential; t: Translate }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className={styles.credential} role="status">
      <span>{t("Credencial generada")}</span>
      <strong>{credential.email}</strong>
      {credential.password ? (
        <div className={styles.secret}>
          <code>{credential.password}</code>
          <button
            type="button"
            className="btn btn-ghost btn-sm"
            onClick={() => {
              void navigator.clipboard
                ?.writeText(credential.password || "")
                .then(() => setCopied(true))
                .catch(() => setCopied(false));
            }}
          >
            {copied ? t("Copiada") : t("Copiar")}
          </button>
        </div>
      ) : (
        <small>{t(deliveryText(credential.delivery_status))}</small>
      )}
      {credential.password && credential.password_change_required ? (
        <small>{t("Contraseña temporal: se pedirá cambiarla en el primer ingreso.")}</small>
      ) : null}
    </div>
  );
}

type CompanyAction = "detail" | "plan" | "invite" | "archive" | "restore";
type UserAction = "edit" | "reset" | "revoke" | "activate" | "deactivate" | "archive";

function CompanyMenu({ company, t, onAction }: { company: SystemCompany; t: Translate; onAction: (action: CompanyAction) => void }) {
  const items: MenuItem[] = [
    { label: t("Ver detalle"), onSelect: () => onAction("detail") },
    { label: t("Editar plan"), onSelect: () => onAction("plan") },
    { label: t("Añadir usuario"), onSelect: () => onAction("invite") },
    isArchived(company)
      ? { label: t("Restaurar empresa"), onSelect: () => onAction("restore"), separatorBefore: true }
      : { label: t("Archivar empresa…"), onSelect: () => onAction("archive"), danger: true, separatorBefore: true },
  ];
  return <RowMenu items={items} label={fill(t("Acciones para {name}"), { name: company.name })} />;
}

function UserMenu({ row, isSelf, t, onAction }: { row: PanelUser; isSelf: boolean; t: Translate; onAction: (action: UserAction) => void }) {
  const items: MenuItem[] = [
    { label: t("Editar"), onSelect: () => onAction("edit") },
    { label: t("Restablecer contraseña"), onSelect: () => onAction("reset") },
    { label: t("Revocar sesiones"), onSelect: () => onAction("revoke") },
  ];
  if (!isSelf) {
    items.push(
      row.status === "inactive"
        ? { label: t("Reactivar acceso"), onSelect: () => onAction("activate"), separatorBefore: true }
        : { label: t("Desactivar acceso"), onSelect: () => onAction("deactivate"), separatorBefore: true },
      { label: t("Eliminar acceso…"), onSelect: () => onAction("archive"), danger: true },
    );
  }
  return <RowMenu items={items} label={fill(t("Acciones para {name}"), { name: row.full_name })} />;
}

export default function SystemPage() {
  const { apiGet, apiPost, apiPatch, activeCompanyId, setActiveCompanyId, user } = useAuth();
  const { t, language } = usePreferences();
  const locale = language === "en" ? "en-US" : "es-NI";
  const [companies, setCompanies] = useState<SystemCompany[]>([]);
  const [users, setUsers] = useState<PanelUser[]>([]);
  const [roles, setRoles] = useState<SystemOverviewResponse["roles"]>([]);
  const [status, setStatus] = useState({ text: "", id: 0 });
  const [hiddenStatusId, setHiddenStatusId] = useState(0);
  const statusText = status.text;
  const setStatusText = useCallback((text: string) => setStatus((current) => ({ text, id: current.id + 1 })), []);
  const [loading, setLoading] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [saving, setSaving] = useState(false);
  const [today, setToday] = useState(() => todayISO());
  const [updatedAt, setUpdatedAt] = useState("");

  const [companyName, setCompanyName] = useState("");
  const [companyLegalName, setCompanyLegalName] = useState("");
  const [companyTimezone, setCompanyTimezone] = useState("America/Managua");
  const [companyAdminName, setCompanyAdminName] = useState("");
  const [companyAdminEmail, setCompanyAdminEmail] = useState("");
  const [controlsCompanyId, setControlsCompanyId] = useState("");
  const [employeeLimit, setEmployeeLimit] = useState("0");
  const [controlsTimezone, setControlsTimezone] = useState("America/Managua");
  const [subscriptionStatus, setSubscriptionStatus] = useState<SubscriptionStatus>("active");
  const [subscriptionEndsAt, setSubscriptionEndsAt] = useState("");
  const [adminNotice, setAdminNotice] = useState("");

  const [panelCompanyId, setPanelCompanyId] = useState("");
  const [panelFullName, setPanelFullName] = useState("");
  const [panelEmail, setPanelEmail] = useState("");
  const [panelRole, setPanelRole] = useState<PanelRole>("supervisor");
  const [generatedCredential, setGeneratedCredential] = useState<Credential | null>(null);

  const [selectedUserId, setSelectedUserId] = useState("");
  const [editFullName, setEditFullName] = useState("");
  const [editRole, setEditRole] = useState<PanelRole>("viewer");
  const [editStatus, setEditStatus] = useState<"active" | "inactive">("active");
  const [resetReason, setResetReason] = useState("");

  const [drawer, setDrawer] = useState<DrawerKind>(null);
  const [userDrawerMode, setUserDrawerMode] = useState<"edit" | "reset">("edit");
  const [detailTab, setDetailTab] = useState<DetailTab>("summary");
  const [companySearch, setCompanySearch] = useState("");
  const [companyFilter, setCompanyFilter] = useState<CompanyFilter>("all");
  const [archiveConfirm, setArchiveConfirm] = useState("");

  const controlsCompanyIdRef = useRef(controlsCompanyId);
  const selectedUserIdRef = useRef(selectedUserId);
  const activeCompanyIdRef = useRef(activeCompanyId);

  const isSystemAdmin = user?.role === "system_admin";
  const liveCompanies = useMemo(() => companies.filter((company) => !isArchived(company)), [companies]);
  const activeCompanies = useMemo(() => companies.filter((company) => company.status === "active"), [companies]);
  const supervisors = useMemo(() => users.filter((row) => row.role === "supervisor"), [users]);
  const systemAdmins = useMemo(() => users.filter((row) => row.role === "system_admin"), [users]);
  const controlsCompany = useMemo(
    () => companies.find((company) => company.id === controlsCompanyId) || companies[0] || null,
    [companies, controlsCompanyId],
  );
  const selectedUser = useMemo(() => users.find((row) => row.id === selectedUserId) || null, [selectedUserId, users]);
  const companyIds = useMemo(() => new Set(companies.map((company) => company.id)), [companies]);
  const companyUsers = useMemo(
    () => (controlsCompany ? users.filter((row) => row.company_id === controlsCompany.id) : []),
    [controlsCompany, users],
  );
  const globalUsers = useMemo(() => users.filter((row) => !row.company_id || !companyIds.has(row.company_id)), [companyIds, users]);

  const companyStates = useMemo(() => {
    const map = new Map<string, ReturnType<typeof subscriptionState>>();
    companies.forEach((company) => map.set(company.id, subscriptionState(company, today, t)));
    return map;
  }, [companies, t, today]);

  const filterCounts = useMemo(
    () => ({
      all: companies.length,
      active: liveCompanies.length,
      attention: companies.filter((company) => companyStates.get(company.id)?.attention).length,
      archived: companies.length - liveCompanies.length,
    }),
    [companies, companyStates, liveCompanies.length],
  );

  const visibleCompanies = useMemo(() => {
    const query = normalize(companySearch.trim());
    return companies.filter((company) => {
      if (companyFilter === "active" && isArchived(company)) return false;
      if (companyFilter === "archived" && !isArchived(company)) return false;
      if (companyFilter === "attention" && !companyStates.get(company.id)?.attention) return false;
      if (!query) return true;
      return normalize(`${company.name} ${company.legal_name} ${company.timezone}`).includes(query);
    });
  }, [companies, companyFilter, companySearch, companyStates]);

  const license = useMemo(() => {
    const limited = liveCompanies.filter((company) => company.controls.employee_limit > 0);
    const used = limited.reduce((sum, company) => sum + company.employees_count, 0);
    const total = limited.reduce((sum, company) => sum + company.controls.employee_limit, 0);
    return { used, total, pct: total ? Math.round((used / total) * 100) : 0 };
  }, [liveCompanies]);

  const totalDevices = useMemo(() => companies.reduce((sum, company) => sum + company.devices_count, 0), [companies]);
  const tempPasswordUsers = useMemo(
    () => users.filter((row) => row.status !== "inactive" && row.password_change_required),
    [users],
  );
  const neverLoggedUsers = useMemo(
    () => users.filter((row) => row.status !== "inactive" && !row.password_change_required && !row.last_login_at),
    [users],
  );

  const loadCompanyControls = useCallback((company: SystemCompany | null) => {
    if (!company) return;
    controlsCompanyIdRef.current = company.id;
    activeCompanyIdRef.current = company.id;
    setControlsCompanyId(company.id);
    setActiveCompanyId(company.id, company.name);
    setPanelCompanyId(company.id);
    setControlsTimezone(company.timezone || "America/Managua");
    setEmployeeLimit(String(company.controls.employee_limit || 0));
    setSubscriptionStatus(company.controls.subscription_status || "active");
    setSubscriptionEndsAt(company.controls.subscription_ends_at || "");
    setAdminNotice(company.controls.admin_notice || "");
  }, [setActiveCompanyId]);

  const loadPanelUser = useCallback((panelUser: PanelUser | null) => {
    if (!panelUser) return;
    selectedUserIdRef.current = panelUser.id;
    setSelectedUserId(panelUser.id);
    setEditFullName(panelUser.full_name);
    setEditRole((panelUser.role || "viewer") as PanelRole);
    setEditStatus(panelUser.status === "inactive" ? "inactive" : "active");
    setResetReason("");
  }, []);

  const clearPanelUser = useCallback(() => {
    selectedUserIdRef.current = "";
    setSelectedUserId("");
    setEditFullName("");
    setEditRole("viewer");
    setEditStatus("active");
    setResetReason("");
  }, []);

  // El aviso flotante de estado se oculta solo tras unos segundos.
  useEffect(() => {
    if (!status.id) return undefined;
    if (/^No se pud/.test(status.text)) return undefined;
    const timer = window.setTimeout(() => setHiddenStatusId(status.id), 5000);
    return () => window.clearTimeout(timer);
  }, [status.id, status.text]);

  useEffect(() => {
    controlsCompanyIdRef.current = controlsCompanyId;
  }, [controlsCompanyId]);

  useEffect(() => {
    selectedUserIdRef.current = selectedUserId;
  }, [selectedUserId]);

  useEffect(() => {
    activeCompanyIdRef.current = activeCompanyId;
  }, [activeCompanyId]);

  const loadSystem = useCallback(async () => {
    if (!isSystemAdmin) return;
    setLoading(true);
    setStatusText("Actualizando sistema...");
    try {
      const response = await apiGet<SystemOverviewResponse>("/api/system/overview");
      const preferredCompany =
        response.companies.find((company) => company.id === activeCompanyIdRef.current) ||
        response.companies.find((company) => company.id === controlsCompanyIdRef.current) ||
        response.companies.find((company) => company.status === "active") ||
        response.companies[0] ||
        null;
      setCompanies(response.companies);
      setUsers(response.users);
      setRoles(response.roles);
      setPanelCompanyId((current) => current || preferredCompany?.id || "");
      loadCompanyControls(preferredCompany);
      loadPanelUser(response.users.find((row) => row.id === selectedUserIdRef.current) || response.users[0] || null);
      setToday(todayISO());
      setUpdatedAt(new Date().toISOString());
      setStatusText("Sistema actualizado");
    } catch {
      setStatusText("No se pudo cargar la consola del sistema");
    } finally {
      setLoading(false);
      setLoaded(true);
    }
  }, [apiGet, isSystemAdmin, loadCompanyControls, loadPanelUser, setStatusText]);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      void loadSystem();
    }, 0);
    return () => window.clearTimeout(timer);
  }, [loadSystem]);

  /* --- Navegación dentro de la consola ------------------------------------ */

  function selectCompany(company: SystemCompany) {
    loadCompanyControls(company);
    setArchiveConfirm("");
  }

  function openCompanyDetail(company: SystemCompany, tab: DetailTab) {
    selectCompany(company);
    setDetailTab(tab);
    window.setTimeout(() => document.getElementById("company-detail")?.scrollIntoView({ behavior: "smooth", block: "start" }), 30);
  }

  function onCompanyRowKey(event: KeyboardEvent<HTMLTableRowElement>, company: SystemCompany) {
    if (event.target !== event.currentTarget) return;
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      selectCompany(company);
    }
  }

  function openDrawer(kind: Exclude<DrawerKind, null>) {
    setGeneratedCredential(null);
    setStatusText("");
    setDrawer(kind);
  }

  function openNewCompany() {
    openDrawer("company");
  }

  function openInvite(companyId?: string) {
    if (companyId) setPanelCompanyId(companyId);
    else if (controlsCompany) setPanelCompanyId(controlsCompany.id);
    setPanelFullName("");
    setPanelEmail("");
    setPanelRole("supervisor");
    openDrawer("invite");
  }

  function openUserDrawer(panelUser: PanelUser, mode: "edit" | "reset") {
    loadPanelUser(panelUser);
    setUserDrawerMode(mode);
    openDrawer("user");
  }

  function closeDrawer() {
    setDrawer(null);
  }

  /* --- Acciones (misma API que la consola anterior) ----------------------- */

  async function createCompany(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!companyName.trim()) return;
    setSaving(true);
    setStatusText("Creando empresa...");
    try {
      const response = await apiPost<{
        company: SystemCompany;
        user: PanelUser;
        credentials: Credential;
      }>("/api/system/companies", {
        name: companyName,
        legal_name: companyLegalName || null,
        timezone: companyTimezone || "America/Managua",
        admin_full_name: companyAdminName,
        admin_email: companyAdminEmail,
      });
      setCompanies((current) => [response.company, ...current.filter((company) => company.id !== response.company.id)]);
      setUsers((current) => [response.user, ...current.filter((row) => row.id !== response.user.id)]);
      setGeneratedCredential(response.credentials);
      setPanelCompanyId(response.company.id);
      loadPanelUser(response.user);
      loadCompanyControls(response.company);
      setCompanyName("");
      setCompanyLegalName("");
      setCompanyAdminName("");
      setCompanyAdminEmail("");
      setDetailTab("summary");
      const message = `${t("Empresa creada.")} ${t(deliveryText(response.credentials.delivery_status))}`;
      setStatusText(message);
      await loadSystem();
      setStatusText(message);
    } catch {
      setStatusText("No se pudo crear la empresa. Revisa duplicados y correo del administrador.");
    } finally {
      setSaving(false);
    }
  }

  async function createPanelUser(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (panelRole !== "system_admin" && !panelCompanyId) {
      setStatusText("Selecciona una empresa para este usuario");
      return;
    }
    setSaving(true);
    setStatusText("Creando credencial...");
    try {
      const response = await apiPost<{
        user: PanelUser;
        credentials: Credential;
      }>("/api/system/users", {
        company_id: panelRole === "system_admin" ? panelCompanyId || null : panelCompanyId,
        full_name: panelFullName,
        email: panelEmail,
        role: panelRole,
      });
      setUsers((current) => [response.user, ...current.filter((row) => row.id !== response.user.id)]);
      setGeneratedCredential(response.credentials);
      loadPanelUser(response.user);
      setPanelFullName("");
      setPanelEmail("");
      setPanelRole("supervisor");
      const message = deliveryText(response.credentials.delivery_status);
      setStatusText(message);
      await loadSystem();
      setStatusText(message);
    } catch {
      setStatusText("No se pudo crear el acceso. Revisa correo duplicado o permisos.");
    } finally {
      setSaving(false);
    }
  }

  async function savePanelUser(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!selectedUserId) {
      setStatusText("Selecciona un usuario del panel");
      return;
    }
    setSaving(true);
    setStatusText("Actualizando usuario...");
    try {
      const response = await apiPatch<{ user: PanelUser }>(`/api/system/users/${selectedUserId}`, {
        full_name: editFullName,
        role: editRole,
        status: editStatus,
      });
      setUsers((current) => current.map((row) => (row.id === response.user.id ? response.user : row)));
      loadPanelUser(response.user);
      setStatusText("Usuario del panel actualizado");
    } catch {
      setStatusText("No se pudo actualizar el usuario");
    } finally {
      setSaving(false);
    }
  }

  async function setPanelUserStatus(panelUser: PanelUser, status: "active" | "inactive") {
    setStatusText("Actualizando usuario...");
    try {
      const response = await apiPatch<{ user: PanelUser }>(`/api/system/users/${panelUser.id}`, {
        full_name: panelUser.full_name,
        role: panelUser.role,
        status,
      });
      setUsers((current) => current.map((row) => (row.id === response.user.id ? response.user : row)));
      loadPanelUser(response.user);
      setStatusText(status === "inactive" ? "Acceso desactivado" : "Acceso reactivado");
    } catch {
      setStatusText("No se pudo actualizar el usuario");
    }
  }

  async function resetPanelPassword(event?: FormEvent<HTMLFormElement>) {
    event?.preventDefault();
    if (!selectedUserId) {
      setStatusText("Selecciona un usuario del panel");
      return;
    }
    setSaving(true);
    setStatusText("Generando nueva credencial...");
    try {
      const response = await apiPost<{
        user: PanelUser;
        credentials: Credential;
        revoked_sessions?: number;
      }>(`/api/system/users/${selectedUserId}/reset-password`, { reason: resetReason || "Reset solicitado por administrador del sistema" });
      setUsers((current) => current.map((row) => (row.id === response.user.id ? response.user : row)));
      setGeneratedCredential(response.credentials);
      loadPanelUser(response.user);
      setStatusText(`${t(deliveryText(response.credentials.delivery_status))} ${t("Sesiones cerradas:")} ${response.revoked_sessions || 0}`);
    } catch {
      setStatusText("No se pudo resetear la credencial");
    } finally {
      setSaving(false);
    }
  }

  async function revokePanelSessions(targetUserId = selectedUserId) {
    if (!targetUserId) {
      setStatusText("Selecciona un usuario del panel");
      return;
    }
    setStatusText("Cerrando sesiones...");
    try {
      const response = await apiPost<{
        user: PanelUser;
        revoked_sessions: number;
      }>(`/api/system/users/${targetUserId}/revoke-sessions`, { reason: "Cierre manual desde consola sistema" });
      setUsers((current) => current.map((row) => (row.id === response.user.id ? response.user : row)));
      loadPanelUser(response.user);
      setStatusText(`${t("Sesiones cerradas:")} ${response.revoked_sessions}`);
    } catch {
      setStatusText("No se pudieron cerrar las sesiones");
    }
  }

  async function saveCompanyControls(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!controlsCompanyId) {
      setStatusText("Selecciona una empresa para configurar controles");
      return;
    }
    setSaving(true);
    setStatusText("Guardando controles...");
    try {
      const response = await apiPatch<{ company: SystemCompany }>(`/api/system/companies/${controlsCompanyId}/controls`, {
        timezone: controlsTimezone,
        employee_limit: Number(employeeLimit || 0),
        subscription_status: subscriptionStatus,
        subscription_ends_at: subscriptionEndsAt || null,
        admin_notice: adminNotice || null,
      });
      setCompanies((current) => current.map((company) => (company.id === response.company.id ? response.company : company)));
      loadCompanyControls(response.company);
      setStatusText("Controles de empresa actualizados");
    } catch {
      setStatusText("No se pudieron guardar los controles");
    } finally {
      setSaving(false);
    }
  }

  /** `confirmed` = el nombre ya se tecleó en la zona de riesgo; si no, se pide confirmación. */
  async function archiveCompany(company: SystemCompany, confirmed = false) {
    if (
      !confirmed &&
      !window.confirm(
        fill(t("Archivar empresa {name}? Se desactivaran usuarios, empleados monitoreados y dispositivos de esa empresa."), {
          name: company.name,
        }),
      )
    ) {
      return;
    }
    setStatusText("Archivando empresa...");
    try {
      const response = await apiPost<{ company: SystemCompany }>(`/api/system/companies/${company.id}/archive`, {
        reason: "Archivada desde consola sistema",
      });
      setCompanies((current) => current.map((row) => (row.id === response.company.id ? response.company : row)));
      loadCompanyControls(response.company);
      setArchiveConfirm("");
      await loadSystem();
      setStatusText("Empresa archivada");
    } catch {
      setStatusText("No se pudo archivar la empresa");
    }
  }

  async function restoreCompany(company: SystemCompany) {
    setStatusText("Restaurando empresa...");
    try {
      const response = await apiPost<{ company: SystemCompany }>(`/api/system/companies/${company.id}/restore`, {
        reason: "Restaurada desde consola sistema",
      });
      setCompanies((current) => current.map((row) => (row.id === response.company.id ? response.company : row)));
      loadCompanyControls(response.company);
      await loadSystem();
      setStatusText("Empresa restaurada");
    } catch {
      setStatusText("No se pudo restaurar la empresa");
    }
  }

  async function archivePanelUser(panelUser: PanelUser) {
    if (
      !window.confirm(
        fill(t("Eliminar usuario del panel {name}? Se cerraran sus sesiones y desaparecera de la consola."), { name: panelUser.full_name }),
      )
    ) {
      return;
    }
    setStatusText("Eliminando usuario del panel...");
    try {
      await apiPost<{ user: PanelUser; revoked_sessions: number }>(`/api/system/users/${panelUser.id}/archive`, {
        reason: "Eliminado desde consola sistema",
      });
      setUsers((current) => current.filter((row) => row.id !== panelUser.id));
      if (selectedUserId === panelUser.id) {
        clearPanelUser();
      }
      await loadSystem();
      setStatusText("Usuario del panel eliminado");
    } catch {
      setStatusText("No se pudo eliminar el usuario del panel");
    }
  }

  if (!isSystemAdmin) {
    return (
      <AppShell title={t("Sistema")} description={t("Controles globales de VYNTRA")}>
        <EmptyBlock title={t("Acceso restringido")} description={t("Esta vista requiere el rol Administrador del sistema.")} />
      </AppShell>
    );
  }

  /* --- Datos derivados para la vista ------------------------------------- */

  type StripAlert = { key: string; tone: "warn" | "bad" | "info"; text: string; companyId?: string; tab?: DetailTab };
  const alerts: StripAlert[] = [];
  liveCompanies.forEach((company) => {
    const days = daysUntil(company.controls.subscription_ends_at, today);
    const status = company.controls.subscription_status;
    const openPlan = { companyId: company.id, tab: "plan" as DetailTab };
    if (status === "suspended" || status === "cancelled") {
      alerts.push({
        key: `sub-${company.id}`,
        tone: "bad",
        text: fill(t("{name}: suscripción {status}"), { name: company.name, status: t(subscriptionLabels[status]).toLowerCase() }),
        ...openPlan,
      });
    } else if (days !== null && days < 0) {
      alerts.push({
        key: `exp-${company.id}`,
        tone: "bad",
        text: fill(t(Math.abs(days) === 1 ? "{name} venció hace 1 día" : "{name} venció hace {n} días"), { name: company.name, n: Math.abs(days) }),
        ...openPlan,
      });
    } else if (days !== null && days <= EXPIRY_WARNING_DAYS) {
      alerts.push({
        key: `exp-${company.id}`,
        tone: "warn",
        text:
          days === 0
            ? fill(t("{name} vence hoy"), { name: company.name })
            : fill(t(days === 1 ? "{name} vence mañana" : "{name} vence en {n} días"), { name: company.name, n: days }),
        ...openPlan,
      });
    } else if (status === "past_due") {
      alerts.push({ key: `due-${company.id}`, tone: "warn", text: fill(t("{name}: pago pendiente"), { name: company.name }), ...openPlan });
    }
    const limit = company.controls.employee_limit;
    if (limit > 0 && company.employees_count >= limit) {
      alerts.push({
        key: `limit-${company.id}`,
        tone: company.employees_count > limit ? "bad" : "warn",
        text: fill(t("{name} alcanzó el límite del plan ({n}/{limit})"), { name: company.name, n: company.employees_count, limit }),
        ...openPlan,
      });
    }
    if (!company.users_count && !users.some((row) => row.company_id === company.id)) {
      alerts.push({
        key: `nousers-${company.id}`,
        tone: "info",
        text: fill(t("{name} no tiene usuarios del panel"), { name: company.name }),
        companyId: company.id,
        tab: "users",
      });
    }
  });
  if (tempPasswordUsers.length) {
    alerts.push({
      key: "temp-passwords",
      tone: "warn",
      text: fill(t(tempPasswordUsers.length === 1 ? "1 usuario con contraseña temporal" : "{n} usuarios con contraseña temporal"), {
        n: tempPasswordUsers.length,
      }),
    });
  }
  if (neverLoggedUsers.length) {
    alerts.push({
      key: "never-logged",
      tone: "info",
      text: fill(t(neverLoggedUsers.length === 1 ? "1 usuario aún no ha ingresado" : "{n} usuarios aún no han ingresado"), {
        n: neverLoggedUsers.length,
      }),
    });
  }

  const expiringCount = liveCompanies.filter((company) => {
    const days = daysUntil(company.controls.subscription_ends_at, today);
    return days !== null && days <= EXPIRY_WARNING_DAYS;
  }).length;
  const archivedCount = companies.length - liveCompanies.length;
  const companiesWithDevices = companies.filter((company) => company.devices_count > 0).length;

  const selectedState = controlsCompany ? companyStates.get(controlsCompany.id) : undefined;
  const selectedArchived = controlsCompany ? isArchived(controlsCompany) : false;
  const timezoneChoices = timezoneOptions.includes(controlsTimezone) ? timezoneOptions : [controlsTimezone, ...timezoneOptions];

  function openAlert(companyId?: string, tab?: DetailTab) {
    const company = companies.find((row) => row.id === companyId);
    if (company) openCompanyDetail(company, tab || "summary");
  }

  function handleCompanyAction(company: SystemCompany, action: CompanyAction) {
    if (action === "detail") openCompanyDetail(company, "summary");
    else if (action === "plan") openCompanyDetail(company, "plan");
    else if (action === "invite") {
      selectCompany(company);
      openInvite(company.id);
    } else if (action === "restore") void restoreCompany(company);
    else void archiveCompany(company);
  }

  function handleUserAction(row: PanelUser, action: UserAction) {
    if (action === "edit") openUserDrawer(row, "edit");
    else if (action === "reset") openUserDrawer(row, "reset");
    else if (action === "revoke") void revokePanelSessions(row.id);
    else if (action === "activate") void setPanelUserStatus(row, "active");
    else if (action === "deactivate") void setPanelUserStatus(row, "inactive");
    else void archivePanelUser(row);
  }

  function userStatusChip(row: PanelUser) {
    if (row.status === "inactive") return <Chip>{t("Inactivo")}</Chip>;
    if (row.status === "archived") return <Chip tone="bad">{t("Eliminado")}</Chip>;
    if (row.password_change_required) return <Chip tone="warn">{t("Contraseña temporal")}</Chip>;
    return <Chip tone="good">{t("Activo")}</Chip>;
  }

  function renderUserRows(rows: PanelUser[], showCompany = false) {
    return (
      <ul className={styles.userList}>
        {rows.map((row) => {
          const sessions = row.active_sessions || 0;
          return (
            <li key={row.id} className={styles.userRow}>
              <span className="avatar" aria-hidden>
                {initials(row.full_name || row.email)}
              </span>
              <div className={styles.userName}>
                <strong>
                  {row.full_name}
                  {row.id === user?.id ? <em>{t("Tú")}</em> : null}
                </strong>
                <small>{showCompany ? `${row.email} · ${row.company || t("Sin empresa")}` : row.email}</small>
              </div>
              <div>
                <Chip tone={row.role === "system_admin" ? "accent" : "plain"} dot={false}>
                  {t(roleLabels[row.role] || row.role)}
                </Chip>
              </div>
              <div>{userStatusChip(row)}</div>
              <div className={styles.userMeta}>
                <span>{row.last_login_at ? formatDateTime(row.last_login_at, locale) : t("Sin ingreso")}</span>
                <small>
                  {sessions === 1 ? t("1 sesión activa") : fill(t("{n} sesiones activas"), { n: sessions })}
                </small>
              </div>
              <UserMenu row={row} isSelf={row.id === user?.id} t={t} onAction={(action) => handleUserAction(row, action)} />
            </li>
          );
        })}
      </ul>
    );
  }

  // Los mensajes rutinarios de carga ya se ven en el boton Actualizar y en la hora del encabezado.
  const routineStatus = statusText === "Actualizando sistema..." || statusText === "Sistema actualizado";
  const statusSlot =
    !drawer && statusText && !routineStatus && hiddenStatusId !== status.id ? (
      <div className={styles.toast}>
        <StatusLine>{t(statusText)}</StatusLine>
        <button type="button" className="icon-button" onClick={() => setHiddenStatusId(status.id)} aria-label={t("Cerrar aviso")}>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden>
            <path d="M18 6 6 18M6 6l12 12" />
          </svg>
        </button>
      </div>
    ) : null;
  const drawerStatus = statusText ? (
    <span className={styles.footStatus} role="status" aria-live="polite">
      {t(statusText)}
    </span>
  ) : (
    <span className={styles.footStatus} />
  );

  const description = updatedAt
    ? `${t("Consola master multiempresa")} · ${t("actualizado")} ${new Date(updatedAt).toLocaleTimeString(locale, { hour: "2-digit", minute: "2-digit" })}`
    : t("Consola master multiempresa");

  return (
    <AppShell
      title={t("Sistema")}
      description={description}
      actions={
        <>
          <RefreshButton loading={loading} onClick={() => void loadSystem()} />
          <button type="button" className="btn btn-outline" onClick={() => openInvite()}>
            {icons.userPlus}
            <span>{t("Invitar usuario")}</span>
          </button>
          <button type="button" className="btn" onClick={openNewCompany}>
            {icons.plus}
            <span>{t("Nueva empresa")}</span>
          </button>
        </>
      }
    >
      <div className={styles.page}>
        <section className={styles.consolePanel} aria-label={t("Estado general del sistema")}>
          <div className={styles.consoleMain}>
            <span className={styles.consoleEyebrow}>{t("Consola master")}</span>
            <h2>{controlsCompany?.name || t("Sin empresa seleccionada")}</h2>
            <p>
              {loaded
                ? fill(t("{active} empresas activas · {users} usuarios del panel · {devices} dispositivos registrados"), {
                    active: activeCompanies.length,
                    users: users.length,
                    devices: totalDevices,
                  })
                : t("Cargando estado global de empresas, usuarios y licencias.")}
            </p>
            <div className={styles.consoleActions}>
              {controlsCompany ? (
                <button type="button" className="btn btn-outline btn-sm" onClick={() => openCompanyDetail(controlsCompany, "summary")}>
                  {t("Ver empresa activa")}
                </button>
              ) : null}
              <button type="button" className="btn btn-ghost btn-sm" onClick={() => setCompanyFilter(alerts.length ? "attention" : "all")}>
                {alerts.length ? t("Ver alertas") : t("Ver empresas")}
              </button>
            </div>
          </div>
          <div className={styles.consoleFacts}>
            <div>
              <span>{t("Estado")}</span>
              {selectedState ? <Chip tone={selectedState.tone}>{selectedState.label}</Chip> : <strong>{t("Pendiente")}</strong>}
            </div>
            <div>
              <span>{t("Alertas")}</span>
              <strong className={alerts.length ? styles.valueWarn : ""}>{alerts.length}</strong>
            </div>
            <div>
              <span>{t("Licencias")}</span>
              <strong>{license.total ? `${license.pct}%` : "—"}</strong>
            </div>
            <div>
              <span>{t("Archivadas")}</span>
              <strong>{archivedCount}</strong>
            </div>
          </div>
        </section>

        <AttentionList
          label={t("Avisos")}
          items={alerts.map((alert) => ({
            key: alert.key,
            tone: alert.tone,
            title: alert.text,
            selectable: Boolean(alert.companyId),
            action: alert.companyId ? t("Abrir") : undefined,
          }))}
          onSelect={(key) => {
            const alert = alerts.find((row) => row.key === key);
            if (alert) openAlert(alert.companyId, alert.tab);
          }}
        />

        <MetricBand
          label={t("Indicadores del sistema")}
          items={[
            {
              key: "licenses",
              lead: true,
              tone: !license.total ? "plain" : license.pct >= 100 ? "bad" : license.pct >= 85 ? "warn" : "good",
              label: t("Uso de licencias"),
              value: license.total ? `${license.pct}%` : "—",
              meter: license.total ? license.pct : undefined,
              status: !license.total ? undefined : license.pct >= 100 ? t("Al límite") : license.pct >= 85 ? t("Cerca del límite") : t("Con margen"),
              detail: license.total
                ? fill(t("{used} de {total} empleados contratados"), { used: license.used, total: license.total })
                : t("Sin límites de plan definidos"),
            },
            {
              key: "companies",
              lead: true,
              tone: expiringCount ? "warn" : "good",
              label: t("Empresas activas"),
              value: activeCompanies.length,
              status: expiringCount
                ? fill(t(expiringCount === 1 ? "1 por vencer o vencida" : "{n} por vencer o vencidas"), { n: expiringCount })
                : t("Suscripciones al día"),
              detail: archivedCount
                ? fill(t("de {total} registradas · {n} archivadas"), { total: companies.length, n: archivedCount })
                : fill(t("de {total} registradas"), { total: companies.length }),
            },
            {
              key: "users",
              label: t("Usuarios del panel"),
              value: users.length,
              detail: fill(t("{admins} admin. del sistema · {supervisors} supervisores"), {
                admins: systemAdmins.length,
                supervisors: supervisors.length,
              }),
            },
            {
              key: "devices",
              label: t("Dispositivos"),
              value: totalDevices,
              detail: fill(t(companiesWithDevices === 1 ? "Agentes registrados en 1 empresa" : "Agentes registrados en {n} empresas"), {
                n: companiesWithDevices,
              }),
            },
          ]}
        />

        {statusSlot}

        <section className={styles.card} aria-labelledby="companies-title">
          <header className={styles.cardHead}>
            <div className={styles.cardTitle}>
              <h2 id="companies-title">{t("Empresas")}</h2>
              <span>{fill(t(companies.length === 1 ? "1 registrada" : "{n} registradas"), { n: companies.length })}</span>
            </div>
            <div className="toolbar">
              <div className={`search-input ${styles.search}`}>
                {icons.search}
                <input
                  type="search"
                  value={companySearch}
                  onChange={(event) => setCompanySearch(event.target.value)}
                  placeholder={t("Buscar empresa")}
                  aria-label={t("Buscar empresa")}
                />
              </div>
              <div className="segmented" role="group" aria-label={t("Filtrar por estado")}>
                {(
                  [
                    ["all", "Todas"],
                    ["active", "Activas"],
                    ["attention", "Por vencer"],
                    ["archived", "Archivadas"],
                  ] as Array<[CompanyFilter, string]>
                ).map(([id, label]) => (
                  <button key={id} type="button" aria-pressed={companyFilter === id} onClick={() => setCompanyFilter(id)}>
                    {t(label)}
                    <span className={styles.count}>{filterCounts[id]}</span>
                  </button>
                ))}
              </div>
            </div>
          </header>

          {!loaded ? (
            <p className={styles.loadingText}>{t("Cargando empresas...")}</p>
          ) : !companies.length ? (
            <div className={styles.cardBody}>
              <EmptyBlock
                title={t("Aún no hay empresas")}
                description={t("Crea la primera empresa y su administrador para empezar.")}
                action={
                  <button type="button" className="btn btn-outline btn-sm" onClick={openNewCompany}>
                    {t("Nueva empresa")}
                  </button>
                }
              />
            </div>
          ) : !visibleCompanies.length ? (
            <div className={styles.cardBody}>
              <EmptyBlock
                title={t("Sin resultados")}
                description={t("Ninguna empresa coincide con la búsqueda o el filtro.")}
                action={
                  <button
                    type="button"
                    className="btn btn-ghost btn-sm"
                    onClick={() => {
                      setCompanySearch("");
                      setCompanyFilter("all");
                    }}
                  >
                    {t("Limpiar filtros")}
                  </button>
                }
              />
            </div>
          ) : (
            <div className={styles.tableWrap}>
              <table className={styles.table}>
                <thead>
                  <tr>
                    <th>{t("Empresa")}</th>
                    <th>{t("Uso del plan")}</th>
                    <th className="num">{t("Usuarios")}</th>
                    <th className="num">{t("Dispositivos")}</th>
                    <th>{t("Suscripción")}</th>
                    <th aria-label={t("Acciones")} />
                  </tr>
                </thead>
                <tbody>
                  {visibleCompanies.map((company) => {
                    const state = companyStates.get(company.id);
                    const selected = controlsCompany?.id === company.id;
                    const limit = company.controls.employee_limit;
                    return (
                      <tr
                        key={company.id}
                        className={`${selected ? "selected-row" : ""} ${isArchived(company) ? styles.archivedRow : ""}`}
                        onClick={() => selectCompany(company)}
                        onKeyDown={(event) => onCompanyRowKey(event, company)}
                        tabIndex={0}
                        aria-selected={selected}
                      >
                        <td>
                          <div className={styles.stack}>
                            <strong>{company.name}</strong>
                            <small>{company.legal_name ? `${company.legal_name} · ${company.timezone}` : company.timezone}</small>
                          </div>
                        </td>
                        <td>
                          <div className={styles.usage}>
                            <span>{planText(company, t)}</span>
                            {limit ? (
                              <UsageBar value={company.employees_count} max={limit} label={t("Uso del limite de empleados")} />
                            ) : null}
                          </div>
                        </td>
                        <td className="num">{company.users_count}</td>
                        <td className="num">{company.devices_count}</td>
                        <td>
                          <div className={styles.stack}>
                            {state ? <Chip tone={state.tone}>{state.label}</Chip> : null}
                            <small>
                              {company.controls.subscription_ends_at
                                ? `${t((daysUntil(company.controls.subscription_ends_at, today) ?? 0) < 0 ? "Venció el" : "Vence")} ${formatDay(
                                    company.controls.subscription_ends_at,
                                    locale,
                                  )}`
                                : t("Sin vencimiento definido")}
                            </small>
                          </div>
                        </td>
                        <td className={styles.menuCell}>
                          <CompanyMenu company={company} t={t} onAction={(action) => handleCompanyAction(company, action)} />
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </section>

        {controlsCompany ? (
          <section className={styles.card} id="company-detail" aria-labelledby="company-detail-title">
            <header className={styles.detailHead}>
              <div>
                <h2 id="company-detail-title">{controlsCompany.name}</h2>
                <p>
                  {[
                    controlsCompany.legal_name,
                    controlsCompany.timezone,
                    controlsCompany.controls.employee_limit
                      ? fill(t("plan de {n} empleados"), { n: controlsCompany.controls.employee_limit })
                      : t("sin límite de empleados"),
                    controlsCompany.controls.subscription_ends_at
                      ? `${t((daysUntil(controlsCompany.controls.subscription_ends_at, today) ?? 0) < 0 ? "venció el" : "vence")} ${formatDay(
                          controlsCompany.controls.subscription_ends_at,
                          locale,
                        )}`
                      : "",
                  ]
                    .filter(Boolean)
                    .join(" · ")}
                </p>
              </div>
              {selectedState ? <Chip tone={selectedState.tone}>{selectedState.label}</Chip> : null}
            </header>

            <div className={styles.tabsRow}>
              <Tabs<DetailTab>
                value={detailTab}
                onChange={(id) => setDetailTab(id)}
                tabs={[
                  { id: "summary", label: t("Resumen") },
                  { id: "users", label: `${t("Usuarios")} (${companyUsers.length})` },
                  { id: "plan", label: t("Plan y suscripción") },
                  { id: "risk", label: t("Zona de riesgo"), danger: true },
                ]}
              />
            </div>

            <div className={styles.cardBody}>
              {detailTab === "summary" ? (
                <div className={styles.summary}>
                  <dl className={styles.facts}>
                    <div>
                      <dt>{t("Empleados")}</dt>
                      <dd>
                        {planText(controlsCompany, t)}
                        {controlsCompany.controls.employee_limit ? (
                          <UsageBar
                            value={controlsCompany.employees_count}
                            max={controlsCompany.controls.employee_limit}
                            label={t("Uso del limite de empleados")}
                          />
                        ) : null}
                      </dd>
                    </div>
                    <div>
                      <dt>{t("Usuarios del panel")}</dt>
                      <dd>{controlsCompany.users_count}</dd>
                    </div>
                    <div>
                      <dt>{t("Dispositivos")}</dt>
                      <dd>{controlsCompany.devices_count}</dd>
                    </div>
                    <div>
                      <dt>{t("Suscripción")}</dt>
                      <dd>
                        {t(subscriptionLabels[controlsCompany.controls.subscription_status || "active"])}
                        <small>
                          {controlsCompany.controls.subscription_ends_at
                            ? `${t(
                                (daysUntil(controlsCompany.controls.subscription_ends_at, today) ?? 0) < 0 ? "Venció el" : "Vence",
                              )} ${formatDay(controlsCompany.controls.subscription_ends_at, locale)}`
                            : t("Sin vencimiento definido")}
                        </small>
                      </dd>
                    </div>
                    <div>
                      <dt>{t("Zona horaria")}</dt>
                      <dd>{controlsCompany.timezone}</dd>
                    </div>
                    <div>
                      <dt>{t("Razón social")}</dt>
                      <dd>{controlsCompany.legal_name || "—"}</dd>
                    </div>
                    <div>
                      <dt>{t("Estado")}</dt>
                      <dd>{selectedArchived ? t("Archivada") : t("Activa")}</dd>
                    </div>
                    <div>
                      <dt>{t("Creada")}</dt>
                      <dd>{controlsCompany.created_at ? formatDay(controlsCompany.created_at, locale) : "—"}</dd>
                    </div>
                  </dl>
                  <div className={styles.notice}>
                    <span>{t("Mensaje para admins")}</span>
                    <p>{controlsCompany.controls.admin_notice || t("Sin mensaje. Se configura en Plan y suscripción.")}</p>
                  </div>
                </div>
              ) : null}

              {detailTab === "users" ? (
                <div className={styles.tabPane}>
                  <div className={styles.paneHead}>
                    <span>
                      {fill(t(companyUsers.length === 1 ? "1 usuario con acceso al panel" : "{n} usuarios con acceso al panel"), {
                        n: companyUsers.length,
                      })}
                    </span>
                    <button
                      type="button"
                      className="btn btn-outline btn-sm"
                      onClick={() => openInvite(controlsCompany.id)}
                      disabled={selectedArchived}
                    >
                      {icons.plus}
                      <span>{t("Añadir usuario")}</span>
                    </button>
                  </div>
                  {companyUsers.length ? (
                    renderUserRows(companyUsers)
                  ) : (
                    <EmptyBlock
                      title={t("Sin usuarios del panel")}
                      description={fill(t("Invita al primer usuario de {name}."), { name: controlsCompany.name })}
                    />
                  )}
                </div>
              ) : null}

              {detailTab === "plan" ? (
                <form className={styles.form} onSubmit={saveCompanyControls}>
                  <div className="field-row">
                    <Field label={t("Zona horaria")}>
                      <select value={controlsTimezone} onChange={(event) => setControlsTimezone(event.target.value)}>
                        {timezoneChoices.map((timezone) => (
                          <option key={timezone} value={timezone}>
                            {timezone}
                          </option>
                        ))}
                      </select>
                    </Field>
                    <Field label={t("Límite de empleados")} hint={t("0 = sin límite")}>
                      <input type="number" min="0" value={employeeLimit} onChange={(event) => setEmployeeLimit(event.target.value)} />
                    </Field>
                  </div>
                  <div className="field-row">
                    <Field label={t("Estado de la suscripción")}>
                      <select value={subscriptionStatus} onChange={(event) => setSubscriptionStatus(event.target.value as SubscriptionStatus)}>
                        {(Object.keys(subscriptionLabels) as SubscriptionStatus[]).map((status) => (
                          <option key={status} value={status}>
                            {t(subscriptionLabels[status])}
                          </option>
                        ))}
                      </select>
                    </Field>
                    <Field label={t("Vence")}>
                      <input type="date" value={subscriptionEndsAt} onChange={(event) => setSubscriptionEndsAt(event.target.value)} />
                    </Field>
                  </div>
                  <Field label={t("Mensaje para admins")} hint={t("Se muestra como aviso a los administradores de esta empresa.")}>
                    <textarea
                      value={adminNotice}
                      onChange={(event) => setAdminNotice(event.target.value)}
                      placeholder={t("Tu suscripcion vence pronto. Comunicate con soporte.")}
                      maxLength={255}
                      rows={3}
                    />
                  </Field>
                  <div className={styles.formActions}>
                    <button type="submit" className="btn" disabled={saving}>
                      {t("Guardar cambios")}
                    </button>
                  </div>
                </form>
              ) : null}

              {detailTab === "risk" ? (
                <div className={styles.danger}>
                  {selectedArchived ? (
                    <div className={styles.dangerRow}>
                      <div>
                        <strong>{t("Restaurar empresa")}</strong>
                        <p>{t("La empresa vuelve a estar activa en la consola. Revisa después sus usuarios y dispositivos.")}</p>
                      </div>
                      <button type="button" className="btn btn-outline" onClick={() => void restoreCompany(controlsCompany)}>
                        {t("Restaurar empresa")}
                      </button>
                    </div>
                  ) : (
                    <form
                      className={styles.dangerRow}
                      onSubmit={(event) => {
                        event.preventDefault();
                        if (archiveConfirm.trim() === controlsCompany.name) void archiveCompany(controlsCompany, true);
                      }}
                    >
                      <div>
                        <strong>{t("Archivar empresa")}</strong>
                        <p>{t("Se desactivaran usuarios, empleados monitoreados y dispositivos de esa empresa.")}</p>
                        <Field label={fill(t("Escribe «{name}» para confirmar"), { name: controlsCompany.name })}>
                          <input
                            value={archiveConfirm}
                            onChange={(event) => setArchiveConfirm(event.target.value)}
                            autoComplete="off"
                            spellCheck={false}
                          />
                        </Field>
                      </div>
                      <button type="submit" className="btn btn-danger" disabled={archiveConfirm.trim() !== controlsCompany.name}>
                        {t("Archivar empresa")}
                      </button>
                    </form>
                  )}
                </div>
              ) : null}
            </div>
          </section>
        ) : null}

        {globalUsers.length ? (
          <section className={styles.card} aria-labelledby="global-users-title">
            <header className={styles.cardHead}>
              <div className={styles.cardTitle}>
                <h2 id="global-users-title">{t("Accesos globales")}</h2>
                <span>{t("Administradores del sistema y usuarios sin empresa")}</span>
              </div>
            </header>
            <div className={styles.cardBodyTight}>{renderUserRows(globalUsers, true)}</div>
          </section>
        ) : null}
      </div>

      {/* --- Nueva empresa ------------------------------------------------- */}
      <Drawer
        open={drawer === "company"}
        onClose={closeDrawer}
        title={t("Nueva empresa")}
        description={t("Crea la empresa y su primer administrador.")}
        footer={
          generatedCredential ? (
            <>
              {drawerStatus}
              <button type="button" className="btn btn-outline" onClick={() => setGeneratedCredential(null)}>
                {t("Crear otra")}
              </button>
              <button type="button" className="btn" onClick={closeDrawer}>
                {t("Listo")}
              </button>
            </>
          ) : (
            <>
              {drawerStatus}
              <button type="button" className="btn btn-ghost" onClick={closeDrawer}>
                {t("Cancelar")}
              </button>
              <button type="submit" form="new-company-form" className="btn" disabled={saving}>
                {saving ? t("Creando...") : t("Crear empresa")}
              </button>
            </>
          )
        }
      >
        {generatedCredential ? (
          <CredentialBox credential={generatedCredential} t={t} />
        ) : (
          <form id="new-company-form" className={styles.drawerForm} onSubmit={createCompany}>
            <div className="drawer-section">
              <Field label={t("Nombre comercial")}>
                <input value={companyName} onChange={(event) => setCompanyName(event.target.value)} placeholder={t("Empresa cliente")} required />
              </Field>
              <Field label={t("Razón social (opcional)")}>
                <input value={companyLegalName} onChange={(event) => setCompanyLegalName(event.target.value)} />
              </Field>
              <Field label={t("Zona horaria")}>
                <select value={companyTimezone} onChange={(event) => setCompanyTimezone(event.target.value)}>
                  {timezoneOptions.map((timezone) => (
                    <option key={timezone} value={timezone}>
                      {timezone}
                    </option>
                  ))}
                </select>
              </Field>
            </div>
            <div className="drawer-section">
              <h3>{t("Primer administrador")}</h3>
              <Field label={t("Nombre completo")}>
                <input
                  value={companyAdminName}
                  onChange={(event) => setCompanyAdminName(event.target.value)}
                  placeholder={t("Nombre completo")}
                  required
                />
              </Field>
              <Field label={t("Correo")} hint={t("Recibirá sus credenciales de acceso.")}>
                <input
                  type="email"
                  value={companyAdminEmail}
                  onChange={(event) => setCompanyAdminEmail(event.target.value)}
                  placeholder="admin@empresa.com"
                  required
                />
              </Field>
            </div>
          </form>
        )}
      </Drawer>

      {/* --- Invitar usuario ----------------------------------------------- */}
      <Drawer
        open={drawer === "invite"}
        onClose={closeDrawer}
        title={t("Invitar usuario")}
        description={t("Crea una credencial de acceso al panel.")}
        footer={
          generatedCredential ? (
            <>
              {drawerStatus}
              <button type="button" className="btn btn-outline" onClick={() => setGeneratedCredential(null)}>
                {t("Invitar a otro")}
              </button>
              <button type="button" className="btn" onClick={closeDrawer}>
                {t("Listo")}
              </button>
            </>
          ) : (
            <>
              {drawerStatus}
              <button type="button" className="btn btn-ghost" onClick={closeDrawer}>
                {t("Cancelar")}
              </button>
              <button type="submit" form="invite-user-form" className="btn" disabled={saving}>
                {saving ? t("Creando...") : t("Crear credencial")}
              </button>
            </>
          )
        }
      >
        {generatedCredential ? (
          <CredentialBox credential={generatedCredential} t={t} />
        ) : (
          <form id="invite-user-form" className={styles.drawerForm} onSubmit={createPanelUser}>
            <Field
              label={t("Empresa")}
              hint={panelRole === "system_admin" ? t("Opcional para administradores del sistema.") : undefined}
            >
              <select value={panelCompanyId} onChange={(event) => setPanelCompanyId(event.target.value)} required={panelRole !== "system_admin"}>
                <option value="">{t("Selecciona empresa")}</option>
                {companies.map((company) => (
                  <option key={company.id} value={company.id}>
                    {company.name}
                    {isArchived(company) ? ` (${t("archivada")})` : ""}
                  </option>
                ))}
              </select>
            </Field>
            <Field label={t("Rol")} hint={t(roleHelp[panelRole])}>
              <select value={panelRole} onChange={(event) => setPanelRole(event.target.value as PanelRole)}>
                {roles.map((role) => (
                  <option key={role} value={role}>
                    {t(roleLabels[role])}
                  </option>
                ))}
              </select>
            </Field>
            <Field label={t("Nombre completo")}>
              <input value={panelFullName} onChange={(event) => setPanelFullName(event.target.value)} placeholder={t("Nombre completo")} required />
            </Field>
            <Field label={t("Correo")}>
              <input
                type="email"
                value={panelEmail}
                onChange={(event) => setPanelEmail(event.target.value)}
                placeholder="supervisor@empresa.com"
                required
              />
            </Field>
          </form>
        )}
      </Drawer>

      {/* --- Editar usuario / restablecer contraseña ------------------------ */}
      <Drawer
        open={drawer === "user"}
        onClose={closeDrawer}
        title={userDrawerMode === "reset" ? t("Restablecer contraseña") : t("Editar usuario")}
        description={selectedUser ? `${selectedUser.email} · ${selectedUser.company || t("Sin empresa")}` : t("Elige un acceso para editarlo")}
        footer={
          userDrawerMode === "reset" ? (
            generatedCredential ? (
              <>
                {drawerStatus}
                <button type="button" className="btn" onClick={closeDrawer}>
                  {t("Listo")}
                </button>
              </>
            ) : (
              <>
                {drawerStatus}
                <button type="button" className="btn btn-ghost" onClick={closeDrawer}>
                  {t("Cancelar")}
                </button>
                <button type="submit" form="reset-password-form" className="btn btn-danger" disabled={!selectedUserId || saving}>
                  {t("Restablecer contraseña")}
                </button>
              </>
            )
          ) : (
            <>
              {drawerStatus}
              <button type="button" className="btn btn-ghost" onClick={closeDrawer}>
                {t("Cancelar")}
              </button>
              <button type="submit" form="edit-user-form" className="btn" disabled={!selectedUserId || saving}>
                {t("Guardar usuario")}
              </button>
            </>
          )
        }
      >
        {userDrawerMode === "reset" ? (
          generatedCredential ? (
            <CredentialBox credential={generatedCredential} t={t} />
          ) : (
            <form id="reset-password-form" className={styles.drawerForm} onSubmit={resetPanelPassword}>
              <p className={styles.drawerText}>
                {t("Se generará una contraseña temporal nueva y se cerrarán las sesiones abiertas de este usuario.")}
              </p>
              <Field label={t("Motivo del reset")} hint={t("Queda registrado en la auditoría.")}>
                <input
                  value={resetReason}
                  onChange={(event) => setResetReason(event.target.value)}
                  placeholder={t("Ej. cambio de responsable")}
                  disabled={!selectedUserId}
                />
              </Field>
            </form>
          )
        ) : (
          <form id="edit-user-form" className={styles.drawerForm} onSubmit={savePanelUser}>
            <div className="drawer-section">
              <Field label={t("Nombre")}>
                <input value={editFullName} onChange={(event) => setEditFullName(event.target.value)} disabled={!selectedUserId} />
              </Field>
              <div className="field-row">
                <Field label={t("Rol")}>
                  <select value={editRole} onChange={(event) => setEditRole(event.target.value as PanelRole)} disabled={!selectedUserId}>
                    {roles.map((role) => (
                      <option key={role} value={role}>
                        {t(roleLabels[role])}
                      </option>
                    ))}
                  </select>
                </Field>
                <Field label={t("Estado")}>
                  <select
                    value={editStatus}
                    onChange={(event) => setEditStatus(event.target.value as typeof editStatus)}
                    disabled={!selectedUserId}
                  >
                    <option value="active">{t("Activo")}</option>
                    <option value="inactive">{t("Inactivo")}</option>
                  </select>
                </Field>
              </div>
              <small className="field-hint">{t(roleHelp[editRole] || "")}</small>
            </div>
            {selectedUser ? (
              <div className="drawer-section">
                <h3>{t("Acceso y sesiones")}</h3>
                <dl className={styles.miniFacts}>
                  <div>
                    <dt>{t("Último ingreso")}</dt>
                    <dd>{selectedUser.last_login_at ? formatDateTime(selectedUser.last_login_at, locale) : t("Sin ingreso")}</dd>
                  </div>
                  <div>
                    <dt>{t("Sesiones activas")}</dt>
                    <dd>{selectedUser.active_sessions || 0}</dd>
                  </div>
                  <div>
                    <dt>{t("Contraseña")}</dt>
                    <dd>{selectedUser.password_change_required ? t("Temporal") : t("Definida por el usuario")}</dd>
                  </div>
                </dl>
                <div className={styles.inlineActions}>
                  <button type="button" className="btn btn-outline btn-sm" onClick={() => setUserDrawerMode("reset")}>
                    {t("Restablecer contraseña")}
                  </button>
                  <button type="button" className="btn btn-outline btn-sm" onClick={() => void revokePanelSessions()}>
                    {t("Cerrar sesiones")}
                  </button>
                </div>
              </div>
            ) : null}
          </form>
        )}
      </Drawer>
    </AppShell>
  );
}
