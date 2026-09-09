const STORAGE_KEYS = {
  station: "vyntraStationBridge",
  queue: "vyntraBrowserQueue",
  status: "vyntraBrowserStatus",
};

const SAMPLE_ALARM = "vyntra-browser-sample";
const SAMPLE_SECONDS = 60;
const STALE_STATION_MS = 10 * 60 * 1000;
const VERSION = "browser-extension-0.1.0";

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
  return {
    available: true,
    tracking,
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
  await storageSet({ [STORAGE_KEYS.status]: status });
  notifyStationTabs(status);
  return status;
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

async function uploadVisibleTabCapture() {
  const values = await storageGet(STORAGE_KEYS.station);
  const station = values[STORAGE_KEYS.station];
  if (!station?.session?.token) throw new Error("Abre la estacion web e inicia sesion primero.");

  const tab = await queryActiveTab();
  const dataUrl = await chrome.tabs.captureVisibleTab(tab?.windowId, { format: "png" });
  const blob = dataUrlToBlob(dataUrl);
  const sha = await sha256Hex(blob);
  const form = new FormData();
  form.set("file", blob, `vyntra-browser-${Date.now()}.png`);
  form.set("employee", station.session.employee?.full_name || station.session.email || "unknown");
  form.set("equipment", station.session.device?.name || "VYNTRA Browser");
  form.set("captured_at", nowIso());
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
  return response.json();
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
    const status = await saveStatus({ available: true, tracking: false, lastSync: null, lastError: null });
    return { ok: true, status };
  }

  if (message?.type === "station_ping" || message?.type === "popup_status") {
    return { ok: true, status: await currentStatus() };
  }

  if (message?.type === "capture_visible_tab") {
    const result = await uploadVisibleTabCapture();
    return { ok: true, result, status: await currentStatus() };
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
  chrome.alarms.create(SAMPLE_ALARM, { periodInMinutes: 1 });
});

chrome.runtime.onStartup.addListener(() => {
  chrome.alarms.create(SAMPLE_ALARM, { periodInMinutes: 1 });
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === SAMPLE_ALARM) {
    sampleBrowserActivity().catch(() => undefined);
  }
});
