"use client";

import { FormEvent, useEffect, useRef, useState, type CSSProperties } from "react";
import { classifyLoginError, isApiError, requestJson, retryAfterMinutes } from "@/lib/api";
import { zonedDateISO } from "@/lib/dates";
import { useDialog } from "@/lib/use-dialog";

const STATION_VERSION = "web-station-1.0.0";
const sessionKey = "vyntra.station.session";
// Claves globales de versiones anteriores (compartidas entre usuarios del mismo
// navegador). Se migran o descartan al iniciar sesion; ver migrateLegacyStorage.
const legacyStateKey = "vyntra.station.state";
const legacyQueueKey = "vyntra.station.queue";
// Estado, cola y rechazados quedan aislados por empleado.
const stateKeyPrefix = "vyntra.station.state.";
const queueKeyPrefix = "vyntra.station.queue.";
const rejectedKeyPrefix = "vyntra.station.rejected.";
const consentPrefix = "vyntra.station.consent.";
const timeZoneKey = "vyntra.station.timezone";
const loginLanguageKey = "vyntra.station.loginLanguage";
const rememberEmailKey = "vyntra.station.rememberEmail";
const QUEUE_LIMIT = 100;
const REJECTED_LIMIT = 20;
const MAX_TRANSITION_ATTEMPTS = 3;
const TRANSITION_EVENT_PREFIXES = ["shift_", "break_", "lunch_", "overtime_"];
// 0.3.0 aplica la politica de captura minima (sin URL ni titulos; evidencia solo en sitios productivos).
// Se ofrece como actualizacion opcional; subir requiredExtensionVersion cuando se decida exigirla.
const requiredExtensionVersion = "0.2.3";
const latestExtensionVersion = "0.3.0";
const extensionDownloadHref = `/extensions/vyntra-browser-extension.zip?v=${latestExtensionVersion}`;

const stationTimeZones = [
  "America/Managua",
  "America/Costa_Rica",
  "America/El_Salvador",
  "America/Guatemala",
  "America/Tegucigalpa",
  "America/Panama",
  "America/Bogota",
  "America/Mexico_City",
  "America/New_York",
  "America/Los_Angeles",
  "UTC",
];

const stationTimeZoneLabels: Record<string, string> = {
  "America/Managua": "Managua",
  "America/Costa_Rica": "Costa Rica",
  "America/El_Salvador": "El Salvador",
  "America/Guatemala": "Guatemala",
  "America/Tegucigalpa": "Tegucigalpa",
  "America/Panama": "Panama",
  "America/Bogota": "Bogota",
  "America/Mexico_City": "Mexico City",
  "America/New_York": "New York",
  "America/Los_Angeles": "Los Angeles",
  UTC: "UTC",
};

type StationStatus = "FUERA" | "TRABAJANDO" | "BREAK" | "LUNCH" | "TERMINADO";
type OvertimeStatus = "SIN_HORAS_EXTRA" | "ACTIVA" | "FINALIZADA";
type LoginLanguage = "es" | "en";

const stationLoginCopy = {
  es: {
    languageToggleLabel: "Cambiar login a ingles",
    ariaStation: "VYNTRA Estacion",
    brandSubtitle: "Estacion de marcaje",
    hero: "Marca tu jornada de forma simple y segura.",
    howWorks: "Como funciona",
    installExtension: "Instalar extension",
    updateExtension: "Actualizar extension",
    signInTitle: "Iniciar sesion",
    emailLabel: "Correo electronico",
    emailPlaceholder: "Correo electronico",
    passwordLabel: "Contrasena",
    passwordPlaceholder: "Tu contrasena",
    remember: "Recordarme",
    forgotPassword: "Olvidaste tu contrasena?",
    verifying: "Verificando...",
    enter: "Entrar",
    resetEmail: "Correo",
    sendCode: "Enviar codigo",
    resetCode: "Codigo",
    resetPassword: "Nueva contrasena",
    resetSubmit: "Restablecer",
    close: "Cerrar",
    extensionReady: "✓ Extension conectada",
    extensionOutdated: (version: string | null) => `Extension incompatible · v${version || "anterior"}`,
    extensionRequired: "Extension requerida para marcar jornada",
    install: "Instalar",
    update: "Actualizar",
    howModalEyebrow: "Estacion de marcaje",
    howModalTitle: "Como funciona",
    howModalIntro: "La estacion registra tu jornada laboral y mantiene evidencia de actividad mientras estas marcado como trabajando.",
    howModalItems: [
      "Inicias sesion con tus credenciales laborales y marcas entrada, descansos, almuerzo y salida.",
      "La extension valida que esta instalada y en una version compatible antes de permitir el marcaje.",
      "Durante la jornada activa toma capturas autorizadas cada 5 minutos como respaldo de trabajo.",
      "La extension puede seguir registrando actividad del navegador si cierras la pestana, pero debes volver a la estacion para break, lunch o finalizar jornada.",
      "La zona horaria se selecciona dentro de la estacion despues de iniciar sesion.",
    ],
    howModalNote: "Sin una extension compatible, la estacion bloquea el marcaje hasta completar la instalacion.",
    extensionRequiredEyebrow: "Extension requerida",
    extensionNewVersion: `Nueva version ${latestExtensionVersion}`,
    extensionModalTitle: `Nueva version ${latestExtensionVersion}`,
    extensionModalIntro: "Instala o actualiza VYNTRA Browser para usar la estacion de marcaje con actividad en otras pestanas y capturas autorizadas cada 5 minutos durante la jornada activa.",
    extensionSteps: [
      "Descarga el archivo de actualizacion.",
      "Descomprime el ZIP en una carpeta local.",
      "Abre Chrome o Edge y entra a la pagina de extensiones.",
      "Activa el modo de desarrollador y reemplaza la extension actual.",
      "Vuelve a esta estacion y espera a que el estado cambie a actualizado.",
    ],
    downloadUpdate: "Descargar actualizacion",
    extensionModalNote: "Sin esta version de la extension no se puede abrir ni marcar la jornada.",
    status: {
      verifyingCredentials: "Verificando credenciales...",
      signedIn: "Sesion iniciada",
      invalidCredentials: "Correo o contrasena invalida",
      resetCode: (code: string) => `Codigo de prueba: ${code}`,
      resetRequested: "Si el correo existe, se envio un codigo.",
      resetRequestFailed: "No se pudo solicitar recuperacion.",
      resetConfirmed: "Contrasena restablecida. Ingresa con la nueva contrasena.",
      resetInvalid: "Codigo invalido o vencido.",
      tooManyAttempts: (minutes: number | null) =>
        minutes
          ? `Demasiados intentos. Espera ${minutes} min antes de volver a intentar.`
          : "Demasiados intentos. Espera unos minutos antes de volver a intentar.",
      serverError: "El servidor no esta disponible. Intenta de nuevo en unos minutos.",
      networkError: "Sin conexion con el servidor. Revisa tu red e intenta de nuevo.",
      unknownError: "No se pudo iniciar sesion. Intenta de nuevo.",
    },
  },
  en: {
    languageToggleLabel: "Switch login to Spanish",
    ariaStation: "VYNTRA Time Clock",
    brandSubtitle: "Time clock station",
    hero: "Clock in and out simply and securely.",
    howWorks: "How it works",
    installExtension: "Install extension",
    updateExtension: "Update extension",
    signInTitle: "Sign in",
    emailLabel: "Email address",
    emailPlaceholder: "Email address",
    passwordLabel: "Password",
    passwordPlaceholder: "Your password",
    remember: "Remember me",
    forgotPassword: "Forgot your password?",
    verifying: "Verifying...",
    enter: "Enter",
    resetEmail: "Email",
    sendCode: "Send code",
    resetCode: "Code",
    resetPassword: "New password",
    resetSubmit: "Reset",
    close: "Close",
    extensionReady: "✓ Extension connected",
    extensionOutdated: (version: string | null) => `Incompatible extension · v${version || "previous"}`,
    extensionRequired: "Extension required to clock in",
    install: "Install",
    update: "Update",
    howModalEyebrow: "Time clock station",
    howModalTitle: "How it works",
    howModalIntro: "The station records your workday and keeps activity evidence while you are clocked in as working.",
    howModalItems: [
      "Sign in with your employee credentials and record start, breaks, lunch, and end of day.",
      "The extension confirms it is installed and compatible before clocking is allowed.",
      "During an active workday it takes authorized screenshots every 5 minutes as work evidence.",
      "The extension can keep recording browser activity if you close the tab, but you must return to the station for breaks, lunch or clock-out.",
      "The time zone is selected inside the station after signing in.",
    ],
    howModalNote: "Without a compatible extension, the station blocks clocking until setup is complete.",
    extensionRequiredEyebrow: "Extension required",
    extensionNewVersion: `New version ${latestExtensionVersion}`,
    extensionModalTitle: `New version ${latestExtensionVersion}`,
    extensionModalIntro: "Install or update VYNTRA Browser to use the time clock with activity in other tabs and authorized screenshots every 5 minutes during an active workday.",
    extensionSteps: [
      "Download the update file.",
      "Unzip the ZIP file into a local folder.",
      "Open Chrome or Edge and go to the extensions page.",
      "Enable developer mode and replace the current extension.",
      "Return to this station and wait for the status to change to updated.",
    ],
    downloadUpdate: "Download update",
    extensionModalNote: "Without this extension version, the station cannot be opened or used to clock in.",
    status: {
      verifyingCredentials: "Verifying credentials...",
      signedIn: "Signed in",
      invalidCredentials: "Invalid email or password",
      resetCode: (code: string) => `Test code: ${code}`,
      resetRequested: "If the email exists, a code was sent.",
      resetRequestFailed: "Could not request password recovery.",
      resetConfirmed: "Password reset. Sign in with the new password.",
      resetInvalid: "Invalid or expired code.",
      tooManyAttempts: (minutes: number | null) =>
        minutes
          ? `Too many attempts. Wait ${minutes} min before trying again.`
          : "Too many attempts. Wait a few minutes before trying again.",
      serverError: "The server is unavailable. Try again in a few minutes.",
      networkError: "Cannot reach the server. Check your network and try again.",
      unknownError: "Could not sign in. Please try again.",
    },
  },
} satisfies Record<LoginLanguage, {
  languageToggleLabel: string;
  ariaStation: string;
  brandSubtitle: string;
  hero: string;
  howWorks: string;
  installExtension: string;
  updateExtension: string;
  signInTitle: string;
  emailLabel: string;
  emailPlaceholder: string;
  passwordLabel: string;
  passwordPlaceholder: string;
  remember: string;
  forgotPassword: string;
  verifying: string;
  enter: string;
  resetEmail: string;
  sendCode: string;
  resetCode: string;
  resetPassword: string;
  resetSubmit: string;
  close: string;
  extensionReady: string;
  extensionOutdated: (version: string | null) => string;
  extensionRequired: string;
  install: string;
  update: string;
  howModalEyebrow: string;
  howModalTitle: string;
  howModalIntro: string;
  howModalItems: string[];
  howModalNote: string;
  extensionRequiredEyebrow: string;
  extensionNewVersion: string;
  extensionModalTitle: string;
  extensionModalIntro: string;
  extensionSteps: string[];
  downloadUpdate: string;
  extensionModalNote: string;
  status: {
    verifyingCredentials: string;
    signedIn: string;
    invalidCredentials: string;
    resetCode: (code: string) => string;
    resetRequested: string;
    resetRequestFailed: string;
    resetConfirmed: string;
    resetInvalid: string;
    tooManyAttempts: (minutes: number | null) => string;
    serverError: string;
    networkError: string;
    unknownError: string;
  };
}>;

