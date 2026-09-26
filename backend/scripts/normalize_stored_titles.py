"""
Apply the minimum-capture policy to data stored before it existed.

- Replaces every activity's window title with its normalized identifier.
- Removes URLs, domains and literal titles from stored shift events and incidents.
- Deletes window titles that are no longer referenced.

Runs as a dry run by default; pass --apply to write the changes.
"""

from pathlib import Path
import json
import sys

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from sqlalchemy import select

from app.capture_policy import normalize_window_title, sanitize_capture_payload
from app.database import SessionLocal
from app.main import capture_rules_for_employee, get_or_create_window_title
from app.models import Activity, AppCatalog, Employee, Incident, Shift, ShiftEvent, WindowTitleCatalog


def sanitized_json(rules, raw: str) -> str | None:
    try:
        payload = json.loads(raw or "{}")
    except json.JSONDecodeError:
        return None
    if not isinstance(payload, dict):
        return None
    clean = json.dumps(sanitize_capture_payload(rules, payload), ensure_ascii=False, default=str)
    return clean if clean != raw else None


def run(apply: bool):
    with SessionLocal() as db:
        rules_cache: dict[str, list] = {}

        def rules_for(company_id: str, employee_id: str | None):
            key = employee_id or ""
            if key not in rules_cache:
                employee = db.get(Employee, employee_id) if employee_id else None
                rules_cache[key] = capture_rules_for_employee(db, company_id, employee)
            return rules_cache[key]

        activities_changed = 0
        for activity in db.execute(select(Activity)).scalars():
            app_row = db.get(AppCatalog, activity.app_id) if activity.app_id else None
            title_row = db.get(WindowTitleCatalog, activity.window_title_id) if activity.window_title_id else None
            current = title_row.title_text if title_row else ""
            normalized = normalize_window_title(
                rules_for(activity.company_id, activity.employee_id),
                app_row.executable_name if app_row else "",
                current,
            )
            if normalized != current:
                activities_changed += 1
                if apply:
                    activity.window_title_id = get_or_create_window_title(db, activity.company_id, normalized).id

        events_changed = 0
        for event in db.execute(select(ShiftEvent)).scalars():
            shift = db.get(Shift, event.shift_id)
            if shift is None:
                continue
            clean = sanitized_json(rules_for(shift.company_id, shift.employee_id), event.payload_json)
            if clean is not None:
                events_changed += 1
                if apply:
                    event.payload_json = clean

        incidents_changed = 0
        for incident in db.execute(select(Incident)).scalars():
            clean = sanitized_json(rules_for(incident.company_id, incident.employee_id), incident.payload_json)
            if clean is not None:
                incidents_changed += 1
                if apply:
                    incident.payload_json = clean

        orphan_titles = 0
        if apply:
            db.flush()
        referenced = set(db.execute(select(Activity.window_title_id).distinct()).scalars())
        for title_row in db.execute(select(WindowTitleCatalog)).scalars().all():
            if title_row.id not in referenced:
                orphan_titles += 1
                if apply:
                    db.delete(title_row)

        if apply:
            db.commit()
        mode = "Applied" if apply else "Dry run (use --apply to write)"
        print(mode)
        print(f"Activities with a literal title: {activities_changed}")
        print(f"Shift events with URLs or literal titles: {events_changed}")
        print(f"Incidents with URLs or literal titles: {incidents_changed}")
        print(f"Unreferenced window titles{' deleted' if apply else ''}: {orphan_titles}")


if __name__ == "__main__":
    run(apply="--apply" in sys.argv[1:])
