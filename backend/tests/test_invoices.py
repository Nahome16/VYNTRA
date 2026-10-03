"""Facturacion mensual a empresas: periodos, importes, correo y endpoints de sistema."""

import dataclasses
from datetime import date, timedelta

from fastapi.testclient import TestClient
import pytest

from app import main
from app.auth import create_admin_access_token, hash_password
from app.main import (
    add_business_days,
    app,
    billing_period_for,
    billing_periods_until,
    current_billing_period,
    default_billing_period_start,
    ensure_company_roles,
    format_date_long,
    format_date_weekday_short,
    format_money,
    format_period_label,
    format_period_long,
    invoice_amounts,
    invoice_delivery_status,
    latest_undelivered_closed_period,
    next_invoice_number,
    render_invoice_email,
)
from app.models import AdminSession, AuditLog, Company, Employee, Invoice, User, now_utc

START = date(2026, 9, 15)
EN_DASH = chr(0x2013)
E_ACUTE = chr(0xE9)
MIDDOT = chr(0xB7)


# --- Helpers puros -----------------------------------------------------------


def test_period_math_before_and_after_first_close():
    assert billing_period_for(date(2026, 10, 3), START) == (date(2026, 9, 15), date(2026, 10, 14))
    assert current_billing_period(date(2026, 10, 3), START) == (date(2026, 9, 15), date(2026, 10, 14))
    assert billing_periods_until(date(2026, 10, 3), START) == [(date(2026, 9, 15), date(2026, 10, 14))]

    periods = billing_periods_until(date(2026, 10, 15), START)
    assert periods == [
        (date(2026, 10, 15), date(2026, 11, 14)),
        (date(2026, 9, 15), date(2026, 10, 14)),
    ]
    # 2026-10-15: el periodo 09-15..10-14 ya esta cerrado; el 10-15..11-14 es el abierto.
    assert periods[1][1] < date(2026, 10, 15) <= periods[0][1]


def test_period_math_edges():
    # Antes del inicio de facturacion solo existe el primer periodo (abierto).
    assert billing_periods_until(date(2026, 8, 1), START) == [(date(2026, 9, 15), date(2026, 10, 14))]
    # Cambio de anio.
    assert billing_period_for(date(2027, 1, 3), START) == (date(2026, 12, 15), date(2027, 1, 14))
    assert billing_period_for(date(2026, 12, 15), START) == (date(2026, 12, 15), date(2027, 1, 14))


def test_default_and_pending_period():
    today = date(2026, 11, 20)
    periods = billing_periods_until(today, START)
    assert [p[0] for p in periods] == [date(2026, 11, 15), date(2026, 10, 15), date(2026, 9, 15)]
    assert default_billing_period_start(periods, {}, today) == date(2026, 10, 15)
    assert latest_undelivered_closed_period(periods, {"2026-10-15": "sent"}, today) == (
        date(2026, 9, 15),
        date(2026, 10, 14),
    )
    delivered = {"2026-10-15": "sent", "2026-09-15": "partial"}
    assert latest_undelivered_closed_period(periods, delivered, today) is None
    assert default_billing_period_start(periods, delivered, today) == date(2026, 10, 15)
    # Sin periodos cerrados se sugiere el abierto.
    open_only = billing_periods_until(date(2026, 10, 3), START)
    assert default_billing_period_start(open_only, {}, date(2026, 10, 3)) == date(2026, 9, 15)


def test_business_days():
    assert add_business_days(date(2026, 10, 15), 4) == date(2026, 10, 21)  # jueves -> miercoles
    assert add_business_days(date(2026, 10, 16), 4) == date(2026, 10, 22)  # viernes -> jueves
    assert add_business_days(date(2026, 10, 17), 4) == date(2026, 10, 22)  # sabado -> jueves


