"use client";

import { FormEvent, useEffect, useRef, useState, type CSSProperties } from "react";

const STATION_VERSION = "web-station-1.0.0";
const sessionKey = "vyntra.station.session";
const stateKey = "vyntra.station.state";
const consentPrefix = "vyntra.station.consent.";
const queueKey = "vyntra.station.queue";
const timeZoneKey = "vyntra.station.timezone";
const extensionDownloadHref = "/extensions/vyntra-browser-extension.zip";

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

type StationStatus = "FUERA" | "TRABAJANDO" | "BREAK" | "LUNCH" | "TERMINADO";
type OvertimeStatus = "SIN_HORAS_EXTRA" | "ACTIVA" | "FINALIZADA";

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
};

type ExtensionStatus = {
  available: boolean;
  tracking: boolean;
  lastSync: string | null;
  lastError: string | null;
  lastSeenAt: number | null;
};

class StationEventRejected extends Error {}

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
  window.localStorage.setItem(key, JSON.stringify(value));
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

function zonedDateIso(timeZone: string, value: Date | string | number = new Date()) {
  const date = value instanceof Date ? value : new Date(value);
  try {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).formatToParts(date);
    const year = parts.find((part) => part.type === "year")?.value || "0000";
    const month = parts.find((part) => part.type === "month")?.value || "01";
    const day = parts.find((part) => part.type === "day")?.value || "01";
    return `${year}-${month}-${day}`;
  } catch {
    return date.toISOString().slice(0, 10);
  }
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

