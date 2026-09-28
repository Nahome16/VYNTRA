"use client";

import { FormEvent, useCallback, useEffect, useId, useMemo, useState } from "react";
import { Chip, Drawer, EmptyBlock, RefreshButton, StatusLine } from "@/components/ui";
import { useAuth } from "@/components/auth-provider";
import { usePreferences } from "@/components/preferences-provider";
import { Incident, IncidentStatus } from "@/lib/types";
import { formatDuration } from "@/lib/format";
import styles from "./incidents-panel.module.css";

type IncidentResponse = {
  company: { id: string; name: string };
  count: number;
  incidents: Incident[];
};

const statusLabels: Record<IncidentStatus, string> = {
  pending: "Pendiente",
  approved: "Aprobada",
  rejected: "Rechazada",
  closed: "Cerrada",
};

const statusTone: Record<IncidentStatus, "plain" | "good" | "warn" | "bad"> = {
  pending: "warn",
  approved: "good",
  rejected: "bad",
  closed: "plain",
};

const incidentTypeLabels: Record<string, string> = {
  correccion_marcaje: "Correccion de marcaje",
  permiso_vacaciones: "Permiso o vacaciones",
  tiempo_perdido: "Falla tecnica",
  system_lost_time: "Falla tecnica",
  general: "Incidencia",
};

const statusFilters: Array<{ value: "" | IncidentStatus; label: string }> = [
  { value: "pending", label: "Pendientes" },
  { value: "approved", label: "Aprobadas" },
  { value: "rejected", label: "Rechazadas" },
  { value: "closed", label: "Cerradas" },
  { value: "", label: "Todos" },
];

const resolutionOptions: Array<{ value: IncidentStatus; label: string }> = [
  { value: "approved", label: "Aprobar" },
  { value: "rejected", label: "Rechazar" },
  { value: "closed", label: "Cerrar sin ajuste" },
];

function formatDateTime(value: string | null) {
  if (!value) return "-";
  return new Date(value).toLocaleString("es-NI", {
    dateStyle: "medium",
    timeStyle: "short",
  });
}

function typeLabel(value: string, t: (text: string) => string) {
  return t(incidentTypeLabels[value] || value || "Incidencia");
}

/** El payload puede faltar en incidencias antiguas; se trata como objeto vacio. */
function payloadOf(incident: Incident): Record<string, unknown> {
  return incident.payload && typeof incident.payload === "object" ? incident.payload : {};
}

function payloadValue(payload: Record<string, unknown>, key: string) {
  const value = payload[key];
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return "";
}

function evidenceRows(incident: Incident) {
  const evidence = payloadOf(incident).evidencia_tecnica;
  if (!evidence || typeof evidence !== "object" || Array.isArray(evidence)) return [];
  const source = evidence as Record<string, unknown>;
  const rows: Array<[string, unknown]> = [
    ["Periodo sugerido", source.periodo_sugerido],
    ["Minutos estimados", source.minutos_estimados],
    ["App activa", source.app_activa],
    ["Ventana activa", source.ventana_activa],
    ["Estado de jornada", source.estado_jornada],
    ["Ultima captura", source.ultima_captura_txt],
    ["Sincronizacion", source.sincronizacion],
    ["Equipo", source.equipo],
  ];
  return rows.filter(([, value]) => value !== null && value !== undefined && value !== "");
}

function suggestedAdjustmentSeconds(incident: Incident) {
  if (incident.time_adjustment?.seconds) return incident.time_adjustment.seconds;
  const payload = payloadOf(incident);
  const evidence = payload.evidencia_tecnica;
  const source = evidence && typeof evidence === "object" && !Array.isArray(evidence)
    ? evidence as Record<string, unknown>
    : {};
  const minutes = Number(source.minutos_estimados || payload.minutos_estimados || 0);
  if (Number.isFinite(minutes) && minutes > 0) return Math.max(60, Math.round(minutes * 60));
  return 15 * 60;
}

