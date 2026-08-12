"use client";

import { useEffect, useMemo, useState } from "react";
import { AppShell } from "@/components/app-shell";
import { EmptyState, Panel, RefreshButton, StatusLine } from "@/components/ui";
import { useAuth } from "@/components/auth-provider";
import { CatalogsResponse, ProductivityRule, UncategorizedItem } from "@/lib/types";
import { formatDuration } from "@/lib/format";

const sectionLabels = {
  reglas: "Reglas",
  accesos: "Accesos",
  usuarios: "Usuarios monitoreados",
} as const;

type SectionKey = keyof typeof sectionLabels;

function classificationLabel(value: string) {
  const labels: Record<string, string> = {
    productive: "Productiva",
    neutral: "Neutral",
    non_productive: "No productiva",
    uncategorized: "Sin clasificar",
  };
  return labels[value] || value;
}

export default function SettingsPage() {
  const { apiGet, user } = useAuth();
  const [activeSection, setActiveSection] = useState<SectionKey>("reglas");
  const [catalogs, setCatalogs] = useState<CatalogsResponse | null>(null);
  const [rules, setRules] = useState<ProductivityRule[]>([]);
  const [uncategorized, setUncategorized] = useState<UncategorizedItem[]>([]);
  const [statusText, setStatusText] = useState("");
  const [loading, setLoading] = useState(false);

  async function loadSettings() {
    setLoading(true);
    setStatusText("Actualizando ajustes...");
    try {
      const [nextCatalogs, nextRules, nextUncategorized] = await Promise.all([
        apiGet<CatalogsResponse>("/api/productivity/catalogs"),
        apiGet<{ rules: ProductivityRule[] }>("/api/productivity/rules"),
        apiGet<{ items: UncategorizedItem[] }>("/api/productivity/uncategorized?limit=12"),
      ]);
      setCatalogs(nextCatalogs);
      setRules(nextRules.rules);
      setUncategorized(nextUncategorized.items);
      setStatusText("Datos actualizados");
    } catch {
      setStatusText("No se pudieron cargar ajustes");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    if (user) void loadSettings();
  }, [user]);

  const activeRules = useMemo(() => rules.filter((rule) => rule.is_active), [rules]);
  const roleSummary = useMemo(
    () => [
      { name: "admin", scope: "Gestion completa de empresa" },
      { name: "rrhh", scope: "Personal, asistencia y evidencias" },
      { name: "supervisor", scope: "Equipo asignado y reporteria" },
      { name: "viewer", scope: "Solo lectura" },
    ],
    [],
  );

  return (
    <AppShell
      title="Ajustes"
      description={`${user?.company || "Empresa"} - reglas, accesos y usuarios monitoreados.`}
      actions={<RefreshButton loading={loading} onClick={loadSettings} />}
    >
      <div className="tabs">
        {(Object.keys(sectionLabels) as SectionKey[]).map((key) => (
          <button
            className={activeSection === key ? "active" : ""}
            key={key}
            onClick={() => setActiveSection(key)}
          >
            {sectionLabels[key]}
          </button>
        ))}
      </div>

      {activeSection === "reglas" ? (
        <section className="settings-grid">
          <Panel title="Reglas productivas" meta={`${activeRules.length} activas`} className="wide">
            {rules.length ? (
              <table>
                <thead>
                  <tr>
                    <th>App</th>
                    <th>Titulo contiene</th>
                    <th>Clasificacion</th>
                    <th>Alcance</th>
                    <th>Prioridad</th>
                  </tr>
                </thead>
                <tbody>
                  {rules.slice(0, 60).map((rule) => (
                    <tr key={rule.id}>
                      <td>{rule.executable_name || "*"}</td>
                      <td>{rule.title_contains || "*"}</td>
                      <td>
                        <span className={`badge badge-${rule.classification}`}>
                          {classificationLabel(rule.classification)}
                        </span>
                      </td>
                      <td>{rule.employee || rule.department || rule.position || "Empresa"}</td>
                      <td>{rule.priority}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : (
              <EmptyState>No hay reglas configuradas.</EmptyState>
            )}
          </Panel>

          <Panel title="Pendientes de clasificar" meta={`${uncategorized.length} patrones`}>
            <div className="stack">
              {uncategorized.length ? (
                uncategorized.map((item) => (
                  <article className="list-item" key={`${item.executable_name}-${item.title_text}`}>
                    <strong>{item.executable_name || "(desconocido)"}</strong>
                    <span>{item.title_text || "(sin titulo)"}</span>
                    <small>{formatDuration(item.seconds)} - {item.samples} muestras</small>
                  </article>
                ))
              ) : (
                <EmptyState>No hay actividad pendiente de clasificar.</EmptyState>
              )}
            </div>
          </Panel>
        </section>
      ) : null}

      {activeSection === "accesos" ? (
        <section className="settings-grid">
          <Panel title="Roles administrativos" meta="empresa actual" className="wide">
            <table>
              <thead>
                <tr>
                  <th>Rol</th>
                  <th>Alcance</th>
                  <th>Estado</th>
                </tr>
              </thead>
              <tbody>
                {roleSummary.map((role) => (
                  <tr key={role.name}>
                    <td>{role.name}</td>
                    <td>{role.scope}</td>
                    <td>Activo</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Panel>
          <Panel title="Sesion actual" meta={user?.role}>
            <div className="detail-list">
              <label>Usuario</label>
              <strong>{user?.full_name}</strong>
              <label>Correo</label>
              <span>{user?.email}</span>
              <label>Empresa</label>
              <span>{user?.company}</span>
            </div>
          </Panel>
        </section>
      ) : null}

      {activeSection === "usuarios" ? (
        <section className="settings-grid">
          <Panel title="Usuarios monitoreados" meta={`${catalogs?.employees.length || 0} empleados`} className="wide">
            {catalogs?.employees.length ? (
              <table>
                <thead>
                  <tr>
                    <th>Codigo</th>
                    <th>Empleado</th>
                    <th>Correo</th>
                    <th>Estado</th>
                  </tr>
                </thead>
                <tbody>
                  {catalogs.employees.map((employee) => (
                    <tr key={employee.id}>
                      <td>{employee.employee_code}</td>
                      <td>{employee.full_name}</td>
                      <td>{employee.email || "Sin correo"}</td>
                      <td>{employee.status}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : (
              <EmptyState>No hay usuarios monitoreados creados.</EmptyState>
            )}
          </Panel>
          <Panel title="Alta de usuario" meta="pendiente">
            <div className="compact-form">
              <label>Nombre</label>
              <input disabled placeholder="Empleado nuevo" />
              <label>Correo</label>
              <input disabled placeholder="empleado@empresa.com" />
              <button disabled>Crear usuario</button>
            </div>
          </Panel>
        </section>
      ) : null}

      <StatusLine>{statusText}</StatusLine>
    </AppShell>
  );
}
