const STORAGE_KEYS = {
  station: "vyntraStationBridge",
  queue: "vyntraBrowserQueue",
  status: "vyntraBrowserStatus",
  activity: "vyntraBrowserPageActivity",
  rules: "vyntraBrowserRules",
};

const SAMPLE_ALARM = "vyntra-browser-sample";
const AUTO_CAPTURE_ALARM = "vyntra-browser-auto-capture";
const SAMPLE_SECONDS = 60;
const AUTO_CAPTURE_MINUTES = 5;
const STALE_STATION_MS = 10 * 60 * 1000;
const MAX_ACTIVE_SHIFT_MS = 18 * 60 * 60 * 1000;
const WORKING_STATUS = "TRABAJANDO";
const VERSION = "0.3.0";
const ACTIVE_STATUSES = new Set(["TRABAJANDO", "BREAK", "LUNCH"]);

// Politica de captura minima: la lista de sitios permitidos son las reglas de
// productividad de la empresa. La URL y el titulo literal de la pestana solo se
// usan en memoria para comparar; nunca se guardan ni se transmiten.
const BROWSER_EXECUTABLE = "browser-extension";
const UNLISTED_SITE_TITLE = "(sitio fuera de lista)";
const LISTED_APP_TITLE = "(aplicacion permitida)";
const MAX_IDENTIFIER_LENGTH = 120;
const RULES_MAX_AGE_MS = 30 * 60 * 1000;