def test_amounts_and_formatting():
    assert invoice_amounts(7, 1500) == {"subtotal_cents": 10500, "tax_cents": 0, "total_cents": 10500}
    assert format_money(10500, "USD") == "USD 105.00"
    assert format_money(123456789, "USD") == "USD 1,234,567.89"
    assert format_period_label(date(2026, 9, 15), date(2026, 10, 14)) == f"15 sep. {EN_DASH} 14 oct. 2026"
    assert format_period_label(date(2026, 12, 15), date(2027, 1, 14)) == f"15 dic. 2026 {EN_DASH} 14 ene. 2027"
    assert format_period_long(date(2026, 9, 15), date(2026, 10, 14)) == "15 de septiembre al 14 de octubre de 2026"
    assert format_date_weekday_short(date(2026, 10, 21)) == f"Mi{E_ACUTE}. 21 oct. 2026"
    assert format_date_long(date(2026, 10, 21), with_weekday=True) == f"mi{E_ACUTE}rcoles 21 de octubre de 2026"
    assert invoice_delivery_status(["sent", "sent"]) == "sent"
    assert invoice_delivery_status(["sent", "failed"]) == "partial"
    assert invoice_delivery_status(["not_configured"]) == "not_configured"
    assert invoice_delivery_status(["failed"]) == "failed"


def _render(**overrides):
    values = dict(
        number="VYN-202610-0001",
        company_name="Cliente Uno S.A.",
        period_start=date(2026, 9, 15),
        period_end=date(2026, 10, 14),
        issued_on=date(2026, 10, 15),
        due_on=date(2026, 10, 21),
        active_users=7,
        unit_price_cents=1500,
        subtotal_cents=10500,
        tax_cents=0,
        total_cents=10500,
        currency="USD",
        recipients=[{"email": "olga@cliente.test", "full_name": "Olga Owner"}],
    )
    values.update(overrides)
    return render_invoice_email(**values)


def test_render_invoice_email_without_bank_data():
    subject, html, plain = _render()
    assert subject == f"Factura VYN-202610-0001 {MIDDOT} VYNTRA {MIDDOT} 15 sep. {EN_DASH} 14 oct. 2026"
    assert "Hola, Olga Owner:" in html
    assert "USD</span> 105.00" in html
    assert "7 usuarios activos" in html
    assert "Te enviaremos los datos de pago por separado." in html
    assert "Transferencia bancaria" not in html
    assert "15 de octubre al 14 de noviembre de 2026" in html  # siguiente periodo
    assert "mailto:notificaciones@vyntralab.com?subject=Pago%20factura%20VYN-202610-0001" in html
    assert "VYN-202610-0001" in plain and "USD 105.00" in plain
    assert "$" not in html


def test_render_invoice_email_with_bank_rows_and_escaping(monkeypatch):
    monkeypatch.setattr(
        main,
        "settings",
        dataclasses.replace(main.settings, billing_bank_name="Banco Prueba", billing_iban="XX00 TEST 0001"),
    )
    _subject, html, plain = _render(
        company_name="<b>Hack</b> & Co",
        recipients=[
            {"email": "a@cliente.test", "full_name": "Ana"},
            {"email": "b@cliente.test", "full_name": "Beto"},
        ],
    )
    assert "Banco Prueba" in html and "XX00 TEST 0001" in html
    assert "Transferencia bancaria" in html
    assert "Te enviaremos" not in html
    assert "<b>Hack</b>" not in html
    assert "&lt;b&gt;Hack&lt;/b&gt; &amp; Co" in html
    assert "Hola, equipo de &lt;b&gt;Hack&lt;/b&gt; &amp; Co:" in html
    assert "Banco: Banco Prueba" in plain


def test_invoice_number_sequence(db):
    company = Company(name="Secuencia Co")
    db.add(company)
    db.flush()
    assert next_invoice_number(db, date(2026, 10, 14)) == "VYN-202610-0001"
    db.add(
        Invoice(
            company_id=company.id,
            number="VYN-202610-0001",
            period_start="2026-09-15",
            period_end="2026-10-14",
            issued_on="2026-10-15",
            due_on="2026-10-21",
        )
    )
    db.flush()
    assert next_invoice_number(db, date(2026, 10, 14)) == "VYN-202610-0002"
    assert next_invoice_number(db, date(2026, 11, 14)) == "VYN-202611-0001"


# --- Endpoints ----------------------------------------------------------------


def _session_token(db, user: User, role_name: str) -> str:
    session = AdminSession(user_id=user.id, company_id=user.company_id, expires_at=now_utc() + timedelta(hours=1))
    db.add(session)
    db.flush()
    return create_admin_access_token(user, role_name, session.id)


def _user(db, company: Company, role, email: str, full_name: str, status: str = "active") -> User:
    user = User(
        company_id=company.id,
        role_id=role.id,
        email=email,
        full_name=full_name,
        password_hash=hash_password("Temporal-123"),
        status=status,
    )
    db.add(user)
    db.flush()
    return user


