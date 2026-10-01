"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { AppShell } from "@/components/app-shell";
import { Chip, EmptyBlock, RefreshButton } from "@/components/ui";
import { useAuth } from "@/components/auth-provider";
import { usePreferences } from "@/components/preferences-provider";
import {
  CatalogsResponse,
  DashboardResponse,
  ProductivityBlock,
} from "@/lib/types";
import { downloadCsv } from "@/lib/csv";
import { monthStartISO, todayISO } from "@/lib/dates";
import { formatDuration } from "@/lib/format";
import styles from "./empleados.module.css";

function initialsFor(name: string) {
  const initials = name
    .split(" ")
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase())
    .join("");
  return initials || "US";
}

function hours(seconds: number) {
  return `${Math.round((seconds / 3600) * 10) / 10}`;
}

function percent(part: number, total: number) {
  if (!total) return 0;
  return Math.max(0, Math.min(100, Math.round((part / total) * 100)));
}

export default function EmployeesPage() {
  const router = useRouter();
  const { apiGet, activeCompanyId, activeCompanyName, user } = useAuth();
  const { t } = usePreferences();
  const [catalogs, setCatalogs] = useState<CatalogsResponse | null>(null);
  const [dashboard, setDashboard] = useState<DashboardResponse | null>(null);
  const [dateFrom, setDateFrom] = useState(monthStartISO());
  const [dateTo, setDateTo] = useState(todayISO());
  const [searchTerm, setSearchTerm] = useState("");
  const [departmentFilter, setDepartmentFilter] = useState("");
  const [statusText, setStatusText] = useState("");
  const [loading, setLoading] = useState(false);

  const loadEmployees = useCallback(async () => {
    if (user?.role === "system_admin" && !activeCompanyId) {
      setCatalogs(null);
      setDashboard(null);
      setStatusText(t("Selecciona una empresa en Sistema para ver empleados"));
      return;
    }
    setLoading(true);
    setStatusText(t("Actualizando empleados..."));
    const params = new URLSearchParams();
    if (dateFrom) params.set("date_from", dateFrom);
    if (dateTo) params.set("date_to", dateTo);
    if (user?.role === "system_admin" && activeCompanyId) params.set("company_id", activeCompanyId);
    const query = params.toString();

    try {
      const [nextCatalogs, nextDashboard] = await Promise.all([
        apiGet<CatalogsResponse>(`/api/productivity/catalogs${query ? `?${query}` : ""}`),
        apiGet<DashboardResponse>(`/api/productivity/dashboard${query ? `?${query}` : ""}`),
      ]);
      setCatalogs(nextCatalogs);
      setDashboard(nextDashboard);
      setStatusText(t("Datos actualizados"));
    } catch {
      setStatusText(t("No se pudieron cargar los empleados"));
    } finally {
      setLoading(false);
    }
  }, [activeCompanyId, apiGet, dateFrom, dateTo, t, user?.role]);

  useEffect(() => {
    if (!user) return;
    const timer = window.setTimeout(() => {
      void loadEmployees();
    }, 0);
    return () => window.clearTimeout(timer);
  }, [loadEmployees, user]);

  const employees = useMemo(() => catalogs?.employees || [], [catalogs]);
  const departmentMap = useMemo(
    () => new Map(catalogs?.departments.map((department) => [department.id, department.name])),
    [catalogs],
  );
  const positionMap = useMemo(
    () => new Map(catalogs?.positions.map((position) => [position.id, position.name])),
    [catalogs],
  );
  const blocksByEmployee = useMemo(() => {
    const rows = new Map<string, ProductivityBlock[]>();
    (dashboard?.blocks || []).forEach((block) => {
      rows.set(block.employee_id, [...(rows.get(block.employee_id) || []), block]);
    });
    return rows;
  }, [dashboard]);

  const employeeRows = useMemo(
    () =>
      employees
        .map((employee) => {
          const blocks = blocksByEmployee.get(employee.id) || [];
          const totals = blocks.reduce(
            (sum, block) => ({
              // `|| 0`: un bloque incompleto no debe convertir la fila en NaN.
              active: sum.active + (block.active_seconds || 0),
              productive: sum.productive + (block.productive_seconds || 0),
              nonProductive: sum.nonProductive + (block.non_productive_seconds || 0),
              neutral: sum.neutral + (block.neutral_seconds || 0),
              idle: sum.idle + (block.idle_seconds || 0),
              breakLunch: sum.breakLunch + (block.break_seconds || 0) + (block.lunch_seconds || 0),
            }),
            { active: 0, productive: 0, nonProductive: 0, neutral: 0, idle: 0, breakLunch: 0 },
          );
          return {
            employee,
            blocks,
            totals,
            department: employee.department_id
              ? departmentMap.get(employee.department_id) || t("Sin departamento")
              : t("Sin departamento"),
            position: employee.position_id ? positionMap.get(employee.position_id) || "" : "",
          };
        })
        .filter((row) => !departmentFilter || row.employee.department_id === departmentFilter)
        .filter((row) => {
          const needle = searchTerm.trim().toLowerCase();
          if (!needle) return true;
          return [row.employee.full_name, row.employee.email, row.department, row.position, row.employee.employee_code]
            .join(" ")
            .toLowerCase()
            .includes(needle);
        }),
    [blocksByEmployee, departmentFilter, departmentMap, employees, positionMap, searchTerm, t],
  );

  function openEmployeeProfile(employeeId: string) {
    const params = new URLSearchParams();
    if (dateFrom) params.set("date_from", dateFrom);
    if (dateTo) params.set("date_to", dateTo);
    router.push(`/empleados/perfil/${employeeId}?${params.toString()}`);
  }

  function exportCsv() {
    const header = [
      t("Nombre del empleado"),
      t("Equipo"),
      t("Ubicacion"),
      t("Actividad [h]"),
      t("Productivo [h]"),
      t("Improductivo [h]"),
      t("Neutral [h]"),
      t("Tiempo inactivo [h]"),
      t("Descanso [h]"),
    ];
    const rows = employeeRows.map((row) => [
        row.employee.full_name,
        row.employee.employee_code,
        row.department,
        hours(row.totals.active),
        hours(row.totals.productive),
        hours(row.totals.nonProductive),
        hours(row.totals.neutral),
        hours(row.totals.idle),
        hours(row.totals.breakLunch),
    ]);
    downloadCsv(`vyntra-empleados-${dateFrom}-${dateTo}.csv`, header, rows);
  }

  const hasFilters = Boolean(searchTerm.trim() || departmentFilter);
  const noCompany = user?.role === "system_admin" && !activeCompanyId;

  return (
    <AppShell
      title={t("Empleados")}
      description={`${activeCompanyName || dashboard?.company.name || user?.company || t("Empresa")} · ${t("actividad, productividad y detalle por usuario.")}`}
      status={statusText}
      actions={<RefreshButton loading={loading} onClick={loadEmployees} />}
    >
      <section className={`toolbar ${styles.toolbar}`} aria-label={t("Filtros")}>
        <label className={`search-input ${styles.search}`}>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden>
            <circle cx="11" cy="11" r="7" />
            <path d="m20 20-3.5-3.5" />
          </svg>
          <input
            type="search"
            value={searchTerm}
            onChange={(event) => setSearchTerm(event.target.value)}
            placeholder={t("Buscar empleado...")}
            aria-label={t("Buscar empleado...")}
          />
        </label>
        <select
          aria-label={t("Departamento")}
          value={departmentFilter}
          onChange={(event) => setDepartmentFilter(event.target.value)}
        >
          <option value="">{t("Todos los departamentos")}</option>
          {(catalogs?.departments || []).map((department) => (
            <option key={department.id} value={department.id}>{department.name}</option>
          ))}
        </select>
        <div className={styles.range} role="group" aria-label={t("Seleccionar fechas")}>
          <input
            type="date"
            aria-label={t("Desde")}
            value={dateFrom}
            max={dateTo || undefined}
            onChange={(event) => setDateFrom(event.target.value)}
          />
          <span aria-hidden>–</span>
          <input
            type="date"
            aria-label={t("Hasta")}
            value={dateTo}
            min={dateFrom || undefined}
            onChange={(event) => setDateTo(event.target.value)}
          />
        </div>
        <span className={styles.count}>
          {employeeRows.length} {employeeRows.length === 1 ? t("empleado") : t("empleados")}
        </span>
        <button className="btn btn-outline" onClick={exportCsv} disabled={!employeeRows.length}>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
            <path d="M12 4v11M7 10l5 5 5-5M5 20h14" />
          </svg>
          <span>{t("Exportar CSV")}</span>
        </button>
      </section>

      {employeeRows.length ? (
        <div className={styles.card}>
          <div className={styles.scroll}>
            <table className={styles.table}>
              <thead>
                <tr>
                  <th>{t("Nombre del empleado")}</th>
                  <th>{t("Departamento")}</th>
                  <th>{t("Ahora")}</th>
                  <th>{t("Distribución")}</th>
                  <th className="num">{t("Productividad")}</th>
                  <th className="num">{t("Actividad [h]")}</th>
                  <th aria-hidden />
                </tr>
              </thead>
              <tbody>
                {employeeRows.map((row) => {
                  const productivity = row.totals.active
                    ? Math.round(((row.totals.productive + row.totals.neutral) / row.totals.active) * 100)
                    : null;
                  const activeTotal = row.totals.productive + row.totals.neutral + row.totals.nonProductive + row.totals.idle + row.totals.breakLunch;
                  const nowTone = row.employee.status !== "active" ? "plain" : row.totals.active ? "good" : "warn";
                  const nowLabel = row.employee.status !== "active"
                    ? t("Inactivo")
                    : row.totals.active
                    ? t("Con actividad")
                    : t("Sin actividad");
                  return (
                    <tr
                      key={row.employee.id}
                      tabIndex={0}
                      onClick={() => openEmployeeProfile(row.employee.id)}
                      onKeyDown={(event) => {
                        if (event.key === "Enter" || event.key === " ") {
                          event.preventDefault();
                          openEmployeeProfile(row.employee.id);
                        }
                      }}
                      aria-label={`${t("Ver perfil de")} ${row.employee.full_name}`}
                    >
                      <td>
                        <div className={styles.person}>
                          <span className="avatar" aria-hidden>{initialsFor(row.employee.full_name)}</span>
                          <div>
                            <strong>{row.employee.full_name}</strong>
                            <small>
                              {row.employee.email || t("Sin correo laboral")} · <span className={styles.code}>{row.employee.employee_code}</span>
                            </small>
                          </div>
                        </div>
                      </td>
                      <td>
                        <span className={styles.metric}>{row.department}</span>
                        {row.position ? <small className={styles.subline}>{row.position}</small> : null}
                      </td>
                      <td>
                        <Chip tone={nowTone}>{nowLabel}</Chip>
                      </td>
                      <td>
                        {activeTotal ? (
                          <div className={styles.distribution} aria-label={`${t("Distribución")}: ${formatDuration(activeTotal)}`}>
                            <span style={{ width: `${percent(row.totals.productive, activeTotal)}%` }} className={styles.segmentProductive} />
                            <span style={{ width: `${percent(row.totals.neutral, activeTotal)}%` }} className={styles.segmentNeutral} />
                            <span style={{ width: `${percent(row.totals.nonProductive, activeTotal)}%` }} className={styles.segmentBad} />
                            <span style={{ width: `${percent(row.totals.idle, activeTotal)}%` }} className={styles.segmentIdle} />
                            <span style={{ width: `${percent(row.totals.breakLunch, activeTotal)}%` }} className={styles.segmentBreak} />
                          </div>
                        ) : (
                          <span className={styles.muted}>—</span>
                        )}
                        <small className={styles.subline}>
                          {activeTotal
                            ? `${t("Productivo")} ${formatDuration(row.totals.productive)} · ${t("Inactivo")} ${formatDuration(row.totals.idle)}`
                            : t("Sin actividad en el periodo")}
                        </small>
                      </td>
                      <td>
                        {productivity === null ? (
                          <span className={`num ${styles.muted} ${styles.block}`}>—</span>
                        ) : (
                          <div className={styles.productivity}>
                            <span className="num">{productivity}%</span>
                            <div className="usage-bar" aria-hidden>
                              <i style={{ width: `${Math.min(100, productivity)}%` }} />
                            </div>
                          </div>
                        )}
                      </td>
                      <td className={`num ${styles.metric}`}>{hours(row.totals.active)}</td>
                      <td>
                        <span className={styles.chevron} aria-hidden>
                          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                            <path d="m9 6 6 6-6 6" />
                          </svg>
                        </span>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      ) : (
        <EmptyBlock
          title={noCompany ? statusText : loading ? t("Actualizando empleados...") : t("No hay empleados para el filtro actual.")}
          description={
            noCompany || loading
              ? undefined
              : hasFilters
                ? t("Prueba con otro termino de busqueda o departamento.")
                : t("Cuando registres empleados en Ajustes apareceran aqui con su actividad.")
          }
          action={
            hasFilters && !noCompany ? (
              <button
                type="button"
                className="btn btn-outline btn-sm"
                onClick={() => {
                  setSearchTerm("");
                  setDepartmentFilter("");
                }}
              >
                {t("Limpiar filtros")}
              </button>
            ) : undefined
          }
        />
      )}
    </AppShell>
  );
}
