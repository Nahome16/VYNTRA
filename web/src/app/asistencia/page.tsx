"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { AppShell } from "@/components/app-shell";
import { Chip, Drawer, EmptyBlock, RefreshButton, RowMenu, StatusLine, Tabs } from "@/components/ui";
import { useAuth } from "@/components/auth-provider";
import { usePreferences, useT } from "@/components/preferences-provider";
import { AttendanceEmployee, AttendanceOverviewResponse, AttendanceShift } from "@/lib/types";
import { DEFAULT_TIME_ZONE, isValidTimeZone, monthStartISO, todayISO } from "@/lib/dates";
import { formatDuration, fullDate } from "@/lib/format";
import { downloadAuthenticatedFile } from "@/lib/download-file";
import styles from "./asistencia.module.css";

type AttendanceView = "live" | "history" | "groups" | "summary";
type MetricDetailKey = "punctual" | "tardy" | "justified" | "break" | "lunch";
type QuickFilter = "all" | "live" | "paused" | "absent" | "finished" | "late";
type DetailTab = "summary" | "day" | "schedule";
type Tone = "plain" | "good" | "warn" | "bad";

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
  activity_snapshot: "Actividad",
  browser_activity_snapshot: "Actividad navegador",
  station_tab_closed: "Pestana cerrada",
};

const eventTones: Record<string, "plain" | "good" | "warn" | "accent" | "info"> = {
  shift_started: "good",
  shift_finished: "plain",
  break_started: "warn",
  break_finished: "warn",
  lunch_started: "info",
  lunch_finished: "info",
  overtime_started: "accent",
  overtime_finished: "accent",
};

/* --- Composicion de la jornada (barra de jornada) ------------------------- */

type ShiftMix = { work: number; break: number; lunch: number; idle: number; overtime: number };

const mixParts: Array<{ key: keyof ShiftMix; label: string; className: string; swatch: string }> = [
  { key: "work", label: "Trabajo", className: "seg-work", swatch: styles.swWork },
  { key: "break", label: "Break", className: "seg-break", swatch: styles.swBreak },
  { key: "lunch", label: "Lunch", className: "seg-lunch", swatch: styles.swLunch },
  { key: "idle", label: "Inactivo", className: "seg-idle", swatch: styles.swIdle },
  { key: "overtime", label: "Extra", className: "seg-overtime", swatch: styles.swOvertime },
];

function emptyMix(): ShiftMix {
  return { work: 0, break: 0, lunch: 0, idle: 0, overtime: 0 };
}

function mixTotal(mix: ShiftMix) {
  return mix.work + mix.break + mix.lunch + mix.idle + mix.overtime;
}

/** Segundos en horas extra a partir de los eventos overtime_started/overtime_finished. */
function overtimeSeconds(shift: AttendanceShift) {
  let total = 0;
  let openedAt: number | null = null;
  shift.events.forEach((event) => {
    const time = new Date(event.occurred_at).getTime();
    if (!Number.isFinite(time)) return;
    if (event.event_type === "overtime_started") openedAt = time;
    if (event.event_type === "overtime_finished" && openedAt !== null) {
      total += Math.max(0, time - openedAt) / 1000;
      openedAt = null;
    }
  });
  if (openedAt !== null && !shift.ended_at) total += Math.max(0, Date.now() - openedAt) / 1000;
  return Math.floor(total);
}

/** Reparte la duracion de las jornadas en trabajo / break / lunch / inactivo / extra. */
function addShiftToMix(mix: ShiftMix, shift: AttendanceShift) {
  if (!shift.started_at) return mix;
  const span = workedSeconds(shift);
  const breakSeconds = Math.max(0, shift.break_seconds || 0);
  const lunchSeconds = Math.max(0, shift.lunch_seconds || 0);
  const idleSeconds = Math.max(0, shift.idle_seconds || 0);
  const extraSeconds = overtimeSeconds(shift);
  mix.break += breakSeconds;
  mix.lunch += lunchSeconds;
  mix.idle += idleSeconds;
  mix.overtime += extraSeconds;
  mix.work += Math.max(0, span - breakSeconds - lunchSeconds - idleSeconds - extraSeconds);
  return mix;
}

function shiftMix(shifts: AttendanceShift[]) {
  return shifts.reduce(addShiftToMix, emptyMix());
}

function ShiftBar({ mix, className = "" }: { mix: ShiftMix; className?: string }) {
  const t = useT();
  const total = mixTotal(mix);
  const summary = total
    ? mixParts
        .filter((part) => mix[part.key] > 0)
        .map((part) => `${t(part.label)} ${formatDuration(mix[part.key])}`)
        .join(" · ")
    : t("Sin jornada registrada");
  return (
    <div className={`shift-bar ${className}`} role="img" aria-label={summary} title={summary}>
      {total
        ? mixParts.map((part) =>
            mix[part.key] > 0 ? (
              <i key={part.key} className={part.className} style={{ width: `${(mix[part.key] / total) * 100}%` }} />
            ) : null,
          )
        : null}
    </div>
  );
}

function ShiftLegend({ mix }: { mix?: ShiftMix }) {
  const t = useT();
  return (
    <ul className={styles.legend} aria-label={t("Leyenda de la barra de jornada")}>
      {mixParts.map((part) => (
        <li key={part.key}>
          <i className={part.swatch} aria-hidden />
          <span>{t(part.label)}</span>
          {mix ? <b className="tabular">{formatDuration(mix[part.key])}</b> : null}
        </li>
      ))}
    </ul>
  );
}