type StationSession = {
  email: string;
  token: string;
  companyId: string;
  employee: {
    id: string;
    employee_code: string;
    full_name: string;
    email: string;
  };
  credential: {
    id: string;
    email: string;
    password_change_required: boolean;
  };
  device: {
    id: string;
    name: string;
  };
};

type StationState = {
  status: StationStatus;
  workDate: string | null;
  timeZone: string;
  startedAt: string | null;
  endedAt: string | null;
  phaseStartedAt: number | null;
  workBase: number;
  breakBase: number;
  lunchBase: number;
  breakUsed: boolean;
  lunchUsed: boolean;
  overtimeStatus: OvertimeStatus;
  overtimeCode: string;
  overtimeStartedAt: number | null;
  overtimeBase: number;
  overtimeAssignedSeconds: number;
};

type QueuedEvent = {
  id: string;
  tipo: string;
  created_at: string;
  payload: Record<string, unknown>;
  /** Solo local: intentos rechazados por el servidor (no se envia). */
  attempts?: number;
};

type RejectedEvent = {
  id: string;
  tipo: string;
  created_at: string;
  error: string;
  rejected_at: string;
};

type SendEventResult = {
  status: "sent" | "queued" | "rejected" | "skipped";
  error?: string;
};

type AgentEventsResponse = {
  ok?: boolean;
  accepted?: Array<{ id?: string; duplicate?: boolean }>;
  rejected?: Array<{ id?: string; error?: string }>;
};

type QueueStats = { pending: number; rejected: number; lastRejectedError: string };

type ExtensionStatus = {
  available: boolean;
  tracking: boolean;
  extensionVersion: string | null;
  lastSync: string | null;
  lastError: string | null;
  lastSeenAt: number | null;
};

const emptyState: StationState = {
  status: "FUERA",
  workDate: null,
  timeZone: "America/Managua",
  startedAt: null,
  endedAt: null,
  phaseStartedAt: null,
  workBase: 0,
  breakBase: 0,
  lunchBase: 0,
  breakUsed: false,
  lunchUsed: false,
  overtimeStatus: "SIN_HORAS_EXTRA",
  overtimeCode: "",
  overtimeStartedAt: null,
  overtimeBase: 0,
  overtimeAssignedSeconds: 0,
};

function loadJson<T>(key: string): T | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(key);
    return raw ? JSON.parse(raw) as T : null;
  } catch {
    return null;
  }
}

function saveJson(key: string, value: unknown) {
  try {
    window.localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Almacenamiento lleno o no disponible: se conserva el estado en memoria.
  }
}

function removeKey(key: string) {
  try {
    window.localStorage.removeItem(key);
  } catch {
    // Almacenamiento no disponible.
  }
}

const stateKeyFor = (employeeId: string) => `${stateKeyPrefix}${employeeId}`;
const queueKeyFor = (employeeId: string) => `${queueKeyPrefix}${employeeId}`;
const rejectedKeyFor = (employeeId: string) => `${rejectedKeyPrefix}${employeeId}`;

function isTransitionEvent(tipo: string) {
  return TRANSITION_EVENT_PREFIXES.some((prefix) => tipo.startsWith(prefix));
}

/**
 * Limita la cola a QUEUE_LIMIT eventos descartando primero los eventos mas
 * antiguos que NO son transiciones de jornada. Las transiciones
 * (shift_*, break_*, lunch_*, overtime_*) nunca se descartan.
 */
function trimQueue(events: QueuedEvent[]) {
  if (events.length <= QUEUE_LIMIT) return events;
  let excess = events.length - QUEUE_LIMIT;
  const dropIds = new Set<string>();
  for (const event of events) {
    if (excess <= 0) break;
    if (isTransitionEvent(event.tipo)) continue;
    dropIds.add(event.id);
    excess -= 1;
  }
  return events.filter((event) => !dropIds.has(event.id));
}

function loadQueue(employeeId: string) {
  const events = loadJson<QueuedEvent[]>(queueKeyFor(employeeId));
  return Array.isArray(events) ? events.filter((event) => event && typeof event.id === "string") : [];
}

function enqueueEvents(employeeId: string, events: QueuedEvent[]) {
  const current = loadQueue(employeeId);
  const known = new Set(current.map((event) => event.id));
  const merged = [...current, ...events.filter((event) => !known.has(event.id))];
  saveJson(queueKeyFor(employeeId), trimQueue(merged));
}

function loadRejected(employeeId: string) {
  const items = loadJson<RejectedEvent[]>(rejectedKeyFor(employeeId));
  return Array.isArray(items) ? items : [];
}

function storeRejected(employeeId: string, items: Array<{ event: QueuedEvent; error: string }>) {
  if (!items.length) return;
  const rejectedAt = nowIso();
  const next = [
    ...loadRejected(employeeId),
    ...items.map(({ event, error }) => ({
      id: event.id,
      tipo: event.tipo,
      created_at: event.created_at,
      error: error.slice(0, 300),
      rejected_at: rejectedAt,
    })),
  ].slice(-REJECTED_LIMIT);
  saveJson(rejectedKeyFor(employeeId), next);
}

function readQueueStats(employeeId: string | null | undefined): QueueStats {
  if (!employeeId) return { pending: 0, rejected: 0, lastRejectedError: "" };
  const rejected = loadRejected(employeeId);
  return {
    pending: loadQueue(employeeId).length,
    rejected: rejected.length,
    lastRejectedError: rejected.at(-1)?.error || "",
  };
}

function wireEvent(event: QueuedEvent) {
  // Solo los campos que espera el backend (attempts es local).
  return { id: event.id, tipo: event.tipo, created_at: event.created_at, payload: event.payload };
}

function eventId() {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) return crypto.randomUUID();
  return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function nowIso() {
  return new Date().toISOString();
}

function defaultTimeZone() {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "America/Managua";
  } catch {
    return "America/Managua";
  }
}

function timeZoneLocationLabel(timeZone: string) {
  if (stationTimeZoneLabels[timeZone]) return stationTimeZoneLabels[timeZone];
  const rawLocation = timeZone.split("/").pop() || timeZone;
  return rawLocation.replaceAll("_", " ");
}

function zonedDateIso(timeZone: string, value: Date | string | number = new Date()) {
  return zonedDateISO(timeZone, value);
}

function formatZonedTime(value: string | number | Date, timeZone: string, withSeconds = false) {
  try {
    return new Intl.DateTimeFormat("es-NI", {
      timeZone,
      hour: "2-digit",
      minute: "2-digit",
      second: withSeconds ? "2-digit" : undefined,
      hour12: true,
    }).format(new Date(value));
  } catch {
    return new Date(value).toLocaleTimeString("es-NI");
  }
}

function normalizeState(state: Partial<StationState> | null, timeZone: string): StationState {
  if (!state) return { ...emptyState, timeZone };
  const startedAt = state.startedAt || null;
  const endedAt = state.endedAt || null;
  return {
    ...emptyState,
    ...state,
    timeZone: state.timeZone || timeZone,
    workDate: state.workDate || (startedAt ? zonedDateIso(timeZone, startedAt) : endedAt ? zonedDateIso(timeZone, endedAt) : null),
  };
}

function secondsSince(ts: number | null) {
  if (!ts) return 0;
  return Math.max(0, Math.floor((Date.now() - ts) / 1000));
}

function formatHms(total: number) {
  const seconds = Math.max(0, Math.floor(total));
  const h = Math.floor(seconds / 3600).toString().padStart(2, "0");
  const m = Math.floor((seconds % 3600) / 60).toString().padStart(2, "0");
  const s = Math.floor(seconds % 60).toString().padStart(2, "0");
  return `${h}:${m}:${s}`;
}

function versionAtLeast(current: string | null | undefined, required: string) {
  if (!current) return false;
  const currentParts = current.split(".").map((part) => Number.parseInt(part, 10) || 0);
  const requiredParts = required.split(".").map((part) => Number.parseInt(part, 10) || 0);
  const maxLength = Math.max(currentParts.length, requiredParts.length);
  for (let index = 0; index < maxLength; index += 1) {
    const currentPart = currentParts[index] || 0;
    const requiredPart = requiredParts[index] || 0;
    if (currentPart > requiredPart) return true;
    if (currentPart < requiredPart) return false;
  }
  return true;
}

function totals(state: StationState, canAccrueTime = true) {
  const work = state.workBase + (canAccrueTime && state.status === "TRABAJANDO" ? secondsSince(state.phaseStartedAt) : 0);
  const breakSeconds = state.breakBase + (canAccrueTime && state.status === "BREAK" ? secondsSince(state.phaseStartedAt) : 0);
  const lunch = state.lunchBase + (canAccrueTime && state.status === "LUNCH" ? secondsSince(state.phaseStartedAt) : 0);
  const overtime = state.overtimeBase + (canAccrueTime && state.overtimeStatus === "ACTIVA" ? secondsSince(state.overtimeStartedAt) : 0);
  return { work, breakSeconds, lunch, overtime };
}

function workdayElapsedSeconds(state: StationState) {
  if (!state.startedAt) return 0;
  const startedAt = new Date(state.startedAt).getTime();
  const endedAt = state.endedAt ? new Date(state.endedAt).getTime() : Date.now();
  if (!Number.isFinite(startedAt) || !Number.isFinite(endedAt)) return 0;
  return Math.max(0, Math.floor((endedAt - startedAt) / 1000));
}

function closeCurrentPhase(state: StationState): StationState {
  const current = totals(state);
  return {
    ...state,
    workBase: current.work,
    breakBase: current.breakSeconds,
    lunchBase: current.lunch,
    overtimeBase: current.overtime,
    phaseStartedAt: null,
    overtimeStartedAt: state.overtimeStatus === "ACTIVA" ? Date.now() : state.overtimeStartedAt,
  };
}

