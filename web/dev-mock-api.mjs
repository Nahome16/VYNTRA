import http from "node:http";
import { randomUUID } from "node:crypto";

const port = Number(process.env.PORT || 8000);

const allPermissions = [
  "system:manage",
  "dashboard:read",
  "devices:read",
  "devices:manage",
  "employees:read",
  "employees:manage",
  "attendance:read",
  "attendance:manage",
  "incidents:read",
  "incidents:resolve",
  "settings:manage",
  "rules:read",
  "rules:manage",
  "access_codes:read",
  "access_codes:manage",
  "audit:read",
];

const companyBase = { id: "cmp-vyntra-demo", name: "Vyntra Demo" };

const companies = [
  {
    ...companyBase,
    legal_name: "Vyntra Demo S.A.",
    status: "active",
    timezone: "America/Managua",
    created_at: "2026-08-20T08:00:00Z",
    employees_count: 7,
    users_count: 2,
    devices_count: 2,
    controls: {
      employee_limit: 7,
      subscription_status: "trial",
      subscription_ends_at: "2026-09-05",
      admin_notice: "Tu suscripcion vence pronto. Contacta al proveedor del sistema.",
    },
  },
  {
    id: "cmp-norte",
    name: "Operaciones Norte",
    legal_name: "Operaciones Norte S.A.",
    status: "active",
    timezone: "America/Managua",
    created_at: "2026-08-20T08:10:00Z",
    employees_count: 5,
    users_count: 0,
    devices_count: 0,
    controls: {
      employee_limit: 12,
      subscription_status: "active",
      subscription_ends_at: "2026-10-01",
      admin_notice: "",
    },
  },
];

const adminUser = {
  id: "usr-system",
  company_id: null,
  company: "Sistema",
  email: "sistema@vyntra.local",
  full_name: "Admin del sistema",
  role: "system_admin",
  permissions: allPermissions,
  status: "active",
  created_at: "2026-08-20T08:00:00Z",
  last_login_at: "2026-08-20T09:12:00Z",
};

const users = [
  adminUser,
  {
    id: "usr-owner",
    company_id: "cmp-vyntra-demo",
    company: "Vyntra Demo",
    email: "owner@vyntra.local",
    full_name: "Owner Empresa",
    role: "owner",
    permissions: allPermissions.filter((permission) => permission !== "system:manage"),
    status: "active",
    created_at: "2026-08-20T08:05:00Z",
    last_login_at: "2026-08-20T08:40:00Z",
  },
  {
    id: "usr-rrhh",
    company_id: "cmp-vyntra-demo",
    company: "Vyntra Demo",
    email: "rrhh@vyntra.local",
    full_name: "RRHH Demo",
    role: "rrhh",
    permissions: ["dashboard:read", "employees:read", "employees:manage", "attendance:read", "attendance:manage", "incidents:read", "incidents:resolve"],
    status: "active",
    created_at: "2026-08-20T08:06:00Z",
    last_login_at: null,
  },
];

const departments = [
  { id: "dep-soporte", name: "Soporte", status: "active" },
  { id: "dep-ventas", name: "Ventas", status: "active" },
  { id: "dep-operacion", name: "Operacion", status: "active" },
];

const positions = [
  { id: "pos-analista", name: "Analista", status: "active" },
  { id: "pos-ejecutivo", name: "Ejecutivo", status: "active" },
  { id: "pos-supervisor", name: "Supervisor", status: "active" },
];

const employees = [
  { id: "emp-001", employee_code: "EMP-001", full_name: "Ana Lopez", email: "ana@demo.local", department_id: "dep-soporte", position_id: "pos-analista", status: "active" },
  { id: "emp-002", employee_code: "EMP-002", full_name: "Luis Gomez", email: "luis@demo.local", department_id: "dep-ventas", position_id: "pos-ejecutivo", status: "active" },
  { id: "emp-003", employee_code: "EMP-003", full_name: "Marta Reyes", email: "marta@demo.local", department_id: "dep-operacion", position_id: "pos-supervisor", status: "active" },
];

