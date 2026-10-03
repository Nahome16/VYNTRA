"""
reports.py - PDF report builders for VYNTRA.
"""

from __future__ import annotations

from datetime import datetime, timezone
from io import BytesIO
from pathlib import Path

from reportlab.lib import colors
from reportlab.lib.pagesizes import A4, landscape
from reportlab.lib.units import mm
from reportlab.lib.utils import simpleSplit
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


def workday_seconds(shift: dict, now: datetime | None = None) -> int:
    started_at = shift.get("started_at")
    if started_at:
        try:
            start = datetime.fromisoformat(str(started_at).replace("Z", "+00:00"))
            end_value = shift.get("ended_at")
            end = (
                datetime.fromisoformat(str(end_value).replace("Z", "+00:00"))
                if end_value
                else now or datetime.now(start.tzinfo)
            )
            return max(0, int((end - start).total_seconds()))
        except (TypeError, ValueError):
            pass

    return max(
        0,
        int(shift.get("work_seconds") or 0)
        + int(shift.get("break_seconds") or 0)
        + int(shift.get("lunch_seconds") or 0),
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
        ("Productividad", fmt_pct(totals.get("productivity_pct")), "Productivo + neutral", tone_for_pct(totals.get("productivity_pct", 0))),
        ("Neutral", fmt_pct(totals.get("neutral_pct")), fmt_duration(totals.get("neutral_seconds", 0)), BLUE),
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
    total_work = sum(workday_seconds(shift) for shift in shifts)
    active_now = len([shift for shift in shifts if shift.get("started_at") and not shift.get("ended_at") and shift.get("status") != "closed"])
    attendance_cards = [
        ("Empleados", str(len(employees)), "Incluidos en el filtro", BLUE),
        ("Jornadas", str(len(started)), "Con entrada registrada", GOOD),
        ("Finalizadas", str(len(finished)), "Con salida o cierre", BLUE),
        ("Activas", str(active_now), "Actualmente abiertas", WARN if active_now else BLUE),
    ]
    for index, card in enumerate(attendance_cards):
        draw_card(pdf, MARGIN + index * (card_w + gap), card_y, card_w, 31 * mm, *card)

    draw_section_title(pdf, MARGIN, section_y, "Resumen de asistencia", f"Jornada total {fmt_duration(total_work)}")
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
        row["work"] += workday_seconds(shift)
        row["breaks"] += int(shift.get("break_seconds") or 0) + int(shift.get("lunch_seconds") or 0)
        row["justified"] += int(shift.get("justified_seconds") or 0)
    top_employees = sorted(by_employee.values(), key=lambda row: row["work"], reverse=True)[:8]
    draw_table(
        pdf,
        MARGIN,
        section_y - 5 * mm,
        [65 * mm, 44 * mm, 26 * mm, 34 * mm, 34 * mm, 34 * mm],
        ["Empleado", "Departamento", "Jornadas", "Jornada", "Break/Lunch", "Justificado"],
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
                fmt_duration(workday_seconds(shift)),
                safe_text(shift.get("status"), "-"),
            ]
        )
    draw_table(
        pdf,
        MARGIN,
        details_y - 5 * mm,
        [28 * mm, 83 * mm, 26 * mm, 26 * mm, 38 * mm, 34 * mm],
        ["Fecha", "Empleado", "Entrada", "Salida", "Jornada", "Estado"],
        detail_rows or [["Sin datos", "-", "-", "-", "-", "-"]],
    )
    draw_footer(pdf)
    pdf.save()
    return buffer.getvalue()


# --- Factura (PDF descargable) ------------------------------------------------
# Mismo diseno que el correo (docs/factura/factura-correo.html), en A4 vertical.

INVOICE_PAGE_W, INVOICE_PAGE_H = A4
INVOICE_MARGIN = 18 * mm
INV_INK = colors.HexColor("#0b0d12")
INV_INK_SOFT = colors.HexColor("#344054")
INV_MUTED = colors.HexColor("#5f6878")
INV_FAINT = colors.HexColor("#98a2b3")
INV_LINE = colors.HexColor("#e4e7ec")
INV_LINE_STRONG = colors.HexColor("#d0d5dd")
INV_SOFT_BG = colors.HexColor("#f9fafb")
INV_BLACK = colors.HexColor("#0a0a0a")
INV_BLUE = colors.HexColor("#2563eb")
INV_WARN_BG = colors.HexColor("#fffaeb")
INV_WARN = colors.HexColor("#b54708")
INVOICE_LOGO = Path(__file__).resolve().parent / "assets" / "vyntra-wordmark-white.png"


