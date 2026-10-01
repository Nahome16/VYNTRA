"use client";

import { FormEvent, useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { AppShell } from "@/components/app-shell";
import { Chip, Drawer, EmptyBlock, RefreshButton, RowMenu, StatusLine, Tabs } from "@/components/ui";
import { useAuth } from "@/components/auth-provider";
import { usePreferences } from "@/components/preferences-provider";
import { IncidentsPanel } from "@/components/incidents-panel";
import { zonedDateISO } from "@/lib/dates";
import { useDialog } from "@/lib/use-dialog";
import { AccessCode, CatalogsResponse, Employee, ProductivityRule, UncategorizedItem } from "@/lib/types";
import styles from "./ajustes.module.css";

const sectionLabels = {
  usuarios: "Usuarios monitoreados",
  accesos: "Accesos",
  incidencias: "Incidencias",
  reglas: "Reglas",
  cuenta: "Cuenta",
} as const;

const classifications = ["productive", "neutral", "non_productive", "uncategorized"] as const;

type SectionKey = keyof typeof sectionLabels;
type RuleClassification = (typeof classifications)[number];
type AccessType = "station_reopen" | "overtime";
type RuleScope = "company" | "department" | "employee";
type RuleScopeKind = RuleScope | "position" | "pending";
type RuleRow =
  | { kind: "rule"; id: string; app: string; title: string; classification: string; scope: string; scopeKind: RuleScopeKind; department_id: string | null; rule: ProductivityRule }
  | { kind: "pending"; id: string; app: string; title: string; classification: "uncategorized"; scope: string; scopeKind: "pending"; department_id: string | null; item: UncategorizedItem };
type ChipTone = "plain" | "good" | "warn" | "bad" | "accent" | "info";

function isSectionKey(value: string): value is SectionKey {
  return value in sectionLabels;
}

/** Permiso de lectura que necesita cada seccion (null = siempre visible). */
const sectionPermissions: Record<SectionKey, string | null> = {
  usuarios: "employees:read",
  accesos: "access_codes:read",
  incidencias: "incidents:read",
  reglas: "rules:read",
  cuenta: null,
};

const accessTypeLabels: Record<AccessType, string> = {
  station_reopen: "Reabrir",
  overtime: "Horas extra",
};

const accessTypeTitles: Record<AccessType, string> = {
  station_reopen: "Reabrir estacion de marcaje",
  overtime: "Designar horas extra",
};

const EMPLOYEE_PAGE_SIZE = 8;

function accessStatusLabel(code: AccessCode) {
  if (code.status === "issued" && new Date(code.valid_until).getTime() <= Date.now()) {
    return "Vencido";
  }
  const labels: Record<string, string> = {
    issued: "Pendiente",
    sent: "Enviado",
    active: "Activo",
    used: "Usado",
    expired: "Vencido",
    revoked: "Revocado",
  };
  return labels[code.status] || code.status;
}

function accessStatusTone(label: string): ChipTone {
  const tones: Record<string, ChipTone> = {
    Pendiente: "accent",
    Enviado: "info",
    Activo: "good",
    Usado: "plain",
    Vencido: "plain",
    Revocado: "bad",
  };
  return tones[label] || "plain";
}

function classificationLabel(value: string) {
  const labels: Record<string, string> = {
    productive: "Productiva",
    neutral: "Neutral",
    non_productive: "No productiva",
    uncategorized: "Sin clasificar",
  };
  return labels[value] || value;
}

function classificationClass(value: string) {
  if (value === "productive") return styles.clsGood;
  if (value === "non_productive") return styles.clsBad;
  if (value === "uncategorized") return styles.clsWarn;
  return styles.clsPlain;
}

function scopeTone(kind: RuleScopeKind): ChipTone {
  if (kind === "department") return "info";
  if (kind === "employee") return "accent";
  if (kind === "pending") return "warn";
  return "plain";
}

function scopeLabel(rule: ProductivityRule, t: (text: string) => string) {
  if (rule.employee) return `${t("Empleado")}: ${rule.employee}`;
  if (rule.department) return `${t("Departamento")}: ${rule.department}`;
  if (rule.position) return `${t("Puesto")}: ${rule.position}`;
  return t("General");
}

function scopeKind(rule: ProductivityRule): RuleScopeKind {
  if (rule.employee_id) return "employee";
  if (rule.department_id) return "department";
  if (rule.position_id) return "position";
  return "company";
}

function initialsFor(name: string) {
  const initials = name
    .split(" ")
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase())
    .join("");
  return initials || "US";
}

function matchesNeedle(values: Array<string | null | undefined>, needle: string) {
  if (!needle) return true;
  return values.join(" ").toLowerCase().includes(needle);
}

function pageSlice<T>(rows: T[], page: number, pageSize: number) {
  return rows.slice((page - 1) * pageSize, page * pageSize);
}

function isCodeCurrent(code: AccessCode) {
  return code.status === "issued" && new Date(code.valid_until).getTime() > Date.now();
}

function deliveryStatusText(status?: string) {
  if (status === "sent") return "Enviado por correo";
  if (status === "failed") return "No se pudo enviar por correo";
  return "Entrega pendiente";
}

/** Cierra un menu flotante al hacer clic fuera o pulsar Escape. */
function useDismiss(open: boolean, close: () => void) {
  const ref = useRef<HTMLDivElement | null>(null);
  const closeRef = useRef(close);
  useEffect(() => {
    closeRef.current = close;
  }, [close]);
  useEffect(() => {
    if (!open) return undefined;
    const onDown = (event: MouseEvent) => {
      if (ref.current && !ref.current.contains(event.target as Node)) closeRef.current();
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") closeRef.current();
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);
  return ref;
}

function SearchField({ value, onChange, placeholder, label }: { value: string; onChange: (value: string) => void; placeholder: string; label: string }) {
  return (
    <div className={`search-input ${styles.search}`}>
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden>
        <circle cx="11" cy="11" r="7" />
        <path d="m20 20-3.5-3.5" />
      </svg>
      <input type="search" value={value} onChange={(event) => onChange(event.target.value)} placeholder={placeholder} aria-label={label} />
    </div>
  );
}

function PlusIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden>
      <path d="M12 5v14M5 12h14" />
    </svg>
  );
}

