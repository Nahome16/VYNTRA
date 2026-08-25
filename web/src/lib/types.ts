export type AdminUser = {
  id: string | null;
  company_id: string;
  company: string;
  email: string;
  full_name: string;
  role: string;
  permissions: string[];
  status: string;
  last_login_at: string | null;
};

export type SystemCompany = {
  id: string;
  name: string;
  legal_name: string;
  status: string;
  timezone: string;
  created_at: string | null;
  employees_count: number;
  users_count: number;
  devices_count: number;
  controls: {
    employee_limit: number;
    subscription_status: "active" | "trial" | "past_due" | "suspended" | "cancelled";
    subscription_ends_at: string;
    admin_notice: string;
  };
};

export type PanelUser = {
  id: string;
  company_id: string;
  company: string;
  email: string;
  full_name: string;
  role: string;
  permissions: string[];
  status: string;
  created_at: string | null;
  last_login_at: string | null;
  active_sessions?: number;
};

export type SystemOverviewResponse = {
  companies: SystemCompany[];
  users: PanelUser[];
  roles: Array<"system_admin" | "owner" | "admin" | "rrhh" | "supervisor" | "viewer">;
};

export type AuditLogEntry = {
  id: string;
  company_id: string | null;
  company: string;
  user_id: string | null;
  actor: string;
  actor_email: string;
  device_id: string | null;
  action: string;
  entity_type: string;
  entity_id: string;
  ip_address: string;
  payload: Record<string, unknown> | unknown[] | string;
  created_at: string | null;
};

export type AuditLogsResponse = {
  company_id: string | null;
  count: number;
  items: AuditLogEntry[];
  filters: Record<string, string | number | null>;
};

export type DeviceStatus = "online" | "offline" | "revoked";

export type AgentDownload = {
  filename: string;
  platform: string;
  size_bytes: number;
  updated_at: string;
  download_url: string;
};

export type AgentDownloadsResponse = {
  count: number;
  directory_ready: boolean;
  downloads: AgentDownload[];
};

export type DeviceRecord = {
  id: string;
  company_id: string;
  company: string;
  employee_id: string | null;
  employee: string;
  employee_code: string;
  name: string;
  hostname: string;
  location: string;
  is_active: boolean;
  status: DeviceStatus;
  agent_version: string;
  created_at: string | null;
  last_seen_at: string | null;
};

export type DevicesResponse = {
  company: { id: string; name: string };
  count: number;
  devices: DeviceRecord[];
};

export type DashboardTotals = {
  total_seconds: number;
  active_seconds: number;
  productive_seconds: number;
  neutral_seconds: number;
  non_productive_seconds: number;
  uncategorized_seconds: number;
  idle_seconds: number;
  break_seconds: number;
  lunch_seconds: number;
  justified_seconds: number;
  productivity_pct: number;
  acceptable_pct: number;
  non_productive_pct: number;
  neutral_pct: number;
  uncategorized_pct: number;
  idle_pct: number;
};

export type DashboardDay = {
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
  justified_seconds: number;
  productivity_pct: number;
  acceptable_pct: number;
  idle_pct: number;
  break_pct: number;
  lunch_pct: number;
};

export type ProductivityBlock = DashboardTotals & {
  id: string;
  employee_id: string;
  department_id: string | null;
  block_date: string;
  block_start: string;
  break_lunch_seconds: number;
  break_pct: number;
  lunch_pct: number;
};

export type DashboardResponse = {
  company: { id: string; name: string };
  filters: {
    date_from: string | null;
    date_to: string | null;
    employee_id: string | null;
    department_id: string | null;
  };
  totals: DashboardTotals;
  days: DashboardDay[];
  adjustments: TimeAdjustment[];
  blocks: ProductivityBlock[];
};

export type Department = {
  id: string;
  name: string;
  status: string;
};

export type Position = {
  id: string;
  name: string;
  status: string;
};

