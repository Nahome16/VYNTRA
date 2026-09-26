"""La clasificacion en memoria debe ser identica a la implementacion original."""

import itertools
import random

from app.main import classify_activity, classify_with_rules, load_active_productivity_rules
from app.models import Employee, ProductivityRule


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
