import type { Metadata, Viewport } from "next";
import Script from "next/script";
import { AuthProvider } from "@/components/auth-provider";
import { PreferencesProvider } from "@/components/preferences-provider";
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

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html
      lang="es"
      data-theme="light"
      suppressHydrationWarning
      className="h-full antialiased"
    >
      <head>
        <Script id="vyntra-preferences" strategy="beforeInteractive">
          {PREFERENCES_BOOT_SCRIPT}
        </Script>
      </head>
      <body className="min-h-full flex flex-col">
        <PreferencesProvider>
          <AuthProvider>{children}</AuthProvider>
        </PreferencesProvider>
      </body>
    </html>
  );
}
