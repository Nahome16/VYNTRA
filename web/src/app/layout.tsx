import type { Metadata, Viewport } from "next";
import { headers } from "next/headers";
import Script from "next/script";
import { AuthProvider } from "@/components/auth-provider";
import { PreferencesProvider } from "@/components/preferences-provider";
import { RouteGuard } from "@/components/route-guard";
import { PREFERENCES_BOOT_SCRIPT } from "@/lib/i18n";
import "./globals.css";
import "./design-system.css";

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
  themeColor: "#f6f7f9",
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
      <head suppressHydrationWarning>
        {/* El navegador oculta el atributo nonce tras cargar la pagina, por eso
            se suprime el aviso de hidratacion de este script. */}
        <Script
          id="vyntra-preferences"
          nonce={nonce}
          strategy="beforeInteractive"
          suppressHydrationWarning
          dangerouslySetInnerHTML={{ __html: PREFERENCES_BOOT_SCRIPT }}
        />
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
