import type { Metadata, Viewport } from "next";
import { headers } from "next/headers";
import Script from "next/script";
import { AuthProvider } from "@/components/auth-provider";
import { PreferencesProvider } from "@/components/preferences-provider";
import { RouteGuard } from "@/components/route-guard";
import { PREFERENCES_BOOT_SCRIPT } from "@/lib/i18n";
import "./globals.css";

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
  themeColor: "#ffffff",
};

export const metadata: Metadata = {
  title: "VYNTRA Control",
  description: "Panel administrativo de productividad y control operativo VYNTRA.",
};

export default async function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  // Nonce de la Content-Security-Policy generado en src/proxy.ts. Leer las
  // cabeceras hace que las paginas se rendericen por peticion (requisito del nonce).
  const nonce = (await headers()).get("x-nonce") || undefined;
  return (
    <html
      lang="es"
      data-theme="light"
      suppressHydrationWarning
      className="h-full antialiased"
    >
      <head>
        <Script id="vyntra-preferences" strategy="beforeInteractive" nonce={nonce}>
          {PREFERENCES_BOOT_SCRIPT}
        </Script>
      </head>
      <body className="min-h-full flex flex-col">
        <PreferencesProvider>
          <AuthProvider>
            <RouteGuard>{children}</RouteGuard>
          </AuthProvider>
        </PreferencesProvider>
      </body>
    </html>
  );
}
