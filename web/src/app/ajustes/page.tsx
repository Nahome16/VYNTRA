"use client";

import { FormEvent, useCallback, useEffect, useMemo, useState } from "react";
import { AppShell } from "@/components/app-shell";
import { EmptyState, RefreshButton, StatusLine } from "@/components/ui";
import { useAuth } from "@/components/auth-provider";
import { usePreferences } from "@/components/preferences-provider";
import { AccessCode, CatalogsResponse, Employee, ProductivityRule, UncategorizedItem } from "@/lib/types";

const sectionLabels = {
  usuarios: "Usuarios monitoreados",
  accesos: "Accesos",
  reglas: "Reglas",
} as const;

const classifications = ["productive", "neutral", "non_productive", "uncategorized"] as const;

type SectionKey = keyof typeof sectionLabels;
type RuleClassification = (typeof classifications)[number];
type AccessType = "station_reopen" | "overtime";
type RuleRow =
  | { kind: "rule"; id: string; app: string; title: string; classification: string; scope: string; department_id: string | null; rule: ProductivityRule }
  | { kind: "pending"; id: string; app: string; title: string; classification: "uncategorized"; scope: string; department_id: null; item: UncategorizedItem };

const accessTypeLabels: Record<AccessType, string> = {
  station_reopen: "Reabrir",
  overtime: "Horas extra",
};

function classificationLabel(value: string) {
  const labels: Record<string, string> = {
    productive: "Productiva",
    neutral: "Neutral",
    non_productive: "No productiva",
    uncategorized: "Sin clasificar",
  };
  return labels[value] || value;
}

