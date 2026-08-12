"use client";

import { FormEvent, useEffect, useMemo, useState } from "react";
import { AppShell } from "@/components/app-shell";
import { EmptyState, Panel, RefreshButton, StatusLine } from "@/components/ui";
import { useAuth } from "@/components/auth-provider";
import {
  CatalogsResponse,
  Employee,
  ProductivityRule,
  StationRestoreCode,
  UncategorizedItem,
} from "@/lib/types";
import { formatDuration } from "@/lib/format";

const sectionLabels = {
  usuarios: "Usuarios monitoreados",
  accesos: "Accesos",
  reglas: "Reglas",
} as const;

type SectionKey = keyof typeof sectionLabels;

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
  return "General empresa";
}

export default function SettingsPage() {
  const { apiGet, apiPost, user } = useAuth();
  const [activeSection, setActiveSection] = useState<SectionKey>("usuarios");
  const [catalogs, setCatalogs] = useState<CatalogsResponse | null>(null);
  const [rules, setRules] = useState<ProductivityRule[]>([]);
  const [uncategorized, setUncategorized] = useState<UncategorizedItem[]>([]);
  const [restoreCodes, setRestoreCodes] = useState<StationRestoreCode[]>([]);
  const [statusText, setStatusText] = useState("");
  const [loading, setLoading] = useState(false);

  const [employeeName, setEmployeeName] = useState("");
  const [employeeEmail, setEmployeeEmail] = useState("");
  const [employeeDepartmentId, setEmployeeDepartmentId] = useState("");
  const [newDepartment, setNewDepartment] = useState("");
  const [standaloneDepartment, setStandaloneDepartment] = useState("");
  const [generatedCredential, setGeneratedCredential] = useState<{ email: string; password: string } | null>(null);

  const [codeEmployeeId, setCodeEmployeeId] = useState("");
  const [codeReason, setCodeReason] = useState("Restaurar estacion de marcaje");
  const [codeMinutes, setCodeMinutes] = useState("60");
  const [lastRestoreCode, setLastRestoreCode] = useState<StationRestoreCode | null>(null);

  const [ruleDepartmentFilter, setRuleDepartmentFilter] = useState("");
  const [ruleScope, setRuleScope] = useState<"company" | "department" | "employee">("company");
  const [ruleDepartmentId, setRuleDepartmentId] = useState("");
  const [ruleEmployeeId, setRuleEmployeeId] = useState("");
  const [ruleExecutable, setRuleExecutable] = useState("");
  const [ruleTitle, setRuleTitle] = useState("");
  const [ruleClassification, setRuleClassification] = useState("productive");
  const [rulePriority, setRulePriority] = useState("100");
  const [ruleNotes, setRuleNotes] = useState("");

  async function loadSettings() {
    setLoading(true);
    setStatusText("Actualizando ajustes...");
    try {
      const [nextCatalogs, nextRules, nextUncategorized, nextCodes] = await Promise.all([
        apiGet<CatalogsResponse>("/api/productivity/catalogs"),
        apiGet<{ rules: ProductivityRule[] }>("/api/productivity/rules"),
        apiGet<{ items: UncategorizedItem[] }>("/api/productivity/uncategorized?limit=12"),
        apiGet<{ codes: StationRestoreCode[] }>("/api/settings/restore-codes"),
      ]);
      setCatalogs(nextCatalogs);
      setRules(nextRules.rules);
      setUncategorized(nextUncategorized.items);
      setRestoreCodes(nextCodes.codes);
      setCodeEmployeeId((current) => current || nextCatalogs.employees[0]?.id || "");
      setStatusText("Datos actualizados");
    } catch {
      setStatusText("No se pudieron cargar ajustes");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    if (user) void loadSettings();
  }, [user]);

  const departments = catalogs?.departments || [];
  const employees = catalogs?.employees || [];
  const departmentMap = useMemo(
    () => new Map(departments.map((department) => [department.id, department.name])),
    [departments],
  );
  const filteredRules = useMemo(
    () =>
      rules.filter((rule) => {
        if (!ruleDepartmentFilter) return true;
        if (ruleDepartmentFilter === "general") return !rule.department_id && !rule.employee_id;
        return rule.department_id === ruleDepartmentFilter;
      }),
    [ruleDepartmentFilter, rules],
  );
  const scopedEmployees = useMemo(
    () =>
      ruleDepartmentId
        ? employees.filter((employee) => employee.department_id === ruleDepartmentId)
        : employees,
    [employees, ruleDepartmentId],
  );

  async function handleCreateEmployee(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setStatusText("Creando usuario monitoreado...");
    setGeneratedCredential(null);
    try {
      const response = await apiPost<{
        employee: Employee;
        credentials: { email: string; password: string; delivery_status: string };
      }>("/api/settings/employees", {
        full_name: employeeName,
        email: employeeEmail,
        department_id: employeeDepartmentId || null,
        new_department: newDepartment || null,
      });
      setGeneratedCredential({
        email: response.credentials.email,
        password: response.credentials.password,
      });
      setEmployeeName("");
      setEmployeeEmail("");
      setEmployeeDepartmentId("");
      setNewDepartment("");
      await loadSettings();
      setStatusText("Usuario creado. Credenciales generadas para prueba local.");
    } catch {
      setStatusText("No se pudo crear el usuario. Revisa correo duplicado o formato invalido.");
    }
  }

  function prepareRuleFromUncategorized(item: UncategorizedItem) {
    setActiveSection("reglas");
    setRuleScope("company");
    setRuleDepartmentId("");
    setRuleEmployeeId("");
    setRuleExecutable(item.executable_name);
    setRuleTitle(item.title_text);
    setRuleClassification("neutral");
    setRulePriority("120");
    setRuleNotes("Creada desde pendientes de clasificar");
    setStatusText("Regla preparada desde actividad sin clasificar");
  }

  async function handleCreateDepartment(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!standaloneDepartment.trim()) return;
    setStatusText("Creando departamento...");
    try {
      await apiPost("/api/settings/departments", { name: standaloneDepartment });
      setStandaloneDepartment("");
      await loadSettings();
      setStatusText("Departamento creado");
    } catch {
      setStatusText("No se pudo crear el departamento");
    }
  }

  async function handleCreateRestoreCode(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!codeEmployeeId) return;
    setStatusText("Generando codigo de acceso...");
    try {
      const response = await apiPost<{ code: StationRestoreCode }>("/api/settings/restore-codes", {
        employee_id: codeEmployeeId,
        reason: codeReason,
        valid_minutes: Number(codeMinutes),
      });
      setLastRestoreCode(response.code);
      await loadSettings();
      setStatusText("Codigo generado. En local se muestra en pantalla.");
    } catch {
      setStatusText("No se pudo generar el codigo");
    }
  }

  async function handleCreateRule(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setStatusText("Creando regla productiva...");
    try {
      await apiPost("/api/productivity/rules", {
        executable_name: ruleExecutable,
        title_contains: ruleTitle,
        classification: ruleClassification,
        priority: Number(rulePriority),
        notes: ruleNotes,
        department_id: ruleScope === "department" ? ruleDepartmentId : null,
        employee_id: ruleScope === "employee" ? ruleEmployeeId : null,
        reclassify: true,
        rebuild_blocks: true,
      });
      setRuleExecutable("");
      setRuleTitle("");
      setRuleNotes("");
      await loadSettings();
      setStatusText("Regla creada y reclasificacion encolada");
    } catch {
      setStatusText("No se pudo crear la regla. Debe tener app o titulo y un alcance valido.");
    }
  }

  return (
    <AppShell
      title="Ajustes"
      description={`${user?.company || "Empresa"} - usuarios, accesos y reglas por empresa.`}
      actions={<RefreshButton loading={loading} onClick={loadSettings} />}
    >
      <div className="tabs">
        {(Object.keys(sectionLabels) as SectionKey[]).map((key) => (
          <button
            className={activeSection === key ? "active" : ""}
            key={key}
            onClick={() => setActiveSection(key)}
          >
            {sectionLabels[key]}
          </button>
        ))}
      </div>

      {activeSection === "usuarios" ? (
        <section className="settings-grid">
          <Panel title="Usuarios monitoreados" meta={`${employees.length} empleados`} className="wide">
            {employees.length ? (
              <table>
                <thead>
                  <tr>
                    <th>Codigo</th>
                    <th>Empleado</th>
                    <th>Correo</th>
                    <th>Departamento</th>
                    <th>Estado</th>
                  </tr>
                </thead>
                <tbody>
                  {employees.map((employee) => (
                    <tr key={employee.id}>
                      <td>{employee.employee_code}</td>
                      <td>{employee.full_name}</td>
                      <td>{employee.email || "Sin correo"}</td>
                      <td>{employee.department_id ? departmentMap.get(employee.department_id) || "Sin departamento" : "Sin departamento"}</td>
                      <td><span className="badge attendance-good">{employee.status}</span></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : (
              <EmptyState>No hay usuarios monitoreados creados.</EmptyState>
            )}
          </Panel>

          <Panel title="Agregar usuario" meta="credenciales">
            <form className="compact-form" onSubmit={handleCreateEmployee}>
              <label>Nombre completo</label>
              <input value={employeeName} onChange={(event) => setEmployeeName(event.target.value)} placeholder="Empleado nuevo" required />
              <label>Correo electronico</label>
              <input type="email" value={employeeEmail} onChange={(event) => setEmployeeEmail(event.target.value)} placeholder="empleado@empresa.com" required />
              <label>Departamento existente</label>
              <select value={employeeDepartmentId} onChange={(event) => setEmployeeDepartmentId(event.target.value)}>
                <option value="">Sin asignar</option>
                {departments.map((department) => (
                  <option value={department.id} key={department.id}>{department.name}</option>
                ))}
              </select>
              <label>Nuevo departamento</label>
              <input value={newDepartment} onChange={(event) => setNewDepartment(event.target.value)} placeholder="Ej. Finanzas" />
              <button type="submit">Agregar usuario</button>
            </form>
            {generatedCredential ? (
              <div className="credential-box">
                <span>Credencial generada</span>
                <strong>{generatedCredential.email}</strong>
                <code>{generatedCredential.password}</code>
                <small>SMTP aun no esta configurado; por ahora se muestra una sola vez para pruebas locales.</small>
              </div>
            ) : null}
          </Panel>

          <Panel title="Departamentos" meta={`${departments.length} activos`}>
            <form className="compact-form" onSubmit={handleCreateDepartment}>
              <label>Nuevo departamento</label>
              <input value={standaloneDepartment} onChange={(event) => setStandaloneDepartment(event.target.value)} placeholder="Ej. Operaciones" />
              <button type="submit">Crear departamento</button>
            </form>
            <div className="chips settings-chips">
              {departments.map((department) => (
                <span key={department.id}>{department.name}</span>
              ))}
            </div>
          </Panel>
        </section>
      ) : null}

      {activeSection === "accesos" ? (
        <section className="settings-grid">
          <Panel title="Codigos de restauracion" meta={`${restoreCodes.length} emitidos`} className="wide">
            {restoreCodes.length ? (
              <table>
                <thead>
                  <tr>
                    <th>Empleado</th>
                    <th>Codigo</th>
                    <th>Estado</th>
                    <th>Valido hasta</th>
                    <th>Motivo</th>
                  </tr>
                </thead>
                <tbody>
                  {restoreCodes.map((code) => (
                    <tr key={code.id}>
                      <td>{code.employee || code.email}</td>
                      <td><span className="time-pill">{code.code}</span></td>
                      <td><span className="badge attendance-warn">{code.status}</span></td>
                      <td>{new Date(code.valid_until).toLocaleString("es-NI")}</td>
                      <td>{code.reason}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : (
              <EmptyState>No hay codigos generados.</EmptyState>
            )}
          </Panel>

          <Panel title="Crear acceso" meta="restaurar jornada">
            <form className="compact-form" onSubmit={handleCreateRestoreCode}>
              <label>Usuario</label>
              <select value={codeEmployeeId} onChange={(event) => setCodeEmployeeId(event.target.value)} required>
                <option value="">Selecciona usuario</option>
                {employees.map((employee) => (
                  <option value={employee.id} key={employee.id}>{employee.full_name}</option>
                ))}
              </select>
              <label>Validez en minutos</label>
              <input type="number" min="5" max="1440" value={codeMinutes} onChange={(event) => setCodeMinutes(event.target.value)} />
              <label>Motivo</label>
              <input value={codeReason} onChange={(event) => setCodeReason(event.target.value)} />
              <button type="submit">Generar codigo</button>
            </form>
            {lastRestoreCode ? (
              <div className="credential-box">
                <span>Codigo generado</span>
                <code>{lastRestoreCode.code}</code>
                <small>Cuando configuremos SMTP, este codigo se enviara al correo del usuario.</small>
              </div>
            ) : null}
          </Panel>
        </section>
      ) : null}

      {activeSection === "reglas" ? (
        <section className="settings-grid">
          <Panel title="Reglas productivas" meta={`${filteredRules.length} visibles`} className="wide">
            <div className="settings-filter">
              <label>
                Departamento
                <select value={ruleDepartmentFilter} onChange={(event) => setRuleDepartmentFilter(event.target.value)}>
                  <option value="">Todos</option>
                  <option value="general">General empresa</option>
                  {departments.map((department) => (
                    <option value={department.id} key={department.id}>{department.name}</option>
                  ))}
                </select>
              </label>
            </div>
            {filteredRules.length ? (
              <table>
                <thead>
                  <tr>
                    <th>App</th>
                    <th>Titulo contiene</th>
                    <th>Clasificacion</th>
                    <th>Alcance</th>
                    <th>Prioridad</th>
                  </tr>
                </thead>
                <tbody>
                  {filteredRules.slice(0, 80).map((rule) => (
                    <tr key={rule.id}>
                      <td>{rule.executable_name || "*"}</td>
                      <td>{rule.title_contains || "*"}</td>
                      <td><span className={`badge badge-${rule.classification}`}>{classificationLabel(rule.classification)}</span></td>
                      <td>{scopeLabel(rule)}</td>
                      <td>{rule.priority}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : (
              <EmptyState>No hay reglas para el filtro actual.</EmptyState>
            )}
          </Panel>

          <Panel title="Agregar regla" meta="alcance">
            <form className="compact-form" onSubmit={handleCreateRule}>
              <label>Aplicar a</label>
              <select value={ruleScope} onChange={(event) => setRuleScope(event.target.value as "company" | "department" | "employee")}>
                <option value="company">General empresa</option>
                <option value="department">Departamento</option>
                <option value="employee">Empleado</option>
              </select>
              {ruleScope !== "company" ? (
                <>
                  <label>Departamento</label>
                  <select value={ruleDepartmentId} onChange={(event) => setRuleDepartmentId(event.target.value)} required={ruleScope === "department"}>
                    <option value="">Selecciona departamento</option>
                    {departments.map((department) => (
                      <option value={department.id} key={department.id}>{department.name}</option>
                    ))}
                  </select>
                </>
              ) : null}
              {ruleScope === "employee" ? (
                <>
                  <label>Empleado</label>
                  <select value={ruleEmployeeId} onChange={(event) => setRuleEmployeeId(event.target.value)} required>
                    <option value="">Selecciona empleado</option>
                    {scopedEmployees.map((employee) => (
                      <option value={employee.id} key={employee.id}>{employee.full_name}</option>
                    ))}
                  </select>
                </>
              ) : null}
              <label>Ejecutable de app</label>
              <input value={ruleExecutable} onChange={(event) => setRuleExecutable(event.target.value)} placeholder="chrome.exe, EXCEL.EXE" />
              <label>Titulo contiene</label>
              <input value={ruleTitle} onChange={(event) => setRuleTitle(event.target.value)} placeholder="Netflix, Google Docs, CRM" />
              <label>Clasificacion</label>
              <select value={ruleClassification} onChange={(event) => setRuleClassification(event.target.value)}>
                <option value="productive">Productiva</option>
                <option value="neutral">Neutral</option>
                <option value="non_productive">No productiva</option>
                <option value="uncategorized">Sin clasificar</option>
              </select>
              <label>Prioridad</label>
              <input type="number" min="1" max="999" value={rulePriority} onChange={(event) => setRulePriority(event.target.value)} />
              <label>Notas</label>
              <input value={ruleNotes} onChange={(event) => setRuleNotes(event.target.value)} placeholder="Motivo de la regla" />
              <button type="submit">Agregar regla</button>
            </form>
          </Panel>

          <Panel title="Pendientes de clasificar" meta={`${uncategorized.length} patrones`}>
            <div className="stack">
              {uncategorized.length ? (
                uncategorized.map((item) => (
                  <article className="list-item" key={`${item.executable_name}-${item.title_text}`}>
                    <strong>{item.executable_name || "(desconocido)"}</strong>
                    <span>{item.title_text || "(sin titulo)"}</span>
                    <small>{formatDuration(item.seconds)} - {item.samples} muestras</small>
                    <button className="row-action" type="button" onClick={() => prepareRuleFromUncategorized(item)}>
                      Crear regla
                    </button>
                  </article>
                ))
              ) : (
                <EmptyState>No hay actividad pendiente de clasificar.</EmptyState>
              )}
            </div>
          </Panel>
        </section>
      ) : null}

      <StatusLine>{statusText}</StatusLine>
    </AppShell>
  );
}