const devices = [
  {
    id: "dev-001",
    company_id: "cmp-vyntra-demo",
    company: "Vyntra Demo",
    employee_id: "emp-001",
    employee: "Ana Lopez",
    employee_code: "EMP-001",
    name: "ANA-LAPTOP",
    hostname: "ANA-LAPTOP",
    location: "Managua",
    is_active: true,
    status: "online",
    agent_version: "1.4.0",
    created_at: "2026-08-20T08:00:00Z",
    last_seen_at: new Date().toISOString(),
  },
  {
    id: "dev-002",
    company_id: "cmp-vyntra-demo",
    company: "Vyntra Demo",
    employee_id: "emp-002",
    employee: "Luis Gomez",
    employee_code: "EMP-002",
    name: "LUIS-PC",
    hostname: "LUIS-PC",
    location: "Casa",
    is_active: true,
    status: "offline",
    agent_version: "1.3.8",
    created_at: "2026-08-19T08:00:00Z",
    last_seen_at: "2026-08-19T19:30:00Z",
  },
];

const auditLogs = [
  {
    id: "aud-001",
    company_id: "cmp-vyntra-demo",
    company: "Vyntra Demo",
    user_id: "usr-system",
    actor: "Admin del sistema",
    actor_email: "sistema@vyntra.local",
    device_id: null,
    action: "system_company_controls_updated",
    entity_type: "company",
    entity_id: "cmp-vyntra-demo",
    ip_address: "127.0.0.1",
    payload: { reason: "Limite inicial para lanzamiento con 7 empleados", employee_limit: 7 },
    created_at: "2026-08-20T09:10:00Z",
  },
  {
    id: "aud-002",
    company_id: "cmp-vyntra-demo",
    company: "Vyntra Demo",
    user_id: "usr-system",
    actor: "Admin del sistema",
    actor_email: "sistema@vyntra.local",
    device_id: "dev-001",
    action: "device_token_rotated",
    entity_type: "device",
    entity_id: "dev-001",
    ip_address: "127.0.0.1",
    payload: { reason: "Rotacion preventiva", hostname: "ANA-LAPTOP" },
    created_at: "2026-08-20T09:15:00Z",
  },
];

const incidents = [
  {
    id: "inc-001",
    company_id: "cmp-vyntra-demo",
    employee_id: "emp-001",
    employee: "Ana Lopez",
    employee_code: "EMP-001",
    department: "Soporte",
    incident_type: "late_start",
    title: "Entrada tardia",
    description: "El inicio de jornada supero la tolerancia configurada.",
    status: "pending",
    severity: "medium",
    occurred_at: "2026-08-20T08:18:00Z",
    resolved_at: null,
    resolution_note: "",
    created_at: "2026-08-20T08:20:00Z",
  },
  {
    id: "inc-002",
    company_id: "cmp-vyntra-demo",
    employee_id: "emp-002",
    employee: "Luis Gomez",
    employee_code: "EMP-002",
    department: "Ventas",
    incident_type: "idle_excess",
    title: "Inactividad prolongada",
    description: "Periodo de inactividad por encima del umbral.",
    status: "approved",
    severity: "low",
    occurred_at: "2026-08-19T15:40:00Z",
    resolved_at: "2026-08-19T16:00:00Z",
    resolution_note: "Justificado por llamada externa.",
    created_at: "2026-08-19T15:45:00Z",
  },
];

function send(res, status, data, headers = {}) {
  const isString = typeof data === "string";
  res.writeHead(status, {
    "content-type": isString ? "text/csv; charset=utf-8" : "application/json; charset=utf-8",
    "access-control-allow-origin": "*",
    "access-control-allow-headers": "authorization,content-type",
    "access-control-allow-methods": "GET,POST,PATCH,OPTIONS",
    ...headers,
  });
  res.end(isString ? data : JSON.stringify(data));
}

