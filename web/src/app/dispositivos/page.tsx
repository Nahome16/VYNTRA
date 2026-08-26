"use client";

import { FormEvent, useCallback, useEffect, useMemo, useState } from "react";
import { AppShell } from "@/components/app-shell";
import { EmptyState, Panel, RefreshButton, StatCard, StatusLine } from "@/components/ui";
import { useAuth } from "@/components/auth-provider";
import { CatalogsResponse, DeviceRecord, DevicesResponse, SystemCompany, SystemOverviewResponse } from "@/lib/types";

function dateText(value: string | null) {
  if (!value) return "Sin conexion";
  return new Date(value).toLocaleString("es-NI");
}

function statusClass(status: string) {
  if (status === "online") return "badge attendance-good";
  if (status === "offline") return "badge attendance-warn";
  return "badge attendance-bad";
}

export default function DevicesPage() {
  const { apiGet, apiPost, apiPatch, user } = useAuth();
  const [companies, setCompanies] = useState<SystemCompany[]>([]);
  const [devices, setDevices] = useState<DeviceRecord[]>([]);
  const [catalogs, setCatalogs] = useState<CatalogsResponse | null>(null);
  const [companyId, setCompanyId] = useState("");
  const [statusFilter, setStatusFilter] = useState("");
  const [statusText, setStatusText] = useState("");
  const [loading, setLoading] = useState(false);

  const [name, setName] = useState("");
  const [hostname, setHostname] = useState("");
  const [location, setLocation] = useState("");
  const [employeeId, setEmployeeId] = useState("");
  const [agentVersion, setAgentVersion] = useState("pending");

  const [selectedDeviceId, setSelectedDeviceId] = useState("");
  const [editName, setEditName] = useState("");
  const [editHostname, setEditHostname] = useState("");
  const [editLocation, setEditLocation] = useState("");
  const [editEmployeeId, setEditEmployeeId] = useState("");
  const [editAgentVersion, setEditAgentVersion] = useState("");
  const [editActive, setEditActive] = useState(true);
  const [rotateReason, setRotateReason] = useState("");
  const [issuedToken, setIssuedToken] = useState<{ device: string; token: string } | null>(null);

  const canRead = Boolean(user?.permissions?.includes("devices:read"));
  const canManage = Boolean(user?.permissions?.includes("devices:manage"));
  const isSystemAdmin = user?.role === "system_admin";
  const selectedDevice = useMemo(() => devices.find((device) => device.id === selectedDeviceId) || null, [devices, selectedDeviceId]);
  const onlineCount = useMemo(() => devices.filter((device) => device.status === "online").length, [devices]);
  const revokedCount = useMemo(() => devices.filter((device) => device.status === "revoked").length, [devices]);
  const assignedCount = useMemo(() => devices.filter((device) => device.employee_id).length, [devices]);

  function loadDeviceForEdit(device: DeviceRecord | null) {
    if (!device) {
      setSelectedDeviceId("");
      setEditName("");
      setEditHostname("");
      setEditLocation("");
      setEditEmployeeId("");
      setEditAgentVersion("");
      setEditActive(true);
      setRotateReason("");
      return;
    }
    setSelectedDeviceId(device.id);
    setEditName(device.name);
    setEditHostname(device.hostname);
    setEditLocation(device.location);
    setEditEmployeeId(device.employee_id || "");
    setEditAgentVersion(device.agent_version || "unknown");
    setEditActive(device.is_active);
    setRotateReason("");
  }

  const queryString = useCallback(() => {
    const params = new URLSearchParams();
    if (isSystemAdmin && companyId) params.set("company_id", companyId);
    if (statusFilter) params.set("status_filter", statusFilter);
    return params.toString();
  }, [companyId, isSystemAdmin, statusFilter]);

  const loadDevices = useCallback(async () => {
    if (!canRead) return;
    if (isSystemAdmin && !companyId) {
      setDevices([]);
      loadDeviceForEdit(null);
      setStatusText("Selecciona una empresa para ver sus dispositivos");
      return;
    }
    setLoading(true);
    setStatusText("Cargando dispositivos...");
    try {
      const qs = queryString();
      const response = await apiGet<DevicesResponse>(`/api/devices${qs ? `?${qs}` : ""}`);
      setDevices(response.devices);
      loadDeviceForEdit(response.devices.find((device) => device.id === selectedDeviceId) || response.devices[0] || null);
      setStatusText(`${response.count} dispositivos cargados`);
    } catch {
      setStatusText("No se pudieron cargar los dispositivos");
    } finally {
      setLoading(false);
    }
  }, [apiGet, canRead, companyId, isSystemAdmin, queryString, selectedDeviceId]);

  const loadCatalogs = useCallback(async () => {
    if (!canRead) return;
    if (isSystemAdmin && !companyId) {
      setCatalogs(null);
      return;
    }
    try {
      const qs = isSystemAdmin && companyId ? `?company_id=${encodeURIComponent(companyId)}` : "";
      const response = await apiGet<CatalogsResponse>(`/api/productivity/catalogs${qs}`);
      setCatalogs(response);
    } catch {
      setCatalogs(null);
    }
  }, [apiGet, canRead, companyId, isSystemAdmin]);

  const loadCompanies = useCallback(async () => {
    if (!isSystemAdmin) return;
    try {
      const response = await apiGet<SystemOverviewResponse>("/api/system/overview");
      setCompanies(response.companies);
      setCompanyId((current) => current || response.companies[0]?.id || "");
    } catch {
      setCompanies([]);
    }
  }, [apiGet, isSystemAdmin]);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      void loadCompanies();
      void loadCatalogs();
      void loadDevices();
    }, 0);
    return () => window.clearTimeout(timer);
  }, [loadCatalogs, loadCompanies, loadDevices]);

  async function createDevice(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!canManage) return;
    if (isSystemAdmin && !companyId) {
      setStatusText("Selecciona una empresa antes de crear el dispositivo");
      return;
    }
    setStatusText("Creando dispositivo...");
    try {
      const response = await apiPost<{
        device: DeviceRecord;
        credentials: { device_token: string };
      }>("/api/devices", {
        company_id: isSystemAdmin ? companyId || null : null,
        employee_id: employeeId || null,
        name,
        hostname: hostname || name,
        location,
        agent_version: agentVersion || "pending",
      });
      setIssuedToken({ device: response.device.name, token: response.credentials.device_token });
      setName("");
      setHostname("");
      setLocation("");
      setEmployeeId("");
      setAgentVersion("pending");
      setStatusText("Dispositivo creado. Copia el token antes de cerrar esta pantalla.");
      await loadDevices();
    } catch {
      setStatusText("No se pudo crear el dispositivo");
    }
  }

  async function saveDevice(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!canManage || !selectedDeviceId) return;
    setStatusText("Guardando dispositivo...");
    try {
      const response = await apiPatch<{ device: DeviceRecord }>(`/api/devices/${selectedDeviceId}`, {
        employee_id: editEmployeeId || null,
        name: editName,
        hostname: editHostname,
        location: editLocation,
        agent_version: editAgentVersion,
        is_active: editActive,
      });
      setDevices((current) => current.map((device) => (device.id === response.device.id ? response.device : device)));
      loadDeviceForEdit(response.device);
      setStatusText("Dispositivo actualizado");
    } catch {
      setStatusText("No se pudo actualizar el dispositivo");
    }
  }

  async function rotateToken() {
    if (!canManage || !selectedDeviceId || !selectedDevice) return;
    setStatusText("Rotando token...");
    try {
      const response = await apiPost<{
        device: DeviceRecord;
        credentials: { device_token: string };
      }>(`/api/devices/${selectedDeviceId}/rotate-token`, {
        reason: rotateReason || "Rotacion solicitada desde panel",
      });
      setIssuedToken({ device: response.device.name, token: response.credentials.device_token });
      setDevices((current) => current.map((device) => (device.id === response.device.id ? response.device : device)));
      loadDeviceForEdit(response.device);
      setStatusText("Token rotado. Instala el nuevo token en la PC antes de cerrar.");
    } catch {
      setStatusText("No se pudo rotar el token");
    }
  }

  if (!canRead) {
    return (
      <AppShell title="Dispositivos" description="Inventario de agentes VYNTRA">
        <Panel title="Acceso restringido">
          <EmptyState>Tu rol no tiene permiso para consultar dispositivos.</EmptyState>
        </Panel>
      </AppShell>
    );
  }

  return (
    <AppShell
      title="Dispositivos"
      description={`${user?.company || "Sistema"} · agentes instalados y tokens`}
      actions={<RefreshButton loading={loading} onClick={() => void loadDevices()} />}
    >
      <section className="settings-page devices-page">
        <div className="stats-grid">
          <StatCard label="Dispositivos" value={`${devices.length}`} detail="En inventario" />
          <StatCard label="Online" value={`${onlineCount}`} detail="Vistos en 10 minutos" tone={onlineCount ? "good" : "plain"} />
          <StatCard label="Asignados" value={`${assignedCount}`} detail="Con empleado" />
          <StatCard label="Revocados" value={`${revokedCount}`} detail="Token inactivo" tone={revokedCount ? "warn" : "plain"} />
        </div>

        <Panel title="Filtros">
          <div className="device-filter-grid">
            {isSystemAdmin ? (
              <label>Empresa
                <select value={companyId} onChange={(event) => setCompanyId(event.target.value)}>
                  <option value="">Selecciona empresa</option>
                  {companies.map((company) => (
                    <option key={company.id} value={company.id}>{company.name}</option>
                  ))}
                </select>
              </label>
            ) : null}
            <label>Estado
              <select value={statusFilter} onChange={(event) => setStatusFilter(event.target.value)}>
                <option value="">Todos</option>
                <option value="online">Online</option>
                <option value="offline">Offline</option>
                <option value="revoked">Revocados</option>
              </select>
            </label>
            <button type="button" className="settings-primary-action" onClick={() => { void loadCatalogs(); void loadDevices(); }}>
              Aplicar filtros
            </button>
          </div>
        </Panel>

        <StatusLine>{statusText}</StatusLine>

        {issuedToken ? (
          <section className="device-token-box">
            <div>
              <span>Token generado para</span>
              <strong>{issuedToken.device}</strong>
              <p>Copialo ahora. Por seguridad no se vuelve a mostrar.</p>
            </div>
            <code>{issuedToken.token}</code>
          </section>
        ) : null}

        <div className="device-layout">
          <Panel title="Inventario" meta={`${devices.length} equipos`} className="settings-main-panel">
            <div className="settings-table-shell device-table-shell">
              <table>
                <thead>
                  <tr>
                    <th>Equipo</th>
                    <th>Empleado</th>
                    <th>Empresa</th>
                    <th>Version</th>
                    <th>Ultima conexion</th>
                    <th>Estado</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {devices.map((device) => (
                    <tr key={device.id}>
                      <td>
                        <strong>{device.name}</strong>
                        <small>{device.hostname || device.location || "-"}</small>
                      </td>
                      <td>
                        <strong>{device.employee || "Sin asignar"}</strong>
                        <small>{device.employee_code || device.employee_id || "-"}</small>
                      </td>
                      <td>{device.company}</td>
                      <td>{device.agent_version || "unknown"}</td>
                      <td>{dateText(device.last_seen_at)}</td>
                      <td><span className={statusClass(device.status)}>{device.status}</span></td>
                      <td>
                        <button type="button" className="row-action" onClick={() => loadDeviceForEdit(device)}>
                          Editar
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {!devices.length ? <EmptyState>No hay dispositivos para el filtro actual.</EmptyState> : null}
            </div>
          </Panel>

          <div className="device-side-stack">
            <Panel title="Nuevo dispositivo">
              <form className="settings-form device-form" onSubmit={createDevice}>
                <label>Nombre del equipo<input value={name} onChange={(event) => setName(event.target.value)} placeholder="PC-OPERACIONES-01" required disabled={!canManage} /></label>
                <label>Hostname<input value={hostname} onChange={(event) => setHostname(event.target.value)} placeholder="Opcional" disabled={!canManage} /></label>
                <label>Ubicacion<input value={location} onChange={(event) => setLocation(event.target.value)} placeholder="Sucursal / area" disabled={!canManage} /></label>
                <label>Version agente<input value={agentVersion} onChange={(event) => setAgentVersion(event.target.value)} disabled={!canManage} /></label>
                <label>Empleado
                  <select value={employeeId} onChange={(event) => setEmployeeId(event.target.value)} disabled={!canManage}>
                    <option value="">Sin asignar</option>
                    {(catalogs?.employees || []).map((employee) => (
                      <option key={employee.id} value={employee.id}>{employee.full_name}</option>
                    ))}
                  </select>
                </label>
                <button type="submit" className="primary-action" disabled={!canManage}>Crear y emitir token</button>
              </form>
            </Panel>

            <Panel title="Control del equipo">
              <form className="settings-form device-form" onSubmit={saveDevice}>
                <label>Equipo
                  <select value={selectedDeviceId} onChange={(event) => loadDeviceForEdit(devices.find((device) => device.id === event.target.value) || null)} disabled={!canManage}>
                    <option value="">Selecciona equipo</option>
                    {devices.map((device) => (
                      <option key={device.id} value={device.id}>{device.name}</option>
                    ))}
                  </select>
                </label>
                <label>Nombre<input value={editName} onChange={(event) => setEditName(event.target.value)} disabled={!canManage || !selectedDeviceId} /></label>
                <label>Hostname<input value={editHostname} onChange={(event) => setEditHostname(event.target.value)} disabled={!canManage || !selectedDeviceId} /></label>
                <label>Ubicacion<input value={editLocation} onChange={(event) => setEditLocation(event.target.value)} disabled={!canManage || !selectedDeviceId} /></label>
                <label>Version<input value={editAgentVersion} onChange={(event) => setEditAgentVersion(event.target.value)} disabled={!canManage || !selectedDeviceId} /></label>
                <label>Empleado
                  <select value={editEmployeeId} onChange={(event) => setEditEmployeeId(event.target.value)} disabled={!canManage || !selectedDeviceId}>
                    <option value="">Sin asignar</option>
                    {(catalogs?.employees || []).map((employee) => (
                      <option key={employee.id} value={employee.id}>{employee.full_name}</option>
                    ))}
                  </select>
                </label>
                <label className="device-toggle-row">
                  <input type="checkbox" checked={editActive} onChange={(event) => setEditActive(event.target.checked)} disabled={!canManage || !selectedDeviceId} />
                  Token activo
                </label>
                <button type="submit" className="primary-action" disabled={!canManage || !selectedDeviceId}>Guardar equipo</button>
              </form>
              <div className="device-rotate-box">
                <label>Motivo rotacion
                  <input value={rotateReason} onChange={(event) => setRotateReason(event.target.value)} placeholder="Ej. reinstalacion o perdida de token" disabled={!canManage || !selectedDeviceId} />
                </label>
                <button type="button" className="secondary-button danger" onClick={() => void rotateToken()} disabled={!canManage || !selectedDeviceId}>
                  Rotar token
                </button>
              </div>
            </Panel>
          </div>
        </div>
      </section>
    </AppShell>
  );
}