@pytest.fixture()
def billing(db, monkeypatch):
    system_company = Company(name="VYNTRA Sistema")
    db.add(system_company)
    db.flush()
    system_roles = ensure_company_roles(db, system_company.id)
    system_user = _user(db, system_company, system_roles["system_admin"], "sistema@vyntra.test", "Sistema")

    company = Company(name="Cliente Uno", legal_name="Cliente Uno S.A.", timezone="America/Managua")
    db.add(company)
    db.flush()
    roles = ensure_company_roles(db, company.id)
    _user(db, company, roles["owner"], "olga@cliente.test", "Olga Owner")
    company_admin = _user(db, company, roles["admin"], "adan@cliente.test", "Adan Admin")
    _user(db, company, roles["viewer"], "vera@cliente.test", "Vera Viewer")
    _user(db, company, roles["admin"], "viejo@cliente.test", "Admin Archivado", status="archived")
    for index in range(7):
        db.add(Employee(company_id=company.id, employee_code=f"EMP-{index}", full_name=f"Empleado {index}"))
    db.add(Employee(company_id=company.id, employee_code="EMP-X", full_name="Archivado", status="archived"))

    system_token = _session_token(db, system_user, "system_admin")
    company_token = _session_token(db, company_admin, "admin")
    db.commit()

    state = {"today": date(2026, 10, 15)}
    monkeypatch.setattr(main, "billing_today", lambda _company: state["today"])
    return {
        "client": TestClient(app),  # sin "with": no ejecuta el evento de arranque
        "headers": {"Authorization": f"Bearer {system_token}"},
        "company_headers": {"Authorization": f"Bearer {company_token}"},
        "company_id": company.id,
        "system_user_id": system_user.id,
        "state": state,
    }


def test_billing_overview_shape(billing):
    client, headers, company_id = billing["client"], billing["headers"], billing["company_id"]
    response = client.get(f"/api/system/companies/{company_id}/billing", headers=headers)
    assert response.status_code == 200
    data = response.json()
    assert data["company"] == {"id": company_id, "name": "Cliente Uno", "legal_name": "Cliente Uno S.A."}
    assert data["settings"] == {
        "unit_price_cents": 1500,
        "currency": "USD",
        "due_business_days": 4,
        "billing_start": "2026-09-15",
        "payment_configured": False,
        "contact_email": "notificaciones@vyntralab.com",
    }
    assert data["active_users"] == 7
    assert [row["email"] for row in data["recipients"]] == ["olga@cliente.test", "adan@cliente.test"]
    assert data["recipients"][0]["role"] == "owner"
    assert set(data["recipients"][0]) == {"id", "email", "full_name", "role"}
    assert [(p["start"], p["end"], p["status"]) for p in data["periods"]] == [
        ("2026-10-15", "2026-11-14", "open"),
        ("2026-09-15", "2026-10-14", "closed"),
    ]
    assert data["periods"][1]["label"] == f"15 sep. {EN_DASH} 14 oct. 2026"
    assert data["periods"][1]["invoice"] is None
    assert data["default_period_start"] == "2026-09-15"
    assert data["invoices"] == []

    missing = client.get("/api/system/companies/no-existe/billing", headers=headers)
    assert missing.status_code == 404


def test_preview_does_not_persist(billing, db):
    client, headers, company_id = billing["client"], billing["headers"], billing["company_id"]
    response = client.post(
        f"/api/system/companies/{company_id}/invoices/preview",
        headers=headers,
        json={"period_start": "2026-09-15"},
    )
    assert response.status_code == 200
    data = response.json()
    assert data["invoice"] == {
        "number": "VYN-202610-0001",
        "period_start": "2026-09-15",
        "period_end": "2026-10-14",
        "period_label": f"15 sep. {EN_DASH} 14 oct. 2026",
        "issued_on": "2026-10-15",
        "due_on": "2026-10-21",
        "active_users": 7,
        "unit_price_cents": 1500,
        "subtotal_cents": 10500,
        "tax_cents": 0,
        "total_cents": 10500,
        "currency": "USD",
    }
    assert data["subject"].startswith("Factura VYN-202610-0001")
    assert "Hola, equipo de Cliente Uno S.A.:" in data["html"]
    assert data["recipients"] == [
        {"email": "olga@cliente.test", "full_name": "Olga Owner"},
        {"email": "adan@cliente.test", "full_name": "Adan Admin"},
    ]
    assert data["already_sent"] is False

    override = client.post(
        f"/api/system/companies/{company_id}/invoices/preview",
        headers=headers,
        json={"period_start": "2026-09-15", "active_users": 3, "recipients": ["OLGA@cliente.test"]},
    ).json()
    assert override["invoice"]["total_cents"] == 4500
    assert "Hola, Olga Owner:" in override["html"]
    assert override["recipients"] == [{"email": "olga@cliente.test", "full_name": "Olga Owner"}]

    db.expire_all()
    assert db.query(Invoice).count() == 0
    assert db.query(AuditLog).filter(AuditLog.action == "invoice_sent").count() == 0


