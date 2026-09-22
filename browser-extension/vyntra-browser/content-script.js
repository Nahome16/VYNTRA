const allowedOrigins = new Set([
  "https://vyntralab.tech",
  "https://www.vyntralab.tech",
  "http://localhost:3000",
  "http://localhost:3001",
]);

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
    url: window.location.href,
    title: document.title,
  };
  pageActivity.clicks = 0;
  pageActivity.focusChanges = 0;
  chrome.runtime.sendMessage(payload, () => undefined);
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

chrome.runtime.onMessage.addListener((message) => {
  if (message?.type === "extension_status") {
    postStatus(message.status);
  }
});

window.addEventListener("click", () => markInteraction("click"), { capture: true, passive: true });
window.addEventListener("focus", () => markInteraction("focus"));
document.addEventListener("visibilitychange", () => markInteraction("focus"));
window.addEventListener("pagehide", flushPageActivity);

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
