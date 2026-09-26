"use client";

import { FormEvent, useCallback, useEffect, useMemo, useState } from "react";
import { AppShell } from "@/components/app-shell";
import { EmptyState, Panel, RefreshButton, StatCard, StatusLine } from "@/components/ui";
import { useAuth } from "@/components/auth-provider";
import { apiFetch } from "@/lib/api";
import { todayISO } from "@/lib/dates";
import { saveBlob } from "@/lib/download-file";
import { AuditLogEntry, AuditLogsResponse, SystemCompany, SystemOverviewResponse } from "@/lib/types";

function dateOnly(value: string | null) {
  if (!value) return "-";
  return new Date(value).toLocaleString("es-NI");
}

const AUDIT_PAGE_SIZE = 50;

function payloadText(payload: AuditLogEntry["payload"]) {
  if (!payload) return "{}";
  if (typeof payload === "string") return payload;
  return JSON.stringify(payload);
}

export default function AuditPage() {
  const { apiGet, token, activeCompanyId, setActiveCompanyId, user } = useAuth();
  const [logs, setLogs] = useState<AuditLogEntry[]>([]);
  const [companies, setCompanies] = useState<SystemCompany[]>([]);
  const [companyId, setCompanyId] = useState("");
  const [actor, setActor] = useState("");
  const [action, setAction] = useState("");
  const [entityType, setEntityType] = useState("");
  const [entityId, setEntityId] = useState("");
  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");
  const [limit, setLimit] = useState("200");
  const [statusText, setStatusText] = useState("");
  const [loading, setLoading] = useState(false);
  const [downloading, setDownloading] = useState(false);
  const [page, setPage] = useState(1);

  const isSystemAdmin = user?.role === "system_admin";
  const canReadAudit = isSystemAdmin && Boolean(user?.permissions?.includes("audit:read"));
  const actorsCount = useMemo(() => new Set(logs.map((log) => log.actor_email || log.actor).filter(Boolean)).size, [logs]);
  const actionsCount = useMemo(() => new Set(logs.map((log) => log.action).filter(Boolean)).size, [logs]);
  const companiesCount = useMemo(() => new Set(logs.map((log) => log.company || log.company_id).filter(Boolean)).size, [logs]);
  // La API puede devolver hasta 1000 filas: se paginan en el cliente para no renderizarlas todas.
  const pageCount = Math.max(1, Math.ceil(logs.length / AUDIT_PAGE_SIZE));
  const currentPage = Math.min(page, pageCount);
  const visibleLogs = useMemo(
    () => logs.slice((currentPage - 1) * AUDIT_PAGE_SIZE, currentPage * AUDIT_PAGE_SIZE),
    [currentPage, logs],
  );

  const queryString = useCallback(
    (exportMode: "json" | "csv" = "json") => {
      const params = new URLSearchParams();
      if (isSystemAdmin && companyId) params.set("company_id", companyId);
      if (actor.trim()) params.set("actor", actor.trim());
      if (action.trim()) params.set("action", action.trim());
      if (entityType.trim()) params.set("entity_type", entityType.trim());
      if (entityId.trim()) params.set("entity_id", entityId.trim());
      if (dateFrom) params.set("date_from", dateFrom);
      if (dateTo) params.set("date_to", dateTo);
      params.set("limit", String(Math.max(1, Math.min(Number(limit || 200), 1000))));
      params.set("export", exportMode);
      return params.toString();
    },
    [action, actor, companyId, dateFrom, dateTo, entityId, entityType, isSystemAdmin, limit],
  );

  const loadAudit = useCallback(async () => {
    if (!canReadAudit) return;
    setLoading(true);
    setStatusText("Cargando auditoria...");
    try {
      const response = await apiGet<AuditLogsResponse>(`/api/audit/logs?${queryString()}`);
      setLogs(response.items);
      setPage(1);
      setStatusText(`${response.count} eventos cargados`);
    } catch {
      setStatusText("No se pudo cargar la auditoria");
    } finally {
      setLoading(false);
    }
  }, [apiGet, canReadAudit, queryString]);

  const loadCompanies = useCallback(async () => {
    if (!isSystemAdmin) return;
    try {
      const response = await apiGet<SystemOverviewResponse>("/api/system/overview");
      setCompanies(response.companies);
    } catch {
      setCompanies([]);
    }
  }, [apiGet, isSystemAdmin]);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      void loadCompanies();
      void loadAudit();
    }, 0);
    return () => window.clearTimeout(timer);
  }, [loadAudit, loadCompanies]);

  useEffect(() => {
    if (!activeCompanyId) return;
    const timer = window.setTimeout(() => {
      setCompanyId(activeCompanyId);
    }, 0);
    return () => window.clearTimeout(timer);
  }, [activeCompanyId]);

  async function applyFilters(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    await loadAudit();
  }

  async function exportCsv() {
    if (!canReadAudit || !token) return;
    setDownloading(true);
    setStatusText("Preparando CSV...");
    try {
      const response = await apiFetch(`/api/audit/logs?${queryString("csv")}`, { token, timeoutMs: 120_000 });
      const blob = await response.blob();
      saveBlob(blob, `vyntra-auditoria-${todayISO()}.csv`);
      setStatusText("CSV exportado");
    } catch {
      setStatusText("No se pudo exportar el CSV");
    } finally {
      setDownloading(false);
    }
  }

  if (!isSystemAdmin) {
    return (
      <AppShell title="Auditoria" description="Trazabilidad de acciones sensibles">
        <Panel title="Acceso restringido">
          <EmptyState>Esta vista solo esta disponible para el administrador del sistema.</EmptyState>
        </Panel>
      </AppShell>
    );
  }

  return (
    <AppShell
      title="Auditoria"
      description={`${user?.company || "Sistema"} · acciones administrativas y eventos sensibles`}
      actions={<RefreshButton loading={loading} onClick={() => void loadAudit()} />}
    >
      <section className="settings-page audit-page">
        <div className="stats-grid">
          <StatCard label="Eventos" value={`${logs.length}`} detail="Resultado del filtro" />
          <StatCard label="Actores" value={`${actorsCount}`} detail="Usuarios detectados" />
          <StatCard label="Acciones" value={`${actionsCount}`} detail="Tipos auditados" />
          <StatCard label="Empresas" value={`${companiesCount}`} detail={isSystemAdmin ? "Alcance global" : "Tu empresa"} />
        </div>

        <Panel title="Filtros">
          <form className="audit-filter-grid" onSubmit={applyFilters}>
            {isSystemAdmin ? (
              <label>Empresa
                <select value={companyId} onChange={(event) => {
                  setCompanyId(event.target.value);
                  if (event.target.value) setActiveCompanyId(event.target.value);
                }}>
                  <option value="">Todas</option>
                  {companies.map((company) => (
                    <option key={company.id} value={company.id}>{company.name}</option>
                  ))}
                </select>
              </label>
            ) : null}
            <label>Actor
              <input value={actor} onChange={(event) => setActor(event.target.value)} placeholder="correo o nombre" />
            </label>
            <label>Accion
              <input value={action} onChange={(event) => setAction(event.target.value)} placeholder="incident_resolved" />
            </label>
            <label>Entidad
              <input value={entityType} onChange={(event) => setEntityType(event.target.value)} placeholder="user, shift, incident" />
            </label>
            <label>ID entidad
              <input value={entityId} onChange={(event) => setEntityId(event.target.value)} placeholder="UUID exacto" />
            </label>
            <label>Desde
              <input type="date" value={dateFrom} onChange={(event) => setDateFrom(event.target.value)} />
            </label>
            <label>Hasta
              <input type="date" value={dateTo} onChange={(event) => setDateTo(event.target.value)} />
            </label>
            <label>Limite
              <input type="number" min="1" max="1000" value={limit} onChange={(event) => setLimit(event.target.value)} />
            </label>
            <div className="audit-actions">
              <button type="submit" className="settings-primary-action">Aplicar filtros</button>
              <button type="button" className="secondary-button" onClick={() => void exportCsv()} disabled={downloading}>
                {downloading ? "Exportando..." : "Exportar CSV"}
              </button>
            </div>
          </form>
        </Panel>

        <StatusLine>{statusText}</StatusLine>

        <Panel title="Eventos auditados" meta={`${logs.length} registros`}>
          <div className="settings-table-shell audit-table-shell">
            <table>
              <thead>
                <tr>
                  <th>Fecha</th>
                  <th>Actor</th>
                  <th>Empresa</th>
                  <th>Accion</th>
                  <th>Entidad</th>
                  <th>IP</th>
                  <th>Payload</th>
                </tr>
              </thead>
              <tbody>
                {visibleLogs.map((log) => (
                  <tr key={log.id}>
                    <td>{dateOnly(log.created_at)}</td>
                    <td>
                      <strong>{log.actor || "Sistema"}</strong>
                      <small>{log.actor_email || log.user_id || "-"}</small>
                    </td>
                    <td>{log.company || "-"}</td>
                    <td><span className="audit-action-pill">{log.action}</span></td>
                    <td>
                      <strong>{log.entity_type || "-"}</strong>
                      <small>{log.entity_id || "-"}</small>
                    </td>
                    <td>{log.ip_address || "-"}</td>
                    <td><code className="audit-payload">{payloadText(log.payload)}</code></td>
                  </tr>
                ))}
              </tbody>
            </table>
            {!logs.length ? <EmptyState>No hay eventos para el filtro actual.</EmptyState> : null}
          </div>
          {pageCount > 1 ? (
            <div className="settings-pagination">
              <button type="button" disabled={currentPage <= 1} onClick={() => setPage(Math.max(1, currentPage - 1))}>
                Anterior
              </button>
              <span>{currentPage} / {pageCount}</span>
              <button type="button" disabled={currentPage >= pageCount} onClick={() => setPage(Math.min(pageCount, currentPage + 1))}>
                Siguiente
              </button>
            </div>
          ) : null}
        </Panel>
      </section>
    </AppShell>
  );
}
