"use client";

import { FormEvent, Fragment, KeyboardEvent, useCallback, useEffect, useMemo, useState } from "react";
import { AppShell } from "@/components/app-shell";
import { Chip, EmptyBlock, RefreshButton, StatusLine } from "@/components/ui";
import { useAuth } from "@/components/auth-provider";
import { usePreferences } from "@/components/preferences-provider";
import { apiFetch } from "@/lib/api";
import { todayISO } from "@/lib/dates";
import { saveBlob } from "@/lib/download-file";
import { AuditLogEntry, AuditLogsResponse, SystemCompany, SystemOverviewResponse } from "@/lib/types";
import styles from "./auditoria.module.css";

const AUDIT_PAGE_SIZE = 50;
const DEFAULT_LIMIT = "200";

type Tone = "plain" | "good" | "warn" | "bad" | "info";

function payloadPretty(payload: AuditLogEntry["payload"]) {
  if (!payload) return "{}";
  if (typeof payload === "string") {
    try {
      return JSON.stringify(JSON.parse(payload), null, 2);
    } catch {
      return payload;
    }
  }
  return JSON.stringify(payload, null, 2);
}

const actionLabels: Record<string, string> = {
  system_company_controls_updated: "Controles de empresa actualizados",
  device_token_rotated: "Token del equipo rotado",
  incident_resolved: "Incidencia resuelta",
  incident_approved: "Incidencia aprobada",
  incident_rejected: "Incidencia rechazada",
  employee_created: "Empleado creado",
  employee_updated: "Empleado actualizado",
  employee_archived: "Empleado eliminado",
  employee_restored: "Empleado restaurado",
  access_code_created: "Codigo de acceso generado",
  productivity_rule_created: "Regla productiva creada",
  productivity_rule_updated: "Regla productiva actualizada",
  audit_exported: "Auditoria exportada",
};

const entityLabels: Record<string, string> = {
  company: "Empresa",
  device: "Equipo",
  employee: "Empleado",
  incident: "Incidencia",
  user: "Usuario",
  shift: "Jornada",
  access_code: "Codigo de acceso",
  productivity_rule: "Regla productiva",
};

const payloadLabels: Record<string, string> = {
  reason: "Motivo",
  employee_limit: "Limite de empleados",
  hostname: "Equipo",
  status: "Estado",
  role: "Rol",
  email: "Correo",
  full_name: "Nombre",
  company_id: "Empresa",
  device_id: "Equipo",
  employee_id: "Empleado",
  resolution_notes: "Nota de resolucion",
};

function humanizeCode(value: string) {
  return value
    .replace(/_/g, " ")
    .replace(/\b\w/g, (char) => char.toUpperCase());
}

function actionLabel(action: string, t: (text: string) => string) {
  return t(actionLabels[action] || humanizeCode(action || "Evento"));
}

function entityLabel(entity: string, t: (text: string) => string) {
  return t(entityLabels[entity] || humanizeCode(entity || "Entidad"));
}

function payloadRecord(payload: AuditLogEntry["payload"]): Record<string, unknown> {
  if (!payload) return {};
  if (typeof payload === "string") {
    try {
      const parsed = JSON.parse(payload);
      return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : { valor: payload };
    } catch {
      return { valor: payload };
    }
  }
  if (Array.isArray(payload)) return { elementos: payload.length };
  return payload;
}

function formatPayloadValue(value: unknown) {
  if (value === null || value === undefined || value === "") return "-";
  if (typeof value === "boolean") return value ? "Si" : "No";
  if (typeof value === "number") return String(value);
  if (typeof value === "string") return value;
  return JSON.stringify(value);
}

function payloadSummary(payload: AuditLogEntry["payload"]) {
  return Object.entries(payloadRecord(payload)).slice(0, 4);
}

/** Tono del chip segun el tipo de accion auditada. */
function actionTone(action: string): Tone {
  const value = action.toLowerCase();
  if (/(delet|archiv|revok|denied|fail|suspend|remov|block)/.test(value)) return "bad";
  if (/(reset|rotat|password|expir)/.test(value)) return "warn";
  if (/(creat|restor|resolv|approv|activat)/.test(value)) return "good";
  if (/(export|download|view|read)/.test(value)) return "info";
  return "plain";
}

