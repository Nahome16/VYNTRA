import http from "node:http";
import { randomUUID } from "node:crypto";
import fs from "node:fs";

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
  { id: "emp-001", company_id: "cmp-vyntra-demo", employee_code: "EMP-001", full_name: "Ana Lopez", email: "ana@demo.local", department_id: "dep-soporte", position_id: "pos-analista", status: "active" },
  { id: "emp-002", company_id: "cmp-vyntra-demo", employee_code: "EMP-002", full_name: "Luis Gomez", email: "luis@demo.local", department_id: "dep-ventas", position_id: "pos-ejecutivo", status: "active" },
  { id: "emp-003", company_id: "cmp-vyntra-demo", employee_code: "EMP-003", full_name: "Marta Reyes", email: "marta@demo.local", department_id: "dep-operacion", position_id: "pos-supervisor", status: "active" },
  { id: "emp-norte-001", company_id: "cmp-norte", employee_code: "NOR-001", full_name: "Carla Mendez", email: "carla@norte.local", department_id: "dep-operacion", position_id: "pos-supervisor", status: "active" },
  { id: "emp-norte-002", company_id: "cmp-norte", employee_code: "NOR-002", full_name: "Diego Ruiz", email: "diego@norte.local", department_id: "dep-soporte", position_id: "pos-analista", status: "active" },
  { id: "emp-norte-003", company_id: "cmp-norte", employee_code: "NOR-003", full_name: "Elena Torres", email: "elena@norte.local", department_id: "dep-ventas", position_id: "pos-ejecutivo", status: "active" },
  { id: "emp-norte-004", company_id: "cmp-norte", employee_code: "NOR-004", full_name: "Marco Diaz", email: "marco@norte.local", department_id: "dep-operacion", position_id: "pos-analista", status: "active" },
  { id: "emp-norte-005", company_id: "cmp-norte", employee_code: "NOR-005", full_name: "Sofia Castillo", email: "sofia@norte.local", department_id: "dep-soporte", position_id: "pos-ejecutivo", status: "active" },
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

const agentDownloads = [
  {
    filename: "VyntraAgent-Setup-1.4.2.exe",
    platform: "Windows",
    size_bytes: 48_234_112,
    updated_at: "2026-09-28T14:30:00Z",
    download_url: "/api/downloads/agent/VyntraAgent-Setup-1.4.2.exe",
  },
  {
    filename: "VyntraAgent-Update-1.4.2.zip",
    platform: "Windows",
    size_bytes: 18_102_272,
    updated_at: "2026-09-28T14:35:00Z",
    download_url: "/api/downloads/agent/VyntraAgent-Update-1.4.2.zip",
  },
];

const productivityRules = [];
const accessCodes = [];

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
    billing: billingSummary(company),
  }));
}

function companyFromRequest(url) {
  const companyId = url.searchParams.get("company_id");
  return companies.find((company) => company.id === companyId) || companies[0];
}

function employeesForCompany(companyId) {
  return employees.filter((employee) => employee.company_id === companyId);
}

function attendanceEmployeesForCompany(companyId) {
  return employeesForCompany(companyId).map((employee) => ({
    ...employee,
    department: departments.find((item) => item.id === employee.department_id)?.name || null,
    position: positions.find((item) => item.id === employee.position_id)?.name || null,
    schedule: {
      id: `sch-${employee.id}`,
      start_time: "08:00",
      end_time: "17:00",
      expected_break_minutes: 15,
      expected_lunch_minutes: 60,
      effective_from: "2026-08-01",
      timezone: "America/Managua",
    },
  }));
}

function csvLogs(logs) {
  const rows = [["created_at", "actor_email", "action", "entity_type", "entity_id", "reason"]];
  for (const log of logs) {
    rows.push([log.created_at, log.actor_email, log.action, log.entity_type, log.entity_id, log.payload?.reason || ""]);
  }
  return rows.map((row) => row.map((cell) => `"${String(cell).replaceAll('"', '""')}"`).join(",")).join("\n");
}

