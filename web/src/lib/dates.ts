/**
 * Fechas de calendario ("YYYY-MM-DD") calculadas en la zona horaria de la
 * empresa/estacion, no en UTC. `toISOString().slice(0, 10)` devuelve la fecha UTC,
 * que en America/Managua (UTC-6) ya es "manana" a partir de las 18:00.
 */

export const DEFAULT_TIME_ZONE = "America/Managua";

const formatters = new Map<string, Intl.DateTimeFormat>();

function dateFormatter(timeZone: string) {
  let formatter = formatters.get(timeZone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat("en-CA", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    });
    formatters.set(timeZone, formatter);
  }
  return formatter;
}

export function isValidTimeZone(timeZone: string | null | undefined): timeZone is string {
  if (!timeZone) return false;
  try {
    dateFormatter(timeZone);
    return true;
  } catch {
    return false;
  }
}

/** Fecha de calendario (YYYY-MM-DD) de `value` en `timeZone`. */
export function zonedDateISO(timeZone: string = DEFAULT_TIME_ZONE, value: Date | string | number = new Date()) {
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) return "";
  const zone = isValidTimeZone(timeZone) ? timeZone : DEFAULT_TIME_ZONE;
  try {
    const parts = dateFormatter(zone).formatToParts(date);
    const year = parts.find((part) => part.type === "year")?.value || "0000";
    const month = parts.find((part) => part.type === "month")?.value || "01";
    const day = parts.find((part) => part.type === "day")?.value || "01";
    return `${year}-${month}-${day}`;
  } catch {
    return date.toISOString().slice(0, 10);
  }
}

/** Hoy (YYYY-MM-DD) en la zona horaria indicada (por defecto America/Managua). */
export function todayISO(timeZone: string = DEFAULT_TIME_ZONE) {
  return zonedDateISO(timeZone);
}

/** Primer dia del mes actual (YYYY-MM-DD) en la zona horaria indicada. */
export function monthStartISO(timeZone: string = DEFAULT_TIME_ZONE) {
  return `${todayISO(timeZone).slice(0, 8)}01`;
}

/** Suma dias a una fecha de calendario YYYY-MM-DD (aritmetica pura, sin zona horaria). */
export function addDaysISO(value: string, days: number) {
  const [year, month, day] = value.split("-").map(Number);
  const date = new Date(Date.UTC(year || 1970, (month || 1) - 1, day || 1));
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}
