import { apiFetch } from "@/lib/api";

/** Tiempo antes de liberar el object URL: revocarlo de inmediato puede cancelar la descarga en algunos navegadores. */
const REVOKE_DELAY_MS = 60_000;
/** Instaladores y reportes pueden tardar: timeout amplio para descargas. */
const DOWNLOAD_TIMEOUT_MS = 10 * 60_000;

/** Descarga un Blob en el navegador con el nombre indicado. */
export function saveBlob(blob: Blob, filename: string) {
  const url = window.URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.rel = "noopener";
  link.style.display = "none";
  document.body.appendChild(link);
  link.click();
  link.remove();
  window.setTimeout(() => window.URL.revokeObjectURL(url), REVOKE_DELAY_MS);
}

export async function downloadAuthenticatedFile(path: string, token: string, fallbackName: string) {
  const response = await apiFetch(path, { token, timeoutMs: DOWNLOAD_TIMEOUT_MS });
  const disposition = response.headers.get("Content-Disposition") || "";
  const match = disposition.match(/filename="?([^"]+)"?/i);
  const filename = match?.[1] || fallbackName;
  const blob = await response.blob();
  saveBlob(blob, filename);
}