export type Employee = {
  id: string;
  employee_code: string;
  full_name: string;
  email: string;
  department_id: string | null;
  position_id: string | null;
  status: string;
};

export type CatalogsResponse = {
  company: { id: string; name: string };
  classifications: string[];
  departments: Department[];
  positions: Position[];
  employees: Employee[];
};

export type UncategorizedItem = {
  executable_name: string;
  title_text: string;
  samples: number;
  seconds: number;
};

export type StationRestoreCode = {
  id: string;
  employee_id: string;
  employee: string | null;
  email: string;
  code?: string;
  status: string;
  reason: string;
  valid_from: string;
  valid_until: string;
  used_at: string | null;
  created_at: string | null;
};

export type AccessCode = StationRestoreCode & {
  type: "station_reopen" | "overtime";
  type_label: string;
  assigned_minutes?: number | null;
};

export type IncidentStatus = "pending" | "approved" | "rejected" | "closed";

export type TimeAdjustment = {
  id: string;
  company_id: string;
  employee_id: string;
  device_id: string | null;
  incident_id: string | null;
  adjustment_type: string;
  status: string;
  started_at: string;
  ended_at: string;
  seconds: number;
  productivity_classification: string;
  reason: string;
  notes: string;
};

export type Incident = {
  id: string;
  company_id: string;
  employee_id: string;
  employee: string | null;
  employee_code: string | null;
  device_id: string | null;
  device: string | null;
  incident_type: string;
  status: IncidentStatus;
  title: string;
  description: string;
  requested_at: string | null;
  resolved_at: string | null;
  resolution_notes: string;
  time_adjustment: TimeAdjustment | null;
  payload: Record<string, unknown>;
};

export type ProductivityRule = {
  id: string;
  company_id: string;
  department_id: string | null;
  department: string | null;
  position_id: string | null;
  position: string | null;
  employee_id: string | null;
  employee: string | null;
  executable_name: string;
  title_contains: string;
  classification: string;
  priority: number;
  is_active: boolean;
  notes: string;
  created_at: string | null;
  updated_at: string | null;
};

export type AttendanceEmployee = Employee & {
  department: string | null;
  position: string | null;
  schedule: {
    id: string | null;
    start_time: string;
    end_time: string;
    effective_from: string;
    timezone: string;
  };
};

export type ShiftEvent = {
  id: string;
  event_type: string;
  occurred_at: string;
};

export type AttendanceShift = {
  id: string;
  company_id: string;
  employee_id: string;
  device_id: string | null;
  shift_date: string;
  status: string;
  started_at: string | null;
  ended_at: string | null;
  work_seconds: number;
  break_seconds: number;
  lunch_seconds: number;
  idle_seconds: number;
  justified_seconds: number;
  events: ShiftEvent[];
};

export type AttendanceOverviewResponse = {
  company: { id: string; name: string };
  filters: {
    date_from: string | null;
    date_to: string | null;
    employee_id: string | null;
    department_id: string | null;
  };
  employees: AttendanceEmployee[];
  time_adjustments: TimeAdjustment[];
  shifts: AttendanceShift[];
};

export type EmployeeDetailResponse = {
  company: { id: string; name: string };
  filters: {
    date_from: string | null;
    date_to: string | null;
  };
  employee: Employee & {
    department: string | null;
    position: string | null;
  };
  totals: DashboardTotals;
  days: Array<{
    date: string;
    active_seconds: number;
    productive_seconds: number;
    neutral_seconds: number;
    non_productive_seconds: number;
    idle_seconds: number;
    break_seconds: number;
    lunch_seconds: number;
    justified_seconds: number;
  }>;
  apps: Array<{
    app: string;
    classification: string;
    seconds: number;
    samples: number;
  }>;
  adjustments: TimeAdjustment[];
  blocks: ProductivityBlock[];
  evidence: Array<{
    id: string;
    captured_at: string;
    original_filename: string;
    equipment: string;
    content_type: string;
    status: string;
    view_url: string;
  }>;
};
