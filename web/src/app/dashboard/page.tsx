"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { AppShell } from "@/components/app-shell";
import { EmptyState, Panel, RefreshButton, StatCard, StatusLine } from "@/components/ui";
import { useAuth } from "@/components/auth-provider";
import { usePreferences } from "@/components/preferences-provider";
import { CompositionChart, CompositionSegment, TrendChart } from "@/components/charts";
import { formatDuration, formatPercent, fullDate, metricTone } from "@/lib/format";
import { CatalogsResponse, DashboardResponse, UncategorizedItem } from "@/lib/types";

export default function DashboardPage() {
  const { apiGet, user } = useAuth();
  const [dashboard, setDashboard] = useState<DashboardResponse | null>(null);
  const [uncategorized, setUncategorized] = useState<UncategorizedItem[]>([]);
  const [catalogs, setCatalogs] = useState<CatalogsResponse | null>(null);
  const [statusText, setStatusText] = useState("");
  const [loading, setLoading] = useState(false);

  const { t } = usePreferences();
  const totals = dashboard?.totals;
  const topDays = useMemo(() => dashboard?.days.slice(-7).reverse() || [], [dashboard]);
  const headcount = catalogs?.employees.length || 0;

  // Tendencia de productividad en orden cronológico.
  const trendPoints = useMemo(
    () =>
      (dashboard?.days || []).slice(-14).map((day) => ({
        key: day.block_date,
        label: fullDate(day.block_date).slice(0, 5),
        value: day.productivity_pct,
      })),
    [dashboard],
  );

  // Reparto del tiempo activo entre las cuatro categorías.
  const composition = useMemo<CompositionSegment[]>(() => {
    if (!totals) return [];
    return [
      { key: "prod", label: t("Productivo"), seconds: totals.productive_seconds, slot: 1,
        display: formatDuration(totals.productive_seconds) },
      { key: "neu", label: t("Neutral"), seconds: totals.neutral_seconds, slot: 2,
        display: formatDuration(totals.neutral_seconds) },
      { key: "non", label: t("No productivo"), seconds: totals.non_productive_seconds, slot: 3,
        display: formatDuration(totals.non_productive_seconds) },
      { key: "idle", label: t("Idle"), seconds: totals.idle_seconds, slot: 4,
        display: formatDuration(totals.idle_seconds) },
    ];
  }, [t, totals]);

  // Reparto de personal por departamento, de mayor a menor.
  const departmentRows = useMemo(() => {
    if (!catalogs) return [];
    return catalogs.departments
      .map((department) => ({
        id: department.id,
        name: department.name,
        total: catalogs.employees.filter((e) => e.department_id === department.id).length,
      }))
      .sort((a, b) => b.total - a.total || a.name.localeCompare(b.name, "es"));
  }, [catalogs]);

  const loadDashboard = useCallback(async () => {
    setLoading(true);
    setStatusText(t("Actualizando datos..."));
    try {
      const [nextDashboard, nextUncategorized, nextCatalogs] = await Promise.all([
        apiGet<DashboardResponse>("/api/productivity/dashboard"),
        apiGet<{ items: UncategorizedItem[] }>("/api/productivity/uncategorized?limit=8"),
        apiGet<CatalogsResponse>("/api/productivity/catalogs"),
      ]);
      setDashboard(nextDashboard);
      setUncategorized(nextUncategorized.items);
      setCatalogs(nextCatalogs);
      setStatusText(t("Datos actualizados"));
    } catch {
      setStatusText(t("No se pudieron cargar los datos"));
    } finally {
      setLoading(false);
    }
  }, [apiGet, t]);

  useEffect(() => {
    if (!user) return;
    const timer = window.setTimeout(() => {
      void loadDashboard();
    }, 0);
    return () => window.clearTimeout(timer);
  }, [loadDashboard, user]);

  return (
    <AppShell
      title={t("Dashboard")}
      description={`${user?.company || t("Empresa")} · ${t("productividad calculada desde actividad real del agente.")}`}
      actions={<RefreshButton loading={loading} onClick={loadDashboard} />}
    >
      {!totals ? (
        <Panel title={t("Estado")}>
          <EmptyState>{statusText || t("Cargando datos...")}</EmptyState>
        </Panel>
      ) : (
        <>
          <section className="stats-grid">
            <StatCard
              label={t("Productividad")}
              value={`${totals.productivity_pct}%`}
              detail={`${formatDuration(totals.productive_seconds)} ${t("productivo")}`}
              tone={metricTone(totals.productivity_pct)}
            />
            <StatCard
              label={t("Aceptable")}
              value={`${totals.acceptable_pct}%`}
              detail={t("Productivo + neutral")}
              tone={metricTone(totals.acceptable_pct)}
            />
            <StatCard
              label={t("No productivo")}
              value={`${totals.non_productive_pct}%`}
              detail={formatDuration(totals.non_productive_seconds)}
              tone={totals.non_productive_pct > 12 ? "bad" : "plain"}
            />
            <StatCard
              label={t("Idle")}
              value={`${totals.idle_pct}%`}
              detail={formatDuration(totals.idle_seconds)}
              tone={totals.idle_pct > 15 ? "warn" : "plain"}
            />
          </section>

          <section className="insight-strip" aria-label={t("Ajustes operativos")}>
            <div>
              <span>{t("Tiempo justificado")}</span>
              <strong>{formatDuration(totals.justified_seconds)}</strong>
              <small>{t("Aprobado por incidencias")}</small>
            </div>
            <p>
              {totals.justified_seconds
                ? t("Ese tiempo entra como neutral y evita castigar la productividad por fallas aprobadas.")
                : t("No hay tiempo ajustado por incidencias en este periodo.")}
            </p>
          </section>

          <section className="chart-grid-2">
            <Panel title={t("Tendencia de productividad")} meta={`${trendPoints.length} ${t("últimos días")}`}>
              <TrendChart
                points={trendPoints}
                emptyLabel={t("Sin datos suficientes para graficar.")}
                averageLabel={t("Promedio del periodo")}
              />
            </Panel>

            <Panel title={t("Composición del tiempo")} meta={formatDuration(totals.active_seconds)}>
              <CompositionChart
                segments={composition}
                emptyLabel={t("Sin datos suficientes para graficar.")}
              />
            </Panel>
          </section>

          <section className="work-grid">
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

            <Panel
              title={t("Organización")}
              meta={`${headcount} ${headcount === 1 ? t("empleado") : t("empleados")}`}
            >
              {departmentRows.length ? (
                <div className="dept-list">
                  {departmentRows.map((row) => (
                    <div key={row.id}>
                      <strong>{row.name}</strong>
                      <span className={row.total === 0 ? "zero" : undefined}>{row.total}</span>
                    </div>
                  ))}
                </div>
              ) : (
                <EmptyState>{t("Aun no hay departamentos configurados.")}</EmptyState>
              )}
            </Panel>
          </section>
          <StatusLine>{statusText}</StatusLine>
        </>
      )}
    </AppShell>
  );
}
