"use client";

import { useParams, useSearchParams } from "next/navigation";
import { AppShell } from "@/components/app-shell";
import { EmployeeProfile } from "@/components/employee-profile";
import { useAuth } from "@/components/auth-provider";

export default function EmployeeProfilePage() {
  const params = useParams<{ id: string }>();
  const searchParams = useSearchParams();
  const { user } = useAuth();

  return (
    <AppShell
      title="Perfil empleado"
      description={`${user?.company || "Empresa"} - ficha, actividad, productividad y evidencias del usuario.`}
    >
      <EmployeeProfile
        employeeId={params.id}
        initialDateFrom={searchParams.get("date_from") || undefined}
        initialDateTo={searchParams.get("date_to") || undefined}
      />
    </AppShell>
  );
}
