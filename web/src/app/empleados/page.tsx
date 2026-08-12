"use client";

import { useEffect, useMemo, useState } from "react";
import { AppShell } from "@/components/app-shell";
import { EmptyState, Panel, RefreshButton, StatusLine } from "@/components/ui";
import { useAuth } from "@/components/auth-provider";
import { CatalogsResponse, DashboardResponse, Employee } from "@/lib/types";
import { formatDuration } from "@/lib/format";

export default function EmployeesPage() {
  const { apiGet, user } = useAuth();
  const [catalogs, setCatalogs] = useState<CatalogsResponse | null>(null);
  const [dashboard, setDashboard] = useState<DashboardResponse | null>(null);
  const [selectedEmployeeId, setSelectedEmployeeId] = useState("");
  const [statusText, setStatusText] = useState("");
  const [loading, setLoading] = useState(false);

  async function loadEmployees() {
    setLoading(true);
    setStatusText("Actualizando empleados...");
    try {
      const [nextCatalogs, nextDashboard] = await Promise.all([
        apiGet<CatalogsResponse>("/api/productivity/catalogs"),
        apiGet<DashboardResponse>("/api/productivity/dashboard"),
      ]);
      setCatalogs(nextCatalogs);
      setDashboard(nextDashboard);
      setSelectedEmployeeId((current) => current || nextCatalogs.employees[0]?.id || "");
      setStatusText("Datos actualizados");
    } catch {
      setStatusText("No se pudieron cargar los empleados");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    if (user) void loadEmployees();
  }, [user]);

  const selectedEmployee = catalogs?.employees.find((employee) => employee.id === selectedEmployeeId);
  const departmentMap = useMemo(
    () => new Map(catalogs?.departments.map((department) => [department.id, department.name])),
    [catalogs],
  );
  const positionMap = useMemo(
    () => new Map(catalogs?.positions.map((position) => [position.id, position.name])),
    [catalogs],
  );
  const employeeSeconds = useMemo(() => {
    const blocks = dashboard?.blocks || [];
    return blocks.reduce<Record<string, number>>((totals, block) => {
      totals[block.employee_id] = (totals[block.employee_id] || 0) + block.active_seconds;
      return totals;
    }, {});
  }, [dashboard]);

  return (
    <AppShell
      title="Empleados"
      description={`${user?.company || "Empresa"} - personal monitoreado, actividad y evidencias por usuario.`}
      actions={<RefreshButton loading={loading} onClick={loadEmployees} />}
    >
      <section className="split-grid">
        <Panel title="Personal monitoreado" meta={`${catalogs?.employees.length || 0} registros`} className="wide">
          {catalogs?.employees.length ? (
            <table>
              <thead>
                <tr>
                  <th>Codigo</th>
                  <th>Empleado</th>
                  <th>Departamento</th>
                  <th>Puesto</th>
                  <th>Activo</th>
                  <th>Estado</th>
                </tr>
              </thead>
              <tbody>
                {catalogs.employees.map((employee: Employee) => (
                  <tr
                    className={selectedEmployeeId === employee.id ? "selected-row" : ""}
                    key={employee.id}
                    onClick={() => setSelectedEmployeeId(employee.id)}
                  >
                    <td>{employee.employee_code}</td>
                    <td>{employee.full_name}</td>
                    <td>{employee.department_id ? departmentMap.get(employee.department_id) || "" : ""}</td>
                    <td>{employee.position_id ? positionMap.get(employee.position_id) || "" : ""}</td>
                    <td>{formatDuration(employeeSeconds[employee.id] || 0)}</td>
                    <td>{employee.status}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <EmptyState>No hay empleados cargados para esta empresa.</EmptyState>
          )}
        </Panel>

        <Panel title="Ficha del empleado" meta={selectedEmployee?.employee_code}>
          {selectedEmployee ? (
            <div className="detail-list">
              <label>Nombre</label>
              <strong>{selectedEmployee.full_name}</strong>
              <label>Correo</label>
              <span>{selectedEmployee.email || "Sin correo laboral"}</span>
              <label>Departamento</label>
              <span>{selectedEmployee.department_id ? departmentMap.get(selectedEmployee.department_id) : ""}</span>
              <label>Puesto</label>
              <span>{selectedEmployee.position_id ? positionMap.get(selectedEmployee.position_id) : ""}</span>
            </div>
          ) : (
            <EmptyState>Selecciona un empleado.</EmptyState>
          )}
        </Panel>

        <Panel title="Evidencias" meta="por usuario">
          <div className="evidence-placeholder">
            <strong>{selectedEmployee?.full_name || "Empleado"}</strong>
            <span>Capturas, archivos y eventos asociados apareceran aqui.</span>
            <small>Endpoint pendiente: listado seguro de evidencias por empleado y fecha.</small>
          </div>
        </Panel>
      </section>
      <StatusLine>{statusText}</StatusLine>
    </AppShell>
  );
}
