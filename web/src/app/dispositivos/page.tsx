"use client";

import { FormEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AppShell } from "@/components/app-shell";
import { Chip, Drawer, EmptyBlock, EmptyState, Panel, RefreshButton, RowMenu, StatusLine } from "@/components/ui";
import { StatTile } from "@/components/charts";
import { useAuth } from "@/components/auth-provider";
import { usePreferences } from "@/components/preferences-provider";
import { CatalogsResponse, DeviceRecord, DevicesResponse, SystemCompany, SystemOverviewResponse } from "@/lib/types";
import styles from "./dispositivos.module.css";

type IssuedToken = { device: string; deviceId: string; token: string; kind: "create" | "rotate" };

function dateText(value: string | null, t: (text: string) => string) {
  if (!value) return t("Sin conexion");
  return new Date(value).toLocaleString("es-NI");
}

/** "hace 5 min", "hace 2 h"... en el idioma activo. */
function relativeText(value: string | null, language: string, t: (text: string) => string) {
  if (!value) return t("Sin conexion");
  const time = new Date(value).getTime();
  if (!Number.isFinite(time)) return t("Sin conexion");
  const seconds = Math.round((time - Date.now()) / 1000);
  const format = new Intl.RelativeTimeFormat(language === "en" ? "en" : "es", { numeric: "auto" });
  const abs = Math.abs(seconds);
  if (abs < 60) return format.format(0, "second");
  if (abs < 3600) return format.format(Math.round(seconds / 60), "minute");
  if (abs < 86400) return format.format(Math.round(seconds / 3600), "hour");
  if (abs < 86400 * 30) return format.format(Math.round(seconds / 86400), "day");
  return new Date(value).toLocaleDateString(language === "en" ? "en-US" : "es-NI");
}

function statusChip(status: string, t: (text: string) => string) {
  if (status === "online") return <Chip tone="good">{t("En línea")}</Chip>;
  if (status === "offline") return <Chip tone="warn">{t("Desconectado")}</Chip>;
  if (status === "revoked") return <Chip tone="bad">{t("Revocado")}</Chip>;
  return <Chip>{status}</Chip>;
}