function scopeLabel(rule: ProductivityRule, t: (text: string) => string) {
  if (rule.employee) return `${t("Empleado")}: ${rule.employee}`;
  if (rule.department) return `${t("Departamento")}: ${rule.department}`;
  if (rule.position) return `${t("Puesto")}: ${rule.position}`;
  return t("General");
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

export default function SettingsPage() {
  const { apiGet, apiPatch, apiPost, user } = useAuth();
  const { t } = usePreferences();
  const [activeSection, setActiveSection] = useState<SectionKey>("usuarios");
  const [catalogs, setCatalogs] = useState<CatalogsResponse | null>(null);
  const [rules, setRules] = useState<ProductivityRule[]>([]);
  const [uncategorized, setUncategorized] = useState<UncategorizedItem[]>([]);
  const [accessCodes, setAccessCodes] = useState<AccessCode[]>([]);
  const [statusText, setStatusText] = useState("");
  const [loading, setLoading] = useState(false);

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
    code: string;
    expiresAt: string;
    delivery: string;
  } | null>(null);

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
  const [ruleFilterMenuOpen, setRuleFilterMenuOpen] = useState(false);
  const [showClassificationFilter, setShowClassificationFilter] = useState(false);
  const [pendingOnly, setPendingOnly] = useState(false);
  const [showRuleModal, setShowRuleModal] = useState(false);
  const [editingRule, setEditingRule] = useState<ProductivityRule | null>(null);
  const [ruleScope, setRuleScope] = useState<"company" | "department" | "employee">("company");
  const [ruleDepartmentId, setRuleDepartmentId] = useState("");
  const [ruleEmployeeId, setRuleEmployeeId] = useState("");
  const [ruleExecutable, setRuleExecutable] = useState("");
  const [ruleTitle, setRuleTitle] = useState("");
  const [ruleClassification, setRuleClassification] = useState<RuleClassification>("productive");
  const [ruleNotes, setRuleNotes] = useState("");

  const loadSettings = useCallback(async () => {
    setLoading(true);
    setStatusText(t("Actualizando ajustes..."));
    try {
      const [nextCatalogs, nextRules, nextUncategorized, nextCodes] = await Promise.all([
        apiGet<CatalogsResponse>("/api/productivity/catalogs"),
        apiGet<{ rules: ProductivityRule[] }>("/api/productivity/rules"),
        apiGet<{ items: UncategorizedItem[] }>("/api/productivity/uncategorized?limit=30"),
        apiGet<{ codes: AccessCode[] }>("/api/settings/access-codes"),
      ]);
      setCatalogs(nextCatalogs);
      setRules(nextRules.rules);
      setUncategorized(nextUncategorized.items);
      setAccessCodes(nextCodes.codes);
      setAccessEmployeeId(
        (current) =>
          current ||
          nextCatalogs.employees.find((employee) => employee.status === "active")?.id ||
          nextCatalogs.employees[0]?.id ||
          "",
      );
      setStatusText(t("Datos actualizados"));
    } catch {
      setStatusText(t("No se pudieron cargar ajustes"));
    } finally {
      setLoading(false);
    }
  }, [apiGet, t]);

  useEffect(() => {
    if (!user) return;
    const timer = window.setTimeout(() => {
      void loadSettings();
    }, 0);
    return () => window.clearTimeout(timer);
  }, [loadSettings, user]);

  const departments = useMemo(() => catalogs?.departments || [], [catalogs]);
  const employees = useMemo(() => catalogs?.employees || [], [catalogs]);
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

  const filteredEmployees = useMemo(() => {
    const needle = employeeSearch.trim().toLowerCase();
    return employees.filter((employee) => {
      const department = employee.department_id ? departmentMap.get(employee.department_id) || "" : "";
      const departmentMatches = !employeeDepartmentFilter || employee.department_id === employeeDepartmentFilter;
      return departmentMatches && matchesNeedle([employee.full_name, employee.email, employee.employee_code, department], needle);
    });
  }, [departmentMap, employeeDepartmentFilter, employeeSearch, employees]);

  const employeePageCount = Math.max(1, Math.ceil(filteredEmployees.length / 8));
  const visibleEmployees = pageSlice(filteredEmployees, Math.min(employeePage, employeePageCount), 8);

  const filteredAccessCodes = useMemo(() => {
    const needle = accessSearch.trim().toLowerCase();
    return accessCodes.filter((code) => {
      const sourceDate = code.created_at || code.valid_from;
      const matchesDate = !accessDate || (sourceDate ? new Date(sourceDate).toISOString().slice(0, 10) === accessDate : false);
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
      department_id: rule.department_id,
      rule,
    }));
    const pendingRows: RuleRow[] = uncategorized.map((item, index) => ({
      kind: "pending",
      id: `${item.executable_name}-${item.title_text}-${index}`,
      app: item.executable_name || t("(desconocido)"),
      title: item.title_text || t("(sin titulo)"),
      classification: "uncategorized",
      scope: t("Pendiente"),
      department_id: null,
      item,
    }));
    return pendingOnly ? pendingRows : [...existingRules, ...pendingRows];
  }, [pendingOnly, rules, t, uncategorized]);

  const filteredRuleRows = useMemo(() => {
    const needle = ruleSearch.trim().toLowerCase();
    return ruleRows.filter((row) => {
      const matchesDepartment =
        !ruleDepartmentFilter ||
        (ruleDepartmentFilter === "general" ? row.department_id === null : row.department_id === ruleDepartmentFilter);
      const matchesClassification = !ruleClassificationFilter || row.classification === ruleClassificationFilter;
      const matchesSearch = matchesNeedle([row.app, row.title, row.scope, t(classificationLabel(row.classification))], needle);
      return matchesDepartment && matchesClassification && matchesSearch;
    });
  }, [ruleClassificationFilter, ruleDepartmentFilter, ruleRows, ruleSearch, t]);

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
        activation: {
          email: string;
          expires_at: string;
          delivery: string;
          code?: string;
          note?: string;
        };
      }>("/api/settings/employees", {
        full_name: employeeName,
        email: employeeEmail,
        department_id: employeeDepartmentId || null,
        new_department: newDepartment || null,
      });
      setGeneratedCredential({
        email: response.activation.email,
        code: response.activation.code || "",
        expiresAt: response.activation.expires_at,
        delivery: response.activation.delivery,
      });
      setEmployeeName("");
      setEmployeeEmail("");
      setEmployeeDepartmentId("");
      setNewDepartment("");
      await loadSettings();
      setStatusText(
        response.activation.delivery === "not_configured"
          ? t("Usuario creado. Falta configurar el correo saliente: entrega el codigo manualmente.")
          : t("Usuario creado. El codigo de activacion va en camino a su correo."),
      );
    } catch {
      setStatusText(t("No se pudo guardar el usuario. Revisa correo duplicado o formato invalido."));
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
      const response = await apiPost<{ code: AccessCode }>("/api/settings/access-codes", {
        type: accessDraftType,
        employee_id: accessEmployeeId,
        valid_minutes: Number(accessValidMinutes),
        assigned_minutes: accessDraftType === "overtime" ? Number(accessAssignedMinutes || accessValidMinutes) : undefined,
        reason: accessReason,
      });
      setAccessCodes((current) => [response.code, ...current.filter((code) => code.id !== response.code.id)]);
      closeAccessModal();
      setStatusText(t("Codigo generado y agregado a la tabla"));
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
      setRuleScope("company");
      setRuleDepartmentId("");
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
        await apiPost("/api/productivity/rules", {
          executable_name: row.item.executable_name,
          title_contains: row.item.title_text,
          classification,
          priority: 120,
          notes: "Creada desde pendientes de clasificar",
          department_id: null,
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

  return (
    <AppShell
      title={t("Ajustes")}
      description={`${user?.company || t("Empresa")} - ${t("usuarios, accesos y reglas por empresa.")}`}
      actions={<RefreshButton loading={loading} onClick={loadSettings} />}
    >
      <section className="settings-board">
        <div className="settings-board-header">
          <div>
            <h2>{t("Ajustes")}</h2>
            <p>{user?.company || t("Empresa")} - {t("usuarios, accesos y reglas")}</p>
          </div>
          <div className="settings-board-tabs" role="tablist" aria-label={t("Secciones de ajustes")}>
            {(Object.keys(sectionLabels) as SectionKey[]).map((key) => (
              <button
                aria-selected={activeSection === key}
                className={activeSection === key ? "active" : ""}
                key={key}
                onClick={() => setActiveSection(key)}
                role="tab"
                type="button"
              >
                {t(sectionLabels[key])}
              </button>
            ))}
          </div>
        </div>

        <div className="settings-summary-pills" aria-label={t("Resumen de sistema")}>
          {summaryPills.map((pill) => (
            <button key={pill} type="button">
              {pill}
            </button>
          ))}
        </div>

        {activeSection === "usuarios" ? (
          <>
            <div className="settings-actionbar">
              <div className="settings-search">
                <span aria-hidden="true">⌕</span>
                <input
                  value={employeeSearch}
                  onChange={(event) => {
                    setEmployeePage(1);
                    setEmployeeSearch(event.target.value);
                  }}
                  placeholder={t("Buscar empleado...")}
                />
              </div>
              <select
                value={employeeDepartmentFilter}
                onChange={(event) => {
                  setEmployeePage(1);
                  setEmployeeDepartmentFilter(event.target.value);
                }}
              >
                <option value="">{t("Departamento")}</option>
                {departments.map((department) => (
                  <option value={department.id} key={department.id}>{department.name}</option>
                ))}
              </select>
              <button className="settings-primary-action" type="button" onClick={() => openEmployeeModal()}>
                {t("+ Agregar")}
              </button>
            </div>

            <div className="settings-table-shell settings-users-table">
              <table>
                <thead>
                  <tr>
                    <th>{t("Codigo")}</th>
                    <th>{t("Empleado")}</th>
                    <th>{t("Depto.")}</th>
                    <th>{t("Estado")}</th>
                    <th aria-label={t("Acciones")} />
                  </tr>
                </thead>
                <tbody>
                  {visibleEmployees.map((employee) => {
                    const status = employee.status;
                    return (
                      <tr key={employee.id}>
                        <td>{employee.employee_code}</td>
                        <td>
                          <div className="settings-employee-cell">
                            <span>{initialsFor(employee.full_name)}</span>
                            <div>
                              <strong>{employee.full_name}</strong>
                              <small>{employee.email || t("Sin correo")}</small>
                            </div>
                          </div>
                        </td>
                        <td>{employee.department_id ? departmentMap.get(employee.department_id) || t("Sin departamento") : t("Sin departamento")}</td>
                        <td>
                          <button
                            className={`settings-toggle ${status === "active" ? "active" : ""}`}
                            type="button"
                            onClick={() => void toggleEmployeeStatus(employee)}
                            aria-label={`${t("Cambiar estado de")} ${employee.full_name}`}
                            title={status === "active" ? t("Desactivar usuario") : t("Activar usuario")}
                          >
                            <span />
                          </button>
                        </td>
                        <td>
                          <button className="row-action" type="button" onClick={() => openEmployeeModal(employee)}>
                            {t("Editar")}
                          </button>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
              {!visibleEmployees.length ? <EmptyState>{t("No hay usuarios para el filtro actual.")}</EmptyState> : null}
            </div>

            <div className="settings-pagination">
              <button type="button" disabled={employeePage <= 1} onClick={() => setEmployeePage((page) => Math.max(1, page - 1))}>
                {t("Anterior")}
              </button>
              <span>{employeePage} / {employeePageCount}</span>
              <button type="button" disabled={employeePage >= employeePageCount} onClick={() => setEmployeePage((page) => Math.min(employeePageCount, page + 1))}>
                {t("Siguiente")}
              </button>
            </div>
          </>
        ) : null}

        {activeSection === "accesos" ? (
          <>
            <div className="settings-actionbar settings-access-bar">
              <div className="settings-search">
                <span aria-hidden="true">⌕</span>
                <input value={accessSearch} onChange={(event) => setAccessSearch(event.target.value)} placeholder={t("Buscar empleado, codigo o tipo...")} />
              </div>
              <input type="date" value={accessDate} onChange={(event) => setAccessDate(event.target.value)} aria-label={t("Fecha")} />
              <div className="settings-dropdown">
                <button className="settings-primary-action" type="button" onClick={() => setAccessMenuOpen((open) => !open)}>
                  {t("+ Generar")} ▾
                </button>
                {accessMenuOpen ? (
                  <div className="settings-dropdown-menu">
                    <span>{t("Elegir tipo de codigo")}</span>
                    <button type="button" onClick={() => openAccessModal("station_reopen")}>
                      {t("Reabrir estacion de marcaje")}
                    </button>
                    <button type="button" onClick={() => openAccessModal("overtime")}>
                      {t("Designar horas extra")}
                    </button>
                  </div>
                ) : null}
              </div>
            </div>

            <div className="settings-table-shell">
              <table>
                <thead>
                  <tr>
                    <th>{t("Empleado")}</th>
                    <th>{t("Tipo")}</th>
                    <th>{t("Codigo")}</th>
                    <th>{t("Valido hasta")}</th>
                  </tr>
                </thead>
                <tbody>
                  {filteredAccessCodes.map((code) => {
                    return (
                      <tr key={code.id}>
                        <td>{code.employee || code.email}</td>
                        <td><span className={`settings-type settings-type-${code.type}`}>{code.type_label || t(accessTypeLabels[code.type])}</span></td>
                        <td><strong>{code.code}</strong></td>
                        <td>{new Date(code.valid_until).toLocaleString("es-NI")}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
              {!filteredAccessCodes.length ? <EmptyState>{t("No hay codigos para el filtro actual.")}</EmptyState> : null}
            </div>
            <p className="settings-note">{t("Elige un tipo en + Generar, completa usuario y vigencia, y luego se agrega a la tabla.")}</p>
          </>
        ) : null}

        {activeSection === "reglas" ? (
          <>
            <div className="settings-actionbar settings-rules-bar">
              <div className="settings-search">
                <span aria-hidden="true">⌕</span>
                <input value={ruleSearch} onChange={(event) => setRuleSearch(event.target.value)} placeholder={t("Buscar app, titulo o persona...")} />
              </div>
              <div className="settings-dropdown">
                <button className="row-action settings-filter-trigger" type="button" onClick={() => setRuleFilterMenuOpen((open) => !open)}>
                  {t("Filtros")} ▾
                </button>
                {ruleFilterMenuOpen ? (
                  <div className="settings-dropdown-menu settings-filter-menu">
                    <span>{t("Filtrar consulta")}</span>
                    <label>{t("Departamento")}
                      <select
                        value={ruleDepartmentFilter}
                        onChange={(event) => {
                          setRuleDepartmentFilter(event.target.value);
                          setPendingOnly(false);
                        }}
                      >
                        <option value="">{t("Sin filtro")}</option>
                        <option value="general">{t("General")}</option>
                        {departments.map((department) => (
                          <option value={department.id} key={department.id}>{department.name}</option>
                        ))}
                      </select>
                    </label>
                    {showClassificationFilter || ruleClassificationFilter ? (
                      <label>{t("Clasificacion")}
                        <select
                          value={ruleClassificationFilter}
                          onChange={(event) => {
                            setRuleClassificationFilter(event.target.value);
                            setPendingOnly(false);
                          }}
                        >
                          <option value="">{t("Sin filtro")}</option>
                          {classifications.map((classification) => (
                            <option value={classification} key={classification}>{t(classificationLabel(classification))}</option>
                          ))}
                        </select>
                      </label>
                    ) : (
                      <button type="button" onClick={() => setShowClassificationFilter(true)}>
                        {t("+ Agregar filtro de clasificacion")}
                      </button>
                    )}
                    <button
                      type="button"
                      onClick={() => {
                        setRuleDepartmentFilter("");
                        setRuleClassificationFilter("");
                        setShowClassificationFilter(false);
                        setPendingOnly(false);
                      }}
                    >
                      {t("Limpiar filtros")}
                    </button>
                  </div>
                ) : null}
              </div>
              <button className="settings-primary-action" type="button" onClick={() => openRuleModal()}>
                {t("+ Nueva regla")}
              </button>
            </div>
            {ruleDepartmentFilter || ruleClassificationFilter ? (
              <div className="settings-filter-chips">
                {ruleDepartmentFilter ? (
                  <button type="button" onClick={() => setRuleDepartmentFilter("")}>
                    {t("Depto")}: {ruleDepartmentFilter === "general" ? t("General") : departmentMap.get(ruleDepartmentFilter) || t("Departamento")} x
                  </button>
                ) : null}
                {ruleClassificationFilter ? (
                  <button
                    type="button"
                    onClick={() => {
                      setRuleClassificationFilter("");
                      setShowClassificationFilter(false);
                      setPendingOnly(false);
                    }}
                  >
                    {t("Clasificacion")}: {t(classificationLabel(ruleClassificationFilter))} x
                  </button>
                ) : null}
              </div>
            ) : null}
            <button
              className={`settings-pending-filter ${pendingOnly ? "active" : ""}`}
              type="button"
              onClick={() => {
                setPendingOnly((current) => {
                  const next = !current;
                  setRuleDepartmentFilter("");
                  setRuleClassificationFilter(next ? "uncategorized" : "");
                  return next;
                });
              }}
            >
              {uncategorized.length} {t("pendientes de clasificar")}
            </button>

            <div className="settings-table-shell">
              <table>
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
                        <strong>{row.app}</strong>
                        <small>{row.title}</small>
                      </td>
                      <td>
                        <select
                          className={`settings-classification-select badge-${row.classification}`}
                          value={row.classification}
                          onChange={(event) => void updateRuleClassification(row, event.target.value as RuleClassification)}
                          title={t("Cambiar clasificacion")}
                        >
                          {classifications.map((classification) => (
                            <option value={classification} key={classification}>
                              {t(classificationLabel(classification))}
                            </option>
                          ))}
                        </select>
                      </td>
                      <td>{row.scope}</td>
                      <td>
                        {row.kind === "rule" ? (
                          <button className="row-action" type="button" onClick={() => openRuleModal(row.rule)}>
                            {t("Editar")}
                          </button>
                        ) : null}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {!filteredRuleRows.length ? <EmptyState>{t("No hay reglas para el filtro actual.")}</EmptyState> : null}
            </div>
            <p className="settings-note">{t("Filtros combinables. Click en la etiqueta para reclasificar sin salir de la tabla.")}</p>
          </>
        ) : null}

        <StatusLine>{statusText}</StatusLine>
      </section>

      {showEmployeeModal ? (
        <div className="settings-modal" role="dialog" aria-modal="true" onClick={closeEmployeeModal}>
          <form className="settings-modal-panel" onSubmit={handleSaveEmployee} onClick={(event) => event.stopPropagation()}>
            <header>
              <h2>{editingEmployee ? t("Editar usuario") : t("Agregar usuario")}</h2>
              <button type="button" onClick={closeEmployeeModal} aria-label={t("Cerrar")}>x</button>
            </header>
            <label>{t("Nombre completo")}<input value={employeeName} onChange={(event) => setEmployeeName(event.target.value)} placeholder={t("Empleado nuevo")} required /></label>
            <label>{t("Correo electronico")}<input type="email" value={employeeEmail} onChange={(event) => setEmployeeEmail(event.target.value)} placeholder="empleado@empresa.com" required /></label>
            <label>{t("Departamento existente")}
              <select value={employeeDepartmentId} onChange={(event) => setEmployeeDepartmentId(event.target.value)}>
                <option value="">{t("Sin asignar")}</option>
                {departments.map((department) => (
                  <option value={department.id} key={department.id}>{department.name}</option>
                ))}
              </select>
            </label>
            <label>{t("Nuevo departamento")}<input value={newDepartment} onChange={(event) => setNewDepartment(event.target.value)} placeholder={t("Ej. Finanzas")} /></label>
            <footer>
              <button className="row-action" type="button" onClick={closeEmployeeModal}>{t("Cancelar")}</button>
              <button className="settings-primary-action" type="submit">{t("Guardar")}</button>
            </footer>
            {generatedCredential ? (
              <div className="credential-box">
                <span>
                  {generatedCredential.delivery === "not_configured"
                    ? t("Correo saliente no configurado")
                    : t("Invitacion enviada")}
                </span>
                <strong>{generatedCredential.email}</strong>
                {generatedCredential.code ? (
                  <>
                    <code>{generatedCredential.code}</code>
                    <small>
                      {t("Entrega este codigo al asistente. Es de un solo uso y el sistema no volvera a mostrarlo. El definira su propia contrasena en la estacion.")}
                    </small>
                  </>
                ) : (
                  <small>
                    {t("El asistente recibira su codigo de activacion por correo y definira su propia contrasena. Tu no necesitas conocerla ni guardarla.")}
                  </small>
                )}
              </div>
            ) : null}
          </form>
        </div>
      ) : null}

      {showAccessModal ? (
        <div className="settings-modal" role="dialog" aria-modal="true" onClick={closeAccessModal}>
          <form className="settings-modal-panel" onSubmit={handleCreateAccessCode} onClick={(event) => event.stopPropagation()}>
            <header>
              <h2>{t(accessTypeLabels[accessDraftType])}</h2>
              <button type="button" onClick={closeAccessModal} aria-label={t("Cerrar")}>x</button>
            </header>
            <label>{t("Usuario")}
              <select value={accessEmployeeId} onChange={(event) => setAccessEmployeeId(event.target.value)} required>
                <option value="">{t("Selecciona usuario")}</option>
                {employees.map((employee) => (
                  <option value={employee.id} key={employee.id} disabled={employee.status !== "active"}>
                    {employee.full_name}{employee.status !== "active" ? ` ${t("(inactivo)")}` : ""}
                  </option>
                ))}
              </select>
            </label>
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
            <label>{t("Motivo")}
              <input value={accessReason} onChange={(event) => setAccessReason(event.target.value)} placeholder={t("Motivo del codigo")} />
            </label>
            <footer>
              <button className="row-action" type="button" onClick={closeAccessModal}>{t("Cancelar")}</button>
              <button className="settings-primary-action" type="submit">{t("Generar codigo")}</button>
            </footer>
          </form>
        </div>
      ) : null}

      {showRuleModal ? (
        <div className="settings-modal" role="dialog" aria-modal="true" onClick={closeRuleModal}>
          <form className="settings-modal-panel" onSubmit={handleSaveRule} onClick={(event) => event.stopPropagation()}>
            <header>
              <h2>{editingRule ? t("Editar regla") : t("Nueva regla")}</h2>
              <button type="button" onClick={closeRuleModal} aria-label={t("Cerrar")}>x</button>
            </header>
            <label>{t("Aplicar a")}
              <select
                value={ruleScope}
                onChange={(event) => {
                  setRuleScope(event.target.value as "company" | "department" | "employee");
                  setRuleDepartmentId("");
                  setRuleEmployeeId("");
                }}
              >
                <option value="company">{t("General empresa")}</option>
                <option value="department">{t("Departamento")}</option>
                <option value="employee">{t("Empleado")}</option>
              </select>
            </label>
            {ruleScope !== "company" ? (
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
            ) : null}
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
            <label>{t("Ejecutable de app")}<input value={ruleExecutable} onChange={(event) => setRuleExecutable(event.target.value)} placeholder="chrome.exe, EXCEL.EXE" /></label>
            <label>{t("Titulo contiene")}<input value={ruleTitle} onChange={(event) => setRuleTitle(event.target.value)} placeholder="Netflix, Google Docs, CRM" /></label>
            <label>{t("Clasificacion")}
              <select value={ruleClassification} onChange={(event) => setRuleClassification(event.target.value as RuleClassification)}>
                {classifications.map((classification) => (
                  <option value={classification} key={classification}>{t(classificationLabel(classification))}</option>
                ))}
              </select>
            </label>
            <label>{t("Notas")}<input value={ruleNotes} onChange={(event) => setRuleNotes(event.target.value)} placeholder={t("Motivo de la regla")} /></label>
            <footer>
              <button className="row-action" type="button" onClick={closeRuleModal}>{t("Cancelar")}</button>
              <button className="settings-primary-action" type="submit">{t("Guardar")}</button>
            </footer>
          </form>
        </div>
      ) : null}
    </AppShell>
  );
}
