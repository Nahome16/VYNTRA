"use client";

import { ReactNode } from "react";
import { usePathname } from "next/navigation";
import { AppShell } from "@/components/app-shell";
import { useAuth } from "@/components/auth-provider";
import { usePreferences } from "@/components/preferences-provider";
import { EmptyState, Panel } from "@/components/ui";
import { hasPermission, requiredPermissionFor } from "@/lib/permissions";

/**
 * Bloquea las rutas del panel para las que el rol no tiene permiso. Se monta en el
 * layout raiz, por encima de cada pagina, para que la pagina ni siquiera se
 * monte (y por tanto no llame a APIs que responderian 403).
 */
export function RouteGuard({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const { ready, user } = useAuth();
  const { t } = usePreferences();
  const permission = requiredPermissionFor(pathname);

  if (!permission || !ready || !user || hasPermission(user.permissions, permission)) {
    return <>{children}</>;
  }

  return (
    <AppShell title={t("Acceso restringido")} description={`${user.company || ""}`}>
      <Panel title={t("Acceso restringido")}>
        <EmptyState>{t("Tu rol no tiene permiso para ver esta seccion.")}</EmptyState>
      </Panel>
    </AppShell>
  );
}