function resolutionImpactText(incident: Incident, status: IncidentStatus, t: (text: string) => string) {
  const duration = formatDuration(suggestedAdjustmentSeconds(incident));
  if (status === "approved") {
    return `${t("Se agregaran")} ${duration} ${t("como tiempo justificado neutral en productividad y asistencia.")}`;
  }
  if (incident.time_adjustment) {
    return t("El ajuste de tiempo asociado quedara anulado y dejara de contar en los reportes.");
  }
  return t("No se creara ajuste de tiempo y la incidencia quedara sin impacto en productividad.");
}

function defaultResolutionStatus(incident: Incident): IncidentStatus {
  return incident.status === "pending" ? "approved" : incident.status;
}

export function IncidentsPanel({ active = true }: { active?: boolean }) {
  const { apiGet, apiPatch, user } = useAuth();
  const { t } = usePreferences();
  const formId = useId();
  const [incidents, setIncidents] = useState<Incident[]>([]);
  const [selectedIncidentId, setSelectedIncidentId] = useState("");
  const [reviewOpen, setReviewOpen] = useState(false);
  const [statusFilter, setStatusFilter] = useState<"" | IncidentStatus>("pending");
  const [search, setSearch] = useState("");
  const [resolutionStatus, setResolutionStatus] = useState<IncidentStatus>("approved");
  const [resolutionNotes, setResolutionNotes] = useState("");
  const [confirmResolution, setConfirmResolution] = useState(false);
  const [statusText, setStatusText] = useState("");
  const [loading, setLoading] = useState(false);
  const canResolveIncidents = Boolean(user?.permissions.includes("incidents:resolve"));

  const loadIncidents = useCallback(async () => {
    setLoading(true);
    setStatusText(t("Actualizando incidencias..."));
    const params = new URLSearchParams();
    if (statusFilter) params.set("status_filter", statusFilter);
    try {
      const response = await apiGet<IncidentResponse>(
        `/api/incidents${params.toString() ? `?${params.toString()}` : ""}`,
      );
      setIncidents(response.incidents);
      setStatusText(t("Incidencias actualizadas"));
      const firstIncident = response.incidents[0] || null;
      setSelectedIncidentId(firstIncident?.id || "");
      setResolutionStatus(firstIncident ? defaultResolutionStatus(firstIncident) : "approved");
      setResolutionNotes(firstIncident?.resolution_notes || "");
      setReviewOpen(false);
    } catch {
      setStatusText(t("No se pudieron cargar las incidencias"));
    } finally {
      setLoading(false);
    }
  }, [apiGet, statusFilter, t]);

  useEffect(() => {
    if (!user || !active) return;
    const timer = window.setTimeout(() => {
      void loadIncidents();
    }, 0);
    return () => window.clearTimeout(timer);
  }, [active, loadIncidents, user]);

  const selectedIncident = useMemo(
    () => incidents.find((incident) => incident.id === selectedIncidentId) || incidents[0] || null,
    [incidents, selectedIncidentId],
  );

  const filteredIncidents = useMemo(() => {
    const needle = search.trim().toLowerCase();
    if (!needle) return incidents;
    return incidents.filter((incident) =>
      [
        incident.employee,
        incident.employee_code,
        incident.device,
        incident.title,
        incident.description,
        incident.incident_type,
        payloadValue(payloadOf(incident), "problema"),
      ]
        .join(" ")
        .toLowerCase()
        .includes(needle),
    );
  }, [incidents, search]);

  const stats = useMemo(() => {
    const all = incidents.length;
    const pending = incidents.filter((incident) => incident.status === "pending").length;
    const approved = incidents.filter((incident) => incident.status === "approved").length;
    const rejected = incidents.filter((incident) => incident.status === "rejected").length;
    return { all, pending, approved, rejected };
  }, [incidents]);

  function selectIncident(incident: Incident) {
    setSelectedIncidentId(incident.id);
    setResolutionStatus(defaultResolutionStatus(incident));
    setResolutionNotes(incident.resolution_notes || "");
    setConfirmResolution(false);
    setReviewOpen(true);
  }

  async function resolveIncident(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!selectedIncident) return;
    if (resolutionNotes.trim().length < 4) {
      setStatusText(t("Agrega una nota breve de resolucion"));
      return;
    }
    if (!confirmResolution) {
      setConfirmResolution(true);
      setStatusText(t("Confirma el impacto antes de guardar"));
      return;
    }
    setStatusText(t("Guardando resolucion..."));
    try {
      const response = await apiPatch<{ incident: Incident }>(`/api/incidents/${selectedIncident.id}`, {
        status: resolutionStatus,
        resolution_notes: resolutionNotes,
      });
      const nextIncidents = incidents
        .map((incident) => (incident.id === response.incident.id ? response.incident : incident))
        .filter((incident) => !statusFilter || incident.status === statusFilter);
      setIncidents(nextIncidents);
      const stillListed = nextIncidents.some((incident) => incident.id === response.incident.id);
      const nextSelection = nextIncidents.find((incident) => incident.id === response.incident.id) || nextIncidents[0] || null;
      setSelectedIncidentId(nextSelection?.id || "");
      setResolutionStatus(nextSelection ? defaultResolutionStatus(nextSelection) : "approved");
      setResolutionNotes(nextSelection?.resolution_notes || "");
      setConfirmResolution(false);
      // Si la incidencia sale del filtro actual (p. ej. deja de estar pendiente) se cierra la revision.
      if (!stillListed) setReviewOpen(false);
      setStatusText(t("Incidencia actualizada"));
    } catch (error) {
      const status = (error as { status?: number }).status;
      setStatusText(status === 403 ? t("Tu usuario no tiene permiso para resolver incidencias") : t("No se pudo guardar la resolucion"));
    }
  }

  const evidence = selectedIncident ? evidenceRows(selectedIncident) : [];
  const drawerOpen = reviewOpen && Boolean(selectedIncident);

  return (
    <div className={styles.root}>
      <section className={styles.metrics} aria-label={t("Resumen de incidencias")}>
        <div>
          <span>{t("En filtro")}</span>
          <strong>{stats.all}</strong>
          <small>{t("Incidencias cargadas")}</small>
        </div>
        <div>
          <span><i className={styles.dotWarn} aria-hidden />{t("Pendientes")}</span>
          <strong className={stats.pending ? styles.valueWarn : ""}>{stats.pending}</strong>
          <small>{t("Requieren revision")}</small>
        </div>
        <div>
          <span><i className={styles.dotGood} aria-hidden />{t("Aprobadas")}</span>
          <strong>{stats.approved}</strong>
          <small>{t("Validado por RR. HH.")}</small>
        </div>
        <div>
          <span><i className={styles.dotBad} aria-hidden />{t("Rechazadas")}</span>
          <strong className={stats.rejected ? styles.valueBad : ""}>{stats.rejected}</strong>
          <small>{t("No proceden")}</small>
        </div>
      </section>

      <div className="toolbar">
        <div className="segmented" role="group" aria-label={t("Estado")}>
          {statusFilters.map((option) => (
            <button
              key={option.value || "all"}
              type="button"
              aria-pressed={statusFilter === option.value}
              onClick={() => setStatusFilter(option.value)}
            >
              {t(option.label)}
            </button>
          ))}
        </div>
        <div className={`search-input ${styles.search}`}>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden>
            <circle cx="11" cy="11" r="7" />
            <path d="m20 20-3.5-3.5" />
          </svg>
          <input
            type="search"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder={t("Empleado, equipo, tipo o descripcion")}
            aria-label={t("Buscar")}
          />
        </div>
        <span className="grow" />
        <RefreshButton loading={loading} onClick={() => void loadIncidents()} />
      </div>

      <section className={styles.card}>
        <header className={styles.cardHead}>
          <h2>{t("Bandeja de incidencias")}</h2>
          <span>{filteredIncidents.length} {t("resultados")}</span>
        </header>
        {filteredIncidents.length ? (
          <div className={styles.tableWrap}>
            <table className={styles.table}>
              <thead>
                <tr>
                  <th>{t("Empleado")}</th>
                  <th>{t("Tipo")}</th>
                  <th>{t("Estado")}</th>
                  <th>{t("Fecha")}</th>
                  <th>{t("Impacto")}</th>
                  <th aria-label={t("Acciones")} />
                </tr>
              </thead>
              <tbody>
                {filteredIncidents.map((incident) => {
                  const isSelected = drawerOpen && selectedIncident?.id === incident.id;
                  return (
                    <tr className={isSelected ? "selected-row" : ""} key={incident.id} onClick={() => selectIncident(incident)}>
                      <td>
                        <div className={styles.stack}>
                          <strong>{incident.employee || t("Sin empleado")}</strong>
                          <small>{incident.employee_code || incident.device || t("Sin referencia")}</small>
                        </div>
                      </td>
                      <td>
                        <div className={styles.stack}>
                          <Chip tone="plain" dot={false}>{typeLabel(incident.incident_type, t)}</Chip>
                          {incident.title ? <small>{incident.title}</small> : null}
                        </div>
                      </td>
                      <td>
                        <Chip tone={statusTone[incident.status] || "plain"}>
                          {t(statusLabels[incident.status] || incident.status)}
                        </Chip>
                      </td>
                      <td className="tabular">{formatDateTime(incident.requested_at)}</td>
                      <td>
                        {incident.time_adjustment ? (
                          <span className={incident.time_adjustment.status === "active" ? styles.impactOn : styles.impactOff}>
                            {formatDuration(incident.time_adjustment.seconds)} · {incident.time_adjustment.status === "active" ? t("Activo neutral") : t("Anulado")}
                          </span>
                        ) : (
                          <span className={styles.muted}>—</span>
                        )}
                      </td>
                      <td className={styles.actionCol}>
                        <button
                          className="btn btn-outline btn-sm"
                          type="button"
                          onClick={(event) => {
                            event.stopPropagation();
                            selectIncident(incident);
                          }}
                          aria-label={`${t("Revisar incidencia de")} ${incident.employee || t("Sin empleado")}`}
                          aria-pressed={isSelected}
                        >
                          {t("Revisar")}
                        </button>
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
              title={t("No hay incidencias para el filtro actual.")}
              description={t("Las solicitudes de los empleados apareceran aqui para su revision.")}
              action={
                statusFilter || search ? (
                  <button
                    type="button"
                    className="btn btn-outline btn-sm"
                    onClick={() => {
                      setSearch("");
                      setStatusFilter("");
                    }}
                  >
                    {t("Ver todas")}
                  </button>
                ) : undefined
              }
            />
          </div>
        )}
      </section>

      <StatusLine>{statusText}</StatusLine>

      <Drawer
        open={drawerOpen}
        wide
        title={selectedIncident ? selectedIncident.title || typeLabel(selectedIncident.incident_type, t) : t("Revision")}
        description={
          selectedIncident
            ? `${typeLabel(selectedIncident.incident_type, t)} · ${selectedIncident.employee || t("Sin empleado")}`
            : t("Selecciona una incidencia para revisar.")
        }
        onClose={() => setReviewOpen(false)}
        footer={
          <>
            <div className={styles.footStatus}><StatusLine>{statusText}</StatusLine></div>
            <button type="button" className="btn btn-outline" onClick={() => setReviewOpen(false)}>
              {canResolveIncidents ? t("Cancelar") : t("Cerrar")}
            </button>
            {canResolveIncidents ? (
              <button className="btn" type="submit" form={formId} disabled={loading}>
                {confirmResolution ? t("Confirmar y guardar") : t("Revisar impacto")}
              </button>
            ) : null}
          </>
        }
      >
        {selectedIncident ? (
          <>
            <div className={styles.reviewHead}>
              <Chip tone={statusTone[selectedIncident.status] || "plain"}>
                {t(statusLabels[selectedIncident.status] || selectedIncident.status)}
              </Chip>
              <p>{selectedIncident.description || payloadValue(payloadOf(selectedIncident), "motivo") || t("Sin descripcion")}</p>
            </div>

            <dl className={styles.facts}>
              <div><dt>{t("Empleado")}</dt><dd>{selectedIncident.employee || "-"}</dd></div>
              <div><dt>{t("Equipo")}</dt><dd>{selectedIncident.device || "-"}</dd></div>
              <div><dt>{t("Solicitada")}</dt><dd>{formatDateTime(selectedIncident.requested_at)}</dd></div>
              <div><dt>{t("Problema")}</dt><dd>{payloadValue(payloadOf(selectedIncident), "problema") || typeLabel(selectedIncident.incident_type, t)}</dd></div>
              {selectedIncident.time_adjustment ? (
                <>
                  <div><dt>{t("Tiempo justificado")}</dt><dd>{formatDuration(selectedIncident.time_adjustment.seconds)}</dd></div>
                  <div><dt>{t("Impacto")}</dt><dd>{selectedIncident.time_adjustment.status === "active" ? t("Activo neutral") : t("Anulado")}</dd></div>
                </>
              ) : null}
            </dl>

            {evidence.length ? (
              <section className="drawer-section">
                <h3>{t("Evidencia tecnica")}</h3>
                <dl className={styles.evidence}>
                  {evidence.map(([label, value]) => (
                    <div key={label}>
                      <dt>{t(label)}</dt>
                      <dd>{String(value)}</dd>
                    </div>
                  ))}
                </dl>
              </section>
            ) : null}

            {canResolveIncidents ? (
              <form id={formId} className={`drawer-section ${styles.form}`} onSubmit={resolveIncident}>
                <h3>{t("Resolucion")}</h3>
                <div className="segmented" role="group" aria-label={t("Resolucion")}>
                  {resolutionOptions.map((option) => (
                    <button
                      key={option.value}
                      type="button"
                      aria-pressed={resolutionStatus === option.value}
                      onClick={() => {
                        setResolutionStatus(option.value);
                        setConfirmResolution(false);
                      }}
                    >
                      {t(option.label)}
                    </button>
                  ))}
                </div>
                <label>
                  {t("Nota")}
                  <textarea
                    value={resolutionNotes}
                    onChange={(event) => {
                      setResolutionNotes(event.target.value);
                      setConfirmResolution(false);
                    }}
                    placeholder={t("Resultado de la revision")}
                    rows={4}
                  />
                </label>
                <section className={`${styles.impact} ${styles[`impact_${resolutionStatus}`] || ""}`}>
                  <span>{t("Impacto previsto")}</span>
                  <strong>{resolutionImpactText(selectedIncident, resolutionStatus, t)}</strong>
                  <small>
                    {resolutionStatus === "approved"
                      ? t("El ajuste aparecera como neutral justificado, no como productividad artificial.")
                      : t("La decision quedara auditada con la nota de revision.")}
                  </small>
                </section>
                {confirmResolution ? (
                  <div className={styles.confirm} role="alert">
                    <strong>{t("Confirmar decision")}</strong>
                    <span>{t("Revisa que la nota y el impacto previsto sean correctos.")}</span>
                  </div>
                ) : null}
              </form>
            ) : (
              <section className={`${styles.impact} ${styles.impact_closed}`}>
                <span>{t("Modo lectura")}</span>
                <strong>{t("Tu usuario puede revisar incidencias, pero no resolverlas.")}</strong>
                <small>{t("Solicita a RR. HH. o a un administrador que apruebe, rechace o cierre esta incidencia.")}</small>
              </section>
            )}
          </>
        ) : null}
      </Drawer>
    </div>
  );
}