function mockTotals(active, productive, neutral, nonProductive, uncategorized, idle) {
  const total = active + idle;
  const pct = (part, whole) => (whole ? Math.round((part / whole) * 1000) / 10 : 0);
  return {
    total_seconds: total,
    active_seconds: active,
    productive_seconds: productive,
    neutral_seconds: neutral,
    non_productive_seconds: nonProductive,
    uncategorized_seconds: uncategorized,
    idle_seconds: idle,
    break_seconds: 1800,
    lunch_seconds: 3600,
    justified_seconds: 0,
    productivity_pct: pct(productive + neutral, active),
    acceptable_pct: pct(productive + neutral, active),
    non_productive_pct: pct(nonProductive, active),
    neutral_pct: pct(neutral, active),
    uncategorized_pct: pct(uncategorized, active),
    idle_pct: pct(idle, total),
    break_pct: 0,
    lunch_pct: 0,
  };
}

function dashboardPayload(company, url) {
  const scopedEmployees = employeesForCompany(company.id);
  const today = new Date().toISOString().slice(0, 10);
  // El periodo anterior (termina antes de hoy) rinde un poco menos, para ver las comparaciones.
  const previous = (url?.searchParams.get("date_to") || today) < today;
  const profiles = [
    [27000, 19800, 3600, 1800, 1800, 3600],
    [25200, 12600, 3600, 6300, 2700, 6300],
    [28800, 21600, 4500, 1500, 1200, 2400],
  ];
  const blocks = [];
  const days = [];
  for (let offset = 6; offset >= 0; offset -= 1) {
    const date = new Date(Date.now() - offset * 86400000).toISOString().slice(0, 10);
    const dayParts = [0, 0, 0, 0, 0, 0];
    scopedEmployees.forEach((employee, index) => {
      const base = profiles[index % profiles.length];
      const wobble = ((offset * 7 + index * 3) % 5) - 2;
      const factor = previous ? 0.93 : 1;
      const parts = [
        base[0],
        Math.round(base[1] * factor * (1 + wobble * 0.03)),
        base[2],
        Math.round(base[3] * (previous ? 1.25 : 1)),
        base[4],
        Math.round(base[5] * (previous ? 1.2 : 1)),
      ];
      parts[1] = Math.min(parts[1], parts[0] - parts[2] - parts[3] - parts[4]);
      parts.forEach((value, i) => (dayParts[i] += value));
      blocks.push({
        id: `blk-${employee.id}-${date}`,
        employee_id: employee.id,
        department_id: employee.department_id,
        block_date: date,
        block_start: `${date}T08:00:00`,
        break_lunch_seconds: 5400,
        ...mockTotals(...parts),
      });
    });
    days.push({ block_date: date, break_lunch_seconds: 0, ...mockTotals(...dayParts) });
  }
  const sum = (key) => blocks.reduce((acc, block) => acc + block[key], 0);
  const totals = mockTotals(
    sum("active_seconds"),
    sum("productive_seconds"),
    sum("neutral_seconds"),
    sum("non_productive_seconds"),
    sum("uncategorized_seconds"),
    sum("idle_seconds"),
  );
  return {
    company: { id: company.id, name: company.name },
    filters: { date_from: null, date_to: null, employee_id: null, department_id: null },
    totals,
    days,
    adjustments: [],
    blocks,
  };
}

function catalogsPayload(company) {
  return {
    company: { id: company.id, name: company.name },
    classifications: ["productive", "neutral", "non_productive", "uncategorized"],
    departments,
    positions,
    employees: employeesForCompany(company.id),
  };
}


// --- Facturacion (simulada) ------------------------------------------------
// Fecha simulada para ver el recordatorio de un periodo ya cerrado.
const BILLING_TODAY = process.env.MOCK_BILLING_TODAY || "2026-10-16";
const BILLING_START = "2026-09-15";
const UNIT_PRICE_CENTS = 1500;
const invoices = [];
const monthsShort = ["ene.", "feb.", "mar.", "abr.", "may.", "jun.", "jul.", "ago.", "sep.", "oct.", "nov.", "dic."];

function isoAddMonths(iso, months) {
  const [y, m, d] = iso.split("-").map(Number);
  const date = new Date(Date.UTC(y, m - 1 + months, d));
  return date.toISOString().slice(0, 10);
}

