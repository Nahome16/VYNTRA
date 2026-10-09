"""La clasificacion en memoria debe ser identica a la implementacion original."""

from datetime import timedelta
import itertools
import random

from fastapi.testclient import TestClient

from app.auth import create_admin_access_token
from app.main import classify_activity, classify_with_rules, load_active_productivity_rules
from app.main import app, get_or_create_app, get_or_create_window_title
from app.models import Activity, AdminSession, Employee, ProductivityRule, Role, User, now_utc


def reference_classify(rules, employee, executable_name, title_text_value):
    """Copia literal del algoritmo original de classify_activity (antes del cambio)."""
    executable = (executable_name or "").strip().lower()
    title_lower = (title_text_value or "").strip().lower()
    matches = []
    for rule in rules:
        if rule.employee_id and rule.employee_id != employee.id:
            continue
        if rule.department_id and rule.department_id != employee.department_id:
            continue
        if rule.position_id and rule.position_id != employee.position_id:
            continue
        if rule.executable_name and rule.executable_name.strip().lower() != executable:
            continue
        if rule.title_contains and rule.title_contains.strip().lower() not in title_lower:
            continue
        scope_score = 0
        if rule.department_id:
            scope_score += 1000
        if rule.position_id:
            scope_score += 2000
        if rule.employee_id:
            scope_score += 3000
        matches.append((scope_score + rule.priority, rule))
    if not matches:
        return "uncategorized"
    _, best = sorted(matches, key=lambda item: item[0], reverse=True)[0]
    if best.classification in {"productive", "non_productive", "neutral"}:
        return best.classification
    return "uncategorized"


def test_in_memory_classification_matches_reference():
    rng = random.Random(1234)
    departments = ["d1", "d2", None]
    positions = ["p1", "p2", None]
    employees = [
        Employee(id=f"e{i}", department_id=d, position_id=p, company_id="c", employee_code=str(i), full_name="x")
        for i, (d, p) in enumerate(itertools.product(["d1", "d2"], ["p1", "p2"]))
    ]
    executables = ["excel.exe", "chrome.exe", "browser", "slack.exe", ""]
    titles = ["Presupuesto 2026", "Facebook - Inicio", "Jira board", "", "(fuera de lista)"]
    classifications = ["productive", "neutral", "non_productive", "uncategorized"]
    rules = []
    for index in range(60):
        rules.append(
            ProductivityRule(
                id=f"r{index}",
                company_id="c",
                department_id=rng.choice(departments),
                position_id=rng.choice(positions),
                employee_id=rng.choice([None, None, None, "e0", "e3"]),
                executable_name=rng.choice(["excel.exe", "CHROME.EXE", "", "browser", "slack.exe"]),
                title_contains=rng.choice(["", "presupuesto", "Facebook", "jira", "zzz"]),
                classification=rng.choice(classifications),
                priority=rng.choice([10, 50, 100, 100, 500]),
                is_active=True,
            )
        )
    for employee in employees:
        for executable in executables:
            for title in titles:
                assert classify_with_rules(rules, employee, executable, title) == reference_classify(
                    rules, employee, executable, title
                )


def test_db_wrapper_uses_same_rules(db):
    from tests.factories import create_company_setup

    company, _department, _position, employee, _device = create_company_setup(db)
    rules = load_active_productivity_rules(db, company.id)
    for executable, title in [
        ("excel.exe", "Presupuesto 2026"),
        ("slack.exe", "(aplicacion permitida)"),
        ("chrome.exe", "facebook"),
        ("notepad.exe", "(fuera de lista)"),
    ]:
        assert classify_activity(db, company.id, employee, executable, title) == reference_classify(
            rules, employee, executable, title
        )
    assert classify_activity(db, company.id, employee, "excel.exe", "Presupuesto") == "productive"
    assert classify_activity(db, company.id, employee, "chrome.exe", "facebook") == "non_productive"


def admin_headers(db, company):
    role = Role(company_id=company.id, name="admin")
    db.add(role)
    db.flush()
    user = User(
        company_id=company.id,
        role_id=role.id,
        email="admin-classification@example.test",
        full_name="Admin Clasificacion",
        password_hash="test",
    )
    db.add(user)
    db.flush()
    session = AdminSession(user_id=user.id, company_id=company.id, expires_at=now_utc() + timedelta(hours=1))
    db.add(session)
    db.commit()
    return {"Authorization": f"Bearer {create_admin_access_token(user, 'admin', session.id)}"}


def test_uncategorized_endpoint_reports_total_count_beyond_limit(db):
    from tests.factories import create_company_setup

    company, _department, _position, employee, device = create_company_setup(db)
    for index in range(35):
        app_row = get_or_create_app(db, company.id, f"pendiente-{index}.exe")
        title_row = get_or_create_window_title(db, company.id, f"Pendiente {index}")
        db.add(
            Activity(
                company_id=company.id,
                employee_id=employee.id,
                device_id=device.id,
                app_id=app_row.id,
                window_title_id=title_row.id,
                started_at=now_utc() + timedelta(seconds=index),
                duration_seconds=60,
                classification="uncategorized",
                source_event_id=f"pending-{index}",
                source_sample_index=0,
            )
        )
    db.commit()

    client = TestClient(app)
    headers = admin_headers(db, company)
    first_page = client.get("/api/productivity/uncategorized?limit=30", headers=headers)
    assert first_page.status_code == 200, first_page.text
    body = first_page.json()
    assert body["count"] == 35
    assert body["returned"] == 30
    assert len(body["items"]) == 30

    first_item = body["items"][0]
    created = client.post(
        "/api/productivity/rules",
        headers=headers,
        json={
            "executable_name": first_item["executable_name"],
            "title_contains": first_item["rule_title_contains"] or "",
            "classification": "productive",
            "priority": 120,
            "reclassify": True,
            "rebuild_blocks": False,
        },
    )
    assert created.status_code == 200, created.text
    assert created.json()["reclassify"]["changed"] == 1

    next_page = client.get("/api/productivity/uncategorized?limit=30", headers=headers)
    assert next_page.status_code == 200, next_page.text
    assert next_page.json()["count"] == 34
    assert len(next_page.json()["items"]) == 30
