"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { AppShell } from "@/components/app-shell";
import { EmptyBlock, Panel, RefreshButton, StatusLine } from "@/components/ui";
import { BarTrendChart, DonutChart, DonutSegment, StatTile } from "@/components/charts";
import { useAuth } from "@/components/auth-provider";
import { usePreferences } from "@/components/preferences-provider";
import { formatDuration, fullDate, metricTone } from "@/lib/format";
import {
  CatalogsResponse,
  DashboardResponse,
  SystemCompany,
  SystemOverviewResponse,
} from "@/lib/types";
import { downloadAuthenticatedFile } from "@/lib/download-file";
import { addDaysISO, monthStartISO, todayISO } from "@/lib/dates";
import styles from "./dashboard.module.css";

type PeriodKey = "today" | "7d" | "month" | "custom";

const periodLabels: Record<Exclude<PeriodKey, "custom">, string> = {
  today: "Hoy",
  "7d": "7 días",
  month: "Mes",
};

const addDays = addDaysISO;

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

type Delta = { text: string; direction: "up" | "down"; tone: "plain" | "good" | "bad"; note: string };

/**
 * Comparacion con el periodo anterior en puntos porcentuales. Se omite cuando
 * no aporta: sin datos previos o sin cambio apreciable.
 */
function compareToPrevious(
  current: number,
  previous: number | undefined,
  hasPrevious: boolean,
  note: string,
  inverse = false,
): Delta | undefined {
  if (!hasPrevious || previous === undefined || previous === null) return undefined;
  const diff = current - previous;
  if (!Number.isFinite(diff) || Math.abs(diff) < 0.05) return undefined;
  const better = inverse ? diff < 0 : diff > 0;
  return {
    text: `${diff > 0 ? "+" : "−"}${Math.abs(diff).toFixed(1)} pts`,
    direction: diff > 0 ? "up" : "down",
    tone: better ? "good" : "bad",
    note,
  };
}

