"""
Build productivity_blocks from raw activities.

This first ETL is intentionally simple and auditable:
- productive/non_productive/neutral/uncategorized: Activity.classification
- idle: only the part of a continuous idle streak that exceeds idle_grace_seconds
- idle grace seconds are counted as neutral focus time
"""

from collections import defaultdict
from datetime import datetime, timedelta, timezone
from pathlib import Path
import sys

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from sqlalchemy import delete, select

from app.database import SessionLocal
from app.models import (
    Activity,
    CompanySetting,
    ETLRunLog,
    ProductivityBlock,
    new_id,
    now_utc,
)


def setting_int(db, company_id: str, key: str, default: int) -> int:
    row = db.execute(
        select(CompanySetting).where(
            CompanySetting.company_id == company_id,
            CompanySetting.key == key,
        )
    ).scalar_one_or_none()
    if not row:
        return default
    try:
        return int(row.value)
    except ValueError:
        return default


def block_start_for(ts: datetime, block_minutes: int) -> datetime:
    ts = ts.astimezone(timezone.utc)
    minute = (ts.minute // block_minutes) * block_minutes
    return ts.replace(minute=minute, second=0, microsecond=0)


def percent(part: int, whole: int) -> float:
    if whole <= 0:
        return 0.0
    return round((part / whole) * 100, 2)


def activity_bucket(activity: Activity, idle_seconds: int) -> str:
    if idle_seconds > 0:
        return "idle"
    classification = getattr(activity, "classification", "") or ""
    if classification in {"productive", "neutral", "non_productive", "uncategorized"}:
        return classification
    if activity.is_productive is True:
        return "productive"
    if activity.is_productive is False:
        return "non_productive"
    return "uncategorized"


def run():
    with SessionLocal() as db:
        activities = db.execute(
            select(Activity).order_by(
                Activity.company_id,
                Activity.employee_id,
                Activity.shift_id,
                Activity.started_at,
            )
        ).scalars().all()

        if not activities:
            print("No activities to process.")
            return

        company_ids = {activity.company_id for activity in activities}
        deleted = 0
        for company_id in company_ids:
            result = db.execute(
                delete(ProductivityBlock).where(ProductivityBlock.company_id == company_id)
            )
            deleted += result.rowcount or 0

        idle_streak_by_shift: dict[tuple[str, str, str], int] = defaultdict(int)
        blocks: dict[tuple[str, str, str], dict] = {}

        for activity in activities:
            block_minutes = setting_int(
                db, activity.company_id, "productivity_block_minutes", 30
            )
            idle_grace = setting_int(db, activity.company_id, "idle_grace_seconds", 300)
            duration = max(0, int(activity.duration_seconds or 0))
            shift_key = (
                activity.company_id,
                activity.employee_id,
                activity.shift_id or "",
            )
            idle_real = 0
            if activity.is_idle:
                idle_before = idle_streak_by_shift[shift_key]
                idle_after = idle_before + duration
                idle_real = max(0, idle_after - idle_grace) - max(
                    0, idle_before - idle_grace
                )
                idle_streak_by_shift[shift_key] = idle_after
            else:
                idle_streak_by_shift[shift_key] = 0

            block_start = block_start_for(activity.started_at, block_minutes)
            block_date = block_start.date().isoformat()
            block_time = block_start.strftime("%H:%M")
            block_key = (activity.employee_id, block_date, block_time)

            if block_key not in blocks:
                blocks[block_key] = {
                    "id": new_id(),
                    "company_id": activity.company_id,
                    "employee_id": activity.employee_id,
                    "shift_id": activity.shift_id,
                    "department_id_snapshot": None,
                    "block_date": block_date,
                    "block_start": block_time,
                    "total_seconds": 0,
                    "active_seconds": 0,
                    "productive_seconds": 0,
                    "neutral_seconds": 0,
                    "non_productive_seconds": 0,
                    "uncategorized_seconds": 0,
                    "idle_seconds": 0,
                    "break_lunch_seconds": 0,
                }

            block = blocks[block_key]
            block["total_seconds"] += duration
            if activity.is_idle:
                block["idle_seconds"] += idle_real
                active_piece = max(0, duration - idle_real)
                block["active_seconds"] += active_piece
                if active_piece:
                    block["neutral_seconds"] += active_piece
            else:
                bucket = activity_bucket(activity, idle_real)
                block["active_seconds"] += duration
                block[f"{bucket}_seconds"] += duration

        now = now_utc()
        for block in blocks.values():
            active = block["active_seconds"]
            total = block["total_seconds"]
            productive = block["productive_seconds"]
            neutral = block["neutral_seconds"]
            non_productive = block["non_productive_seconds"]
            uncategorized = block["uncategorized_seconds"]
            idle = block["idle_seconds"]
            block["productivity_pct"] = percent(productive, active)
            block["acceptable_pct"] = percent(productive + neutral, active)
            block["non_productive_pct"] = percent(non_productive, active)
            block["neutral_pct"] = percent(neutral, active)
            block["uncategorized_pct"] = percent(uncategorized, active)
            block["idle_pct"] = percent(idle, total)
            block["created_at"] = now
            block["updated_at"] = now
            db.add(ProductivityBlock(**block))

        min_day = min(activity.started_at.date().isoformat() for activity in activities)
        max_day = max(activity.started_at.date().isoformat() for activity in activities)
        db.add(
            ETLRunLog(
                company_id=None,
                window_start=min_day,
                window_end=max_day,
                rows_deleted=deleted,
                rows_inserted=len(blocks),
                notes="productivity_blocks rebuilt from activities",
            )
        )
        db.commit()
        print(f"Inserted {len(blocks)} productivity blocks. Deleted {deleted}.")


if __name__ == "__main__":
    run()