function eventId() {
  if (crypto?.randomUUID) return crypto.randomUUID();
  return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function nowIso() {
  return new Date().toISOString();
}

function getHost(url) {
  try {
    return new URL(url || "").hostname;
  } catch {
    return "";
  }
}

function storageGet(keys) {
  return chrome.storage.local.get(keys);
}

function storageSet(values) {
  return chrome.storage.local.set(values);
}

function storageRemove(keys) {
  return chrome.storage.local.remove(keys);
}

function queryActiveTab() {
  return chrome.tabs.query({ active: true, lastFocusedWindow: true }).then((tabs) => tabs[0] || null);
}

function queryIdleState() {
  return new Promise((resolve) => {
    chrome.idle.queryState(60, (state) => resolve(state || "active"));
  });
}

function emptyPageActivity() {
  return {
    clicks: 0,
    focusChanges: 0,
    lastInteractionAt: null,
    tabs: {},
  };
}

function getStatus(station, override = {}) {
  const tracking = Boolean(station?.session?.token && station?.shiftActive && station?.consentAccepted && !isStationStale(station));
  const autoCaptureEnabled = tracking && station?.state?.status === WORKING_STATUS;
  return {
    available: true,
    tracking,
    extensionVersion: VERSION,
    autoCaptureEnabled,
    autoCaptureMinutes: AUTO_CAPTURE_MINUTES,
    lastSync: station?.syncedAt || null,
    lastError: null,
    ...override,
  };
}

function isActiveShift(station) {
  return Boolean(station?.shiftActive && ACTIVE_STATUSES.has(station?.state?.status));
}

function isStationStale(station) {
  const syncedAt = Date.parse(station?.syncedAt || "");
  if (isActiveShift(station)) {
    const startedAt = Date.parse(station?.state?.startedAt || station?.snapshot?.inicio_jornada || "");
    if (startedAt && Date.now() - startedAt <= MAX_ACTIVE_SHIFT_MS) return false;
  }
  return !syncedAt || Date.now() - syncedAt > STALE_STATION_MS;
}

function secondsSince(timestamp) {
  if (!timestamp) return 0;
  return Math.max(0, Math.floor((Date.now() - Number(timestamp)) / 1000));
}

function stationTotals(station) {
  const state = station?.state || {};
  const work = Number(state.workBase || 0) + (state.status === "TRABAJANDO" ? secondsSince(state.phaseStartedAt) : 0);
  const breakSeconds = Number(state.breakBase || 0) + (state.status === "BREAK" ? secondsSince(state.phaseStartedAt) : 0);
  const lunch = Number(state.lunchBase || 0) + (state.status === "LUNCH" ? secondsSince(state.phaseStartedAt) : 0);
  const overtime = Number(state.overtimeBase || 0) + (state.overtimeStatus === "ACTIVA" ? secondsSince(state.overtimeStartedAt) : 0);
  return { work, breakSeconds, lunch, overtime };
}

async function saveStatus(status) {
  const values = await storageGet(STORAGE_KEYS.status);
  const previous = values[STORAGE_KEYS.status] || {};
  const nextStatus = { ...previous, ...status };
  await storageSet({ [STORAGE_KEYS.status]: nextStatus });
  notifyStationTabs(nextStatus);
  return nextStatus;
}

async function currentStatus() {
  const values = await storageGet([STORAGE_KEYS.station, STORAGE_KEYS.status]);
  return values[STORAGE_KEYS.status] || getStatus(values[STORAGE_KEYS.station]);
}

function notifyStationTabs(status) {
  chrome.tabs.query({
    url: [
      "https://vyntralab.tech/estacion*",
      "https://www.vyntralab.tech/estacion*",
      "http://localhost:3000/estacion*",
      "http://localhost:3001/estacion*",
    ],
  }).then((tabs) => {
    for (const tab of tabs) {
      if (tab.id) chrome.tabs.sendMessage(tab.id, { type: "extension_status", status }).catch(() => undefined);
    }
  }).catch(() => undefined);
}

async function postStationEvent(station, event) {
  const apiBase = station.apiBase || "https://vyntralab.tech";
  const response = await fetch(`${apiBase}/api/agent/events`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Device-Token": station.session.token,
    },
    body: JSON.stringify({ events: [event] }),
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.json();
}

async function flushQueue(station) {
  const values = await storageGet(STORAGE_KEYS.queue);
  const queue = values[STORAGE_KEYS.queue] || [];
  if (!queue.length) return;
  const pending = [];
  for (const event of queue) {
    try {
      await postStationEvent(station, event);
    } catch {
      pending.push(event);
    }
  }
  await storageSet({ [STORAGE_KEYS.queue]: pending.slice(-200) });
}

async function enqueue(event) {
  const values = await storageGet(STORAGE_KEYS.queue);
  const queue = values[STORAGE_KEYS.queue] || [];
  await storageSet({ [STORAGE_KEYS.queue]: [...queue, event].slice(-200) });
}

async function loadRules(station, { force = false } = {}) {
  const values = await storageGet(STORAGE_KEYS.rules);
  const cached = values[STORAGE_KEYS.rules];
  const fresh = cached && Date.now() - Date.parse(cached.fetchedAt || "") < RULES_MAX_AGE_MS;
  if (!force && fresh) return cached.rules || [];
  if (!station?.session?.token) return cached?.rules || [];

  try {
    const response = await fetch(`${station.apiBase || "https://vyntralab.tech"}/api/agent/rules`, {
      headers: { "X-Device-Token": station.session.token },
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const data = await response.json();
    const rules = Array.isArray(data?.rules) ? data.rules : [];
    await storageSet({ [STORAGE_KEYS.rules]: { rules, fetchedAt: nowIso() } });
    return rules;
  } catch {
    return cached?.rules || [];
  }
}

// Devuelve el identificador normalizado de la pestana, si el sitio esta en la
// lista y si admite evidencia visual (solo sitios clasificados como productivos).
function normalizeTab(tab, rules) {
  const domain = getHost(tab?.url || "");
  const haystack = `${domain} - ${tab?.title || ""}`.toLowerCase();
  const rank = (rule) => Number(rule.scope_score || 0) + Number(rule.priority || 0);
  let bestTitle = null;
  let bestAny = null;
  let executableMatch = false;
  for (const rule of rules || []) {
    const executable = String(rule?.executable_name || "").trim().toLowerCase();
    const pattern = String(rule?.title_contains || "").trim();
    if (!executable && !pattern) continue;
    if (executable && executable !== BROWSER_EXECUTABLE) continue;
    if (pattern && !haystack.includes(pattern.toLowerCase())) continue;
    if (pattern) {
      if (!bestTitle || rank(rule) > rank(bestTitle)) bestTitle = rule;
    } else {
      executableMatch = true;
    }
    if (!bestAny || rank(rule) > rank(bestAny)) bestAny = rule;
  }
  const evidenceAllowed = bestAny?.classification === "productive";
  if (bestTitle) {
    const identifier = String(bestTitle.title_contains).trim().slice(0, MAX_IDENTIFIER_LENGTH);
    return { identifier, listed: true, evidenceAllowed };
  }
  if (executableMatch) return { identifier: LISTED_APP_TITLE, listed: true, evidenceAllowed };
  return { identifier: UNLISTED_SITE_TITLE, listed: false, evidenceAllowed: false };
}

async function recordPageActivity(message, sender) {
  const values = await storageGet([STORAGE_KEYS.station, STORAGE_KEYS.activity]);
  const station = values[STORAGE_KEYS.station];
  if (!station?.session?.token || !station.shiftActive || !station.consentAccepted || isStationStale(station)) {
    return { ok: true, ignored: true };
  }

  const tabId = sender?.tab?.id ? String(sender.tab.id) : "unknown";
  const activity = {
    ...emptyPageActivity(),
    ...(values[STORAGE_KEYS.activity] || {}),
    tabs: {
      ...(values[STORAGE_KEYS.activity]?.tabs || {}),
    },
  };
  const tabActivity = {
    clicks: 0,
    focusChanges: 0,
    lastInteractionAt: null,
    ...(activity.tabs[tabId] || {}),
  };
  const clicks = Math.max(0, Number(message.clicks || 0));
  const focusChanges = Math.max(0, Number(message.focusChanges || 0));
  const lastInteractionAt = message.lastInteractionAt || nowIso();
  activity.clicks += clicks;
  activity.focusChanges += focusChanges;
  activity.lastInteractionAt = lastInteractionAt;
  activity.tabs[tabId] = {
    ...tabActivity,
    clicks: tabActivity.clicks + clicks,
    focusChanges: tabActivity.focusChanges + focusChanges,
    lastInteractionAt,
    updatedAt: nowIso(),
  };
  await storageSet({ [STORAGE_KEYS.activity]: activity });
  return { ok: true };
}

async function readPageActivitySummary(activeTab) {
  const values = await storageGet(STORAGE_KEYS.activity);
  const activity = values[STORAGE_KEYS.activity] || emptyPageActivity();
  const tabActivity = activeTab?.id ? activity.tabs?.[String(activeTab.id)] || null : null;
  return {
    clicks: Number(activity.clicks || 0),
    focusChanges: Number(activity.focusChanges || 0),
    lastInteractionAt: activity.lastInteractionAt || null,
    activeTabClicks: Number(tabActivity?.clicks || 0),
    activeTabFocusChanges: Number(tabActivity?.focusChanges || 0),
  };
}

async function clearPageActivity() {
  await storageSet({ [STORAGE_KEYS.activity]: emptyPageActivity() });
}

function buildActivityEvent(station, tab, idleState, pageActivity = emptyPageActivity(), rules = []) {
  const { identifier, listed } = normalizeTab(tab, rules);
  const isIdle = idleState !== "active";
  const basePayload = station.snapshot && typeof station.snapshot === "object" ? station.snapshot : {};
  const baseTelemetry = basePayload.telemetria || {};
  const baseClicks = Number(baseTelemetry.clics || 0);
  const baseFocusChanges = Number(baseTelemetry.cambios_ventana || 0);
  const currentTotals = stationTotals(station);
  return {
    id: eventId(),
    tipo: "browser_activity_snapshot",
    created_at: nowIso(),
    payload: {
      ...basePayload,
      estado: station.state?.status || basePayload.estado || "TRABAJANDO",
      browser_extension: true,
      extension_version: VERSION,
      seg_trabajado: currentTotals.work,
      seg_break: currentTotals.breakSeconds,
      seg_lunch: currentTotals.lunch,
      seg_horas_extra: currentTotals.overtime,
      recurso_actual: identifier,
      titulo_actual: identifier,
      idle_estado_navegador: idleState,
      telemetria: {
        ...baseTelemetry,
        origen: "browser_extension",
        clics: baseClicks + Number(pageActivity.clicks || 0),
        cambios_ventana: baseFocusChanges + Number(pageActivity.focusChanges || 0),
        navegador_clics: Number(pageActivity.clicks || 0),
        navegador_cambios_ventana: Number(pageActivity.focusChanges || 0),
        navegador_clics_pestana_actual: Number(pageActivity.activeTabClicks || 0),
        navegador_cambios_pestana_actual: Number(pageActivity.activeTabFocusChanges || 0),
        navegador_ultima_interaccion: pageActivity.lastInteractionAt || null,
        muestras_recientes: [
          {
            timestamp: nowIso(),
            proceso: BROWSER_EXECUTABLE,
            titulo: identifier,
            en_lista: listed,
            clicks: Number(pageActivity.activeTabClicks || 0),
            cambios_ventana: Number(pageActivity.activeTabFocusChanges || 0),
            idle_segundos: isIdle ? SAMPLE_SECONDS : 0,
            is_idle: isIdle,
            duracion_muestra_segundos: SAMPLE_SECONDS,
          },
        ],
        timestamp: nowIso(),
      },
      timestamp: nowIso(),
    },
  };
}

async function sampleBrowserActivity() {
  const values = await storageGet(STORAGE_KEYS.station);
  const station = values[STORAGE_KEYS.station];
  if (!station?.session?.token || !station.shiftActive || !station.consentAccepted || isStationStale(station)) {
    await saveStatus(getStatus(station));
    return;
  }

  try {
    const [tab, idleState, rules] = await Promise.all([queryActiveTab(), queryIdleState(), loadRules(station)]);
    const pageActivity = await readPageActivitySummary(tab);
    const event = buildActivityEvent(station, tab, idleState, pageActivity, rules);
    await postStationEvent(station, event);
    await clearPageActivity();
    await flushQueue(station);
    await saveStatus(getStatus(station, { lastSync: nowIso() }));
  } catch (error) {
    const pageActivity = await readPageActivitySummary(null);
    const fallbackEvent = buildActivityEvent(station, null, "unknown", pageActivity);
    await enqueue(fallbackEvent);
    await saveStatus(getStatus(station, { lastError: error?.message || "No se pudo sincronizar" }));
  }
}

function dataUrlToBlob(dataUrl) {
  const [meta, data] = dataUrl.split(",");
  const contentType = /data:(.*?);base64/.exec(meta)?.[1] || "image/png";
  const raw = atob(data);
  const bytes = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i += 1) bytes[i] = raw.charCodeAt(i);
  return new Blob([bytes], { type: contentType });
}

async function sha256Hex(blob) {
  const buffer = await blob.arrayBuffer();
  const hash = await crypto.subtle.digest("SHA-256", buffer);
  return [...new Uint8Array(hash)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function canAutoCapture(station) {
  return Boolean(
    station?.session?.token
    && station.shiftActive
    && station.consentAccepted
    && station.state?.status === WORKING_STATUS
    && !isStationStale(station),
  );
}

async function uploadVisibleTabCapture(options = {}) {
  const values = options.station ? {} : await storageGet(STORAGE_KEYS.station);
  const station = options.station || values[STORAGE_KEYS.station];
  if (!station?.session?.token) throw new Error("Abre la estacion web e inicia sesion primero.");

  const tab = await queryActiveTab();
  const rules = await loadRules(station);
  if (!normalizeTab(tab, rules).evidenceAllowed) {
    const error = new Error("La pestana activa no es un sitio de trabajo permitido; no se captura evidencia.");
    error.code = "UNLISTED_SITE";
    throw error;
  }
  // captureVisibleTab solo dibuja el contenido de la pestana: nunca el escritorio ni la barra de tareas.
  const dataUrl = await chrome.tabs.captureVisibleTab(tab?.windowId, { format: "png" });
  const blob = dataUrlToBlob(dataUrl);
  const sha = await sha256Hex(blob);
  const capturedAt = nowIso();
  const mode = options.mode || "manual";
  const form = new FormData();
  form.set("file", blob, `vyntra-browser-${mode}-${Date.now()}.png`);
  form.set("employee", station.session.employee?.full_name || station.session.email || "unknown");
  form.set("equipment", station.session.device?.name || "VYNTRA Browser");
  form.set("captured_at", capturedAt);
  form.set("sha256", sha);
  form.set("file_size", String(blob.size));
  form.set("agent_version", VERSION);
  form.set("monitor_count", "1");

  const response = await fetch(`${station.apiBase || "https://vyntralab.tech"}/api/evidence/upload`, {
    method: "POST",
    headers: { "X-Device-Token": station.session.token },
    body: form,
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  await sampleBrowserActivity();
  return { capturedAt, result: await response.json() };
}

async function autoCaptureVisibleTab() {
  const values = await storageGet([STORAGE_KEYS.station, STORAGE_KEYS.status]);
  const station = values[STORAGE_KEYS.station];
  if (!canAutoCapture(station)) {
    await saveStatus(getStatus(station));
    return;
  }

  const status = values[STORAGE_KEYS.status] || {};
  const lastCaptureAt = Date.parse(status.lastCapture || "");
  const captureIntervalMs = AUTO_CAPTURE_MINUTES * 60 * 1000;
  if (lastCaptureAt && Date.now() - lastCaptureAt < captureIntervalMs - 5000) return;

  try {
    const capture = await uploadVisibleTabCapture({ station, mode: "auto" });
    await saveStatus(getStatus(station, {
      lastCapture: capture.capturedAt,
      lastCaptureMode: "auto",
      lastError: null,
    }));
  } catch (error) {
    if (error?.code === "UNLISTED_SITE") {
      await saveStatus(getStatus(station, { lastCaptureSkipped: nowIso(), lastError: null }));
      return;
    }
    await saveStatus(getStatus(station, {
      lastError: `Captura automatica: ${error?.message || "no se pudo subir"}`,
    }));
  }
}

function ensureAlarms() {
  chrome.alarms.create(SAMPLE_ALARM, { periodInMinutes: 1 });
  chrome.alarms.create(AUTO_CAPTURE_ALARM, { periodInMinutes: AUTO_CAPTURE_MINUTES });
}

async function handleMessage(message, sender) {
  if (message?.type === "page_activity") {
    return recordPageActivity(message, sender);
  }

  if (message?.type === "station_sync") {
    const station = {
      ...message.payload,
      syncedAt: nowIso(),
    };
    await storageSet({ [STORAGE_KEYS.station]: station });
    loadRules(station, { force: true }).catch(() => undefined);
    const status = await saveStatus(getStatus(station, { lastSync: station.syncedAt }));
    return { ok: true, status };
  }

  if (message?.type === "station_clear") {
    await storageRemove([STORAGE_KEYS.station, STORAGE_KEYS.rules]);
    const status = await saveStatus(getStatus(null, { lastSync: null, lastError: null }));
    return { ok: true, status };
  }

  if (message?.type === "station_ping" || message?.type === "popup_status") {
    return { ok: true, status: await currentStatus() };
  }

  if (message?.type === "capture_visible_tab") {
    const capture = await uploadVisibleTabCapture({ mode: "manual" });
    const values = await storageGet(STORAGE_KEYS.station);
    const status = await saveStatus(getStatus(values[STORAGE_KEYS.station], {
      lastCapture: capture.capturedAt,
      lastCaptureMode: "manual",
      lastError: null,
    }));
    return { ok: true, result: capture.result, status };
  }

  if (message?.type === "sample_now") {
    await sampleBrowserActivity();
    return { ok: true, status: await currentStatus() };
  }

  return { ok: false, error: "Mensaje no soportado" };
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  handleMessage(message, sender)
    .then(sendResponse)
    .catch((error) => sendResponse({ ok: false, error: error?.message || "Error interno" }));
  return true;
});

chrome.runtime.onInstalled.addListener(() => {
  ensureAlarms();
});

chrome.runtime.onStartup.addListener(() => {
  ensureAlarms();
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === SAMPLE_ALARM) {
    sampleBrowserActivity().catch(() => undefined);
  }
  if (alarm.name === AUTO_CAPTURE_ALARM) {
    autoCaptureVisibleTab().catch(() => undefined);
  }
});

ensureAlarms();
