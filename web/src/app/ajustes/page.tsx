"use client";

import { FormEvent, useCallback, useEffect, useMemo, useState } from "react";
import { AppShell } from "@/components/app-shell";
import { EmptyState, RefreshButton, StatusLine } from "@/components/ui";
import { useAuth } from "@/components/auth-provider";
import { IncidentsPanel } from "@/components/incidents-panel";
import { AccessCode, CatalogsResponse, Employee, ProductivityRule, UncategorizedItem } from "@/lib/types";

const sectionLabels = {
  usuarios: "Usuarios monitoreados",
  accesos: "Accesos",
  incidencias: "Incidencias",
  reglas: "Reglas",
} as const;

const classifications = ["productive", "neutral", "non_productive", "uncategorized"] as const;

type SectionKey = keyof typeof sectionLabels;
type RuleClassification = (typeof classifications)[number];
type AccessType = "station_reopen" | "overtime";
type RuleRow =
  | { kind: "rule"; id: string; app: string; title: string; classification: string; scope: string; department_id: string | null; rule: ProductivityRule }
  | { kind: "pending"; id: string; app: string; title: string; classification: "uncategorized"; scope: string; department_id: null; item: UncategorizedItem };

function isSectionKey(value: string): value is SectionKey {
  return value in sectionLabels;
}

const accessTypeLabels: Record<AccessType, string> = {
  station_reopen: "Reabrir",
  overtime: "Horas extra",
};

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

function classificationLabel(value: string) {
  const labels: Record<string, string> = {
    productive: "Productiva",
    neutral: "Neutral",
    non_productive: "No productiva",
    uncategorized: "Sin clasificar",
  };
  return labels[value] || value;
}