function requireAuth(req, res) {
  const auth = req.headers.authorization || "";
  if (!auth.startsWith("Bearer ")) {
    send(res, 401, { detail: "No autorizado" });
    return false;
  }
  return true;
}

function readBody(req) {
  return new Promise((resolve) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      try {
        resolve(raw ? JSON.parse(raw) : {});
      } catch {
        resolve({});
      }
    });
  });
}

function companyOverview() {
  return companies.map((company) => ({
    ...company,
    users_count: users.filter((user) => user.company_id === company.id).length,
    devices_count: devices.filter((device) => device.company_id === company.id).length,
  }));
}

function csvLogs(logs) {
  const rows = [["created_at", "actor_email", "action", "entity_type", "entity_id", "reason"]];
  for (const log of logs) {
    rows.push([log.created_at, log.actor_email, log.action, log.entity_type, log.entity_id, log.payload?.reason || ""]);
  }
  return rows.map((row) => row.map((cell) => `"${String(cell).replaceAll('"', '""')}"`).join(",")).join("\n");
}

function dashboardPayload() {
  const totals = {
    total_seconds: 201600,
    active_seconds: 176400,
    productive_seconds: 118800,
    neutral_seconds: 32400,
    non_productive_seconds: 14400,
    uncategorized_seconds: 10800,
    idle_seconds: 25200,
    break_seconds: 7200,
    lunch_seconds: 14400,
    justified_seconds: 3600,
    productivity_pct: 67,
    acceptable_pct: 85,
    non_productive_pct: 8,
    neutral_pct: 18,
    uncategorized_pct: 6,
    idle_pct: 14,
  };
  return {
    company: companyBase,
    filters: { date_from: null, date_to: null, employee_id: null, department_id: null },
    totals,
    days: [
      { block_date: "2026-08-18", ...totals },
      { block_date: "2026-08-19", ...totals, productivity_pct: 64 },
      { block_date: "2026-08-20", ...totals, productivity_pct: 71 },
    ],
    adjustments: [],
    blocks: employees.map((employee, index) => ({
      id: `blk-${employee.id}`,
      employee_id: employee.id,
      employee: employee.full_name,
      department: departments.find((item) => item.id === employee.department_id)?.name || "",
      block_date: "2026-08-20",
      executable_name: index === 1 ? "chrome.exe" : "excel.exe",
      title_text: index === 1 ? "CRM" : "Reporte diario",
      classification: index === 1 ? "neutral" : "productive",
      seconds: 14400 - index * 900,
      samples: 48 - index * 5,
    })),
  };
}

function catalogsPayload() {
  return {
    company: companyBase,
    classifications: ["productive", "neutral", "non_productive", "uncategorized"],
    departments,
    positions,
    employees,
  };
}

