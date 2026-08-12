"use client";

import { FormEvent, useMemo, useState } from "react";

type AdminUser = {
  email: string;
  full_name: string;
  role: string;
  company: string;
};

type DashboardTotals = {
  total_seconds: number;
  active_seconds: number;
  productive_seconds: number;
  neutral_seconds: number;
  non_productive_seconds: number;
  uncategorized_seconds: number;
  idle_seconds: number;
  break_seconds: number;
  lunch_seconds: number;
  productivity_pct: number;
  acceptable_pct: number;
  non_productive_pct: number;
  neutral_pct: number;
  uncategorized_pct: number;
  idle_pct: number;
};

type DashboardDay = {
  block_date: string;
  total_seconds: number;
  active_seconds: number;
  productive_seconds: number;
  neutral_seconds: number;
  non_productive_seconds: number;
  uncategorized_seconds: number;
  idle_seconds: number;
  break_seconds: number;
  lunch_seconds: number;
  productivity_pct: number;
  acceptable_pct: number;
  idle_pct: number;
  break_pct: number;
  lunch_pct: number;
};

type DashboardResponse = {
  company: { id: string; name: string };
  totals: DashboardTotals;
  days: DashboardDay[];
};

type UncategorizedItem = {
  executable_name: string;
  title_text: string;
  samples: number;
  seconds: number;
};

type CatalogsResponse = {
  departments: { id: string; name: string; status: string }[];
  employees: { id: string; full_name: string; employee_code: string; status: string }[];
};

const apiBaseUrl = process.env.NEXT_PUBLIC_API_BASE_URL || "";

function formatDuration(seconds: number) {
  const total = Math.max(0, Math.round(seconds || 0));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  if (hours > 0) return `${hours}h ${minutes}m`;
  return `${minutes}m`;
}

function formatPercent(part: number, whole: number) {
  if (!whole) return "0%";
  return `${Math.round((part / whole) * 1000) / 10}%`;
}

function metricTone(value: number) {
  if (value >= 85) return "good";
  if (value >= 65) return "warn";
  return "bad";
}

function Stat({
  label,
  value,
  detail,
  tone = "plain",
}: {
  label: string;
  value: string;
  detail: string;
  tone?: "plain" | "good" | "warn" | "bad";
}) {
  return (
    <section className={`stat stat-${tone}`}>
      <span>{label}</span>
      <strong>{value}</strong>
      <small>{detail}</small>
    </section>
  );
}