/* --- Utilidades existentes ------------------------------------------------ */

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
  const phase = (shift.current_phase || "").toUpperCase();
  if (shift.ended_at || shift.status === "closed" || phase === "TERMINADO") return { label: "Finalizado", tone: "plain" as const };
  if (phase === "LUNCH") return { label: "Almuerzo", tone: "warn" as const };
  if (phase === "BREAK" || phase === "PAUSADO") return { label: "Break", tone: "warn" as const };
  const lastEvent = shift.events.at(-1)?.event_type;
  if (lastEvent === "lunch_started") return { label: "Almuerzo", tone: "warn" as const };
  if (lastEvent === "break_started") return { label: "Break", tone: "warn" as const };
  return { label: "Activo", tone: "good" as const };
}

function workedSeconds(shift?: AttendanceShift) {
  if (!shift?.started_at) return 0;
  const startedAt = new Date(shift.started_at).getTime();
  const endedAt = shift.ended_at ? new Date(shift.ended_at).getTime() : Date.now();
  if (!Number.isFinite(startedAt) || !Number.isFinite(endedAt)) return 0;
  return Math.max(0, Math.floor((endedAt - startedAt) / 1000));
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

/** Jornada de un dia anterior que quedo abierta (sin salida ni cierre). */
function isUnclosed(shift: AttendanceShift, today: string) {
  return Boolean(shift.started_at) && !shift.ended_at && shift.status !== "closed" && shift.shift_date < today;
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

function shiftTimelineEnd(shift: AttendanceShift) {
  return shift.ended_at || (shift.started_at ? new Date().toISOString() : null);
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

function statusGroup(label: string): Exclude<QuickFilter, "all" | "late"> {
  if (label === "Activo") return "live";
  if (label === "Break" || label === "Almuerzo") return "paused";
  if (label === "Ausente") return "absent";
  return "finished";
}

export default function AttendancePage() {
  const { apiGet, apiPost, apiPatch, token, activeCompanyId, user } = useAuth();
  const { t } = usePreferences();
  const [view, setView] = useState<AttendanceView>("history");
  const [quickFilter, setQuickFilter] = useState<QuickFilter>("all");
  const [overview, setOverview] = useState<AttendanceOverviewResponse | null>(null);
  const [selectedDepartment, setSelectedDepartment] = useState("");
  const [selectedEmployee, setSelectedEmployee] = useState("");
  const [selectedAssociateId, setSelectedAssociateId] = useState("");
  const [detailTab, setDetailTab] = useState<DetailTab>("summary");
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
  const isSystemAdmin = user?.role === "system_admin";

  const loadAttendance = useCallback(async (range?: { dateFrom?: string; dateTo?: string; silent?: boolean }) => {
    if (isSystemAdmin && !activeCompanyId) {
      setOverview(null);
      setStatusText(t("Selecciona una empresa en Sistema para ver asistencia"));
      return;
    }
    if (!range?.silent) {
      setLoading(true);
      setStatusText(t("Actualizando asistencia..."));
    }
    const params = new URLSearchParams();
    const nextDateFrom = range?.dateFrom ?? dateFrom;
    const nextDateTo = range?.dateTo ?? dateTo;
    if (nextDateFrom) params.set("date_from", nextDateFrom);
    if (nextDateTo) params.set("date_to", nextDateTo);
    if (isSystemAdmin && activeCompanyId) params.set("company_id", activeCompanyId);
    if (selectedDepartment) params.set("department_id", selectedDepartment);
    if (selectedEmployee) params.set("employee_id", selectedEmployee);

    try {
      const nextOverview = await apiGet<AttendanceOverviewResponse>(
        `/api/attendance/overview?${params.toString()}`,
      );
      setOverview(nextOverview);
      if (!range?.silent) setStatusText(t("Datos actualizados"));
    } catch {
      if (!range?.silent) setStatusText(t("No se pudo cargar asistencia"));
    } finally {
      if (!range?.silent) setLoading(false);
    }
  }, [activeCompanyId, apiGet, dateFrom, dateTo, isSystemAdmin, selectedDepartment, selectedEmployee, t]);

  useEffect(() => {
    if (!user) return;
    const timer = window.setTimeout(() => {
      void loadAttendance();
    }, 0);
    return () => window.clearTimeout(timer);
  }, [loadAttendance, user]);

  // Refresco en vivo cada 30 s, pausado mientras la pestana no esta visible; al
  // volver a la pestana se refresca de inmediato y se reanuda el intervalo.
  useEffect(() => {
    if (!user || view !== "live") return;
    let timer: number | undefined;
    const start = () => {
      if (timer !== undefined) return;
      timer = window.setInterval(() => {
        void loadAttendance({ silent: true });
      }, 30000);
    };
    const stop = () => {
      if (timer === undefined) return;
      window.clearInterval(timer);
      timer = undefined;
    };
    const onVisibilityChange = () => {
      if (document.hidden) {
        stop();
        return;
      }
      void loadAttendance({ silent: true });
      start();
    };
    if (!document.hidden) start();
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => {
      stop();
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, [loadAttendance, user, view]);

  useEffect(() => {
    if (!isSystemAdmin) return;
    const timer = window.setTimeout(() => {
      setSelectedDepartment("");
      setSelectedEmployee("");
      setSelectedAssociateId("");
      setMetricDetailKey(null);
    }, 0);
    return () => window.clearTimeout(timer);
  }, [activeCompanyId, isSystemAdmin]);

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
  // Zona horaria de la empresa: la de los horarios de sus empleados (fallback America/Managua).
  const companyTimeZone = useMemo(
    () => employees.map((employee) => employee.schedule?.timezone).find(isValidTimeZone) || DEFAULT_TIME_ZONE,
    [employees],
  );
  const companyToday = todayISO(companyTimeZone);
  const todayShifts = useMemo(
    () => shifts.filter((shift) => shift.shift_date === companyToday),
    [companyToday, shifts],
  );
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
  const selectedAssociateMix = useMemo(() => shiftMix(selectedAssociateShifts), [selectedAssociateShifts]);
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
          secondary: `${t("Esperado")} ${formatDuration(expectedBreakSeconds)} - ${t(comparisonText(shift.break_seconds, expectedBreakSeconds))}`,
        }];
      }
      if (!shift.lunch_seconds) return [];
      return [{
        date: fullDate(shift.shift_date),
        primary: `${t("Real")} ${formatDuration(shift.lunch_seconds)}`,
        secondary: `${t("Esperado")} ${formatDuration(expectedLunchSeconds)} - ${t(comparisonText(shift.lunch_seconds, expectedLunchSeconds))}`,
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
        const todayShift = latestTodayByEmployee.get(employee.id);
        const records = shifts.filter((shift) => shift.employee_id === employee.id && shift.started_at);
        return {
          employee,
          todayShift,
          records,
          hours: records.reduce((sum, shift) => sum + workedSeconds(shift), 0),
          tardy: records.filter((shift) => !isPunctual(shift, employee.schedule.start_time)).length,
          lateToday: Boolean(todayShift?.started_at && !isPunctual(todayShift, employee.schedule.start_time)),
          unclosed: records.filter((shift) => isUnclosed(shift, companyToday)).length,
          latestStatus: statusForShift(todayShift),
          mix: shiftMix(records),
          todayMix: shiftMix(todayShift ? [todayShift] : []),
        };
      }),
    [companyToday, employees, latestTodayByEmployee, shifts],
  );
  type ReportRow = (typeof employeeReportRows)[number];

  const matchesQuickFilter = useCallback(
    (row: ReportRow, filter: QuickFilter) => {
      if (filter === "all") return true;
      if (filter === "late") return view === "live" ? row.lateToday : row.tardy > 0;
      return statusGroup(row.latestStatus.label) === filter;
    },
    [view],
  );
  const quickFilterCounts = useMemo(() => {
    const keys: QuickFilter[] = ["all", "live", "paused", "absent", "finished", "late"];
    return Object.fromEntries(
      keys.map((key) => [key, employeeReportRows.filter((row) => matchesQuickFilter(row, key)).length]),
    ) as Record<QuickFilter, number>;
  }, [employeeReportRows, matchesQuickFilter]);
  const visibleRows = useMemo(
    () => employeeReportRows.filter((row) => matchesQuickFilter(row, quickFilter)),
    [employeeReportRows, matchesQuickFilter, quickFilter],
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
  const rangeMix = useMemo(() => shiftMix(shifts), [shifts]);

  const groupStats = useMemo(() => {
    const rows = new Map<string, {
      department: string;
      employees: number;
      started: number;
      finished: number;
      breakSeconds: number;
      lunchSeconds: number;
      workSeconds: number;
      mix: ShiftMix;
    }>();
    employees.forEach((employee) => {
      const key = employee.department_id || "none";
      rows.set(key, {
        department: employee.department || t("Sin departamento"),
        employees: (rows.get(key)?.employees || 0) + 1,
        started: rows.get(key)?.started || 0,
        finished: rows.get(key)?.finished || 0,
        breakSeconds: rows.get(key)?.breakSeconds || 0,
        lunchSeconds: rows.get(key)?.lunchSeconds || 0,
        workSeconds: rows.get(key)?.workSeconds || 0,
        mix: rows.get(key)?.mix || emptyMix(),
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
      addShiftToMix(row.mix, shift);
    });
    return Array.from(rows.values()).sort((a, b) => a.department.localeCompare(b.department));
  }, [employees, employeeMap, shifts, t]);

  const recentEvents = useMemo(
    () =>
      shifts
        .flatMap((shift) =>
          shift.events.map((event) => ({
            ...event,
            employee: employeeLabel(employeeMap.get(shift.employee_id), t("Empleado no encontrado")),
            shiftDate: shift.shift_date,
          })),
        )
        .slice(-12)
        .reverse(),
    [employeeMap, shifts, t],
  );

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

  function openDetail(employeeId: string, tab: DetailTab = "summary") {
    setDetailTab(tab);
    setSelectedAssociateId(employeeId);
  }

  function clearFilters() {
    setQuickFilter("all");
    setSelectedDepartment("");
    setSelectedEmployee("");
  }

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
    if (isSystemAdmin && activeCompanyId) params.set("company_id", activeCompanyId);
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

  function rowMenu(employee: AttendanceEmployee) {
    return (
      <RowMenu
        label={`${t("Acciones de")} ${employee.full_name}`}
        items={[
          { label: t("Ver detalles"), onSelect: () => openDetail(employee.id, "summary") },
          { label: t("Corregir jornada"), onSelect: () => openDetail(employee.id, "day") },
          { label: t("Editar horario"), onSelect: () => openDetail(employee.id, "schedule") },
        ]}
      />
    );
  }

  function personCell(employee: AttendanceEmployee, secondary: string, live: boolean) {
    return (
      <div className={styles.person}>
        <span className={`avatar ${styles.avatar}`} aria-hidden>{initialsFor(employee.full_name)}</span>
        <div>
          <strong>
            {employee.full_name}
            {live ? <span className={`live-dot ${styles.liveDot}`} role="img" aria-label={t("En vivo")} title={t("Trabajando ahora")} /> : null}
          </strong>
          <small>{secondary}</small>
        </div>
      </div>
    );
  }

  const quickFilters: Array<{ key: QuickFilter; label: string }> = [
    { key: "all", label: "Todos" },
    { key: "live", label: "En vivo" },
    { key: "paused", label: "En pausa" },
    { key: "absent", label: "Ausentes" },
    { key: "finished", label: "Finalizados" },
    { key: "late", label: view === "live" ? "Tarde hoy" : "Con tardanzas" },
  ];
  const showQuickFilters = view === "live" || view === "history";
  const noRowsBlock = (
    <EmptyBlock
      title={t("No hay asociados para este filtro.")}
      description={t("Ajusta el rango de fechas, el departamento o el estado.")}
      action={
        <button type="button" className="btn btn-outline btn-sm" onClick={clearFilters}>
          {t("Limpiar filtros")}
        </button>
      }
    />
  );

  return (
    <AppShell
      title={t("Asistencia")}
      description={`${overview?.company.name || user?.company || t("Empresa")} - ${t("control de jornada, ausencias, break y lunch.")}`}
      actions={(
        <>
          <button className="btn btn-outline" onClick={downloadReport} disabled={reportLoading || !overview}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
              <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
              <path d="M14 2v6h6M8 13h8M8 17h5" />
            </svg>
            <span>{reportLoading ? t("Generando PDF...") : t("Exportar PDF")}</span>
          </button>
          <RefreshButton loading={loading} onClick={() => void loadAttendance()} />
        </>
      )}
    >
      <div className={styles.page}>
        <div className={`toolbar ${styles.toolbar}`}>
          <div className="segmented" role="group" aria-label={t("Secciones de asistencia")}>
            {(Object.keys(viewLabels) as AttendanceView[]).map((key) => (
              <button aria-pressed={view === key} key={key} onClick={() => setView(key)} type="button">
                {key === "live" ? <span className={`live-dot ${styles.segDot}`} aria-hidden /> : null}
                {t(viewLabels[key])}
              </button>
            ))}
          </div>
          <span className="grow" />
          <div className={styles.range} role="group" aria-label={t("Rango de fechas")}>
            <input type="date" aria-label={t("Desde")} value={dateFrom} onChange={(event) => setDateFrom(event.target.value)} />
            <span aria-hidden>–</span>
            <input type="date" aria-label={t("Hasta")} value={dateTo} onChange={(event) => setDateTo(event.target.value)} />
          </div>
          <select aria-label={t("Departamento")} value={selectedDepartment} onChange={(event) => setSelectedDepartment(event.target.value)}>
            <option value="">{t("Todos los departamentos")}</option>
            {departments.map((department) => (
              <option value={department.id} key={department.id}>{department.name}</option>
            ))}
          </select>
          <select aria-label={t("Empleado")} value={selectedEmployee} onChange={(event) => setSelectedEmployee(event.target.value)}>
            <option value="">{t("Todos los empleados")}</option>
            {employees.map((employee) => (
              <option value={employee.id} key={employee.id}>{employee.full_name}</option>
            ))}
          </select>
          <button className="btn btn-outline" onClick={() => void loadAttendance()} disabled={loading}>{t("Aplicar")}</button>
        </div>

        {overview ? (
        <section className={styles.metrics} aria-label={t("Resumen de asistencia")}>
          <div>
            <span><i className={`live-dot ${styles.metricDot}`} aria-hidden />{t("Activos ahora")}</span>
            <strong className="tabular">{stats.activeNow}</strong>
            <small>{t("de")} {stats.totalEmployees} {t("asociados")}</small>
          </div>
          <div>
            <span>{t("Ausentes hoy")}</span>
            <strong className={`tabular ${stats.absentToday ? styles.valueBad : ""}`}>{stats.absentToday}</strong>
            <small>{t("sin entrada registrada")}</small>
          </div>
          <div>
            <span>{t("Break")}</span>
            <strong className="tabular">{formatDuration(stats.breakSeconds)}</strong>
            <small>{t("en el rango")}</small>
          </div>
          <div>
            <span>{t("Lunch")}</span>
            <strong className="tabular">{formatDuration(stats.lunchSeconds)}</strong>
            <small>{t("en el rango")}</small>
          </div>
          <div>
            <span>{t("Justificado")}</span>
            <strong className="tabular">{formatDuration(stats.justifiedSeconds)}</strong>
            <small>{t("por incidencias aprobadas")}</small>
          </div>
        </section>
        ) : null}

        {!overview ? (
          <EmptyBlock title={statusText || t("Cargando asistencia...")} />
        ) : (
          <>
            {showQuickFilters ? (
              <div className={styles.quickRow}>
                <div className={styles.quickFilters} role="group" aria-label={t("Filtro rapido por estado")}>
                  {quickFilters.map((filter) => (
                    <button
                      key={filter.key}
                      type="button"
                      aria-pressed={quickFilter === filter.key}
                      onClick={() => setQuickFilter(filter.key)}
                    >
                      {filter.key === "live" ? <span className={`live-dot ${styles.chipDot}`} aria-hidden /> : null}
                      {t(filter.label)}
                      <b className="tabular">{quickFilterCounts[filter.key]}</b>
                    </button>
                  ))}
                </div>
                <ShiftLegend />
              </div>
            ) : null}

            {view === "live" ? (
              <section className={styles.card}>
                <header className={styles.cardHead}>
                  <div>
                    <h2>{t("Jornada de hoy")}</h2>
                    <span>{fullDate(companyToday)} · {t("se actualiza cada 30 s")}</span>
                  </div>
                  <span className={styles.cardMeta}>{visibleRows.length} {t("asociados")}</span>
                </header>
                {visibleRows.length ? (
                  <div className={styles.tableWrap}>
                    <table className={`${styles.table} ${styles.clickable}`}>
                      <thead>
                        <tr>
                          <th>{t("Empleado")}</th>
                          <th>{t("Estado")}</th>
                          <th>{t("Entrada")}</th>
                          <th>{t("Salida")}</th>
                          <th className={styles.barCol}>{t("Jornada")}</th>
                          <th aria-label={t("Acciones")} />
                        </tr>
                      </thead>
                      <tbody>
                        {visibleRows.map((row) => (
                          <tr
                            key={row.employee.id}
                            className={selectedAssociate?.id === row.employee.id ? "selected-row" : ""}
                            onClick={() => openDetail(row.employee.id)}
                          >
                            <td>{personCell(row.employee, row.employee.department || t("Sin departamento"), row.latestStatus.label === "Activo")}</td>
                            <td>
                              <div className={styles.chips}>
                                <Chip tone={row.latestStatus.tone}>{t(row.latestStatus.label)}</Chip>
                                {row.todayShift?.started_at ? (
                                  row.lateToday ? <Chip tone="bad" dot={false}>{t("Tarde")}</Chip> : <Chip tone="good" dot={false}>{t("A tiempo")}</Chip>
                                ) : null}
                              </div>
                            </td>
                            <td className="tabular">{timeOnly(row.todayShift?.started_at || null)}</td>
                            <td className="tabular">{timeOnly(row.todayShift?.ended_at || null)}</td>
                            <td className={styles.barCol}>
                              <div className={styles.barCell}>
                                <ShiftBar mix={row.todayMix} />
                                <span className="tabular">{formatDuration(workedSeconds(row.todayShift))}</span>
                              </div>
                            </td>
                            <td className={styles.menuCol}>{rowMenu(row.employee)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                ) : (
                  <div className={styles.cardEmpty}>{noRowsBlock}</div>
                )}
              </section>
            ) : null}

            {view === "history" ? (
              <section className={styles.card}>
                <header className={styles.cardHead}>
                  <div>
                    <h2>{t("Reporte global de asistencia")}</h2>
                    <span>{fullDate(dateFrom)} – {fullDate(dateTo)}</span>
                  </div>
                  <span className={styles.cardMeta}>{visibleRows.length} {t("asociados")}</span>
                </header>
                {visibleRows.length ? (
                  <div className={styles.tableWrap}>
                    <table className={`${styles.table} ${styles.clickable}`}>
                      <thead>
                        <tr>
                          <th>{t("Asociado")}</th>
                          <th>{t("Departamento")}</th>
                          <th className="num">{t("Dias asistidos")}</th>
                          <th>{t("Tardanzas")}</th>
                          <th className={styles.barCol}>{t("Total horas")}</th>
                          <th>{t("Estado hoy")}</th>
                          <th aria-label={t("Acciones")} />
                        </tr>
                      </thead>
                      <tbody>
                        {visibleRows.map((row) => (
                          <tr
                            key={row.employee.id}
                            className={selectedAssociate?.id === row.employee.id ? "selected-row" : ""}
                            onClick={() => openDetail(row.employee.id)}
                          >
                            <td>{personCell(row.employee, row.employee.email || t("Sin correo laboral"), row.latestStatus.label === "Activo")}</td>
                            <td>{row.employee.department || t("Sin departamento")}</td>
                            <td className="num">
                              <strong className={styles.strongNum}>{row.records.length}</strong>
                              <small className={styles.unit}> {t("registros")}</small>
                            </td>
                            <td>
                              {row.tardy ? (
                                <Chip tone="bad">{row.tardy}</Chip>
                              ) : (
                                <span className={styles.muted}>{t("Ninguna")}</span>
                              )}
                            </td>
                            <td className={styles.barCol}>
                              <div className={styles.barCell}>
                                <ShiftBar mix={row.mix} />
                                <span className="tabular">{formatDuration(row.hours)}</span>
                              </div>
                            </td>
                            <td>
                              <div className={styles.chips}>
                                <Chip tone={row.latestStatus.tone}>{t(row.latestStatus.label)}</Chip>
                                {row.unclosed ? (
                                  <Chip tone="warn" dot={false}>{row.unclosed} {t("sin cerrar")}</Chip>
                                ) : null}
                              </div>
                            </td>
                            <td className={styles.menuCol}>{rowMenu(row.employee)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                ) : (
                  <div className={styles.cardEmpty}>{noRowsBlock}</div>
                )}
              </section>
            ) : null}

            {view === "groups" ? (
              <section className={styles.card}>
                <header className={styles.cardHead}>
                  <div>
                    <h2>{t("Asistencia por departamento")}</h2>
                    <span>{fullDate(dateFrom)} – {fullDate(dateTo)}</span>
                  </div>
                  <ShiftLegend />
                </header>
                {groupStats.length ? (
                  <div className={styles.tableWrap}>
                    <table className={styles.table}>
                      <thead>
                        <tr>
                          <th>{t("Departamento")}</th>
                          <th className="num">{t("Empleados")}</th>
                          <th className="num">{t("Jornadas")}</th>
                          <th className="num">{t("Finalizadas")}</th>
                          <th className={styles.barCol}>{t("Jornada total")}</th>
                          <th className="num">{t("Break")}</th>
                          <th className="num">{t("Lunch")}</th>
                        </tr>
                      </thead>
                      <tbody>
                        {groupStats.map((row) => (
                          <tr key={row.department}>
                            <td><strong className={styles.strongText}>{row.department}</strong></td>
                            <td className="num">{row.employees}</td>
                            <td className="num">{row.started}</td>
                            <td className="num">{row.finished}</td>
                            <td className={styles.barCol}>
                              <div className={styles.barCell}>
                                <ShiftBar mix={row.mix} />
                                <span className="tabular">{formatDuration(row.workSeconds)}</span>
                              </div>
                            </td>
                            <td className="num">{formatDuration(row.breakSeconds)}</td>
                            <td className="num">{formatDuration(row.lunchSeconds)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                ) : (
                  <div className={styles.cardEmpty}>
                    <EmptyBlock title={t("No hay departamentos con asociados.")} description={t("Asigna departamentos en Ajustes para agrupar la asistencia.")} />
                  </div>
                )}
              </section>
            ) : null}

            {view === "summary" ? (
              <section className={styles.summaryGrid}>
                <section className={styles.card}>
                  <header className={styles.cardHead}>
                    <div>
                      <h2>{t("Resumen del rango")}</h2>
                      <span>{fullDate(dateFrom)} – {fullDate(dateTo)}</span>
                    </div>
                  </header>
                  <div className={styles.cardBody}>
                    <ShiftBar mix={rangeMix} className={styles.bigBar} />
                    <ShiftLegend mix={rangeMix} />
                    <dl className={styles.facts}>
                      <div><dt>{t("Empleados")}</dt><dd>{stats.totalEmployees}</dd></div>
                      <div><dt>{t("Jornadas iniciadas")}</dt><dd>{stats.started}</dd></div>
                      <div><dt>{t("Jornadas finalizadas")}</dt><dd>{stats.finished}</dd></div>
                      <div><dt>{t("Jornada total")}</dt><dd>{formatDuration(stats.workSeconds)}</dd></div>
                      <div><dt>{t("Break total")}</dt><dd>{formatDuration(stats.breakSeconds)}</dd></div>
                      <div><dt>{t("Lunch total")}</dt><dd>{formatDuration(stats.lunchSeconds)}</dd></div>
                      <div><dt>{t("Justificado")}</dt><dd>{formatDuration(stats.justifiedSeconds)}</dd></div>
                    </dl>
                  </div>
                </section>
                <section className={styles.card}>
                  <header className={styles.cardHead}>
                    <div>
                      <h2>{t("Eventos recientes")}</h2>
                      <span>{t("Ultimos 12 eventos del rango")}</span>
                    </div>
                  </header>
                  {recentEvents.length ? (
                    <ul className={styles.events}>
                      {recentEvents.map((event) => (
                        <li key={event.id}>
                          <Chip tone={eventTones[event.event_type] || "plain"}>
                            {eventLabels[event.event_type] ? t(eventLabels[event.event_type]) : event.event_type}
                          </Chip>
                          <strong>{event.employee}</strong>
                          <small className="tabular">{fullDate(event.shiftDate)} · {timeOnly(event.occurred_at)}</small>
                        </li>
                      ))}
                    </ul>
                  ) : (
                    <div className={styles.cardEmpty}>
                      <EmptyBlock title={t("Sin eventos en el rango")} description={t("Los marcajes apareceran aqui en cuanto se registren.")} />
                    </div>
                  )}
                </section>
              </section>
            ) : null}
          </>
        )}
        <StatusLine>{statusText}</StatusLine>
      </div>

      <Drawer
        open={Boolean(selectedAssociate)}
        wide
        title={selectedAssociate?.full_name || t("Detalles del asociado")}
        description={
          selectedAssociate
            ? `${selectedAssociate.department || t("Sin departamento")} · ${t("Horario")} ${selectedAssociate.schedule.start_time} – ${selectedAssociate.schedule.end_time}`
            : undefined
        }
        onClose={() => setSelectedAssociateId("")}
        footer={
          <>
            <div className={styles.footStatus}><StatusLine>{statusText}</StatusLine></div>
            <button type="button" className="btn btn-outline" onClick={() => setSelectedAssociateId("")}>{t("Cerrar")}</button>
          </>
        }
      >
        {selectedAssociate ? (
          <>
            <div className={styles.drawerHead}>
              <Chip tone={selectedAssociateStatus.tone}>{t(selectedAssociateStatus.label)}</Chip>
              {selectedAssociateStatus.label === "Activo" ? (
                <span className={styles.liveText}><span className="live-dot" aria-hidden />{t("Trabajando ahora")}</span>
              ) : null}
              <span className={styles.muted}>{selectedAssociate.email || t("Sin correo laboral")}</span>
            </div>
            <div className={styles.tabsReset}>
              <Tabs<DetailTab>
                value={detailTab}
                onChange={setDetailTab}
                tabs={[
                  { id: "summary", label: t("Resumen") },
                  { id: "day", label: t("Jornada del dia") },
                  { id: "schedule", label: t("Horario") },
                ]}
              />
            </div>

            {detailTab === "summary" ? (
              <div className="drawer-section">
                <div className={styles.sectionHead}>
                  <h3>{t("Resumen del rango")}</h3>
                  <span>{fullDate(dateFrom)} – {fullDate(dateTo)}</span>
                </div>
                <div className={styles.metricGrid}>
                  <button className={styles.metricButton} aria-pressed={metricDetailKey === "punctual"} type="button" onClick={() => setMetricDetailKey("punctual")}><span>{t("Puntuales")}</span><strong className={styles.valueGood}>{selectedAssociateStats.punctual}</strong></button>
                  <button className={styles.metricButton} aria-pressed={metricDetailKey === "tardy"} type="button" onClick={() => setMetricDetailKey("tardy")}><span>{t("Tardanzas")}</span><strong className={styles.valueBad}>{selectedAssociateStats.tardy}</strong></button>
                  <div className={styles.metricStatic}><span>{t("Jornadas")}</span><strong>{selectedAssociateStats.completed}</strong></div>
                  <div className={styles.metricStatic}><span>{t("Jornada total")}</span><strong>{formatDuration(selectedAssociateStats.workSeconds)}</strong></div>
                  <button className={styles.metricButton} aria-pressed={metricDetailKey === "justified"} type="button" onClick={() => setMetricDetailKey("justified")}><span>{t("Justificado")}</span><strong>{formatDuration(selectedAssociateStats.justifiedSeconds)}</strong></button>
                  <button className={styles.metricButton} aria-pressed={metricDetailKey === "break"} type="button" onClick={() => setMetricDetailKey("break")}><span>{t("Break")}</span><strong>{formatDuration(selectedAssociateStats.breakSeconds)}</strong></button>
                  <button className={styles.metricButton} aria-pressed={metricDetailKey === "lunch"} type="button" onClick={() => setMetricDetailKey("lunch")}><span>{t("Lunch")}</span><strong>{formatDuration(selectedAssociateStats.lunchSeconds)}</strong></button>
                </div>
                <p className="field-hint">{t("Selecciona una metrica para ver el detalle por dia.")}</p>
                {metricDetail ? (
                  <div className={styles.metricDetail}>
                    <div className={styles.metricDetailHead}>
                      <strong>{t(metricDetail.title)}</strong>
                      <button type="button" className="icon-button" aria-label={t("Cerrar detalle")} onClick={() => setMetricDetailKey(null)}>
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden>
                          <path d="M18 6 6 18M6 6l12 12" />
                        </svg>
                      </button>
                    </div>
                    {metricDetail.rows.length ? (
                      <ul>
                        {metricDetail.rows.map((row) => (
                          <li key={`${row.date}-${row.primary}-${row.secondary}`}>
                            <small className="tabular">{row.date}</small>
                            <strong>{row.primary}</strong>
                            <span>{row.secondary}</span>
                          </li>
                        ))}
                      </ul>
                    ) : (
                      <p className={styles.muted}>{t("No hay eventos en este rango.")}</p>
                    )}
                  </div>
                ) : null}
                <div className={styles.mixBlock}>
                  <span className={styles.subLabel}>{t("Distribucion del tiempo")}</span>
                  <ShiftBar mix={selectedAssociateMix} className={styles.bigBar} />
                  <ShiftLegend mix={selectedAssociateMix} />
                </div>
              </div>
            ) : null}

            {detailTab === "day" ? (
              <div className="drawer-section">
                <div className={styles.sectionHead}>
                  <h3>{t("Historico detallado de actividad")}</h3>
                  <label className={styles.inlineLabel}>
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
                  <>
                    <article className={styles.dayCard}>
                      <div className={styles.dayHead}>
                        <div>
                          <strong>{shortDate(selectedDayShift.shift_date)}</strong>
                          <span>{t("Total")}: {formatDuration(workedSeconds(selectedDayShift))}</span>
                        </div>
                        <div className={styles.chips}>
                          <Chip tone={statusForShift(selectedDayShift).tone as Tone}>{t(statusForShift(selectedDayShift).label)}</Chip>
                          {selectedDayShift.started_at ? (
                            isPunctual(selectedDayShift, selectedAssociate.schedule.start_time)
                              ? <Chip tone="good" dot={false}>{t("A tiempo")}</Chip>
                              : <Chip tone="bad" dot={false}>{t("Tarde")}</Chip>
                          ) : null}
                          {isUnclosed(selectedDayShift, companyToday) ? <Chip tone="warn" dot={false}>{t("Sin cerrar")}</Chip> : null}
                        </div>
                      </div>
                      <div className={styles.dayTrack} aria-hidden>
                        {selectedDayShift.started_at ? (
                          <span className={styles.trackWork} style={timelineSpan(selectedDayShift.started_at, shiftTimelineEnd(selectedDayShift), 1)} />
                        ) : null}
                        {eventTime(selectedDayShift, "break_started") && eventTime(selectedDayShift, "break_finished") ? (
                          <span
                            className={styles.trackBreak}
                            style={timelineSpan(
                              eventTime(selectedDayShift, "break_started"),
                              eventTime(selectedDayShift, "break_finished"),
                              0.5,
                            )}
                          />
                        ) : null}
                        {eventTime(selectedDayShift, "lunch_started") && eventTime(selectedDayShift, "lunch_finished") ? (
                          <span
                            className={styles.trackLunch}
                            style={timelineSpan(
                              eventTime(selectedDayShift, "lunch_started"),
                              eventTime(selectedDayShift, "lunch_finished"),
                              1,
                            )}
                          />
                        ) : null}
                      </div>
                      <div className={styles.trackLabels} aria-hidden>
                        <span>00:00</span>
                        <span>06:00</span>
                        <span>12:00</span>
                        <span>18:00</span>
                        <span>24:00</span>
                      </div>
                      <div className={styles.comparison}>
                        <div>
                          <span>{t("Break")}</span>
                          <strong className="tabular">{formatDuration(selectedDayShift.break_seconds)} / {formatDuration(expectedBreakSeconds)}</strong>
                          <Chip tone={selectedDayShift.break_seconds > expectedBreakSeconds ? "warn" : "good"} dot={false}>
                            {t(comparisonText(selectedDayShift.break_seconds, expectedBreakSeconds))}
                          </Chip>
                        </div>
                        <div>
                          <span>{t("Lunch")}</span>
                          <strong className="tabular">{formatDuration(selectedDayShift.lunch_seconds)} / {formatDuration(expectedLunchSeconds)}</strong>
                          <Chip tone={selectedDayShift.lunch_seconds > expectedLunchSeconds ? "warn" : "good"} dot={false}>
                            {t(comparisonText(selectedDayShift.lunch_seconds, expectedLunchSeconds))}
                          </Chip>
                        </div>
                      </div>
                      <ShiftBar mix={shiftMix([selectedDayShift])} />
                    </article>
                    <form
                      className={styles.form}
                      onSubmit={(event) => {
                        event.preventDefault();
                        void saveShiftCorrection();
                      }}
                    >
                      <h3>{t("Corregir jornada")}</h3>
                      <div className={styles.timeGrid}>
                        <label>{t("Entrada")}<input type="time" value={entryTime} onChange={(event) => setEntryTime(event.target.value)} /></label>
                        <label>{t("Salida")}<input type="time" value={exitTime} onChange={(event) => setExitTime(event.target.value)} /></label>
                        <label>{t("Inicio break")}<input type="time" value={breakStartTime} onChange={(event) => setBreakStartTime(event.target.value)} /></label>
                        <label>{t("Fin break")}<input type="time" value={breakEndTime} onChange={(event) => setBreakEndTime(event.target.value)} /></label>
                        <label>{t("Inicio lunch")}<input type="time" value={lunchStartTime} onChange={(event) => setLunchStartTime(event.target.value)} /></label>
                        <label>{t("Fin lunch")}<input type="time" value={lunchEndTime} onChange={(event) => setLunchEndTime(event.target.value)} /></label>
                      </div>
                      <label>{t("Motivo")}<input value={correctionReason} onChange={(event) => setCorrectionReason(event.target.value)} placeholder={t("Ej. Correccion aprobada por RRHH")} required /></label>
                      <div className={styles.formActions}>
                        <span className="field-hint">{t("El motivo es obligatorio (minimo 3 caracteres).")}</span>
                        <button className="btn" type="submit">{t("Guardar correccion")}</button>
                      </div>
                    </form>
                  </>
                ) : (
                  <form
                    className={styles.form}
                    onSubmit={(event) => {
                      event.preventDefault();
                      void createManualShift();
                    }}
                  >
                    <div className={styles.notice}>
                      <strong>{t("No hay jornada registrada en esta fecha")}</strong>
                      <span>{t("Puedes crear una jornada manual con el motivo de la excepcion.")}</span>
                    </div>
                    <div className={styles.timeGrid}>
                      <label>{t("Entrada")}<input type="time" value={entryTime} onChange={(event) => setEntryTime(event.target.value)} required /></label>
                      <label>{t("Salida")}<input type="time" value={exitTime} onChange={(event) => setExitTime(event.target.value)} /></label>
                      <label>{t("Inicio break")}<input type="time" value={breakStartTime} onChange={(event) => setBreakStartTime(event.target.value)} /></label>
                      <label>{t("Fin break")}<input type="time" value={breakEndTime} onChange={(event) => setBreakEndTime(event.target.value)} /></label>
                      <label>{t("Inicio lunch")}<input type="time" value={lunchStartTime} onChange={(event) => setLunchStartTime(event.target.value)} /></label>
                      <label>{t("Fin lunch")}<input type="time" value={lunchEndTime} onChange={(event) => setLunchEndTime(event.target.value)} /></label>
                    </div>
                    <label>{t("Motivo")}<input value={correctionReason} onChange={(event) => setCorrectionReason(event.target.value)} placeholder={t("Ej. Registro manual aprobado")} required /></label>
                    <div className={styles.formActions}>
                      <span className="field-hint">{t("El motivo es obligatorio (minimo 3 caracteres).")}</span>
                      <button className="btn" type="submit">{t("Crear jornada manual")}</button>
                    </div>
                  </form>
                )}
              </div>
            ) : null}

            {detailTab === "schedule" ? (
              <form
                className={`drawer-section ${styles.form}`}
                onSubmit={(event) => {
                  event.preventDefault();
                  void saveSchedule();
                }}
              >
                <div className={styles.sectionHead}>
                  <h3>{t("Horario asignado")}</h3>
                  <span>{t("Vigente desde")} {fullDate(detailDate)}</span>
                </div>
                <div className="field-row">
                  <label>
                    {t("Entrada")}
                    <input
                      aria-label={t("Hora de entrada asignada")}
                      type="time"
                      value={scheduleStart}
                      onChange={(event) => setScheduleStart(event.target.value)}
                    />
                  </label>
                  <label>
                    {t("Salida")}
                    <input
                      aria-label={t("Hora de salida asignada")}
                      type="time"
                      value={scheduleEnd}
                      onChange={(event) => setScheduleEnd(event.target.value)}
                    />
                  </label>
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
                <div className={styles.formActions}>
                  <span className="field-hint">{t("Minutos entre 0 y 240. El cambio aplica desde la fecha seleccionada en Jornada del dia.")}</span>
                  <button className="btn" type="submit">{t("Guardar horario")}</button>
                </div>
              </form>
            ) : null}
          </>
        ) : null}
      </Drawer>
    </AppShell>
  );
}
