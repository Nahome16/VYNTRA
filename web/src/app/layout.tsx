import type { Metadata, Viewport } from "next";
import { Figtree, IBM_Plex_Mono } from "next/font/google";
import { AuthProvider } from "@/components/auth-provider";
import { PreferencesProvider } from "@/components/preferences-provider";
import { PREFERENCES_BOOT_SCRIPT } from "@/lib/i18n";
import "./globals.css";

const sans = Figtree({
  subsets: ["latin"],
  variable: "--font-sans",
  display: "swap",
});

const mono = IBM_Plex_Mono({
  subsets: ["latin"],
  weight: ["400", "500", "600"],
  variable: "--font-mono",
  display: "swap",
});

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
      className={`h-full antialiased ${sans.variable} ${mono.variable}`}
    >
      <head>
        <script dangerouslySetInnerHTML={{ __html: PREFERENCES_BOOT_SCRIPT }} />
      </head>
      <body className="min-h-full flex flex-col">
        <PreferencesProvider>
          <AuthProvider>{children}</AuthProvider>
        </PreferencesProvider>
      </body>
    </html>
  );
}