function freezeAccruingState(state: StationState): StationState {
  const current = totals(state, true);
  return {
    ...state,
    workBase: current.work,
    breakBase: current.breakSeconds,
    lunchBase: current.lunch,
    overtimeBase: current.overtime,
    phaseStartedAt: null,
    overtimeStartedAt: state.overtimeStatus === "ACTIVA" ? null : state.overtimeStartedAt,
  };
}

async function postStation<T>(token: string, path: string, body: unknown): Promise<T> {
  return requestJson<T>(path, {
    method: "POST",
    deviceToken: token,
    body: JSON.stringify(body),
  });
}

/** Envia eventos y devuelve los ids aceptados (o duplicados) y los rechazados. */
async function postAgentEvents(token: string, events: QueuedEvent[]) {
  const response = await postStation<AgentEventsResponse>(token, "/api/agent/events", { events: events.map(wireEvent) });
  const accepted = new Set<string>();
  (response.accepted || []).forEach((item) => {
    if (item?.id) accepted.add(item.id);
  });
  const rejected = new Map<string, string>();
  (response.rejected || []).forEach((item) => {
    if (item?.id) rejected.set(item.id, item.error || "Evento rechazado");
  });
  return { accepted, rejected };
}

/**
 * Migra las claves globales de versiones anteriores al almacenamiento del
 * empleado indicado. `trustLegacyState` es true cuando la sesion guardada
 * garantiza que los datos globales eran de este empleado. Si no, solo se
 * conservan los eventos que el propio empleado genero (payload.empleado) y el
 * estado solo se adopta si hay evidencia de que era suyo. Lo demas se descarta:
 * nunca debe enviarse con el token de otro usuario.
 */
function migrateLegacyStorage(employee: { id: string; full_name: string }, trustLegacyState: boolean) {
  const legacyState = loadJson<Partial<StationState>>(legacyStateKey);
  const legacyQueue = loadJson<QueuedEvent[]>(legacyQueueKey);
  if (!legacyState && !legacyQueue) return;
  const events = Array.isArray(legacyQueue) ? legacyQueue.filter((event) => event && typeof event.id === "string") : [];
  const ownEvents = trustLegacyState
    ? events
    : events.filter((event) => event.payload?.empleado === employee.full_name);
  if (ownEvents.length) enqueueEvents(employee.id, ownEvents);
  const adoptState = trustLegacyState || ownEvents.length > 0;
  if (legacyState && adoptState && !loadJson(stateKeyFor(employee.id))) {
    saveJson(stateKeyFor(employee.id), legacyState);
  }
  removeKey(legacyStateKey);
  removeKey(legacyQueueKey);
}

function loadEmployeeState(employeeId: string, fallbackTimeZone: string) {
  return normalizeState(loadJson<Partial<StationState>>(stateKeyFor(employeeId)), fallbackTimeZone);
}

// Un solo envio de la cola a la vez (por pestana).
let flushInFlight: Promise<void> | null = null;

/**
 * Envia la cola pendiente del empleado. Solo quita de la cola los ids que el
 * servidor acepto (o marco como duplicados). Los rechazados pasan al almacen
 * de rechazados (las transiciones de jornada se reintentan hasta
 * MAX_TRANSITION_ATTEMPTS veces). Los eventos encolados mientras la peticion
 * estaba en curso se conservan porque la cola se relee y se fusiona al final.
 */
function flushQueue(token: string, employeeId: string): Promise<void> {
  if (flushInFlight) return flushInFlight;
  flushInFlight = (async () => {
    const batch = loadQueue(employeeId).slice(0, QUEUE_LIMIT);
    if (!batch.length) return;
    const { accepted, rejected } = await postAgentEvents(token, batch);
    const batchById = new Map(batch.map((event) => [event.id, event]));
    const toRejectedStore: Array<{ event: QueuedEvent; error: string }> = [];
    const retryAttempts = new Map<string, number>();
    rejected.forEach((error, id) => {
      const event = batchById.get(id);
      if (!event) return;
      const attempts = (event.attempts || 0) + 1;
      if (isTransitionEvent(event.tipo) && attempts < MAX_TRANSITION_ATTEMPTS) {
        retryAttempts.set(id, attempts);
      } else {
        toRejectedStore.push({ event, error });
      }
    });
    const removeIds = new Set([...accepted, ...toRejectedStore.map((item) => item.event.id)]);
    const current = loadQueue(employeeId);
    const next = current
      .filter((event) => !removeIds.has(event.id))
      .map((event) => (retryAttempts.has(event.id) ? { ...event, attempts: retryAttempts.get(event.id) } : event));
    saveJson(queueKeyFor(employeeId), next);
    storeRejected(employeeId, toRejectedStore);
  })().finally(() => {
    flushInFlight = null;
  });
  return flushInFlight;
}

function ExtensionDownloadCard({ compact = false }: { compact?: boolean }) {
  return (
    <section className={compact ? "station-extension-card compact" : "station-extension-card"}>
      <div className="station-card-title">
        <h2>Extension VYNTRA Browser</h2>
        <span>Version {latestExtensionVersion}</span>
      </div>
      <p>Es requerida para marcar jornada. Esta version agrega capturas automaticas autorizadas cada 5 minutos mientras la jornada esta activa.</p>
      <a className="station-download-button" href={extensionDownloadHref} download>
        Descargar actualizacion
      </a>
      <ol>
        <li>Descarga y descomprime el archivo.</li>
        <li>Abre Chrome o Edge y entra a la pagina de extensiones.</li>
        <li>Activa el modo de desarrollador.</li>
        <li>Elige cargar extension sin empaquetar y selecciona la carpeta descargada.</li>
        <li>Vuelve a esta estacion e inicia sesion.</li>
      </ol>
      <small>La estacion no permite iniciar, pausar, reabrir ni finalizar jornada si la extension no esta conectada o no es compatible.</small>
    </section>
  );
}

function TimeZoneSelect({
  value,
  onChange,
  compact = false,
  disabled = false,
  disabledReason = "",
}: {
  value: string;
  onChange: (value: string) => void;
  compact?: boolean;
  disabled?: boolean;
  disabledReason?: string;
}) {
  const options = stationTimeZones.includes(value) ? stationTimeZones : [value, ...stationTimeZones];
  return (
    <label className={compact ? "station-timezone compact" : "station-timezone"} title={disabled ? disabledReason : undefined}>Zona horaria
      <select value={value} onChange={(event) => onChange(event.target.value)} disabled={disabled}>
        {options.map((timeZone) => (
          <option value={timeZone} key={timeZone}>{timeZone}</option>
        ))}
      </select>
    </label>
  );
}

/** Re-renderiza solo al componente que lo usa, una vez por segundo; devuelve la hora actual. */
function useSecondTick() {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);
  return now;
}

/**
 * Cronometro de la jornada. Es el unico (junto con StationLiveMetrics) que se
 * actualiza cada segundo, para no re-renderizar toda la estacion.
 */
function StationClockFace({ state }: { state: StationState }) {
  useSecondTick();
  const workdayElapsed = workdayElapsedSeconds(state);
  const dailyProgress = Math.min(100, Math.max(0, (workdayElapsed / (8 * 60 * 60)) * 100));
  return (
    <div className="station-clock-face" style={{ "--station-progress": `${dailyProgress}%` } as CSSProperties}>
      <div>
        <strong>{formatHms(workdayElapsed)}</strong>
        <span>Jornada completa hoy</span>
        <small>Meta diaria: 8h</small>
      </div>
    </div>
  );
}

function StationLiveMetrics({
  state,
  timeZone,
  canAccrueTime,
}: {
  state: StationState;
  timeZone: string;
  canAccrueTime: boolean;
}) {
  const now = useSecondTick();
  const liveTotals = totals(state, canAccrueTime);
  return (
    <div className="station-metric-grid">
      <article>
        <span>HORA ACTUAL</span>
        <strong>{formatZonedTime(now, timeZone, true)}</strong>
      </article>
      <article>
        <span>DIA LABORAL</span>
        <strong>{zonedDateIso(timeZone, now)}</strong>
      </article>
      <article>
        <span>BREAK USADO</span>
        <strong>{formatHms(liveTotals.breakSeconds)}</strong>
      </article>
      <article>
        <span>ALMUERZO USADO</span>
        <strong>{formatHms(liveTotals.lunch)}</strong>
      </article>
      <article>
        <span>HORAS EXTRA</span>
        <strong>{formatHms(liveTotals.overtime)}</strong>
      </article>
    </div>
  );
}