const server = http.createServer(async (req, res) => {
  if (req.method === "OPTIONS") {
    send(res, 204, {});
    return;
  }

  const url = new URL(req.url ?? "/", `http://${req.headers.host}`);
  const path = url.pathname;

  if (path === "/api/admin/login" && req.method === "POST") {
    const body = await readBody(req);
    if (String(body.email ?? "").toLowerCase() === "sistema@vyntra.local" && body.password === "Vyntra2026") {
      send(res, 200, { access_token: "demo-system-token", token_type: "bearer", user: adminUser });
      return;
    }
    send(res, 401, { detail: "Credenciales invalidas" });
    return;
  }

  if (!requireAuth(req, res)) return;

  if (path === "/api/admin/me") {
    send(res, 200, { user: adminUser });
    return;
  }

  if (path === "/api/admin/company-notice") {
    send(res, 200, { messages: [{ type: "warning", message: companies[0].controls.admin_notice }] });
    return;
  }

  if (path === "/api/system/overview" && req.method === "GET") {
    send(res, 200, { companies: companyOverview(), users, roles: ["system_admin", "owner", "admin", "rrhh", "supervisor", "viewer"] });
    return;
  }

  if (path === "/api/system/companies" && req.method === "POST") {
    const body = await readBody(req);
    const company = {
      id: `cmp-${randomUUID().slice(0, 8)}`,
      name: body.name || "Nueva empresa",
      legal_name: body.legal_name || body.name || "Nueva empresa",
      status: "active",
      timezone: body.timezone || "America/Managua",
      created_at: new Date().toISOString(),
      employees_count: 0,
      users_count: 0,
      devices_count: 0,
      controls: {
        employee_limit: Number(body.employee_limit ?? 7),
        subscription_status: body.subscription_status || "trial",
        subscription_ends_at: body.subscription_ends_at || "",
        admin_notice: body.admin_notice || "",
      },
    };
    companies.unshift(company);
    send(res, 200, { company });
    return;
  }

  const controlsMatch = path.match(/^\/api\/system\/companies\/([^/]+)\/controls$/);
  if (controlsMatch && req.method === "PATCH") {
    const body = await readBody(req);
    const company = companies.find((item) => item.id === controlsMatch[1]);
    if (!company) {
      send(res, 404, { detail: "Empresa no encontrada" });
      return;
    }
    company.status = body.is_active === false ? "suspended" : "active";
    company.controls = {
      ...company.controls,
      employee_limit: Number(body.employee_limit ?? company.controls.employee_limit),
      subscription_status: body.subscription_status ?? company.controls.subscription_status,
      subscription_ends_at: body.subscription_ends_at ?? company.controls.subscription_ends_at,
      admin_notice: body.admin_notice ?? company.controls.admin_notice,
    };
    send(res, 200, { company });
    return;
  }

  if (path === "/api/system/users" && req.method === "POST") {
    const body = await readBody(req);
    const company = companies.find((item) => item.id === body.company_id);
    const user = {
      id: `usr-${randomUUID().slice(0, 8)}`,
      company_id: body.company_id || null,
      company: company?.name || "Sistema",
      email: body.email,
      full_name: body.full_name || body.email,
      role: body.role || "viewer",
      permissions: body.role === "system_admin" ? allPermissions : allPermissions.filter((permission) => permission !== "system:manage"),
      status: "active",
      created_at: new Date().toISOString(),
      last_login_at: null,
    };
    users.unshift(user);
    send(res, 200, { user, temporary_password: body.temporary_password || "Temporal2026" });
    return;
  }

  const userMatch = path.match(/^\/api\/system\/users\/([^/]+)$/);
  if (userMatch && req.method === "PATCH") {
    const body = await readBody(req);
    const user = users.find((item) => item.id === userMatch[1]);
    if (!user) {
      send(res, 404, { detail: "Usuario no encontrado" });
      return;
    }
    const company = companies.find((item) => item.id === body.company_id);
    Object.assign(user, {
      full_name: body.full_name ?? user.full_name,
      role: body.role ?? user.role,
      status: body.is_active === false ? "inactive" : "active",
      company_id: body.company_id ?? user.company_id,
      company: company?.name ?? user.company,
    });
    send(res, 200, { user });
    return;
  }

  const resetMatch = path.match(/^\/api\/system\/users\/([^/]+)\/reset-password$/);
  if (resetMatch && req.method === "POST") {
    const user = users.find((item) => item.id === resetMatch[1]);
    if (!user) {
      send(res, 404, { detail: "Usuario no encontrado" });
      return;
    }
    send(res, 200, { user, temporary_password: `Temp-${randomUUID().slice(0, 8)}` });
    return;
  }

  if (path === "/api/devices" && req.method === "GET") {
    send(res, 200, { company: companyBase, count: devices.length, devices });
    return;
  }

  if (path === "/api/devices" && req.method === "POST") {
    const body = await readBody(req);
    const company = companies.find((item) => item.id === body.company_id) || companies[0];
    const employee = employees.find((item) => item.id === body.employee_id);
    const device = {
      id: `dev-${randomUUID().slice(0, 8)}`,
      company_id: company.id,
      company: company.name,
      employee_id: body.employee_id || null,
      employee: employee?.full_name || "",
      employee_code: employee?.employee_code || "",
      name: body.name || "Nuevo equipo",
      hostname: body.hostname || body.name || "NUEVO-EQUIPO",
      location: body.location || "",
      is_active: true,
      status: "offline",
      agent_version: body.agent_version || "1.4.0",
      created_at: new Date().toISOString(),
      last_seen_at: null,
    };
    devices.unshift(device);
    send(res, 200, { device, device_token: `device-${randomUUID()}` });
    return;
  }

  const deviceMatch = path.match(/^\/api\/devices\/([^/]+)$/);
  if (deviceMatch && req.method === "PATCH") {
    const body = await readBody(req);
    const device = devices.find((item) => item.id === deviceMatch[1]);
    if (!device) {
      send(res, 404, { detail: "Equipo no encontrado" });
      return;
    }
    const employee = employees.find((item) => item.id === body.employee_id);
    Object.assign(device, {
      employee_id: body.employee_id ?? device.employee_id,
      employee: employee?.full_name ?? device.employee,
      employee_code: employee?.employee_code ?? device.employee_code,
      name: body.name ?? device.name,
      hostname: body.hostname ?? device.hostname,
      agent_version: body.agent_version ?? device.agent_version,
      is_active: body.is_active ?? device.is_active,
      location: body.location ?? device.location,
      status: body.is_active === false ? "revoked" : device.status,
    });
    send(res, 200, { device });
    return;
  }

  const rotateMatch = path.match(/^\/api\/devices\/([^/]+)\/rotate-token$/);
  if (rotateMatch && req.method === "POST") {
    const device = devices.find((item) => item.id === rotateMatch[1]);
    if (!device) {
      send(res, 404, { detail: "Equipo no encontrado" });
      return;
    }
    send(res, 200, { device, device_token: `device-${randomUUID()}` });
    return;
  }

  if (path === "/api/audit/logs" && req.method === "GET") {
    if (url.searchParams.get("export") === "csv") {
      send(res, 200, csvLogs(auditLogs), { "content-disposition": "attachment; filename=audit_logs.csv" });
      return;
    }
    send(res, 200, { company_id: null, count: auditLogs.length, items: auditLogs, filters: {} });
    return;
  }

  if (path === "/api/productivity/catalogs") {
    send(res, 200, catalogsPayload());
    return;
  }

  if (path === "/api/productivity/dashboard") {
    send(res, 200, dashboardPayload());
    return;
  }

  if (path === "/api/productivity/uncategorized") {
    send(res, 200, { items: [{ executable_name: "unknown.exe", title_text: "Aplicacion sin clasificar", samples: 5, seconds: 1200 }] });
    return;
  }

  if (path === "/api/incidents" && req.method === "GET") {
    send(res, 200, { company: companyBase, count: incidents.length, incidents });
    return;
  }

  const incidentMatch = path.match(/^\/api\/incidents\/([^/]+)$/);
  if (incidentMatch && req.method === "PATCH") {
    const body = await readBody(req);
    const incident = incidents.find((item) => item.id === incidentMatch[1]);
    if (!incident) {
      send(res, 404, { detail: "Incidencia no encontrada" });
      return;
    }
    Object.assign(incident, { status: body.status ?? incident.status, resolution_note: body.resolution_note ?? "", resolved_at: new Date().toISOString() });
    send(res, 200, { incident });
    return;
  }

  if (path === "/api/attendance/overview") {
    send(res, 200, { company: companyBase, filters: { date_from: null, date_to: null, employee_id: null, department_id: null }, employees: [], time_adjustments: [], shifts: [] });
    return;
  }

  send(res, 404, { detail: `Mock endpoint no implementado: ${req.method} ${path}` });
});

server.listen(port, () => {
  console.log(`Vyntra dev mock API listening on http://localhost:${port}`);
  console.log("Demo login: sistema@vyntra.local / Vyntra2026");
});
