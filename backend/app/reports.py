"""
reports.py - PDF report builders for VYNTRA.
"""

from __future__ import annotations

from datetime import datetime, timezone
from io import BytesIO

from reportlab.lib import colors
from reportlab.lib.pagesizes import A4, landscape
from reportlab.lib.units import mm
from reportlab.pdfgen import canvas


PAGE_SIZE = landscape(A4)
PAGE_W, PAGE_H = PAGE_SIZE
MARGIN = 16 * mm
BLUE = colors.HexColor("#2f64ea")
CYAN = colors.HexColor("#38bdf8")
INK = colors.HexColor("#111827")
MUTED = colors.HexColor("#64748b")
LINE = colors.HexColor("#d8e1ef")
SURFACE = colors.HexColor("#f8fafc")
GOOD = colors.HexColor("#10b981")
WARN = colors.HexColor("#f59e0b")
BAD = colors.HexColor("#ef4444")


def fmt_duration(seconds: int | float) -> str:
    total = max(0, int(round(seconds or 0)))
    hours = total // 3600
    minutes = (total % 3600) // 60
    if hours:
        return f"{hours}h {minutes}m"
    return f"{minutes}m"


def fmt_pct(value: int | float) -> str:
    return f"{round(float(value or 0), 1):g}%"


def fmt_date(value: str | None) -> str:
    if not value:
        return "-"
    parts = value.split("-")
    if len(parts) == 3:
        return f"{parts[2]}/{parts[1]}/{parts[0]}"
    return value


def fmt_datetime(value: str | None) -> str:
    if not value:
        return "-"
    try:
        return datetime.fromisoformat(value.replace("Z", "+00:00")).strftime("%d/%m/%Y %H:%M")
    except ValueError:
        return value[:16]


def safe_text(value: object, fallback: str = "-") -> str:
    text = str(value or "").strip()
    return text if text else fallback


def worked_seconds(shift: dict) -> int:
    return max(
        0,
        int(shift.get("work_seconds") or 0)
        - int(shift.get("break_seconds") or 0)
        - int(shift.get("lunch_seconds") or 0)
        + int(shift.get("justified_seconds") or 0),
    )


def tone_for_pct(value: int | float):
    value = float(value or 0)
    if value >= 85:
        return GOOD
    if value >= 65:
        return WARN
    return BAD


def draw_page_header(pdf: canvas.Canvas, title: str, subtitle: str, page: int) -> None:
    pdf.setFillColor(INK)
    pdf.rect(0, PAGE_H - 26 * mm, PAGE_W, 26 * mm, fill=1, stroke=0)
    pdf.setFillColor(BLUE)
    pdf.roundRect(MARGIN, PAGE_H - 20 * mm, 13 * mm, 13 * mm, 3 * mm, fill=1, stroke=0)
    pdf.setFillColor(colors.white)
    pdf.setFont("Helvetica-Bold", 14)
    pdf.drawCentredString(MARGIN + 6.5 * mm, PAGE_H - 15.3 * mm, "V")
    pdf.setFont("Helvetica-Bold", 16)
    pdf.drawString(MARGIN + 18 * mm, PAGE_H - 12 * mm, title)
    pdf.setFont("Helvetica", 8.5)
    pdf.setFillColor(colors.HexColor("#cbd5e1"))
    pdf.drawString(MARGIN + 18 * mm, PAGE_H - 18 * mm, subtitle)
    pdf.setFillColor(colors.HexColor("#94a3b8"))
    pdf.drawRightString(PAGE_W - MARGIN, PAGE_H - 13 * mm, f"Pagina {page}")