export default function StationPage() {
  const [session, setSession] = useState<StationSession | null>(null);
  const [stationState, setStationState] = useState<StationState>(emptyState);
  const [ready, setReady] = useState(false);
  const [statusText, setStatusText] = useState("");
  const [loginEmail, setLoginEmail] = useState("");
  const [loginPassword, setLoginPassword] = useState("");
  const [rememberEmail, setRememberEmail] = useState(false);
  const [loginLanguage, setLoginLanguage] = useState<LoginLanguage>("es");
  const [busy, setBusy] = useState(false);
  const [consentAccepted, setConsentAccepted] = useState(false);
  const [consentChecks, setConsentChecks] = useState([false, false, false, false]);
  const [passwordForm, setPasswordForm] = useState({ current: "", next: "", confirm: "" });
  const [resetForm, setResetForm] = useState({ email: "", code: "", password: "" });
  const [resetOpen, setResetOpen] = useState(false);
  const [howWorksDialogOpen, setHowWorksDialogOpen] = useState(false);
  const [extensionDialogOpen, setExtensionDialogOpen] = useState(false);
  const [legalDialogOpen, setLegalDialogOpen] = useState(false);
  const [incidentOpen, setIncidentOpen] = useState(false);
  const [incident, setIncident] = useState({ type: "correccion_marcaje", description: "" });
  const [accessCode, setAccessCode] = useState("");
  const [overtimeRequest, setOvertimeRequest] = useState({ exitTime: "", reason: "" });
  const [stationTimeZone, setStationTimeZone] = useState("America/Managua");
  const [isOnline, setIsOnline] = useState(() => (typeof navigator === "undefined" ? true : navigator.onLine));
  const [queueStats, setQueueStats] = useState<QueueStats>({ pending: 0, rejected: 0, lastRejectedError: "" });
  const [extensionStatus, setExtensionStatus] = useState<ExtensionStatus>({
    available: false,
    tracking: false,
    extensionVersion: null,
    lastSync: null,
    lastError: null,
    lastSeenAt: null,
  });
  // Re-render "grueso" de la estacion (cambio de dia, caducidad de la extension).
  // El reloj y los contadores por segundo viven en StationClockFace/StationLiveMetrics.
  const [, setRenderTick] = useState(0);
  const activityRef = useRef({ clicks: 0, focusChanges: 0, lastInteraction: Date.now() });
  const extensionProbeStartedAtRef = useRef(Date.now());
  const extensionWasBlockedRef = useRef(false);
  const howWorksDialogRef = useDialog<HTMLElement>(howWorksDialogOpen, () => setHowWorksDialogOpen(false));
  const extensionDialogRef = useDialog<HTMLElement>(extensionDialogOpen, () => setExtensionDialogOpen(false));
  const legalDialogRef = useDialog<HTMLElement>(legalDialogOpen, () => setLegalDialogOpen(false));

  const employeeId = session?.employee.id || "";
  const shiftActive = stationState.status === "TRABAJANDO" || stationState.status === "BREAK" || stationState.status === "LUNCH";
  // Zona horaria con la que se inicio la jornada: rige las fechas mientras la
  // jornada esta activa o cerrada hoy, para que cambiar el selector no permita
  // saltarse el bloqueo de "jornada cerrada hoy".
  const shiftTimeZone = stationState.timeZone || stationTimeZone;
  const closedWorkDate = stationState.status === "TERMINADO"
    ? stationState.workDate || (stationState.endedAt ? zonedDateIso(shiftTimeZone, stationState.endedAt) : null)
    : null;
  const closedToday = closedWorkDate !== null
    && (closedWorkDate >= zonedDateIso(shiftTimeZone) || closedWorkDate >= zonedDateIso(stationTimeZone));
  const timeZoneLocked = shiftActive || closedToday;
  const effectiveTimeZone = timeZoneLocked ? shiftTimeZone : stationTimeZone;
  const currentWorkDate = zonedDateIso(effectiveTimeZone);
  const extensionReachable = Boolean(extensionStatus.available && extensionStatus.lastSeenAt && Date.now() - extensionStatus.lastSeenAt < 15000);
  const extensionMeetsMinimum = versionAtLeast(extensionStatus.extensionVersion, requiredExtensionVersion);
  const extensionUpToDate = versionAtLeast(extensionStatus.extensionVersion, latestExtensionVersion);
  const extensionNeedsUpdate = extensionReachable && !extensionMeetsMinimum;
  const extensionUpdateAvailable = extensionReachable && extensionMeetsMinimum && !extensionUpToDate;
  const extensionConnected = extensionReachable && extensionMeetsMinimum;
  const extensionMissing = !extensionReachable;
  const extensionGraceActive = !extensionStatus.lastSeenAt && Date.now() - extensionProbeStartedAtRef.current < 3000;
  const canAccrueTime = extensionConnected || extensionGraceActive;
  const canAcceptConsent = consentChecks.every(Boolean);
  const needsPasswordChange = Boolean(session?.credential.password_change_required);
  const consentKey = session ? `${consentPrefix}${session.email}` : "";
  const loginText = stationLoginCopy[loginLanguage];
  const stationLocationLabel = timeZoneLocationLabel(effectiveTimeZone);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      const savedTimeZone = window.localStorage.getItem(timeZoneKey) || defaultTimeZone();
      const savedLoginLanguage = window.localStorage.getItem(loginLanguageKey);
      const savedSession = loadJson<StationSession>(sessionKey);
      const rememberedEmail = window.localStorage.getItem(rememberEmailKey) || "";
      setStationTimeZone(savedTimeZone);
      if (savedLoginLanguage === "es" || savedLoginLanguage === "en") setLoginLanguage(savedLoginLanguage);
      if (rememberedEmail) {
        setLoginEmail(rememberedEmail);
        setRememberEmail(true);
      }
      if (savedSession?.employee?.id && savedSession.token) {
        // La sesion guardada es del mismo usuario que dejo los datos globales antiguos.
        migrateLegacyStorage(savedSession.employee, true);
        setSession(savedSession);
        setLoginEmail(savedSession.email);
        setConsentAccepted(window.localStorage.getItem(`${consentPrefix}${savedSession.email}`) === "accepted");
        setStationState(loadEmployeeState(savedSession.employee.id, savedTimeZone));
        setQueueStats(readQueueStats(savedSession.employee.id));
      } else {
        if (savedSession) removeKey(sessionKey);
        setStationState({ ...emptyState, timeZone: savedTimeZone });
      }
      setReady(true);
    }, 0);
    return () => window.clearTimeout(timer);
  }, []);

  useEffect(() => {
    if (!ready || !employeeId) return;
    saveJson(stateKeyFor(employeeId), stationState);
  }, [ready, employeeId, stationState]);

  useEffect(() => {
    const timer = window.setInterval(() => setRenderTick((value) => value + 1), 30000);
    return () => window.clearInterval(timer);
  }, []);

  // Re-render exacto cuando la ultima senal de la extension caduca (15 s) y
  // cuando termina el periodo de gracia inicial (3 s).
  useEffect(() => {
    if (!extensionStatus.lastSeenAt) return undefined;
    const delay = Math.max(0, extensionStatus.lastSeenAt + 15000 - Date.now() + 50);
    const timer = window.setTimeout(() => setRenderTick((value) => value + 1), delay);
    return () => window.clearTimeout(timer);
  }, [extensionStatus.lastSeenAt]);

  useEffect(() => {
    const delay = Math.max(0, extensionProbeStartedAtRef.current + 3000 - Date.now() + 50);
    const timer = window.setTimeout(() => setRenderTick((value) => value + 1), delay);
    return () => window.clearTimeout(timer);
  }, []);

  useEffect(() => {
    const onClick = () => {
      activityRef.current.clicks += 1;
      activityRef.current.lastInteraction = Date.now();
    };
    const onFocus = () => {
      activityRef.current.focusChanges += 1;
      activityRef.current.lastInteraction = Date.now();
    };
    const onVisibility = () => {
      activityRef.current.focusChanges += 1;
    };
    const onOnline = () => setIsOnline(true);
    const onOffline = () => setIsOnline(false);
    window.addEventListener("click", onClick);
    window.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", onVisibility);
    window.addEventListener("online", onOnline);
    window.addEventListener("offline", onOffline);
    return () => {
      window.removeEventListener("click", onClick);
      window.removeEventListener("focus", onFocus);
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("online", onOnline);
      window.removeEventListener("offline", onOffline);
    };
  }, []);

  useEffect(() => {
    const onExtensionMessage = (event: MessageEvent) => {
      if (event.source !== window || event.origin !== window.location.origin) return;
      const data = event.data as Partial<ExtensionStatus> & { type?: string };
      if (data?.type !== "VYNTRA_EXTENSION_STATUS") return;
      setExtensionStatus({
        available: true,
        tracking: Boolean(data.tracking),
        extensionVersion: typeof data.extensionVersion === "string" ? data.extensionVersion : null,
        lastSync: typeof data.lastSync === "string" ? data.lastSync : null,
        lastError: typeof data.lastError === "string" ? data.lastError : null,
        lastSeenAt: Date.now(),
      });
    };
    window.addEventListener("message", onExtensionMessage);
    window.postMessage({ type: "VYNTRA_STATION_PING" }, window.location.origin);
    return () => window.removeEventListener("message", onExtensionMessage);
  }, []);

  useEffect(() => {
    const timer = window.setInterval(() => {
      window.postMessage({ type: "VYNTRA_STATION_PING" }, window.location.origin);
    }, 5000);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    if (!ready || !shiftActive) {
      extensionWasBlockedRef.current = false;
      return;
    }

    if (!extensionConnected && !extensionGraceActive) {
      extensionWasBlockedRef.current = true;
      const freezeTimer = window.setTimeout(() => setStationState((current) => {
        if (!["TRABAJANDO", "BREAK", "LUNCH"].includes(current.status)) return current;
        if (current.phaseStartedAt === null && (current.overtimeStatus !== "ACTIVA" || current.overtimeStartedAt === null)) return current;
        return freezeAccruingState(current);
      }), 0);
      return () => window.clearTimeout(freezeTimer);
    }

    if (extensionConnected && extensionWasBlockedRef.current) {
      extensionWasBlockedRef.current = false;
      const resumeTimer = window.setTimeout(() => setStationState((current) => {
        if (!["TRABAJANDO", "BREAK", "LUNCH"].includes(current.status)) return current;
        return {
          ...current,
          phaseStartedAt: current.phaseStartedAt ?? Date.now(),
          overtimeStartedAt: current.overtimeStatus === "ACTIVA" ? Date.now() : current.overtimeStartedAt,
        };
      }), 0);
      return () => window.clearTimeout(resumeTimer);
    }
  }, [ready, shiftActive, extensionConnected, extensionGraceActive]);

  useEffect(() => {
    if (!session?.token) return;
    const timer = window.setInterval(() => {
      if (shiftActive && extensionConnected) void sendEvent("activity_snapshot", stationState, false);
      void runFlush(session);
      syncBrowserExtension();
    }, 30000);
    return () => window.clearInterval(timer);
    // The timer intentionally samples the current station state every time this effect is renewed.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session?.token, shiftActive, stationState]);

  // Al iniciar sesion o recuperar la conexion se envia la cola pendiente.
  useEffect(() => {
    if (!session?.token || !isOnline) return undefined;
    const timer = window.setTimeout(() => void runFlush(session), 0);
    return () => window.clearTimeout(timer);
    // runFlush only depends on the session captured here.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session?.token, isOnline]);

  useEffect(() => {
    if (!shiftActive) return undefined;
    const onBeforeUnload = (event: BeforeUnloadEvent) => {
      sendClosingEvent("beforeunload");
      event.preventDefault();
      event.returnValue = "";
    };
    const onPageHide = () => sendClosingEvent("pagehide");
    window.addEventListener("beforeunload", onBeforeUnload);
    window.addEventListener("pagehide", onPageHide);
    return () => {
      window.removeEventListener("beforeunload", onBeforeUnload);
      window.removeEventListener("pagehide", onPageHide);
    };
    // The unload handlers need the latest station/session snapshot while a shift is active.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session?.token, shiftActive, stationState, extensionConnected, extensionStatus.lastSeenAt]);

  useEffect(() => {
    syncBrowserExtension();
    // The extension receives a fresh snapshot every time the session, consent or station state changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session?.token, consentAccepted, stationState, needsPasswordChange]);

  function webTelemetry() {
    const idle = Math.floor((Date.now() - activityRef.current.lastInteraction) / 1000);
    const hidden = document.visibilityState !== "visible";
    return {
      seg_activo: Math.max(0, totals(stationState, canAccrueTime).work - idle),
      seg_idle: idle >= 60 || hidden ? idle : 0,
      clics: activityRef.current.clicks,
      cambios_ventana: activityRef.current.focusChanges,
      recurso_actual: hidden ? "Pestana no visible" : "VYNTRA Estacion Web",
      muestras_recientes: [
        {
          timestamp: nowIso(),
          proceso: "browser",
          titulo: document.title || "VYNTRA Estacion Web",
          idle_segundos: idle,
          is_idle: idle >= 60 || hidden,
          duracion_muestra_segundos: 30,
        },
      ],
      timestamp: nowIso(),
    };
  }

  function snapshot(state: StationState) {
    const current = totals(state);
    const snapshotTimeZone = state.status === "FUERA" ? effectiveTimeZone : state.timeZone || effectiveTimeZone;
    return {
      estado: state.status,
      empleado: session?.employee.full_name || "",
      equipo: session?.device.name || "Estacion web",
      fecha: state.workDate || currentWorkDate,
      zona_horaria: snapshotTimeZone,
      inicio_jornada: state.startedAt,
      fin_jornada: state.endedAt,
      seg_trabajado: current.work,
      seg_break: current.breakSeconds,
      seg_lunch: current.lunch,
      seg_horas_extra: current.overtime,
      horas_extra_estado: state.overtimeStatus,
      horas_extra_codigo: state.overtimeCode,
      horas_extra_inicio: state.overtimeStartedAt ? new Date(state.overtimeStartedAt).toISOString() : null,
      horas_extra_asignadas_segundos: state.overtimeAssignedSeconds,
      break_consumido: state.breakUsed,
      lunch_consumido: state.lunchUsed,
      telemetria: webTelemetry(),
      web_station: true,
      extension_connected: extensionConnected,
      extension_last_seen_ms_ago: extensionStatus.lastSeenAt ? Date.now() - extensionStatus.lastSeenAt : null,
      extension_tracking: extensionStatus.tracking,
      timestamp: nowIso(),
    };
  }

  function syncBrowserExtension() {
    if (!ready) return;
    if (!session || needsPasswordChange || !consentAccepted) {
      window.postMessage({ type: "VYNTRA_STATION_CLEAR" }, window.location.origin);
      return;
    }
    window.postMessage({
      type: "VYNTRA_STATION_SYNC",
      apiBase: window.location.origin,
      version: STATION_VERSION,
      session: {
        email: session.email,
        token: session.token,
        companyId: session.companyId,
        employee: session.employee,
        device: session.device,
      },
      state: stationState,
      snapshot: snapshot(stationState),
      shiftActive,
      consentAccepted,
      syncedAt: nowIso(),
    }, window.location.origin);
  }

  function updateTimeZone(nextTimeZone: string) {
    // Bloqueado durante una jornada activa o cerrada hoy (ver timeZoneLocked).
    if (timeZoneLocked) return;
    setStationTimeZone(nextTimeZone);
    window.localStorage.setItem(timeZoneKey, nextTimeZone);
    setStationState((current) => (current.status === "FUERA" ? { ...current, timeZone: nextTimeZone } : current));
  }

  function toggleLoginLanguage() {
    const nextLanguage: LoginLanguage = loginLanguage === "es" ? "en" : "es";
    setLoginLanguage(nextLanguage);
    window.localStorage.setItem(loginLanguageKey, nextLanguage);
  }

  function requireExtension() {
    if (extensionConnected) return true;
    if (extensionNeedsUpdate) {
      setStatusText(`La extension instalada no es compatible. Instala VYNTRA Browser ${requiredExtensionVersion} o superior para marcar jornada.`);
      return false;
    }
    setStatusText("Instala y conecta la extension VYNTRA Browser para marcar jornada.");
    return false;
  }

  /** Envia la cola del empleado de `activeSession` con su propio token. */
  async function runFlush(activeSession: StationSession | null) {
    if (!activeSession?.token || !activeSession.employee?.id) return;
    try {
      await flushQueue(activeSession.token, activeSession.employee.id);
    } catch {
      // Sin conexion o error del servidor: la cola se reintenta en el siguiente ciclo.
    }
    setQueueStats(readQueueStats(activeSession.employee.id));
  }

  function sendErrorText(error: unknown) {
    if (isApiError(error) && (error.kind === "network" || error.kind === "timeout")) {
      return "Sin conexion. El evento quedo pendiente.";
    }
    if (isApiError(error)) return `No se pudo sincronizar (HTTP ${error.status}). El evento quedo pendiente.`;
    return "Sin conexion. El evento quedo pendiente.";
  }

  async function sendEvent(type: string, nextState: StationState, showStatus = true, extra: Record<string, unknown> = {}) {
    const activeSession = session;
    if (!activeSession?.token) return { status: "skipped", error: "Sesion no disponible" } satisfies SendEventResult;
    const activeEmployeeId = activeSession.employee.id;
    // Las muestras de actividad solo tienen sentido en tiempo real: no se envian
    // ni se encolan sin conexion.
    const isActivitySnapshot = type === "activity_snapshot";
    if (isActivitySnapshot && typeof navigator !== "undefined" && !navigator.onLine) {
      return { status: "skipped", error: "Sin conexion" } satisfies SendEventResult;
    }
    const event: QueuedEvent = {
      id: eventId(),
      tipo: type,
      created_at: nowIso(),
      payload: { ...snapshot(nextState), ...extra },
    };
    try {
      const { accepted, rejected } = await postAgentEvents(activeSession.token, [event]);
      if (rejected.has(event.id)) {
        const errorMessage = rejected.get(event.id) || "Evento rechazado";
        storeRejected(activeEmployeeId, [{ event, error: errorMessage }]);
        setQueueStats(readQueueStats(activeEmployeeId));
        if (showStatus) setStatusText(errorMessage);
        return { status: "rejected", error: errorMessage } satisfies SendEventResult;
      }
      if (!accepted.has(event.id)) {
        // El servidor no confirmo este id: se conserva para reintentar.
        if (!isActivitySnapshot) enqueueEvents(activeEmployeeId, [event]);
        setQueueStats(readQueueStats(activeEmployeeId));
        if (showStatus) setStatusText("Sin confirmacion del servidor. El evento quedo pendiente.");
        return { status: isActivitySnapshot ? "skipped" : "queued" } satisfies SendEventResult;
      }
      if (showStatus) setStatusText("Sincronizado");
      // La cola pendiente se envia aparte: si falla no afecta a este evento ya aceptado.
      void runFlush(activeSession);
      return { status: "sent" } satisfies SendEventResult;
    } catch (error) {
      if (!isActivitySnapshot) enqueueEvents(activeEmployeeId, [event]);
      setQueueStats(readQueueStats(activeEmployeeId));
      const errorMessage = sendErrorText(error);
      if (showStatus) setStatusText(errorMessage);
      return {
        status: isActivitySnapshot ? "skipped" : "queued",
        error: errorMessage,
      } satisfies SendEventResult;
    }
  }

  function sendClosingEvent(reason: "pagehide" | "beforeunload") {
    if (!session?.token || !shiftActive) return;
    const event: QueuedEvent = {
      id: eventId(),
      tipo: "station_tab_closed",
      created_at: nowIso(),
      payload: {
        ...snapshot(stationState),
        cierre_pestana: true,
        motivo_cierre: reason,
      },
    };
    try {
      void fetch("/api/agent/events", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Device-Token": session.token,
        },
        body: JSON.stringify({ events: [wireEvent(event)] }),
        cache: "no-store",
        keepalive: true,
      }).catch(() => undefined);
    } catch {
      // Browsers may abort unload work. The warning still protects the main flow.
    }
  }

  function loginErrorText(error: unknown) {
    const kind = classifyLoginError(error);
    if (kind === "credentials") return loginText.status.invalidCredentials;
    if (kind === "rate_limited") return loginText.status.tooManyAttempts(retryAfterMinutes(error));
    if (kind === "server") return loginText.status.serverError;
    if (kind === "network") return loginText.status.networkError;
    return loginText.status.unknownError;
  }

  async function login(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!extensionConnected) {
      setExtensionDialogOpen(true);
      requireExtension();
      return;
    }
    setBusy(true);
    setStatusText(loginText.status.verifyingCredentials);
    try {
      const cleanEmail = loginEmail.trim().toLowerCase();
      const payload = await requestJson<{
        ok: boolean;
        company: { id: string };
        employee: StationSession["employee"];
        credential: StationSession["credential"];
        device: { id: string; name: string; token: string };
      }>("/api/station/enroll", {
        method: "POST",
        body: JSON.stringify({
          email: cleanEmail,
          password: loginPassword,
          occurred_at: nowIso(),
          agent_version: STATION_VERSION,
          hostname: "web-browser",
          windows_user: "web",
          device_name: `Estacion web - ${navigator.userAgent.slice(0, 48)}`,
        }),
      });
      const nextSession: StationSession = {
        email: payload.credential.email,
        token: payload.device.token,
        companyId: payload.company.id,
        employee: payload.employee,
        credential: payload.credential,
        device: { id: payload.device.id, name: payload.device.name },
      };
      // Datos de versiones anteriores sin dueno conocido: solo se conserva lo
      // que pertenece a este empleado.
      migrateLegacyStorage(nextSession.employee, false);
      setSession(nextSession);
      saveJson(sessionKey, nextSession);
      setStationState(loadEmployeeState(nextSession.employee.id, stationTimeZone));
      setQueueStats(readQueueStats(nextSession.employee.id));
      setConsentAccepted(window.localStorage.getItem(`${consentPrefix}${nextSession.email}`) === "accepted");
      if (rememberEmail) window.localStorage.setItem(rememberEmailKey, cleanEmail);
      else removeKey(rememberEmailKey);
      setLoginPassword("");
      setStatusText(loginText.status.signedIn);
    } catch (error) {
      setStatusText(loginErrorText(error));
    } finally {
      setBusy(false);
    }
  }

  async function changePassword(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!session) return;
    if (passwordForm.next !== passwordForm.confirm) {
      setStatusText("La confirmacion no coincide.");
      return;
    }
    setBusy(true);
    try {
      await postStation(session.token, "/api/station/password/change", {
        email: session.email,
        current_password: passwordForm.current,
        new_password: passwordForm.next,
      });
      const nextSession = {
        ...session,
        credential: { ...session.credential, password_change_required: false },
      };
      setSession(nextSession);
      saveJson(sessionKey, nextSession);
      setPasswordForm({ current: "", next: "", confirm: "" });
      setStatusText("Contrasena actualizada");
    } catch {
      setStatusText("No se pudo cambiar la contrasena.");
    } finally {
      setBusy(false);
    }
  }

  async function requestReset() {
    setBusy(true);
    try {
      const payload = await requestJson<{ reset_code?: string }>("/api/station-web/password-reset/request", {
        method: "POST",
        body: JSON.stringify({ email: resetForm.email || loginEmail }),
      });
      setStatusText(payload.reset_code ? loginText.status.resetCode(payload.reset_code) : loginText.status.resetRequested);
    } catch {
      setStatusText(loginText.status.resetRequestFailed);
    } finally {
      setBusy(false);
    }
  }

  async function confirmReset(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    try {
      await requestJson("/api/station-web/password-reset/confirm", {
        method: "POST",
        body: JSON.stringify({
          email: resetForm.email || loginEmail,
          reset_code: resetForm.code,
          new_password: resetForm.password,
        }),
      });
      setResetOpen(false);
      setStatusText(loginText.status.resetConfirmed);
    } catch {
      setStatusText(loginText.status.resetInvalid);
    } finally {
      setBusy(false);
    }
  }

  async function acceptConsent() {
    if (!session || !canAcceptConsent) return;
    window.localStorage.setItem(consentKey, "accepted");
    setConsentAccepted(true);
    await sendEvent("consent_saved", stationState, true, {
      aceptado: true,
      auth_email: session.email,
      version: "2026.08-web-station-v1",
      fechaHora: nowIso(),
      checks: consentChecks,
    });
  }

  async function transition(type: string, makeState: (state: StationState) => StationState) {
    if (!requireExtension()) return;
    const next = makeState(stationState);
    setStationState(next);
    await sendEvent(type, next);
  }

  async function startShift() {
    if (!requireExtension()) return;
    if (closedToday) {
      setStatusText("Ya activaste y cerraste la jornada de hoy. Ingresa codigo de reactivacion para reabrirla.");
      return;
    }
    await transition("shift_started", () => ({
      ...emptyState,
      status: "TRABAJANDO",
      workDate: zonedDateIso(stationTimeZone),
      timeZone: stationTimeZone,
      startedAt: nowIso(),
      phaseStartedAt: Date.now(),
    }));
  }

  async function finishShift() {
    await transition("shift_finished", (state) => {
      const closed = closeCurrentPhase(state);
      const closedTimeZone = closed.timeZone || effectiveTimeZone;
      return {
        ...closed,
        status: "TERMINADO",
        workDate: closed.workDate || zonedDateIso(closedTimeZone),
        timeZone: closedTimeZone,
        endedAt: nowIso(),
        overtimeStatus: closed.overtimeStatus === "ACTIVA" ? "FINALIZADA" : closed.overtimeStatus,
        overtimeStartedAt: null,
      };
    });
  }

  async function startBreak() {
    await transition("break_started", (state) => ({ ...closeCurrentPhase(state), status: "BREAK", breakUsed: true, phaseStartedAt: Date.now() }));
  }

  async function endBreak() {
    await transition("break_finished", (state) => ({ ...closeCurrentPhase(state), status: "TRABAJANDO", phaseStartedAt: Date.now() }));
  }

  async function startLunch() {
    await transition("lunch_started", (state) => ({ ...closeCurrentPhase(state), status: "LUNCH", lunchUsed: true, phaseStartedAt: Date.now() }));
  }

  async function endLunch() {
    await transition("lunch_finished", (state) => ({ ...closeCurrentPhase(state), status: "TRABAJANDO", phaseStartedAt: Date.now() }));
  }

  async function activateOvertime() {
    if (!session || !accessCode.trim()) return;
    if (!requireExtension()) return;
    setBusy(true);
    try {
      const response = await postStation<{
        authorization: { code: string; assigned_minutes?: number | null; minutos_asignados?: number | null };
      }>(session.token, "/api/station/access-codes/consume", { code: accessCode.trim(), type: "overtime" });
      const minutes = response.authorization.assigned_minutes || response.authorization.minutos_asignados || 60;
      const next = {
        ...stationState,
        overtimeStatus: "ACTIVA" as OvertimeStatus,
        overtimeCode: response.authorization.code || accessCode.trim().toUpperCase(),
        overtimeStartedAt: Date.now(),
        overtimeBase: 0,
        overtimeAssignedSeconds: Math.max(1, minutes) * 60,
      };
      setStationState(next);
      setAccessCode("");
      await sendEvent("overtime_started", next);
    } catch {
      setStatusText("Codigo invalido, vencido o ya utilizado.");
    } finally {
      setBusy(false);
    }
  }

  async function restoreShift() {
    if (!session || !accessCode.trim() || stationState.status !== "TERMINADO") return;
    if (!requireExtension()) return;
    setBusy(true);
    try {
      await postStation(session.token, "/api/station/access-codes/consume", {
        code: accessCode.trim(),
        type: "station_reopen",
      });
      const restoredTimeZone = stationState.timeZone || effectiveTimeZone;
      const next = {
        ...stationState,
        status: "TRABAJANDO" as StationStatus,
        workDate: stationState.workDate || zonedDateIso(restoredTimeZone),
        timeZone: restoredTimeZone,
        endedAt: null,
        phaseStartedAt: Date.now(),
      };
      setStationState(next);
      setAccessCode("");
      await sendEvent("shift_restored_by_admin", next);
    } catch {
      setStatusText("Codigo invalido, vencido o ya utilizado.");
    } finally {
      setBusy(false);
    }
  }

  async function requestOvertime(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!overtimeRequest.reason.trim()) return;
    await sendEvent("overtime_requested", stationState, true, {
      dia: stationState.workDate || currentWorkDate,
      zona_horaria: effectiveTimeZone,
      hora_salida: overtimeRequest.exitTime,
      motivo: overtimeRequest.reason.trim(),
      estado: "pendiente_autorizacion",
    });
    setOvertimeRequest({ exitTime: "", reason: "" });
    setStatusText("Solicitud de horas extra enviada");
  }

  async function submitIncident(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!incident.description.trim()) return;
    const incidentTypeLabel: Record<string, string> = {
      correccion_marcaje: "Correccion de marcaje",
      permiso_vacaciones: "Permisos o vacaciones",
      tiempo_perdido: "Tiempo perdido por sistema",
    };
    const result = await sendEvent("incident_submitted", stationState, true, {
      tipo: incident.type,
      incident_type: incident.type,
      titulo: incidentTypeLabel[incident.type] || "Incidencia",
      problema: incidentTypeLabel[incident.type] || incident.type,
      motivo: incident.description.trim(),
      dia: stationState.workDate || currentWorkDate,
      zona_horaria: effectiveTimeZone,
      estado_jornada: stationState.status,
      web_station_incident: true,
      evidencia_tecnica: {
        periodo_sugerido: stationState.startedAt ? `${formatZonedTime(stationState.startedAt, effectiveTimeZone)} - ${formatZonedTime(Date.now(), effectiveTimeZone)}` : "Jornada web",
        minutos_estimados: 15,
        app_activa: "Estacion web",
        ventana_activa: "Estacion de marcaje",
        estado_jornada: stationState.status,
        sincronizacion: isOnline ? "En linea" : "Sin conexion",
        equipo: session?.device.name || "Estacion web",
        zona_horaria: effectiveTimeZone,
        extension: extensionConnected ? "Conectada" : "No conectada",
      },
      requested_at: nowIso(),
    });
    if (result.status === "rejected") return;
    setIncident({ type: "correccion_marcaje", description: "" });
    setIncidentOpen(false);
    setStatusText(result.status === "queued" ? "Incidencia guardada pendiente de sincronizacion" : "Incidencia enviada");
  }

  async function logout() {
    const activeSession = session;
    const hadActiveShift = shiftActive;
    if (activeSession && hadActiveShift) {
      const confirmed = window.confirm(
        "Tienes una jornada activa. Si sales, la jornada queda guardada en este equipo y podras continuarla al volver a iniciar sesion, "
          + "pero no podras marcar break, almuerzo ni salida hasta que regreses. ¿Deseas salir?",
      );
      if (!confirmed) return;
    }
    setBusy(true);
    if (activeSession?.token && activeSession.employee?.id) {
      // Ultimo intento de enviar la cola con el token de ESTE usuario. Lo que no
      // se pueda enviar queda guardado bajo su empleado y solo se enviara cuando
      // el vuelva a iniciar sesion; nunca con el token de otra persona.
      await Promise.race([
        flushQueue(activeSession.token, activeSession.employee.id).catch(() => undefined),
        new Promise((resolve) => window.setTimeout(resolve, 4000)),
      ]);
      saveJson(stateKeyFor(activeSession.employee.id), stationState);
    }
    removeKey(sessionKey);
    window.postMessage({ type: "VYNTRA_STATION_CLEAR" }, window.location.origin);
    setSession(null);
    setStationState({ ...emptyState, timeZone: stationTimeZone });
    setQueueStats(readQueueStats(null));
    setConsentAccepted(false);
    setConsentChecks([false, false, false, false]);
    setPasswordForm({ current: "", next: "", confirm: "" });
    setIncident({ type: "correccion_marcaje", description: "" });
    setIncidentOpen(false);
    setLegalDialogOpen(false);
    setAccessCode("");
    setOvertimeRequest({ exitTime: "", reason: "" });
    setBusy(false);
    setStatusText(hadActiveShift ? "Sesion cerrada. La jornada activa quedo guardada para cuando vuelvas a iniciar sesion." : "Sesion cerrada");
  }

  if (!ready) {
    return <main className="station-public-shell"><div className="station-brand-mark">V</div></main>;
  }

  if (!session) {
    const extensionStatusClass = extensionConnected ? "ready" : "needs-update";
    const extensionStatusText = extensionConnected
      ? extensionUpdateAvailable
        ? `${loginText.extensionReady} · ${loginLanguage === "es" ? "nueva version" : "new version"} ${latestExtensionVersion} ${loginLanguage === "es" ? "disponible" : "available"}`
        : loginText.extensionReady
      : extensionNeedsUpdate
      ? loginText.extensionOutdated(extensionStatus.extensionVersion)
      : loginText.extensionRequired;

    return (
      <main className="station-public-shell station-login-shell">
        <button
          type="button"
          className="station-language-toggle"
          aria-label={loginText.languageToggleLabel}
          onClick={toggleLoginLanguage}
        >
          {loginLanguage === "es" ? "EN" : "ES"}
        </button>
        <div className="station-public-layout station-login-layout">
          <section className="station-login-hero" aria-label={loginText.ariaStation}>
            <div className="station-login-brand station-login-brand-hero">
              <div className="station-brand-mark">V</div>
              <div>
                <span>VYNTRA</span>
                <strong>{loginText.brandSubtitle}</strong>
              </div>
            </div>
            <h2>{loginText.hero}</h2>
            <div className="station-login-hero-actions">
              <button type="button" className="station-hero-button" onClick={() => setHowWorksDialogOpen(true)}>{loginText.howWorks}</button>
              {!extensionConnected || extensionUpdateAvailable ? (
                <button type="button" className="station-hero-link" onClick={() => setExtensionDialogOpen(true)}>
                  {extensionConnected || extensionNeedsUpdate ? loginText.updateExtension : loginText.installExtension}
                </button>
              ) : null}
            </div>
          </section>
          <section className="station-login-panel" aria-labelledby="station-login-title">
            <h1 id="station-login-title">{loginText.signInTitle}</h1>
            <form className="station-form" onSubmit={login}>
              <label>{loginText.emailLabel}
                <span className="station-input-wrap">
                  <input type="email" value={loginEmail} onChange={(event) => setLoginEmail(event.target.value)} autoComplete="email" placeholder={loginText.emailPlaceholder} required />
                  <span aria-hidden="true">@</span>
                </span>
              </label>
              <label>{loginText.passwordLabel}
                <span className="station-input-wrap">
                  <input
                    type="password"
                    value={loginPassword}
                    onChange={(event) => setLoginPassword(event.target.value)}
                    autoComplete="current-password"
                    placeholder={loginText.passwordPlaceholder}
                    required
                  />
                  <span aria-hidden="true">o</span>
                </span>
              </label>
              <div className="station-login-options">
                <label>
                  <input
                    type="checkbox"
                    checked={rememberEmail}
                    onChange={(event) => {
                      setRememberEmail(event.target.checked);
                      if (!event.target.checked) removeKey(rememberEmailKey);
                    }}
                  />
                  {loginText.remember}
                </label>
                <button type="button" onClick={() => { setResetOpen(true); setResetForm((form) => ({ ...form, email: loginEmail })); }}>
                  {loginText.forgotPassword}
                </button>
              </div>
              <button type="submit" className="station-primary" disabled={busy || !extensionConnected}>{busy ? loginText.verifying : loginText.enter}</button>
            </form>
            <p className={`station-extension-status ${extensionStatusClass}`}>
              <span>{extensionStatusText}</span>
              {!extensionConnected || extensionUpdateAvailable ? (
                <button type="button" onClick={() => setExtensionDialogOpen(true)}>
                  {extensionConnected || extensionNeedsUpdate ? loginText.update : loginText.install}
                </button>
              ) : null}
            </p>
            {resetOpen ? (
              <form className="station-reset-box" onSubmit={confirmReset}>
                <label>{loginText.resetEmail}
                  <input type="email" value={resetForm.email} onChange={(event) => setResetForm({ ...resetForm, email: event.target.value })} required />
                </label>
                <button type="button" className="station-secondary" onClick={requestReset} disabled={busy}>{loginText.sendCode}</button>
                <label>{loginText.resetCode}
                  <input value={resetForm.code} onChange={(event) => setResetForm({ ...resetForm, code: event.target.value })} required />
                </label>
                <label>{loginText.resetPassword}
                  <input type="password" value={resetForm.password} onChange={(event) => setResetForm({ ...resetForm, password: event.target.value })} required />
                </label>
                <button type="submit" className="station-primary" disabled={busy}>{loginText.resetSubmit}</button>
              </form>
            ) : null}
            {statusText ? <p className="station-status-line" role="status" aria-live="polite">{statusText}</p> : null}
          </section>
        </div>
        {howWorksDialogOpen ? (
          <div className="station-extension-dialog-backdrop" role="presentation" onClick={() => setHowWorksDialogOpen(false)}>
            <section
              className="station-extension-dialog"
              role="dialog"
              aria-modal="true"
              aria-labelledby="station-how-dialog-title"
              ref={howWorksDialogRef}
              onClick={(event) => event.stopPropagation()}
            >
              <button
                type="button"
                className="station-extension-dialog-close"
                aria-label={loginText.close}
                onClick={() => setHowWorksDialogOpen(false)}
              >
                ×
              </button>
              <header>
                <span>{loginText.howModalEyebrow}</span>
                <h2 id="station-how-dialog-title">{loginText.howModalTitle}</h2>
                <p>{loginText.howModalIntro}</p>
              </header>
              <ul className="station-info-list">
                {loginText.howModalItems.map((item) => <li key={item}>{item}</li>)}
              </ul>
              <small>{loginText.howModalNote}</small>
            </section>
          </div>
        ) : null}
        {extensionDialogOpen ? (
          <div className="station-extension-dialog-backdrop" role="presentation" onClick={() => setExtensionDialogOpen(false)}>
            <section
              className="station-extension-dialog"
              role="dialog"
              aria-modal="true"
              aria-labelledby="station-extension-dialog-title"
              ref={extensionDialogRef}
              onClick={(event) => event.stopPropagation()}
            >
              <button
                type="button"
                className="station-extension-dialog-close"
                aria-label={loginText.close}
                onClick={() => setExtensionDialogOpen(false)}
              >
                ×
              </button>
              <header>
                <span>{extensionMissing ? loginText.extensionRequiredEyebrow : loginText.extensionNewVersion}</span>
                <h2 id="station-extension-dialog-title">{loginText.extensionModalTitle}</h2>
                <p>{loginText.extensionModalIntro}</p>
              </header>
              <ol>
                {loginText.extensionSteps.map((step) => <li key={step}>{step}</li>)}
              </ol>
              <a className="station-download-button" href={extensionDownloadHref} download>
                {loginText.downloadUpdate}
              </a>
              <small>{loginText.extensionModalNote}</small>
            </section>
          </div>
        ) : null}
      </main>
    );
  }

  if (needsPasswordChange) {
    return (
      <main className="station-public-shell">
        <section className="station-login-panel">
          <div className="station-login-brand">
            <div className="station-brand-mark">V</div>
            <div>
              <span>{session.employee.full_name}</span>
              <h1>Cambia tu contrasena</h1>
            </div>
          </div>
          <form className="station-form" onSubmit={changePassword}>
            <label>Contrasena temporal
              <input type="password" value={passwordForm.current} onChange={(event) => setPasswordForm({ ...passwordForm, current: event.target.value })} required />
            </label>
            <label>Nueva contrasena
              <input type="password" value={passwordForm.next} onChange={(event) => setPasswordForm({ ...passwordForm, next: event.target.value })} required />
            </label>
            <label>Confirmar contrasena
              <input type="password" value={passwordForm.confirm} onChange={(event) => setPasswordForm({ ...passwordForm, confirm: event.target.value })} required />
            </label>
            <small>Minimo 8 caracteres, mayuscula, minuscula, numero y signo.</small>
            <button type="submit" className="station-primary" disabled={busy}>Guardar</button>
          </form>
          {statusText ? <p className="station-status-line" role="status" aria-live="polite">{statusText}</p> : null}
        </section>
      </main>
    );
  }

  if (!consentAccepted) {
    return (
      <main className="station-public-shell">
        <section className="station-consent-panel">
          <div className="station-login-brand">
            <div className="station-brand-mark">V</div>
            <div>
              <span>{session.employee.full_name}</span>
              <h1>Aviso de estacion web</h1>
            </div>
          </div>
          <div className="station-consent-copy">
            <p>Esta estacion registra tu jornada laboral, pausas, almuerzo, horas extra, incidencias y actividad dentro de esta pagina mientras tu jornada este activa.</p>
            <p>La extension VYNTRA Browser es requerida para marcar. Registra actividad autorizada del navegador, no aplicaciones externas, teclas globales, camara, microfono ni archivos personales.</p>
          </div>
          <div className="station-check-list">
            {[
              "Lei y comprendi el aviso de monitoreo web.",
              "Entiendo que esta estacion registra marcajes y eventos de asistencia.",
              "Entiendo que debo mantener conectada la extension VYNTRA Browser para marcar.",
              "Autorizo el uso de la estacion web y la extension durante mi jornada laboral.",
            ].map((label, index) => (
              <label key={label}>
                <input
                  type="checkbox"
                  checked={consentChecks[index]}
                  onChange={(event) => setConsentChecks((current) => current.map((value, itemIndex) => itemIndex === index ? event.target.checked : value))}
                />
                {label}
              </label>
            ))}
          </div>
          <div className="station-consent-actions">
            <button type="button" className="station-primary" disabled={!canAcceptConsent} onClick={() => void acceptConsent()}>Aceptar y continuar</button>
            <button type="button" className="station-secondary" onClick={() => void logout()} disabled={busy}>Salir</button>
          </div>
          {statusText ? <p className="station-status-line" role="status" aria-live="polite">{statusText}</p> : null}
        </section>
      </main>
    );
  }

  const canMark = extensionConnected && !busy;
  const canStartNewShift = stationState.status === "FUERA" || (stationState.status === "TERMINADO" && !closedToday);
  const extensionBlockText = extensionNeedsUpdate
    ? `La extension instalada no es compatible. Instala VYNTRA Browser ${requiredExtensionVersion} o superior.`
    : "Marcaje bloqueado hasta conectar la extension.";
  const extensionStatusText = extensionNeedsUpdate
    ? `Instala version ${requiredExtensionVersion} o superior`
    : "Instala VYNTRA Browser";
  const statusCopy: Record<StationStatus, { label: string; capture: string; detail: string }> = {
    FUERA: {
      label: "Fuera de jornada",
      capture: extensionConnected ? "Registro detenido" : extensionNeedsUpdate ? "Actualizacion requerida" : "Extension requerida",
      detail: extensionConnected
        ? "Selecciona iniciar jornada para comenzar el registro web."
        : extensionNeedsUpdate
        ? `Instala VYNTRA Browser ${requiredExtensionVersion} o superior para habilitar el marcaje.`
        : "Instala y conecta VYNTRA Browser para habilitar el marcaje.",
    },
    TRABAJANDO: {
      label: "Jornada activa",
      capture: "Registro web activo",
      detail: "Tu jornada esta activa en esta estacion web.",
    },
    BREAK: {
      label: "En break",
      capture: "Registro pausado",
      detail: "Break activo. Finalizalo para volver a jornada.",
    },
    LUNCH: {
      label: "En almuerzo",
      capture: "Registro pausado",
      detail: "Almuerzo activo. Finalizalo para volver a jornada.",
    },
    TERMINADO: {
      label: "Jornada finalizada",
      capture: "Registro detenido",
      detail: closedToday ? "La jornada de hoy ya fue cerrada. Solo puede reabrirse con codigo." : "Puedes iniciar una nueva jornada laboral.",
    },
  };
  const stateItems = [
    {
      number: "1",
      label: "Inicio de jornada",
      detail: stationState.startedAt ? formatZonedTime(stationState.startedAt, effectiveTimeZone) : "--:--",
      active: Boolean(stationState.startedAt),
    },
    {
      number: "2",
      label: "Trabajando",
      detail: stationState.status === "TRABAJANDO" ? "Ahora" : stationState.status === "BREAK" || stationState.status === "LUNCH" ? "Pausado" : stationState.status === "TERMINADO" ? "Cerrada" : "--",
      active: stationState.status === "TRABAJANDO",
    },
    {
      number: "3",
      label: "Break",
      detail: stationState.status === "BREAK" ? "Ahora" : stationState.breakUsed ? "Usado" : "Libre",
      active: stationState.status === "BREAK",
    },
    {
      number: "4",
      label: "Lunch",
      detail: stationState.status === "LUNCH" ? "Ahora" : stationState.lunchUsed ? "Usado" : "Libre",
      active: stationState.status === "LUNCH",
    },
    {
      number: "5",
      label: "Fin de jornada",
      detail: stationState.endedAt ? formatZonedTime(stationState.endedAt, effectiveTimeZone) : "--:--",
      active: stationState.status === "TERMINADO",
    },
  ];
  const visibleActions = [
    canStartNewShift ? (
      <button type="button" className="station-command primary" onClick={() => void startShift()} disabled={!canMark} key="start">Iniciar jornada</button>
    ) : null,
    shiftActive ? (
      <button type="button" className="station-command primary" onClick={() => void finishShift()} disabled={!canMark} key="finish">Finalizar jornada</button>
    ) : null,
    stationState.status === "TRABAJANDO" && !stationState.breakUsed ? (
      <button type="button" className="station-command" onClick={() => void startBreak()} disabled={!canMark} key="break">Break</button>
    ) : null,
    stationState.status === "BREAK" ? (
      <button type="button" className="station-command primary" onClick={() => void endBreak()} disabled={!canMark} key="end-break">Finalizar break</button>
    ) : null,
    stationState.status === "TRABAJANDO" && !stationState.lunchUsed ? (
      <button type="button" className="station-command" onClick={() => void startLunch()} disabled={!canMark} key="lunch">Lunch</button>
    ) : null,
    stationState.status === "LUNCH" ? (
      <button type="button" className="station-command primary" onClick={() => void endLunch()} disabled={!canMark} key="end-lunch">Finalizar almuerzo</button>
    ) : null,
  ].filter(Boolean);

  return (
    <main className="station-workspace">
      <header className="station-topbar">
        <div className="station-title-lockup">
          <div className="station-brand-mark">V</div>
          <div>
            <strong>VYNTRA</strong>
            <span>Estacion de marcaje</span>
          </div>
        </div>
        <div className="station-topbar-actions">
          <span className={`station-pill station-pill-${stationState.status.toLowerCase()}`}>{statusCopy[stationState.status].label}</span>
          <span className="station-user-chip">{session.employee.full_name}</span>
          <button type="button" className="station-help-button" aria-label="Abrir informacion legal" aria-haspopup="dialog" onClick={() => setLegalDialogOpen(true)}>?</button>
          <button type="button" className="station-secondary" onClick={() => void logout()} disabled={busy}>Salir</button>
        </div>
      </header>

      <section className="station-shell">
        <div className="station-main-panel">
          <div className="station-panel-head">
            <div>
              <span>TURNO ACTUAL</span>
              <h1>Operacion BPO - {stationLocationLabel}</h1>
            </div>
            <strong className={`station-capture station-capture-${stationState.status.toLowerCase()}`}>
              {statusCopy[stationState.status].capture}
            </strong>
          </div>

          <StationClockFace state={stationState} />

          <p className="station-action-hint">{statusCopy[stationState.status].detail}</p>
          {shiftActive ? (
            <p className="station-workday-guidance">
              El cronometro cuenta desde el inicio hasta el cierre manual de la jornada.
            </p>
          ) : null}

          <div className="station-action-row">
            {visibleActions}
            {!extensionConnected ? <p className="station-ended-copy">{extensionBlockText}</p> : null}
            {closedToday ? <p className="station-ended-copy">Jornada finalizada. Ingresa codigo de reactivacion en ajustes.</p> : null}
          </div>

          <StationLiveMetrics state={stationState} timeZone={effectiveTimeZone} canAccrueTime={canAccrueTime} />
        </div>

        <aside className="station-side-panel">
          <section className="station-logo-card">
            <div className="station-logo-tile">V</div>
            <div>
              <h2>VYNTRA</h2>
              <strong>Agente empresarial</strong>
              <p>Estacion de marcaje laboral abierta en navegador.</p>
            </div>
          </section>

          <section className="station-status-card">
            <div className="station-card-title">
              <h2>Estado de jornada</h2>
              <span>Registro visible</span>
            </div>
            <div className="station-step-list">
              {stateItems.map((item) => (
                <div className={item.active ? "active" : ""} key={item.label}>
                  <span>{item.number}</span>
                  <strong>{item.label}</strong>
                  <small>{item.detail}</small>
                </div>
              ))}
            </div>
          </section>

          <section className="station-support-card">
            <div className="station-card-title">
              <h2>Incidencias y ajustes</h2>
              <span>Solicitudes</span>
            </div>
            <div className="station-support-grid">
              <article>
                <span>S</span>
                <div>
                  <strong>{isOnline && !queueStats.pending ? "Sincronizado" : "Pendiente"}</strong>
                  <small>
                    {queueStats.pending
                      ? `${queueStats.pending} ${queueStats.pending === 1 ? "evento" : "eventos"} por sincronizar`
                      : isOnline ? "En linea" : "Sin conexion"}
                  </small>
                  {queueStats.rejected ? (
                    <small title={queueStats.lastRejectedError || undefined}>
                      {queueStats.rejected} {queueStats.rejected === 1 ? "evento rechazado" : "eventos rechazados"} por el servidor
                    </small>
                  ) : null}
                </div>
              </article>
              <article>
                <span>B</span>
                <div>
                  <strong>{extensionConnected ? "Extension conectada" : "Marcaje bloqueado"}</strong>
                  <small>{extensionConnected ? (extensionStatus.tracking ? "Navegador activo" : "Lista para marcar") : extensionStatusText}</small>
                </div>
              </article>
            </div>
            <TimeZoneSelect
              value={effectiveTimeZone}
              onChange={updateTimeZone}
              compact
              disabled={timeZoneLocked}
              disabledReason="La zona horaria queda fija mientras la jornada esta activa o cerrada hoy."
            />
            <button type="button" className="station-primary wide" onClick={() => setIncidentOpen((value) => !value)}>Abrir incidencias</button>

            <div className="station-code-box">
              <h3>Codigos de acceso</h3>
              <p>{stationState.status === "TERMINADO" ? "Ingresa un codigo para reabrir esta jornada." : "Ingresa el codigo autorizado por tu supervisor."}</p>
              <div className="station-inline-form">
                <input value={accessCode} onChange={(event) => setAccessCode(event.target.value)} placeholder="Codigo" disabled={(stationState.status !== "TERMINADO" && !shiftActive) || busy} />
                {stationState.status === "TERMINADO" ? (
                  <button type="button" className="station-primary" onClick={() => void restoreShift()} disabled={!canMark || !accessCode.trim()}>Reabrir</button>
                ) : (
                  <button type="button" className="station-primary" onClick={() => void activateOvertime()} disabled={!shiftActive || !canMark || stationState.overtimeStatus === "ACTIVA"}>Activar</button>
                )}
              </div>
            </div>

            <form className="station-overtime-form" onSubmit={requestOvertime}>
              <label>Hora estimada de salida
                <input type="time" value={overtimeRequest.exitTime} onChange={(event) => setOvertimeRequest({ ...overtimeRequest, exitTime: event.target.value })} disabled={!shiftActive} />
              </label>
              <label>Motivo
                <textarea value={overtimeRequest.reason} onChange={(event) => setOvertimeRequest({ ...overtimeRequest, reason: event.target.value })} rows={3} disabled={!shiftActive} />
              </label>
              <button type="submit" className="station-secondary wide" disabled={!shiftActive || !overtimeRequest.reason.trim()}>Solicitar horas extra</button>
            </form>
          </section>
          {!extensionConnected ? <ExtensionDownloadCard compact /> : null}
        </aside>
      </section>

      {incidentOpen ? (
        <form className="station-incident-drawer" onSubmit={submitIncident}>
          <label>Tipo
            <select value={incident.type} onChange={(event) => setIncident({ ...incident, type: event.target.value })}>
              <option value="correccion_marcaje">Correccion de marcaje</option>
              <option value="permiso_vacaciones">Permisos o vacaciones</option>
              <option value="tiempo_perdido">Tiempo perdido por sistema</option>
            </select>
          </label>
          <label>Detalle
            <textarea value={incident.description} onChange={(event) => setIncident({ ...incident, description: event.target.value })} rows={4} required />
          </label>
          <div>
            <button type="submit" className="station-primary">Enviar incidencia</button>
            <button type="button" className="station-secondary" onClick={() => setIncidentOpen(false)}>Cancelar</button>
          </div>
        </form>
      ) : null}

      {legalDialogOpen ? (
        <div className="station-extension-dialog-backdrop" role="presentation" onClick={() => setLegalDialogOpen(false)}>
          <section
            className="station-extension-dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby="station-legal-dialog-title"
            ref={legalDialogRef}
            onClick={(event) => event.stopPropagation()}
          >
            <button
              type="button"
              className="station-extension-dialog-close"
              aria-label="Cerrar"
              onClick={() => setLegalDialogOpen(false)}
            >
              ×
            </button>
            <header>
              <span>Informacion legal</span>
              <h2 id="station-legal-dialog-title">Aviso de estacion web</h2>
              <p>Esta estacion registra tu jornada laboral, pausas, almuerzo, horas extra, incidencias y actividad dentro de esta pagina mientras tu jornada este activa.</p>
            </header>
            <ul className="station-info-list">
              <li>La extension VYNTRA Browser es requerida para marcar. Registra actividad autorizada del navegador, no aplicaciones externas, teclas globales, camara, microfono ni archivos personales.</li>
              <li>Durante la jornada activa toma capturas autorizadas cada 5 minutos como respaldo de trabajo.</li>
            </ul>
            <a className="station-download-button" href="/privacy" target="_blank" rel="noopener noreferrer">
              Ver aviso de privacidad completo
            </a>
          </section>
        </div>
      ) : null}

      {statusText ? <p className="station-floating-status" role="status" aria-live="polite">{statusText}</p> : null}
    </main>
  );
}
