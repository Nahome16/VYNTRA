"use client";

import { FormEvent, useCallback, useEffect, useMemo, useState } from "react";
import { EmptyState, Panel, RefreshButton, StatCard, StatusLine } from "@/components/ui";
import { useAuth } from "@/components/auth-provider";
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

function typeLabel(value: string) {
  return incidentTypeLabels[value] || value || "Incidencia";
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

function defaultResolutionStatus(incident: Incident): IncidentStatus {
  return incident.status === "pending" ? "approved" : incident.status;
}

export function IncidentsPanel({ active = true }: { active?: boolean }) {
  const { apiGet, apiPatch, user } = useAuth();
  const [incidents, setIncidents] = useState<Incident[]>([]);
  const [selectedIncidentId, setSelectedIncidentId] = useState("");
  const [statusFilter, setStatusFilter] = useState<"" | IncidentStatus>("pending");
  const [search, setSearch] = useState("");
  const [resolutionStatus, setResolutionStatus] = useState<IncidentStatus>("approved");
  const [resolutionNotes, setResolutionNotes] = useState("");
  const [statusText, setStatusText] = useState("");
  const [loading, setLoading] = useState(false);

  const loadIncidents = useCallback(async () => {
    setLoading(true);
    setStatusText("Actualizando incidencias...");
    const params = new URLSearchParams();
    if (statusFilter) params.set("status_filter", statusFilter);
    try {
      const response = await apiGet<IncidentResponse>(
        `/api/incidents${params.toString() ? `?${params.toString()}` : ""}`,
      );
      setIncidents(response.incidents);
      setStatusText("Incidencias actualizadas");
      const firstIncident = response.incidents[0] || null;
      setSelectedIncidentId(firstIncident?.id || "");
      setResolutionStatus(firstIncident ? defaultResolutionStatus(firstIncident) : "approved");
      setResolutionNotes(firstIncident?.resolution_notes || "");
    } catch {
      setStatusText("No se pudieron cargar las incidencias");
    } finally {
      setLoading(false);
    }
  }, [apiGet, statusFilter]);

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
  }

  async function resolveIncident(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!selectedIncident) return;
    if (resolutionNotes.trim().length < 4) {
      setStatusText("Agrega una nota breve de resolucion");
      return;
    }
    setStatusText("Guardando resolucion...");
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
      setStatusText("Incidencia actualizada");
    } catch {
      setStatusText("No se pudo guardar la resolucion");
    }
  }

  return (
    <>
      <section className="stats-grid">
        <StatCard label="En filtro" value={`${stats.all}`} detail="Incidencias cargadas" />
        <StatCard label="Pendientes" value={`${stats.pending}`} detail="Requieren revision" tone={stats.pending ? "warn" : "plain"} />
        <StatCard label="Aprobadas" value={`${stats.approved}`} detail="Validado por RR. HH." tone="good" />
        <StatCard label="Rechazadas" value={`${stats.rejected}`} detail="No proceden" tone={stats.rejected ? "bad" : "plain"} />
      </section>

      <div className="filter-row incidents-filter">
        <label>
          Estado
          <select value={statusFilter} onChange={(event) => setStatusFilter(event.target.value as "" | IncidentStatus)}>
            <option value="">Todos</option>
            <option value="pending">Pendientes</option>
            <option value="approved">Aprobadas</option>
            <option value="rejected">Rechazadas</option>
            <option value="closed">Cerradas</option>
          </select>
        </label>
        <label>
          Buscar
          <input
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Empleado, equipo, tipo o descripcion"
          />
        </label>
        <RefreshButton loading={loading} onClick={() => void loadIncidents()} />
      </div>

      <section className="incidents-layout">
        <Panel title="Bandeja de incidencias" meta={`${filteredIncidents.length} resultados`}>
          {filteredIncidents.length ? (
            <table>
              <thead>
                <tr>
                  <th>Empleado</th>
                  <th>Tipo</th>
                  <th>Estado</th>
                  <th>Fecha</th>
                  <th aria-label="Acciones" />
                </tr>
              </thead>
              <tbody>
                {filteredIncidents.map((incident) => (
                  <tr className={selectedIncident?.id === incident.id ? "selected-row" : ""} key={incident.id}>
                    <td>
                      <strong>{incident.employee || "Sin empleado"}</strong>
                      <small>{incident.employee_code || incident.device || "Sin referencia"}</small>
                    </td>
                    <td>
                      <span className="soft-pill">{typeLabel(incident.incident_type)}</span>
                      <small>{incident.title}</small>
                    </td>
                    <td>
                      <span className={`badge attendance-${statusTone[incident.status]}`}>
                        {statusLabels[incident.status] || incident.status}
                      </span>
                    </td>
                    <td>{formatDateTime(incident.requested_at)}</td>
                    <td>
                      <button className="row-action" type="button" onClick={() => selectIncident(incident)}>
                        Revisar
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <EmptyState>No hay incidencias para el filtro actual.</EmptyState>
          )}
        </Panel>

        <Panel title="Revision" meta={selectedIncident ? statusLabels[selectedIncident.status] : "Sin seleccion"}>
          {selectedIncident ? (
            <div className="incident-review">
              <header>
                <span className={`badge attendance-${statusTone[selectedIncident.status]}`}>
                  {statusLabels[selectedIncident.status] || selectedIncident.status}
                </span>
                <h2>{selectedIncident.title || typeLabel(selectedIncident.incident_type)}</h2>
                <p>{selectedIncident.description || payloadValue(selectedIncident.payload, "motivo") || "Sin descripcion"}</p>
              </header>

              <dl className="incident-facts">
                <div><dt>Empleado</dt><dd>{selectedIncident.employee || "-"}</dd></div>
                <div><dt>Equipo</dt><dd>{selectedIncident.device || "-"}</dd></div>
                <div><dt>Solicitada</dt><dd>{formatDateTime(selectedIncident.requested_at)}</dd></div>
                <div><dt>Problema</dt><dd>{payloadValue(selectedIncident.payload, "problema") || typeLabel(selectedIncident.incident_type)}</dd></div>
                {selectedIncident.time_adjustment ? (
                  <>
                    <div><dt>Tiempo justificado</dt><dd>{formatDuration(selectedIncident.time_adjustment.seconds)}</dd></div>
                    <div><dt>Impacto</dt><dd>{selectedIncident.time_adjustment.status === "active" ? "Activo neutral" : "Anulado"}</dd></div>
                  </>
                ) : null}
              </dl>

              {evidenceRows(selectedIncident).length ? (
                <section className="incident-evidence">
                  <h3>Evidencia tecnica</h3>
                  {evidenceRows(selectedIncident).map(([label, value]) => (
                    <div key={label}>
                      <span>{label}</span>
                      <strong>{String(value)}</strong>
                    </div>
                  ))}
                </section>
              ) : null}

              <form className="incident-resolution" onSubmit={resolveIncident}>
                <label>
                  Resolucion
                  <select
                    value={resolutionStatus}
                    onChange={(event) => setResolutionStatus(event.target.value as IncidentStatus)}
                  >
                    <option value="approved">Aprobar</option>
                    <option value="rejected">Rechazar</option>
                    <option value="closed">Cerrar sin ajuste</option>
                  </select>
                </label>
                <label>
                  Nota
                  <textarea
                    value={resolutionNotes}
                    onChange={(event) => setResolutionNotes(event.target.value)}
                    placeholder="Resultado de la revision"
                    rows={4}
                  />
                </label>
                <button className="secondary-button" type="submit" disabled={loading}>
                  Guardar resolucion
                </button>
              </form>
            </div>
          ) : (
            <EmptyState>Selecciona una incidencia para revisar.</EmptyState>
          )}
        </Panel>
      </section>

      <StatusLine>{statusText}</StatusLine>
    </>
  );
}
