const trackingEl = document.getElementById("tracking");
const stateEl = document.getElementById("state");
const versionEl = document.getElementById("version");
const lastSyncEl = document.getElementById("lastSync");
const autoCaptureEl = document.getElementById("autoCapture");
const lastCaptureEl = document.getElementById("lastCapture");
const messageEl = document.getElementById("message");
const sampleButton = document.getElementById("sampleNow");
const captureButton = document.getElementById("capture");

function send(message) {
  return chrome.runtime.sendMessage(message);
}

function fmtDate(value) {
  if (!value) return "--";
  try {
    return new Date(value).toLocaleTimeString("es-NI", { hour: "2-digit", minute: "2-digit" });
  } catch {
    return "--";
  }
}

function render(status) {
  const tracking = Boolean(status?.tracking);
  const autoCapture = Boolean(status?.autoCaptureEnabled);
  trackingEl.textContent = tracking ? "Navegador activo" : "En espera";
  stateEl.textContent = tracking ? "Conectada a estacion" : "Abre la estacion web";
  versionEl.textContent = status?.extensionVersion || "--";
  lastSyncEl.textContent = fmtDate(status?.lastSync);
  autoCaptureEl.textContent = autoCapture ? `Cada ${status.autoCaptureMinutes || 5} min` : "Pausada";
  lastCaptureEl.textContent = fmtDate(status?.lastCapture);
  messageEl.textContent = status?.lastError || "";
}

async function loadStatus() {
  const response = await send({ type: "popup_status" });
  render(response?.status);
}

async function runAction(button, message, successText) {
  button.disabled = true;
  messageEl.textContent = message;
  try {
    const response = await send(button === captureButton ? { type: "capture_visible_tab" } : { type: "sample_now" });
    if (!response?.ok) throw new Error(response?.error || "No se pudo completar");
    render(response.status);
    messageEl.textContent = successText;
  } catch (error) {
    messageEl.textContent = error?.message || "No se pudo completar";
  } finally {
    button.disabled = false;
  }
}

sampleButton.addEventListener("click", () => {
  runAction(sampleButton, "Sincronizando actividad...", "Actividad enviada.");
});

captureButton.addEventListener("click", () => {
  runAction(captureButton, "Capturando pestana activa...", "Captura enviada al portal.");
});

loadStatus().catch(() => {
  messageEl.textContent = "No se pudo leer el estado.";
});
