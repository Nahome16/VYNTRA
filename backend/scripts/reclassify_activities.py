"""
Reapply productivity rules to existing activity samples.

Use this after adding or changing productivity_rules so the dashboard reflects
the new classification without waiting for new agent samples.
"""

from collections import Counter
from pathlib import Path
import sys

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from sqlalchemy import select

from app.database import SessionLocal
from app.main import classification_to_bool, classify_activity, seed_productivity_rules
from app.models import Activity, AppCatalog, Company, Employee, WindowTitleCatalog


def run():
    with SessionLocal() as db:
        companies = db.execute(select(Company)).scalars().all()
        for company in companies:
            seed_productivity_rules(db, company.id)
        db.flush()

        activities = db.execute(select(Activity).order_by(Activity.started_at)).scalars().all()
        changed = 0
        totals = Counter()

        for activity in activities:
            employee = db.get(Employee, activity.employee_id)
            if employee is None:
                continue

            app_row = db.get(AppCatalog, activity.app_id) if activity.app_id else None
            title_row = (
                db.get(WindowTitleCatalog, activity.window_title_id)
                if activity.window_title_id
                else None
            )
            executable_name = app_row.executable_name if app_row else ""
            title_text = title_row.title_text if title_row else ""

            new_classification = classify_activity(
                db,
                activity.company_id,
                employee,
                executable_name,
                title_text,
            )
            totals[new_classification] += 1
            if activity.classification != new_classification:
                activity.classification = new_classification
                activity.is_productive = classification_to_bool(new_classification)
                changed += 1

        db.commit()
        print(f"Reclassified {changed} activities.")
        for classification, count in sorted(totals.items()):
            print(f"{classification}: {count}")


if __name__ == "__main__":
    run()
