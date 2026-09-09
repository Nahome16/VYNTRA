const allowedOrigins = new Set([
  "https://vyntralab.tech",
  "https://www.vyntralab.tech",
  "http://localhost:3000",
  "http://localhost:3001",
]);

function postStatus(status) {
  window.postMessage({
    type: "VYNTRA_EXTENSION_STATUS",
    available: true,
    tracking: Boolean(status?.tracking),
    lastSync: status?.lastSync || null,
    lastError: status?.lastError || null,
  }, window.location.origin);
}

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
