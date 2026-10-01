"use client";

import { AppShell } from "@/components/app-shell";
import { IncidentsPanel } from "@/components/incidents-panel";
import { usePreferences } from "@/components/preferences-provider";

export default function IncidentsPage() {
  const { t } = usePreferences();
  return (
    <AppShell
      title={t("Incidencias")}
      description={t("Bandeja diaria para revisar solicitudes, evidencias y ajustes de tiempo.")}
    >
      <IncidentsPanel />
    </AppShell>
  );
}