function totals(state: StationState, canAccrueTime = true) {
  const work = state.workBase + (canAccrueTime && state.status === "TRABAJANDO" ? secondsSince(state.phaseStartedAt) : 0);
  const breakSeconds = state.breakBase + (canAccrueTime && state.status === "BREAK" ? secondsSince(state.phaseStartedAt) : 0);
  const lunch = state.lunchBase + (canAccrueTime && state.status === "LUNCH" ? secondsSince(state.phaseStartedAt) : 0);
  const overtime = state.overtimeBase + (canAccrueTime && state.overtimeStatus === "ACTIVA" ? secondsSince(state.overtimeStartedAt) : 0);
  return { work, breakSeconds, lunch, overtime };
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

async function requestJson<T>(path: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(path, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      ...(init.headers || {}),
    },
    cache: "no-store",
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.json();
}

async function postStation<T>(token: string, path: string, body: unknown): Promise<T> {
  return requestJson<T>(path, {
    method: "POST",
    headers: { "X-Device-Token": token },
    body: JSON.stringify(body),
  });
}

function queueEvents(events: QueuedEvent[]) {
  const current = loadJson<QueuedEvent[]>(queueKey) || [];
  saveJson(queueKey, [...current, ...events].slice(-100));
}

async function flushQueue(token: string) {
  const events = loadJson<QueuedEvent[]>(queueKey) || [];
  if (!events.length) return;
  const response = await postStation<{ ok?: boolean; rejected?: { error?: string }[] }>(token, "/api/agent/events", { events });
  if (response.ok === false) throw new Error(response.rejected?.[0]?.error || "Evento rechazado");
  saveJson(queueKey, []);
}

function ExtensionDownloadCard({ compact = false }: { compact?: boolean }) {
  return (
    <section className={compact ? "station-extension-card compact" : "station-extension-card"}>
      <div className="station-card-title">
        <h2>Extension VYNTRA Browser</h2>
        <span>Obligatoria</span>
      </div>
      <p>Es requerida para marcar jornada. Agrega actividad del navegador: pestana activa, dominio, titulo, foco, inactividad y captura manual de pestana.</p>
      <a className="station-download-button" href={extensionDownloadHref} download>
        Descargar extension
      </a>
      <ol>
        <li>Descarga y descomprime el archivo.</li>
        <li>Abre Chrome o Edge y entra a la pagina de extensiones.</li>
        <li>Activa el modo de desarrollador.</li>
        <li>Elige cargar extension sin empaquetar y selecciona la carpeta descargada.</li>
        <li>Vuelve a esta estacion e inicia sesion.</li>
      </ol>
      <small>La estacion no permite iniciar, pausar, reabrir ni finalizar jornada si la extension no esta conectada.</small>
    </section>
  );
}

function TimeZoneSelect({
  value,
  onChange,
  compact = false,
}: {
  value: string;
  onChange: (value: string) => void;
  compact?: boolean;
}) {
  const options = stationTimeZones.includes(value) ? stationTimeZones : [value, ...stationTimeZones];
  return (
    <label className={compact ? "station-timezone compact" : "station-timezone"}>Zona horaria
      <select value={value} onChange={(event) => onChange(event.target.value)}>
        {options.map((timeZone) => (
          <option value={timeZone} key={timeZone}>{timeZone}</option>
        ))}
      </select>
    </label>
  );
}

export default function StationPage() {
  const [session, setSession] = useState<StationSession | null>(null);
  const [stationState, setStationState] = useState<StationState>(emptyState);
  const [ready, setReady] = useState(false);
  const [statusText, setStatusText] = useState("");
  const [loginEmail, setLoginEmail] = useState("");
  const [loginPassword, setLoginPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [consentAccepted, setConsentAccepted] = useState(false);
  const [consentChecks, setConsentChecks] = useState([false, false, false, false]);
  const [passwordForm, setPasswordForm] = useState({ current: "", next: "", confirm: "" });
  const [resetForm, setResetForm] = useState({ email: "", code: "", password: "" });
  const [resetOpen, setResetOpen] = useState(false);
  const [incidentOpen, setIncidentOpen] = useState(false);
  const [incident, setIncident] = useState({ type: "correccion_marcaje", description: "" });
  const [accessCode, setAccessCode] = useState("");
  const [overtimeRequest, setOvertimeRequest] = useState({ exitTime: "", reason: "" });
  const [stationTimeZone, setStationTimeZone] = useState("America/Managua");
  const [isOnline, setIsOnline] = useState(() => (typeof navigator === "undefined" ? true : navigator.onLine));
  const [extensionStatus, setExtensionStatus] = useState<ExtensionStatus>({
    available: false,
    tracking: false,
    lastSync: null,
    lastError: null,
    lastSeenAt: null,
  });
  const [, setTicks] = useState(0);
  const activityRef = useRef({ clicks: 0, focusChanges: 0, lastInteraction: Date.now() });
  const extensionProbeStartedAtRef = useRef(Date.now());
  const extensionWasBlockedRef = useRef(false);

  const currentWorkDate = zonedDateIso(stationTimeZone);
  const closedWorkDate = stationState.workDate || (stationState.endedAt ? zonedDateIso(stationTimeZone, stationState.endedAt) : null);
  const closedToday = stationState.status === "TERMINADO" && closedWorkDate === currentWorkDate;
  const extensionConnected = Boolean(extensionStatus.available && extensionStatus.lastSeenAt && Date.now() - extensionStatus.lastSeenAt < 15000);
  const extensionGraceActive = !extensionStatus.lastSeenAt && Date.now() - extensionProbeStartedAtRef.current < 3000;
  const currentTotals = totals(stationState, extensionConnected || extensionGraceActive);
  const canAcceptConsent = consentChecks.every(Boolean);
  const needsPasswordChange = Boolean(session?.credential.password_change_required);
  const consentKey = session ? `${consentPrefix}${session.email}` : "";
  const shiftActive = stationState.status === "TRABAJANDO" || stationState.status === "BREAK" || stationState.status === "LUNCH";

  useEffect(() => {
    const timer = window.setTimeout(() => {
      const savedTimeZone = window.localStorage.getItem(timeZoneKey) || defaultTimeZone();
      const savedSession = loadJson<StationSession>(sessionKey);
      const savedState = normalizeState(loadJson<Partial<StationState>>(stateKey), savedTimeZone);
      setStationTimeZone(savedTimeZone);
      if (savedSession) {
        setSession(savedSession);
        setLoginEmail(savedSession.email);
        setConsentAccepted(window.localStorage.getItem(`${consentPrefix}${savedSession.email}`) === "accepted");
      }
      setStationState(savedState);
      setReady(true);
    }, 0);
    return () => window.clearTimeout(timer);
  }, []);

  useEffect(() => {
    if (!ready) return;
    saveJson(stateKey, { ...stationState, timeZone: stationTimeZone });
  }, [ready, stationState, stationTimeZone]);

  useEffect(() => {
    const timer = window.setInterval(() => setTicks((value) => value + 1), 1000);
    return () => window.clearInterval(timer);
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
      void flushQueue(session.token).catch(() => undefined);
      syncBrowserExtension();
    }, 30000);
    return () => window.clearInterval(timer);
    // The timer intentionally samples the current station state every time this effect is renewed.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session?.token, shiftActive, stationState]);

  useEffect(() => {
    syncBrowserExtension();
    // The extension receives a fresh snapshot every time the session, consent or station state changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session?.token, consentAccepted, stationState, needsPasswordChange]);

  function webTelemetry() {
    const idle = Math.floor((Date.now() - activityRef.current.lastInteraction) / 1000);
    const hidden = document.visibilityState !== "visible";
    return {
      seg_activo: Math.max(0, currentTotals.work - idle),
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
    return {
      estado: state.status,
      empleado: session?.employee.full_name || "",
      equipo: session?.device.name || "Estacion web",
      fecha: state.workDate || currentWorkDate,
      zona_horaria: stationTimeZone,
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
    setStationTimeZone(nextTimeZone);
    window.localStorage.setItem(timeZoneKey, nextTimeZone);
    setStationState((current) => ({ ...current, timeZone: nextTimeZone }));
  }

  function requireExtension() {
    if (extensionConnected) return true;
    setStatusText("Instala y conecta la extension VYNTRA Browser para marcar jornada.");
    return false;
  }

  async function sendEvent(type: string, nextState: StationState, showStatus = true, extra: Record<string, unknown> = {}) {
    if (!session?.token) return;
    const event: QueuedEvent = {
      id: eventId(),
      tipo: type,
      created_at: nowIso(),
      payload: { ...snapshot(nextState), ...extra },
    };
    try {
      const response = await postStation<{ ok?: boolean; rejected?: { error?: string }[] }>(session.token, "/api/agent/events", { events: [event] });
      if (response.ok === false) throw new StationEventRejected(response.rejected?.[0]?.error || "Evento rechazado");
      await flushQueue(session.token);
      if (showStatus) setStatusText("Sincronizado");
    } catch (error) {
      if (!(error instanceof StationEventRejected)) queueEvents([event]);
      if (showStatus) setStatusText(error instanceof Error ? error.message : "Sin conexion. El evento quedo pendiente.");
    }
  }

  async function login(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setStatusText("Verificando credenciales...");
    try {
      const payload = await requestJson<{
        ok: boolean;
        company: { id: string };
        employee: StationSession["employee"];
        credential: StationSession["credential"];
        device: { id: string; name: string; token: string };
      }>("/api/station/enroll", {
        method: "POST",
        body: JSON.stringify({
          email: loginEmail.trim().toLowerCase(),
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
      setSession(nextSession);
      saveJson(sessionKey, nextSession);
      setConsentAccepted(window.localStorage.getItem(`${consentPrefix}${nextSession.email}`) === "accepted");
      setLoginPassword("");
      setStatusText("Sesion iniciada");
    } catch {
      setStatusText("Correo o contrasena invalida");
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
      setStatusText(payload.reset_code ? `Codigo de prueba: ${payload.reset_code}` : "Si el correo existe, se envio un codigo.");
    } catch {
      setStatusText("No se pudo solicitar recuperacion.");
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
      setStatusText("Contrasena restablecida. Ingresa con la nueva contrasena.");
    } catch {
      setStatusText("Codigo invalido o vencido.");
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
      workDate: currentWorkDate,
      timeZone: stationTimeZone,
      startedAt: nowIso(),
      phaseStartedAt: Date.now(),
    }));
  }

  async function finishShift() {
    await transition("shift_finished", (state) => {
      const closed = closeCurrentPhase(state);
      return {
        ...closed,
        status: "TERMINADO",
        workDate: closed.workDate || currentWorkDate,
        timeZone: stationTimeZone,
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
      const next = {
        ...stationState,
        status: "TRABAJANDO" as StationStatus,
        workDate: stationState.workDate || currentWorkDate,
        timeZone: stationTimeZone,
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
      zona_horaria: stationTimeZone,
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
    await sendEvent("incident_submitted", stationState, true, {
      tipo: incident.type,
      incident_type: incident.type,
      motivo: incident.description.trim(),
      requested_at: nowIso(),
    });
    setIncident({ type: "correccion_marcaje", description: "" });
    setIncidentOpen(false);
    setStatusText("Incidencia enviada");
  }

  function logout() {
    window.localStorage.removeItem(sessionKey);
    window.postMessage({ type: "VYNTRA_STATION_CLEAR" }, window.location.origin);
    setSession(null);
    setStatusText("Sesion cerrada");
  }

  if (!ready) {
    return <main className="station-public-shell"><div className="station-brand-mark">V</div></main>;
  }

  if (!session) {
    return (
      <main className="station-public-shell">
        <div className="station-public-layout">
          <section className="station-login-panel" aria-labelledby="station-login-title">
            <div className="station-login-brand">
              <div className="station-brand-mark">V</div>
              <div>
                <span>VYNTRA</span>
                <h1 id="station-login-title">Estacion de marcaje</h1>
              </div>
            </div>
            <form className="station-form" onSubmit={login}>
              <TimeZoneSelect value={stationTimeZone} onChange={updateTimeZone} />
              <label>Correo laboral
                <input type="email" value={loginEmail} onChange={(event) => setLoginEmail(event.target.value)} autoComplete="email" required />
              </label>
              <label>Contrasena
                <input type="password" value={loginPassword} onChange={(event) => setLoginPassword(event.target.value)} autoComplete="current-password" required />
              </label>
              <button type="submit" className="station-primary" disabled={busy}>{busy ? "Verificando..." : "Entrar"}</button>
            </form>
            <button type="button" className="station-link-button" onClick={() => { setResetOpen(true); setResetForm((form) => ({ ...form, email: loginEmail })); }}>
              Recuperar contrasena
            </button>
            {resetOpen ? (
              <form className="station-reset-box" onSubmit={confirmReset}>
                <label>Correo
                  <input type="email" value={resetForm.email} onChange={(event) => setResetForm({ ...resetForm, email: event.target.value })} required />
                </label>
                <button type="button" className="station-secondary" onClick={requestReset} disabled={busy}>Enviar codigo</button>
                <label>Codigo
                  <input value={resetForm.code} onChange={(event) => setResetForm({ ...resetForm, code: event.target.value })} required />
                </label>
                <label>Nueva contrasena
                  <input type="password" value={resetForm.password} onChange={(event) => setResetForm({ ...resetForm, password: event.target.value })} required />
                </label>
                <button type="submit" className="station-primary" disabled={busy}>Restablecer</button>
              </form>
            ) : null}
            {statusText ? <p className="station-status-line">{statusText}</p> : null}
          </section>
          <ExtensionDownloadCard />
        </div>
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
          {statusText ? <p className="station-status-line">{statusText}</p> : null}
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
            <button type="button" className="station-secondary" onClick={logout}>Salir</button>
          </div>
          {statusText ? <p className="station-status-line">{statusText}</p> : null}
        </section>
      </main>
    );
  }

  const dailyProgress = Math.min(100, Math.max(0, (currentTotals.work / (8 * 60 * 60)) * 100));
  const canMark = extensionConnected && !busy;
  const canStartNewShift = stationState.status === "FUERA" || (stationState.status === "TERMINADO" && !closedToday);
  const statusCopy: Record<StationStatus, { label: string; capture: string; detail: string }> = {
    FUERA: {
      label: "Fuera de jornada",
      capture: extensionConnected ? "Registro detenido" : "Extension requerida",
      detail: extensionConnected ? "Selecciona iniciar jornada para comenzar el registro web." : "Instala y conecta VYNTRA Browser para habilitar el marcaje.",
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
      detail: stationState.startedAt ? formatZonedTime(stationState.startedAt, stationTimeZone) : "--:--",
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
      detail: stationState.endedAt ? formatZonedTime(stationState.endedAt, stationTimeZone) : "--:--",
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
          <button type="button" className="station-help-button" aria-label="Abrir informacion legal">?</button>
          <button type="button" className="station-secondary" onClick={logout}>Salir</button>
        </div>
      </header>

      <section className="station-shell">
        <div className="station-main-panel">
          <div className="station-panel-head">
            <div>
              <span>TURNO ACTUAL</span>
              <h1>Operacion BPO - Managua</h1>
            </div>
            <strong className={`station-capture station-capture-${stationState.status.toLowerCase()}`}>
              {statusCopy[stationState.status].capture}
            </strong>
          </div>

          <div className="station-clock-face" style={{ "--station-progress": `${dailyProgress}%` } as CSSProperties}>
            <div>
              <strong>{formatHms(currentTotals.work)}</strong>
              <span>Tiempo trabajado hoy</span>
              <small>Meta diaria: 8h</small>
            </div>
          </div>

          <p className="station-action-hint">{statusCopy[stationState.status].detail}</p>

          <div className="station-action-row">
            {visibleActions}
            {!extensionConnected ? <p className="station-ended-copy">Marcaje bloqueado hasta conectar la extension.</p> : null}
            {closedToday ? <p className="station-ended-copy">Jornada finalizada. Ingresa codigo de reactivacion en ajustes.</p> : null}
          </div>

          <div className="station-metric-grid">
            <article>
              <span>HORA ACTUAL</span>
              <strong>{formatZonedTime(Date.now(), stationTimeZone, true)}</strong>
            </article>
            <article>
              <span>DIA LABORAL</span>
              <strong>{currentWorkDate}</strong>
            </article>
            <article>
              <span>BREAK USADO</span>
              <strong>{formatHms(currentTotals.breakSeconds)}</strong>
            </article>
            <article>
              <span>ALMUERZO USADO</span>
              <strong>{formatHms(currentTotals.lunch)}</strong>
            </article>
            <article>
              <span>HORAS EXTRA</span>
              <strong>{formatHms(currentTotals.overtime)}</strong>
            </article>
          </div>
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
                  <strong>{isOnline ? "Sincronizado" : "Pendiente"}</strong>
                  <small>{isOnline ? "En linea" : "Sin conexion"}</small>
                </div>
              </article>
              <article>
                <span>W</span>
                <div>
                  <strong>Actividad web</strong>
                  <small>{activityRef.current.clicks} clics</small>
                </div>
              </article>
              <article>
                <span>B</span>
                <div>
                  <strong>{extensionConnected ? "Extension conectada" : "Marcaje bloqueado"}</strong>
                  <small>{extensionConnected ? (extensionStatus.tracking ? "Navegador activo" : "Lista para marcar") : "Instala VYNTRA Browser"}</small>
                </div>
              </article>
            </div>
            <TimeZoneSelect value={stationTimeZone} onChange={updateTimeZone} compact />
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
          <ExtensionDownloadCard compact />
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

      {statusText ? <p className="station-floating-status">{statusText}</p> : null}
    </main>
  );
}
