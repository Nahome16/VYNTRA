import { NextRequest, NextResponse } from "next/server";

/**
 * Content-Security-Policy con nonce por peticion.
 *
 * - Scripts: solo los que llevan el nonce (Next.js lo agrega a sus propios scripts
 *   y el layout lo pasa al script de preferencias de tema/idioma). Sin
 *   'unsafe-inline' para scripts.
 * - Estilos: 'unsafe-inline' porque la interfaz usa atributos style (anchos de
 *   barras, variables CSS) que no admiten nonce.
 * - connect-src 'self': el panel y la estacion solo llaman a /api/* del mismo
 *   origen (Next reenvia al backend con rewrites()). Origenes extra (si alguna vez
 *   se llama a la API en otro dominio) se agregan con VYNTRA_CSP_CONNECT_SRC.
 * - img-src incluye blob: para las capturas de evidencia (object URLs).
 */
function buildCsp(nonce: string) {
  const isDev = process.env.NODE_ENV === "development";
  const extraConnect = (process.env.VYNTRA_CSP_CONNECT_SRC || "").trim();
  const directives = [
    "default-src 'self'",
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'${isDev ? " 'unsafe-eval'" : ""}`,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' blob: data:",
    "font-src 'self' data:",
    `connect-src 'self'${isDev ? " ws: wss:" : ""}${extraConnect ? ` ${extraConnect}` : ""}`,
    "media-src 'self' blob:",
    "worker-src 'self' blob:",
    "manifest-src 'self'",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ];
  return directives.join("; ");
}

export function proxy(request: NextRequest) {
  const nonce = btoa(crypto.randomUUID());
  const csp = buildCsp(nonce);

  const requestHeaders = new Headers(request.headers);
  requestHeaders.set("x-nonce", nonce);
  requestHeaders.set("Content-Security-Policy", csp);

  const response = NextResponse.next({ request: { headers: requestHeaders } });
  response.headers.set("Content-Security-Policy", csp);
  return response;
}

export const config = {
  matcher: [
    {
      // Paginas HTML: se excluyen /api (proxy al backend), assets estaticos,
      // descargas publicas y archivos con extension.
      source: "/((?!api/|_next/static|_next/image|favicon.ico|extensions/|.*\\.[a-zA-Z0-9]+$).*)",
      missing: [
        { type: "header", key: "next-router-prefetch" },
        { type: "header", key: "purpose", value: "prefetch" },
      ],
    },
  ],
};