function valueTone(tone: "plain" | "good" | "warn" | "bad") {
  return tone === "good" ? "plain" : tone;
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
    if (!selectedDepartment) return t("General");
    return catalogs?.departments.find((department) => department.id === selectedDepartment)?.name || t("Departamento");
  }, [catalogs, selectedDepartment, t]);

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
      const current = activeCompanies.find((company) => company.id === activeCompanyId);
      if (!current) {
        setActiveCompanyId(activeCompanies[0]?.id || user?.company_id || "", activeCompanies[0]?.name);
      } else {
        setActiveCompanyId(current.id, current.name);
      }
    } catch {
      setStatusText(t("No se pudo cargar el listado de empresas"));
    }
  }, [activeCompanyId, apiGet, isSystemAdmin, setActiveCompanyId, t, user]);

  const loadDashboard = useCallback(async () => {
    if (isSystemAdmin && !activeCompanyId) {
      setStatusText(t("Selecciona una empresa en Sistema para ver el dashboard"));
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

  const hasPrevious = Boolean(previousTotals && previousTotals.total_seconds > 0);
  const comparisonNote = t("vs periodo anterior");
  const donutSegments: DonutSegment[] = totals
    ? [
        {
          key: "productive",
          label: t("Productivo"),
          value: Math.max(0, Math.round((totals.productivity_pct - totals.neutral_pct) * 10) / 10),
          slot: 1,
          detail: formatDuration(totals.productive_seconds),
        },
        { key: "neutral", label: t("Neutral"), value: totals.neutral_pct, slot: 2, detail: formatDuration(totals.neutral_seconds) },
        {
          key: "non-productive",
          label: t("No productivo"),
          value: totals.non_productive_pct,
          slot: 3,
          detail: formatDuration(totals.non_productive_seconds),
        },
        ...(totals.uncategorized_pct > 0
          ? [
              {
                key: "uncategorized",
                label: t("Sin clasificar"),
                value: totals.uncategorized_pct,
                slot: 5 as const,
                detail: formatDuration(totals.uncategorized_seconds),
              },
            ]
          : []),
      ]
    : [];

  return (
    <AppShell
      title={t("Dashboard")}
      description={`${selectedCompanyName} · ${selectedDepartmentName} · ${dateFrom === dateTo ? fullDate(dateTo) : `${fullDate(dateFrom)} – ${fullDate(dateTo)}`}`}
      actions={(
        <>
          <button className="btn btn-outline" onClick={downloadReport} disabled={reportLoading || !totals}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
              <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
              <path d="M14 2v6h6M12 18v-6M9 15l3 3 3-3" />
            </svg>
            <span>{reportLoading ? t("Generando PDF...") : t("Exportar PDF")}</span>
          </button>
          <RefreshButton loading={loading} onClick={loadDashboard} />
        </>
      )}
    >
      <section className={`toolbar ${styles.toolbar}`} aria-label={t("Filtros del dashboard")}>
        {isSystemAdmin ? (
          <select
            aria-label={t("Empresa")}
            value={activeCompanyId}
            onChange={(event) => {
              const company = companies.find((item) => item.id === event.target.value);
              setActiveCompanyId(event.target.value, company?.name);
              setSelectedDepartment("");
            }}
          >
            {companies.map((company) => (
              <option key={company.id} value={company.id}>{company.name}</option>
            ))}
          </select>
        ) : null}
        <select
          aria-label={t("Departamento")}
          value={selectedDepartment}
          onChange={(event) => setSelectedDepartment(event.target.value)}
        >
          <option value="">{t("Todos los departamentos")}</option>
          {(catalogs?.departments || []).map((department) => (
            <option key={department.id} value={department.id}>{department.name}</option>
          ))}
        </select>
        <span className={styles.divider} aria-hidden />
        <div className="segmented" role="group" aria-label={t("Periodo")}>
          {(Object.keys(periodLabels) as Array<Exclude<PeriodKey, "custom">>).map((key) => (
            <button key={key} type="button" aria-pressed={period === key} onClick={() => applyPeriod(key)}>
              {t(periodLabels[key])}
            </button>
          ))}
        </div>
        <div className={styles.range}>
          <input
            type="date"
            aria-label={t("Desde")}
            value={dateFrom}
            max={dateTo || undefined}
            onChange={(event) => {
              setPeriod("custom");
              setDateFrom(event.target.value);
            }}
          />
          <span aria-hidden>–</span>
          <input
            type="date"
            aria-label={t("Hasta")}
            value={dateTo}
            min={dateFrom || undefined}
            onChange={(event) => {
              setPeriod("custom");
              setDateTo(event.target.value);
            }}
          />
        </div>
      </section>

      {!totals ? (
        <EmptyBlock
          title={statusText || t("Cargando datos...")}
          description={loading ? undefined : t("Ajusta la empresa, el departamento o el periodo para ver resultados.")}
        />
      ) : (
        <>
          <section className={styles.kpis} aria-label={t("Indicadores")}>
            <StatTile
              label={t("Tiempo activo")}
              value={formatDuration(totals.active_seconds)}
              detail={`${t("Total registrado")}: ${formatDuration(totals.total_seconds)}`}
            />
            <StatTile
              label={t("Productividad")}
              marker={1}
              value={`${totals.productivity_pct}%`}
              valueTone={valueTone(metricTone(totals.productivity_pct))}
              detail={`${formatDuration(totals.productive_seconds + totals.neutral_seconds)} ${t("productivo + neutral")}`}
              delta={compareToPrevious(totals.productivity_pct, previousTotals?.productivity_pct, hasPrevious, comparisonNote)}
            />
            <StatTile
              label={t("No productivo")}
              marker={3}
              value={`${totals.non_productive_pct}%`}
              valueTone={totals.non_productive_pct > 12 ? "bad" : "plain"}
              detail={formatDuration(totals.non_productive_seconds)}
              delta={compareToPrevious(totals.non_productive_pct, previousTotals?.non_productive_pct, hasPrevious, comparisonNote, true)}
            />
            <StatTile
              label={t("Inactivo")}
              marker={4}
              value={`${totals.idle_pct}%`}
              valueTone={totals.idle_pct > 15 ? "warn" : "plain"}
              detail={formatDuration(totals.idle_seconds)}
              delta={compareToPrevious(totals.idle_pct, previousTotals?.idle_pct, hasPrevious, comparisonNote, true)}
            />
          </section>

          <section className={styles.charts}>
            <Panel
              title={t("Tendencia de productividad")}
              meta={`${t("Últimos")} ${trendPoints.length} ${trendPoints.length === 1 ? t("día") : t("días")}`}
            >
              <BarTrendChart
                points={trendPoints}
                emptyLabel={t("Sin datos suficientes para graficar.")}
                seriesLabel={t("Productividad diaria")}
                averageLabel={t("Promedio")}
              />
            </Panel>

            <Panel title={t("Composición del tiempo")} meta={`${formatDuration(totals.active_seconds)} ${t("activos")}`}>
              <DonutChart
                segments={donutSegments}
                centerValue={`${totals.productivity_pct}%`}
                centerLabel={t("productivo + neutral")}
                ariaLabel={`${t("Productivo")} ${totals.productivity_pct}%`}
              />
            </Panel>
          </section>
          <StatusLine>{statusText}</StatusLine>
        </>
      )}
    </AppShell>
  );
}