export default function Home() {
  const [email, setEmail] = useState("admin@vyntra.local");
  const [password, setPassword] = useState("Vyntra2026");
  const [token, setToken] = useState("");
  const [user, setUser] = useState<AdminUser | null>(null);
  const [dashboard, setDashboard] = useState<DashboardResponse | null>(null);
  const [uncategorized, setUncategorized] = useState<UncategorizedItem[]>([]);
  const [catalogs, setCatalogs] = useState<CatalogsResponse | null>(null);
  const [statusText, setStatusText] = useState("");
  const [loading, setLoading] = useState(false);

  const totals = dashboard?.totals;
  const topDays = useMemo(() => dashboard?.days.slice(-7).reverse() || [], [dashboard]);

  async function apiGet<T>(path: string, authToken = token): Promise<T> {
    const response = await fetch(`${apiBaseUrl}${path}`, {
      headers: { Authorization: `Bearer ${authToken}` },
      cache: "no-store",
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return response.json();
  }

  async function loadPanel(authToken: string) {
    const [nextDashboard, nextUncategorized, nextCatalogs] = await Promise.all([
      apiGet<DashboardResponse>("/api/productivity/dashboard", authToken),
      apiGet<{ items: UncategorizedItem[] }>("/api/productivity/uncategorized?limit=8", authToken),
      apiGet<CatalogsResponse>("/api/productivity/catalogs", authToken),
    ]);
    setDashboard(nextDashboard);
    setUncategorized(nextUncategorized.items);
    setCatalogs(nextCatalogs);
  }

  async function handleLogin(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setLoading(true);
    setStatusText("Validando credenciales...");
    try {
      const response = await fetch(`${apiBaseUrl}/api/admin/login`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, password }),
      });
      if (!response.ok) throw new Error("Credenciales incorrectas");
      const payload = await response.json();
      setToken(payload.access_token);
      setUser(payload.user);
      await loadPanel(payload.access_token);
      setStatusText("Sesion activa");
    } catch (error) {
      setStatusText(error instanceof Error ? error.message : "No se pudo iniciar sesion");
    } finally {
      setLoading(false);
    }
  }

  async function refreshPanel() {
    if (!token) return;
    setLoading(true);
    setStatusText("Actualizando datos...");
    try {
      await loadPanel(token);
      setStatusText("Datos actualizados");
    } catch {
      setStatusText("No se pudieron actualizar los datos");
    } finally {
      setLoading(false);
    }
  }

  if (!user || !totals) {
    return (
      <main className="login-shell">
        <section className="login-panel">
          <div className="brand-mark">V</div>
          <h1>VYNTRA Control</h1>
          <p>Ingreso administrativo para revisar productividad, actividad y reglas de clasificacion.</p>
          <form onSubmit={handleLogin} className="login-form">
            <label>
              Correo
              <input value={email} onChange={(event) => setEmail(event.target.value)} />
            </label>
            <label>
              Contrasena
              <input
                type="password"
                value={password}
                onChange={(event) => setPassword(event.target.value)}
              />
            </label>
            <button type="submit" disabled={loading}>
              {loading ? "Validando..." : "Iniciar sesion"}
            </button>
          </form>
          <span className="status-line">{statusText || `API: ${apiBaseUrl}`}</span>
        </section>
      </main>
    );
  }

  return (
    <main className="app-shell">
      <aside className="sidebar">
        <div className="brand-row">
          <div className="brand-mark">V</div>
          <div>
            <strong>VYNTRA</strong>
            <span>Control</span>
          </div>
        </div>
        <nav>
          <a className="active">Dashboard</a>
          <a>Reglas</a>
          <a>Evidencias</a>
          <a>Empleados</a>
        </nav>
        <div className="user-box">
          <span>{user.company}</span>
          <strong>{user.full_name}</strong>
          <small>{user.email} - {user.role}</small>
        </div>
      </aside>

      <section className="content">
        <header className="topbar">
          <div>
            <h1>Panel de productividad</h1>
            <p>{dashboard.company.name} - datos calculados desde actividad real del agente.</p>
          </div>
          <button className="secondary-button" onClick={refreshPanel} disabled={loading}>
            {loading ? "Actualizando" : "Actualizar"}
          </button>
        </header>

        <section className="stats-grid">
          <Stat
            label="Productividad"
            value={`${totals.productivity_pct}%`}
            detail={`${formatDuration(totals.productive_seconds)} productivo`}
            tone={metricTone(totals.productivity_pct)}
          />
          <Stat
            label="Aceptable"
            value={`${totals.acceptable_pct}%`}
            detail="Productivo + neutral"
            tone={metricTone(totals.acceptable_pct)}
          />
          <Stat
            label="No productivo"
            value={`${totals.non_productive_pct}%`}
            detail={formatDuration(totals.non_productive_seconds)}
            tone={totals.non_productive_pct > 12 ? "bad" : "plain"}
          />
          <Stat
            label="Idle"
            value={`${totals.idle_pct}%`}
            detail={formatDuration(totals.idle_seconds)}
            tone={totals.idle_pct > 15 ? "warn" : "plain"}
          />
        </section>

        <section className="work-grid">
          <div className="panel wide">
            <div className="panel-title">
              <h2>Resumen diario</h2>
              <span>{formatDuration(totals.active_seconds)} activos</span>
            </div>
            <table>
              <thead>
                <tr>
                  <th>Fecha</th>
                  <th>Activo</th>
                  <th>Productivo</th>
                  <th>Neutral</th>
                  <th>No productivo</th>
                  <th>Break</th>
                  <th>Lunch</th>
                </tr>
              </thead>
              <tbody>
                {topDays.map((day) => (
                  <tr key={day.block_date}>
                    <td>{day.block_date}</td>
                    <td>{formatDuration(day.active_seconds)}</td>
                    <td>{day.productivity_pct}%</td>
                    <td>{formatPercent(day.neutral_seconds, day.active_seconds)}</td>
                    <td>{formatDuration(day.non_productive_seconds)}</td>
                    <td>{formatDuration(day.break_seconds)}</td>
                    <td>{formatDuration(day.lunch_seconds)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div className="panel">
            <div className="panel-title">
              <h2>Sin categorizar</h2>
              <span>{totals.uncategorized_pct}%</span>
            </div>
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
                <p className="empty">No hay actividad pendiente de clasificar.</p>
              )}
            </div>
          </div>

          <div className="panel">
            <div className="panel-title">
              <h2>Organizacion</h2>
              <span>{catalogs?.employees.length || 0} empleados</span>
            </div>
            <div className="chips">
              {catalogs?.departments.map((department) => (
                <span key={department.id}>{department.name}</span>
              ))}
            </div>
          </div>
        </section>
        <span className="status-line">{statusText}</span>
      </section>
    </main>
  );
}
