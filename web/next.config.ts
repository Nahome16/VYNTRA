import type { NextConfig } from "next";

// Cabeceras de seguridad comunes a todas las respuestas del frontend. La
// Content-Security-Policy se agrega por peticion (con nonce) en src/proxy.ts.
const securityHeaders = [
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "X-Frame-Options", value: "DENY" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  {
    key: "Permissions-Policy",
    value: "camera=(), microphone=(), geolocation=(), payment=(), usb=(), display-capture=(), browsing-topics=()",
  },
];

const nextConfig: NextConfig = {
  devIndicators: false,
  output: "standalone",
  poweredByHeader: false,
  async headers() {
    return [
      {
        source: "/:path*",
        headers: securityHeaders,
      },
    ];
  },
  // Con output "standalone" este destino se fija durante `next build`:
  // VYNTRA_API_URL debe estar definido al construir (ver Dockerfile/README).
  async rewrites() {
    return [
      {
        source: "/api/:path*",
        destination: `${process.env.VYNTRA_API_URL || "http://localhost:8000"}/api/:path*`,
      },
    ];
  },
};

export default nextConfig;
