"use client";

import { useEffect, useMemo, useState } from "react";
import { AppShell } from "@/components/app-shell";
import { EmptyState, Panel, RefreshButton, StatCard, StatusLine } from "@/components/ui";
import { useAuth } from "@/components/auth-provider";
import { formatDuration, formatPercent, fullDate, metricTone } from "@/lib/format";
import { CatalogsResponse, DashboardResponse, UncategorizedItem } from "@/lib/types";

export default function DashboardPage() {
  const { apiGet, user } = useAuth();
  const [dashboard, setDashboard] = useState<DashboardResponse | null>(null);
  const [uncategorized, setUncategorized] = useState<UncategorizedItem[]>([]);
  const [catalogs, setCatalogs] = useState<CatalogsResponse | null>(null);
  const [statusText, setStatusText] = useState("");
  const [loading, setLoading] = useState(false);

  const totals = dashboard?.totals;
  const topDays = useMemo(() => dashboard?.days.slice(-7).reverse() || [], [dashboard]);

  async function loadDashboard() {
    setLoading(true);
    setStatusText("Actualizando datos...");
    try {
      const [nextDashboard, nextUncategorized, nextCatalogs] = await Promise.all([
        apiGet<DashboardResponse>("/api/productivity/dashboard"),
        apiGet<{ items: UncategorizedItem[] }>("/api/productivity/uncategorized?limit=8"),
        apiGet<CatalogsResponse>("/api/productivity/catalogs"),
      ]);
      setDashboard(nextDashboard);
      setUncategorized(nextUncategorized.items);
      setCatalogs(nextCatalogs);
      setStatusText("Datos actualizados");
    } catch {
      setStatusText("No se pudieron cargar los datos");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    if (user) void loadDashboard();
  }, [user]);

  return (
    <AppShell
      title="Dashboard"
      description={`${user?.company || "Empresa"} - productividad calculada desde actividad real del agente.`}
      actions={<RefreshButton loading={loading} onClick={loadDashboard} />}
    >
      {!totals ? (
        <Panel title="Estado">
          <EmptyState>{statusText || "Cargando datos..."}</EmptyState>
        </Panel>
      ) : (
        <>
          <section className="stats-grid">
            <StatCard
              label="Productividad"
              value={`${totals.productivity_pct}%`}
              detail={`${formatDuration(totals.productive_seconds)} productivo`}
              tone={metricTone(totals.productivity_pct)}
            />
            <StatCard
              label="Aceptable"
              value={`${totals.acceptable_pct}%`}
              detail="Productivo + neutral"
              tone={metricTone(totals.acceptable_pct)}
            />
            <StatCard
              label="No productivo"
              value={`${totals.non_productive_pct}%`}
              detail={formatDuration(totals.non_productive_seconds)}
              tone={totals.non_productive_pct > 12 ? "bad" : "plain"}
            />
            <StatCard
              label="Idle"
              value={`${totals.idle_pct}%`}
              detail={formatDuration(totals.idle_seconds)}
              tone={totals.idle_pct > 15 ? "warn" : "plain"}
            />
          </section>

          <section className="work-grid">
            <Panel title="Resumen diario" meta={`${formatDuration(totals.active_seconds)} activos`} className="wide">
              <table>
                <thead>
                  <tr>
                    <th>Fecha</th>
                    <th>Activo</th>
                    <th>Productivo</th>
                    <th>Neutral</th>
                    <th>No productivo</th>
                    <th>Break</th>
                    <th>Lunch</th>
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
                      <td>{formatDuration(day.break_seconds)}</td>
                      <td>{formatDuration(day.lunch_seconds)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </Panel>

            <Panel title="Sin categorizar" meta={`${totals.uncategorized_pct}%`}>
              <div className="stack">
                {uncategorized.length ? (
                  uncategorized.map((item) => (
                    <article className="list-item" key={`${item.executable_name}-${item.title_text}`}>
                      <strong>{item.executable_name || "(desconocido)"}</strong>
                      <span>{item.title_text || "(sin titulo)"}</span>
                      <small>{formatDuration(item.seconds)} - {item.samples} muestras</small>
                    </article>
                  ))
                ) : (
                  <EmptyState>No hay actividad pendiente de clasificar.</EmptyState>
                )}
              </div>
            </Panel>

            <Panel title="Organizacion" meta={`${catalogs?.employees.length || 0} empleados`}>
              <div className="chips">
                {catalogs?.departments.map((department) => (
                  <span key={department.id}>{department.name}</span>
                ))}
              </div>
            </Panel>
          </section>
          <StatusLine>{statusText}</StatusLine>
        </>
      )}
    </AppShell>
  );
}
