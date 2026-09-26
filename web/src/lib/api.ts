/**
 * Cliente HTTP comun del panel y de la estacion web.
 *
 * - Timeout por AbortController (por defecto 20 s).
 * - Errores tipados con ApiError: `status` HTTP (0 si no hubo respuesta),
 *   `kind` (http | network | timeout), `detail` del backend y `retryAfter`.
 */

export const DEFAULT_TIMEOUT_MS = 20_000;

export type ApiErrorKind = "http" | "network" | "timeout";

export class ApiError extends Error {
  readonly status: number;
  readonly kind: ApiErrorKind;
  readonly detail: string;
  /** Segundos sugeridos por el header Retry-After (429), si vino. */
  readonly retryAfter: number | null;

  constructor(status: number, options: { kind?: ApiErrorKind; detail?: string; retryAfter?: number | null } = {}) {
    const kind = options.kind || "http";
    super(kind === "http" ? `HTTP ${status}` : kind === "timeout" ? "Request timeout" : "Network error");
    this.name = "ApiError";
    this.status = status;
    this.kind = kind;
    this.detail = options.detail || "";
    this.retryAfter = options.retryAfter ?? null;
  }
}

export type RequestOptions = Omit<RequestInit, "headers"> & {
  headers?: Record<string, string>;
  /** Token Bearer del panel administrativo. */
  token?: string;
  /** Token de dispositivo de la estacion (header X-Device-Token). */
  deviceToken?: string;
  timeoutMs?: number;
};

function parseRetryAfter(value: string | null) {
  if (!value) return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.round(seconds);
  const date = Date.parse(value);
  if (Number.isFinite(date)) return Math.max(0, Math.round((date - Date.now()) / 1000));
  return null;
}

async function errorDetail(response: Response) {
  try {
    const payload = (await response.clone().json()) as { detail?: unknown };
    if (typeof payload?.detail === "string") return payload.detail;
  } catch {
    // Respuesta sin JSON.
  }
  return "";
}

/** fetch con timeout y cabeceras de autenticacion; lanza ApiError si falla. */
export async function apiFetch(path: string, options: RequestOptions = {}): Promise<Response> {
  const { token, deviceToken, timeoutMs = DEFAULT_TIMEOUT_MS, headers = {}, signal, ...init } = options;
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  const onExternalAbort = () => controller.abort();
  if (signal) {
    if (signal.aborted) controller.abort();
    else signal.addEventListener("abort", onExternalAbort, { once: true });
  }

  let response: Response;
  try {
    response = await fetch(path, {
      cache: "no-store",
      ...init,
      headers: {
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...(deviceToken ? { "X-Device-Token": deviceToken } : {}),
        ...headers,
      },
      signal: controller.signal,
    });
  } catch {
    throw new ApiError(0, { kind: timedOut ? "timeout" : "network" });
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", onExternalAbort);
  }

  if (!response.ok) {
    throw new ApiError(response.status, {
      detail: await errorDetail(response),
      retryAfter: parseRetryAfter(response.headers.get("Retry-After")),
    });
  }
  return response;
}

/** Peticion JSON (envia y recibe JSON). */
export async function requestJson<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const response = await apiFetch(path, {
    ...options,
    headers: { "Content-Type": "application/json", ...(options.headers || {}) },
  });
  if (response.status === 204) return undefined as T;
  try {
    return (await response.json()) as T;
  } catch {
    throw new ApiError(response.status, { kind: "http", detail: "Invalid JSON response" });
  }
}

export function isApiError(error: unknown): error is ApiError {
  return error instanceof ApiError;
}

export type LoginErrorKind = "credentials" | "rate_limited" | "server" | "network" | "unknown";

/** Clasifica un error de login para mostrar un mensaje adecuado. */
export function classifyLoginError(error: unknown): LoginErrorKind {
  if (!isApiError(error)) return "unknown";
  if (error.kind === "network" || error.kind === "timeout") return "network";
  if (error.status === 400 || error.status === 401 || error.status === 403 || error.status === 422) {
    return "credentials";
  }
  if (error.status === 429) return "rate_limited";
  if (error.status >= 500) return "server";
  return "unknown";
}

/** Minutos a esperar (redondeado hacia arriba) segun Retry-After, o null. */
export function retryAfterMinutes(error: unknown) {
  if (!isApiError(error) || !error.retryAfter) return null;
  return Math.max(1, Math.ceil(error.retryAfter / 60));
}
