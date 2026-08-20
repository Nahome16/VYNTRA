"use client";

import { FormEvent, useCallback, useEffect, useMemo, useState } from "react";
import { AppShell } from "@/components/app-shell";
import { EmptyState, Panel, RefreshButton, StatCard, StatusLine } from "@/components/ui";
import { useAuth } from "@/components/auth-provider";
import { PanelUser, SystemCompany, SystemOverviewResponse } from "@/lib/types";

type PanelRole = "system_admin" | "owner" | "admin" | "rrhh" | "supervisor" | "viewer";

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

function deliveryText(status?: string) {
  if (status === "sent") return "Credencial enviada por correo.";
  if (status === "failed") return "Credencial creada, pero el correo fallo.";
  return "Credencial creada. Entrega pendiente de configuracion SMTP.";
}

function planUsage(company: SystemCompany | null) {
  if (!company || !company.controls.employee_limit) return 0;
  return Math.min(100, Math.round((company.employees_count / company.controls.employee_limit) * 100));
}

function badgeClass(status: string) {
  if (status === "active") return "badge attendance-good";
  if (status === "trial" || status === "past_due") return "badge attendance-warn";
  return "badge attendance-bad";
}

export default function SystemPage() {
  const { apiGet, apiPost, apiPatch, user } = useAuth();
  const [companies, setCompanies] = useState<SystemCompany[]>([]);
  const [users, setUsers] = useState<PanelUser[]>([]);
  const [roles, setRoles] = useState<SystemOverviewResponse["roles"]>([]);
  const [statusText, setStatusText] = useState("");
  const [loading, setLoading] = useState(false);

  const [companyName, setCompanyName] = useState("");
  const [companyLegalName, setCompanyLegalName] = useState("");
  const [companyTimezone, setCompanyTimezone] = useState("America/Managua");
  const [controlsCompanyId, setControlsCompanyId] = useState("");
  const [employeeLimit, setEmployeeLimit] = useState("0");
  const [subscriptionStatus, setSubscriptionStatus] = useState<SystemCompany["controls"]["subscription_status"]>("active");
  const [subscriptionEndsAt, setSubscriptionEndsAt] = useState("");
  const [adminNotice, setAdminNotice] = useState("");

  const [panelCompanyId, setPanelCompanyId] = useState("");
  const [panelFullName, setPanelFullName] = useState("");
  const [panelEmail, setPanelEmail] = useState("");
  const [panelRole, setPanelRole] = useState<PanelRole>("supervisor");
  const [generatedCredential, setGeneratedCredential] = useState<{ email: string; password?: string; delivery_status?: string } | null>(null);

  const [selectedUserId, setSelectedUserId] = useState("");
  const [editFullName, setEditFullName] = useState("");
  const [editRole, setEditRole] = useState<PanelRole>("viewer");
  const [editStatus, setEditStatus] = useState<"active" | "inactive">("active");
  const [resetReason, setResetReason] = useState("");

  const isSystemAdmin = user?.role === "system_admin";
  const activeCompanies = useMemo(() => companies.filter((company) => company.status === "active"), [companies]);
  const supervisors = useMemo(() => users.filter((row) => row.role === "supervisor"), [users]);
  const controlsCompany = useMemo(
    () => companies.find((company) => company.id === controlsCompanyId) || companies[0] || null,
    [companies, controlsCompanyId],
  );
  const selectedUser = useMemo(() => users.find((row) => row.id === selectedUserId) || null, [selectedUserId, users]);
  const usage = planUsage(controlsCompany);

  const loadCompanyControls = useCallback((company: SystemCompany | null) => {
    if (!company) return;
    setControlsCompanyId(company.id);
    setEmployeeLimit(String(company.controls.employee_limit || 0));
    setSubscriptionStatus(company.controls.subscription_status || "active");
    setSubscriptionEndsAt(company.controls.subscription_ends_at || "");
    setAdminNotice(company.controls.admin_notice || "");
  }, []);

  const loadPanelUser = useCallback((panelUser: PanelUser | null) => {
    if (!panelUser) return;
    setSelectedUserId(panelUser.id);
    setEditFullName(panelUser.full_name);
    setEditRole((panelUser.role || "viewer") as PanelRole);
    setEditStatus(panelUser.status === "inactive" ? "inactive" : "active");
    setResetReason("");
  }, []);

  const loadSystem = useCallback(async () => {
    if (!isSystemAdmin) return;
    setLoading(true);
    setStatusText("Actualizando sistema...");
    try {
      const response = await apiGet<SystemOverviewResponse>("/api/system/overview");
      setCompanies(response.companies);
      setUsers(response.users);
      setRoles(response.roles);
      setPanelCompanyId((current) => current || response.companies[0]?.id || "");
      loadCompanyControls(response.companies.find((company) => company.id === controlsCompanyId) || response.companies[0] || null);
      loadPanelUser(response.users.find((row) => row.id === selectedUserId) || response.users[0] || null);
      setStatusText("Sistema actualizado");
    } catch {
      setStatusText("No se pudo cargar la consola del sistema");
    } finally {
      setLoading(false);
    }
  }, [apiGet, controlsCompanyId, isSystemAdmin, loadCompanyControls, loadPanelUser, selectedUserId]);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      void loadSystem();
    }, 0);
    return () => window.clearTimeout(timer);
  }, [loadSystem]);

  async function createCompany(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!companyName.trim()) return;
    setStatusText("Creando empresa...");
    try {
      const response = await apiPost<{ company: SystemCompany }>("/api/system/companies", {
        name: companyName,
        legal_name: companyLegalName || null,
        timezone: companyTimezone || "America/Managua",
      });
      setCompanies((current) => [response.company, ...current.filter((company) => company.id !== response.company.id)]);
      setPanelCompanyId(response.company.id);
      loadCompanyControls(response.company);
      setCompanyName("");
      setCompanyLegalName("");
      setStatusText("Empresa creada");
      await loadSystem();
    } catch {
      setStatusText("No se pudo crear la empresa");
    }
  }

  async function createPanelUser(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (panelRole !== "system_admin" && !panelCompanyId) {
      setStatusText("Selecciona una empresa para este usuario");
      return;
    }
    setStatusText("Creando credencial...");
    try {
      const response = await apiPost<{
        user: PanelUser;
        credentials: { email: string; password?: string; delivery_status?: string };
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
      setStatusText(deliveryText(response.credentials.delivery_status));
      await loadSystem();
    } catch {
      setStatusText("No se pudo crear el acceso. Revisa correo duplicado o permisos.");
    }
  }

  async function savePanelUser(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!selectedUserId) {
      setStatusText("Selecciona un usuario del panel");
      return;
    }
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
    }
  }

  async function resetPanelPassword() {
    if (!selectedUserId) {
      setStatusText("Selecciona un usuario del panel");
      return;
    }
    setStatusText("Generando nueva credencial...");
    try {
      const response = await apiPost<{
        user: PanelUser;
        credentials: { email: string; password?: string; delivery_status?: string };
      }>(`/api/system/users/${selectedUserId}/reset-password`, { reason: resetReason || "Reset solicitado por administrador del sistema" });
      setUsers((current) => current.map((row) => (row.id === response.user.id ? response.user : row)));
      setGeneratedCredential(response.credentials);
      loadPanelUser(response.user);
      setStatusText(deliveryText(response.credentials.delivery_status));
    } catch {
      setStatusText("No se pudo resetear la credencial");
    }
  }

  async function saveCompanyControls(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!controlsCompanyId) {
      setStatusText("Selecciona una empresa para configurar controles");
      return;
    }
    setStatusText("Guardando controles...");
    try {
      const response = await apiPatch<{ company: SystemCompany }>(`/api/system/companies/${controlsCompanyId}/controls`, {
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
    }
  }

  if (!isSystemAdmin) {
    return (
      <AppShell title="Sistema" description="Controles globales de VYNTRA">
        <Panel title="Acceso restringido">
          <EmptyState>Esta vista requiere el rol Administrador del sistema.</EmptyState>
        </Panel>
      </AppShell>
    );
  }

  return (
    <AppShell
      title="Sistema"
      description="Consola master multitenant"
      actions={<RefreshButton loading={loading} onClick={() => void loadSystem()} />}
    >
      <section className="settings-page system-console">
        <div className="stats-grid">
          <StatCard label="Empresas" value={`${companies.length}`} detail={`${activeCompanies.length} activas`} />
          <StatCard label="Usuarios panel" value={`${users.length}`} detail="Accesos administrativos" />
          <StatCard label="Supervisores" value={`${supervisors.length}`} detail="Credenciales operativas" />
          <StatCard label="Dispositivos" value={`${companies.reduce((sum, company) => sum + company.devices_count, 0)}`} detail="Agentes registrados" />
        </div>

        <StatusLine>{statusText}</StatusLine>

        {controlsCompany ? (
          <section className="system-focus">
            <div>
              <span>Empresa en foco</span>
              <h2>{controlsCompany.name}</h2>
              <p>{controlsCompany.legal_name || controlsCompany.timezone}</p>
            </div>
            <div className="system-plan-meter">
              <div>
                <span>Uso del plan</span>
                <strong>
                  {controlsCompany.employees_count}/{controlsCompany.controls.employee_limit || "sin limite"}
                </strong>
              </div>
              <div className="system-progress" aria-label="Uso del limite de empleados">
                <span style={{ width: `${usage}%` }} />
              </div>
            </div>
            <div className="system-subscription-card">
              <span>Suscripcion</span>
              <strong>{controlsCompany.controls.subscription_status}</strong>
              <small>{controlsCompany.controls.subscription_ends_at ? `Vence ${controlsCompany.controls.subscription_ends_at}` : "Sin vencimiento definido"}</small>
            </div>
            {controlsCompany.controls.admin_notice ? (
              <p className="system-focus-notice">{controlsCompany.controls.admin_notice}</p>
            ) : null}
          </section>
        ) : null}

        <div className="system-console-grid">
          <Panel title="Empresas" meta={`${companies.length} registradas`} className="settings-main-panel">
            <div className="settings-table-shell">
              <table>
                <thead>
                  <tr>
                    <th>Empresa</th>
                    <th>Usuarios</th>
                    <th>Empleados</th>
                    <th>Limite</th>
                    <th>Vence</th>
                    <th>Dispositivos</th>
                    <th>Estado</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {companies.map((company) => (
                    <tr key={company.id}>
                      <td>
                        <strong>{company.name}</strong>
                        <small>{company.legal_name || company.timezone}</small>
                      </td>
                      <td>{company.users_count}</td>
                      <td>{company.employees_count}</td>
                      <td>{company.controls.employee_limit || "Sin limite"}</td>
                      <td>{company.controls.subscription_ends_at || "-"}</td>
                      <td>{company.devices_count}</td>
                      <td><span className={badgeClass(company.controls.subscription_status || company.status)}>{company.controls.subscription_status || company.status}</span></td>
                      <td>
                        <button className="row-action" type="button" onClick={() => loadCompanyControls(company)}>
                          Seleccionar
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {!companies.length ? <EmptyState>No hay empresas creadas.</EmptyState> : null}
            </div>
          </Panel>

          <div className="system-command-stack">
            <Panel title="Nueva empresa">
              <form className="settings-form system-form" onSubmit={createCompany}>
                <label>Nombre comercial<input value={companyName} onChange={(event) => setCompanyName(event.target.value)} placeholder="Empresa cliente" required /></label>
                <label>Razon social<input value={companyLegalName} onChange={(event) => setCompanyLegalName(event.target.value)} placeholder="Opcional" /></label>
                <label>Zona horaria<input value={companyTimezone} onChange={(event) => setCompanyTimezone(event.target.value)} placeholder="America/Managua" /></label>
                <button type="submit" className="primary-action">Crear empresa</button>
              </form>
            </Panel>

            <Panel title="Controles comerciales">
              <form className="settings-form system-form" onSubmit={saveCompanyControls}>
                <label>Empresa
                  <select
                    value={controlsCompanyId}
                    onChange={(event) => {
                      const company = companies.find((row) => row.id === event.target.value) || null;
                      loadCompanyControls(company);
                    }}
                    required
                  >
                    <option value="">Selecciona empresa</option>
                    {companies.map((company) => (
                      <option key={company.id} value={company.id}>{company.name}</option>
                    ))}
                  </select>
                </label>
                <div className="system-form-row">
                  <label>Limite empleados
                    <input type="number" min="0" value={employeeLimit} onChange={(event) => setEmployeeLimit(event.target.value)} />
                  </label>
                  <label>Estado
                    <select value={subscriptionStatus} onChange={(event) => setSubscriptionStatus(event.target.value as typeof subscriptionStatus)}>
                      <option value="active">Activa</option>
                      <option value="trial">Prueba</option>
                      <option value="past_due">Pago pendiente</option>
                      <option value="suspended">Suspendida</option>
                      <option value="cancelled">Cancelada</option>
                    </select>
                  </label>
                </div>
                <label>Vence<input type="date" value={subscriptionEndsAt} onChange={(event) => setSubscriptionEndsAt(event.target.value)} /></label>
                <label>Mensaje para admins
                  <textarea value={adminNotice} onChange={(event) => setAdminNotice(event.target.value)} placeholder="Tu suscripcion vence pronto. Comunicate con soporte." maxLength={255} rows={3} />
                </label>
                <button type="submit" className="primary-action">Guardar controles</button>
              </form>
            </Panel>
          </div>
        </div>

        <div className="system-access-grid">
          <Panel title="Crear credencial">
            <form className="settings-form system-form" onSubmit={createPanelUser}>
              <div className="system-form-row">
                <label>Empresa
                  <select value={panelCompanyId} onChange={(event) => setPanelCompanyId(event.target.value)} required={panelRole !== "system_admin"}>
                    <option value="">Selecciona empresa</option>
                    {companies.map((company) => (
                      <option key={company.id} value={company.id}>{company.name}</option>
                    ))}
                  </select>
                </label>
                <label>Rol
                  <select value={panelRole} onChange={(event) => setPanelRole(event.target.value as PanelRole)}>
                    {roles.map((role) => (
                      <option key={role} value={role}>{roleLabels[role]}</option>
                    ))}
                  </select>
                </label>
              </div>
              <p className="role-hint">{roleHelp[panelRole]}</p>
              <label>Nombre completo<input value={panelFullName} onChange={(event) => setPanelFullName(event.target.value)} placeholder="Nombre completo" required /></label>
              <label>Correo<input type="email" value={panelEmail} onChange={(event) => setPanelEmail(event.target.value)} placeholder="supervisor@empresa.com" required /></label>
              <button type="submit" className="primary-action">Crear credencial</button>
            </form>
            {generatedCredential ? (
              <div className="credential-box system-credential">
                <span>Ultima credencial</span>
                <strong>{generatedCredential.email}</strong>
                {generatedCredential.password ? <code>{generatedCredential.password}</code> : <small>{deliveryText(generatedCredential.delivery_status)}</small>}
              </div>
            ) : null}
          </Panel>

          <Panel title="Administrar acceso">
            <form className="settings-form system-form" onSubmit={savePanelUser}>
              <label>Usuario
                <select
                  value={selectedUserId}
                  onChange={(event) => loadPanelUser(users.find((row) => row.id === event.target.value) || null)}
                >
                  <option value="">Selecciona usuario</option>
                  {users.map((row) => (
                    <option key={row.id} value={row.id}>{row.full_name} - {row.email}</option>
                  ))}
                </select>
              </label>
              <div className="system-user-focus">
                <strong>{selectedUser?.email || "Sin usuario seleccionado"}</strong>
                <span>{selectedUser ? `${selectedUser.company} · ${roleLabels[selectedUser.role] || selectedUser.role}` : "Elige un acceso para editarlo"}</span>
              </div>
              <label>Nombre<input value={editFullName} onChange={(event) => setEditFullName(event.target.value)} disabled={!selectedUserId} /></label>
              <div className="system-form-row">
                <label>Rol
                  <select value={editRole} onChange={(event) => setEditRole(event.target.value as PanelRole)} disabled={!selectedUserId}>
                    {roles.map((role) => (
                      <option key={role} value={role}>{roleLabels[role]}</option>
                    ))}
                  </select>
                </label>
                <label>Estado
                  <select value={editStatus} onChange={(event) => setEditStatus(event.target.value as typeof editStatus)} disabled={!selectedUserId}>
                    <option value="active">Activo</option>
                    <option value="inactive">Inactivo</option>
                  </select>
                </label>
              </div>
              <button type="submit" className="primary-action" disabled={!selectedUserId}>Guardar usuario</button>
            </form>
            <div className="system-reset-box">
              <label>Motivo del reset
                <input value={resetReason} onChange={(event) => setResetReason(event.target.value)} placeholder="Ej. cambio de responsable" disabled={!selectedUserId} />
              </label>
              <button type="button" className="secondary-button danger" onClick={() => void resetPanelPassword()} disabled={!selectedUserId}>
                Resetear contrasena
              </button>
            </div>
          </Panel>
        </div>

        <Panel title="Usuarios del panel" meta={`${users.length} accesos`}>
          <div className="settings-table-shell">
            <table>
              <thead>
                <tr>
                  <th>Usuario</th>
                  <th>Empresa</th>
                  <th>Rol</th>
                  <th>Estado</th>
                  <th>Ultimo ingreso</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {users.map((row) => (
                  <tr key={row.id}>
                    <td><strong>{row.full_name}</strong><small>{row.email}</small></td>
                    <td>{row.company}</td>
                    <td>{roleLabels[row.role] || row.role}</td>
                    <td><span className={badgeClass(row.status)}>{row.status}</span></td>
                    <td>{row.last_login_at ? new Date(row.last_login_at).toLocaleString("es-NI") : "Sin ingreso"}</td>
                    <td>
                      <button className="row-action" type="button" onClick={() => loadPanelUser(row)}>
                        Editar
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {!users.length ? <EmptyState>No hay usuarios administrativos.</EmptyState> : null}
          </div>
        </Panel>
      </section>
    </AppShell>
  );
}
