const STORAGE_KEYS = {
  station: "vyntraStationBridge",
  stationToken: "vyntraStationToken",
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
const VERSION = "0.3.1";
const ACTIVE_STATUSES = new Set(["TRABAJANDO", "BREAK", "LUNCH"]);

// Build de desarrollo: manifest.dev.json declara version_name "<version>-dev" y
// agrega localhost. En produccion solo se aceptan los origenes de vyntralab.tech.
const IS_DEV_BUILD = /-dev$/.test(chrome.runtime.getManifest?.().version_name || "");
const PRODUCTION_STATION_ORIGINS = ["https://vyntralab.tech", "https://www.vyntralab.tech"];
const DEV_STATION_ORIGINS = ["http://localhost:3000", "http://localhost:3001"];
const STATION_ORIGINS = new Set(IS_DEV_BUILD ? [...PRODUCTION_STATION_ORIGINS, ...DEV_STATION_ORIGINS] : PRODUCTION_STATION_ORIGINS);
const DEFAULT_API_BASE = "https://vyntralab.tech";

// Cola local de eventos.
const MAX_QUEUE_EVENTS = 500;
const SEND_BATCH_SIZE = 50;
// Eventos de marcaje: nunca se descartan al recortar la cola.
const SHIFT_CRITICAL_EVENTS = new Set([
  "shift_started",
  "shift_finished",
  "shift_restored_by_admin",
  "break_started",
  "break_finished",
  "lunch_started",
  "lunch_finished",
  "overtime_requested",
  "overtime_started",
  "overtime_finished",
]);

// Politica de captura minima: la lista de sitios permitidos son las reglas de
// productividad de la empresa. La URL y el titulo literal de la pestana solo se
// usan en memoria para comparar; nunca se guardan ni se transmiten.
const BROWSER_EXECUTABLE = "browser-extension";
const UNLISTED_SITE_TITLE = "(sitio fuera de lista)";
const LISTED_APP_TITLE = "(aplicacion permitida)";
const MAX_IDENTIFIER_LENGTH = 120;
const RULES_MAX_AGE_MS = 30 * 60 * 1000;
const DOMAIN_PATTERN_RE = /^\.?[a-z0-9-]+(\.[a-z0-9-]+)+$/i;

// Contador de clics fuera de la estacion: solo en sitios productivos, mediante
// un content script dinamico registrado para esos dominios.
const PRODUCTIVE_SCRIPT_ID = "vyntra-productive-activity";

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

function getOrigin(url) {
  try {
    return new URL(url || "").origin;
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

// ---- token de la estacion ----------------------------------------------------
// El token se guarda en chrome.storage.session (memoria del navegador, no
// accesible para content scripts) cuando esta disponible; si no, en local.
function sessionStorageArea() {
  return chrome.storage?.session || null;
}

async function saveStation(station) {
  const token = station?.session?.token || "";
  const sessionArea = sessionStorageArea();
  if (sessionArea && station) {
    const { token: _omit, ...sessionWithoutToken } = station.session || {};
    await sessionArea.set({ [STORAGE_KEYS.stationToken]: token });
    await storageSet({ [STORAGE_KEYS.station]: { ...station, session: sessionWithoutToken } });
    return;
  }
  await storageSet({ [STORAGE_KEYS.station]: station });
}

async function loadStation() {
  const values = await storageGet(STORAGE_KEYS.station);
  const station = values[STORAGE_KEYS.station];
  if (!station) return null;
  const sessionArea = sessionStorageArea();
  if (!sessionArea) return station;
  const tokenValues = await sessionArea.get(STORAGE_KEYS.stationToken);
  const token = tokenValues[STORAGE_KEYS.stationToken] || station.session?.token || "";
  return { ...station, session: { ...(station.session || {}), token } };
}

async function clearStation() {
  await storageRemove([STORAGE_KEYS.station, STORAGE_KEYS.rules]);
  const sessionArea = sessionStorageArea();
  if (sessionArea) await sessionArea.remove(STORAGE_KEYS.stationToken);
}

// ---- validacion de origenes ------------------------------------------------
function isAllowedStationOrigin(origin) {
  return STATION_ORIGINS.has(String(origin || ""));
}

function isAllowedApiBase(apiBase) {
  return isAllowedStationOrigin(String(apiBase || "").replace(/\/+$/, ""));
}

function stationApiBase(station) {
  const apiBase = String(station?.apiBase || "").replace(/\/+$/, "");
  return isAllowedApiBase(apiBase) ? apiBase : DEFAULT_API_BASE;
}

function isFromThisExtension(sender) {
  return Boolean(sender) && sender.id === chrome.runtime.id;
}

function isFromExtensionPage(sender) {
  if (!isFromThisExtension(sender) || sender.tab) return false;
  const base = chrome.runtime.getURL("");
  return typeof sender.url === "string" && sender.url.startsWith(base);
}

function isFromStationPage(sender) {
  if (!isFromThisExtension(sender) || !sender.tab) return false;
  if (typeof sender.frameId === "number" && sender.frameId !== 0) return false;
  return isAllowedStationOrigin(getOrigin(sender.url));
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
  const values = await storageGet(STORAGE_KEYS.status);
  return values[STORAGE_KEYS.status] || getStatus(await loadStation());
}

function stationUrlPatterns() {
  return [...STATION_ORIGINS].map((origin) => `${origin}/estacion*`);
}

function notifyStationTabs(status) {
  chrome.tabs.query({ url: stationUrlPatterns() }).then((tabs) => {
    for (const tab of tabs) {
      if (tab.id) chrome.tabs.sendMessage(tab.id, { type: "extension_status", status }).catch(() => undefined);
    }
  }).catch(() => undefined);
}

// ---- cola de eventos (serializada) -----------------------------------------
// Mutex simple con cadena de promesas: enqueue y flush nunca se intercalan, asi
// que no se pierden eventos por lecturas/escrituras concurrentes del storage.
let queueChain = Promise.resolve();

function withQueueLock(task) {
  const run = queueChain.then(task, task);
  queueChain = run.catch(() => undefined);
  return run;
}

function isShiftCritical(event) {
  return SHIFT_CRITICAL_EVENTS.has(String(event?.tipo || ""));
}

// Recorta la cola descartando primero los eventos mas antiguos que no son de
// marcaje. Los eventos de marcaje nunca se descartan.
function trimQueue(queue, max = MAX_QUEUE_EVENTS) {
  if (queue.length <= max) return queue;
  let excess = queue.length - max;
  const kept = [];
  for (const event of queue) {
    if (excess > 0 && !isShiftCritical(event)) {
      excess -= 1;
      continue;
    }
    kept.push(event);
  }
  return kept;
}

function enqueue(events) {
  const list = Array.isArray(events) ? events : [events];
  return withQueueLock(async () => {
    const values = await storageGet(STORAGE_KEYS.queue);
    const queue = values[STORAGE_KEYS.queue] || [];
    await storageSet({ [STORAGE_KEYS.queue]: trimQueue([...queue, ...list]) });
  });
}

class TransientSendError extends Error {}

async function postStationEvents(station, events) {
  let response;
  try {
    response = await fetch(`${stationApiBase(station)}/api/agent/events`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Device-Token": station.session.token,
      },
      body: JSON.stringify({ events }),
    });
  } catch (error) {
    throw new TransientSendError(error?.message || "Sin conexion");
  }
  if ([400, 413, 422].includes(response.status)) {
    return { invalid: true, status: response.status };
  }
  if (!response.ok) throw new TransientSendError(`HTTP ${response.status}`);
  return response.json();
}

// Envia un lote y devuelve los ids resueltos (aceptados o rechazados por el servidor).
async function sendBatch(station, batch) {
  const result = await postStationEvents(station, batch);
  if (result?.invalid) {
    if (batch.length === 1) return new Set([batch[0].id]);
    const resolved = new Set();
    for (const event of batch) {
      for (const id of await sendBatch(station, [event])) resolved.add(id);
    }
    return resolved;
  }
  const resolved = new Set();
  for (const item of result?.accepted || []) if (item?.id) resolved.add(item.id);
  for (const item of result?.rejected || []) if (item?.id) resolved.add(item.id);
  return resolved;
}

function flushQueue(station) {
  return withQueueLock(async () => {
    const values = await storageGet(STORAGE_KEYS.queue);
    const queue = values[STORAGE_KEYS.queue] || [];
    if (!queue.length || !station?.session?.token) return { sent: 0, pending: queue.length };
    const resolved = new Set();
    let failure = null;
    for (let index = 0; index < queue.length; index += SEND_BATCH_SIZE) {
      try {
        for (const id of await sendBatch(station, queue.slice(index, index + SEND_BATCH_SIZE))) resolved.add(id);
      } catch (error) {
        failure = error;
        break;
      }
    }
    const pending = queue.filter((event) => !resolved.has(event.id));
    await storageSet({ [STORAGE_KEYS.queue]: pending });
    if (failure) throw failure;
    return { sent: resolved.size, pending: pending.length };
  });
}

// ---- reglas -----------------------------------------------------------------
async function loadRules(station, { force = false } = {}) {
  const values = await storageGet(STORAGE_KEYS.rules);
  const cached = values[STORAGE_KEYS.rules];
  const fresh = cached && Date.now() - Date.parse(cached.fetchedAt || "") < RULES_MAX_AGE_MS;
  if (!force && fresh) return cached.rules || [];
  if (!station?.session?.token) return cached?.rules || [];

  try {
    const response = await fetch(`${stationApiBase(station)}/api/agent/rules`, {
      headers: { "X-Device-Token": station.session.token },
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const data = await response.json();
    const rules = Array.isArray(data?.rules) ? data.rules : [];
    await storageSet({ [STORAGE_KEYS.rules]: { rules, fetchedAt: nowIso() } });
    await syncProductiveContentScript(rules);
    return rules;
  } catch {
    return cached?.rules || [];
  }
}

function isDomainPattern(pattern) {
  const value = String(pattern || "").trim();
  return Boolean(value) && !/\s/.test(value) && DOMAIN_PATTERN_RE.test(value);
}

// Un patron con forma de dominio coincide con el host exacto o con un subdominio
// (".salesforce.com" / "salesforce.com"), nunca como subcadena arbitraria.
function hostMatchesDomain(host, pattern) {
  const domain = String(pattern || "").trim().replace(/^\./, "").toLowerCase();
  const cleanHost = String(host || "").trim().replace(/\.$/, "").toLowerCase();
  if (!domain || !cleanHost) return false;
  return cleanHost === domain || cleanHost.endsWith(`.${domain}`);
}

function ruleMatchesTab(pattern, host, title) {
  if (isDomainPattern(pattern)) return hostMatchesDomain(host, pattern);
  const haystack = `${host} - ${title || ""}`.toLowerCase();
  return haystack.includes(String(pattern).toLowerCase());
}

// Devuelve el identificador normalizado de la pestana, si el sitio esta en la
// lista y si admite evidencia visual (solo sitios clasificados como productivos).
function normalizeTab(tab, rules) {
  const host = getHost(tab?.url || "");
  const title = tab?.title || "";
  const rank = (rule) => Number(rule.scope_score || 0) + Number(rule.priority || 0);
  let bestTitle = null;
  let bestAny = null;
  let executableMatch = false;
  for (const rule of rules || []) {
    const executable = String(rule?.executable_name || "").trim().toLowerCase();
    const pattern = String(rule?.title_contains || "").trim();
    if (!executable && !pattern) continue;
    if (executable && executable !== BROWSER_EXECUTABLE) continue;
    if (pattern && !ruleMatchesTab(pattern, host, title)) continue;
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

// Patrones de coincidencia para el content script dinamico: solo dominios de
// reglas productivas del navegador. Los patrones que no son dominio no pueden
// traducirse a hosts, asi que en esos sitios no se cuentan clics.
function productiveMatchPatterns(rules) {
  const patterns = new Set();
  for (const rule of rules || []) {
    if (rule?.classification !== "productive") continue;
    const executable = String(rule?.executable_name || "").trim().toLowerCase();
    if (executable && executable !== BROWSER_EXECUTABLE) continue;
    const pattern = String(rule?.title_contains || "").trim().toLowerCase();
    if (!pattern) {
      if (executable === BROWSER_EXECUTABLE) return ["http://*/*", "https://*/*"];
      continue;
    }
    if (!isDomainPattern(pattern)) continue;
    const domain = pattern.replace(/^\./, "");
    patterns.add(`*://${domain}/*`);
    patterns.add(`*://*.${domain}/*`);
  }
  return [...patterns].sort();
}

let registeredPatternsKey = null;

async function syncProductiveContentScript(rules) {
  const scripting = chrome.scripting;
  if (!scripting?.registerContentScripts) return;
  const matches = productiveMatchPatterns(rules);
  const key = matches.join("|");
  if (key === registeredPatternsKey) return;
  try {
    const existing = await scripting.getRegisteredContentScripts({ ids: [PRODUCTIVE_SCRIPT_ID] });
    if (!matches.length) {
      if (existing.length) await scripting.unregisterContentScripts({ ids: [PRODUCTIVE_SCRIPT_ID] });
    } else {
      const script = {
        id: PRODUCTIVE_SCRIPT_ID,
        matches,
        excludeMatches: stationUrlPatterns().map((pattern) => pattern.replace(/estacion\*$/, "*")),
        js: ["content-script.js"],
        runAt: "document_start",
        allFrames: false,
      };
      if (existing.length) {
        await scripting.updateContentScripts([script]);
      } else {
        await scripting.registerContentScripts([{ ...script, persistAcrossSessions: true }]);
      }
    }
    registeredPatternsKey = key;
  } catch (error) {
    registeredPatternsKey = null;
    console.warn("VYNTRA: no se pudo registrar el contador de sitios productivos", error);
  }
}

async function unregisterProductiveContentScript() {
  registeredPatternsKey = null;
  try {
    const existing = await chrome.scripting?.getRegisteredContentScripts?.({ ids: [PRODUCTIVE_SCRIPT_ID] });
    if (existing?.length) await chrome.scripting.unregisterContentScripts({ ids: [PRODUCTIVE_SCRIPT_ID] });
  } catch {
    // Sin permisos o API no disponible: no hay nada registrado.
  }
}

// ---- actividad de pagina ----------------------------------------------------
async function recordPageActivity(message, sender) {
  const station = await loadStation();
  if (!station?.session?.token || !station.shiftActive || !station.consentAccepted || isStationStale(station)) {
    return { ok: true, ignored: true };
  }
  if (!sender?.tab) return { ok: true, ignored: true };
  // Solo se cuentan clics en la estacion y en sitios clasificados como productivos.
  if (!isFromStationPage(sender)) {
    const rules = await loadRules(station);
    if (!normalizeTab(sender.tab, rules).evidenceAllowed) return { ok: true, ignored: true };
  }

  const values = await storageGet(STORAGE_KEYS.activity);
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
  const clicks = Math.max(0, Math.min(10000, Number(message.clicks || 0)));
  const focusChanges = Math.max(0, Math.min(10000, Number(message.focusChanges || 0)));
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
  const station = await loadStation();
  if (!station?.session?.token || !station.shiftActive || !station.consentAccepted || isStationStale(station)) {
    await saveStatus(getStatus(station));
    return;
  }

  let event;
  try {
    const [tab, idleState, rules] = await Promise.all([queryActiveTab(), queryIdleState(), loadRules(station)]);
    const pageActivity = await readPageActivitySummary(tab);
    event = buildActivityEvent(station, tab, idleState, pageActivity, rules);
  } catch {
    const pageActivity = await readPageActivitySummary(null);
    event = buildActivityEvent(station, null, "unknown", pageActivity);
  }
  // La muestra queda en la cola persistente antes de intentar enviarla.
  await enqueue(event);
  await clearPageActivity();
  try {
    await flushQueue(station);
    await saveStatus(getStatus(station, { lastSync: nowIso() }));
  } catch (error) {
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

function sameTab(before, after) {
  return Boolean(
    before && after
    && before.id === after.id
    && before.windowId === after.windowId
    && before.url === after.url,
  );
}

async function uploadVisibleTabCapture(options = {}) {
  const station = options.station || await loadStation();
  if (!station?.session?.token) throw new Error("Abre la estacion web e inicia sesion primero.");

  // 1) Reglas primero; 2) pestana activa; 3) decision; 4) captura;
  // 5) se vuelve a consultar la pestana activa y se descarta si cambio.
  const rules = await loadRules(station);
  const tab = await queryActiveTab();
  if (!tab || !normalizeTab(tab, rules).evidenceAllowed) {
    const error = new Error("La pestana activa no es un sitio de trabajo permitido; no se captura evidencia.");
    error.code = "UNLISTED_SITE";
    throw error;
  }
  // captureVisibleTab solo dibuja el contenido de la pestana: nunca el escritorio ni la barra de tareas.
  let dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, { format: "png" });
  const tabAfter = await queryActiveTab();
  if (!sameTab(tab, tabAfter) || !normalizeTab(tabAfter, rules).evidenceAllowed) {
    dataUrl = null;
    const error = new Error("La pestana activa cambio durante la captura; la imagen se descarto.");
    error.code = "TAB_CHANGED";
    throw error;
  }
  const blob = dataUrlToBlob(dataUrl);
  dataUrl = null;
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

  const response = await fetch(`${stationApiBase(station)}/api/evidence/upload`, {
    method: "POST",
    headers: { "X-Device-Token": station.session.token },
    body: form,
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  await sampleBrowserActivity();
  return { capturedAt, result: await response.json() };
}

async function autoCaptureVisibleTab() {
  const station = await loadStation();
  if (!canAutoCapture(station)) {
    await saveStatus(getStatus(station));
    return;
  }

  const values = await storageGet(STORAGE_KEYS.status);
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
    if (error?.code === "UNLISTED_SITE" || error?.code === "TAB_CHANGED") {
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

const NOT_ALLOWED = { ok: false, error: "Origen no permitido" };

async function handleMessage(message, sender) {
  if (message?.type === "page_activity") {
    if (!isFromThisExtension(sender) || !sender?.tab) return NOT_ALLOWED;
    return recordPageActivity(message, sender);
  }

  if (message?.type === "station_sync") {
    if (!isFromStationPage(sender)) return NOT_ALLOWED;
    const payload = message.payload && typeof message.payload === "object" ? message.payload : {};
    const senderOrigin = getOrigin(sender.url);
    const apiBase = String(payload.apiBase || "").replace(/\/+$/, "");
    if (!isAllowedApiBase(apiBase) || apiBase !== senderOrigin) {
      return { ok: false, error: "apiBase no permitido" };
    }
    const station = {
      ...payload,
      apiBase,
      syncedAt: nowIso(),
    };
    await saveStation(station);
    loadRules(station, { force: true }).catch(() => undefined);
    const status = await saveStatus(getStatus(station, { lastSync: station.syncedAt }));
    return { ok: true, status };
  }

  if (message?.type === "station_clear") {
    if (!isFromStationPage(sender)) return NOT_ALLOWED;
    await clearStation();
    await unregisterProductiveContentScript();
    const status = await saveStatus(getStatus(null, { lastSync: null, lastError: null }));
    return { ok: true, status };
  }

  if (message?.type === "station_ping") {
    if (!isFromStationPage(sender) && !isFromExtensionPage(sender)) return NOT_ALLOWED;
    return { ok: true, status: await currentStatus() };
  }

  if (message?.type === "popup_status") {
    if (!isFromExtensionPage(sender)) return NOT_ALLOWED;
    return { ok: true, status: await currentStatus() };
  }

  if (message?.type === "capture_visible_tab") {
    if (!isFromExtensionPage(sender)) return NOT_ALLOWED;
    const capture = await uploadVisibleTabCapture({ mode: "manual" });
    const status = await saveStatus(getStatus(await loadStation(), {
      lastCapture: capture.capturedAt,
      lastCaptureMode: "manual",
      lastError: null,
    }));
    return { ok: true, result: capture.result, status };
  }

  if (message?.type === "sample_now") {
    if (!isFromExtensionPage(sender)) return NOT_ALLOWED;
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