function scopeLabel(rule: ProductivityRule) {
  if (rule.employee) return `Empleado: ${rule.employee}`;
  if (rule.department) return `Departamento: ${rule.department}`;
  if (rule.position) return `Puesto: ${rule.position}`;
  return "General";
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

export default function SettingsPage() {
  const { apiGet, apiPatch, apiPost, user } = useAuth();
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
    password?: string;
    password_change_required?: boolean;
    delivery_status?: string;
  } | null>(null);
  const [resettingCredentialId, setResettingCredentialId] = useState("");

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
    setStatusText("Actualizando ajustes...");
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
      setStatusText("Datos actualizados");
    } catch {
      setStatusText("No se pudieron cargar ajustes");
    } finally {
      setLoading(false);
    }
  }, [apiGet]);

  useEffect(() => {
    if (!user) return;
    const timer = window.setTimeout(() => {
      void loadSettings();
    }, 0);
    return () => window.clearTimeout(timer);
  }, [loadSettings, user]);

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
    () => [`${activeEmployees} usuarios activos`, `${rules.length} reglas`, `${activeCodes} codigos vigentes`],
    [activeCodes, activeEmployees, rules.length],
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
      scope: scopeLabel(rule),
      department_id: rule.department_id,
      rule,
    }));
    const pendingRows: RuleRow[] = uncategorized.map((item, index) => ({
      kind: "pending",
      id: `${item.executable_name}-${item.title_text}-${index}`,
      app: item.executable_name || "(desconocido)",
      title: item.title_text || "(sin titulo)",
      classification: "uncategorized",
      scope: "Pendiente",
      department_id: null,
      item,
    }));
    return pendingOnly ? pendingRows : [...existingRules, ...pendingRows];
  }, [pendingOnly, rules, uncategorized]);

  const filteredRuleRows = useMemo(() => {
    const needle = ruleSearch.trim().toLowerCase();
    return ruleRows.filter((row) => {
      const matchesDepartment =
        !ruleDepartmentFilter ||
        (ruleDepartmentFilter === "general" ? row.department_id === null : row.department_id === ruleDepartmentFilter);
      const matchesClassification = !ruleClassificationFilter || row.classification === ruleClassificationFilter;
      const matchesSearch = matchesNeedle([row.app, row.title, row.scope, classificationLabel(row.classification)], needle);
      return matchesDepartment && matchesClassification && matchesSearch;
    });
  }, [ruleClassificationFilter, ruleDepartmentFilter, ruleRows, ruleSearch]);

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
    setStatusText(editingEmployee ? "Actualizando usuario monitoreado..." : "Creando usuario monitoreado...");
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
        setStatusText("Usuario actualizado");
        return;
      }

      const response = await apiPost<{
        employee: Employee;
        credentials: { email: string; password?: string; delivery_status: string; password_change_required?: boolean };
      }>("/api/settings/employees", {
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
          ? "Usuario creado y credencial enviada por correo."
          : response.credentials.password
          ? "Usuario creado. Guarda la credencial generada antes de cerrar."
          : "Usuario creado. Configura entrega de credenciales para activarlo."
      );
    } catch {
      setStatusText("No se pudo guardar el usuario. Revisa correo duplicado o formato invalido.");
    }
  }

  async function resetEmployeeCredentials(employee: Employee) {
    if (employee.status !== "active") {
      setStatusText("Activa el usuario antes de reenviar credenciales.");
      return;
    }
    setResettingCredentialId(employee.id);
    setStatusText(`Regenerando credencial para ${employee.full_name}...`);
    try {
      const response = await apiPost<{
        credentials: { email: string; password?: string; delivery_status: string; password_change_required?: boolean };
      }>(`/api/settings/employees/${employee.id}/reset-credentials`, {});
      setStatusText(
        response.credentials.delivery_status === "sent"
          ? `Credencial enviada por correo a ${response.credentials.email}.`
          : response.credentials.password
          ? `Credencial regenerada para ${response.credentials.email}.`
          : `No se pudo enviar la credencial a ${response.credentials.email}. Revisa SMTP o el buzon.`,
      );
    } catch {
      setStatusText("No se pudo regenerar la credencial del usuario.");
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
    setAccessReason(type === "overtime" ? "Designar horas extra" : "Reabrir estacion de marcaje");
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
      setStatusText("Selecciona o crea un usuario antes de generar codigo");
      return;
    }
    setStatusText("Generando codigo...");
    try {
      const response = await apiPost<{ code: AccessCode; delivery_status?: string }>("/api/settings/access-codes", {
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
          ? "Codigo generado y enviado por correo."
          : response.code.code
          ? "Codigo generado y agregado a la tabla"
          : "Codigo generado. Configura entrega segura para enviarlo."
      );
    } catch {
      setStatusText("No se pudo generar el codigo");
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
    setStatusText(editingRule ? "Actualizando regla..." : "Creando regla productiva...");
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
        setStatusText("Regla actualizada");
        return;
      }
      await apiPost("/api/productivity/rules", payload);
      closeRuleModal();
      await loadSettings();
      setStatusText("Regla creada y reclasificacion encolada");
    } catch {
      setStatusText("No se pudo guardar la regla. Debe tener app o titulo y un alcance valido.");
    }
  }

  async function updateRuleClassification(row: RuleRow, classification: RuleClassification) {
    if (classification === row.classification) return;
    setStatusText("Actualizando clasificacion...");
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
      setStatusText("Clasificacion actualizada");
    } catch {
      setStatusText("No se pudo actualizar la clasificacion");
    }
  }

  async function toggleEmployeeStatus(employee: Employee) {
    if (employee.status === "archived") {
      setStatusText("El usuario esta archivado. Usa Restaurar para recuperarlo.");
      return;
    }
    const status = employee.status === "active" ? "inactive" : "active";
    setStatusText("Actualizando estado del usuario...");
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
      setStatusText(status === "active" ? "Usuario activado" : "Usuario desactivado");
    } catch {
      setStatusText("No se pudo actualizar el estado del usuario");
    }
  }

  async function archiveEmployee(employee: Employee) {
    if (!window.confirm(`Eliminar usuario monitoreado ${employee.full_name}? Se archivara su acceso y se revocaran sus dispositivos asignados.`)) {
      return;
    }
    setStatusText("Eliminando usuario monitoreado...");
    try {
      const response = await apiPost<{ employee: Employee }>(`/api/settings/employees/${employee.id}/archive`, {
        reason: "Eliminado desde ajustes",
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
      setStatusText("Usuario monitoreado eliminado");
    } catch {
      setStatusText("No se pudo eliminar el usuario monitoreado");
    }
  }

  async function restoreEmployee(employee: Employee) {
    setStatusText("Restaurando usuario monitoreado...");
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
      setStatusText("Usuario monitoreado restaurado");
    } catch {
      setStatusText("No se pudo restaurar el usuario monitoreado");
    }
  }

  return (
    <AppShell
      title="Ajustes"
      description={`${user?.company || "Empresa"} - usuarios, accesos, incidencias y reglas por empresa.`}
      actions={<RefreshButton loading={loading} onClick={loadSettings} />}
    >
      <section className="settings-board">
        <div className="settings-board-header">
          <div>
            <h2>Ajustes</h2>
            <p>{user?.company || "Empresa"} - usuarios, accesos, incidencias y reglas</p>
          </div>
          <div className="settings-board-tabs" role="tablist" aria-label="Secciones de ajustes">
            {(Object.keys(sectionLabels) as SectionKey[]).map((key) => (
              <button
                aria-selected={activeSection === key}
                className={activeSection === key ? "active" : ""}
                key={key}
                onClick={() => selectSection(key)}
                role="tab"
                type="button"
              >
                {sectionLabels[key]}
              </button>
            ))}
          </div>
        </div>

        <div className="settings-summary-pills" aria-label="Resumen de sistema">
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
                  placeholder="Buscar empleado..."
                />
              </div>
              <select
                value={employeeDepartmentFilter}
                onChange={(event) => {
                  setEmployeePage(1);
                  setEmployeeDepartmentFilter(event.target.value);
                }}
              >
                <option value="">Departamento</option>
                {departments.map((department) => (
                  <option value={department.id} key={department.id}>{department.name}</option>
                ))}
              </select>
              <button className="settings-primary-action" type="button" onClick={() => openEmployeeModal()}>
                + Agregar
              </button>
            </div>

            <div className="settings-table-shell settings-users-table">
              <table>
                <thead>
                  <tr>
                    <th>Codigo</th>
                    <th>Empleado</th>
                    <th>Depto.</th>
                    <th>Estado</th>
                    <th aria-label="Acciones" />
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
                              <small>{employee.email || "Sin correo"}</small>
                            </div>
                          </div>
                        </td>
                        <td>{employee.department_id ? departmentMap.get(employee.department_id) || "Sin departamento" : "Sin departamento"}</td>
                        <td>
                          <button
                            className={`settings-toggle ${status === "active" ? "active" : ""}`}
                            type="button"
                            onClick={() => void toggleEmployeeStatus(employee)}
                            aria-label={`Cambiar estado de ${employee.full_name}`}
                            title={status === "active" ? "Desactivar usuario" : "Activar usuario"}
                          >
                            <span />
                          </button>
                        </td>
                        <td>
                          <div className="settings-row-actions">
                            <button className="row-action" type="button" onClick={() => openEmployeeModal(employee)}>
                              Editar
                            </button>
                            <button
                              className="row-action"
                              type="button"
                              disabled={resettingCredentialId === employee.id || employee.status !== "active"}
                              onClick={() => void resetEmployeeCredentials(employee)}
                            >
                              {resettingCredentialId === employee.id ? "Enviando..." : "Reenviar"}
                            </button>
                            {employee.status === "archived" ? (
                              <button className="row-action" type="button" onClick={() => void restoreEmployee(employee)}>
                                Restaurar
                              </button>
                            ) : (
                              <button className="row-action danger" type="button" onClick={() => void archiveEmployee(employee)}>
                                Eliminar
                              </button>
                            )}
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
              {!visibleEmployees.length ? <EmptyState>No hay usuarios para el filtro actual.</EmptyState> : null}
            </div>

            <div className="settings-pagination">
              <button type="button" disabled={employeePage <= 1} onClick={() => setEmployeePage((page) => Math.max(1, page - 1))}>
                Anterior
              </button>
              <span>{employeePage} / {employeePageCount}</span>
              <button type="button" disabled={employeePage >= employeePageCount} onClick={() => setEmployeePage((page) => Math.min(employeePageCount, page + 1))}>
                Siguiente
              </button>
            </div>
          </>
        ) : null}

        {activeSection === "accesos" ? (
          <>
            <div className="settings-actionbar settings-access-bar">
              <div className="settings-search">
                <span aria-hidden="true">⌕</span>
                <input value={accessSearch} onChange={(event) => setAccessSearch(event.target.value)} placeholder="Buscar empleado, codigo o tipo..." />
              </div>
              <input type="date" value={accessDate} onChange={(event) => setAccessDate(event.target.value)} aria-label="Fecha" />
              <div className="settings-dropdown">
                <button className="settings-primary-action" type="button" onClick={() => setAccessMenuOpen((open) => !open)}>
                  + Generar ▾
                </button>
                {accessMenuOpen ? (
                  <div className="settings-dropdown-menu">
                    <span>Elegir tipo de codigo</span>
                    <button type="button" onClick={() => openAccessModal("station_reopen")}>
                      Reabrir estacion de marcaje
                    </button>
                    <button type="button" onClick={() => openAccessModal("overtime")}>
                      Designar horas extra
                    </button>
                  </div>
                ) : null}
              </div>
            </div>

            <div className="settings-table-shell">
              <table>
                <thead>
                  <tr>
                    <th>Empleado</th>
                    <th>Tipo</th>
                    <th>Codigo</th>
                    <th>Estado</th>
                    <th>Valido hasta</th>
                  </tr>
                </thead>
                <tbody>
                  {filteredAccessCodes.map((code) => {
                    return (
                      <tr key={code.id}>
                        <td>{code.employee || code.email}</td>
                        <td><span className={`settings-type settings-type-${code.type}`}>{code.type_label || accessTypeLabels[code.type]}</span></td>
                        <td><strong>{code.code || "Entrega pendiente"}</strong></td>
                        <td><span className={`settings-access-status settings-access-status-${code.status}`}>{accessStatusLabel(code)}</span></td>
                        <td>{new Date(code.valid_until).toLocaleString("es-NI")}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
              {!filteredAccessCodes.length ? <EmptyState>No hay codigos para el filtro actual.</EmptyState> : null}
            </div>
            <p className="settings-note">Elige un tipo en + Generar, completa usuario y vigencia. La estacion consume el codigo una sola vez contra el servidor.</p>
          </>
        ) : null}

        {activeSection === "reglas" ? (
          <>
            <div className="settings-actionbar settings-rules-bar">
              <div className="settings-search">
                <span aria-hidden="true">⌕</span>
                <input value={ruleSearch} onChange={(event) => setRuleSearch(event.target.value)} placeholder="Buscar app, titulo o persona..." />
              </div>
              <div className="settings-dropdown">
                <button className="row-action settings-filter-trigger" type="button" onClick={() => setRuleFilterMenuOpen((open) => !open)}>
                  Filtros ▾
                </button>
                {ruleFilterMenuOpen ? (
                  <div className="settings-dropdown-menu settings-filter-menu">
                    <span>Filtrar consulta</span>
                    <label>Departamento
                      <select
                        value={ruleDepartmentFilter}
                        onChange={(event) => {
                          setRuleDepartmentFilter(event.target.value);
                          setPendingOnly(false);
                        }}
                      >
                        <option value="">Sin filtro</option>
                        <option value="general">General</option>
                        {departments.map((department) => (
                          <option value={department.id} key={department.id}>{department.name}</option>
                        ))}
                      </select>
                    </label>
                    {showClassificationFilter || ruleClassificationFilter ? (
                      <label>Clasificacion
                        <select
                          value={ruleClassificationFilter}
                          onChange={(event) => {
                            setRuleClassificationFilter(event.target.value);
                            setPendingOnly(false);
                          }}
                        >
                          <option value="">Sin filtro</option>
                          {classifications.map((classification) => (
                            <option value={classification} key={classification}>{classificationLabel(classification)}</option>
                          ))}
                        </select>
                      </label>
                    ) : (
                      <button type="button" onClick={() => setShowClassificationFilter(true)}>
                        + Agregar filtro de clasificacion
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
                      Limpiar filtros
                    </button>
                  </div>
                ) : null}
              </div>
              <button className="settings-primary-action" type="button" onClick={() => openRuleModal()}>
                + Nueva regla
              </button>
            </div>
            {ruleDepartmentFilter || ruleClassificationFilter ? (
              <div className="settings-filter-chips">
                {ruleDepartmentFilter ? (
                  <button type="button" onClick={() => setRuleDepartmentFilter("")}>
                    Depto: {ruleDepartmentFilter === "general" ? "General" : departmentMap.get(ruleDepartmentFilter) || "Departamento"} x
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
                    Clasificacion: {classificationLabel(ruleClassificationFilter)} x
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
              {uncategorized.length} pendientes de clasificar
            </button>

            <div className="settings-table-shell">
              <table>
                <thead>
                  <tr>
                    <th>App / titulo</th>
                    <th>Clasificacion</th>
                    <th>Alcance</th>
                    <th aria-label="Acciones" />
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
                          title="Cambiar clasificacion"
                        >
                          {classifications.map((classification) => (
                            <option value={classification} key={classification}>
                              {classificationLabel(classification)}
                            </option>
                          ))}
                        </select>
                      </td>
                      <td>{row.scope}</td>
                      <td>
                        {row.kind === "rule" ? (
                          <button className="row-action" type="button" onClick={() => openRuleModal(row.rule)}>
                            Editar
                          </button>
                        ) : null}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {!filteredRuleRows.length ? <EmptyState>No hay reglas para el filtro actual.</EmptyState> : null}
            </div>
            <p className="settings-note">Filtros combinables. Click en la etiqueta para reclasificar sin salir de la tabla.</p>
          </>
        ) : null}

        {activeSection === "incidencias" ? (
          <IncidentsPanel active={activeSection === "incidencias"} />
        ) : null}

        {activeSection !== "incidencias" ? <StatusLine>{statusText}</StatusLine> : null}
      </section>

      {showEmployeeModal ? (
        <div className="settings-modal" role="dialog" aria-modal="true" onClick={closeEmployeeModal}>
          <form className="settings-modal-panel" onSubmit={handleSaveEmployee} onClick={(event) => event.stopPropagation()}>
            <header>
              <h2>{editingEmployee ? "Editar usuario" : "Agregar usuario"}</h2>
              <button type="button" onClick={closeEmployeeModal} aria-label="Cerrar">x</button>
            </header>
            <label>Nombre completo<input value={employeeName} onChange={(event) => setEmployeeName(event.target.value)} placeholder="Empleado nuevo" required /></label>
            <label>Correo electronico<input type="email" value={employeeEmail} onChange={(event) => setEmployeeEmail(event.target.value)} placeholder="empleado@empresa.com" required /></label>
            <label>Departamento existente
              <select value={employeeDepartmentId} onChange={(event) => setEmployeeDepartmentId(event.target.value)}>
                <option value="">Sin asignar</option>
                {departments.map((department) => (
                  <option value={department.id} key={department.id}>{department.name}</option>
                ))}
              </select>
            </label>
            <label>Nuevo departamento<input value={newDepartment} onChange={(event) => setNewDepartment(event.target.value)} placeholder="Ej. Finanzas" /></label>
            <footer>
              <button className="row-action" type="button" onClick={closeEmployeeModal}>Cancelar</button>
              <button className="settings-primary-action" type="submit">Guardar</button>
            </footer>
            {generatedCredential ? (
              <div className="credential-box">
                <span>Credencial generada</span>
                <strong>{generatedCredential.email}</strong>
                {generatedCredential.password ? (
                  <code>{generatedCredential.password}</code>
                ) : (
                  <small>{deliveryStatusText(generatedCredential.delivery_status)}</small>
                )}
                {generatedCredential.password_change_required && generatedCredential.password ? <small>Temporal: el usuario debera cambiarla al primer ingreso.</small> : null}
              </div>
            ) : null}
          </form>
        </div>
      ) : null}

      {showAccessModal ? (
        <div className="settings-modal" role="dialog" aria-modal="true" onClick={closeAccessModal}>
          <form className="settings-modal-panel" onSubmit={handleCreateAccessCode} onClick={(event) => event.stopPropagation()}>
            <header>
              <h2>{accessTypeLabels[accessDraftType]}</h2>
              <button type="button" onClick={closeAccessModal} aria-label="Cerrar">x</button>
            </header>
            <label>Usuario
              <select value={accessEmployeeId} onChange={(event) => setAccessEmployeeId(event.target.value)} required>
                <option value="">Selecciona usuario</option>
                {employees.map((employee) => (
                  <option value={employee.id} key={employee.id} disabled={employee.status !== "active"}>
                    {employee.full_name}{employee.status !== "active" ? " (inactivo)" : ""}
                  </option>
                ))}
              </select>
            </label>
            <label>Vigencia del codigo
              <select value={accessValidMinutes} onChange={(event) => setAccessValidMinutes(event.target.value)}>
                <option value="30">30 minutos</option>
                <option value="60">1 hora</option>
                <option value="120">2 horas</option>
                <option value="240">4 horas</option>
                <option value="480">8 horas</option>
              </select>
            </label>
            {accessDraftType === "overtime" ? (
              <label>Minutos autorizados
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
            <label>Motivo
              <input value={accessReason} onChange={(event) => setAccessReason(event.target.value)} placeholder="Motivo del codigo" />
            </label>
            <footer>
              <button className="row-action" type="button" onClick={closeAccessModal}>Cancelar</button>
              <button className="settings-primary-action" type="submit">Generar codigo</button>
            </footer>
          </form>
        </div>
      ) : null}

      {showRuleModal ? (
        <div className="settings-modal" role="dialog" aria-modal="true" onClick={closeRuleModal}>
          <form className="settings-modal-panel" onSubmit={handleSaveRule} onClick={(event) => event.stopPropagation()}>
            <header>
              <h2>{editingRule ? "Editar regla" : "Nueva regla"}</h2>
              <button type="button" onClick={closeRuleModal} aria-label="Cerrar">x</button>
            </header>
            <label>Aplicar a
              <select
                value={ruleScope}
                onChange={(event) => {
                  setRuleScope(event.target.value as "company" | "department" | "employee");
                  setRuleDepartmentId("");
                  setRuleEmployeeId("");
                }}
              >
                <option value="company">General empresa</option>
                <option value="department">Departamento</option>
                <option value="employee">Empleado</option>
              </select>
            </label>
            {ruleScope !== "company" ? (
              <label>Departamento
                <select
                  value={ruleDepartmentId}
                  onChange={(event) => {
                    setRuleDepartmentId(event.target.value);
                    setRuleEmployeeId("");
                  }}
                  required={ruleScope === "department"}
                >
                  <option value="">Selecciona departamento</option>
                  {departments.map((department) => (
                    <option value={department.id} key={department.id}>{department.name}</option>
                  ))}
                </select>
              </label>
            ) : null}
            {ruleScope === "employee" ? (
              <label>Empleado
                <select value={ruleEmployeeId} onChange={(event) => setRuleEmployeeId(event.target.value)} required>
                  <option value="">Selecciona empleado</option>
                  {scopedEmployees.map((employee) => (
                    <option value={employee.id} key={employee.id}>{employee.full_name}</option>
                  ))}
                </select>
              </label>
            ) : null}
            <label>Ejecutable de app<input value={ruleExecutable} onChange={(event) => setRuleExecutable(event.target.value)} placeholder="chrome.exe, EXCEL.EXE" /></label>
            <label>Titulo contiene<input value={ruleTitle} onChange={(event) => setRuleTitle(event.target.value)} placeholder="Netflix, Google Docs, CRM" /></label>
            <label>Clasificacion
              <select value={ruleClassification} onChange={(event) => setRuleClassification(event.target.value as RuleClassification)}>
                {classifications.map((classification) => (
                  <option value={classification} key={classification}>{classificationLabel(classification)}</option>
                ))}
              </select>
            </label>
            <label>Notas<input value={ruleNotes} onChange={(event) => setRuleNotes(event.target.value)} placeholder="Motivo de la regla" /></label>
            <footer>
              <button className="row-action" type="button" onClick={closeRuleModal}>Cancelar</button>
              <button className="settings-primary-action" type="submit">Guardar</button>
            </footer>
          </form>
        </div>
      ) : null}
    </AppShell>
  );
}