def test_send_without_smtp_saves_invoice(billing, db):
    client, headers, company_id = billing["client"], billing["headers"], billing["company_id"]
    response = client.post(
        f"/api/system/companies/{company_id}/invoices/send",
        headers=headers,
        json={"period_start": "2026-09-15"},
    )
    assert response.status_code == 200
    data = response.json()
    invoice = data["invoice"]
    assert invoice["status"] == "not_configured"
    assert invoice["number"] == "VYN-202610-0001"
    assert invoice["total_cents"] == 10500
    assert invoice["send_count"] == 1
    assert invoice["sent_at"]
    assert invoice["sent_by"]["id"] == billing["system_user_id"]
    assert invoice["recipients"] == [
        {"email": "olga@cliente.test", "full_name": "Olga Owner", "status": "not_configured"},
        {"email": "adan@cliente.test", "full_name": "Adan Admin", "status": "not_configured"},
    ]
    assert data["delivery"] == [
        {"email": "olga@cliente.test", "status": "not_configured"},
        {"email": "adan@cliente.test", "status": "not_configured"},
    ]

    db.expire_all()
    assert db.query(Invoice).count() == 1
    audit = db.query(AuditLog).filter(AuditLog.action == "invoice_sent").one()
    assert audit.entity_type == "invoice" and audit.entity_id == invoice["id"]
    assert "VYN-202610-0001" in audit.payload_json

    overview = client.get(f"/api/system/companies/{company_id}/billing", headers=headers).json()
    assert overview["periods"][1]["invoice"]["number"] == "VYN-202610-0001"
    assert overview["invoices"][0]["id"] == invoice["id"]
    # not_configured no cuenta como enviada: el periodo sigue sugerido.
    assert overview["default_period_start"] == "2026-09-15"


def test_resend_same_period_keeps_number(billing, db, monkeypatch):
    calls = []

    def fake_send_email(to_email, subject, body, *, html=None, reply_to=None):
        calls.append({"to": to_email, "subject": subject, "html": html, "reply_to": reply_to})
        return "sent"

    monkeypatch.setattr(main, "send_email", fake_send_email)
    client, headers, company_id = billing["client"], billing["headers"], billing["company_id"]
    url = f"/api/system/companies/{company_id}/invoices/send"

    first = client.post(url, headers=headers, json={"period_start": "2026-09-15"}).json()["invoice"]
    assert first["status"] == "sent"
    assert [call["to"] for call in calls] == ["olga@cliente.test", "adan@cliente.test"]
    assert calls[0]["reply_to"] == "notificaciones@vyntralab.com"
    assert "VYN-202610-0001" in calls[0]["html"]

    second_response = client.post(
        url, headers=headers, json={"period_start": "2026-09-15", "active_users": 9, "recipients": ["adan@cliente.test"]}
    ).json()
    second = second_response["invoice"]
    assert second["id"] == first["id"]
    assert second["number"] == "VYN-202610-0001"
    assert second["send_count"] == 2
    assert second["total_cents"] == 13500
    assert second["recipients"] == [{"email": "adan@cliente.test", "full_name": "Adan Admin", "status": "sent"}]
    assert second_response["delivery"] == [{"email": "adan@cliente.test", "status": "sent"}]

    preview = client.post(
        f"/api/system/companies/{company_id}/invoices/preview", headers=headers, json={"period_start": "2026-09-15"}
    ).json()
    assert preview["already_sent"] is True
    assert preview["invoice"]["number"] == "VYN-202610-0001"

    # Un mes despues: el siguiente periodo usa el prefijo de su mes de cierre.
    billing["state"]["today"] = date(2026, 11, 20)
    third = client.post(url, headers=headers, json={"period_start": "2026-10-15"}).json()["invoice"]
    assert third["number"] == "VYN-202611-0001"
    assert third["issued_on"] == "2026-11-20"
    assert third["due_on"] == "2026-11-26"

    db.expire_all()
    assert db.query(Invoice).count() == 2
    overview = client.get(f"/api/system/companies/{company_id}/billing", headers=headers).json()
    assert [row["number"] for row in overview["invoices"]] == ["VYN-202611-0001", "VYN-202610-0001"]


