"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { AppShell } from "@/components/app-shell";
import { EmptyState, Panel, RefreshButton, StatCard, StatusLine } from "@/components/ui";
import { useAuth } from "@/components/auth-provider";
import { usePreferences } from "@/components/preferences-provider";
import { formatDuration, formatPercent, fullDate, metricTone } from "@/lib/format";
import {
  AttendanceOverviewResponse,
  AttendanceShift,
  CatalogsResponse,
  DashboardResponse,
  DashboardTotals,
  Incident,
  ProductivityBlock,
  UncategorizedItem,
} from "@/lib/types";
import { downloadAuthenticatedFile } from "@/lib/download-file";

type PeriodKey = "today" | "7d" | "month" | "custom";
type TrendPoint = { key: string; label: string; value: number };
type DepartmentProductivity = { id: string; name: string; productivityPct: number; activeSeconds: number; employees: number };

const periodLabels: Record<PeriodKey, string> = {
  today: "Hoy",
  "7d": "7 dias",
  month: "Mes",
  custom: "Personalizado",
};

function localISO(date: Date) {
  const year = date.getFullYear();
  const month = `${date.getMonth() + 1}`.padStart(2, "0");
  const day = `${date.getDate()}`.padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function todayISO() {
  return localISO(new Date());
}

function addDays(value: string, days: number) {
  const date = new Date(`${value}T00:00:00`);
  date.setDate(date.getDate() + days);
  return localISO(date);
}

function monthStartISO() {
  const date = new Date();
  date.setDate(1);
  return localISO(date);
}

function daySpanInclusive(dateFrom: string, dateTo: string) {
  const start = new Date(`${dateFrom}T00:00:00`).getTime();
  const end = new Date(`${dateTo}T00:00:00`).getTime();
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return 1;
  return Math.max(1, Math.round((end - start) / 86400000) + 1);
}

function datesForPeriod(period: PeriodKey, customFrom: string, customTo: string) {
  const today = todayISO();
  if (period === "custom") {
    return { dateFrom: customFrom || today, dateTo: customTo || customFrom || today };
  }
  if (period === "7d") return { dateFrom: addDays(today, -6), dateTo: today };
  if (period === "month") return { dateFrom: monthStartISO(), dateTo: today };
  return { dateFrom: today, dateTo: today };
}

function previousRange(dateFrom: string, dateTo: string) {
  const length = daySpanInclusive(dateFrom, dateTo);
  const previousTo = addDays(dateFrom, -1);
  return { dateFrom: addDays(previousTo, 1 - length), dateTo: previousTo };
}

function buildParams({ dateFrom, dateTo, departmentId, employeeId }: {
  dateFrom: string;
  dateTo: string;
  departmentId: string;
  employeeId: string;
}) {
  const params = new URLSearchParams();
  if (dateFrom) params.set("date_from", dateFrom);
  if (dateTo) params.set("date_to", dateTo);
  if (departmentId) params.set("department_id", departmentId);
  if (employeeId) params.set("employee_id", employeeId);
  return params;
}

function trendDelta(current: number, previous?: number) {
  if (previous === undefined || previous === null) return undefined;
  const diff = current - previous;
  if (Math.abs(diff) < 0.05) return "0.0%";
  return `${diff > 0 ? "+" : ""}${diff.toFixed(1)}%`;
}

function deltaTone(delta?: string, inverse = false): "plain" | "good" | "warn" | "bad" {
  if (!delta || delta === "0.0%") return "plain";
  const value = Number(delta.replace("%", ""));
  if (!Number.isFinite(value)) return "plain";
  if (inverse) return value > 0 ? "bad" : "good";
  return value > 0 ? "good" : "bad";
}

function percent(part: number, whole: number) {
  if (whole <= 0) return 0;
  return Math.round((part / whole) * 1000) / 10;
}

function statusForShift(shift?: AttendanceShift) {
  if (!shift?.started_at) return "absent";
  if (shift.ended_at || shift.status === "closed") return "closed";
  const lastEvent = shift.events.at(-1)?.event_type;
  if (lastEvent === "lunch_started") return "lunch";
  if (lastEvent === "break_started") return "break";
  return "active";
}

function dateInRange(value: string | null, dateFrom: string, dateTo: string) {
  if (!value) return false;
  const day = value.slice(0, 10);
  return day >= dateFrom && day <= dateTo;
}

function sumTotals(blocks: ProductivityBlock[]): DashboardTotals {
  const totals = blocks.reduce(
    (acc, block) => {
      acc.total_seconds += block.total_seconds || 0;
      acc.active_seconds += block.active_seconds || 0;
      acc.productive_seconds += block.productive_seconds || 0;
      acc.neutral_seconds += block.neutral_seconds || 0;
      acc.non_productive_seconds += block.non_productive_seconds || 0;
      acc.uncategorized_seconds += block.uncategorized_seconds || 0;
      acc.idle_seconds += block.idle_seconds || 0;
      acc.break_seconds += block.break_seconds || 0;
      acc.lunch_seconds += block.lunch_seconds || 0;
      acc.justified_seconds += block.justified_seconds || 0;
      return acc;
    },
    {
      total_seconds: 0,
      active_seconds: 0,
      productive_seconds: 0,
      neutral_seconds: 0,
      non_productive_seconds: 0,
      uncategorized_seconds: 0,
      idle_seconds: 0,
      break_seconds: 0,
      lunch_seconds: 0,
      justified_seconds: 0,
    },
  );
  return {
    ...totals,
    productivity_pct: percent(totals.productive_seconds, totals.active_seconds),
    acceptable_pct: percent(totals.productive_seconds + totals.neutral_seconds, totals.active_seconds),
    non_productive_pct: percent(totals.non_productive_seconds, totals.active_seconds),
    neutral_pct: percent(totals.neutral_seconds, totals.active_seconds),
    uncategorized_pct: percent(totals.uncategorized_seconds, totals.active_seconds),
    idle_pct: percent(totals.idle_seconds, totals.total_seconds),
    break_pct: percent(totals.break_seconds, totals.total_seconds),
    lunch_pct: percent(totals.lunch_seconds, totals.total_seconds),
  };
}

function DailyBarTrend({ points }: { points: TrendPoint[] }) {
  if (!points.length) return <p className="empty">Sin datos suficientes para graficar.</p>;
  const average = points.reduce((sum, point) => sum + point.value, 0) / points.length;
  return (
    <div className="daily-bar-chart" aria-label={`Promedio: ${average.toFixed(1)}%`}>
      <div className="daily-bar-legend">
        <span><i /> Productivo</span>
        <span><i /> Promedio</span>
      </div>
      <div className="daily-bar-plot">
        {points.map((point, index) => (
          <div className="daily-bar-slot" key={point.key}>
            <span
              className={index === points.length - 1 ? "active" : undefined}
              style={{ height: `${Math.max(4, Math.min(100, point.value))}%` }}
              title={`${point.label}: ${point.value}%`}
            />
            <small>{point.label}</small>
          </div>
        ))}
        <b style={{ bottom: `${Math.max(0, Math.min(100, average))}%` }} />
      </div>
    </div>
  );
}

function TimeDonut({ totals }: { totals: DashboardTotals }) {
  const segments = [
    { key: "productivo", label: "Productivo", value: totals.productivity_pct },
    { key: "neutral", label: "Neutral", value: totals.neutral_pct + totals.uncategorized_pct },
    { key: "no-productivo", label: "No productivo", value: totals.non_productive_pct },
  ];
  const radius = 42;
  const circumference = 2 * Math.PI * radius;
  let offset = 0;

  return (
    <div className="time-donut">
      <svg viewBox="0 0 120 120" role="img" aria-label={`Productivo ${totals.productivity_pct}%`}>
        <circle cx="60" cy="60" r={radius} className="donut-track" />
        {segments.map((segment, index) => {
          const length = (Math.max(0, segment.value) / 100) * circumference;
          const dashOffset = -offset;
          offset += length;
          return (
            <circle
              key={segment.key}
              cx="60"
              cy="60"
              r={radius}
              className={`donut-segment donut-${index + 1}`}
              strokeDasharray={`${length} ${circumference - length}`}
              strokeDashoffset={dashOffset}
            />
          );
        })}
        <text x="60" y="57" textAnchor="middle">{totals.productivity_pct}%</text>
        <text x="60" y="72" textAnchor="middle">Total</text>
      </svg>
      <ul>
        {segments.map((segment, index) => (
          <li key={segment.key}>
            <span><i className={`donut-dot-${index + 1}`} />{segment.label}</span>
            <strong>{segment.value}%</strong>
          </li>
        ))}
      </ul>
    </div>
  );
}

export default function DashboardPage() {
  const { apiGet, token, user } = useAuth();
  const [dashboard, setDashboard] = useState<DashboardResponse | null>(null);
  const [previousDashboard, setPreviousDashboard] = useState<DashboardResponse | null>(null);
  const [attendance, setAttendance] = useState<AttendanceOverviewResponse | null>(null);
  const [incidents, setIncidents] = useState<Incident[]>([]);
  const [uncategorized, setUncategorized] = useState<UncategorizedItem[]>([]);
  const [catalogs, setCatalogs] = useState<CatalogsResponse | null>(null);
  const [period, setPeriod] = useState<PeriodKey>("today");
  const [customDateFrom, setCustomDateFrom] = useState(todayISO());
  const [customDateTo, setCustomDateTo] = useState(todayISO());
  const [selectedDepartment, setSelectedDepartment] = useState("");
  const [selectedEmployee, setSelectedEmployee] = useState("");
  const [employeeSearch, setEmployeeSearch] = useState("");
  const [statusText, setStatusText] = useState("");
  const [loading, setLoading] = useState(false);
  const [reportLoading, setReportLoading] = useState(false);

  const { t } = usePreferences();
  const { dateFrom, dateTo } = useMemo(
    () => datesForPeriod(period, customDateFrom, customDateTo),
    [customDateFrom, customDateTo, period],
  );
  const currentParams = useMemo(
    () => buildParams({ dateFrom, dateTo, departmentId: selectedDepartment, employeeId: selectedEmployee }),
    [dateFrom, dateTo, selectedDepartment, selectedEmployee],
  );
  const totals = dashboard?.totals;
  const previousTotals = previousDashboard?.totals;
  const topDays = useMemo(() => dashboard?.days.slice(-7).reverse() || [], [dashboard]);
  const headcount = attendance?.employees.length || catalogs?.employees.length || 0;

  const filteredEmployees = useMemo(() => {
    const employees = catalogs?.employees || [];
    const search = employeeSearch.trim().toLowerCase();
    return employees
      .filter((employee) => !selectedDepartment || employee.department_id === selectedDepartment)
      .filter((employee) =>
        !search
        || employee.full_name.toLowerCase().includes(search)
        || employee.email.toLowerCase().includes(search)
        || employee.employee_code.toLowerCase().includes(search),
      );
  }, [catalogs, employeeSearch, selectedDepartment]);

  const trendPoints = useMemo(
    () =>
      (dashboard?.days || []).slice(-7).map((day) => ({
        key: day.block_date,
        label: fullDate(day.block_date).slice(0, 5),
        value: day.productivity_pct,
      })),
    [dashboard],
  );

  const operationalStats = useMemo(() => {
    const employees = attendance?.employees || [];
    const shifts = attendance?.shifts || [];
    const latestByEmployee = new Map<string, AttendanceShift>();
    shifts
      .filter((shift) => shift.shift_date === dateTo)
      .forEach((shift) => {
        if (!latestByEmployee.has(shift.employee_id)) latestByEmployee.set(shift.employee_id, shift);
      });
    const active = employees.filter((employee) => statusForShift(latestByEmployee.get(employee.id)) === "active").length;
    const breakLunch = employees.filter((employee) => {
      const status = statusForShift(latestByEmployee.get(employee.id));
      return status === "break" || status === "lunch";
    }).length;
    const missing = employees.filter((employee) => !latestByEmployee.get(employee.id)?.started_at).length;
    const employeeIds = new Set(employees.map((employee) => employee.id));
    const visibleIncidents = incidents.filter((incident) =>
      employeeIds.has(incident.employee_id)
      && dateInRange(incident.requested_at, dateFrom, dateTo),
    );
    return { active, breakLunch, missing, incidents: visibleIncidents.length };
  }, [attendance, dateFrom, dateTo, incidents]);

  const departmentProductivity = useMemo<DepartmentProductivity[]>(() => {
    if (!catalogs || !dashboard) return [];
    const departmentNames = new Map(catalogs.departments.map((department) => [department.id, department.name]));
    const employeesByDepartment = new Map<string, number>();
    catalogs.employees.forEach((employee) => {
      const key = employee.department_id || "none";
      if (selectedDepartment && key !== selectedDepartment) return;
      employeesByDepartment.set(key, (employeesByDepartment.get(key) || 0) + 1);
    });
    const blocksByDepartment = new Map<string, ProductivityBlock[]>();
    dashboard.blocks.forEach((block) => {
      const key = block.department_id || "none";
      if (selectedDepartment && key !== selectedDepartment) return;
      blocksByDepartment.set(key, [...(blocksByDepartment.get(key) || []), block]);
    });
    return Array.from(employeesByDepartment, ([id, employees]) => {
      const departmentTotals = sumTotals(blocksByDepartment.get(id) || []);
      return {
        id,
        name: id === "none" ? t("Sin departamento") : departmentNames.get(id) || t("Sin departamento"),
        productivityPct: departmentTotals.productivity_pct,
        activeSeconds: departmentTotals.active_seconds,
        employees,
      };
    }).sort((a, b) => b.productivityPct - a.productivityPct || b.activeSeconds - a.activeSeconds);
  }, [catalogs, dashboard, selectedDepartment, t]);

  const loadDashboard = useCallback(async () => {
    setLoading(true);
    setStatusText(t("Actualizando datos..."));
    const previous = previousRange(dateFrom, dateTo);
    const previousParams = buildParams({
      dateFrom: previous.dateFrom,
      dateTo: previous.dateTo,
      departmentId: selectedDepartment,
      employeeId: selectedEmployee,
    });
    const incidentParams = new URLSearchParams();
    if (selectedEmployee) incidentParams.set("employee_id", selectedEmployee);

    try {
      const [nextDashboard, nextPrevious, nextAttendance, nextIncidents, nextUncategorized, nextCatalogs] = await Promise.all([
        apiGet<DashboardResponse>(`/api/productivity/dashboard?${currentParams.toString()}`),
        apiGet<DashboardResponse>(`/api/productivity/dashboard?${previousParams.toString()}`),
        apiGet<AttendanceOverviewResponse>(`/api/attendance/overview?${currentParams.toString()}`),
        apiGet<{ incidents: Incident[] }>(`/api/incidents${incidentParams.toString() ? `?${incidentParams.toString()}` : ""}`),
        apiGet<{ items: UncategorizedItem[] }>("/api/productivity/uncategorized?limit=8"),
        apiGet<CatalogsResponse>("/api/productivity/catalogs"),
      ]);
      setDashboard(nextDashboard);
      setPreviousDashboard(nextPrevious);
      setAttendance(nextAttendance);
      setIncidents(nextIncidents.incidents);
      setUncategorized(nextUncategorized.items);
      setCatalogs(nextCatalogs);
      setStatusText(t("Datos actualizados"));
    } catch {
      setStatusText(t("No se pudieron cargar los datos"));
    } finally {
      setLoading(false);
    }
  }, [apiGet, currentParams, dateFrom, dateTo, selectedDepartment, selectedEmployee, t]);

  useEffect(() => {
    if (!user) return;
    const timer = window.setTimeout(() => {
      void loadDashboard();
    }, 0);
    return () => window.clearTimeout(timer);
  }, [loadDashboard, user]);

  async function downloadReport() {
    setReportLoading(true);
    setStatusText(t("Generando PDF..."));
    try {
      const query = currentParams.toString();
      await downloadAuthenticatedFile(`/api/reports/operations.pdf${query ? `?${query}` : ""}`, token, "vyntra-reporte-operativo.pdf");
      setStatusText(t("Reporte descargado"));
    } catch {
      setStatusText(t("No se pudo generar el PDF"));
    } finally {
      setReportLoading(false);
    }
  }

  return (
    <AppShell
      title={t("Dashboard")}
      description={`${user?.company || t("Empresa")} · ${dateFrom === dateTo ? fullDate(dateTo) : `${fullDate(dateFrom)} - ${fullDate(dateTo)}`}`}
      actions={(
        <>
          <button className="secondary-button" onClick={downloadReport} disabled={reportLoading || !totals}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
              <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
              <path d="M14 2v6h6M8 13h8M8 17h5" />
            </svg>
            <span>{reportLoading ? t("Generando PDF...") : "PDF"}</span>
          </button>
          <RefreshButton loading={loading} onClick={loadDashboard} />
        </>
      )}
    >
      <section className="dashboard-filter-bar" aria-label="Filtros del dashboard">
        <div className="period-tabs">
          {(Object.keys(periodLabels) as PeriodKey[]).map((key) => (
            <button key={key} type="button" className={period === key ? "active" : undefined} onClick={() => setPeriod(key)}>
              {periodLabels[key]}
            </button>
          ))}
        </div>
        {period === "custom" ? (
          <div className="dashboard-date-range">
            <input type="date" value={customDateFrom} onChange={(event) => setCustomDateFrom(event.target.value)} />
            <span>-</span>
            <input type="date" value={customDateTo} onChange={(event) => setCustomDateTo(event.target.value)} />
          </div>
        ) : null}
        <select value={selectedDepartment} onChange={(event) => {
          setSelectedDepartment(event.target.value);
          setSelectedEmployee("");
        }}>
          <option value="">Todos los departamentos</option>
          {(catalogs?.departments || []).map((department) => (
            <option key={department.id} value={department.id}>{department.name}</option>
          ))}
        </select>
        <input value={employeeSearch} onChange={(event) => setEmployeeSearch(event.target.value)} placeholder="Buscar empleado..." />
        <select value={selectedEmployee} onChange={(event) => setSelectedEmployee(event.target.value)}>
          <option value="">Todos los empleados</option>
          {filteredEmployees.map((employee) => (
            <option key={employee.id} value={employee.id}>{employee.full_name}</option>
          ))}
        </select>
      </section>

      {!totals ? (
        <Panel title={t("Estado")}>
          <EmptyState>{statusText || t("Cargando datos...")}</EmptyState>
        </Panel>
      ) : (
        <>
          <section className="stats-grid operational-grid">
            <StatCard label="En jornada" value={`${operationalStats.active}`} detail={`${headcount} empleados en filtro`} tone={operationalStats.active ? "good" : "plain"} />
            <StatCard label="En break/lunch" value={`${operationalStats.breakLunch}`} detail="Pausas activas ahora" tone={operationalStats.breakLunch ? "warn" : "plain"} />
            <StatCard label="Sin marcar" value={`${operationalStats.missing}`} detail={`Fecha: ${fullDate(dateTo)}`} tone={operationalStats.missing ? "warn" : "plain"} />
            <StatCard label="Incidencias/extra" value={`${operationalStats.incidents}`} detail="Solicitudes en el periodo" tone={operationalStats.incidents ? "bad" : "plain"} />
          </section>

          <section className="stats-grid">
            <StatCard
              label={t("Productividad")}
              value={`${totals.productivity_pct}%`}
              detail={`${formatDuration(totals.productive_seconds)} ${t("productivo")}`}
              tone={metricTone(totals.productivity_pct)}
              delta={trendDelta(totals.productivity_pct, previousTotals?.productivity_pct)}
              deltaTone={deltaTone(trendDelta(totals.productivity_pct, previousTotals?.productivity_pct))}
            />
            <StatCard
              label={t("Aceptable")}
              value={`${totals.acceptable_pct}%`}
              detail={`${formatDuration(totals.justified_seconds)} justificado`}
              tone={metricTone(totals.acceptable_pct)}
              delta={trendDelta(totals.acceptable_pct, previousTotals?.acceptable_pct)}
              deltaTone={deltaTone(trendDelta(totals.acceptable_pct, previousTotals?.acceptable_pct))}
            />
            <StatCard
              label={t("No productivo")}
              value={`${totals.non_productive_pct}%`}
              detail={formatDuration(totals.non_productive_seconds)}
              tone={totals.non_productive_pct > 12 ? "bad" : "plain"}
              delta={trendDelta(totals.non_productive_pct, previousTotals?.non_productive_pct)}
              deltaTone={deltaTone(trendDelta(totals.non_productive_pct, previousTotals?.non_productive_pct), true)}
            />
            <StatCard
              label={t("Idle")}
              value={`${totals.idle_pct}%`}
              detail={formatDuration(totals.idle_seconds)}
              tone={totals.idle_pct > 15 ? "warn" : "plain"}
              delta={trendDelta(totals.idle_pct, previousTotals?.idle_pct)}
              deltaTone={deltaTone(trendDelta(totals.idle_pct, previousTotals?.idle_pct), true)}
            />
          </section>

          <section className="chart-grid-2">
            <Panel title={t("Tendencia de productividad")} meta={`${trendPoints.length} dias`}>
              <DailyBarTrend points={trendPoints} />
            </Panel>

            <Panel title={t("Composición del tiempo")} meta={formatDuration(totals.active_seconds)}>
              <TimeDonut totals={totals} />
            </Panel>
          </section>

          <Panel title="Productividad por departamento" meta={`${departmentProductivity.length} grupos`}>
            {departmentProductivity.length ? (
              <div className="department-productivity">
                {departmentProductivity.map((row) => (
                  <div key={row.id}>
                    <header>
                      <span>{row.name}</span>
                      <strong>{row.productivityPct}%</strong>
                    </header>
                    <b><i style={{ width: `${Math.max(0, Math.min(100, row.productivityPct))}%` }} /></b>
                    <small>{row.employees} empleados · {formatDuration(row.activeSeconds)} activos</small>
                  </div>
                ))}
              </div>
            ) : (
              <EmptyState>{t("Aun no hay departamentos configurados.")}</EmptyState>
            )}
          </Panel>

          <section className="work-grid dashboard-detail-grid">
            <Panel title={t("Resumen diario")} meta={`${formatDuration(totals.active_seconds)} ${t("activos")}`} className="wide">
              <table>
                <thead>
                  <tr>
                    <th>{t("Fecha")}</th>
                    <th>{t("Activo")}</th>
                    <th>{t("Productivo")}</th>
                    <th>{t("Neutral")}</th>
                    <th>{t("No productivo")}</th>
                    <th>{t("Justificado")}</th>
                    <th>{t("Break")}</th>
                    <th>{t("Lunch")}</th>
                  </tr>
                </thead>
                <tbody>
                  {topDays.map((day) => (
                    <tr key={day.block_date}>
                      <td>{fullDate(day.block_date)}</td>
                      <td>{formatDuration(day.active_seconds)}</td>
                      <td>{day.productivity_pct}%</td>
                      <td>{formatPercent(day.neutral_seconds, day.active_seconds)}</td>
                      <td>{formatDuration(day.non_productive_seconds)}</td>
                      <td>{formatDuration(day.justified_seconds)}</td>
                      <td>{formatDuration(day.break_seconds)}</td>
                      <td>{formatDuration(day.lunch_seconds)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </Panel>

            <Panel title={t("Sin categorizar")} meta={`${totals.uncategorized_pct}%`}>
              <div className="stack">
                {uncategorized.length ? (
                  uncategorized.map((item) => (
                    <article className="list-item" key={`${item.executable_name}-${item.title_text}`}>
                      <strong>{item.executable_name || t("(desconocido)")}</strong>
                      <span>{item.title_text || t("(sin titulo)")}</span>
                      <small>{formatDuration(item.seconds)} - {item.samples} {t("muestras")}</small>
                    </article>
                  ))
                ) : (
                  <EmptyState>{t("No hay actividad pendiente de clasificar.")}</EmptyState>
                )}
              </div>
            </Panel>
          </section>
          <StatusLine>{statusText}</StatusLine>
        </>
      )}
    </AppShell>
  );
}
