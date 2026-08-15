"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AppShell } from "@/components/app-shell";
import { EmptyState, Panel, RefreshButton, StatCard, StatusLine } from "@/components/ui";
import { useAuth } from "@/components/auth-provider";
import { AttendanceEmployee, AttendanceOverviewResponse, AttendanceShift } from "@/lib/types";
import { formatDuration, fullDate } from "@/lib/format";

type AttendanceView = "live" | "history" | "groups" | "summary";

const viewLabels: Record<AttendanceView, string> = {
  live: "En vivo",
  history: "Historico",
  groups: "Grupos",
  summary: "Resumen",
};

const eventLabels: Record<string, string> = {
  shift_started: "Entrada",
  shift_finished: "Salida",
  break_started: "Inicio break",
  break_finished: "Fin break",
  lunch_started: "Inicio lunch",
  lunch_finished: "Fin lunch",
  overtime_started: "Inicio extra",
  overtime_finished: "Fin extra",
};

function todayISO() {
  return new Date().toISOString().slice(0, 10);
}

function monthStartISO() {
  const date = new Date();
  date.setDate(1);
  return date.toISOString().slice(0, 10);
}

function timeOnly(value: string | null) {
  if (!value) return "-";
  return new Date(value).toLocaleTimeString("es-NI", {
    hour: "2-digit",
    minute: "2-digit",
  });
}

function shortDate(value: string) {
  if (!value) return "";
  return new Date(`${value}T00:00:00`).toLocaleDateString("es-NI", {
    weekday: "long",
    day: "numeric",
    month: "short",
  });
}

function percentOfDay(value: string | null) {
  if (!value) return 0;
  const date = new Date(value);
  return ((date.getHours() * 60 + date.getMinutes()) / 1440) * 100;
}

function statusForShift(shift?: AttendanceShift) {
  if (!shift?.started_at) return { label: "Ausente", tone: "bad" as const };
  if (shift.ended_at || shift.status === "closed") return { label: "Finalizado", tone: "plain" as const };
  const lastEvent = shift.events.at(-1)?.event_type;
  if (lastEvent === "lunch_started") return { label: "Almuerzo", tone: "warn" as const };
  if (lastEvent === "break_started") return { label: "Break", tone: "warn" as const };
  return { label: "Activo", tone: "good" as const };
}

function workedSeconds(shift?: AttendanceShift) {
  if (!shift) return 0;
  return Math.max(0, (shift.work_seconds || 0) - (shift.break_seconds || 0) - (shift.lunch_seconds || 0));
}

function employeeLabel(employee: AttendanceEmployee | undefined) {
  return employee?.full_name || "Empleado no encontrado";
}

function initialsFor(name: string) {
  return name
    .split(" ")
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase())
    .join("");
}

function isPunctual(shift: AttendanceShift, scheduleStart = "08:00") {
  if (!shift.started_at) return false;
  const started = new Date(shift.started_at);
  const scheduled = new Date(started);
  const [hour, minute] = scheduleStart.split(":").map(Number);
  scheduled.setHours(hour || 0, (minute || 0) + 5, 0, 0);
  return started <= scheduled;
}

function eventTime(shift: AttendanceShift, eventType: string) {
  return shift.events.find((event) => event.event_type === eventType)?.occurred_at || null;
}

function timelineSpan(start: string | null, end: string | null, minWidth = 0.5) {
  const left = percentOfDay(start);
  const right = end ? percentOfDay(end) : left;
  return {
    left: `${Math.min(100, Math.max(0, left))}%`,
    width: `${Math.max(right - left, minWidth)}%`,
  };
}

function timeInput(value: string | null) {
  if (!value) return "";
  const date = new Date(value);
  return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}

function dateTimeFromInput(date: string, time: string) {
  if (!date || !time) return null;
  return new Date(`${date}T${time}:00`).toISOString();
}

