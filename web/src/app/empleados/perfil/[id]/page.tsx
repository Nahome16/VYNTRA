"use client";

import Link from "next/link";
import { useParams, useSearchParams } from "next/navigation";
import { AppShell } from "@/components/app-shell";
import { EmployeeProfile } from "@/components/employee-profile";
import { useAuth } from "@/components/auth-provider";
import { usePreferences } from "@/components/preferences-provider";

export default function EmployeeProfilePage() {
  const params = useParams<{ id: string }>();
  const searchParams = useSearchParams();
  const { user, activeCompanyName } = useAuth();
  const { t } = usePreferences();
  const dateFrom = searchParams.get("date_from") || undefined;
  const dateTo = searchParams.get("date_to") || undefined;
  const companyName = (user?.role === "system_admin" ? activeCompanyName : "") || user?.company || t("Empresa");

  return (
    <AppShell
      title={t("Perfil empleado")}
      description={`${companyName} · ${t("ficha, actividad, productividad y evidencias del usuario.")}`}
      actions={(
        <Link href="/empleados" className="btn btn-ghost">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
            <path d="M19 12H5M11 18l-6-6 6-6" />
          </svg>
          <span>{t("Empleados")}</span>
        </Link>
      )}
    >
      <EmployeeProfile employeeId={params.id} initialDateFrom={dateFrom} initialDateTo={dateTo} />
    </AppShell>
  );
}