/** Confirmacion accesible para acciones destructivas. */
function ConfirmDialog({
  open,
  title,
  message,
  confirmLabel,
  cancelLabel,
  onConfirm,
  onCancel,
}: {
  open: boolean;
  title: string;
  message: string;
  confirmLabel: string;
  cancelLabel: string;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const titleId = useId();
  const messageId = useId();
  const ref = useDialog<HTMLDivElement>(open, onCancel);
  if (!open) return null;
  return (
    <>
      <div className="drawer-backdrop" onClick={onCancel} aria-hidden />
      <div ref={ref} className={styles.confirm} role="alertdialog" aria-modal="true" aria-labelledby={titleId} aria-describedby={messageId}>
        <span className={styles.confirmIcon} aria-hidden>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
            <path d="M3 6h18M8 6V4h8v2M19 6l-1 14H6L5 6" />
            <path d="M10 11v6M14 11v6" />
          </svg>
        </span>
        <h2 id={titleId}>{title}</h2>
        <p id={messageId}>{message}</p>
        <div className={styles.confirmActions}>
          <button type="button" className="btn btn-outline" data-autofocus onClick={onCancel}>{cancelLabel}</button>
          <button type="button" className={`btn ${styles.dangerSolid}`} onClick={onConfirm}>{confirmLabel}</button>
        </div>
      </div>
    </>
  );
}

export default function SettingsPage() {
  const { apiGet, apiPatch, apiPost, activeCompanyId, changePassword, hasPermission, user } = useAuth();
  const { t } = usePreferences();
  const [activeSection, setActiveSection] = useState<SectionKey>("usuarios");
  const canReadEmployees = hasPermission("employees:read");
  const canReadRules = hasPermission("rules:read");
  const canReadAccessCodes = hasPermission("access_codes:read");
  const visibleSections = useMemo(
    () => (Object.keys(sectionLabels) as SectionKey[]).filter((key) => {
      const permission = sectionPermissions[key];
      return !permission || hasPermission(permission);
    }),
    [hasPermission],
  );
  const currentSection: SectionKey = visibleSections.includes(activeSection) ? activeSection : visibleSections[0] || "cuenta";
  const [catalogs, setCatalogs] = useState<CatalogsResponse | null>(null);
  const [rules, setRules] = useState<ProductivityRule[]>([]);
  const [uncategorized, setUncategorized] = useState<UncategorizedItem[]>([]);
  const [accessCodes, setAccessCodes] = useState<AccessCode[]>([]);
  const [statusText, setStatusText] = useState("");
  const [loading, setLoading] = useState(false);
  const [settingsError, setSettingsError] = useState(false);
  const [currentPanelPassword, setCurrentPanelPassword] = useState("");
  const [newPanelPassword, setNewPanelPassword] = useState("");
  const [confirmPanelPassword, setConfirmPanelPassword] = useState("");
  const [changingPanelPassword, setChangingPanelPassword] = useState(false);
  const isSystemAdmin = user?.role === "system_admin";

  const [employeeSearch, setEmployeeSearch] = useState("");
  const [employeeDepartmentFilter, setEmployeeDepartmentFilter] = useState("");
  const [employeePage, setEmployeePage] = useState(1);
  const [showEmployeeModal, setShowEmployeeModal] = useState(false);
  const [editingEmployee, setEditingEmployee] = useState<Employee | null>(null);
  const [employeeName, setEmployeeName] = useState("");
  const [employeeEmail, setEmployeeEmail] = useState("");
  const [employeeDepartmentId, setEmployeeDepartmentId] = useState("");
  const [newDepartment, setNewDepartment] = useState("");
  const [generatedCredential, setGeneratedCredential] = useState<{
    email: string;
    password?: string;
    password_change_required?: boolean;
    delivery_status?: string;
  } | null>(null);
  const [resettingCredentialId, setResettingCredentialId] = useState("");
  const [archiveCandidate, setArchiveCandidate] = useState<Employee | null>(null);

  const [accessSearch, setAccessSearch] = useState("");
  const [accessDate, setAccessDate] = useState("");
  const [accessMenuOpen, setAccessMenuOpen] = useState(false);
  const [showAccessModal, setShowAccessModal] = useState(false);
  const [accessDraftType, setAccessDraftType] = useState<AccessType>("station_reopen");
  const [accessEmployeeId, setAccessEmployeeId] = useState("");
  const [accessValidMinutes, setAccessValidMinutes] = useState("60");
  const [accessAssignedMinutes, setAccessAssignedMinutes] = useState("120");
  const [accessReason, setAccessReason] = useState("");

  const [ruleSearch, setRuleSearch] = useState("");
  const [ruleDepartmentFilter, setRuleDepartmentFilter] = useState("");
  const [ruleClassificationFilter, setRuleClassificationFilter] = useState("");
  const [pendingOnly, setPendingOnly] = useState(false);
  const [quickRuleScope, setQuickRuleScope] = useState<Exclude<RuleScope, "employee">>("company");
  const [quickRuleDepartmentId, setQuickRuleDepartmentId] = useState("");
  const [showRuleModal, setShowRuleModal] = useState(false);
  const [editingRule, setEditingRule] = useState<ProductivityRule | null>(null);
  const [ruleScope, setRuleScope] = useState<RuleScope>("company");
  const [ruleDepartmentId, setRuleDepartmentId] = useState("");
  const [ruleEmployeeId, setRuleEmployeeId] = useState("");
  const [ruleExecutable, setRuleExecutable] = useState("");
  const [ruleTitle, setRuleTitle] = useState("");
  const [ruleClassification, setRuleClassification] = useState<RuleClassification>("productive");
  const [ruleNotes, setRuleNotes] = useState("");

  const closeAccessMenu = useCallback(() => setAccessMenuOpen(false), []);
  const accessMenuRef = useDismiss(accessMenuOpen, closeAccessMenu);
  const formIds = {
    employee: useId(),
    access: useId(),
    rule: useId(),
  };

  const loadSettings = useCallback(async () => {
    if (isSystemAdmin && !activeCompanyId) {
      setCatalogs(null);
      setRules([]);
      setUncategorized([]);
      setAccessCodes([]);
      setSettingsError(false);
      setStatusText(t("Selecciona una empresa en Sistema para administrar ajustes"));
      return;
    }
    setLoading(true);
    setSettingsError(false);
    setStatusText(t("Actualizando ajustes..."));
    const companyQuery = isSystemAdmin && activeCompanyId ? `?company_id=${encodeURIComponent(activeCompanyId)}` : "";
    const companyLimitQuery = isSystemAdmin && activeCompanyId
      ? `?company_id=${encodeURIComponent(activeCompanyId)}&limit=30`
      : "?limit=30";
    try {
      // Solo se consultan las secciones para las que el rol tiene permiso; asi no
      // se provocan respuestas 403 (p. ej. un rol sin rules:read).
      const [nextCatalogs, nextRules, nextUncategorized, nextCodes] = await Promise.all([
        canReadEmployees ? apiGet<CatalogsResponse>(`/api/productivity/catalogs${companyQuery}`) : Promise.resolve(null),
        canReadRules ? apiGet<{ rules: ProductivityRule[] }>(`/api/productivity/rules${companyQuery}`) : Promise.resolve({ rules: [] }),
        canReadRules
          ? apiGet<{ items: UncategorizedItem[] }>(`/api/productivity/uncategorized${companyLimitQuery}`)
          : Promise.resolve({ items: [] }),
        canReadAccessCodes ? apiGet<{ codes: AccessCode[] }>(`/api/settings/access-codes${companyQuery}`) : Promise.resolve({ codes: [] }),
      ]);
      setCatalogs(nextCatalogs);
      setRules(nextRules.rules);
      setUncategorized(nextUncategorized.items);
      setAccessCodes(nextCodes.codes);
      setAccessEmployeeId(
        (current) =>
          current ||
          nextCatalogs?.employees.find((employee) => employee.status === "active")?.id ||
          nextCatalogs?.employees[0]?.id ||
          "",
      );
      setStatusText(t("Datos actualizados"));
    } catch {
      setSettingsError(true);
      setStatusText(t("No se pudieron cargar ajustes"));
    } finally {
      setLoading(false);
    }
  }, [activeCompanyId, apiGet, canReadAccessCodes, canReadEmployees, canReadRules, isSystemAdmin, t]);

  useEffect(() => {
    if (!user) return;
    const timer = window.setTimeout(() => {
      void loadSettings();
    }, 0);
    return () => window.clearTimeout(timer);
  }, [loadSettings, user]);

  useEffect(() => {
    if (!isSystemAdmin) return;
    const timer = window.setTimeout(() => {
      setEmployeeDepartmentFilter("");
      setRuleDepartmentFilter("");
      setQuickRuleScope("company");
      setQuickRuleDepartmentId("");
      setAccessEmployeeId("");
      setRuleEmployeeId("");
      setRuleDepartmentId("");
    }, 0);
    return () => window.clearTimeout(timer);
  }, [activeCompanyId, isSystemAdmin]);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      const hashSection = window.location.hash.replace("#", "");
      if (isSectionKey(hashSection)) setActiveSection(hashSection);
    }, 0);
    return () => window.clearTimeout(timer);
  }, []);

  function selectSection(section: SectionKey) {
    setActiveSection(section);
    window.history.replaceState(null, "", `#${section}`);
  }

  const departments = useMemo(() => catalogs?.departments || [], [catalogs]);
  const activeCompanyName = catalogs?.company.name || user?.company || t("Empresa");
  const employees = useMemo(() => (catalogs?.employees || []).filter((employee) => employee.status !== "archived"), [catalogs]);
  const departmentMap = useMemo(
    () => new Map(departments.map((department) => [department.id, department.name])),
    [departments],
  );
  const scopedEmployees = useMemo(
    () =>
      ruleDepartmentId
        ? employees.filter((employee) => employee.department_id === ruleDepartmentId)
        : employees,
    [employees, ruleDepartmentId],
  );
  const activeEmployees = useMemo(
    () => employees.filter((employee) => employee.status === "active").length,
    [employees],
  );
  const activeCodes = useMemo(
    () => accessCodes.filter(isCodeCurrent).length,
    [accessCodes],
  );
  const summaryPills = useMemo(
    () => [
      `${activeEmployees} ${t("usuarios activos")}`,
      `${rules.length} ${t("reglas")}`,
      `${activeCodes} ${t("codigos vigentes")}`,
    ],
    [activeCodes, activeEmployees, rules.length, t],
  );
  const quickRuleScopeLabel = useMemo(() => {
    if (quickRuleScope !== "department") return t("General empresa");
    return quickRuleDepartmentId
      ? `${t("Departamento")}: ${departmentMap.get(quickRuleDepartmentId) || t("Departamento")}`
      : t("Departamento sin seleccionar");
  }, [departmentMap, quickRuleDepartmentId, quickRuleScope, t]);
  const ruleScopeSummaries = useMemo(() => {
    const generalRules = rules.filter((rule) => scopeKind(rule) === "company").length;
    return [
      { id: "general", label: t("General empresa"), count: generalRules },
      ...departments.map((department) => ({
        id: department.id,
        label: department.name,
        count: rules.filter((rule) => rule.department_id === department.id).length,
      })),
    ];
  }, [departments, rules, t]);

  const filteredEmployees = useMemo(() => {
    const needle = employeeSearch.trim().toLowerCase();
    return employees.filter((employee) => {
      const department = employee.department_id ? departmentMap.get(employee.department_id) || "" : "";
      const departmentMatches = !employeeDepartmentFilter || employee.department_id === employeeDepartmentFilter;
      return departmentMatches && matchesNeedle([employee.full_name, employee.email, employee.employee_code, department], needle);
    });
  }, [departmentMap, employeeDepartmentFilter, employeeSearch, employees]);

  const employeePageCount = Math.max(1, Math.ceil(filteredEmployees.length / EMPLOYEE_PAGE_SIZE));
  const currentEmployeePage = Math.min(employeePage, employeePageCount);
  const visibleEmployees = pageSlice(filteredEmployees, currentEmployeePage, EMPLOYEE_PAGE_SIZE);
  const firstVisibleEmployee = filteredEmployees.length ? (currentEmployeePage - 1) * EMPLOYEE_PAGE_SIZE + 1 : 0;
  const lastVisibleEmployee = (currentEmployeePage - 1) * EMPLOYEE_PAGE_SIZE + visibleEmployees.length;

  const filteredAccessCodes = useMemo(() => {
    const needle = accessSearch.trim().toLowerCase();
    return accessCodes.filter((code) => {
      const sourceDate = code.created_at || code.valid_from;
      const matchesDate = !accessDate || (sourceDate ? zonedDateISO(undefined, sourceDate) === accessDate : false);
      return matchesDate && matchesNeedle([code.employee, code.email, code.code, code.reason, code.type_label], needle);
    });
  }, [accessCodes, accessDate, accessSearch]);

  const ruleRows = useMemo<RuleRow[]>(() => {
    const existingRules: RuleRow[] = rules.map((rule) => ({
      kind: "rule",
      id: rule.id,
      app: rule.executable_name || "*",
      title: rule.title_contains || "*",
      classification: rule.classification,
      scope: scopeLabel(rule, t),
      scopeKind: scopeKind(rule),
      department_id: rule.department_id,
      rule,
    }));
    const pendingRows: RuleRow[] = uncategorized.map((item, index) => ({
      kind: "pending",
      id: `${item.executable_name}-${item.rule_title_contains || item.title_text}-${item.department_id || "general"}-${index}`,
      app: item.executable_name || t("(desconocido)"),
      title: item.rule_title_contains
        ? `${t("Regla")}: ${item.rule_title_contains} · ${t("Ejemplo")}: ${item.title_text || t("(sin titulo)")}`
        : item.executable_name
        ? `${t("Ejemplo")}: ${item.title_text || t("(sin titulo)")}`
        : item.title_text || t("(sin titulo)"),
      classification: "uncategorized",
      scope: item.department ? `${t("Pendiente")}: ${item.department}` : t("Pendiente sin departamento"),
      scopeKind: "pending",
      department_id: item.department_id,
      item,
    }));
    return pendingOnly ? pendingRows : [...existingRules, ...pendingRows];
  }, [pendingOnly, rules, t, uncategorized]);

  const filteredRuleRows = useMemo(() => {
    const needle = ruleSearch.trim().toLowerCase();
    return ruleRows.filter((row) => {
      const matchesDepartment =
        !ruleDepartmentFilter ||
        (ruleDepartmentFilter === "general" ? row.scopeKind === "company" : row.department_id === ruleDepartmentFilter);
      const matchesClassification = !ruleClassificationFilter || row.classification === ruleClassificationFilter;
      const matchesSearch = matchesNeedle([row.app, row.title, row.scope, t(classificationLabel(row.classification))], needle);
      return matchesDepartment && matchesClassification && matchesSearch;
    });
  }, [ruleClassificationFilter, ruleDepartmentFilter, ruleRows, ruleSearch, t]);
  const hasRuleFilters = Boolean(ruleDepartmentFilter || ruleClassificationFilter || pendingOnly || ruleSearch);

  function openEmployeeModal(employee?: Employee) {
    setEditingEmployee(employee || null);
    setGeneratedCredential(null);
    setEmployeeName(employee?.full_name || "");
    setEmployeeEmail(employee?.email || "");
    setEmployeeDepartmentId(employee?.department_id || "");
    setNewDepartment("");
    setShowEmployeeModal(true);
  }

  function closeEmployeeModal() {
    setShowEmployeeModal(false);
    setEditingEmployee(null);
    setGeneratedCredential(null);
    setEmployeeName("");
    setEmployeeEmail("");
    setEmployeeDepartmentId("");
    setNewDepartment("");
  }

  async function handleSaveEmployee(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setStatusText(editingEmployee ? t("Actualizando usuario monitoreado...") : t("Creando usuario monitoreado..."));
    setGeneratedCredential(null);
    try {
      if (editingEmployee) {
        const response = await apiPatch<{ employee: Employee }>(`/api/settings/employees/${editingEmployee.id}`, {
          full_name: employeeName,
          email: employeeEmail,
          department_id: employeeDepartmentId || null,
          new_department: newDepartment || null,
        });
        setCatalogs((current) =>
          current
            ? {
                ...current,
                employees: current.employees.map((employee) =>
                  employee.id === response.employee.id ? response.employee : employee,
                ),
              }
            : current,
        );
        closeEmployeeModal();
        setStatusText(t("Usuario actualizado"));
        return;
      }

      const response = await apiPost<{
        employee: Employee;
        credentials: { email: string; password?: string; delivery_status: string; password_change_required?: boolean };
      }>("/api/settings/employees", {
        company_id: isSystemAdmin ? activeCompanyId || null : null,
        full_name: employeeName,
        email: employeeEmail,
        department_id: employeeDepartmentId || null,
        new_department: newDepartment || null,
      });
      setGeneratedCredential({
        email: response.credentials.email,
        password: response.credentials.password,
        password_change_required: response.credentials.password_change_required,
        delivery_status: response.credentials.delivery_status,
      });
      setEmployeeName("");
      setEmployeeEmail("");
      setEmployeeDepartmentId("");
      setNewDepartment("");
      await loadSettings();
      setStatusText(
        response.credentials.delivery_status === "sent"
          ? t("Usuario creado y credencial enviada por correo.")
          : response.credentials.password
          ? t("Usuario creado. Guarda la credencial generada antes de cerrar.")
          : t("Usuario creado. Configura entrega de credenciales para activarlo."),
      );
    } catch {
      setStatusText(t("No se pudo guardar el usuario. Revisa correo duplicado o formato invalido."));
    }
  }

  async function resetEmployeeCredentials(employee: Employee) {
    if (employee.status !== "active") {
      setStatusText(t("Activa el usuario antes de reenviar credenciales."));
      return;
    }
    setResettingCredentialId(employee.id);
    setStatusText(`${t("Regenerando credencial para")} ${employee.full_name}...`);
    try {
      const response = await apiPost<{
        credentials: { email: string; password?: string; delivery_status: string; password_change_required?: boolean };
      }>(`/api/settings/employees/${employee.id}/reset-credentials`, {});
      setStatusText(
        response.credentials.delivery_status === "sent"
          ? `${t("Credencial enviada por correo a")} ${response.credentials.email}.`
          : response.credentials.password
          ? `${t("Credencial regenerada para")} ${response.credentials.email}.`
          : `${t("No se pudo enviar la credencial a")} ${response.credentials.email}. ${t("Revisa SMTP o el buzon.")}`,
      );
    } catch {
      setStatusText(t("No se pudo regenerar la credencial del usuario."));
    } finally {
      setResettingCredentialId("");
    }
  }

  function openAccessModal(type: AccessType) {
    const defaultEmployeeId =
      accessEmployeeId ||
      employees.find((employee) => employee.status === "active")?.id ||
      employees[0]?.id ||
      "";
    setAccessDraftType(type);
    setAccessEmployeeId(defaultEmployeeId);
    setAccessValidMinutes(type === "overtime" ? "120" : "60");
    setAccessAssignedMinutes(type === "overtime" ? "120" : "");
    setAccessReason(type === "overtime" ? t("Designar horas extra") : t("Reabrir estacion de marcaje"));
    setAccessMenuOpen(false);
    setShowAccessModal(true);
  }

  function closeAccessModal() {
    setShowAccessModal(false);
    setAccessReason("");
  }

  async function handleCreateAccessCode(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!accessEmployeeId) {
      setStatusText(t("Selecciona o crea un usuario antes de generar codigo"));
      return;
    }
    setStatusText(t("Generando codigo..."));
    try {
      const response = await apiPost<{ code: AccessCode; delivery_status?: string }>("/api/settings/access-codes", {
        company_id: isSystemAdmin ? activeCompanyId || null : null,
        type: accessDraftType,
        employee_id: accessEmployeeId,
        valid_minutes: Number(accessValidMinutes),
        assigned_minutes: accessDraftType === "overtime" ? Number(accessAssignedMinutes || accessValidMinutes) : undefined,
        reason: accessReason,
      });
      setAccessCodes((current) => [response.code, ...current.filter((code) => code.id !== response.code.id)]);
      closeAccessModal();
      setStatusText(
        response.delivery_status === "sent"
          ? t("Codigo generado y enviado por correo.")
          : response.code.code
          ? t("Codigo generado y agregado a la tabla")
          : t("Codigo generado. Configura entrega segura para enviarlo."),
      );
    } catch {
      setStatusText(t("No se pudo generar el codigo"));
    }
  }

  function openRuleModal(rule?: ProductivityRule) {
    setEditingRule(rule || null);
    if (rule) {
      setRuleScope(rule.employee_id ? "employee" : rule.department_id ? "department" : "company");
      setRuleDepartmentId(rule.department_id || "");
      setRuleEmployeeId(rule.employee_id || "");
      setRuleExecutable(rule.executable_name || "");
      setRuleTitle(rule.title_contains || "");
      setRuleClassification(rule.classification as RuleClassification);
      setRuleNotes(rule.notes || "");
    } else {
      setRuleScope(quickRuleScope === "department" && quickRuleDepartmentId ? "department" : "company");
      setRuleDepartmentId(quickRuleScope === "department" ? quickRuleDepartmentId : "");
      setRuleEmployeeId("");
      setRuleExecutable("");
      setRuleTitle("");
      setRuleClassification("productive");
      setRuleNotes("");
    }
    setShowRuleModal(true);
  }

  function closeRuleModal() {
    setShowRuleModal(false);
    setEditingRule(null);
    setRuleScope("company");
    setRuleDepartmentId("");
    setRuleEmployeeId("");
    setRuleExecutable("");
    setRuleTitle("");
    setRuleClassification("productive");
    setRuleNotes("");
  }

  async function handleSaveRule(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setStatusText(editingRule ? t("Actualizando regla...") : t("Creando regla productiva..."));
    const payload = {
      company_id: isSystemAdmin ? activeCompanyId || null : null,
      executable_name: ruleExecutable,
      title_contains: ruleTitle,
      classification: ruleClassification,
      priority: editingRule?.priority || 100,
      notes: ruleNotes,
      department_id: ruleScope === "department" ? ruleDepartmentId : null,
      employee_id: ruleScope === "employee" ? ruleEmployeeId : null,
      position_id: null,
      reclassify: true,
      rebuild_blocks: true,
    };
    try {
      if (editingRule) {
        const response = await apiPatch<{ rule: ProductivityRule }>(`/api/productivity/rules/${editingRule.id}`, payload);
        setRules((current) => current.map((rule) => (rule.id === editingRule.id ? response.rule : rule)));
        closeRuleModal();
        setStatusText(t("Regla actualizada"));
        return;
      }
      await apiPost("/api/productivity/rules", payload);
      closeRuleModal();
      await loadSettings();
      setStatusText(t("Regla creada y reclasificacion encolada"));
    } catch {
      setStatusText(t("No se pudo guardar la regla. Debe tener app o titulo y un alcance valido."));
    }
  }

  async function updateRuleClassification(row: RuleRow, classification: RuleClassification) {
    if (classification === row.classification) return;
    if (row.kind === "pending" && !row.item.department_id && quickRuleScope === "department" && !quickRuleDepartmentId) {
      setStatusText(t("Selecciona el departamento al que aplicara esta regla"));
      return;
    }
    setStatusText(t("Actualizando clasificacion..."));
    try {
      if (row.kind === "rule") {
        const response = await apiPatch<{ rule: ProductivityRule }>(`/api/productivity/rules/${row.id}`, {
          classification,
          reclassify: true,
          rebuild_blocks: true,
        });
        setRules((current) => current.map((rule) => (rule.id === row.id ? response.rule : rule)));
      } else {
        const pendingDepartmentId = row.item.department_id || (quickRuleScope === "department" ? quickRuleDepartmentId : null);
        const pendingScopeLabel = row.item.department
          ? `Departamento: ${row.item.department}`
          : quickRuleScope !== "department"
          ? "General empresa"
          : quickRuleDepartmentId
          ? `Departamento: ${departmentMap.get(quickRuleDepartmentId) || "Departamento"}`
          : "Departamento sin seleccionar";
        await apiPost("/api/productivity/rules", {
          company_id: isSystemAdmin ? activeCompanyId || null : null,
          executable_name: row.item.executable_name,
          title_contains: row.item.rule_title_contains ?? (row.item.executable_name ? "" : row.item.title_text),
          classification,
          priority: 120,
          notes: `Creada desde pendientes de clasificar - ${pendingScopeLabel}`,
          department_id: pendingDepartmentId,
          employee_id: null,
          reclassify: true,
          rebuild_blocks: true,
        });
        setUncategorized((current) => current.filter((item) => item !== row.item));
        await loadSettings();
      }
      setStatusText(t("Clasificacion actualizada"));
    } catch {
      setStatusText(t("No se pudo actualizar la clasificacion"));
    }
  }

  async function toggleEmployeeStatus(employee: Employee) {
    if (employee.status === "archived") {
      setStatusText(t("El usuario esta archivado. Usa Restaurar para recuperarlo."));
      return;
    }
    const status = employee.status === "active" ? "inactive" : "active";
    setStatusText(t("Actualizando estado del usuario..."));
    try {
      const response = await apiPatch<{ employee: Employee }>(`/api/settings/employees/${employee.id}`, { status });
      setCatalogs((current) =>
        current
          ? {
              ...current,
              employees: current.employees.map((row) =>
                row.id === response.employee.id ? response.employee : row,
              ),
            }
          : current,
      );
      setStatusText(status === "active" ? t("Usuario activado") : t("Usuario desactivado"));
    } catch {
      setStatusText(t("No se pudo actualizar el estado del usuario"));
    }
  }

  async function archiveEmployee(employee: Employee) {
    setArchiveCandidate(null);
    setStatusText(t("Eliminando usuario monitoreado..."));
    try {
      const response = await apiPost<{ employee: Employee }>(`/api/settings/employees/${employee.id}/archive`, {
        reason: "Eliminado desde ajustes",
      });
      setCatalogs((current) =>
        current
          ? {
              ...current,
              employees: current.employees.filter((row) => row.id !== response.employee.id),
            }
          : current,
      );
      setStatusText(t("Usuario monitoreado eliminado"));
    } catch {
      setStatusText(t("No se pudo eliminar el usuario monitoreado"));
    }
  }

  async function restoreEmployee(employee: Employee) {
    setStatusText(t("Restaurando usuario monitoreado..."));
    try {
      const response = await apiPost<{ employee: Employee }>(`/api/settings/employees/${employee.id}/restore`, {
        reason: "Restaurado desde ajustes",
      });
      setCatalogs((current) =>
        current
          ? {
              ...current,
              employees: current.employees.map((row) =>
                row.id === response.employee.id ? response.employee : row,
              ),
            }
          : current,
      );
      setStatusText(t("Usuario monitoreado restaurado"));
    } catch {
      setStatusText(t("No se pudo restaurar el usuario monitoreado"));
    }
  }

  async function handleChangePanelPassword(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (newPanelPassword.length < 8) {
      setStatusText(t("La nueva contrasena debe tener al menos 8 caracteres"));
      return;
    }
    if (newPanelPassword !== confirmPanelPassword) {
      setStatusText(t("La confirmacion no coincide con la nueva contrasena"));
      return;
    }
    if (currentPanelPassword === newPanelPassword) {
      setStatusText(t("La nueva contrasena debe ser diferente a la actual"));
      return;
    }
    setChangingPanelPassword(true);
    setStatusText(t("Actualizando contrasena del panel..."));
    try {
      await changePassword(currentPanelPassword, newPanelPassword);
      setCurrentPanelPassword("");
      setNewPanelPassword("");
      setConfirmPanelPassword("");
      setStatusText(t("Contrasena del panel actualizada"));
    } catch {
      setStatusText(t("No se pudo cambiar la contrasena. Revisa tu contrasena actual."));
    } finally {
      setChangingPanelPassword(false);
    }
  }

  function clearRuleFilters() {
    setRuleSearch("");
    setRuleDepartmentFilter("");
    setRuleClassificationFilter("");
    setPendingOnly(false);
  }

  const noCompanySelected = isSystemAdmin && !activeCompanyId;

  return (
    <AppShell
      title={t("Ajustes")}
      description={`${activeCompanyName} - ${t("usuarios, accesos, incidencias y reglas por empresa.")}`}
      actions={<RefreshButton loading={loading} onClick={() => void loadSettings()} />}
    >
      <div className={styles.page}>
        <div className={styles.tabBar}>
          <div className={styles.tabsReset}>
            <Tabs<SectionKey>
              value={currentSection}
              onChange={selectSection}
              tabs={visibleSections.map((key) => ({ id: key, label: t(sectionLabels[key]) }))}
            />
          </div>
          <ul className={styles.summary} aria-label={t("Resumen de sistema")}>
            {summaryPills.map((pill) => (
              <li key={pill}>{pill}</li>
            ))}
          </ul>
        </div>

        {noCompanySelected ? (
          <EmptyBlock
            title={t("Selecciona una empresa")}
            description={t("Selecciona una empresa en Sistema para administrar ajustes")}
          />
        ) : null}

        {settingsError && !noCompanySelected ? (
          <EmptyBlock
            title={t("No se pudieron cargar ajustes")}
            description={t("Revisa la conexion con la API o vuelve a intentar.")}
            action={
              <button type="button" className="btn btn-outline btn-sm" onClick={() => void loadSettings()}>
                {t("Reintentar")}
              </button>
            }
          />
        ) : null}

        {!settingsError && !noCompanySelected && currentSection === "usuarios" ? (
          <section className={styles.section} aria-label={t(sectionLabels.usuarios)}>
            <div className="toolbar">
              <SearchField
                value={employeeSearch}
                onChange={(value) => {
                  setEmployeePage(1);
                  setEmployeeSearch(value);
                }}
                placeholder={t("Buscar empleado...")}
                label={t("Buscar empleado")}
              />
              <select
                className={styles.filterSelect}
                aria-label={t("Departamento")}
                value={employeeDepartmentFilter}
                onChange={(event) => {
                  setEmployeePage(1);
                  setEmployeeDepartmentFilter(event.target.value);
                }}
              >
                <option value="">{t("Todos los departamentos")}</option>
                {departments.map((department) => (
                  <option value={department.id} key={department.id}>{department.name}</option>
                ))}
              </select>
              <span className="grow" />
              <button className="btn" type="button" onClick={() => openEmployeeModal()}>
                <PlusIcon />
                {t("Nuevo usuario")}
              </button>
            </div>

            <div className={styles.card}>
              {visibleEmployees.length ? (
                <div className={styles.tableWrap}>
                  <table className={styles.table}>
                    <thead>
                      <tr>
                        <th>{t("Empleado")}</th>
                        <th>{t("Codigo")}</th>
                        <th>{t("Departamento")}</th>
                        <th>{t("Estado")}</th>
                        <th aria-label={t("Acciones")} />
                      </tr>
                    </thead>
                    <tbody>
                      {visibleEmployees.map((employee) => {
                        const status = employee.status;
                        const isActive = status === "active";
                        return (
                          <tr key={employee.id}>
                            <td>
                              <div className={styles.person}>
                                <span className={`avatar ${styles.avatar}`} aria-hidden>{initialsFor(employee.full_name)}</span>
                                <div>
                                  <strong>{employee.full_name}</strong>
                                  <small>{employee.email || t("Sin correo")}</small>
                                </div>
                              </div>
                            </td>
                            <td><span className={`mono ${styles.code}`}>{employee.employee_code}</span></td>
                            <td>{employee.department_id ? departmentMap.get(employee.department_id) || t("Sin departamento") : t("Sin departamento")}</td>
                            <td>
                              <div className={styles.statusCell}>
                                <button
                                  className={styles.switch}
                                  type="button"
                                  role="switch"
                                  aria-checked={isActive}
                                  onClick={() => void toggleEmployeeStatus(employee)}
                                  aria-label={`${t("Cambiar estado de")} ${employee.full_name}`}
                                  title={isActive ? t("Desactivar usuario") : t("Activar usuario")}
                                >
                                  <span />
                                </button>
                                <span className={isActive ? styles.statusOn : styles.statusOff}>
                                  {status === "archived" ? t("Archivado") : isActive ? t("Activo") : t("Inactivo")}
                                </span>
                              </div>
                            </td>
                            <td className={styles.menuCol}>
                              <RowMenu
                                label={`${t("Acciones de")} ${employee.full_name}`}
                                items={[
                                  { label: t("Editar"), onSelect: () => openEmployeeModal(employee) },
                                  {
                                    label: resettingCredentialId === employee.id ? t("Enviando...") : t("Reenviar credenciales"),
                                    onSelect: () => {
                                      if (resettingCredentialId === employee.id) return;
                                      void resetEmployeeCredentials(employee);
                                    },
                                  },
                                  {
                                    label: isActive ? t("Desactivar usuario") : t("Activar usuario"),
                                    onSelect: () => void toggleEmployeeStatus(employee),
                                  },
                                  employee.status === "archived"
                                    ? { label: t("Restaurar"), onSelect: () => void restoreEmployee(employee), separatorBefore: true }
                                    : { label: t("Eliminar"), onSelect: () => setArchiveCandidate(employee), danger: true, separatorBefore: true },
                                ]}
                              />
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              ) : (
                <div className={styles.cardEmpty}>
                  <EmptyBlock
                    title={t("No hay usuarios para el filtro actual.")}
                    description={employees.length ? t("Prueba con otro nombre o departamento.") : t("Agrega el primer usuario monitoreado de la empresa.")}
                    action={
                      employees.length ? (
                        <button
                          type="button"
                          className="btn btn-outline btn-sm"
                          onClick={() => {
                            setEmployeeSearch("");
                            setEmployeeDepartmentFilter("");
                            setEmployeePage(1);
                          }}
                        >
                          {t("Limpiar filtros")}
                        </button>
                      ) : (
                        <button type="button" className="btn btn-sm" onClick={() => openEmployeeModal()}>{t("Nuevo usuario")}</button>
                      )
                    }
                  />
                </div>
              )}

              <footer className={styles.pagination}>
                <span>
                  {filteredEmployees.length
                    ? `${firstVisibleEmployee}–${lastVisibleEmployee} ${t("de")} ${filteredEmployees.length}`
                    : `0 ${t("usuarios")}`}
                </span>
                <div>
                  <button className="btn btn-outline btn-sm" type="button" disabled={currentEmployeePage <= 1} onClick={() => setEmployeePage((page) => Math.max(1, Math.min(page, employeePageCount) - 1))}>
                    {t("Anterior")}
                  </button>
                  <span className="tabular">{currentEmployeePage} / {employeePageCount}</span>
                  <button className="btn btn-outline btn-sm" type="button" disabled={currentEmployeePage >= employeePageCount} onClick={() => setEmployeePage((page) => Math.min(employeePageCount, page + 1))}>
                    {t("Siguiente")}
                  </button>
                </div>
              </footer>
            </div>
          </section>
        ) : null}

        {!settingsError && !noCompanySelected && currentSection === "accesos" ? (
          <section className={styles.section} aria-label={t(sectionLabels.accesos)}>
            <div className="toolbar">
              <SearchField
                value={accessSearch}
                onChange={setAccessSearch}
                placeholder={t("Buscar empleado, codigo o tipo...")}
                label={t("Buscar codigo")}
              />
              <input className={styles.dateInput} type="date" value={accessDate} onChange={(event) => setAccessDate(event.target.value)} aria-label={t("Fecha")} />
              {accessDate ? (
                <button type="button" className="btn btn-ghost btn-sm" onClick={() => setAccessDate("")}>{t("Quitar fecha")}</button>
              ) : null}
              <span className="grow" />
              <div className="menu-anchor" ref={accessMenuRef}>
                <button
                  className="btn"
                  type="button"
                  aria-haspopup="menu"
                  aria-expanded={accessMenuOpen}
                  onClick={() => setAccessMenuOpen((open) => !open)}
                >
                  <PlusIcon />
                  {t("Generar codigo")}
                  <svg className={styles.caret} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                    <path d="m6 9 6 6 6-6" />
                  </svg>
                </button>
                {accessMenuOpen ? (
                  <div className={`context-menu ${styles.menuWide}`} role="menu" aria-label={t("Elegir tipo de codigo")}>
                    <span className={styles.menuLabel}>{t("Elegir tipo de codigo")}</span>
                    <button type="button" role="menuitem" onClick={() => openAccessModal("station_reopen")}>
                      <span className={styles.menuItem}>
                        <strong>{t("Reabrir estacion de marcaje")}</strong>
                        <small>{t("Permite volver a marcar tras cerrar la jornada.")}</small>
                      </span>
                    </button>
                    <button type="button" role="menuitem" onClick={() => openAccessModal("overtime")}>
                      <span className={styles.menuItem}>
                        <strong>{t("Designar horas extra")}</strong>
                        <small>{t("Autoriza minutos adicionales de trabajo.")}</small>
                      </span>
                    </button>
                  </div>
                ) : null}
              </div>
            </div>

            <div className={styles.card}>
              {filteredAccessCodes.length ? (
                <div className={styles.tableWrap}>
                  <table className={styles.table}>
                    <thead>
                      <tr>
                        <th>{t("Empleado")}</th>
                        <th>{t("Tipo")}</th>
                        <th>{t("Codigo")}</th>
                        <th>{t("Estado")}</th>
                        <th>{t("Valido hasta")}</th>
                      </tr>
                    </thead>
                    <tbody>
                      {filteredAccessCodes.map((code) => {
                        const statusLabel = accessStatusLabel(code);
                        return (
                          <tr key={code.id}>
                            <td>
                              <div className={styles.stack}>
                                <strong>{code.employee || code.email}</strong>
                                {code.reason ? <small>{code.reason}</small> : null}
                              </div>
                            </td>
                            <td>
                              <Chip tone={code.type === "overtime" ? "accent" : "info"} dot={false}>
                                {code.type_label || t(accessTypeLabels[code.type])}
                                {code.type === "overtime" && code.assigned_minutes ? ` · ${code.assigned_minutes} min` : ""}
                              </Chip>
                            </td>
                            <td>
                              {code.code ? (
                                <span className={`mono ${styles.codeValue}`}>{code.code}</span>
                              ) : (
                                <span className={styles.muted}>{t("Entrega pendiente")}</span>
                              )}
                            </td>
                            <td><Chip tone={accessStatusTone(statusLabel)}>{t(statusLabel)}</Chip></td>
                            <td className="tabular">{new Date(code.valid_until).toLocaleString("es-NI")}</td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              ) : (
                <div className={styles.cardEmpty}>
                  <EmptyBlock
                    title={t("No hay codigos para el filtro actual.")}
                    description={t("Genera un codigo para reabrir la estacion o autorizar horas extra.")}
                  />
                </div>
              )}
            </div>
            <p className="field-hint">{t("Elige un tipo en Generar codigo, completa usuario y vigencia. La estacion consume el codigo una sola vez contra el servidor.")}</p>
          </section>
        ) : null}

        {!settingsError && !noCompanySelected && currentSection === "reglas" ? (
          <section className={styles.section} aria-label={t(sectionLabels.reglas)}>
            <div className="toolbar">
              <SearchField
                value={ruleSearch}
                onChange={setRuleSearch}
                placeholder={t("Buscar app, titulo o alcance...")}
                label={t("Buscar regla")}
              />
              <select
                className={styles.filterSelect}
                aria-label={t("Filtrar por departamento")}
                value={ruleDepartmentFilter}
                onChange={(event) => {
                  setRuleDepartmentFilter(event.target.value);
                  setPendingOnly(false);
                }}
              >
                <option value="">{t("Todos los alcances")}</option>
                <option value="general">{t("General")}</option>
                {departments.map((department) => (
                  <option value={department.id} key={department.id}>{department.name}</option>
                ))}
              </select>
              <select
                className={styles.filterSelect}
                aria-label={t("Filtrar por clasificacion")}
                value={ruleClassificationFilter}
                onChange={(event) => {
                  setRuleClassificationFilter(event.target.value);
                  setPendingOnly(false);
                }}
              >
                <option value="">{t("Todas las clasificaciones")}</option>
                {classifications.map((classification) => (
                  <option value={classification} key={classification}>{t(classificationLabel(classification))}</option>
                ))}
              </select>
              <button
                className={styles.pendingToggle}
                type="button"
                aria-pressed={pendingOnly}
                onClick={() => {
                  setPendingOnly((current) => {
                    const next = !current;
                    setRuleDepartmentFilter("");
                    setRuleClassificationFilter(next ? "uncategorized" : "");
                    return next;
                  });
                }}
              >
                <i aria-hidden />
                {uncategorized.length} {t("pendientes de clasificar")}
              </button>
              {hasRuleFilters ? (
                <button type="button" className="btn btn-ghost btn-sm" onClick={clearRuleFilters}>{t("Limpiar filtros")}</button>
              ) : null}
              <span className="grow" />
              <button className="btn" type="button" onClick={() => openRuleModal()}>
                <PlusIcon />
                {t("Nueva regla")}
              </button>
            </div>

            <div className={styles.scopeBar}>
              <div className={styles.scopeList} role="group" aria-label={t("Resumen de reglas por alcance")}>
                {ruleScopeSummaries.map((scope) => (
                  <button
                    type="button"
                    key={scope.id}
                    aria-pressed={ruleDepartmentFilter === scope.id}
                    onClick={() => {
                      setPendingOnly(false);
                      setRuleClassificationFilter("");
                      setRuleDepartmentFilter(scope.id);
                      if (scope.id === "general") {
                        setQuickRuleScope("company");
                        setQuickRuleDepartmentId("");
                      } else {
                        setQuickRuleScope("department");
                        setQuickRuleDepartmentId(scope.id);
                      }
                    }}
                  >
                    <span>{scope.label}</span>
                    <b className="tabular">{scope.count}</b>
                  </button>
                ))}
              </div>
            </div>

            <div className={styles.pendingScope}>
              <div>
                <strong>{t("Nuevas clasificaciones pendientes")}</strong>
                <span>
                  {t("Aplicar a")}: <b>{quickRuleScopeLabel}</b>. {t("Cuando cambies una app pendiente desde la tabla, la regla se creara con este alcance.")}
                </span>
              </div>
              <div className={styles.pendingScopeControls}>
                <select
                  aria-label={t("Alcance")}
                  value={quickRuleScope}
                  onChange={(event) => {
                    const nextScope = event.target.value as Exclude<RuleScope, "employee">;
                    setQuickRuleScope(nextScope);
                    setQuickRuleDepartmentId(nextScope === "department" ? quickRuleDepartmentId || departments[0]?.id || "" : "");
                  }}
                >
                  <option value="company">{t("General empresa")}</option>
                  <option value="department">{t("Departamento")}</option>
                </select>
                <select
                  aria-label={t("Departamento")}
                  value={quickRuleDepartmentId}
                  onChange={(event) => setQuickRuleDepartmentId(event.target.value)}
                  disabled={quickRuleScope !== "department"}
                >
                  <option value="">{t("Selecciona departamento")}</option>
                  {departments.map((department) => (
                    <option value={department.id} key={department.id}>{department.name}</option>
                  ))}
                </select>
              </div>
            </div>

            <div className={styles.card}>
              {filteredRuleRows.length ? (
                <div className={styles.tableWrap}>
                  <table className={styles.table}>
                    <thead>
                      <tr>
                        <th>{t("App / titulo")}</th>
                        <th>{t("Clasificacion")}</th>
                        <th>{t("Alcance")}</th>
                        <th aria-label={t("Acciones")} />
                      </tr>
                    </thead>
                    <tbody>
                      {filteredRuleRows.slice(0, 100).map((row) => (
                        <tr key={`${row.kind}-${row.id}`}>
                          <td>
                            <div className={styles.stack}>
                              <strong className="mono">{row.app}</strong>
                              <small>{row.title}</small>
                            </div>
                          </td>
                          <td>
                            <select
                              className={`${styles.classSelect} ${classificationClass(row.classification)}`}
                              value={row.classification}
                              onChange={(event) => void updateRuleClassification(row, event.target.value as RuleClassification)}
                              title={t("Cambiar clasificacion")}
                              aria-label={`${t("Cambiar clasificacion")} ${row.app}`}
                            >
                              {classifications.map((classification) => (
                                <option value={classification} key={classification}>
                                  {t(classificationLabel(classification))}
                                </option>
                              ))}
                            </select>
                          </td>
                          <td>
                            <div className={styles.stack}>
                              <Chip tone={scopeTone(row.scopeKind)} dot={false}>{row.scope}</Chip>
                              {row.kind === "pending" ? (
                                <small>
                                  {t("Nueva regla")}: {row.item.department ? `${t("Departamento")}: ${row.item.department}` : quickRuleScopeLabel}
                                </small>
                              ) : null}
                            </div>
                          </td>
                          <td className={styles.menuCol}>
                            {row.kind === "rule" ? (
                              <RowMenu
                                label={`${t("Acciones de")} ${row.app}`}
                                items={[{ label: t("Editar regla"), onSelect: () => openRuleModal(row.rule) }]}
                              />
                            ) : null}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ) : (
                <div className={styles.cardEmpty}>
                  <EmptyBlock
                    title={t("No hay reglas para el filtro actual.")}
                    description={t("Cambia los filtros o crea una regla nueva.")}
                    action={
                      hasRuleFilters ? (
                        <button type="button" className="btn btn-outline btn-sm" onClick={clearRuleFilters}>{t("Limpiar filtros")}</button>
                      ) : undefined
                    }
                  />
                </div>
              )}
              {filteredRuleRows.length > 100 ? (
                <footer className={styles.pagination}>
                  <span>{t("Mostrando las primeras 100 de")} {filteredRuleRows.length}. {t("Usa la busqueda para acotar.")}</span>
                </footer>
              ) : null}
            </div>
            <p className="field-hint">{t("Filtros combinables. Cambia la clasificacion directamente en la tabla para reclasificar sin salir.")}</p>
          </section>
        ) : null}

        {!settingsError && !noCompanySelected && currentSection === "incidencias" ? (
          <section className={styles.section} aria-label={t(sectionLabels.incidencias)}>
            <IncidentsPanel active={currentSection === "incidencias"} />
          </section>
        ) : null}

        {!settingsError && !noCompanySelected && currentSection === "cuenta" ? (
          <section className={styles.accountGrid} aria-label={t(sectionLabels.cuenta)}>
            <div className={styles.card}>
              <header className={styles.cardHead}>
                <h2>{t("Cuenta del panel")}</h2>
              </header>
              <div className={styles.cardBody}>
                <div className={styles.person}>
                  <span className="avatar lg" aria-hidden>{initialsFor(user?.full_name || t("Usuario del panel"))}</span>
                  <div>
                    <strong className={styles.accountName}>{user?.full_name || t("Usuario del panel")}</strong>
                    <small>{user?.email || t("Sin correo")} · {user?.role || t("rol")}</small>
                  </div>
                </div>
                <dl className={styles.facts}>
                  <div>
                    <dt>{t("Empresa activa")}</dt>
                    <dd>{activeCompanyName}</dd>
                  </div>
                  <div>
                    <dt>{t("Ultimo cambio de contrasena")}</dt>
                    <dd>{user?.password_changed_at ? new Date(user.password_changed_at).toLocaleString("es-NI") : t("Pendiente")}</dd>
                  </div>
                </dl>
              </div>
            </div>

            <form className={`${styles.card} ${styles.form}`} onSubmit={handleChangePanelPassword}>
              <header className={styles.cardHead}>
                <h2>{t("Cambiar contrasena")}</h2>
              </header>
              <div className={styles.cardBody}>
                <label>{t("Contrasena actual")}
                  <input
                    type="password"
                    value={currentPanelPassword}
                    onChange={(event) => setCurrentPanelPassword(event.target.value)}
                    autoComplete="current-password"
                    required
                  />
                </label>
                <div className="field-row">
                  <label>{t("Nueva contrasena")}
                    <input
                      type="password"
                      value={newPanelPassword}
                      onChange={(event) => setNewPanelPassword(event.target.value)}
                      autoComplete="new-password"
                      minLength={8}
                      required
                    />
                  </label>
                  <label>{t("Confirmar nueva contrasena")}
                    <input
                      type="password"
                      value={confirmPanelPassword}
                      onChange={(event) => setConfirmPanelPassword(event.target.value)}
                      autoComplete="new-password"
                      minLength={8}
                      required
                    />
                  </label>
                </div>
                <p className="field-hint">{t("Minimo 8 caracteres. Usa una contrasena distinta a la temporal o anterior. El cambio aplica solo para tu acceso al panel web.")}</p>
              </div>
              <footer className={styles.cardFoot}>
                <button className="btn" type="submit" disabled={changingPanelPassword}>
                  {changingPanelPassword ? t("Actualizando...") : t("Cambiar contrasena")}
                </button>
              </footer>
            </form>
          </section>
        ) : null}

        {!settingsError && !noCompanySelected && currentSection !== "incidencias" ? <StatusLine>{statusText}</StatusLine> : null}
      </div>

      <Drawer
        open={showEmployeeModal}
        title={editingEmployee ? t("Editar usuario") : t("Agregar usuario")}
        description={editingEmployee ? editingEmployee.employee_code : t("Se generara una credencial de acceso al guardar.")}
        onClose={closeEmployeeModal}
        footer={
          <>
            <div className={styles.footStatus}><StatusLine>{statusText}</StatusLine></div>
            <button className="btn btn-outline" type="button" onClick={closeEmployeeModal}>{generatedCredential ? t("Cerrar") : t("Cancelar")}</button>
            <button className="btn" type="submit" form={formIds.employee}>{t("Guardar")}</button>
          </>
        }
      >
        {generatedCredential ? (
          <div className={styles.credential} role="status">
            <span>{t("Credencial generada")}</span>
            <strong>{generatedCredential.email}</strong>
            {generatedCredential.password ? (
              <code className="mono">{generatedCredential.password}</code>
            ) : (
              <small>{t(deliveryStatusText(generatedCredential.delivery_status))}</small>
            )}
            {generatedCredential.password_change_required && generatedCredential.password ? <small>{t("Temporal: el usuario debera cambiarla al primer ingreso.")}</small> : null}
          </div>
        ) : null}
        <form id={formIds.employee} className={styles.form} onSubmit={handleSaveEmployee}>
          <label>{t("Nombre completo")}<input value={employeeName} onChange={(event) => setEmployeeName(event.target.value)} placeholder={t("Empleado nuevo")} required /></label>
          <label>{t("Correo electronico")}<input type="email" value={employeeEmail} onChange={(event) => setEmployeeEmail(event.target.value)} placeholder="empleado@empresa.com" required /></label>
          <div className="field-row">
            <label>{t("Departamento existente")}
              <select value={employeeDepartmentId} onChange={(event) => setEmployeeDepartmentId(event.target.value)}>
                <option value="">{t("Sin asignar")}</option>
                {departments.map((department) => (
                  <option value={department.id} key={department.id}>{department.name}</option>
                ))}
              </select>
            </label>
            <label>{t("Nuevo departamento")}<input value={newDepartment} onChange={(event) => setNewDepartment(event.target.value)} placeholder={t("Ej. Finanzas")} /></label>
          </div>
          <p className="field-hint">{t("Escribe un departamento nuevo solo si no existe en la lista.")}</p>
        </form>
      </Drawer>

      <Drawer
        open={showAccessModal}
        title={t(accessTypeTitles[accessDraftType])}
        description={t("La estacion consume el codigo una sola vez contra el servidor.")}
        onClose={closeAccessModal}
        footer={
          <>
            <div className={styles.footStatus}><StatusLine>{statusText}</StatusLine></div>
            <button className="btn btn-outline" type="button" onClick={closeAccessModal}>{t("Cancelar")}</button>
            <button className="btn" type="submit" form={formIds.access}>{t("Generar codigo")}</button>
          </>
        }
      >
        <form id={formIds.access} className={styles.form} onSubmit={handleCreateAccessCode}>
          <label>{t("Usuario")}
            <select value={accessEmployeeId} onChange={(event) => setAccessEmployeeId(event.target.value)} required>
              <option value="">{t("Selecciona usuario")}</option>
              {employees.map((employee) => (
                <option value={employee.id} key={employee.id} disabled={employee.status !== "active"}>
                  {employee.full_name}{employee.status !== "active" ? ` (${t("inactivo")})` : ""}
                </option>
              ))}
            </select>
          </label>
          <div className="field-row">
            <label>{t("Vigencia del codigo")}
              <select value={accessValidMinutes} onChange={(event) => setAccessValidMinutes(event.target.value)}>
                <option value="30">{t("30 minutos")}</option>
                <option value="60">{t("1 hora")}</option>
                <option value="120">{t("2 horas")}</option>
                <option value="240">{t("4 horas")}</option>
                <option value="480">{t("8 horas")}</option>
              </select>
            </label>
            {accessDraftType === "overtime" ? (
              <label>{t("Minutos autorizados")}
                <input
                  type="number"
                  min="5"
                  max="1440"
                  value={accessAssignedMinutes}
                  onChange={(event) => setAccessAssignedMinutes(event.target.value)}
                  required
                />
              </label>
            ) : null}
          </div>
          <label>{t("Motivo")}
            <input value={accessReason} onChange={(event) => setAccessReason(event.target.value)} placeholder={t("Motivo del codigo")} />
          </label>
        </form>
      </Drawer>

      <Drawer
        open={showRuleModal}
        title={editingRule ? t("Editar regla") : t("Nueva regla")}
        description={t("Clasifica una app o una ventana. Se reclasifica la actividad existente al guardar.")}
        onClose={closeRuleModal}
        footer={
          <>
            <div className={styles.footStatus}><StatusLine>{statusText}</StatusLine></div>
            <button className="btn btn-outline" type="button" onClick={closeRuleModal}>{t("Cancelar")}</button>
            <button className="btn" type="submit" form={formIds.rule}>{t("Guardar")}</button>
          </>
        }
      >
        <form id={formIds.rule} className={styles.form} onSubmit={handleSaveRule}>
          <div className={styles.fieldGroup}>
            <span className={styles.fieldLabel} id={`${formIds.rule}-scope`}>{t("Aplicar a")}</span>
            <div className="segmented" role="group" aria-labelledby={`${formIds.rule}-scope`}>
              {(["company", "department", "employee"] as RuleScope[]).map((scope) => (
                <button
                  type="button"
                  key={scope}
                  aria-pressed={ruleScope === scope}
                  onClick={() => {
                    setRuleScope(scope);
                    setRuleDepartmentId("");
                    setRuleEmployeeId("");
                  }}
                >
                  {scope === "company" ? t("General empresa") : scope === "department" ? t("Departamento") : t("Empleado")}
                </button>
              ))}
            </div>
          </div>
          {ruleScope !== "company" ? (
            <div className="field-row">
              <label>{t("Departamento")}
                <select
                  value={ruleDepartmentId}
                  onChange={(event) => {
                    setRuleDepartmentId(event.target.value);
                    setRuleEmployeeId("");
                  }}
                  required={ruleScope === "department"}
                >
                  <option value="">{t("Selecciona departamento")}</option>
                  {departments.map((department) => (
                    <option value={department.id} key={department.id}>{department.name}</option>
                  ))}
                </select>
              </label>
              {ruleScope === "employee" ? (
                <label>{t("Empleado")}
                  <select value={ruleEmployeeId} onChange={(event) => setRuleEmployeeId(event.target.value)} required>
                    <option value="">{t("Selecciona empleado")}</option>
                    {scopedEmployees.map((employee) => (
                      <option value={employee.id} key={employee.id}>{employee.full_name}</option>
                    ))}
                  </select>
                </label>
              ) : null}
            </div>
          ) : null}
          <div className="field-row">
            <label>{t("Ejecutable de app")}<input value={ruleExecutable} onChange={(event) => setRuleExecutable(event.target.value)} placeholder="chrome.exe, EXCEL.EXE" /></label>
            <label>{t("Titulo contiene")}<input value={ruleTitle} onChange={(event) => setRuleTitle(event.target.value)} placeholder="Netflix, Google Docs, CRM" /></label>
          </div>
          <p className="field-hint">{t("Indica la app, un texto del titulo de la ventana o ambos.")}</p>
          <label>{t("Clasificacion")}
            <select value={ruleClassification} onChange={(event) => setRuleClassification(event.target.value as RuleClassification)}>
              {classifications.map((classification) => (
                <option value={classification} key={classification}>{t(classificationLabel(classification))}</option>
              ))}
            </select>
          </label>
          <label>{t("Notas")}<input value={ruleNotes} onChange={(event) => setRuleNotes(event.target.value)} placeholder={t("Motivo de la regla")} /></label>
        </form>
      </Drawer>

      <ConfirmDialog
        open={Boolean(archiveCandidate)}
        title={t("Eliminar usuario monitoreado")}
        message={
          archiveCandidate
            ? `${t("Eliminar usuario monitoreado")} ${archiveCandidate.full_name}? ${t("Se archivara su acceso y se revocaran sus dispositivos asignados.")}`
            : ""
        }
        confirmLabel={t("Eliminar")}
        cancelLabel={t("Cancelar")}
        onCancel={() => setArchiveCandidate(null)}
        onConfirm={() => {
          if (archiveCandidate) void archiveEmployee(archiveCandidate);
        }}
      />
    </AppShell>
  );
}
