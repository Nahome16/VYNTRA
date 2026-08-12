export type AdminUser = {
  id: string | null;
  company_id: string;
  company: string;
  email: string;
  full_name: string;
  role: string;
  status: string;
  last_login_at: string | null;
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
  shifts: AttendanceShift[];
};