export default function DevicesPage() {
  const { apiGet, apiPost, apiPatch, activeCompanyId, setActiveCompanyId, user } = useAuth();
  const { t, language } = usePreferences();
  const [companies, setCompanies] = useState<SystemCompany[]>([]);
  const [devices, setDevices] = useState<DeviceRecord[]>([]);
  const [catalogs, setCatalogs] = useState<CatalogsResponse | null>(null);
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
  const [issuedToken, setIssuedToken] = useState<IssuedToken | null>(null);

  const [createOpen, setCreateOpen] = useState(false);
  const [createDone, setCreateDone] = useState(false);
  const [creating, setCreating] = useState(false);
  const [controlOpen, setControlOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [rotateConfirm, setRotateConfirm] = useState(false);
  const [rotating, setRotating] = useState(false);
  const [copied, setCopied] = useState(false);
  // La seleccion se conserva entre recargas sin que cambiarla dispare otra carga.
  const selectedDeviceIdRef = useRef("");

  const canRead = Boolean(user?.permissions?.includes("devices:read"));
  const canManage = Boolean(user?.permissions?.includes("devices:manage"));
  const isSystemAdmin = user?.role === "system_admin";
  const companyId = isSystemAdmin ? activeCompanyId : "";
  const selectedDevice = useMemo(() => devices.find((device) => device.id === selectedDeviceId) || null, [devices, selectedDeviceId]);
  const onlineCount = useMemo(() => devices.filter((device) => device.status === "online").length, [devices]);
  const revokedCount = useMemo(() => devices.filter((device) => device.status === "revoked").length, [devices]);
  const assignedCount = useMemo(() => devices.filter((device) => device.employee_id).length, [devices]);
  const activeCompanyName = useMemo(
    () => companies.find((company) => company.id === companyId)?.name || devices[0]?.company || user?.company || t("Sistema"),
    [companies, companyId, devices, t, user?.company],
  );

  function loadDeviceForEdit(device: DeviceRecord | null) {
    if (!device) {
      selectedDeviceIdRef.current = "";
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
    selectedDeviceIdRef.current = device.id;
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
      setStatusText(t("Selecciona una empresa para ver sus dispositivos"));
      return;
    }
    setLoading(true);
    setStatusText(t("Cargando dispositivos..."));
    try {
      const qs = queryString();
      const response = await apiGet<DevicesResponse>(`/api/devices${qs ? `?${qs}` : ""}`);
      setDevices(response.devices);
      loadDeviceForEdit(response.devices.find((device) => device.id === selectedDeviceIdRef.current) || response.devices[0] || null);
      setStatusText(`${response.count} ${t("dispositivos cargados")}`);
    } catch {
      setStatusText(t("No se pudieron cargar los dispositivos"));
    } finally {
      setLoading(false);
    }
  }, [apiGet, canRead, companyId, isSystemAdmin, queryString, t]);

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
      const activeCompanies = response.companies.filter((company) => company.status === "active");
      setCompanies(activeCompanies);
      const current = activeCompanies.find((company) => company.id === activeCompanyId);
      if (!current) {
        setActiveCompanyId(activeCompanies[0]?.id || "", activeCompanies[0]?.name);
      } else {
        setActiveCompanyId(current.id, current.name);
      }
    } catch {
      setCompanies([]);
    }
  }, [activeCompanyId, apiGet, isSystemAdmin, setActiveCompanyId]);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      void loadCompanies();
      void loadCatalogs();
      void loadDevices();
    }, 0);
    return () => window.clearTimeout(timer);
  }, [loadCatalogs, loadCompanies, loadDevices]);

  useEffect(() => {
    if (!isSystemAdmin) return;
    const timer = window.setTimeout(() => {
      setEmployeeId("");
      setCatalogs(null);
      setDevices([]);
      selectedDeviceIdRef.current = "";
      setSelectedDeviceId("");
      setEditName("");
      setEditHostname("");
      setEditLocation("");
      setEditEmployeeId("");
      setEditAgentVersion("");
      setEditActive(true);
      setRotateReason("");
      setControlOpen(false);
    }, 0);
    return () => window.clearTimeout(timer);
  }, [activeCompanyId, isSystemAdmin]);

  function openCreate() {
    setStatusText("");
    setCreateDone(false);
    setCreateOpen(true);
  }

  function closeCreate() {
    setCreateOpen(false);
    setCreateDone(false);
  }

  function openControl(device: DeviceRecord, confirmRotate = false) {
    loadDeviceForEdit(device);
    setStatusText("");
    setRotateConfirm(confirmRotate);
    setControlOpen(true);
  }

  function closeControl() {
    setControlOpen(false);
    setRotateConfirm(false);
  }

  async function copyToken(value: string) {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1800);
    } catch {
      setCopied(false);
    }
  }

  async function createDevice(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!canManage) return;
    if (isSystemAdmin && !companyId) {
      setStatusText(t("Selecciona una empresa antes de crear el dispositivo"));
      return;
    }
    setCreating(true);
    setStatusText(t("Creando dispositivo..."));
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
      setIssuedToken({ device: response.device.name, deviceId: response.device.id, token: response.credentials.device_token, kind: "create" });
      setCopied(false);
      setName("");
      setHostname("");
      setLocation("");
      setEmployeeId("");
      setAgentVersion("pending");
      setCreateDone(true);
      setStatusText(t("Dispositivo creado. Copia el token antes de cerrar esta pantalla."));
      await loadDevices();
    } catch {
      setStatusText(t("No se pudo crear el dispositivo"));
    } finally {
      setCreating(false);
    }
  }

  async function saveDevice(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!canManage || !selectedDeviceId) return;
    setSaving(true);
    setStatusText(t("Guardando dispositivo..."));
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
      setStatusText(t("Dispositivo actualizado"));
    } catch {
      setStatusText(t("No se pudo actualizar el dispositivo"));
    } finally {
      setSaving(false);
    }
  }

  async function rotateToken() {
    if (!canManage || !selectedDeviceId || !selectedDevice) return;
    setRotating(true);
    setStatusText(t("Rotando token..."));
    try {
      const response = await apiPost<{
        device: DeviceRecord;
        credentials: { device_token: string };
      }>(`/api/devices/${selectedDeviceId}/rotate-token`, {
        reason: rotateReason || "Rotacion solicitada desde panel",
      });
      setIssuedToken({ device: response.device.name, deviceId: response.device.id, token: response.credentials.device_token, kind: "rotate" });
      setCopied(false);
      setDevices((current) => current.map((device) => (device.id === response.device.id ? response.device : device)));
      loadDeviceForEdit(response.device);
      setRotateConfirm(false);
      setStatusText(t("Token rotado. Instala el nuevo token en la PC antes de cerrar."));
    } catch {
      setStatusText(t("No se pudo rotar el token"));
    } finally {
      setRotating(false);
    }
  }

  function tokenBox(token: IssuedToken, className = "") {
    return (
      <section className={`${styles.token} ${className}`} aria-live="polite">
        <div className={styles.tokenHead}>
          <div>
            <span>{token.kind === "rotate" ? t("Nuevo token para") : t("Token generado para")}</span>
            <strong>{token.device}</strong>
            <p>{t("Copialo ahora. Por seguridad no se vuelve a mostrar.")}</p>
          </div>
        </div>
        <div className={styles.tokenValue}>
          <code>{token.token}</code>
          <button type="button" className="btn btn-outline btn-sm" onClick={() => void copyToken(token.token)}>
            {copied ? t("Copiado") : t("Copiar")}
          </button>
        </div>
      </section>
    );
  }

  if (!canRead) {
    return (
      <AppShell title={t("Dispositivos")} description={t("Inventario de agentes VYNTRA")}>
        <Panel title={t("Acceso restringido")}>
          <EmptyState>{t("Tu rol no tiene permiso para consultar dispositivos.")}</EmptyState>
        </Panel>
      </AppShell>
    );
  }

  const employees = catalogs?.employees || [];
  const noCompany = isSystemAdmin && !companyId;

  return (
    <AppShell
      title={t("Dispositivos")}
      description={`${activeCompanyName} · ${t("agentes instalados y tokens")}`}
      actions={(
        <>
          <RefreshButton loading={loading} onClick={() => { void loadCatalogs(); void loadDevices(); }} />
          <button
            type="button"
            className="btn"
            onClick={openCreate}
            disabled={!canManage}
            title={canManage ? undefined : t("Tu rol no permite gestionar dispositivos")}
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden>
              <path d="M12 5v14M5 12h14" />
            </svg>
            <span>{t("Nuevo dispositivo")}</span>
          </button>
        </>
      )}
    >
      <section className={styles.kpis} aria-label={t("Resumen")}>
        <StatTile label={t("Dispositivos")} value={`${devices.length}`} detail={t("En inventario")} />
        <StatTile
          label={t("En línea")}
          marker={onlineCount ? <span className="live-dot" aria-hidden /> : <span className={styles.markerIdle} aria-hidden />}
          value={`${onlineCount}`}
          detail={t("Vistos en 10 minutos")}
        />
        <StatTile label={t("Asignados")} value={`${assignedCount}`} detail={t("Con empleado")} />
        <StatTile
          label={t("Revocados")}
          value={`${revokedCount}`}
          valueTone={revokedCount ? "warn" : "plain"}
          detail={t("Token inactivo")}
        />
      </section>

      {issuedToken && !createOpen && !controlOpen ? (
        <div className={styles.pageToken}>
          {tokenBox(issuedToken)}
        </div>
      ) : null}

      <section className={`toolbar ${styles.toolbar}`} aria-label={t("Filtros")}>
        {isSystemAdmin ? (
          <select
            aria-label={t("Empresa")}
            value={companyId}
            onChange={(event) => {
              const company = companies.find((item) => item.id === event.target.value);
              setActiveCompanyId(event.target.value, company?.name);
            }}
          >
            <option value="">{t("Selecciona empresa")}</option>
            {companies.map((company) => (
              <option key={company.id} value={company.id}>{company.name}</option>
            ))}
          </select>
        ) : null}
        <select aria-label={t("Estado")} value={statusFilter} onChange={(event) => setStatusFilter(event.target.value)}>
          <option value="">{t("Todos los estados")}</option>
          <option value="online">{t("En línea")}</option>
          <option value="offline">{t("Desconectados")}</option>
          <option value="revoked">{t("Revocados")}</option>
        </select>
        <span className={styles.count}>
          {devices.length} {devices.length === 1 ? t("equipo") : t("equipos")}
        </span>
      </section>

      {devices.length ? (
        <section className={styles.deviceGrid} aria-label={t("Inventario de dispositivos")}>
          {devices.map((device) => (
            <article
              key={device.id}
              className={`${styles.deviceCard} ${device.status === "online" ? styles.deviceOnline : ""} ${device.status === "revoked" ? styles.deviceRevoked : ""} ${controlOpen && device.id === selectedDeviceId ? styles.deviceSelected : ""}`}
            >
              <button
                type="button"
                className={styles.deviceMain}
                onClick={() => openControl(device)}
                aria-label={`${t("Control del equipo")} ${device.name}`}
              >
                <div className={styles.deviceTop}>
                  <div className={styles.cellMain}>
                    <strong>{device.name}</strong>
                    <small>
                      <span className={styles.mono}>{device.hostname || "-"}</span>
                      {device.location ? ` · ${device.location}` : ""}
                    </small>
                  </div>
                  {statusChip(device.status, t)}
                </div>

                <div className={styles.deviceFacts}>
                  <span>
                    {t("Empleado")}
                    <strong>{device.employee_id ? device.employee || device.employee_code || t("Sin asignar") : t("Sin asignar")}</strong>
                  </span>
                  <span>
                    {t("Versión")}
                    <strong className={styles.mono}>{device.agent_version || "unknown"}</strong>
                  </span>
                  <span title={dateText(device.last_seen_at, t)}>
                    {t("Última conexión")}
                    <strong>{relativeText(device.last_seen_at, language, t)}</strong>
                  </span>
                </div>
              </button>
              <div className={styles.deviceMenu}>
                <RowMenu
                  label={`${t("Acciones")} ${device.name}`}
                  items={[
                    { label: canManage ? t("Editar equipo") : t("Ver detalle"), onSelect: () => openControl(device) },
                    ...(canManage
                      ? [{ label: t("Rotar token"), onSelect: () => openControl(device, true), danger: true, separatorBefore: true }]
                      : []),
                  ]}
                />
              </div>
            </article>
          ))}
        </section>
      ) : (
        <EmptyBlock
          title={noCompany ? t("Selecciona una empresa para ver sus dispositivos") : loading ? t("Cargando dispositivos...") : t("No hay dispositivos para el filtro actual.")}
          description={
            noCompany || loading
              ? undefined
              : statusFilter
                ? t("Prueba con otro estado o quita el filtro.")
                : t("Registra un equipo para emitir su token e instalar el agente.")
          }
          action={
            !noCompany && !loading ? (
              statusFilter ? (
                <button type="button" className="btn btn-outline btn-sm" onClick={() => setStatusFilter("")}>
                  {t("Quitar filtro")}
                </button>
              ) : canManage ? (
                <button type="button" className="btn btn-sm" onClick={openCreate}>
                  {t("Nuevo dispositivo")}
                </button>
              ) : undefined
            ) : undefined
          }
        />
      )}

      <div style={{ marginTop: 12 }}>
        <StatusLine>{statusText}</StatusLine>
      </div>

      {/* --- Nuevo dispositivo --------------------------------------------- */}
      <Drawer
        open={createOpen}
        onClose={closeCreate}
        title={createDone ? t("Dispositivo creado") : t("Nuevo dispositivo")}
        description={`${t("Se registra en")} ${activeCompanyName}`}
        footer={
          createDone ? (
            <>
              <span className={styles.footStatus}><StatusLine>{statusText}</StatusLine></span>
              <button type="button" className="btn btn-outline" onClick={() => setCreateDone(false)}>
                {t("Crear otro")}
              </button>
              <button type="button" className="btn" onClick={closeCreate}>
                {t("Listo")}
              </button>
            </>
          ) : (
            <>
              <span className={styles.footStatus}><StatusLine>{statusText}</StatusLine></span>
              <button type="button" className="btn btn-ghost" onClick={closeCreate}>
                {t("Cancelar")}
              </button>
              <button type="submit" form="device-create-form" className="btn" disabled={!canManage || creating}>
                {creating ? t("Creando...") : t("Crear y emitir token")}
              </button>
            </>
          )
        }
      >
        {createDone && issuedToken?.kind === "create" ? (
          <>
            {tokenBox(issuedToken)}
            <p className={styles.note}>
              {t("Pega este token en el instalador del agente VYNTRA de la PC. Si lo pierdes, puedes rotarlo desde el control del equipo.")}
            </p>
          </>
        ) : (
          <form id="device-create-form" className={styles.form} onSubmit={createDevice}>
            <label>
              {t("Nombre del equipo")}
              <input value={name} onChange={(event) => setName(event.target.value)} placeholder="PC-OPERACIONES-01" required disabled={!canManage} />
            </label>
            <div className="field-row">
              <label>
                {t("Hostname")}
                <input value={hostname} onChange={(event) => setHostname(event.target.value)} placeholder={t("Opcional")} disabled={!canManage} />
              </label>
              <label>
                {t("Ubicacion")}
                <input value={location} onChange={(event) => setLocation(event.target.value)} placeholder={t("Sucursal / area")} disabled={!canManage} />
              </label>
            </div>
            <div className="field-row">
              <label>
                {t("Version agente")}
                <input value={agentVersion} onChange={(event) => setAgentVersion(event.target.value)} disabled={!canManage} />
              </label>
              <label>
                {t("Empleado")}
                <select value={employeeId} onChange={(event) => setEmployeeId(event.target.value)} disabled={!canManage}>
                  <option value="">{t("Sin asignar")}</option>
                  {employees.map((employee) => (
                    <option key={employee.id} value={employee.id}>{employee.full_name}</option>
                  ))}
                </select>
              </label>
            </div>
            <p className="field-hint">{t("Si dejas el hostname vacio se usa el nombre del equipo. El token se muestra una sola vez al crear.")}</p>
          </form>
        )}
      </Drawer>

      {/* --- Control del equipo -------------------------------------------- */}
      <Drawer
        open={controlOpen && Boolean(selectedDevice)}
        onClose={closeControl}
        title={t("Control del equipo")}
        description={selectedDevice ? `${selectedDevice.name} · ${selectedDevice.company}` : undefined}
        footer={(
          <>
            <span className={styles.footStatus}><StatusLine>{statusText}</StatusLine></span>
            <button type="button" className="btn btn-ghost" onClick={closeControl}>
              {t("Cerrar")}
            </button>
            {canManage ? (
              <button type="submit" form="device-edit-form" className="btn" disabled={!selectedDeviceId || saving}>
                {saving ? t("Guardando...") : t("Guardar equipo")}
              </button>
            ) : null}
          </>
        )}
      >
        {selectedDevice ? (
          <>
            <div className={styles.summary}>
              <div>
                <span>{t("Estado")}</span>
                <strong>{statusChip(selectedDevice.status, t)}</strong>
              </div>
              <div>
                <span>{t("Última conexión")}</span>
                <strong title={dateText(selectedDevice.last_seen_at, t)}>{relativeText(selectedDevice.last_seen_at, language, t)}</strong>
              </div>
              <div>
                <span>{t("Empleado")}</span>
                <strong>{selectedDevice.employee_id ? selectedDevice.employee || selectedDevice.employee_code : t("Sin asignar")}</strong>
              </div>
            </div>

            {issuedToken?.kind === "rotate" && issuedToken.deviceId === selectedDevice.id ? tokenBox(issuedToken) : null}

            <form id="device-edit-form" className={styles.form} onSubmit={saveDevice}>
              <div className="drawer-section">
                <h3>{t("Datos del equipo")}</h3>
                <div className="field-row">
                  <label>
                    {t("Nombre")}
                    <input value={editName} onChange={(event) => setEditName(event.target.value)} disabled={!canManage || !selectedDeviceId} />
                  </label>
                  <label>
                    {t("Hostname")}
                    <input value={editHostname} onChange={(event) => setEditHostname(event.target.value)} disabled={!canManage || !selectedDeviceId} />
                  </label>
                </div>
                <div className="field-row">
                  <label>
                    {t("Ubicacion")}
                    <input value={editLocation} onChange={(event) => setEditLocation(event.target.value)} disabled={!canManage || !selectedDeviceId} />
                  </label>
                  <label>
                    {t("Version")}
                    <input value={editAgentVersion} onChange={(event) => setEditAgentVersion(event.target.value)} disabled={!canManage || !selectedDeviceId} />
                  </label>
                </div>
                <label>
                  {t("Empleado")}
                  <select value={editEmployeeId} onChange={(event) => setEditEmployeeId(event.target.value)} disabled={!canManage || !selectedDeviceId}>
                    <option value="">{t("Sin asignar")}</option>
                    {employees.map((employee) => (
                      <option key={employee.id} value={employee.id}>{employee.full_name}</option>
                    ))}
                  </select>
                </label>
              </div>

              <div className="drawer-section">
                <h3>{t("Token")}</h3>
                <label className={styles.toggle}>
                  <input
                    type="checkbox"
                    checked={editActive}
                    onChange={(event) => setEditActive(event.target.checked)}
                    disabled={!canManage || !selectedDeviceId}
                  />
                  <span>
                    <strong>{t("Token activo")}</strong>
                    <small>{t("Si lo desactivas, el agente de esta PC deja de enviar datos hasta reactivarlo.")}</small>
                  </span>
                </label>
              </div>
            </form>

            {canManage ? (
              <section className={styles.danger} aria-labelledby="rotate-title">
                <h3 id="rotate-title">{t("Rotar token")}</h3>
                <p>{t("Emite un token nuevo e invalida el actual. Tendras que instalarlo en la PC.")}</p>
                <label>
                  {t("Motivo rotacion")}
                  <input
                    value={rotateReason}
                    onChange={(event) => setRotateReason(event.target.value)}
                    placeholder={t("Ej. reinstalacion o perdida de token")}
                    disabled={!selectedDeviceId}
                  />
                </label>
                {rotateConfirm ? (
                  <div className={styles.confirm} role="alert">
                    <span>
                      {t("El token actual de")} <strong>{selectedDevice.name}</strong> {t("dejara de funcionar de inmediato. ¿Continuar?")}
                    </span>
                    <div className={styles.confirmActions}>
                      <button type="button" className="btn btn-danger btn-sm" onClick={() => void rotateToken()} disabled={rotating}>
                        {rotating ? t("Rotando token...") : t("Si, rotar token")}
                      </button>
                      <button type="button" className="btn btn-ghost btn-sm" onClick={() => setRotateConfirm(false)} disabled={rotating}>
                        {t("Cancelar")}
                      </button>
                    </div>
                  </div>
                ) : (
                  <div>
                    <button type="button" className="btn btn-danger" onClick={() => setRotateConfirm(true)} disabled={!selectedDeviceId}>
                      {t("Rotar token")}
                    </button>
                  </div>
                )}
              </section>
            ) : null}
          </>
        ) : null}
      </Drawer>
    </AppShell>
  );
}
