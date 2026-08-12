"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { EmptyState, Panel, StatusLine } from "@/components/ui";
import { useAuth } from "@/components/auth-provider";
import { EmployeeDetailResponse } from "@/lib/types";
import { formatDuration } from "@/lib/format";

const activityHours = [9, 10, 11, 12, 13, 14, 15, 16, 17];

type HourBucket = {
  productive: number;
  neutral: number;
  nonProductive: number;
  idle: number;
  total: number;
};

function todayISO() {
  return new Date().toISOString().slice(0, 10);
}

function monthStartISO() {
  const date = new Date();
  date.setDate(1);
  return date.toISOString().slice(0, 10);
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

function percent(part: number, total: number) {
  if (!total) return 0;
  return Math.max(0, Math.min(100, (part / total) * 100));
}

function shortDay(value: string) {
  return new Date(`${value}T00:00:00`).toLocaleDateString("es-NI", {
    weekday: "short",
    day: "numeric",
  });
}

function classificationLabel(value: string) {
  const labels: Record<string, string> = {
    productive: "Productivo",
    neutral: "Neutral",
    non_productive: "No productivo",
    uncategorized: "Sin clasificar",
  };
  return labels[value] || value;
}

function appShare(appSeconds: number, totalSeconds: number) {
  return `${Math.max(3, percent(appSeconds, totalSeconds))}%`;
}

function hourLabel(hour: number) {
  if (hour < 12) return `${hour}a`;
  if (hour === 12) return "12p";
  return `${hour - 12}p`;
}

function emptyHourBucket(): HourBucket {
  return {
    productive: 0,
    neutral: 0,
    nonProductive: 0,
    idle: 0,
    total: 0,
  };
}

function dominantClass(bucket: HourBucket) {
  if (!bucket.total) return "empty";
  const rows = [
    ["productive", bucket.productive],
    ["neutral", bucket.neutral],
    ["non-productive", bucket.nonProductive],
    ["idle", bucket.idle],
  ] as const;
  return rows.reduce((winner, row) => (row[1] > winner[1] ? row : winner), rows[0])[0];
}

function csvSafe(value: string | number) {
  return `"${String(value).replace(/"/g, '""')}"`;
}

export function EmployeeProfile({
  employeeId,
  initialDateFrom,
  initialDateTo,
}: {
  employeeId: string;
  initialDateFrom?: string;
  initialDateTo?: string;
}) {
  const { apiGet } = useAuth();
  const [employeeDetail, setEmployeeDetail] = useState<EmployeeDetailResponse | null>(null);
  const [dateFrom, setDateFrom] = useState(initialDateFrom || monthStartISO());
  const [dateTo, setDateTo] = useState(initialDateTo || todayISO());
  const [detailTab, setDetailTab] = useState<"resumen" | "registro">("resumen");
  const [statusText, setStatusText] = useState("");
  const [loading, setLoading] = useState(false);

  async function loadProfile(nextDateFrom = dateFrom, nextDateTo = dateTo) {
    setLoading(true);
    setStatusText("Cargando perfil empleado...");
    const params = new URLSearchParams();
    if (nextDateFrom) params.set("date_from", nextDateFrom);
    if (nextDateTo) params.set("date_to", nextDateTo);

    try {
      const detail = await apiGet<EmployeeDetailResponse>(
        `/api/employees/${employeeId}/detail?${params.toString()}`,
      );
      setEmployeeDetail(detail);
      setStatusText("Perfil actualizado");
    } catch {
      setStatusText("No se pudo cargar el perfil empleado");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void loadProfile();
  }, [employeeId]);

  const productiveApps = useMemo(
    () => (employeeDetail?.apps || []).filter((app) => app.classification === "productive").slice(0, 5),
    [employeeDetail],
  );
  const distractingApps = useMemo(
    () => (employeeDetail?.apps || []).filter((app) => app.classification === "non_productive").slice(0, 5),
    [employeeDetail],
  );
  const detailTotal = employeeDetail?.totals.active_seconds || employeeDetail?.totals.total_seconds || 0;
  const activityMap = useMemo(() => {
    if (!employeeDetail) return [];
    const dayLabels = new Map(employeeDetail.days.slice(-7).map((day) => [day.date, shortDay(day.date)]));
    const byDayHour = new Map<string, Map<number, HourBucket>>();

    (employeeDetail.blocks || []).forEach((block) => {
      if (!dayLabels.has(block.block_date)) return;
      const hour = Number(block.block_start.slice(0, 2));
      if (!activityHours.includes(hour)) return;
      if (!byDayHour.has(block.block_date)) byDayHour.set(block.block_date, new Map());
      const hourMap = byDayHour.get(block.block_date);
      if (!hourMap) return;
      const bucket = hourMap.get(hour) || emptyHourBucket();
      bucket.productive += block.productive_seconds;
      bucket.neutral += block.neutral_seconds + block.uncategorized_seconds;
      bucket.nonProductive += block.non_productive_seconds;
      bucket.idle += block.idle_seconds;
      bucket.total +=
        block.productive_seconds +
        block.neutral_seconds +
        block.uncategorized_seconds +
        block.non_productive_seconds +
        block.idle_seconds;
      hourMap.set(hour, bucket);
    });

    return Array.from(dayLabels, ([date, label]) => ({
      date,
      label,
      hours: activityHours.map((hour) => byDayHour.get(date)?.get(hour) || emptyHourBucket()),
    }));
  }, [employeeDetail]);

  function exportProfileCsv() {
    if (!employeeDetail) return;
    const header = ["App", "Clasificacion", "Tiempo", "Muestras"];
    const lines = employeeDetail.apps.map((app) =>
      [app.app, classificationLabel(app.classification), formatDuration(app.seconds), app.samples]
        .map(csvSafe)
        .join(","),
    );
    const blob = new Blob([[header.map(csvSafe).join(","), ...lines].join("\n")], {
      type: "text/csv;charset=utf-8",
    });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `vyntra-perfil-${employeeDetail.employee.employee_code}-${dateFrom}-${dateTo}.csv`;
    link.click();
    URL.revokeObjectURL(url);
  }

  return (
    <div className="employee-profile-view">
      <div className="profile-page-actions">
        <Link className="row-action profile-return" href="/empleados">
          Volver a empleados
        </Link>
        <div className="date-range-control">
          <span>Periodo</span>
          <input type="date" value={dateFrom} onChange={(event) => setDateFrom(event.target.value)} />
          <input type="date" value={dateTo} onChange={(event) => setDateTo(event.target.value)} />
          <button className="row-action" onClick={() => void loadProfile()}>
            Aplicar
          </button>
        </div>
      </div>

      {loading ? (
        <Panel title="Perfil empleado">
          <EmptyState>Cargando informacion del empleado...</EmptyState>
        </Panel>
      ) : null}

      {!loading && !employeeDetail ? (
        <Panel title="Perfil empleado">
          <EmptyState>No se pudo cargar este perfil.</EmptyState>
        </Panel>
      ) : null}

      {!loading && employeeDetail ? (
        <div className="employee-detail-page">
          <section className="employee-profile-hero">
            <div className="profile-main">
              <div className="employee-avatar-lg">{initialsFor(employeeDetail.employee.full_name)}</div>
              <div>
                <h2>{employeeDetail.employee.full_name}</h2>
                <p>{employeeDetail.employee.position || "Empleado monitoreado"}</p>
                <div className="profile-badges">
                  <span className="badge attendance-good">{employeeDetail.employee.status}</span>
                  <span className="soft-pill">{employeeDetail.employee.department || "Sin departamento"}</span>
                </div>
              </div>
            </div>
            <div className="profile-contact">
              <span>{employeeDetail.employee.email || "Sin correo laboral"}</span>
              <span>Equipo {employeeDetail.employee.employee_code}</span>
              <span>{employeeDetail.employee.department || "Sin departamento"}</span>
            </div>
            <button className="secondary-button" onClick={exportProfileCsv}>
              Descargar informe
            </button>
          </section>

          <section className="employee-kpi-grid">
            <div>
              <span>Horas rango</span>
              <strong>{formatDuration(employeeDetail.totals.active_seconds)}</strong>
              <small>Actividad real capturada</small>
            </div>
            <div>
              <span>Productividad</span>
              <strong className="metric-good">{employeeDetail.totals.productivity_pct}%</strong>
              <small>Sobre tiempo activo</small>
            </div>
            <div>
              <span>No productivo</span>
              <strong className={employeeDetail.totals.non_productive_pct > 12 ? "metric-bad" : ""}>
                {employeeDetail.totals.non_productive_pct}%
              </strong>
              <small>{formatDuration(employeeDetail.totals.non_productive_seconds)}</small>
            </div>
          </section>

          <section className="employee-detail-section">
            <div className="panel-title">
              <h2>Composicion de actividad (ultimos 7 dias)</h2>
              <span>
                {dateFrom} - {dateTo}
              </span>
            </div>
            <div className="activity-legend">
              <span>
                <i className="legend-productive" />
                Productivo
              </span>
              <span>
                <i className="legend-neutral" />
                Neutral
              </span>
              <span>
                <i className="legend-bad" />
                No productivo
              </span>
              <span>
                <i className="legend-idle" />
                Inactivo
              </span>
            </div>
            <div className="activity-map">
              <div className="activity-map-hours">
                <span />
                {activityHours.map((hour) => (
                  <strong key={hour}>{hourLabel(hour)}</strong>
                ))}
              </div>
              {activityMap.map((day) => (
                <div className="activity-map-row" key={day.date}>
                  <strong>{day.label}</strong>
                  {day.hours.map((bucket, index) => (
                    <div
                      className={`activity-cell activity-cell-${dominantClass(bucket)}`}
                      key={`${day.date}-${activityHours[index]}`}
                      title={`${day.label} ${hourLabel(activityHours[index])}: ${formatDuration(bucket.total)}`}
                    >
                      {bucket.total ? (
                        <>
                          <span
                            className="segment-productive"
                            style={{ width: `${percent(bucket.productive, bucket.total)}%` }}
                          />
                          <span
                            className="segment-neutral"
                            style={{ width: `${percent(bucket.neutral, bucket.total)}%` }}
                          />
                          <span
                            className="segment-bad"
                            style={{ width: `${percent(bucket.nonProductive, bucket.total)}%` }}
                          />
                          <span className="segment-idle" style={{ width: `${percent(bucket.idle, bucket.total)}%` }} />
                        </>
                      ) : null}
                    </div>
                  ))}
                </div>
              ))}
              {!activityMap.length ? (
                <EmptyState>No hay composicion calculada para este rango.</EmptyState>
              ) : null}
            </div>
          </section>

          <section className="employee-detail-section">
            <div className="panel-title">
              <h2>Detalle de actividad</h2>
              <span>{employeeDetail.apps.length} apps</span>
            </div>
            <div className="tabs inner-tabs">
              <button className={detailTab === "resumen" ? "active" : ""} onClick={() => setDetailTab("resumen")}>
                Resumen
              </button>
              <button className={detailTab === "registro" ? "active" : ""} onClick={() => setDetailTab("registro")}>
                Registro completo
              </button>
            </div>
            {detailTab === "resumen" ? (
              <div className="activity-summary-grid">
                <div>
                  <h3>Aplicaciones principales</h3>
                  {(productiveApps.length ? productiveApps : employeeDetail.apps.slice(0, 5)).map((app) => (
                    <div className="app-progress" key={`${app.app}-${app.classification}`}>
                      <div>
                        <span>{app.app}</span>
                        <small>{formatDuration(app.seconds)}</small>
                      </div>
                      <strong>
                        <i style={{ width: appShare(app.seconds, detailTotal) }} />
                      </strong>
                    </div>
                  ))}
                </div>
                <div>
                  <h3>Puntos de foco</h3>
                  {(distractingApps.length
                    ? distractingApps
                    : employeeDetail.apps.filter((app) => app.classification !== "productive").slice(0, 5)
                  ).map((app) => (
                    <div className="app-progress danger" key={`${app.app}-${app.classification}`}>
                      <div>
                        <span>{app.app}</span>
                        <small>{formatDuration(app.seconds)}</small>
                      </div>
                      <strong>
                        <i style={{ width: appShare(app.seconds, detailTotal) }} />
                      </strong>
                    </div>
                  ))}
                  {!employeeDetail.apps.length ? (
                    <EmptyState>No hay apps registradas para el rango.</EmptyState>
                  ) : null}
                </div>
              </div>
            ) : (
              <div className="app-register">
                {employeeDetail.apps.map((app) => (
                  <article key={`${app.app}-${app.classification}`}>
                    <strong>{app.app}</strong>
                    <span>{formatDuration(app.seconds)}</span>
                    <em className={`badge badge-${app.classification}`}>{classificationLabel(app.classification)}</em>
                  </article>
                ))}
              </div>
            )}
          </section>

          <section className="employee-detail-section">
            <div className="panel-title">
              <h2>Revision de capturas</h2>
              <span>{employeeDetail.evidence.length} archivos</span>
            </div>
            {employeeDetail.evidence.length ? (
              <div className="evidence-grid">
                {employeeDetail.evidence.map((item) => (
                  <article className="evidence-tile" key={item.id}>
                    <div className="evidence-thumb">{item.content_type.includes("image") ? "IMG" : "FILE"}</div>
                    <strong>{item.original_filename}</strong>
                    <span>{new Date(item.captured_at).toLocaleString("es-NI")}</span>
                    <small>
                      {item.equipment} - {item.status}
                    </small>
                  </article>
                ))}
              </div>
            ) : (
              <EmptyState>No hay capturas asociadas a este empleado en el rango.</EmptyState>
            )}
          </section>
        </div>
      ) : null}

      <StatusLine>{statusText}</StatusLine>
    </div>
  );
}