def test_invalid_period_rejected(billing):
    client, headers, company_id = billing["client"], billing["headers"], billing["company_id"]
    url = f"/api/system/companies/{company_id}/invoices/preview"
    for period_start in ("2026-10-16", "2026-08-15", "2026-11-15", "no-es-fecha"):
        response = client.post(url, headers=headers, json={"period_start": period_start})
        assert response.status_code == 400, period_start
        assert "Periodo invalido" in response.json()["detail"]
    # El periodo abierto si se puede previsualizar.
    assert client.post(url, headers=headers, json={"period_start": "2026-10-15"}).status_code == 200


def test_recipient_not_eligible_rejected(billing):
    client, headers, company_id = billing["client"], billing["headers"], billing["company_id"]
    for email in ("vera@cliente.test", "viejo@cliente.test", "otro@externo.test"):
        response = client.post(
            f"/api/system/companies/{company_id}/invoices/send",
            headers=headers,
            json={"period_start": "2026-09-15", "recipients": [email]},
        )
        assert response.status_code == 400, email
    empty = client.post(
        f"/api/system/companies/{company_id}/invoices/send",
        headers=headers,
        json={"period_start": "2026-09-15", "recipients": []},
    )
    assert empty.status_code == 400
    assert "destinatarios" in empty.json()["detail"]


def test_non_system_admin_forbidden(billing):
    client, headers, company_id = billing["client"], billing["company_headers"], billing["company_id"]
    body = {"period_start": "2026-09-15"}
    assert client.get(f"/api/system/companies/{company_id}/billing", headers=headers).status_code == 403
    assert client.post(f"/api/system/companies/{company_id}/invoices/preview", headers=headers, json=body).status_code == 403
    assert client.post(f"/api/system/companies/{company_id}/invoices/send", headers=headers, json=body).status_code == 403
    assert client.get("/api/system/invoices/cualquiera/html", headers=headers).status_code == 403


def test_invoice_html_endpoint(billing):
    client, headers, company_id = billing["client"], billing["headers"], billing["company_id"]
    invoice = client.post(
        f"/api/system/companies/{company_id}/invoices/send", headers=headers, json={"period_start": "2026-09-15"}
    ).json()["invoice"]
    response = client.get(f"/api/system/invoices/{invoice['id']}/html", headers=headers)
    assert response.status_code == 200
    data = response.json()
    assert data["subject"].startswith("Factura VYN-202610-0001")
    assert "VYN-202610-0001" in data["html"]
    assert "Cliente Uno S.A." in data["html"]
    assert "USD</span> 105.00" in data["html"]
    assert client.get("/api/system/invoices/no-existe/html", headers=headers).status_code == 404


def test_system_overview_billing_reminder(billing, monkeypatch):
    client, headers, company_id = billing["client"], billing["headers"], billing["company_id"]

    def company_billing():
        companies = client.get("/api/system/overview", headers=headers).json()["companies"]
        return next(row for row in companies if row["id"] == company_id)["billing"]

    billing["state"]["today"] = date(2026, 10, 3)
    assert company_billing() == {"pending_period": None, "last_invoice": None}

    billing["state"]["today"] = date(2026, 10, 15)
    assert company_billing()["pending_period"] == {
        "start": "2026-09-15",
        "end": "2026-10-14",
        "label": f"15 sep. {EN_DASH} 14 oct. 2026",
    }

    monkeypatch.setattr(main, "send_email", lambda *args, **kwargs: "sent")
    client.post(f"/api/system/companies/{company_id}/invoices/send", headers=headers, json={"period_start": "2026-09-15"})
    summary = company_billing()
    assert summary["pending_period"] is None
    assert summary["last_invoice"]["number"] == "VYN-202610-0001"
    assert summary["last_invoice"]["status"] == "sent"
    assert summary["last_invoice"]["period_start"] == "2026-09-15"
