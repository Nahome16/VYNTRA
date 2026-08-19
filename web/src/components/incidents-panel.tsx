"use client";

import { FormEvent, useCallback, useEffect, useMemo, useState } from "react";
import { EmptyState, Panel, RefreshButton, StatCard, StatusLine } from "@/components/ui";
import { useAuth } from "@/components/auth-provider";
import { usePreferences } from "@/components/preferences-provider";
import { Incident, IncidentStatus } from "@/lib/types";
import { formatDuration } from "@/lib/format";

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

function payloadValue(payload: Record<string, unknown>, key: string) {
  const value = payload[key];
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return "";
}

function evidenceRows(incident: Incident) {
  const evidence = incident.payload.evidencia_tecnica;
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
  const evidence = incident.payload.evidencia_tecnica;
  const source = evidence && typeof evidence === "object" && !Array.isArray(evidence)
    ? evidence as Record<string, unknown>
    : {};
  const minutes = Number(source.minutos_estimados || incident.payload.minutos_estimados || 0);
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
  const [incidents, setIncidents] = useState<Incident[]>([]);
  const [selectedIncidentId, setSelectedIncidentId] = useState("");
  const [statusFilter, setStatusFilter] = useState<"" | IncidentStatus>("pending");
  const [search, setSearch] = useState("");
  const [resolutionStatus, setResolutionStatus] = useState<IncidentStatus>("approved");
  const [resolutionNotes, setResolutionNotes] = useState("");
  const [confirmResolution, setConfirmResolution] = useState(false);
  const [statusText, setStatusText] = useState("");
  const [loading, setLoading] = useState(false);

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
        payloadValue(incident.payload, "problema"),
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
      const nextSelection = nextIncidents.find((incident) => incident.id === response.incident.id) || nextIncidents[0] || null;
      setSelectedIncidentId(nextSelection?.id || "");
      setResolutionStatus(nextSelection ? defaultResolutionStatus(nextSelection) : "approved");
      setResolutionNotes(nextSelection?.resolution_notes || "");
      setConfirmResolution(false);
      setStatusText(t("Incidencia actualizada"));
    } catch {
      setStatusText(t("No se pudo guardar la resolucion"));
    }
  }

  return (
    <>
      <section className="stats-grid">
        <StatCard label={t("En filtro")} value={`${stats.all}`} detail={t("Incidencias cargadas")} />
        <StatCard label={t("Pendientes")} value={`${stats.pending}`} detail={t("Requieren revision")} tone={stats.pending ? "warn" : "plain"} />
        <StatCard label={t("Aprobadas")} value={`${stats.approved}`} detail={t("Validado por RR. HH.")} tone="good" />
        <StatCard label={t("Rechazadas")} value={`${stats.rejected}`} detail={t("No proceden")} tone={stats.rejected ? "bad" : "plain"} />
      </section>

      <div className="filter-row incidents-filter">
        <label>
          {t("Estado")}
          <select value={statusFilter} onChange={(event) => setStatusFilter(event.target.value as "" | IncidentStatus)}>
            <option value="">{t("Todos")}</option>
            <option value="pending">{t("Pendientes")}</option>
            <option value="approved">{t("Aprobadas")}</option>
            <option value="rejected">{t("Rechazadas")}</option>
            <option value="closed">{t("Cerradas")}</option>
          </select>
        </label>
        <label>
          {t("Buscar")}
          <input
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder={t("Empleado, equipo, tipo o descripcion")}
          />
        </label>
        <RefreshButton loading={loading} onClick={() => void loadIncidents()} />
      </div>

      <section className="incidents-layout">
        <Panel title={t("Bandeja de incidencias")} meta={`${filteredIncidents.length} ${t("resultados")}`}>
          {filteredIncidents.length ? (
            <table>
              <thead>
                <tr>
                  <th>{t("Empleado")}</th>
                  <th>{t("Tipo")}</th>
                  <th>{t("Estado")}</th>
                  <th>{t("Fecha")}</th>
                  <th aria-label={t("Acciones")} />
                </tr>
              </thead>
              <tbody>
                {filteredIncidents.map((incident) => (
                  <tr className={selectedIncident?.id === incident.id ? "selected-row" : ""} key={incident.id}>
                    <td>
                      <strong>{incident.employee || t("Sin empleado")}</strong>
                      <small>{incident.employee_code || incident.device || t("Sin referencia")}</small>
                    </td>
                    <td>
                      <span className="soft-pill">{typeLabel(incident.incident_type, t)}</span>
                      <small>{incident.title}</small>
                    </td>
                    <td>
                      <span className={`badge attendance-${statusTone[incident.status]}`}>
                        {t(statusLabels[incident.status] || incident.status)}
                      </span>
                    </td>
                    <td>{formatDateTime(incident.requested_at)}</td>
                    <td>
                      <button
                        className="row-action"
                        type="button"
                        onClick={() => selectIncident(incident)}
                        aria-label={`${t("Revisar incidencia de")} ${incident.employee || t("Sin empleado")}`}
                        aria-pressed={selectedIncident?.id === incident.id}
                      >
                        {t("Revisar")}
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <EmptyState>{t("No hay incidencias para el filtro actual.")}</EmptyState>
          )}
        </Panel>

        <Panel title={t("Revision")} meta={selectedIncident ? t(statusLabels[selectedIncident.status]) : t("Sin seleccion")}>
          {selectedIncident ? (
            <div className="incident-review">
              <header>
                <span className={`badge attendance-${statusTone[selectedIncident.status]}`}>
                  {t(statusLabels[selectedIncident.status] || selectedIncident.status)}
                </span>
                <h2>{selectedIncident.title || typeLabel(selectedIncident.incident_type, t)}</h2>
                <p>{selectedIncident.description || payloadValue(selectedIncident.payload, "motivo") || t("Sin descripcion")}</p>
              </header>

              <dl className="incident-facts">
                <div><dt>{t("Empleado")}</dt><dd>{selectedIncident.employee || "-"}</dd></div>
                <div><dt>{t("Equipo")}</dt><dd>{selectedIncident.device || "-"}</dd></div>
                <div><dt>{t("Solicitada")}</dt><dd>{formatDateTime(selectedIncident.requested_at)}</dd></div>
                <div><dt>{t("Problema")}</dt><dd>{payloadValue(selectedIncident.payload, "problema") || typeLabel(selectedIncident.incident_type, t)}</dd></div>
                {selectedIncident.time_adjustment ? (
                  <>
                    <div><dt>{t("Tiempo justificado")}</dt><dd>{formatDuration(selectedIncident.time_adjustment.seconds)}</dd></div>
                    <div><dt>{t("Impacto")}</dt><dd>{selectedIncident.time_adjustment.status === "active" ? t("Activo neutral") : t("Anulado")}</dd></div>
                  </>
                ) : null}
              </dl>

              {evidenceRows(selectedIncident).length ? (
                <section className="incident-evidence">
                  <h3>{t("Evidencia tecnica")}</h3>
                  {evidenceRows(selectedIncident).map(([label, value]) => (
                    <div key={label}>
                      <span>{t(label)}</span>
                      <strong>{String(value)}</strong>
                    </div>
                  ))}
                </section>
              ) : null}

              <form className="incident-resolution" onSubmit={resolveIncident}>
                <label>
                  {t("Resolucion")}
                  <select
                    value={resolutionStatus}
                    onChange={(event) => {
                      setResolutionStatus(event.target.value as IncidentStatus);
                      setConfirmResolution(false);
                    }}
                  >
                    <option value="approved">{t("Aprobar")}</option>
                    <option value="rejected">{t("Rechazar")}</option>
                    <option value="closed">{t("Cerrar sin ajuste")}</option>
                  </select>
                </label>
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
                <section className={`resolution-impact resolution-impact-${resolutionStatus}`}>
                  <span>{t("Impacto previsto")}</span>
                  <strong>{resolutionImpactText(selectedIncident, resolutionStatus, t)}</strong>
                  <small>
                    {resolutionStatus === "approved"
                      ? t("El ajuste aparecera como neutral justificado, no como productividad artificial.")
                      : t("La decision quedara auditada con la nota de revision.")}
                  </small>
                </section>
                {confirmResolution ? (
                  <div className="resolution-confirm">
                    <strong>{t("Confirmar decision")}</strong>
                    <span>{t("Revisa que la nota y el impacto previsto sean correctos.")}</span>
                  </div>
                ) : null}
                <button className="secondary-button" type="submit" disabled={loading}>
                  {confirmResolution ? t("Confirmar y guardar") : t("Revisar impacto")}
                </button>
              </form>
            </div>
          ) : (
            <EmptyState>{t("Selecciona una incidencia para revisar.")}</EmptyState>
          )}
        </Panel>
      </section>

      <StatusLine>{statusText}</StatusLine>
    </>
  );
}
