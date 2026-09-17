const STORAGE_KEYS = {
  station: "vyntraStationBridge",
  queue: "vyntraBrowserQueue",
  status: "vyntraBrowserStatus",
};

const SAMPLE_ALARM = "vyntra-browser-sample";
const AUTO_CAPTURE_ALARM = "vyntra-browser-auto-capture";
const SAMPLE_SECONDS = 60;
const AUTO_CAPTURE_MINUTES = 5;
const STALE_STATION_MS = 10 * 60 * 1000;
const WORKING_STATUS = "TRABAJANDO";
const VERSION = "browser-extension-0.2.0";

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

function isStationStale(station) {
  const syncedAt = Date.parse(station?.syncedAt || "");
  return !syncedAt || Date.now() - syncedAt > STALE_STATION_MS;
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

function buildActivityEvent(station, tab, idleState) {
  const url = tab?.url || "";
  const domain = getHost(url);
  const title = tab?.title || domain || "Pestana activa";
  const isIdle = idleState !== "active";
  const basePayload = station.snapshot && typeof station.snapshot === "object" ? station.snapshot : {};
  return {
    id: eventId(),
    tipo: "browser_activity_snapshot",
    created_at: nowIso(),
    payload: {
      ...basePayload,
      estado: station.state?.status || basePayload.estado || "TRABAJANDO",
      browser_extension: true,
      extension_version: VERSION,
      recurso_actual: domain || title,
      url_actual: url,
      titulo_actual: title,
      idle_estado_navegador: idleState,
      telemetria: {
        ...(basePayload.telemetria || {}),
        origen: "browser_extension",
        muestras_recientes: [
          {
            timestamp: nowIso(),
            proceso: "browser-extension",
            titulo: domain ? `${domain} - ${title}` : title,
            url,
            dominio: domain,
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
    const [tab, idleState] = await Promise.all([queryActiveTab(), queryIdleState()]);
    const event = buildActivityEvent(station, tab, idleState);
    await postStationEvent(station, event);
    await flushQueue(station);
    await saveStatus(getStatus(station, { lastSync: nowIso() }));
  } catch (error) {
    const fallbackEvent = buildActivityEvent(station, null, "unknown");
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
    await saveStatus(getStatus(station, {
      lastError: `Captura automatica: ${error?.message || "no se pudo subir"}`,
    }));
  }
}

function ensureAlarms() {
  chrome.alarms.create(SAMPLE_ALARM, { periodInMinutes: 1 });
  chrome.alarms.create(AUTO_CAPTURE_ALARM, { periodInMinutes: AUTO_CAPTURE_MINUTES });
}

async function handleMessage(message) {
  if (message?.type === "station_sync") {
    const station = {
      ...message.payload,
      syncedAt: nowIso(),
    };
    await storageSet({ [STORAGE_KEYS.station]: station });
    const status = await saveStatus(getStatus(station, { lastSync: station.syncedAt }));
    return { ok: true, status };
  }

  if (message?.type === "station_clear") {
    await storageRemove(STORAGE_KEYS.station);
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

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  handleMessage(message)
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
