"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { AppShell } from "@/components/app-shell";
import { EmptyState, Panel, RefreshButton, StatCard, StatusLine } from "@/components/ui";
import { useAuth } from "@/components/auth-provider";
import { usePreferences } from "@/components/preferences-provider";
import { formatDuration, fullDate, metricTone } from "@/lib/format";
import {
  CatalogsResponse,
  DashboardResponse,
  DashboardTotals,
  SystemCompany,
  SystemOverviewResponse,
} from "@/lib/types";
import { downloadAuthenticatedFile } from "@/lib/download-file";

type PeriodKey = "today" | "7d" | "month" | "custom";
type TrendPoint = { key: string; label: string; value: number };

const periodLabels: Record<Exclude<PeriodKey, "custom">, string> = {
  today: "Hoy",
  "7d": "7 dias",
  month: "Mes",
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

function rangeForPeriod(period: Exclude<PeriodKey, "custom">) {
  const today = todayISO();
  if (period === "7d") return { dateFrom: addDays(today, -6), dateTo: today };
  if (period === "month") return { dateFrom: monthStartISO(), dateTo: today };
  return { dateFrom: today, dateTo: today };
}

function previousRange(dateFrom: string, dateTo: string) {
  const length = daySpanInclusive(dateFrom, dateTo);
  const previousTo = addDays(dateFrom, -1);
  return { dateFrom: addDays(previousTo, 1 - length), dateTo: previousTo };
}

function buildParams({
  dateFrom,
  dateTo,
  companyId,
  departmentId,
}: {
  dateFrom: string;
  dateTo: string;
  companyId: string;
  departmentId: string;
}) {
  const params = new URLSearchParams();
  if (dateFrom) params.set("date_from", dateFrom);
  if (dateTo) params.set("date_to", dateTo);
  if (companyId) params.set("company_id", companyId);
  if (departmentId) params.set("department_id", departmentId);
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
  const { apiGet, token, activeCompanyId, setActiveCompanyId, user } = useAuth();
  const [dashboard, setDashboard] = useState<DashboardResponse | null>(null);
  const [previousDashboard, setPreviousDashboard] = useState<DashboardResponse | null>(null);
  const [catalogs, setCatalogs] = useState<CatalogsResponse | null>(null);
  const [companies, setCompanies] = useState<SystemCompany[]>([]);
  const [period, setPeriod] = useState<PeriodKey>("month");
  const [dateFrom, setDateFrom] = useState(monthStartISO());
  const [dateTo, setDateTo] = useState(todayISO());
  const [selectedDepartment, setSelectedDepartment] = useState("");
  const [statusText, setStatusText] = useState("");
  const [loading, setLoading] = useState(false);
  const [reportLoading, setReportLoading] = useState(false);

  const { t } = usePreferences();
  const isSystemAdmin = user?.role === "system_admin";
  const effectiveCompanyId = isSystemAdmin ? activeCompanyId : "";

  const currentParams = useMemo(
    () => buildParams({ dateFrom, dateTo, companyId: effectiveCompanyId, departmentId: selectedDepartment }),
    [dateFrom, dateTo, effectiveCompanyId, selectedDepartment],
  );
  const totals = dashboard?.totals;
  const previousTotals = previousDashboard?.totals;

  const selectedCompanyName = useMemo(() => {
    if (!isSystemAdmin) return user?.company || t("Empresa");
    return companies.find((company) => company.id === activeCompanyId)?.name || user?.company || t("Empresa");
  }, [activeCompanyId, companies, isSystemAdmin, t, user?.company]);

  const selectedDepartmentName = useMemo(() => {
    if (!selectedDepartment) return "General";
    return catalogs?.departments.find((department) => department.id === selectedDepartment)?.name || "Departamento";
  }, [catalogs, selectedDepartment]);

  const trendPoints = useMemo(
    () =>
      (dashboard?.days || []).slice(-7).map((day) => ({
        key: day.block_date,
        label: fullDate(day.block_date).slice(0, 5),
        value: day.productivity_pct,
      })),
    [dashboard],
  );

  const loadCompanies = useCallback(async () => {
    if (!isSystemAdmin) return;
    try {
      const response = await apiGet<SystemOverviewResponse>("/api/system/overview");
      const activeCompanies = response.companies.filter((company) => company.status === "active");
      setCompanies(activeCompanies);
      if (!activeCompanies.some((company) => company.id === activeCompanyId)) {
        setActiveCompanyId(activeCompanies[0]?.id || user?.company_id || "");
      }
    } catch {
      setStatusText("No se pudo cargar el listado de empresas");
    }
  }, [activeCompanyId, apiGet, isSystemAdmin, setActiveCompanyId, user]);

  const loadDashboard = useCallback(async () => {
    if (isSystemAdmin && !activeCompanyId) {
      setStatusText("Selecciona una empresa en Sistema para ver el dashboard");
      return;
    }
    setLoading(true);
    setStatusText(t("Actualizando datos..."));
    const previous = previousRange(dateFrom, dateTo);
    const previousParams = buildParams({
      dateFrom: previous.dateFrom,
      dateTo: previous.dateTo,
      companyId: effectiveCompanyId,
      departmentId: selectedDepartment,
    });

    try {
      const catalogQuery = effectiveCompanyId ? `?company_id=${effectiveCompanyId}` : "";
      const [nextDashboard, nextPrevious, nextCatalogs] = await Promise.all([
        apiGet<DashboardResponse>(`/api/productivity/dashboard?${currentParams.toString()}`),
        apiGet<DashboardResponse>(`/api/productivity/dashboard?${previousParams.toString()}`),
        apiGet<CatalogsResponse>(`/api/productivity/catalogs${catalogQuery}`),
      ]);
      setDashboard(nextDashboard);
      setPreviousDashboard(nextPrevious);
      setCatalogs(nextCatalogs);
      setStatusText(t("Datos actualizados"));
    } catch {
      setStatusText(t("No se pudieron cargar los datos"));
    } finally {
      setLoading(false);
    }
  }, [activeCompanyId, apiGet, currentParams, dateFrom, dateTo, effectiveCompanyId, isSystemAdmin, selectedDepartment, t]);

  useEffect(() => {
    if (!user) return;
    const timer = window.setTimeout(() => {
      void loadCompanies();
    }, 0);
    return () => window.clearTimeout(timer);
  }, [loadCompanies, user]);

  useEffect(() => {
    if (!user) return;
    const timer = window.setTimeout(() => {
      void loadDashboard();
    }, 0);
    return () => window.clearTimeout(timer);
  }, [loadDashboard, user]);

  useEffect(() => {
    if (!isSystemAdmin) return;
    const timer = window.setTimeout(() => {
      setSelectedDepartment("");
      setCatalogs(null);
      setDashboard(null);
      setPreviousDashboard(null);
    }, 0);
    return () => window.clearTimeout(timer);
  }, [activeCompanyId, isSystemAdmin]);

  function applyPeriod(nextPeriod: Exclude<PeriodKey, "custom">) {
    const nextRange = rangeForPeriod(nextPeriod);
    setPeriod(nextPeriod);
    setDateFrom(nextRange.dateFrom);
    setDateTo(nextRange.dateTo);
  }

  async function downloadReport() {
    setReportLoading(true);
    setStatusText(t("Generando PDF..."));
    try {
      const query = currentParams.toString();
      await downloadAuthenticatedFile(`/api/reports/operations.pdf${query ? `?${query}` : ""}`, token, "vyntra-reporte-productividad.pdf");
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
      description={`${selectedCompanyName} · ${selectedDepartmentName} · ${dateFrom === dateTo ? fullDate(dateTo) : `${fullDate(dateFrom)} - ${fullDate(dateTo)}`}`}
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
      <section className="dashboard-control-panel" aria-label="Filtros del dashboard">
        <div className="dashboard-filter-group">
          <span>Alcance</span>
          <div className={isSystemAdmin ? "dashboard-scope-grid system" : "dashboard-scope-grid"}>
            {isSystemAdmin ? (
              <label>
                <small>Empresa</small>
                <select value={activeCompanyId} onChange={(event) => {
                  setActiveCompanyId(event.target.value);
                  setSelectedDepartment("");
                }}>
                  {companies.map((company) => (
                    <option key={company.id} value={company.id}>{company.name}</option>
                  ))}
                </select>
              </label>
            ) : null}
            <label>
              <small>Departamento</small>
              <select value={selectedDepartment} onChange={(event) => setSelectedDepartment(event.target.value)}>
                <option value="">General</option>
                {(catalogs?.departments || []).map((department) => (
                  <option key={department.id} value={department.id}>{department.name}</option>
                ))}
              </select>
            </label>
          </div>
        </div>

        <div className="dashboard-filter-group">
          <span>Periodo</span>
          <div className="dashboard-period-control">
            <div className="period-tabs compact">
              {(Object.keys(periodLabels) as Array<Exclude<PeriodKey, "custom">>).map((key) => (
                <button key={key} type="button" className={period === key ? "active" : undefined} onClick={() => applyPeriod(key)}>
                  {periodLabels[key]}
                </button>
              ))}
            </div>
            <label>
              <small>Desde</small>
              <input type="date" value={dateFrom} onChange={(event) => {
                setPeriod("custom");
                setDateFrom(event.target.value);
              }} />
            </label>
            <label>
              <small>Hasta</small>
              <input type="date" value={dateTo} onChange={(event) => {
                setPeriod("custom");
                setDateTo(event.target.value);
              }} />
            </label>
          </div>
        </div>
      </section>

      {!totals ? (
        <Panel title={t("Estado")}>
          <EmptyState>{statusText || t("Cargando datos...")}</EmptyState>
        </Panel>
      ) : (
        <>
          <section className="stats-grid dashboard-metric-grid">
            <StatCard
              label={t("Productividad")}
              value={`${totals.productivity_pct}%`}
              detail={`${formatDuration(totals.productive_seconds)} productivo`}
              tone={metricTone(totals.productivity_pct)}
              delta={trendDelta(totals.productivity_pct, previousTotals?.productivity_pct)}
              deltaTone={deltaTone(trendDelta(totals.productivity_pct, previousTotals?.productivity_pct))}
            />
            <StatCard
              label={t("Aceptable")}
              value={`${totals.acceptable_pct}%`}
              detail={`${formatDuration(totals.neutral_seconds + totals.justified_seconds)} neutral/justificado`}
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

          <section className="chart-grid-2 dashboard-main-grid">
            <Panel title={t("Tendencia de productividad")} meta={`${trendPoints.length} dias`}>
              <DailyBarTrend points={trendPoints} />
            </Panel>

            <Panel title={t("Composición del tiempo")} meta={formatDuration(totals.active_seconds)}>
              <TimeDonut totals={totals} />
            </Panel>
          </section>
          <StatusLine>{statusText}</StatusLine>
        </>
      )}
    </AppShell>
  );
}