export default function AttendancePage() {
  const { apiGet, apiPost, apiPatch, user } = useAuth();
  const [view, setView] = useState<AttendanceView>("history");
  const [overview, setOverview] = useState<AttendanceOverviewResponse | null>(null);
  const [selectedDepartment, setSelectedDepartment] = useState("");
  const [selectedEmployee, setSelectedEmployee] = useState("");
  const [selectedAssociateId, setSelectedAssociateId] = useState("");
  const [detailDate, setDetailDate] = useState(todayISO());
  const [scheduleStart, setScheduleStart] = useState("08:00");
  const [scheduleEnd, setScheduleEnd] = useState("17:00");
  const [entryTime, setEntryTime] = useState("");
  const [exitTime, setExitTime] = useState("");
  const [breakStartTime, setBreakStartTime] = useState("");
  const [breakEndTime, setBreakEndTime] = useState("");
  const [lunchStartTime, setLunchStartTime] = useState("");
  const [lunchEndTime, setLunchEndTime] = useState("");
  const [correctionReason, setCorrectionReason] = useState("");
  const [dateFrom, setDateFrom] = useState(monthStartISO());
  const [dateTo, setDateTo] = useState(todayISO());
  const [statusText, setStatusText] = useState("");
  const [loading, setLoading] = useState(false);
  const didInitialLoad = useRef(false);

  const loadAttendance = useCallback(async (range?: { dateFrom?: string; dateTo?: string }) => {
    setLoading(true);
    setStatusText("Actualizando asistencia...");
    const params = new URLSearchParams();
    const nextDateFrom = range?.dateFrom ?? dateFrom;
    const nextDateTo = range?.dateTo ?? dateTo;
    if (nextDateFrom) params.set("date_from", nextDateFrom);
    if (nextDateTo) params.set("date_to", nextDateTo);
    if (selectedDepartment) params.set("department_id", selectedDepartment);
    if (selectedEmployee) params.set("employee_id", selectedEmployee);

    try {
      const nextOverview = await apiGet<AttendanceOverviewResponse>(
        `/api/attendance/overview?${params.toString()}`,
      );
      setOverview(nextOverview);
      setStatusText("Datos actualizados");
    } catch {
      setStatusText("No se pudo cargar asistencia");
    } finally {
      setLoading(false);
    }
  }, [apiGet, dateFrom, dateTo, selectedDepartment, selectedEmployee]);

  useEffect(() => {
    if (!user || didInitialLoad.current) return;
    didInitialLoad.current = true;
    const timer = window.setTimeout(() => {
      void loadAttendance();
    }, 0);
    return () => window.clearTimeout(timer);
  }, [loadAttendance, user]);

  const employees = useMemo(() => overview?.employees || [], [overview]);
  const shifts = useMemo(() => overview?.shifts || [], [overview]);
  const employeeMap = useMemo(
    () => new Map(employees.map((employee) => [employee.id, employee])),
    [employees],
  );
  const departments = useMemo(() => {
    const rows = new Map<string, string>();
    employees.forEach((employee) => {
      if (employee.department_id && employee.department) rows.set(employee.department_id, employee.department);
    });
    return Array.from(rows, ([id, name]) => ({ id, name }));
  }, [employees]);
  const todayShifts = useMemo(() => shifts.filter((shift) => shift.shift_date === todayISO()), [shifts]);
  const latestTodayByEmployee = useMemo(() => {
    const rows = new Map<string, AttendanceShift>();
    todayShifts.forEach((shift) => {
      if (!rows.has(shift.employee_id)) rows.set(shift.employee_id, shift);
    });
    return rows;
  }, [todayShifts]);
  const selectedAssociate = useMemo(
    () => employees.find((employee) => employee.id === selectedAssociateId) || null,
    [employees, selectedAssociateId],
  );
  const selectedAssociateShifts = useMemo(
    () =>
      selectedAssociate
        ? shifts.filter((shift) => shift.employee_id === selectedAssociate.id)
        : [],
    [selectedAssociate, shifts],
  );
  const selectedAssociateStatus = statusForShift(
    selectedAssociate ? latestTodayByEmployee.get(selectedAssociate.id) : undefined,
  );
  const selectedAssociateStats = useMemo(() => {
    const completed = selectedAssociateShifts.filter((shift) => shift.ended_at || shift.status === "closed").length;
    const punctual = selectedAssociateShifts.filter((shift) => isPunctual(shift, selectedAssociate?.schedule.start_time)).length;
    const tardy = selectedAssociateShifts.filter((shift) => shift.started_at && !isPunctual(shift, selectedAssociate?.schedule.start_time)).length;
    const workSeconds = selectedAssociateShifts.reduce((sum, shift) => sum + workedSeconds(shift), 0);
    const breakSeconds = selectedAssociateShifts.reduce((sum, shift) => sum + shift.break_seconds, 0);
    const lunchSeconds = selectedAssociateShifts.reduce((sum, shift) => sum + shift.lunch_seconds, 0);
    return { completed, punctual, tardy, workSeconds, breakSeconds, lunchSeconds };
  }, [selectedAssociate, selectedAssociateShifts]);
  const selectedDayShift = useMemo(
    () => selectedAssociateShifts.find((shift) => shift.shift_date === detailDate),
    [detailDate, selectedAssociateShifts],
  );
  const employeeReportRows = useMemo(
    () =>
      employees.map((employee) => {
        const records = shifts.filter((shift) => shift.employee_id === employee.id && shift.started_at);
        return {
          employee,
          records,
          hours: records.reduce((sum, shift) => sum + workedSeconds(shift), 0),
          tardy: records.filter((shift) => !isPunctual(shift, employee.schedule.start_time)).length,
          latestStatus: statusForShift(latestTodayByEmployee.get(employee.id)),
        };
      }),
    [employees, latestTodayByEmployee, shifts],
  );

  const stats = useMemo(() => {
    const totalEmployees = employees.length;
    const started = shifts.filter((shift) => shift.started_at).length;
    const finished = shifts.filter((shift) => shift.ended_at || shift.status === "closed").length;
    const activeNow = employees.filter((employee) => statusForShift(latestTodayByEmployee.get(employee.id)).label === "Activo").length;
    const absentToday = employees.filter((employee) => !latestTodayByEmployee.get(employee.id)?.started_at).length;
    const breakSeconds = shifts.reduce((sum, shift) => sum + shift.break_seconds, 0);
    const lunchSeconds = shifts.reduce((sum, shift) => sum + shift.lunch_seconds, 0);
    const workSeconds = shifts.reduce((sum, shift) => sum + workedSeconds(shift), 0);
    return { totalEmployees, started, finished, activeNow, absentToday, breakSeconds, lunchSeconds, workSeconds };
  }, [employees, shifts, latestTodayByEmployee]);

  const groupStats = useMemo(() => {
    const rows = new Map<string, {
      department: string;
      employees: number;
      started: number;
      finished: number;
      breakSeconds: number;
      lunchSeconds: number;
      workSeconds: number;
    }>();
    employees.forEach((employee) => {
      const key = employee.department_id || "none";
      rows.set(key, {
        department: employee.department || "Sin departamento",
        employees: (rows.get(key)?.employees || 0) + 1,
        started: rows.get(key)?.started || 0,
        finished: rows.get(key)?.finished || 0,
        breakSeconds: rows.get(key)?.breakSeconds || 0,
        lunchSeconds: rows.get(key)?.lunchSeconds || 0,
        workSeconds: rows.get(key)?.workSeconds || 0,
      });
    });
    shifts.forEach((shift) => {
      const employee = employeeMap.get(shift.employee_id);
      const key = employee?.department_id || "none";
      const row = rows.get(key);
      if (!row) return;
      row.started += shift.started_at ? 1 : 0;
      row.finished += shift.ended_at || shift.status === "closed" ? 1 : 0;
      row.breakSeconds += shift.break_seconds || 0;
      row.lunchSeconds += shift.lunch_seconds || 0;
      row.workSeconds += workedSeconds(shift);
    });
    return Array.from(rows.values()).sort((a, b) => a.department.localeCompare(b.department));
  }, [employees, employeeMap, shifts]);

  useEffect(() => {
    if (!selectedAssociate) return;
    const timer = window.setTimeout(() => {
      setScheduleStart(selectedAssociate.schedule.start_time || "08:00");
      setScheduleEnd(selectedAssociate.schedule.end_time || "17:00");
    }, 0);
    return () => window.clearTimeout(timer);
  }, [selectedAssociate]);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      const breakStart = selectedDayShift ? eventTime(selectedDayShift, "break_started") : null;
      const breakEnd = selectedDayShift ? eventTime(selectedDayShift, "break_finished") : null;
      const lunchStart = selectedDayShift ? eventTime(selectedDayShift, "lunch_started") : null;
      const lunchEnd = selectedDayShift ? eventTime(selectedDayShift, "lunch_finished") : null;
      setEntryTime(timeInput(selectedDayShift?.started_at || null));
      setExitTime(timeInput(selectedDayShift?.ended_at || null));
      setBreakStartTime(timeInput(breakStart));
      setBreakEndTime(timeInput(breakEnd));
      setLunchStartTime(timeInput(lunchStart));
      setLunchEndTime(timeInput(lunchEnd));
      setCorrectionReason("");
    }, 0);
    return () => window.clearTimeout(timer);
  }, [selectedDayShift]);

  async function handleDetailDateChange(value: string) {
    setDetailDate(value);
    if (value && (value < dateFrom || value > dateTo)) {
      setDateFrom(value);
      setDateTo(value);
      await loadAttendance({ dateFrom: value, dateTo: value });
    }
  }

  async function saveSchedule() {
    if (!selectedAssociate) return;
    setStatusText("Guardando horario...");
    try {
      await apiPatch(`/api/attendance/employees/${selectedAssociate.id}/schedule`, {
        start_time: scheduleStart,
        end_time: scheduleEnd,
        effective_from: detailDate,
      });
      await loadAttendance();
      setStatusText("Horario actualizado");
    } catch {
      setStatusText("No se pudo guardar el horario");
    }
  }

  async function saveShiftCorrection() {
    if (!selectedDayShift) return;
    if (correctionReason.trim().length < 3) {
      setStatusText("Escribe el motivo de la correccion");
      return;
    }
    setStatusText("Guardando correccion...");
    try {
      await apiPatch(`/api/attendance/shifts/${selectedDayShift.id}`, {
        started_at: dateTimeFromInput(detailDate, entryTime),
        ended_at: dateTimeFromInput(detailDate, exitTime),
        break_started_at: dateTimeFromInput(detailDate, breakStartTime),
        break_ended_at: dateTimeFromInput(detailDate, breakEndTime),
        lunch_started_at: dateTimeFromInput(detailDate, lunchStartTime),
        lunch_ended_at: dateTimeFromInput(detailDate, lunchEndTime),
        correction_reason: correctionReason,
      });
      await loadAttendance();
      setStatusText("Asistencia corregida");
    } catch {
      setStatusText("No se pudo guardar la correccion");
    }
  }

  async function createManualShift() {
    if (!selectedAssociate) return;
    if (correctionReason.trim().length < 3) {
      setStatusText("Escribe el motivo para crear la jornada");
      return;
    }
    setStatusText("Creando jornada manual...");
    try {
      await apiPost("/api/attendance/shifts", {
        employee_id: selectedAssociate.id,
        shift_date: detailDate,
        started_at: dateTimeFromInput(detailDate, entryTime),
        ended_at: dateTimeFromInput(detailDate, exitTime),
        break_started_at: dateTimeFromInput(detailDate, breakStartTime),
        break_ended_at: dateTimeFromInput(detailDate, breakEndTime),
        lunch_started_at: dateTimeFromInput(detailDate, lunchStartTime),
        lunch_ended_at: dateTimeFromInput(detailDate, lunchEndTime),
        correction_reason: correctionReason,
      });
      await loadAttendance({ dateFrom, dateTo });
      setStatusText("Jornada manual creada");
    } catch {
      setStatusText("No se pudo crear la jornada manual");
    }
  }

  return (
    <AppShell
      title="Asistencia"
      description={`${user?.company || "Empresa"} - control de jornada, ausencias, break y lunch.`}
      actions={<RefreshButton loading={loading} onClick={loadAttendance} />}
    >
      <div className="attendance-toolbar">
        <div className="tabs">
          {(Object.keys(viewLabels) as AttendanceView[]).map((key) => (
            <button className={view === key ? "active" : ""} key={key} onClick={() => setView(key)}>
              {viewLabels[key]}
            </button>
          ))}
        </div>
        <div className="filter-row">
          <label>
            Desde
            <input type="date" value={dateFrom} onChange={(event) => setDateFrom(event.target.value)} />
          </label>
          <label>
            Hasta
            <input type="date" value={dateTo} onChange={(event) => setDateTo(event.target.value)} />
          </label>
          <label>
            Departamento
            <select value={selectedDepartment} onChange={(event) => setSelectedDepartment(event.target.value)}>
              <option value="">Todos</option>
              {departments.map((department) => (
                <option value={department.id} key={department.id}>{department.name}</option>
              ))}
            </select>
          </label>
          <label>
            Empleado
            <select value={selectedEmployee} onChange={(event) => setSelectedEmployee(event.target.value)}>
              <option value="">Todos</option>
              {employees.map((employee) => (
                <option value={employee.id} key={employee.id}>{employee.full_name}</option>
              ))}
            </select>
          </label>
          <button className="secondary-button" onClick={() => void loadAttendance()} disabled={loading}>Aplicar</button>
        </div>
      </div>

      {!overview ? (
        <Panel title="Estado">
          <EmptyState>{statusText || "Cargando asistencia..."}</EmptyState>
        </Panel>
      ) : (
        <>
          <section className="stats-grid">
            <StatCard label="Activos ahora" value={`${stats.activeNow}`} detail="Jornada abierta" tone="good" />
            <StatCard label="Ausentes hoy" value={`${stats.absentToday}`} detail="Sin entrada registrada" tone={stats.absentToday ? "bad" : "plain"} />
            <StatCard label="Break" value={formatDuration(stats.breakSeconds)} detail="Pausas cortas" />
            <StatCard label="Lunch" value={formatDuration(stats.lunchSeconds)} detail="Almuerzo registrado" />
          </section>

          {view === "live" ? (
            <section className="attendance-grid">
              {employees.map((employee) => {
                const shift = latestTodayByEmployee.get(employee.id);
                const status = statusForShift(shift);
                return (
                  <article
                    className={`attendance-card ${selectedAssociate?.id === employee.id ? "selected-card" : ""}`}
                    key={employee.id}
                    onClick={() => setSelectedAssociateId(employee.id)}
                  >
                    <div>
                      <strong>{employee.full_name}</strong>
                      <span>{employee.department || "Sin departamento"}</span>
                    </div>
                    <span className={`badge attendance-${status.tone}`}>{status.label}</span>
                    <dl>
                      <div><dt>Entrada</dt><dd>{timeOnly(shift?.started_at || null)}</dd></div>
                      <div><dt>Salida</dt><dd>{timeOnly(shift?.ended_at || null)}</dd></div>
                      <div><dt>Activo</dt><dd>{formatDuration(workedSeconds(shift))}</dd></div>
                    </dl>
                  </article>
                );
              })}
            </section>
          ) : null}

          {view === "history" ? (
            <Panel title="Reporte global de asistencia" meta={`${employees.length} asociados`}>
              {employeeReportRows.length ? (
                <table>
                  <thead>
                    <tr>
                      <th>Asociado</th>
                      <th>Departamento</th>
                      <th>Dias asistidos</th>
                      <th>Total horas</th>
                      <th>Tardanzas</th>
                      <th>Estado hoy</th>
                      <th>Acciones</th>
                    </tr>
                  </thead>
                  <tbody>
                    {employeeReportRows.map((row) => (
                      <tr key={row.employee.id} onClick={() => setSelectedAssociateId(row.employee.id)}>
                        <td>
                          <div className="table-person">
                            <span>{initialsFor(row.employee.full_name)}</span>
                            <div>
                              <strong>{row.employee.full_name}</strong>
                              <small>{row.employee.email || "Sin correo laboral"}</small>
                            </div>
                          </div>
                        </td>
                        <td><span className="soft-pill">{row.employee.department || "Sin departamento"}</span></td>
                        <td><strong>{row.records.length}</strong><small className="table-muted"> registros</small></td>
                        <td><span className="time-pill">{formatDuration(row.hours)}</span></td>
                        <td>
                          {row.tardy ? (
                            <span className="badge attendance-bad">{row.tardy}</span>
                          ) : (
                            <span className="table-muted">Ninguna</span>
                          )}
                        </td>
                        <td><span className={`badge attendance-${row.latestStatus.tone}`}>{row.latestStatus.label}</span></td>
                        <td>
                          <button className="row-action" onClick={() => setSelectedAssociateId(row.employee.id)}>
                            Detalles
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              ) : (
                <EmptyState>No hay asociados para este filtro.</EmptyState>
              )}
            </Panel>
          ) : null}

          {view === "groups" ? (
            <section className="attendance-grid group-mode">
              {groupStats.map((row) => (
                <article className="group-card" key={row.department}>
                  <div className="panel-title">
                    <h2>{row.department}</h2>
                    <span>{row.employees} empleados</span>
                  </div>
                  <div className="mini-stats">
                    <div><span>Jornadas</span><strong>{row.started}</strong></div>
                    <div><span>Finalizadas</span><strong>{row.finished}</strong></div>
                    <div><span>Activo</span><strong>{formatDuration(row.workSeconds)}</strong></div>
                    <div><span>Lunch</span><strong>{formatDuration(row.lunchSeconds)}</strong></div>
                  </div>
                </article>
              ))}
            </section>
          ) : null}

          {view === "summary" ? (
            <section className="summary-grid">
              <Panel title="Resumen del rango" meta={`${dateFrom} - ${dateTo}`}>
                <div className="mini-stats">
                  <div><span>Empleados</span><strong>{stats.totalEmployees}</strong></div>
                  <div><span>Jornadas iniciadas</span><strong>{stats.started}</strong></div>
                  <div><span>Jornadas finalizadas</span><strong>{stats.finished}</strong></div>
                  <div><span>Tiempo activo</span><strong>{formatDuration(stats.workSeconds)}</strong></div>
                  <div><span>Break total</span><strong>{formatDuration(stats.breakSeconds)}</strong></div>
                  <div><span>Lunch total</span><strong>{formatDuration(stats.lunchSeconds)}</strong></div>
                </div>
              </Panel>
              <Panel title="Eventos recientes" meta="timeline">
                <div className="timeline-list">
                  {shifts.flatMap((shift) =>
                    shift.events.map((event) => ({
                      ...event,
                      employee: employeeLabel(employeeMap.get(shift.employee_id)),
                      shiftDate: shift.shift_date,
                    })),
                  ).slice(-12).reverse().map((event) => (
                    <article className="timeline-item" key={event.id}>
                      <span>{eventLabels[event.event_type] || event.event_type}</span>
                      <strong>{event.employee}</strong>
                      <small>{fullDate(event.shiftDate)} - {timeOnly(event.occurred_at)}</small>
                    </article>
                  ))}
                </div>
              </Panel>
            </section>
          ) : null}
          <StatusLine>{statusText}</StatusLine>
          {selectedAssociate ? (
            <div className="detail-modal" role="dialog" aria-modal="true" onClick={() => setSelectedAssociateId("")}>
              <section className="detail-modal-panel" onClick={(event) => event.stopPropagation()}>
                <header className="detail-modal-header">
                  <h2>Detalles del asociado</h2>
                  <button aria-label="Cerrar detalle" onClick={() => setSelectedAssociateId("")}>x</button>
                </header>
                <div className="detail-modal-body">
                  <aside className="associate-panel">
                    <section className="associate-card">
                      <div className="associate-avatar">
                        {initialsFor(selectedAssociate.full_name)}
                        <span className={`associate-status attendance-${selectedAssociateStatus.tone}`} />
                      </div>
                      <h2>{selectedAssociate.full_name}</h2>
                      <p>{selectedAssociate.department || "Sin departamento"}</p>
                      <div className="schedule-box editable">
                        <span>Horario asignado</span>
                        <div className="time-edit-row">
                          <input
                            aria-label="Hora de entrada asignada"
                            type="time"
                            value={scheduleStart}
                            onChange={(event) => setScheduleStart(event.target.value)}
                          />
                          <input
                            aria-label="Hora de salida asignada"
                            type="time"
                            value={scheduleEnd}
                            onChange={(event) => setScheduleEnd(event.target.value)}
                          />
                        </div>
                        <button className="row-action" type="button" onClick={saveSchedule}>
                          Guardar horario
                        </button>
                      </div>
                    </section>

                    <section className="associate-month">
                      <h3>Resumen del mes</h3>
                      <div className="associate-metrics">
                        <div><span>Puntuales</span><strong className="metric-good">{selectedAssociateStats.punctual}</strong></div>
                        <div><span>Tardanzas</span><strong className="metric-bad">{selectedAssociateStats.tardy}</strong></div>
                        <div><span>Jornadas</span><strong>{selectedAssociateStats.completed}</strong></div>
                        <div><span>Activo</span><strong>{formatDuration(selectedAssociateStats.workSeconds)}</strong></div>
                        <div><span>Break</span><strong>{formatDuration(selectedAssociateStats.breakSeconds)}</strong></div>
                        <div><span>Lunch</span><strong>{formatDuration(selectedAssociateStats.lunchSeconds)}</strong></div>
                      </div>
                    </section>
                  </aside>

                  <section className="modal-history">
                    <div className="panel-title">
                      <h2>Historico detallado de actividad</h2>
                      <span>{detailDate}</span>
                    </div>
                    <div className="detail-date-filter">
                      <label>
                        Fecha
                        <input
                          type="date"
                          value={detailDate}
                          onChange={(event) => {
                            void handleDetailDateChange(event.target.value);
                          }}
                        />
                      </label>
                    </div>
                    {selectedDayShift ? (
                      <div className="activity-history">
                        <article className="activity-day">
                          <div className="activity-day-header">
                            <div>
                              <strong>{shortDate(selectedDayShift.shift_date)}</strong>
                              <span>Total: {formatDuration(workedSeconds(selectedDayShift))}</span>
                            </div>
                            <span className={`badge attendance-${statusForShift(selectedDayShift).tone}`}>
                              {statusForShift(selectedDayShift).label}
                            </span>
                          </div>
                          <div className="day-track">
                            {selectedDayShift.started_at && selectedDayShift.ended_at ? (
                              <span className="track-work" style={timelineSpan(selectedDayShift.started_at, selectedDayShift.ended_at, 1)} />
                            ) : null}
                            {eventTime(selectedDayShift, "break_started") && eventTime(selectedDayShift, "break_finished") ? (
                              <span
                                className="track-break"
                                style={timelineSpan(
                                  eventTime(selectedDayShift, "break_started"),
                                  eventTime(selectedDayShift, "break_finished"),
                                  0.5,
                                )}
                              />
                            ) : null}
                            {eventTime(selectedDayShift, "lunch_started") && eventTime(selectedDayShift, "lunch_finished") ? (
                              <span
                                className="track-lunch"
                                style={timelineSpan(
                                  eventTime(selectedDayShift, "lunch_started"),
                                  eventTime(selectedDayShift, "lunch_finished"),
                                  1,
                                )}
                              />
                            ) : null}
                          </div>
                          <div className="track-labels">
                            <span>00:00</span>
                            <span>06:00</span>
                            <span>12:00</span>
                            <span>18:00</span>
                            <span>24:00</span>
                          </div>
                        </article>
                        <form className="shift-edit-form" onSubmit={(event) => {
                          event.preventDefault();
                          void saveShiftCorrection();
                        }}>
                          <label>Entrada<input type="time" value={entryTime} onChange={(event) => setEntryTime(event.target.value)} /></label>
                          <label>Salida<input type="time" value={exitTime} onChange={(event) => setExitTime(event.target.value)} /></label>
                          <label>Inicio break<input type="time" value={breakStartTime} onChange={(event) => setBreakStartTime(event.target.value)} /></label>
                          <label>Fin break<input type="time" value={breakEndTime} onChange={(event) => setBreakEndTime(event.target.value)} /></label>
                          <label>Inicio lunch<input type="time" value={lunchStartTime} onChange={(event) => setLunchStartTime(event.target.value)} /></label>
                          <label>Fin lunch<input type="time" value={lunchEndTime} onChange={(event) => setLunchEndTime(event.target.value)} /></label>
                          <label className="form-wide">Motivo<input value={correctionReason} onChange={(event) => setCorrectionReason(event.target.value)} placeholder="Ej. Correccion aprobada por RRHH" required /></label>
                          <button className="secondary-button" type="submit">Guardar correccion</button>
                        </form>
                      </div>
                    ) : (
                      <form className="shift-edit-form" onSubmit={(event) => {
                        event.preventDefault();
                        void createManualShift();
                      }}>
                        <label className="form-wide">Estado<input disabled value="No hay jornada registrada en esta fecha" /></label>
                        <label>Entrada<input type="time" value={entryTime} onChange={(event) => setEntryTime(event.target.value)} required /></label>
                        <label>Salida<input type="time" value={exitTime} onChange={(event) => setExitTime(event.target.value)} /></label>
                        <label>Inicio break<input type="time" value={breakStartTime} onChange={(event) => setBreakStartTime(event.target.value)} /></label>
                        <label>Fin break<input type="time" value={breakEndTime} onChange={(event) => setBreakEndTime(event.target.value)} /></label>
                        <label>Inicio lunch<input type="time" value={lunchStartTime} onChange={(event) => setLunchStartTime(event.target.value)} /></label>
                        <label>Fin lunch<input type="time" value={lunchEndTime} onChange={(event) => setLunchEndTime(event.target.value)} /></label>
                        <label className="form-wide">Motivo<input value={correctionReason} onChange={(event) => setCorrectionReason(event.target.value)} placeholder="Ej. Registro manual aprobado" required /></label>
                        <button className="secondary-button" type="submit">Crear jornada manual</button>
                      </form>
                    )}
                  </section>
                </div>
              </section>
            </div>
          ) : null}
        </>
      )}
    </AppShell>
  );
}
