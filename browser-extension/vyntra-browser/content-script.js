// Se inyecta estaticamente solo en la estacion web (vyntralab.tech) y, de forma
// dinamica, en los dominios que las reglas de la empresa clasifican como
// productivos (ver productiveMatchPatterns en background.js). Solo cuenta clics
// y cambios de foco; nunca lee teclas, formularios ni contenido de la pagina.
(() => {
  if (window.__vyntraContentScriptLoaded) return;
  window.__vyntraContentScriptLoaded = true;

  const manifest = chrome.runtime.getManifest ? chrome.runtime.getManifest() : {};
  const isDevBuild = /-dev$/.test(manifest.version_name || "");
  const allowedOrigins = new Set([
    "https://vyntralab.tech",
    "https://www.vyntralab.tech",
    ...(isDevBuild ? ["http://localhost:3000", "http://localhost:3001"] : []),
  ]);
  const isStationPage = allowedOrigins.has(window.location.origin);

  const pageActivity = {
    clicks: 0,
    focusChanges: 0,
    lastInteractionAt: null,
  };
  let activityFlushTimer = null;

  function canTrackPageActivity() {
    return window.location.protocol === "http:" || window.location.protocol === "https:";
  }

  function flushPageActivity() {
    if (!canTrackPageActivity()) return;
    if (!pageActivity.clicks && !pageActivity.focusChanges) return;
    const payload = {
      type: "page_activity",
      clicks: pageActivity.clicks,
      focusChanges: pageActivity.focusChanges,
      lastInteractionAt: pageActivity.lastInteractionAt,
    };
    pageActivity.clicks = 0;
    pageActivity.focusChanges = 0;
    try {
      chrome.runtime.sendMessage(payload, () => void chrome.runtime.lastError);
    } catch {
      // La extension se actualizo o recargo: este script quedo huerfano.
    }
  }

  function scheduleActivityFlush() {
    if (activityFlushTimer) return;
    activityFlushTimer = window.setTimeout(() => {
      activityFlushTimer = null;
      flushPageActivity();
    }, 5000);
  }

  function markInteraction(kind) {
    if (!canTrackPageActivity()) return;
    if (kind === "click") pageActivity.clicks += 1;
    if (kind === "focus") pageActivity.focusChanges += 1;
    pageActivity.lastInteractionAt = new Date().toISOString();
    scheduleActivityFlush();
  }

  function postStatus(status) {
    window.postMessage({
      type: "VYNTRA_EXTENSION_STATUS",
      available: true,
      tracking: Boolean(status?.tracking),
      extensionVersion: status?.extensionVersion || null,
      lastSync: status?.lastSync || null,
      lastError: status?.lastError || null,
    }, window.location.origin);
  }

  window.addEventListener("click", () => markInteraction("click"), { capture: true, passive: true });
  window.addEventListener("focus", () => markInteraction("focus"));
  document.addEventListener("visibilitychange", () => markInteraction("focus"));
  window.addEventListener("pagehide", flushPageActivity);

  if (!isStationPage) return;

  // Puente con la estacion web: solo en los origenes de VYNTRA.
  chrome.runtime.onMessage.addListener((message) => {
    if (message?.type === "extension_status") {
      postStatus(message.status);
    }
  });

  window.addEventListener("message", (event) => {
    if (event.source !== window || !allowedOrigins.has(event.origin)) return;
    const message = event.data;
    if (!message || typeof message !== "object") return;

    if (message.type === "VYNTRA_STATION_PING") {
      chrome.runtime.sendMessage({ type: "station_ping" }, (response) => {
        postStatus(response?.status);
      });
      return;
    }

    if (message.type === "VYNTRA_STATION_SYNC") {
      chrome.runtime.sendMessage({ type: "station_sync", payload: message }, (response) => {
        postStatus(response?.status);
      });
      return;
    }

    if (message.type === "VYNTRA_STATION_CLEAR") {
      chrome.runtime.sendMessage({ type: "station_clear" }, (response) => {
        postStatus(response?.status);
      });
    }
  });
})();
