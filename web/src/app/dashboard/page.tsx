"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { AppShell } from "@/components/app-shell";
import { AttentionItem, AttentionList, EmptyBlock, Panel, RefreshButton } from "@/components/ui";
import { BarTrendChart, CompositionChart, CompositionSegment, swatchClass } from "@/components/charts";
import { useAuth } from "@/components/auth-provider";
import { usePreferences } from "@/components/preferences-provider";
import { formatDuration, fullDate, metricTone } from "@/lib/format";
import {
  AttendanceOverviewResponse,
  CatalogsResponse,
  DashboardResponse,
  DevicesResponse,
  Incident,
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

/** Meta de productividad y umbral aceptable (los mismos que usa metricTone). */
const PRODUCTIVITY_TARGET = 85;
const PRODUCTIVITY_ACCEPTABLE = 65;


type IncidentResponse = {
  company: { id: string; name: string };
  count: number;
  incidents: Incident[];
};

type OperationsSnapshot = {
  pendingIncidents: number;
  firstIncidentLabel: string;
  offlineDevices: number;
  firstOfflineDevice: string;
  working: number;
  paused: number;
  missing: number;
  totalEmployees: number;
};

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
    tone: Math.abs(diff) <= 1 ? "plain" : better ? "good" : "bad",
    note,
  };
}

/** Variacion relativa (%) para magnitudes como horas activas. */
function relativeChange(current: number, previous: number | undefined, hasPrevious: boolean, note: string): Delta | undefined {
  if (!hasPrevious || !previous) return undefined;
  const change = ((current - previous) / previous) * 100;
  if (!Number.isFinite(change) || Math.abs(change) < 0.5) return undefined;
  return {
    text: `${change > 0 ? "+" : "−"}${Math.abs(change).toFixed(0)}%`,
    direction: change > 0 ? "up" : "down",
    tone: Math.abs(change) < 3 ? "plain" : change > 0 ? "good" : "bad",
    note,
  };
}

