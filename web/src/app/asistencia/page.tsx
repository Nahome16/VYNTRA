"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AppShell } from "@/components/app-shell";
import { EmptyState, Panel, RefreshButton, StatusLine } from "@/components/ui";
import { useAuth } from "@/components/auth-provider";
import { usePreferences } from "@/components/preferences-provider";
import { AttendanceEmployee, AttendanceOverviewResponse, AttendanceShift } from "@/lib/types";
import { formatDuration, fullDate } from "@/lib/format";
import { downloadAuthenticatedFile } from "@/lib/download-file";

type AttendanceView = "live" | "history" | "groups" | "summary";
type MetricDetailKey = "punctual" | "tardy" | "justified" | "break" | "lunch";

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
  return Math.max(0, (shift.work_seconds || 0) - (shift.break_seconds || 0) - (shift.lunch_seconds || 0) + (shift.justified_seconds || 0));
}

function employeeLabel(employee: AttendanceEmployee | undefined, fallback: string) {
  return employee?.full_name || fallback;
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

function parseMinutes(value: string, fallback: number) {
  const numberValue = Number(value);
  if (!Number.isFinite(numberValue)) return fallback;
  return Math.min(240, Math.max(0, Math.round(numberValue)));
}

function comparisonText(actualSeconds: number, expectedSeconds: number) {
  const delta = actualSeconds - expectedSeconds;
  if (delta === 0) return "En tiempo";
  return delta > 0
    ? `+${formatDuration(delta)} sobre`
    : `${formatDuration(Math.abs(delta))} menos`;
}

export default function AttendancePage() {
  const { apiGet, apiPost, apiPatch, token, user } = useAuth();
  const { t } = usePreferences();
  const [view, setView] = useState<AttendanceView>("history");
  const [overview, setOverview] = useState<AttendanceOverviewResponse | null>(null);
  const [selectedDepartment, setSelectedDepartment] = useState("");
  const [selectedEmployee, setSelectedEmployee] = useState("");
  const [selectedAssociateId, setSelectedAssociateId] = useState("");
  const [detailDate, setDetailDate] = useState(todayISO());
  const [scheduleStart, setScheduleStart] = useState("08:00");
  const [scheduleEnd, setScheduleEnd] = useState("17:00");
  const [expectedBreakMinutes, setExpectedBreakMinutes] = useState("15");
  const [expectedLunchMinutes, setExpectedLunchMinutes] = useState("60");
  const [metricDetailKey, setMetricDetailKey] = useState<MetricDetailKey | null>(null);
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
  const [reportLoading, setReportLoading] = useState(false);
  const didInitialLoad = useRef(false);

  const loadAttendance = useCallback(async (range?: { dateFrom?: string; dateTo?: string }) => {
    setLoading(true);
    setStatusText(t("Actualizando asistencia..."));
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
      setStatusText(t("Datos actualizados"));
    } catch {
      setStatusText(t("No se pudo cargar asistencia"));
    } finally {
      setLoading(false);
    }
  }, [apiGet, dateFrom, dateTo, selectedDepartment, selectedEmployee, t]);

  useEffect(() => {
    if (!user || didInitialLoad.current) return;
    didInitialLoad.current = true;
    const timer = window.setTimeout(() => {
      void loadAttendance();
    }, 0);
    return () => window.clearTimeout(timer);
  }, [loadAttendance, user]);

  const employees = useMemo(() => (overview?.employees || []).filter((employee) => employee.status === "active"), [overview]);
  const activeEmployeeIds = useMemo(() => new Set(employees.map((employee) => employee.id)), [employees]);
  const shifts = useMemo(
    () => (overview?.shifts || []).filter((shift) => activeEmployeeIds.has(shift.employee_id)),
    [activeEmployeeIds, overview],
  );
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
    const justifiedSeconds = selectedAssociateShifts.reduce((sum, shift) => sum + (shift.justified_seconds || 0), 0);
    return { completed, punctual, tardy, workSeconds, breakSeconds, lunchSeconds, justifiedSeconds };
  }, [selectedAssociate, selectedAssociateShifts]);
  const expectedBreakSeconds = parseMinutes(
    expectedBreakMinutes,
    selectedAssociate?.schedule.expected_break_minutes ?? 15,
  ) * 60;
  const expectedLunchSeconds = parseMinutes(
    expectedLunchMinutes,
    selectedAssociate?.schedule.expected_lunch_minutes ?? 60,
  ) * 60;
  const selectedDayShift = useMemo(
    () => selectedAssociateShifts.find((shift) => shift.shift_date === detailDate),
    [detailDate, selectedAssociateShifts],
  );
  const metricDetail = useMemo(() => {
    if (!metricDetailKey || !selectedAssociate) return null;
    const orderedShifts = [...selectedAssociateShifts].sort((a, b) => b.shift_date.localeCompare(a.shift_date));
    const rows = orderedShifts.flatMap((shift) => {
      if (metricDetailKey === "punctual") {
        if (!shift.started_at || !isPunctual(shift, selectedAssociate.schedule.start_time)) return [];
        return [{
          date: fullDate(shift.shift_date),
          primary: `${t("Entrada")} ${timeOnly(shift.started_at)}`,
          secondary: `${t("Asignado")} ${selectedAssociate.schedule.start_time}`,
        }];
      }
      if (metricDetailKey === "tardy") {
        if (!shift.started_at || isPunctual(shift, selectedAssociate.schedule.start_time)) return [];
        return [{
          date: fullDate(shift.shift_date),
          primary: `${t("Entrada")} ${timeOnly(shift.started_at)}`,
          secondary: `${t("Asignado")} ${selectedAssociate.schedule.start_time}`,
        }];
      }
      if (metricDetailKey === "justified") {
        if (!shift.justified_seconds) return [];
        return [{
          date: fullDate(shift.shift_date),
          primary: formatDuration(shift.justified_seconds),
          secondary: `${t("Jornada")} ${timeOnly(shift.started_at)} - ${timeOnly(shift.ended_at)}`,
        }];
      }
      if (metricDetailKey === "break") {
        if (!shift.break_seconds) return [];
        return [{
          date: fullDate(shift.shift_date),
          primary: `${t("Real")} ${formatDuration(shift.break_seconds)}`,
          secondary: `${t("Esperado")} ${formatDuration(expectedBreakSeconds)} - ${comparisonText(shift.break_seconds, expectedBreakSeconds)}`,
        }];
      }
      if (!shift.lunch_seconds) return [];
      return [{
        date: fullDate(shift.shift_date),
        primary: `${t("Real")} ${formatDuration(shift.lunch_seconds)}`,
        secondary: `${t("Esperado")} ${formatDuration(expectedLunchSeconds)} - ${comparisonText(shift.lunch_seconds, expectedLunchSeconds)}`,
      }];
    });
    const titles: Record<MetricDetailKey, string> = {
      punctual: "Puntuales",
      tardy: "Tardanzas",
      justified: "Justificados",
      break: "Break",
      lunch: "Lunch",
    };
    return { title: titles[metricDetailKey], rows };
  }, [expectedBreakSeconds, expectedLunchSeconds, metricDetailKey, selectedAssociate, selectedAssociateShifts, t]);
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
    const justifiedSeconds = shifts.reduce((sum, shift) => sum + (shift.justified_seconds || 0), 0);
    const workSeconds = shifts.reduce((sum, shift) => sum + workedSeconds(shift), 0);
    return { totalEmployees, started, finished, activeNow, absentToday, breakSeconds, lunchSeconds, justifiedSeconds, workSeconds };
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
      setExpectedBreakMinutes(String(selectedAssociate.schedule.expected_break_minutes ?? 15));
      setExpectedLunchMinutes(String(selectedAssociate.schedule.expected_lunch_minutes ?? 60));
      setMetricDetailKey(null);
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
    setStatusText(t("Guardando horario..."));
    try {
      await apiPatch(`/api/attendance/employees/${selectedAssociate.id}/schedule`, {
        start_time: scheduleStart,
        end_time: scheduleEnd,
        expected_break_minutes: parseMinutes(expectedBreakMinutes, 15),
        expected_lunch_minutes: parseMinutes(expectedLunchMinutes, 60),
        effective_from: detailDate,
      });
      await loadAttendance();
      setStatusText(t("Horario actualizado"));
    } catch {
      setStatusText(t("No se pudo guardar el horario"));
    }
  }

  async function saveShiftCorrection() {
    if (!selectedDayShift) return;
    if (correctionReason.trim().length < 3) {
      setStatusText(t("Escribe el motivo de la correccion"));
      return;
    }
    setStatusText(t("Guardando correccion..."));
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
      setStatusText(t("Asistencia corregida"));
    } catch {
      setStatusText(t("No se pudo guardar la correccion"));
    }
  }

  async function createManualShift() {
    if (!selectedAssociate) return;
    if (correctionReason.trim().length < 3) {
      setStatusText(t("Escribe el motivo para crear la jornada"));
      return;
    }
    setStatusText(t("Creando jornada manual..."));
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
      setStatusText(t("Jornada manual creada"));
    } catch {
      setStatusText(t("No se pudo crear la jornada manual"));
    }
  }

  async function downloadReport() {
    const params = new URLSearchParams();
    if (dateFrom) params.set("date_from", dateFrom);
    if (dateTo) params.set("date_to", dateTo);
    if (selectedDepartment) params.set("department_id", selectedDepartment);
    if (selectedEmployee) params.set("employee_id", selectedEmployee);
    const query = params.toString();
    setReportLoading(true);
    setStatusText(t("Generando PDF..."));
    try {
      await downloadAuthenticatedFile(
        `/api/reports/operations.pdf${query ? `?${query}` : ""}`,
        token,
        "vyntra-reporte-asistencia.pdf",
      );
      setStatusText(t("Reporte descargado"));
    } catch {
      setStatusText(t("No se pudo generar el PDF"));
    } finally {
      setReportLoading(false);
    }
  }

  return (
    <AppShell
      title={t("Asistencia")}
      description={`${user?.company || t("Empresa")} - ${t("control de jornada, ausencias, break y lunch.")}`}
      actions={(
        <>
          <button className="secondary-button" onClick={downloadReport} disabled={reportLoading || !overview}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
              <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
              <path d="M14 2v6h6M8 13h8M8 17h5" />
            </svg>
            <span>{reportLoading ? t("Generando PDF...") : "PDF"}</span>
          </button>
          <RefreshButton loading={loading} onClick={loadAttendance} />
        </>
      )}
    >
      <section className="settings-board attendance-board">
        <div className="settings-board-header">
          <div>
            <h2>{t("Asistencia")}</h2>
            <p>{user?.company || t("Empresa")} - {t("control de jornada, ausencias, break y lunch")}</p>
          </div>
          <div className="settings-board-tabs" role="tablist" aria-label="Secciones de asistencia">
          {(Object.keys(viewLabels) as AttendanceView[]).map((key) => (
            <button
              aria-selected={view === key}
              className={view === key ? "active" : ""}
              key={key}
              onClick={() => setView(key)}
              role="tab"
              type="button"
            >
              {t(viewLabels[key])}
            </button>
          ))}
          </div>
        </div>

        <div className="settings-summary-pills attendance-summary-pills" aria-label="Resumen de asistencia">
          <button type="button">{stats.activeNow} {t("activos ahora")}</button>
          <button type="button">{stats.absentToday} {t("ausentes hoy")}</button>
          <button type="button">{formatDuration(stats.breakSeconds)} {t("break")}</button>
          <button type="button">{formatDuration(stats.lunchSeconds)} {t("lunch")}</button>
          <button type="button">{formatDuration(stats.justifiedSeconds)} {t("justificado")}</button>
        </div>

        <div className="filter-row attendance-filter-row">
          <label>
            {t("Desde")}
            <input type="date" value={dateFrom} onChange={(event) => setDateFrom(event.target.value)} />
          </label>
          <label>
            {t("Hasta")}
            <input type="date" value={dateTo} onChange={(event) => setDateTo(event.target.value)} />
          </label>
          <label>
            {t("Departamento")}
            <select value={selectedDepartment} onChange={(event) => setSelectedDepartment(event.target.value)}>
              <option value="">{t("Todos")}</option>
              {departments.map((department) => (
                <option value={department.id} key={department.id}>{department.name}</option>
              ))}
            </select>
          </label>
          <label>
            {t("Empleado")}
            <select value={selectedEmployee} onChange={(event) => setSelectedEmployee(event.target.value)}>
              <option value="">{t("Todos")}</option>
              {employees.map((employee) => (
                <option value={employee.id} key={employee.id}>{employee.full_name}</option>
              ))}
            </select>
          </label>
          <button className="secondary-button" onClick={() => void loadAttendance()} disabled={loading}>{t("Aplicar")}</button>
        </div>

      {!overview ? (
        <Panel title={t("Estado")}>
          <EmptyState>{statusText || t("Cargando asistencia...")}</EmptyState>
        </Panel>
      ) : (
        <>
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
                      <span>{employee.department || t("Sin departamento")}</span>
                    </div>
                    <span className={`badge attendance-${status.tone}`}>{t(status.label)}</span>
                    <dl>
                      <div><dt>{t("Entrada")}</dt><dd>{timeOnly(shift?.started_at || null)}</dd></div>
                      <div><dt>{t("Salida")}</dt><dd>{timeOnly(shift?.ended_at || null)}</dd></div>
                      <div><dt>{t("Activo")}</dt><dd>{formatDuration(workedSeconds(shift))}</dd></div>
                    </dl>
                  </article>
                );
              })}
            </section>
          ) : null}

          {view === "history" ? (
            <Panel title={t("Reporte global de asistencia")} meta={`${employees.length} ${t("asociados")}`}>
              {employeeReportRows.length ? (
                <table>
                  <thead>
                    <tr>
                      <th>{t("Asociado")}</th>
                      <th>{t("Departamento")}</th>
                      <th>{t("Dias asistidos")}</th>
                      <th>{t("Total horas")}</th>
                      <th>{t("Tardanzas")}</th>
                      <th>{t("Estado hoy")}</th>
                      <th>{t("Acciones")}</th>
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
                              <small>{row.employee.email || t("Sin correo laboral")}</small>
                            </div>
                          </div>
                        </td>
                        <td><span className="soft-pill">{row.employee.department || t("Sin departamento")}</span></td>
                        <td><strong>{row.records.length}</strong><small className="table-muted"> {t("registros")}</small></td>
                        <td><span className="time-pill">{formatDuration(row.hours)}</span></td>
                        <td>
                          {row.tardy ? (
                            <span className="badge attendance-bad">{row.tardy}</span>
                          ) : (
                            <span className="table-muted">{t("Ninguna")}</span>
                          )}
                        </td>
                        <td><span className={`badge attendance-${row.latestStatus.tone}`}>{t(row.latestStatus.label)}</span></td>
                        <td>
                          <button className="row-action" onClick={() => setSelectedAssociateId(row.employee.id)}>
                            {t("Detalles")}
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              ) : (
                <EmptyState>{t("No hay asociados para este filtro.")}</EmptyState>
              )}
            </Panel>
          ) : null}

          {view === "groups" ? (
            <section className="attendance-grid group-mode">
              {groupStats.map((row) => (
                <article className="group-card" key={row.department}>
                  <div className="panel-title">
                    <h2>{row.department}</h2>
                    <span>{row.employees} {t("empleados")}</span>
                  </div>
                  <div className="mini-stats">
                    <div><span>{t("Jornadas")}</span><strong>{row.started}</strong></div>
                    <div><span>{t("Finalizadas")}</span><strong>{row.finished}</strong></div>
                    <div><span>{t("Activo")}</span><strong>{formatDuration(row.workSeconds)}</strong></div>
                    <div><span>{t("Lunch")}</span><strong>{formatDuration(row.lunchSeconds)}</strong></div>
                  </div>
                </article>
              ))}
            </section>
          ) : null}

          {view === "summary" ? (
            <section className="summary-grid">
              <Panel title={t("Resumen del rango")} meta={`${dateFrom} - ${dateTo}`}>
                <div className="mini-stats">
                  <div><span>{t("Empleados")}</span><strong>{stats.totalEmployees}</strong></div>
                  <div><span>{t("Jornadas iniciadas")}</span><strong>{stats.started}</strong></div>
                  <div><span>{t("Jornadas finalizadas")}</span><strong>{stats.finished}</strong></div>
                  <div><span>{t("Tiempo activo")}</span><strong>{formatDuration(stats.workSeconds)}</strong></div>
                  <div><span>{t("Break total")}</span><strong>{formatDuration(stats.breakSeconds)}</strong></div>
                  <div><span>{t("Lunch total")}</span><strong>{formatDuration(stats.lunchSeconds)}</strong></div>
                  <div><span>{t("Justificado")}</span><strong>{formatDuration(stats.justifiedSeconds)}</strong></div>
                </div>
              </Panel>
              <Panel title={t("Eventos recientes")} meta="timeline">
                <div className="timeline-list">
                  {shifts.flatMap((shift) =>
                    shift.events.map((event) => ({
                      ...event,
                      employee: employeeLabel(employeeMap.get(shift.employee_id), t("Empleado no encontrado")),
                      shiftDate: shift.shift_date,
                    })),
                  ).slice(-12).reverse().map((event) => (
                    <article className="timeline-item" key={event.id}>
                      <span>{eventLabels[event.event_type] ? t(eventLabels[event.event_type]) : event.event_type}</span>
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
                  <h2>{t("Detalles del asociado")}</h2>
                  <button aria-label={t("Cerrar detalle")} onClick={() => setSelectedAssociateId("")}>x</button>
                </header>
                <div className="detail-modal-body">
                  <aside className="associate-panel">
                    <section className="associate-card">
                      <div className="associate-avatar">
                        {initialsFor(selectedAssociate.full_name)}
                        <span className={`associate-status attendance-${selectedAssociateStatus.tone}`} />
                      </div>
                      <h2>{selectedAssociate.full_name}</h2>
                      <p>{selectedAssociate.department || t("Sin departamento")}</p>
                      <div className="schedule-box editable">
                        <span>{t("Horario asignado")}</span>
                        <div className="time-edit-row">
                          <input
                            aria-label={t("Hora de entrada asignada")}
                            type="time"
                            value={scheduleStart}
                            onChange={(event) => setScheduleStart(event.target.value)}
                          />
                          <input
                            aria-label={t("Hora de salida asignada")}
                            type="time"
                            value={scheduleEnd}
                            onChange={(event) => setScheduleEnd(event.target.value)}
                          />
                        </div>
                        <div className="duration-edit-row">
                          <label>
                            {t("Break esperado")}
                            <input
                              aria-label={t("Minutos de break esperados")}
                              type="number"
                              min="0"
                              max="240"
                              value={expectedBreakMinutes}
                              onChange={(event) => setExpectedBreakMinutes(event.target.value)}
                            />
                          </label>
                          <label>
                            {t("Lunch esperado")}
                            <input
                              aria-label={t("Minutos de lunch esperados")}
                              type="number"
                              min="0"
                              max="240"
                              value={expectedLunchMinutes}
                              onChange={(event) => setExpectedLunchMinutes(event.target.value)}
                            />
                          </label>
                        </div>
                        <button className="row-action" type="button" onClick={saveSchedule}>
                          {t("Guardar horario")}
                        </button>
                      </div>
                    </section>

                    <section className="associate-month">
                      <h3>{t("Resumen del mes")}</h3>
                      <div className="associate-metrics">
                        <button className={metricDetailKey === "punctual" ? "active" : ""} type="button" onClick={() => setMetricDetailKey("punctual")}><span>{t("Puntuales")}</span><strong className="metric-good">{selectedAssociateStats.punctual}</strong></button>
                        <button className={metricDetailKey === "tardy" ? "active" : ""} type="button" onClick={() => setMetricDetailKey("tardy")}><span>{t("Tardanzas")}</span><strong className="metric-bad">{selectedAssociateStats.tardy}</strong></button>
                        <div><span>{t("Jornadas")}</span><strong>{selectedAssociateStats.completed}</strong></div>
                        <div><span>{t("Activo")}</span><strong>{formatDuration(selectedAssociateStats.workSeconds)}</strong></div>
                        <button className={metricDetailKey === "justified" ? "active" : ""} type="button" onClick={() => setMetricDetailKey("justified")}><span>{t("Justificado")}</span><strong>{formatDuration(selectedAssociateStats.justifiedSeconds)}</strong></button>
                        <button className={metricDetailKey === "break" ? "active" : ""} type="button" onClick={() => setMetricDetailKey("break")}><span>{t("Break")}</span><strong>{formatDuration(selectedAssociateStats.breakSeconds)}</strong></button>
                        <button className={metricDetailKey === "lunch" ? "active" : ""} type="button" onClick={() => setMetricDetailKey("lunch")}><span>{t("Lunch")}</span><strong>{formatDuration(selectedAssociateStats.lunchSeconds)}</strong></button>
                      </div>
                    </section>
                  </aside>

                  <section className="modal-history">
                    {metricDetail ? (
                      <div className="metric-detail-card metric-detail-card-side">
                        <div className="metric-detail-header">
                          <span>{t(metricDetail.title)}</span>
                          <button type="button" aria-label={t("Cerrar detalle")} onClick={() => setMetricDetailKey(null)}>x</button>
                        </div>
                        {metricDetail.rows.length ? (
                          <div className="metric-detail-list">
                            {metricDetail.rows.map((row) => (
                              <article key={`${row.date}-${row.primary}-${row.secondary}`}>
                                <small>{row.date}</small>
                                <strong>{row.primary}</strong>
                                <span>{row.secondary}</span>
                              </article>
                            ))}
                          </div>
                        ) : (
                          <p>{t("No hay eventos en este rango.")}</p>
                        )}
                      </div>
                    ) : null}
                    <div className="panel-title">
                      <h2>{t("Historico detallado de actividad")}</h2>
                      <span>{detailDate}</span>
                    </div>
                    <div className="detail-date-filter">
                      <label>
                        {t("Fecha")}
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
                              <span>{t("Total")}: {formatDuration(workedSeconds(selectedDayShift))}</span>
                            </div>
                            <span className={`badge attendance-${statusForShift(selectedDayShift).tone}`}>
                              {t(statusForShift(selectedDayShift).label)}
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
                          <div className="break-lunch-comparison">
                            <span className={selectedDayShift.break_seconds > expectedBreakSeconds ? "over" : "ok"}>
                              {t("Break")}: {formatDuration(selectedDayShift.break_seconds)} / {formatDuration(expectedBreakSeconds)} ({comparisonText(selectedDayShift.break_seconds, expectedBreakSeconds)})
                            </span>
                            <span className={selectedDayShift.lunch_seconds > expectedLunchSeconds ? "over" : "ok"}>
                              {t("Lunch")}: {formatDuration(selectedDayShift.lunch_seconds)} / {formatDuration(expectedLunchSeconds)} ({comparisonText(selectedDayShift.lunch_seconds, expectedLunchSeconds)})
                            </span>
                          </div>
                        </article>
                        <form className="shift-edit-form" onSubmit={(event) => {
                          event.preventDefault();
                          void saveShiftCorrection();
                        }}>
                          <label>{t("Entrada")}<input type="time" value={entryTime} onChange={(event) => setEntryTime(event.target.value)} /></label>
                          <label>{t("Salida")}<input type="time" value={exitTime} onChange={(event) => setExitTime(event.target.value)} /></label>
                          <label>{t("Inicio break")}<input type="time" value={breakStartTime} onChange={(event) => setBreakStartTime(event.target.value)} /></label>
                          <label>{t("Fin break")}<input type="time" value={breakEndTime} onChange={(event) => setBreakEndTime(event.target.value)} /></label>
                          <label>{t("Inicio lunch")}<input type="time" value={lunchStartTime} onChange={(event) => setLunchStartTime(event.target.value)} /></label>
                          <label>{t("Fin lunch")}<input type="time" value={lunchEndTime} onChange={(event) => setLunchEndTime(event.target.value)} /></label>
                          <label className="form-wide">{t("Motivo")}<input value={correctionReason} onChange={(event) => setCorrectionReason(event.target.value)} placeholder={t("Ej. Correccion aprobada por RRHH")} required /></label>
                          <button className="secondary-button" type="submit">{t("Guardar correccion")}</button>
                        </form>
                      </div>
                    ) : (
                      <form className="shift-edit-form" onSubmit={(event) => {
                        event.preventDefault();
                        void createManualShift();
                      }}>
                        <label className="form-wide">{t("Estado")}<input disabled value={t("No hay jornada registrada en esta fecha")} /></label>
                        <label>{t("Entrada")}<input type="time" value={entryTime} onChange={(event) => setEntryTime(event.target.value)} required /></label>
                        <label>{t("Salida")}<input type="time" value={exitTime} onChange={(event) => setExitTime(event.target.value)} /></label>
                        <label>{t("Inicio break")}<input type="time" value={breakStartTime} onChange={(event) => setBreakStartTime(event.target.value)} /></label>
                        <label>{t("Fin break")}<input type="time" value={breakEndTime} onChange={(event) => setBreakEndTime(event.target.value)} /></label>
                        <label>{t("Inicio lunch")}<input type="time" value={lunchStartTime} onChange={(event) => setLunchStartTime(event.target.value)} /></label>
                        <label>{t("Fin lunch")}<input type="time" value={lunchEndTime} onChange={(event) => setLunchEndTime(event.target.value)} /></label>
                        <label className="form-wide">{t("Motivo")}<input value={correctionReason} onChange={(event) => setCorrectionReason(event.target.value)} placeholder={t("Ej. Registro manual aprobado")} required /></label>
                        <button className="secondary-button" type="submit">{t("Crear jornada manual")}</button>
                      </form>
                    )}
                  </section>
                </div>
              </section>
            </div>
          ) : null}
        </>
      )}
      </section>
    </AppShell>
  );
}