def _label(pdf: canvas.Canvas, x: float, y: float, text: str) -> None:
    pdf.setFont("Helvetica-Bold", 7.5)
    pdf.setFillColor(INV_FAINT)
    pdf.drawString(x, y, text.upper())


def _fit(pdf: canvas.Canvas, text: str, font: str, size: float, max_width: float) -> str:
    """Recorta con puntos suspensivos si el texto no cabe en el ancho dado."""
    if pdf.stringWidth(text, font, size) <= max_width:
        return text
    while text and pdf.stringWidth(text + "...", font, size) > max_width:
        text = text[:-1]
    return text + "..."


def build_invoice_pdf(doc: dict) -> bytes:
    """Genera el PDF de una factura a partir de los textos ya formateados por el backend."""
    buffer = BytesIO()
    pdf = canvas.Canvas(buffer, pagesize=A4)
    pdf.setTitle(f"Factura {doc['number']} - VYNTRA")
    pdf.setAuthor("VYNTRA")
    pdf.setSubject(f"Factura {doc['number']} {doc['period_label']}")
    width, height = INVOICE_PAGE_W, INVOICE_PAGE_H
    left = INVOICE_MARGIN
    right = width - INVOICE_MARGIN
    content_w = right - left

    # Encabezado negro con logotipo y numero.
    header_h = 30 * mm
    pdf.setFillColor(INV_BLACK)
    pdf.rect(0, height - header_h, width, header_h, fill=1, stroke=0)
    logo_w = 44 * mm
    logo_h = logo_w * 96 / 600
    if INVOICE_LOGO.exists():
        pdf.drawImage(str(INVOICE_LOGO), left, height - header_h / 2 - logo_h / 2, logo_w, logo_h, mask="auto")
    else:
        pdf.setFont("Helvetica-Bold", 18)
        pdf.setFillColor(colors.white)
        pdf.drawString(left, height - header_h / 2 - 6, "VYNTRA")
    pdf.setFont("Helvetica", 8)
    pdf.setFillColor(colors.HexColor("#a3a9b6"))
    pdf.drawRightString(right, height - header_h / 2 + 4, "FACTURA")
    pdf.setFont("Helvetica-Bold", 12)
    pdf.setFillColor(colors.white)
    pdf.drawRightString(right, height - header_h / 2 - 9, doc["number"])

    y = height - header_h - 14 * mm
    pdf.setFont("Helvetica", 10)
    pdf.setFillColor(INV_INK_SOFT)
    intro = f"Factura de {doc['company_name']} por el servicio VYNTRA del periodo {doc['period_long']}."
    for index, text_line in enumerate(simpleSplit(intro, "Helvetica", 10, content_w)[:2]):
        if index:
            y -= 5 * mm
        pdf.drawString(left, y, text_line)

    # Bloque principal: monto y fecha limite.
    box_h = 30 * mm
    y -= 8 * mm
    box_y = y - box_h
    pdf.setStrokeColor(INV_LINE)
    pdf.setLineWidth(0.8)
    pdf.roundRect(left, box_y, content_w, box_h, 4 * mm, fill=0, stroke=1)
    pdf.setFont("Helvetica-Bold", 8.5)
    pdf.setFillColor(INV_MUTED)
    pdf.drawString(left + 7 * mm, box_y + box_h - 9 * mm, "Monto a pagar")
    pdf.drawRightString(right - 7 * mm, box_y + box_h - 9 * mm, "Fecha l\u00edmite de pago")
    pdf.setFont("Helvetica-Bold", 12)
    pdf.drawString(left + 7 * mm, box_y + 8 * mm, doc["currency"])
    currency_w = pdf.stringWidth(doc["currency"] + " ", "Helvetica-Bold", 12)
    pdf.setFont("Helvetica-Bold", 26)
    pdf.setFillColor(INV_INK)
    pdf.drawString(left + 7 * mm + currency_w, box_y + 8 * mm, doc["total_amount"])
    pdf.setFont("Helvetica-Bold", 13)
    pdf.drawRightString(right - 7 * mm, box_y + box_h - 16 * mm, doc["due_weekday_short"])
    pill = doc["due_days_text"] + " para pagar"
    pdf.setFont("Helvetica-Bold", 8)
    pill_w = pdf.stringWidth(pill, "Helvetica-Bold", 8) + 7 * mm
    pdf.setFillColor(INV_WARN_BG)
    pdf.roundRect(right - 7 * mm - pill_w, box_y + 5.5 * mm, pill_w, 6 * mm, 3 * mm, fill=1, stroke=0)
    pdf.setFillColor(INV_WARN)
    pdf.drawRightString(right - 7 * mm - 3.5 * mm, box_y + 7.6 * mm, pill)

    # Facturado a / Detalles.
    y = box_y - 12 * mm
    col_w = content_w / 2 - 6 * mm
    details_x = left + content_w / 2 + 6 * mm
    _label(pdf, left, y, "Facturado a")
    _label(pdf, details_x, y, "Detalles")
    line_y = y - 6 * mm
    pdf.setFont("Helvetica-Bold", 10)
    pdf.setFillColor(INV_INK)
    pdf.drawString(left, line_y, _fit(pdf, doc["company_name"], "Helvetica-Bold", 10, col_w))
    pdf.setFont("Helvetica", 9.5)
    pdf.setFillColor(INV_INK_SOFT)
    for recipient in doc["recipients"][:4]:
        for text_value in (recipient.get("full_name"), recipient.get("email")):
            if text_value:
                line_y -= 5 * mm
                pdf.drawString(left, line_y, _fit(pdf, text_value, "Helvetica", 9.5, col_w))
    detail_y = y - 6 * mm
    for label, value in (
        ("Emisi\u00f3n", doc["issued_short"]),
        ("Periodo", doc["period_label"]),
        ("Vencimiento", doc["due_short"]),
        ("Moneda", doc["currency_label"]),
    ):
        pdf.setFont("Helvetica", 9.5)
        pdf.setFillColor(INV_INK_SOFT)
        pdf.drawString(details_x, detail_y, label)
        pdf.setFont("Helvetica-Bold", 9.5)
        pdf.setFillColor(INV_INK)
        pdf.drawRightString(right, detail_y, value)
        detail_y -= 5 * mm

    # Detalle del cobro.
    y = min(line_y, detail_y) - 10 * mm
    cols = [right - 62 * mm, right - 30 * mm, right]
    _label(pdf, left, y, "Descripci\u00f3n")
    pdf.setFont("Helvetica-Bold", 7.5)
    pdf.setFillColor(INV_FAINT)
    pdf.drawRightString(cols[0], y, "CANT.")
    pdf.drawRightString(cols[1], y, "PRECIO UNIT.")
    pdf.drawRightString(cols[2], y, "IMPORTE")
    y -= 3 * mm
    pdf.setStrokeColor(INV_LINE_STRONG)
    pdf.line(left, y, right, y)
    y -= 7 * mm
    pdf.setFont("Helvetica-Bold", 10)
    pdf.setFillColor(INV_INK)
    pdf.drawString(left, y, "Licencia VYNTRA por usuario monitoreado")
    pdf.setFont("Helvetica", 10)
    pdf.drawRightString(cols[0], y, str(doc["active_users"]))
    pdf.drawRightString(cols[1], y, doc["unit_money"])
    pdf.setFont("Helvetica-Bold", 10)
    pdf.drawRightString(cols[2], y, doc["subtotal_money"])
    pdf.setFont("Helvetica", 8.5)
    pdf.setFillColor(INV_MUTED)
    pdf.drawString(left, y - 4.5 * mm, doc["line_detail"])
    y -= 10 * mm
    pdf.setStrokeColor(INV_LINE)
    pdf.line(left, y, right, y)

    # Totales.
    totals_x = left + content_w * 0.5
    y -= 7 * mm
    for label, value, strong in (
        ("Subtotal", doc["subtotal_money"], False),
        ("IVA (no aplica)", doc["tax_money"], False),
    ):
        pdf.setFont("Helvetica", 9.5)
        pdf.setFillColor(INV_INK_SOFT)
        pdf.drawString(totals_x, y, label)
        pdf.setFillColor(INV_INK)
        pdf.drawRightString(right, y, value)
        y -= 6 * mm
    pdf.setStrokeColor(INV_LINE)
    pdf.line(totals_x, y + 3 * mm, right, y + 3 * mm)
    y -= 3 * mm
    pdf.setFont("Helvetica-Bold", 11)
    pdf.setFillColor(INV_INK)
    pdf.drawString(totals_x, y, "Total a pagar")
    pdf.setFont("Helvetica-Bold", 13)
    pdf.drawRightString(right, y, doc["total_money"])

    # Como pagar.
    rows = doc["payment_rows"]
    pay_rows = len(rows) + 2 if rows else 1
    pay_h = (12 + pay_rows * 5.2 + 10) * mm
    y -= 12 * mm
    pay_y = y - pay_h
    pdf.setFillColor(INV_SOFT_BG)
    pdf.setStrokeColor(INV_LINE)
    pdf.roundRect(left, pay_y, content_w, pay_h, 4 * mm, fill=1, stroke=1)
    row_y = pay_y + pay_h - 9 * mm
    pdf.setFont("Helvetica-Bold", 10)
    pdf.setFillColor(INV_INK)
    pdf.drawString(left + 6 * mm, row_y, "C\u00f3mo pagar")
    row_y -= 7 * mm
    payment_lines = ([("M\u00e9todo", "Transferencia bancaria")] + rows + [("Referencia", doc["number"])]) if rows else []
    for label, value in payment_lines:
        pdf.setFont("Helvetica", 9.5)
        pdf.setFillColor(INV_MUTED)
        pdf.drawString(left + 6 * mm, row_y, label)
        pdf.setFont("Helvetica-Bold", 9.5)
        pdf.setFillColor(INV_BLUE if label == "Referencia" else INV_INK)
        pdf.drawRightString(right - 6 * mm, row_y, value)
        row_y -= 5.2 * mm
    pdf.setFont("Helvetica", 8.5)
    pdf.setFillColor(INV_MUTED)
    if rows:
        pdf.drawString(
            left + 6 * mm,
            row_y - 1 * mm,
            f"Escribe el n\u00famero de factura como referencia y env\u00eda el comprobante a {doc['contact_email']}.",
        )
    else:
        pdf.drawString(left + 6 * mm, row_y, "Te enviaremos los datos de pago por separado.")

    # Condiciones.
    y = pay_y - 10 * mm
    _label(pdf, left, y, "Condiciones")
    pdf.setFont("Helvetica", 9)
    pdf.setFillColor(INV_MUTED)
    for item in (
        f"Se cobran {doc['unit_money']} por cada usuario monitoreado activo durante el periodo.",
        "Esta factura no incluye IVA.",
        f"El pago vence {doc['due_days_text']} despu\u00e9s de la fecha de emisi\u00f3n.",
        f"Pr\u00f3ximo periodo de facturaci\u00f3n: {doc['next_period_long']}.",
    ):
        y -= 5.5 * mm
        pdf.drawString(left + 3 * mm, y, "\u2022")
        pdf.drawString(left + 7 * mm, y, item)

    # Pie.
    pdf.setStrokeColor(INV_LINE)
    pdf.line(left, 22 * mm, right, 22 * mm)
    pdf.setFont("Helvetica", 9)
    pdf.setFillColor(INV_INK_SOFT)
    pdf.drawString(left, 16 * mm, f"\u00bfDudas sobre esta factura? Escr\u00edbenos a {doc['contact_email']}.")
    pdf.setFont("Helvetica", 8)
    pdf.setFillColor(INV_FAINT)
    pdf.drawString(left, 11 * mm, "VYNTRA \u00b7 Managua, Nicaragua")

    pdf.showPage()
    pdf.save()
    return buffer.getvalue()
