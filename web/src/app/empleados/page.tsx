"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { AppShell } from "@/components/app-shell";
import { EmptyState, Panel, RefreshButton, StatusLine } from "@/components/ui";
import { useAuth } from "@/components/auth-provider";
import { usePreferences } from "@/components/preferences-provider";
import {
  CatalogsResponse,
  DashboardResponse,
  ProductivityBlock,
} from "@/lib/types";
import { formatDuration } from "@/lib/format";

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

function hours(seconds: number) {
  return `${Math.round((seconds / 3600) * 10) / 10}`;
}

function csvSafe(value: string | number) {
  return `"${String(value).replace(/"/g, '""')}"`;
}

export default function EmployeesPage() {
  const router = useRouter();
  const { apiGet, user } = useAuth();
  const { t } = usePreferences();
  const [catalogs, setCatalogs] = useState<CatalogsResponse | null>(null);
  const [dashboard, setDashboard] = useState<DashboardResponse | null>(null);
  const [dateFrom, setDateFrom] = useState(monthStartISO());
  const [dateTo, setDateTo] = useState(todayISO());
  const [searchTerm, setSearchTerm] = useState("");
  const [statusText, setStatusText] = useState("");
  const [loading, setLoading] = useState(false);
  const didInitialLoad = useRef(false);

  const loadEmployees = useCallback(async () => {
    setLoading(true);
    setStatusText(t("Actualizando empleados..."));
    const params = new URLSearchParams();
    if (dateFrom) params.set("date_from", dateFrom);
    if (dateTo) params.set("date_to", dateTo);

    try {
      const [nextCatalogs, nextDashboard] = await Promise.all([
        apiGet<CatalogsResponse>("/api/productivity/catalogs"),
        apiGet<DashboardResponse>(`/api/productivity/dashboard?${params.toString()}`),
      ]);
      setCatalogs(nextCatalogs);
      setDashboard(nextDashboard);
      setStatusText(t("Datos actualizados"));
    } catch {
      setStatusText(t("No se pudieron cargar los empleados"));
    } finally {
      setLoading(false);
    }
  }, [apiGet, dateFrom, dateTo, t]);

  useEffect(() => {
    if (!user || didInitialLoad.current) return;
    didInitialLoad.current = true;
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
              active: sum.active + block.active_seconds,
              productive: sum.productive + block.productive_seconds,
              nonProductive: sum.nonProductive + block.non_productive_seconds,
              neutral: sum.neutral + block.neutral_seconds,
              idle: sum.idle + block.idle_seconds,
              breakLunch: sum.breakLunch + block.break_seconds + block.lunch_seconds,
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
        .filter((row) => {
          const needle = searchTerm.trim().toLowerCase();
          if (!needle) return true;
          return [row.employee.full_name, row.employee.email, row.department, row.position, row.employee.employee_code]
            .join(" ")
            .toLowerCase()
            .includes(needle);
        }),
    [blocksByEmployee, departmentMap, employees, positionMap, searchTerm, t],
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
    const lines = employeeRows.map((row) =>
      [
        row.employee.full_name,
        row.employee.employee_code,
        row.department,
        hours(row.totals.active),
        hours(row.totals.productive),
        hours(row.totals.nonProductive),
        hours(row.totals.neutral),
        hours(row.totals.idle),
        hours(row.totals.breakLunch),
      ]
        .map(csvSafe)
        .join(","),
    );
    const blob = new Blob([[header.map(csvSafe).join(","), ...lines].join("\n")], {
      type: "text/csv;charset=utf-8",
    });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `vyntra-empleados-${dateFrom}-${dateTo}.csv`;
    link.click();
    URL.revokeObjectURL(url);
  }

  return (
    <AppShell
      title={t("Empleados")}
      description={`${user?.company || t("Empresa")} - ${t("actividad, productividad y detalle por usuario.")}`}
      actions={<RefreshButton loading={loading} onClick={loadEmployees} />}
    >
      <Panel title={t("Reporte de empleados")} meta={`${employeeRows.length} ${t("visibles")}`}>
        <div className="employee-report-toolbar">
          <div className="date-range-control">
            <span>{t("Seleccionar fechas")}</span>
            <input type="date" value={dateFrom} onChange={(event) => setDateFrom(event.target.value)} />
            <input type="date" value={dateTo} onChange={(event) => setDateTo(event.target.value)} />
            <button className="row-action" onClick={() => void loadEmployees()}>
              {t("Aplicar")}
            </button>
          </div>
          <div className="employee-search-actions">
            <input
              value={searchTerm}
              onChange={(event) => setSearchTerm(event.target.value)}
              placeholder={t("Buscar empleado...")}
            />
            <button className="icon-action" aria-label={t("Descargar CSV")} onClick={exportCsv}>
              CSV
            </button>
          </div>
        </div>

        {employeeRows.length ? (
          <table className="employee-report-table">
            <thead>
              <tr>
                <th>{t("Nombre del empleado")}</th>
                <th>{t("Equipo")}</th>
                <th>{t("Ubicacion")}</th>
                <th>{t("Actividad [h]")}</th>
                <th>{t("Productivo [h]")}</th>
                <th>{t("Improductivo [h]")}</th>
                <th>{t("Neutral [h]")}</th>
                <th>{t("Tiempo inactivo")}</th>
                <th>{t("Descanso")}</th>
              </tr>
            </thead>
            <tbody>
              {employeeRows.map((row) => (
                <tr key={row.employee.id} onClick={() => openEmployeeProfile(row.employee.id)}>
                  <td>
                    <div className="table-person">
                      <span>{initialsFor(row.employee.full_name)}</span>
                      <div>
                        <strong>{row.employee.full_name}</strong>
                        <small>{row.employee.email || t("Sin correo laboral")}</small>
                      </div>
                    </div>
                  </td>
                  <td>{row.employee.employee_code}</td>
                  <td>{row.department}</td>
                  <td>{hours(row.totals.active)}</td>
                  <td>{hours(row.totals.productive)}</td>
                  <td>{hours(row.totals.nonProductive)}</td>
                  <td>{hours(row.totals.neutral)}</td>
                  <td>{formatDuration(row.totals.idle)}</td>
                  <td>{formatDuration(row.totals.breakLunch)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <EmptyState>{t("No hay empleados para el filtro actual.")}</EmptyState>
        )}
      </Panel>

      <StatusLine>{statusText}</StatusLine>
    </AppShell>
  );
}