def draw_footer(pdf: canvas.Canvas) -> None:
    pdf.setStrokeColor(LINE)
    pdf.line(MARGIN, 11 * mm, PAGE_W - MARGIN, 11 * mm)
    pdf.setFont("Helvetica", 7.5)
    pdf.setFillColor(MUTED)
    pdf.drawString(MARGIN, 7 * mm, "Reporte generado por VYNTRA Control")
    pdf.drawRightString(PAGE_W - MARGIN, 7 * mm, datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M UTC"))


def draw_card(pdf: canvas.Canvas, x: float, y: float, w: float, h: float, label: str, value: str, detail: str, tone=BLUE) -> None:
    pdf.setFillColor(colors.white)
    pdf.setStrokeColor(LINE)
    pdf.roundRect(x, y, w, h, 4 * mm, fill=1, stroke=1)
    pdf.setFillColor(tone)
    pdf.roundRect(x + 4 * mm, y + h - 7 * mm, 12 * mm, 2 * mm, 1 * mm, fill=1, stroke=0)
    pdf.setFillColor(MUTED)
    pdf.setFont("Helvetica-Bold", 7.5)
    pdf.drawString(x + 4 * mm, y + h - 13 * mm, label.upper())
    pdf.setFillColor(INK)
    pdf.setFont("Helvetica-Bold", 18)
    pdf.drawString(x + 4 * mm, y + h - 23 * mm, value)
    pdf.setFillColor(MUTED)
    pdf.setFont("Helvetica", 8)
    pdf.drawString(x + 4 * mm, y + 6 * mm, detail[:48])


def draw_section_title(pdf: canvas.Canvas, x: float, y: float, title: str, meta: str = "") -> None:
    pdf.setFillColor(INK)
    pdf.setFont("Helvetica-Bold", 11)
    pdf.drawString(x, y, title)
    if meta:
        pdf.setFillColor(MUTED)
        pdf.setFont("Helvetica", 8)
        pdf.drawRightString(PAGE_W - MARGIN, y, meta)


def draw_progress(pdf: canvas.Canvas, x: float, y: float, w: float, label: str, seconds: int, total: int, color) -> None:
    pct = 0 if total <= 0 else min(1, seconds / total)
    pdf.setFillColor(INK)
    pdf.setFont("Helvetica-Bold", 8)
    pdf.drawString(x, y + 5 * mm, label)
    pdf.setFillColor(MUTED)
    pdf.setFont("Helvetica", 8)
    pdf.drawRightString(x + w, y + 5 * mm, fmt_duration(seconds))
    pdf.setFillColor(colors.HexColor("#e5edf7"))
    pdf.roundRect(x, y, w, 3.5 * mm, 1.5 * mm, fill=1, stroke=0)
    pdf.setFillColor(color)
    pdf.roundRect(x, y, max(3 * mm, w * pct), 3.5 * mm, 1.5 * mm, fill=1, stroke=0)


def draw_table(pdf: canvas.Canvas, x: float, y: float, col_widths: list[float], headers: list[str], rows: list[list[str]], row_h: float = 8 * mm) -> float:
    total_w = sum(col_widths)
    pdf.setFillColor(colors.HexColor("#eef5ff"))
    pdf.setStrokeColor(LINE)
    pdf.roundRect(x, y - row_h, total_w, row_h, 2 * mm, fill=1, stroke=1)
    cursor_x = x
    pdf.setFillColor(INK)
    pdf.setFont("Helvetica-Bold", 7.2)
    for index, header in enumerate(headers):
        pdf.drawString(cursor_x + 2 * mm, y - 5.2 * mm, header)
        cursor_x += col_widths[index]
    y -= row_h
    pdf.setFont("Helvetica", 7.1)
    for row_index, row in enumerate(rows):
        if y - row_h < 18 * mm:
            break
        pdf.setFillColor(colors.white if row_index % 2 == 0 else SURFACE)
        pdf.rect(x, y - row_h, total_w, row_h, fill=1, stroke=0)
        pdf.setStrokeColor(LINE)
        pdf.line(x, y - row_h, x + total_w, y - row_h)
        cursor_x = x
        pdf.setFillColor(INK)
        for index, value in enumerate(row):
            text = safe_text(value)
            max_chars = max(6, int(col_widths[index] / 4.1))
            if len(text) > max_chars:
                text = text[: max_chars - 1] + "."
            pdf.drawString(cursor_x + 2 * mm, y - 5.2 * mm, text)
            cursor_x += col_widths[index]
        y -= row_h
    return y


def build_operations_pdf(dashboard: dict, attendance: dict, generated_by: str) -> bytes:
    buffer = BytesIO()
    pdf = canvas.Canvas(buffer, pagesize=PAGE_SIZE)
    company = safe_text(dashboard.get("company", {}).get("name") or attendance.get("company", {}).get("name"), "VYNTRA")
    filters = dashboard.get("filters", {})
    period = f"{fmt_date(filters.get('date_from'))} - {fmt_date(filters.get('date_to'))}"
    subtitle = f"{company} | Periodo {period} | Generado por {safe_text(generated_by, 'panel')}"
    totals = dashboard.get("totals", {})

    draw_page_header(pdf, "Reporte operativo VYNTRA", subtitle, 1)
    pdf.setFillColor(SURFACE)
    pdf.rect(0, 0, PAGE_W, PAGE_H - 26 * mm, fill=1, stroke=0)

    card_y = PAGE_H - 57 * mm
    gap = 5 * mm
    card_w = (PAGE_W - 2 * MARGIN - 3 * gap) / 4
    cards = [
        ("Productividad", fmt_pct(totals.get("productivity_pct")), fmt_duration(totals.get("productive_seconds", 0)), tone_for_pct(totals.get("productivity_pct", 0))),
        ("Aceptable", fmt_pct(totals.get("acceptable_pct")), "Productivo + neutral", tone_for_pct(totals.get("acceptable_pct", 0))),
        ("No productivo", fmt_pct(totals.get("non_productive_pct")), fmt_duration(totals.get("non_productive_seconds", 0)), BAD if totals.get("non_productive_pct", 0) > 12 else BLUE),
        ("Idle", fmt_pct(totals.get("idle_pct")), fmt_duration(totals.get("idle_seconds", 0)), WARN if totals.get("idle_pct", 0) > 15 else BLUE),
    ]
    for index, card in enumerate(cards):
        draw_card(pdf, MARGIN + index * (card_w + gap), card_y, card_w, 31 * mm, *card)

    left_x = MARGIN
    right_x = PAGE_W / 2 + 4 * mm
    section_y = card_y - 14 * mm
    draw_section_title(pdf, left_x, section_y, "Composicion de tiempo", fmt_duration(totals.get("active_seconds", 0)))
    total_active = int(totals.get("active_seconds") or 0)
    bar_y = section_y - 11 * mm
    draw_progress(pdf, left_x, bar_y, PAGE_W / 2 - MARGIN - 8 * mm, "Productivo", int(totals.get("productive_seconds") or 0), total_active, GOOD)
    draw_progress(pdf, left_x, bar_y - 10 * mm, PAGE_W / 2 - MARGIN - 8 * mm, "Neutral", int(totals.get("neutral_seconds") or 0), total_active, CYAN)
    draw_progress(pdf, left_x, bar_y - 20 * mm, PAGE_W / 2 - MARGIN - 8 * mm, "No productivo", int(totals.get("non_productive_seconds") or 0), total_active, BAD)
    draw_progress(pdf, left_x, bar_y - 30 * mm, PAGE_W / 2 - MARGIN - 8 * mm, "Justificado", int(totals.get("justified_seconds") or 0), total_active, WARN)

    days = (dashboard.get("days") or [])[-14:]
    draw_section_title(pdf, right_x, section_y, "Tendencia diaria", f"{len(days)} dias")
    chart_x = right_x
    chart_y = section_y - 40 * mm
    chart_w = PAGE_W - MARGIN - right_x
    chart_h = 34 * mm
    pdf.setStrokeColor(LINE)
    pdf.setFillColor(colors.white)
    pdf.roundRect(chart_x, chart_y, chart_w, chart_h, 3 * mm, fill=1, stroke=1)
    if days:
        max_bar = max(100, max(float(day.get("productivity_pct") or 0) for day in days))
        slot = chart_w / len(days)
        for index, day in enumerate(days):
            value = float(day.get("productivity_pct") or 0)
            bar_h = max(1.8 * mm, (chart_h - 12 * mm) * value / max_bar)
            x = chart_x + index * slot + slot * 0.24
            y = chart_y + 7 * mm
            pdf.setFillColor(tone_for_pct(value))
            pdf.roundRect(x, y, slot * 0.52, bar_h, 1.2 * mm, fill=1, stroke=0)
        pdf.setFillColor(MUTED)
        pdf.setFont("Helvetica", 7)
        pdf.drawString(chart_x + 4 * mm, chart_y + 2.5 * mm, "Productividad por dia")

    table_y = chart_y - 12 * mm
    draw_section_title(pdf, MARGIN, table_y, "Resumen diario", "Ultimos registros del periodo")
    day_rows = [
        [
            fmt_date(day.get("block_date")),
            fmt_duration(day.get("active_seconds", 0)),
            fmt_pct(day.get("productivity_pct", 0)),
            fmt_duration(day.get("non_productive_seconds", 0)),
            fmt_duration(day.get("justified_seconds", 0)),
            fmt_duration(day.get("break_seconds", 0) + day.get("lunch_seconds", 0)),
        ]
        for day in list(reversed(days[-10:]))
    ]
    draw_table(
        pdf,
        MARGIN,
        table_y - 5 * mm,
        [31 * mm, 34 * mm, 34 * mm, 42 * mm, 39 * mm, 38 * mm],
        ["Fecha", "Activo", "Productividad", "No productivo", "Justificado", "Break/Lunch"],
        day_rows or [["Sin datos", "-", "-", "-", "-", "-"]],
    )
    draw_footer(pdf)
    pdf.showPage()

    draw_page_header(pdf, "Asistencia y jornada", subtitle, 2)
    pdf.setFillColor(SURFACE)
    pdf.rect(0, 0, PAGE_W, PAGE_H - 26 * mm, fill=1, stroke=0)

    employees = attendance.get("employees") or []
    shifts = attendance.get("shifts") or []
    started = [shift for shift in shifts if shift.get("started_at")]
    finished = [shift for shift in shifts if shift.get("ended_at") or shift.get("status") == "closed"]
    total_work = sum(worked_seconds(shift) for shift in shifts)
    active_now = len([shift for shift in shifts if shift.get("started_at") and not shift.get("ended_at") and shift.get("status") != "closed"])
    attendance_cards = [
        ("Empleados", str(len(employees)), "Incluidos en el filtro", BLUE),
        ("Jornadas", str(len(started)), "Con entrada registrada", GOOD),
        ("Finalizadas", str(len(finished)), "Con salida o cierre", BLUE),
        ("Activas", str(active_now), "Actualmente abiertas", WARN if active_now else BLUE),
    ]
    for index, card in enumerate(attendance_cards):
        draw_card(pdf, MARGIN + index * (card_w + gap), card_y, card_w, 31 * mm, *card)

    draw_section_title(pdf, MARGIN, section_y, "Resumen de asistencia", f"Tiempo trabajado {fmt_duration(total_work)}")
    employee_lookup = {employee.get("id"): employee for employee in employees}
    by_employee: dict[str, dict] = {}
    for shift in shifts:
        employee_id = shift.get("employee_id")
        row = by_employee.setdefault(
            employee_id,
            {
                "employee": safe_text(employee_lookup.get(employee_id, {}).get("full_name"), "Sin empleado"),
                "department": safe_text(employee_lookup.get(employee_id, {}).get("department"), "General"),
                "shifts": 0,
                "work": 0,
                "breaks": 0,
                "justified": 0,
            },
        )
        row["shifts"] += 1 if shift.get("started_at") else 0
        row["work"] += worked_seconds(shift)
        row["breaks"] += int(shift.get("break_seconds") or 0) + int(shift.get("lunch_seconds") or 0)
        row["justified"] += int(shift.get("justified_seconds") or 0)
    top_employees = sorted(by_employee.values(), key=lambda row: row["work"], reverse=True)[:8]
    draw_table(
        pdf,
        MARGIN,
        section_y - 5 * mm,
        [65 * mm, 44 * mm, 26 * mm, 34 * mm, 34 * mm, 34 * mm],
        ["Empleado", "Departamento", "Jornadas", "Trabajado", "Break/Lunch", "Justificado"],
        [
            [
                row["employee"],
                row["department"],
                str(row["shifts"]),
                fmt_duration(row["work"]),
                fmt_duration(row["breaks"]),
                fmt_duration(row["justified"]),
            ]
            for row in top_employees
        ]
        or [["Sin datos", "-", "-", "-", "-", "-"]],
    )

    draw_footer(pdf)
    pdf.showPage()

    shifts_page_count = min(18, len(shifts))
    draw_page_header(pdf, "Detalle de jornadas", subtitle, 3)
    pdf.setFillColor(SURFACE)
    pdf.rect(0, 0, PAGE_W, PAGE_H - 26 * mm, fill=1, stroke=0)
    details_y = PAGE_H - 43 * mm
    draw_section_title(pdf, MARGIN, details_y, "Jornadas recientes", f"{shifts_page_count} registros recientes")
    detail_rows = []
    for shift in shifts[:18]:
        employee = employee_lookup.get(shift.get("employee_id"), {})
        detail_rows.append(
            [
                fmt_date(shift.get("shift_date")),
                safe_text(employee.get("full_name"), "Sin empleado"),
                fmt_datetime(shift.get("started_at"))[-5:] if shift.get("started_at") else "-",
                fmt_datetime(shift.get("ended_at"))[-5:] if shift.get("ended_at") else "-",
                fmt_duration(worked_seconds(shift)),
                safe_text(shift.get("status"), "-"),
            ]
        )
    draw_table(
        pdf,
        MARGIN,
        details_y - 5 * mm,
        [28 * mm, 83 * mm, 26 * mm, 26 * mm, 38 * mm, 34 * mm],
        ["Fecha", "Empleado", "Entrada", "Salida", "Trabajado", "Estado"],
        detail_rows or [["Sin datos", "-", "-", "-", "-", "-"]],
    )
    draw_footer(pdf)
    pdf.save()
    return buffer.getvalue()