function fill(text: string, values: Record<string, string | number>) {
  return text.replace(/\{(\w+)\}/g, (_, key: string) => String(values[key] ?? ""));
}

const icons = {
  search: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden>
      <circle cx="11" cy="11" r="6.5" />
      <path d="m16 16 4 4" />
    </svg>
  ),
  download: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M12 4v11M7 10l5 5 5-5M5 19h14" />
    </svg>
  ),
  filter: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden>
      <path d="M4 7h16M7 12h10M10 17h4" />
    </svg>
  ),
  chevron: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="m9 6 6 6-6 6" />
    </svg>
  ),
};

export default function AuditPage() {
  const { apiGet, token, activeCompanyId, setActiveCompanyId, user } = useAuth();
  const { t, language } = usePreferences();
  const locale = language === "en" ? "en-US" : "es-NI";
  const [logs, setLogs] = useState<AuditLogEntry[]>([]);
  const [companies, setCompanies] = useState<SystemCompany[]>([]);
  const [companyId, setCompanyId] = useState("");
  const [actor, setActor] = useState("");
  const [action, setAction] = useState("");
  const [entityType, setEntityType] = useState("");
  const [entityId, setEntityId] = useState("");
  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");
  const [limit, setLimit] = useState(DEFAULT_LIMIT);
  const [statusText, setStatusText] = useState("");
  const [loading, setLoading] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [downloading, setDownloading] = useState(false);
  const [page, setPage] = useState(1);
  const [moreFilters, setMoreFilters] = useState(false);
  const [expandedId, setExpandedId] = useState("");

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
  const extraFilters = [entityType.trim(), entityId.trim(), limit !== DEFAULT_LIMIT ? limit : ""].filter(Boolean).length;
  const anyFilter = Boolean(companyId || actor.trim() || action.trim() || dateFrom || dateTo || extraFilters);

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
      setExpandedId("");
      setStatusText(`${response.count} ${t("eventos cargados")}`);
    } catch {
      setStatusText("No se pudo cargar la auditoria");
    } finally {
      setLoading(false);
      setLoaded(true);
    }
  }, [apiGet, canReadAudit, queryString, t]);

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

  function clearFilters() {
    setCompanyId("");
    setActor("");
    setAction("");
    setEntityType("");
    setEntityId("");
    setDateFrom("");
    setDateTo("");
    setLimit(DEFAULT_LIMIT);
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

  function toggleRow(id: string) {
    setExpandedId((current) => (current === id ? "" : id));
  }

  function onRowKey(event: KeyboardEvent<HTMLTableRowElement>, id: string) {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      toggleRow(id);
    }
  }

  function formatWhen(value: string | null) {
    if (!value) return { date: "-", time: "" };
    const date = new Date(value);
    if (!Number.isFinite(date.getTime())) return { date: value, time: "" };
    return {
      date: date.toLocaleDateString(locale, { day: "numeric", month: "short", year: "numeric" }),
      time: date.toLocaleTimeString(locale, { hour: "2-digit", minute: "2-digit", second: "2-digit" }),
    };
  }

  if (!isSystemAdmin) {
    return (
      <AppShell title={t("Auditoría")} description={t("Trazabilidad de acciones sensibles")}>
        <EmptyBlock
          title={t("Acceso restringido")}
          description={t("Esta vista solo esta disponible para el administrador del sistema.")}
        />
      </AppShell>
    );
  }

  const firstRow = logs.length ? (currentPage - 1) * AUDIT_PAGE_SIZE + 1 : 0;
  const lastRow = Math.min(currentPage * AUDIT_PAGE_SIZE, logs.length);
  const auditScopeName = companies.find((company) => company.id === companyId)?.name || (companyId ? t("Empresa") : t("Sistema"));

  return (
    <AppShell
      title={t("Auditoría")}
      description={`${auditScopeName} · ${t("acciones administrativas y eventos sensibles")}`}
      status={statusText}
      actions={
        <>
          <RefreshButton loading={loading} onClick={() => void loadAudit()} />
          <button type="button" className="btn btn-outline" onClick={() => void exportCsv()} disabled={downloading}>
            {icons.download}
            <span>{downloading ? t("Exportando...") : t("Exportar CSV")}</span>
          </button>
        </>
      }
    >
      <section className={styles.card} aria-labelledby="audit-title">
        <header className={styles.cardHead}>
          <div className={styles.cardTitle}>
            <h2 id="audit-title">{t("Eventos auditados")}</h2>
            <span>
              {fill(t("{events} eventos · {actors} actores · {actions} tipos de acción · {companies} empresas"), {
                events: logs.length,
                actors: actorsCount,
                actions: actionsCount,
                companies: companiesCount,
              })}
            </span>
          </div>
        </header>

        <form className={styles.filters} onSubmit={applyFilters} aria-label={t("Filtros")}>
          <div className="toolbar">
            <div className={`search-input ${styles.search}`}>
              {icons.search}
              <input
                type="search"
                value={actor}
                onChange={(event) => setActor(event.target.value)}
                placeholder={t("Buscar actor")}
                title={t("Correo o nombre del actor")}
                aria-label={t("Actor")}
              />
            </div>
            <input
              className={styles.action}
              value={action}
              onChange={(event) => setAction(event.target.value)}
              placeholder={t("Código de acción")}
              title={t("Ej. incident_resolved")}
              aria-label={t("Accion")}
            />
            {isSystemAdmin ? (
              <select
                className={styles.company}
                value={companyId}
                aria-label={t("Empresa")}
                onChange={(event) => {
                  setCompanyId(event.target.value);
                  const company = companies.find((row) => row.id === event.target.value);
                  if (company) setActiveCompanyId(company.id, company.name);
                }}
              >
                <option value="">{t("Todas las empresas")}</option>
                {companies.map((company) => (
                  <option key={company.id} value={company.id}>
                    {company.name}
                  </option>
                ))}
              </select>
            ) : null}
            <div className={styles.range}>
              <input type="date" value={dateFrom} onChange={(event) => setDateFrom(event.target.value)} aria-label={t("Desde")} title={t("Desde")} />
              <span aria-hidden>–</span>
              <input type="date" value={dateTo} onChange={(event) => setDateTo(event.target.value)} aria-label={t("Hasta")} title={t("Hasta")} />
            </div>
            <button
              type="button"
              className="btn btn-ghost"
              aria-expanded={moreFilters}
              aria-controls="audit-more-filters"
              onClick={() => setMoreFilters((value) => !value)}
            >
              {icons.filter}
              <span>
                {t("Más filtros")}
                {extraFilters ? ` (${extraFilters})` : ""}
              </span>
            </button>
            <span className="grow" />
            {anyFilter ? (
              <button type="button" className="btn btn-ghost" onClick={clearFilters}>
                {t("Limpiar")}
              </button>
            ) : null}
            <button type="submit" className="btn" title={t("Aplicar filtros")}>
              {t("Aplicar")}
            </button>
          </div>

          {moreFilters ? (
            <div id="audit-more-filters" className={styles.more}>
              <label className={styles.field}>
                <span>{t("Entidad")}</span>
                <input value={entityType} onChange={(event) => setEntityType(event.target.value)} placeholder="user, shift, incident" />
              </label>
              <label className={styles.field}>
                <span>{t("ID entidad")}</span>
                <input value={entityId} onChange={(event) => setEntityId(event.target.value)} placeholder={t("UUID exacto")} />
              </label>
              <label className={styles.field}>
                <span>{t("Límite de filas")}</span>
                <input type="number" min="1" max="1000" value={limit} onChange={(event) => setLimit(event.target.value)} />
                <small className="field-hint">{t("Máximo 1000")}</small>
              </label>
            </div>
          ) : null}
        </form>

        {!logs.length ? (
          <div className={styles.emptyWrap}>
            {loaded ? (
              <EmptyBlock
                title={t("Sin eventos")}
                description={t("No hay eventos para el filtro actual.")}
                action={
                  anyFilter ? (
                    <button type="button" className="btn btn-outline btn-sm" onClick={clearFilters}>
                      {t("Limpiar filtros")}
                    </button>
                  ) : undefined
                }
              />
            ) : (
              <p className={styles.loadingText}>{t("Cargando auditoria...")}</p>
            )}
          </div>
        ) : (
          <div className={styles.tableWrap}>
            <table className={styles.table}>
              <thead>
                <tr>
                  <th>{t("Fecha")}</th>
                  <th>{t("Actor")}</th>
                  <th>{t("Empresa")}</th>
                  <th>{t("Acción")}</th>
                  <th>{t("Entidad")}</th>
                  <th>{t("IP")}</th>
                  <th>{t("Detalle")}</th>
                </tr>
              </thead>
              <tbody>
                {visibleLogs.map((log) => {
                  const when = formatWhen(log.created_at);
                  const expanded = expandedId === log.id;
                  return (
                    <Fragment key={log.id}>
                      <tr
                        className={expanded ? styles.expandedRow : undefined}
                        onClick={() => toggleRow(log.id)}
                        onKeyDown={(event) => onRowKey(event, log.id)}
                        tabIndex={0}
                        aria-expanded={expanded}
                      >
                        <td>
                          <div className={styles.stack}>
                            <span>{when.date}</span>
                            <small>{when.time}</small>
                          </div>
                        </td>
                        <td>
                          <div className={styles.stack}>
                            <strong>{log.actor || t("Sistema")}</strong>
                            <small>{log.actor_email || log.user_id || "-"}</small>
                          </div>
                        </td>
                        <td>{log.company || "-"}</td>
                        <td>
                          <Chip tone={actionTone(log.action)} dot={false}>
                            {actionLabel(log.action, t)}
                          </Chip>
                          <small className={`${styles.code} ${styles.mutedLine}`}>{log.action}</small>
                        </td>
                        <td>
                          <div className={styles.stack}>
                            <span>{entityLabel(log.entity_type, t)}</span>
                            <small className={styles.code}>{log.entity_id || "-"}</small>
                          </div>
                        </td>
                        <td className={styles.code}>{log.ip_address || "-"}</td>
                        <td className={styles.payloadCell}>
                          <span className={`${styles.chevron} ${expanded ? styles.chevronOpen : ""}`}>{icons.chevron}</span>
                          <span className={styles.payload}>
                            {payloadSummary(log.payload).map(([key, value]) => `${t(payloadLabels[key] || humanizeCode(key))}: ${formatPayloadValue(value)}`).join(" · ") || t("Sin detalle")}
                          </span>
                        </td>
                      </tr>
                      {expanded ? (
                        <tr className={styles.detailRow}>
                          <td colSpan={7}>
                            <div className={styles.detailGrid}>
                              {payloadSummary(log.payload).length ? payloadSummary(log.payload).map(([key, value]) => (
                                <div key={key}>
                                  <dt>{t(payloadLabels[key] || humanizeCode(key))}</dt>
                                  <dd>{formatPayloadValue(value)}</dd>
                                </div>
                              )) : (
                                <div>
                                  <dt>{t("Detalle")}</dt>
                                  <dd>{t("Sin cambios registrados")}</dd>
                                </div>
                              )}
                            </div>
                            <details className={styles.technical}>
                              <summary>{t("Ver dato tecnico")}</summary>
                              <pre className={styles.pre}>{payloadPretty(log.payload)}</pre>
                            </details>
                          </td>
                        </tr>
                      ) : null}
                    </Fragment>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}

        <footer className={styles.cardFoot}>
          <StatusLine>{t(statusText)}</StatusLine>
          {logs.length ? (
            <div className={styles.pager}>
              <span>{fill(t("{from}–{to} de {total}"), { from: firstRow, to: lastRow, total: logs.length })}</span>
              {pageCount > 1 ? (
                <>
                  <button
                    type="button"
                    className="btn btn-outline btn-sm"
                    disabled={currentPage <= 1}
                    onClick={() => setPage(Math.max(1, currentPage - 1))}
                  >
                    {t("Anterior")}
                  </button>
                  <span>
                    {currentPage} / {pageCount}
                  </span>
                  <button
                    type="button"
                    className="btn btn-outline btn-sm"
                    disabled={currentPage >= pageCount}
                    onClick={() => setPage(Math.min(pageCount, currentPage + 1))}
                  >
                    {t("Siguiente")}
                  </button>
                </>
              ) : null}
            </div>
          ) : null}
        </footer>
      </section>
    </AppShell>
  );
}