function isoAddDays(iso, days) {
  const date = new Date(`${iso}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function periodLabel(start, end) {
  const [, sm, sd] = start.split("-").map(Number);
  const [ey, em, ed] = end.split("-").map(Number);
  return `${sd} ${monthsShort[sm - 1]} – ${ed} ${monthsShort[em - 1]} ${ey}`;
}

function billingPeriods(companyId) {
  const periods = [];
  let start = BILLING_START;
  while (start <= BILLING_TODAY) {
    const end = isoAddDays(isoAddMonths(start, 1), -1);
    const invoice = invoices.find((row) => row.company_id === companyId && row.period_start === start) || null;
    periods.push({
      start,
      end,
      label: periodLabel(start, end),
      status: end < BILLING_TODAY ? "closed" : "open",
      invoice: invoice ? { id: invoice.id, number: invoice.number, status: invoice.status, sent_at: invoice.sent_at } : null,
    });
    start = isoAddMonths(start, 1);
  }
  return periods.reverse();
}

function dueDate(issued) {
  let date = issued;
  let count = 0;
  while (count < 4) {
    date = isoAddDays(date, 1);
    const day = new Date(`${date}T00:00:00Z`).getUTCDay();
    if (day !== 0 && day !== 6) count += 1;
  }
  return date;
}

function billingRecipients(companyId) {
  return users
    .filter((user) => user.company_id === companyId && user.status === "active" && (user.role === "owner" || user.role === "admin"))
    .map((user) => ({ id: user.id, email: user.email, full_name: user.full_name, role: user.role }));
}

function invoiceAmounts(company, body) {
  const start = body.period_start;
  const end = isoAddDays(isoAddMonths(start, 1), -1);
  const existing = invoices.find((row) => row.company_id === company.id && row.period_start === start);
  const prefix = `VYN-${end.slice(0, 4)}${end.slice(5, 7)}-`;
  const number = existing?.number || `${prefix}${String(invoices.filter((row) => row.number.startsWith(prefix)).length + 1).padStart(4, "0")}`;
  const activeUsers = Number.isFinite(Number(body.active_users)) ? Number(body.active_users) : company.employees_count;
  return {
    number,
    period_start: start,
    period_end: end,
    period_label: periodLabel(start, end),
    issued_on: BILLING_TODAY,
    due_on: dueDate(BILLING_TODAY),
    active_users: activeUsers,
    unit_price_cents: UNIT_PRICE_CENTS,
    subtotal_cents: activeUsers * UNIT_PRICE_CENTS,
    tax_cents: 0,
    total_cents: activeUsers * UNIT_PRICE_CENTS,
    currency: "USD",
  };
}

function invoiceHtml(company, amounts) {
  // La plantilla real la genera el backend; aqui solo se sustituyen los valores de ejemplo.
  const template = fs.readFileSync(new URL("../docs/factura/factura-correo.html", import.meta.url), "utf8");
  const total = (amounts.total_cents / 100).toFixed(2);
  return template
    .replaceAll("VYN-202610-0001", amounts.number)
    .replaceAll("105.00", total)
    .replaceAll("Vyntra Demo S.A.", company.legal_name || company.name)
    .replaceAll("7 usuarios activos", `${amounts.active_users} usuarios activos`)
    .replace(/>7</, `>${amounts.active_users}<`);
}

function billingSummary(company) {
  const periods = billingPeriods(company.id);
  const pending = periods.find((row) => row.status === "closed" && !(row.invoice && ["sent", "partial"].includes(row.invoice.status)));
  const last = invoices.filter((row) => row.company_id === company.id).sort((a, b) => b.period_start.localeCompare(a.period_start))[0];
  return {
    pending_period: pending ? { start: pending.start, end: pending.end, label: pending.label } : null,
    last_invoice: last ? { number: last.number, period_start: last.period_start, period_end: last.period_end, status: last.status, sent_at: last.sent_at } : null,
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


  const billingMatch = path.match(/^\/api\/system\/companies\/([^/]+)\/billing$/);
  if (billingMatch && req.method === "GET") {
    const company = companies.find((row) => row.id === billingMatch[1]);
    if (!company) return send(res, 404, { detail: "Empresa no encontrada" });
    const periods = billingPeriods(company.id);
    const pending = periods.find((row) => row.status === "closed" && !(row.invoice && ["sent", "partial"].includes(row.invoice.status)));
    send(res, 200, {
      company: { id: company.id, name: company.name, legal_name: company.legal_name },
      settings: { unit_price_cents: UNIT_PRICE_CENTS, currency: "USD", due_business_days: 4, billing_start: BILLING_START, payment_configured: true, contact_email: "notificaciones@vyntralab.com" },
      active_users: company.employees_count,
      recipients: billingRecipients(company.id),
      periods,
      default_period_start: (pending || periods.find((row) => row.status === "closed") || periods[0]).start,
      invoices: invoices.filter((row) => row.company_id === company.id).sort((a, b) => b.period_start.localeCompare(a.period_start)),
    });
    return;
  }

  const invoiceActionMatch = path.match(/^\/api\/system\/companies\/([^/]+)\/invoices\/(preview|send)$/);
  if (invoiceActionMatch && req.method === "POST") {
    const company = companies.find((row) => row.id === invoiceActionMatch[1]);
    if (!company) return send(res, 404, { detail: "Empresa no encontrada" });
    const body = await readBody(req);
    if (!billingPeriods(company.id).some((row) => row.start === body.period_start)) return send(res, 400, { detail: "Periodo de facturación no válido" });
    const eligible = billingRecipients(company.id);
    const chosen = (body.recipients?.length ? eligible.filter((row) => body.recipients.includes(row.email)) : eligible);
    if (!chosen.length) return send(res, 400, { detail: "Selecciona al menos un destinatario" });
    const amounts = invoiceAmounts(company, body);
    const html = invoiceHtml(company, amounts);
    const subject = `Factura ${amounts.number} · VYNTRA · ${amounts.period_label}`;
    if (invoiceActionMatch[2] === "preview") {
      const existing = invoices.find((row) => row.company_id === company.id && row.period_start === body.period_start);
      send(res, 200, { invoice: amounts, subject, html, recipients: chosen.map(({ email, full_name }) => ({ email, full_name })), already_sent: Boolean(existing) });
      return;
    }
    let invoice = invoices.find((row) => row.company_id === company.id && row.period_start === body.period_start);
    const recipients = chosen.map(({ email, full_name }) => ({ email, full_name, status: "sent" }));
    if (!invoice) {
      invoice = { id: `inv-${randomUUID().slice(0, 8)}`, company_id: company.id, send_count: 0, created_at: new Date().toISOString() };
      invoices.push(invoice);
    }
    Object.assign(invoice, amounts, {
      status: "sent",
      recipients,
      send_count: invoice.send_count + 1,
      sent_at: new Date().toISOString(),
      sent_by: { id: adminUser.id, full_name: adminUser.full_name, email: adminUser.email },
    });
    send(res, 200, { invoice, delivery: recipients.map(({ email, status }) => ({ email, status })) });
    return;
  }

  const invoiceHtmlMatch = path.match(/^\/api\/system\/invoices\/([^/]+)\/html$/);
  if (invoiceHtmlMatch && req.method === "GET") {
    const invoice = invoices.find((row) => row.id === invoiceHtmlMatch[1]);
    if (!invoice) return send(res, 404, { detail: "Factura no encontrada" });
    const company = companies.find((row) => row.id === invoice.company_id);
    send(res, 200, { subject: `Factura ${invoice.number} · VYNTRA · ${invoice.period_label}`, html: invoiceHtml(company, invoice) });
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

  if (path === "/api/downloads/agent" && req.method === "GET") {
    send(res, 200, { count: agentDownloads.length, directory_ready: true, downloads: agentDownloads });
    return;
  }

  const downloadMatch = path.match(/^\/api\/downloads\/agent\/([^/]+)$/);
  if (downloadMatch && req.method === "GET") {
    send(res, 200, `mock installer: ${decodeURIComponent(downloadMatch[1])}`, {
      "content-disposition": `attachment; filename="${decodeURIComponent(downloadMatch[1]).replaceAll('"', "")}"`,
    });
    return;
  }

  if (path === "/api/devices" && req.method === "GET") {
    const company = companyFromRequest(url);
    const scopedDevices = devices.filter((device) => device.company_id === company.id);
    send(res, 200, { company: { id: company.id, name: company.name }, count: scopedDevices.length, devices: scopedDevices });
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
    send(res, 200, { device, credentials: { device_token: `device-${randomUUID()}` } });
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
    send(res, 200, { device, credentials: { device_token: `device-${randomUUID()}` } });
    return;
  }

  if (path === "/api/audit/logs" && req.method === "GET") {
    const companyId = url.searchParams.get("company_id");
    const scopedLogs = companyId ? auditLogs.filter((log) => log.company_id === companyId) : auditLogs;
    if (url.searchParams.get("export") === "csv") {
      send(res, 200, csvLogs(scopedLogs), { "content-disposition": "attachment; filename=audit_logs.csv" });
      return;
    }
    send(res, 200, { company_id: companyId, count: scopedLogs.length, items: scopedLogs, filters: {} });
    return;
  }

  if (path === "/api/productivity/catalogs") {
    send(res, 200, catalogsPayload(companyFromRequest(url)));
    return;
  }

  if (path === "/api/productivity/rules" && req.method === "GET") {
    const company = companyFromRequest(url);
    send(res, 200, { rules: productivityRules.filter((rule) => rule.company_id === company.id) });
    return;
  }

  if (path === "/api/productivity/dashboard") {
    send(res, 200, dashboardPayload(companyFromRequest(url), url));
    return;
  }

  const employeeDetailMatch = path.match(/^\/api\/employees\/([^/]+)\/detail$/);
  if (employeeDetailMatch && req.method === "GET") {
    const company = companyFromRequest(url);
    const employee = employeesForCompany(company.id).find((item) => item.id === employeeDetailMatch[1]);
    if (!employee) {
      send(res, 404, { detail: "Empleado no encontrado" });
      return;
    }
    const payload = dashboardPayload(company, url);
    const blocks = payload.blocks.filter((block) => block.employee_id === employee.id);
    const sum = (key) => blocks.reduce((acc, block) => acc + (block[key] || 0), 0);
    send(res, 200, {
      company: { id: company.id, name: company.name },
      filters: { date_from: url.searchParams.get("date_from"), date_to: url.searchParams.get("date_to") },
      employee: {
        ...employee,
        department: departments.find((item) => item.id === employee.department_id)?.name || null,
        position: positions.find((item) => item.id === employee.position_id)?.name || null,
      },
      totals: mockTotals(
        sum("active_seconds"),
        sum("productive_seconds"),
        sum("neutral_seconds"),
        sum("non_productive_seconds"),
        sum("uncategorized_seconds"),
        sum("idle_seconds"),
      ),
      days: blocks.map((block) => ({
        date: block.block_date,
        active_seconds: block.active_seconds,
        productive_seconds: block.productive_seconds,
        neutral_seconds: block.neutral_seconds,
        non_productive_seconds: block.non_productive_seconds,
        idle_seconds: block.idle_seconds,
        break_seconds: block.break_seconds,
        lunch_seconds: block.lunch_seconds,
        justified_seconds: 0,
      })),
      apps: [
        { app: "excel.exe", classification: "productive", seconds: 54000, samples: 180 },
        { app: "chrome.exe · CRM", classification: "neutral", seconds: 21600, samples: 72 },
        { app: "whatsapp.exe", classification: "non_productive", seconds: 7200, samples: 24 },
      ],
      adjustments: [],
      blocks,
      evidence_total: 0,
      evidence: [],
    });
    return;
  }

  if (path === "/api/productivity/uncategorized") {
    send(res, 200, { items: [{ executable_name: "unknown.exe", title_text: "Aplicacion sin clasificar", samples: 5, seconds: 1200 }] });
    return;
  }

  if (path === "/api/settings/access-codes" && req.method === "GET") {
    const company = companyFromRequest(url);
    send(res, 200, { codes: accessCodes.filter((code) => code.company_id === company.id) });
    return;
  }

  if (path === "/api/incidents" && req.method === "GET") {
    const company = companyFromRequest(url);
    const scopedIncidents = incidents.filter((incident) => incident.company_id === company.id);
    send(res, 200, { company: { id: company.id, name: company.name }, count: scopedIncidents.length, incidents: scopedIncidents });
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
    const company = companyFromRequest(url);
    const scopedEmployees = attendanceEmployeesForCompany(company.id);
    send(res, 200, {
      company: { id: company.id, name: company.name },
      filters: {
        date_from: url.searchParams.get("date_from"),
        date_to: url.searchParams.get("date_to"),
        employee_id: url.searchParams.get("employee_id"),
        department_id: url.searchParams.get("department_id"),
      },
      employees: scopedEmployees,
      time_adjustments: [],
      shifts: [],
    });
    return;
  }

  send(res, 404, { detail: `Mock endpoint no implementado: ${req.method} ${path}` });
});

server.listen(port, () => {
  console.log(`Vyntra dev mock API listening on http://localhost:${port}`);
  console.log("Demo login: sistema@vyntra.local / Vyntra2026");
});