function DeltaChip({ delta, compact = false }: { delta: Delta; compact?: boolean }) {
  return (
    <span className={`${styles.delta} ${styles[`delta${delta.tone === "good" ? "Good" : delta.tone === "bad" ? "Bad" : "Plain"}`]}`}>
      <svg viewBox="0 0 24 24" aria-hidden>
        {delta.direction === "up" ? <path d="M12 19V5M5 12l7-7 7 7" /> : <path d="M12 5v14M19 12l-7 7-7-7" />}
      </svg>
      {delta.text}
      {compact ? null : <span className={styles.deltaNote}>{delta.note}</span>}
    </span>
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
  const [operationsSnapshot, setOperationsSnapshot] = useState<OperationsSnapshot | null>(null);

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

  const loadOperationsSnapshot = useCallback(async () => {
    if (isSystemAdmin && !activeCompanyId) return;
    const companyQuery = effectiveCompanyId ? `company_id=${encodeURIComponent(effectiveCompanyId)}` : "";
    const departmentQuery = selectedDepartment ? `department_id=${encodeURIComponent(selectedDepartment)}` : "";
    const scoped = [companyQuery, departmentQuery].filter(Boolean).join("&");
    const scopedSuffix = scoped ? `&${scoped}` : "";
    const scopedQuery = scoped ? `?${scoped}` : "";
    const today = todayISO();
    const [incidentsResult, devicesResult, attendanceResult] = await Promise.allSettled([
      apiGet<IncidentResponse>(`/api/incidents?status_filter=pending${scopedSuffix}`),
      apiGet<DevicesResponse>(`/api/devices${scopedQuery}`),
      apiGet<AttendanceOverviewResponse>(`/api/attendance/overview?date_from=${today}&date_to=${today}${scopedSuffix}`),
    ]);

    const pendingIncidents = incidentsResult.status === "fulfilled"
      ? incidentsResult.value.incidents.filter((incident) => incident.status === "pending")
      : [];
    const offlineDevices = devicesResult.status === "fulfilled"
      ? devicesResult.value.devices.filter((device) => device.status === "offline" || !device.is_active)
      : [];
    const attendance = attendanceResult.status === "fulfilled" ? attendanceResult.value : null;
    const employees = (attendance?.employees || []).filter((employee) => employee.status === "active");
    const latestShift = new Map<string, NonNullable<AttendanceOverviewResponse["shifts"]>[number]>();
    (attendance?.shifts || []).forEach((shift) => {
      if (!latestShift.has(shift.employee_id)) latestShift.set(shift.employee_id, shift);
    });
    let working = 0;
    let paused = 0;
    employees.forEach((employee) => {
      const shift = latestShift.get(employee.id);
      const phase = (shift?.current_phase || "").toUpperCase();
      if (!shift?.started_at || shift.ended_at || shift.status === "closed" || phase === "TERMINADO") return;
      if (phase === "BREAK" || phase === "LUNCH" || phase === "PAUSADO") paused += 1;
      else working += 1;
    });

    setOperationsSnapshot({
      pendingIncidents: pendingIncidents.length,
      firstIncidentLabel: pendingIncidents[0]?.employee || pendingIncidents[0]?.title || t("Incidencia pendiente"),
      offlineDevices: offlineDevices.length,
      firstOfflineDevice: offlineDevices[0]?.hostname || offlineDevices[0]?.name || t("Equipo sin conexion"),
      working,
      paused,
      missing: Math.max(0, employees.length - working - paused),
      totalEmployees: employees.length,
    });
  }, [activeCompanyId, apiGet, effectiveCompanyId, isSystemAdmin, selectedDepartment, t]);

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
      void loadOperationsSnapshot();
    } catch {
      setStatusText(t("No se pudieron cargar los datos"));
    } finally {
      setLoading(false);
    }
  }, [activeCompanyId, apiGet, currentParams, dateFrom, dateTo, effectiveCompanyId, isSystemAdmin, loadOperationsSnapshot, selectedDepartment, t]);

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

  const composition: CompositionSegment[] = totals
    ? [
        { key: "productive", label: t("Productivo"), seconds: totals.productive_seconds, slot: 1, display: formatDuration(totals.productive_seconds) },
        { key: "neutral", label: t("Neutral"), seconds: totals.neutral_seconds, slot: 2, display: formatDuration(totals.neutral_seconds) },
        {
          key: "non-productive",
          label: t("No productivo"),
          seconds: totals.non_productive_seconds,
          slot: 3,
          display: formatDuration(totals.non_productive_seconds),
        },
        ...(totals.uncategorized_seconds > 0
          ? [
              {
                key: "uncategorized",
                label: t("Sin clasificar"),
                seconds: totals.uncategorized_seconds,
                slot: 5 as const,
                display: formatDuration(totals.uncategorized_seconds),
              },
            ]
          : []),
        { key: "idle", label: t("Inactivo"), seconds: totals.idle_seconds, slot: 4, display: formatDuration(totals.idle_seconds) },
      ]
    : [];

  const employeeFollowUp = useMemo(() => {
    if (!dashboard) return [];
    const names = new Map((catalogs?.employees || []).map((employee) => [employee.id, employee]));
    const departments = new Map((catalogs?.departments || []).map((department) => [department.id, department.name]));
    const totalsByEmployee = new Map<string, { active: number; good: number }>();
    dashboard.blocks.forEach((block) => {
      if (!block.employee_id) return;
      const row = totalsByEmployee.get(block.employee_id) || { active: 0, good: 0 };
      row.active += block.active_seconds || 0;
      row.good += (block.productive_seconds || 0) + (block.neutral_seconds || 0);
      totalsByEmployee.set(block.employee_id, row);
    });
    return Array.from(totalsByEmployee.entries())
      .filter(([, row]) => row.active >= 600)
      .map(([id, row]) => {
        const employee = names.get(id);
        return {
          id,
          name: employee?.full_name || t("Empleado"),
          department: (employee?.department_id && departments.get(employee.department_id)) || "",
          pct: Math.round((row.good / row.active) * 1000) / 10,
          active: row.active,
        };
      })
      .sort((a, b) => a.pct - b.pct);
  }, [catalogs, dashboard, t]);

  const productivityDelta = totals ? compareToPrevious(totals.productivity_pct, previousTotals?.productivity_pct, hasPrevious, comparisonNote) : undefined;
  const productivityStatus = totals ? metricTone(totals.productivity_pct) : "plain";
  const statusLabel = productivityStatus === "good" ? t("En meta") : productivityStatus === "warn" ? t("Aceptable") : t("Bajo la meta");
  const activeDelta = totals ? relativeChange(totals.active_seconds, previousTotals?.active_seconds, hasPrevious, comparisonNote) : undefined;

  const attentionItems: AttentionItem[] = [];
  if (operationsSnapshot?.pendingIncidents) {
    attentionItems.push({
      key: "incidents",
      tone: "warn",
      title: `${operationsSnapshot.pendingIncidents} ${operationsSnapshot.pendingIncidents === 1 ? t("incidencia por revisar") : t("incidencias por revisar")}`,
      detail: operationsSnapshot.firstIncidentLabel,
      href: "/incidencias",
      action: t("Revisar"),
    });
  }
  if (operationsSnapshot?.offlineDevices) {
    attentionItems.push({
      key: "devices",
      tone: "bad",
      title: `${operationsSnapshot.offlineDevices} ${operationsSnapshot.offlineDevices === 1 ? t("equipo sin conexión") : t("equipos sin conexión")}`,
      detail: operationsSnapshot.firstOfflineDevice,
      href: "/dispositivos",
      action: t("Ver equipos"),
    });
  }
  if (operationsSnapshot && operationsSnapshot.missing > 0 && operationsSnapshot.totalEmployees > 0) {
    attentionItems.push({
      key: "attendance",
      tone: "info",
      title: `${operationsSnapshot.missing} ${t("de")} ${operationsSnapshot.totalEmployees} ${t("sin jornada activa ahora")}`,
      detail: t("Sin entrada registrada o jornada finalizada"),
      href: "/asistencia",
      action: t("Ver asistencia"),
    });
  }
  const live = operationsSnapshot;
  const liveTotal = live?.totalEmployees || 0;

  return (
    <AppShell
      title={t("Dashboard")}
      description={`${selectedCompanyName} · ${selectedDepartmentName} · ${dateFrom === dateTo ? fullDate(dateTo) : `${fullDate(dateFrom)} – ${fullDate(dateTo)}`}`}
      status={statusText}
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
          {/* 1. Resumen en una frase: lo primero que lee un jefe. */}
          <p className={styles.summary}>
            {t("El equipo registró")} <strong>{formatDuration(totals.active_seconds)}</strong> {t("de tiempo activo con")}{" "}
            <strong>{totals.productivity_pct}%</strong> {t("de productividad")}
            {productivityDelta ? (
              <>
                {" "}
                (<span className={styles[`text${productivityDelta.tone === "good" ? "Good" : "Bad"}`]}>{productivityDelta.text}</span> {comparisonNote})
              </>
            ) : null}
            .{" "}
            {attentionItems.length ? (
              <>
                {t("Hay")} <strong>{attentionItems.filter((item) => item.tone !== "info").length || attentionItems.length}</strong>{" "}
                {attentionItems.filter((item) => item.tone !== "info").length === 1 || (attentionItems.length === 1) ? t("tema que requiere tu atención.") : t("temas que requieren tu atención.")}
              </>
            ) : (
              t("No hay pendientes que requieran tu atención.")
            )}
          </p>

          {/* 2. Lo que requiere accion, con severidad. */}
          {live ? (
            <AttentionList
              items={attentionItems}
              label={t("Requiere tu atención")}
              empty={{ title: t("Todo en orden"), detail: t("Sin incidencias pendientes ni equipos desconectados.") }}
            />
          ) : null}

          {/* 3. El indicador principal, con meta y comparacion; a su lado, el estado en vivo. */}
          <section className={styles.heroGrid}>
            <article className={styles.hero} aria-label={t("Productividad del equipo")}>
              <header className={styles.heroHead}>
                <span>{t("Productividad del equipo")}</span>
                <span className={`${styles.statusChip} ${styles[productivityStatus]}`}>{statusLabel}</span>
              </header>
              <div className={styles.heroValueRow}>
                <strong className={styles.heroValue}>
                  {totals.productivity_pct}
                  <small>%</small>
                </strong>
                <div className={styles.heroCompare}>
                  {productivityDelta ? <DeltaChip delta={productivityDelta} /> : <span className={styles.deltaMuted}>{t("Sin comparación disponible")}</span>}
                  {hasPrevious && previousTotals ? (
                    <span>
                      {t("Periodo anterior")}: {previousTotals.productivity_pct}%
                    </span>
                  ) : null}
                </div>
              </div>

              <div className={styles.bullet} role="img" aria-label={`${t("Productividad")} ${totals.productivity_pct}%, ${t("meta")} ${PRODUCTIVITY_TARGET}%`}>
                <div className={styles.bulletTrack}>
                  <span className={styles.bulletZoneBad} style={{ width: `${PRODUCTIVITY_ACCEPTABLE}%` }} />
                  <span className={styles.bulletZoneWarn} style={{ width: `${PRODUCTIVITY_TARGET - PRODUCTIVITY_ACCEPTABLE}%` }} />
                  <span className={styles.bulletZoneGood} style={{ width: `${100 - PRODUCTIVITY_TARGET}%` }} />
                  <span className={styles.bulletValue} style={{ width: `${Math.min(100, Math.max(0, totals.productivity_pct))}%` }} />
                  <span className={styles.bulletTarget} style={{ left: `${PRODUCTIVITY_TARGET}%` }} />
                </div>
                <div className={styles.bulletScale} aria-hidden>
                  <span>0%</span>
                  <span style={{ left: `${PRODUCTIVITY_ACCEPTABLE}%` }}>{PRODUCTIVITY_ACCEPTABLE}%</span>
                  <span className={styles.bulletTargetLabel} style={{ left: `${PRODUCTIVITY_TARGET}%` }}>
                    {t("Meta")} {PRODUCTIVITY_TARGET}%
                  </span>
                  <span style={{ left: "100%" }}>100%</span>
                </div>
              </div>

              <div className={styles.heroSplit}>
                <span className={styles.heroSplitTitle}>{t("En qué se fue el tiempo")}</span>
                <CompositionChart segments={composition} emptyLabel={t("Sin actividad registrada en el periodo.")} />
              </div>
            </article>

            <article className={styles.live} aria-label={t("Ahora mismo")}>
              <header className={styles.heroHead}>
                <span>
                  <i className="live-dot" aria-hidden /> {t("Ahora mismo")}
                </span>
                <a href="/asistencia" className={styles.inlineLink}>
                  {t("Asistencia en vivo")}
                </a>
              </header>
              <strong className={styles.liveValue}>
                {live?.working ?? 0}
                <small>
                  {" "}
                  / {liveTotal} {t("trabajando")}
                </small>
              </strong>
              <div className={styles.liveBar} aria-hidden>
                {liveTotal > 0 ? (
                  <>
                    <span className={styles.liveWorking} style={{ flexGrow: live?.working || 0 }} />
                    <span className={styles.livePaused} style={{ flexGrow: live?.paused || 0 }} />
                    <span className={styles.liveMissing} style={{ flexGrow: live?.missing || 0 }} />
                  </>
                ) : null}
              </div>
              <ul className={styles.liveList}>
                <li>
                  <i className={styles.liveWorking} aria-hidden />
                  {t("Trabajando")}
                  <b>{live?.working ?? 0}</b>
                </li>
                <li>
                  <i className={styles.livePaused} aria-hidden />
                  {t("En pausa")}
                  <b>{live?.paused ?? 0}</b>
                </li>
                <li>
                  <i className={styles.liveMissing} aria-hidden />
                  {t("Sin jornada activa")}
                  <b>{live?.missing ?? 0}</b>
                </li>
              </ul>
            </article>
          </section>

          {/* 4. Indicadores de apoyo, con menos peso visual. */}
          <section className={styles.kpiStrip} aria-label={t("Indicadores")}>
            <div className={styles.kpi}>
              <span>{t("Tiempo activo")}</span>
              <strong>{formatDuration(totals.active_seconds)}</strong>
              <small>
                {activeDelta ? <DeltaChip delta={activeDelta} compact /> : null}
                {t("de")} {formatDuration(totals.total_seconds)} {t("registradas")}
              </small>
            </div>
            <div className={styles.kpi}>
              <span>
                <i className={swatchClass(3)} aria-hidden /> {t("No productivo")}
              </span>
              <strong>{totals.non_productive_pct}%</strong>
              <small>
                {(() => {
                  const delta = compareToPrevious(totals.non_productive_pct, previousTotals?.non_productive_pct, hasPrevious, comparisonNote, true);
                  return delta ? <DeltaChip delta={delta} compact /> : null;
                })()}
                {formatDuration(totals.non_productive_seconds)}
              </small>
            </div>
            <div className={styles.kpi}>
              <span>
                <i className={swatchClass(4)} aria-hidden /> {t("Inactivo")}
              </span>
              <strong>{totals.idle_pct}%</strong>
              <small>
                {(() => {
                  const delta = compareToPrevious(totals.idle_pct, previousTotals?.idle_pct, hasPrevious, comparisonNote, true);
                  return delta ? <DeltaChip delta={delta} compact /> : null;
                })()}
                {formatDuration(totals.idle_seconds)}
              </small>
            </div>
          </section>

          {/* 5. Detalle: tendencia y personas que requieren seguimiento. */}
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
                target={PRODUCTIVITY_TARGET}
                targetLabel={t("Meta")}
              />
            </Panel>

            <Panel title={t("Seguimiento del equipo")} meta={employeeFollowUp.length ? `${employeeFollowUp.length} ${t("personas con actividad")}` : undefined}>
              {employeeFollowUp.length ? (
                <ol className={styles.ranking}>
                  {employeeFollowUp.slice(0, 6).map((row) => {
                    const tone = metricTone(row.pct);
                    const params = new URLSearchParams({ date_from: dateFrom, date_to: dateTo });
                    return (
                      <li key={row.id}>
                        <a href={`/empleados/perfil/${row.id}?${params.toString()}`}>
                          <span className={styles.rankName}>
                            <strong>{row.name}</strong>
                            <small>{row.department || formatDuration(row.active)}</small>
                          </span>
                          <span className={styles.rankBar} aria-hidden>
                            <span className={styles[`rank${tone === "good" ? "Good" : tone === "warn" ? "Warn" : "Bad"}`]} style={{ width: `${Math.min(100, row.pct)}%` }} />
                            <i style={{ left: `${PRODUCTIVITY_TARGET}%` }} />
                          </span>
                          <b className={tone === "bad" ? styles.textBad : undefined}>{row.pct}%</b>
                        </a>
                      </li>
                    );
                  })}
                </ol>
              ) : (
                <EmptyBlock title={t("Sin actividad registrada en el periodo.")} description={t("Cuando los equipos reporten actividad verás aquí a quién dar seguimiento.")} />
              )}
              {employeeFollowUp.length ? <p className={styles.rankNote}>{t("Ordenado de menor a mayor productividad. La línea marca la meta.")}</p> : null}
            </Panel>
          </section>
        </>
      )}
    </AppShell>
  );
}
