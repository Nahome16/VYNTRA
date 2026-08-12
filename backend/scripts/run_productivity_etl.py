"""
Build productivity_blocks from raw activities.

This first ETL is intentionally simple and auditable:
- productive/non_productive/neutral/uncategorized: Activity.classification
- idle: only the part of a continuous idle streak that exceeds idle_grace_seconds
- idle grace seconds are counted as neutral focus time
- break/lunch: calculated from shift events and kept outside active time
"""

from collections import defaultdict
import argparse
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
    Employee,
    ETLRunLog,
    ProductivityBlock,
    Shift,
    ShiftEvent,
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


def normalize_utc(value: datetime) -> datetime:
    if value.tzinfo is None:
        return value.replace(tzinfo=timezone.utc)
    return value.astimezone(timezone.utc)


def get_block(
    blocks: dict[tuple[str, str, str, str], dict],
    company_id: str,
    employee_id: str,
    shift_id: str | None,
    department_id: str | None,
    started_at: datetime,
    block_minutes: int,
) -> dict:
    block_start = block_start_for(started_at, block_minutes)
    block_date = block_start.date().isoformat()
    block_time = block_start.strftime("%H:%M")
    block_key = (company_id, employee_id, block_date, block_time)

    if block_key not in blocks:
        blocks[block_key] = {
            "id": new_id(),
            "company_id": company_id,
            "employee_id": employee_id,
            "shift_id": shift_id,
            "department_id_snapshot": department_id,
            "block_date": block_date,
            "block_start": block_time,
            "total_seconds": 0,
            "active_seconds": 0,
            "productive_seconds": 0,
            "neutral_seconds": 0,
            "non_productive_seconds": 0,
            "uncategorized_seconds": 0,
            "idle_seconds": 0,
            "break_seconds": 0,
            "lunch_seconds": 0,
            "break_lunch_seconds": 0,
        }
    else:
        block = blocks[block_key]
        if not block.get("shift_id") and shift_id:
            block["shift_id"] = shift_id
        if not block.get("department_id_snapshot") and department_id:
            block["department_id_snapshot"] = department_id

    return blocks[block_key]


def add_interval_to_blocks(
    db,
    blocks: dict[tuple[str, str, str, str], dict],
    shift: Shift,
    started_at: datetime,
    ended_at: datetime,
    field_name: str,
):
    if ended_at <= started_at:
        return

    block_minutes = setting_int(db, shift.company_id, "productivity_block_minutes", 30)
    current = normalize_utc(started_at)
    interval_end = normalize_utc(ended_at)
    department_id = shift.employee.department_id if shift.employee else None

    while current < interval_end:
        block_start = block_start_for(current, block_minutes)
        block_end = block_start + timedelta(minutes=block_minutes)
        piece_end = min(interval_end, block_end)
        seconds = max(0, int((piece_end - current).total_seconds()))
        if seconds:
            block = get_block(
                blocks,
                shift.company_id,
                shift.employee_id,
                shift.id,
                department_id,
                current,
                block_minutes,
            )
            block["total_seconds"] += seconds
            block[field_name] += seconds
            block["break_lunch_seconds"] += seconds
        current = piece_end


def add_shift_pause_intervals(
    db,
    blocks: dict[tuple[str, str, str, str], dict],
    shifts: list[Shift],
):
    for shift in shifts:
        events = db.execute(
            select(ShiftEvent)
            .where(ShiftEvent.shift_id == shift.id)
            .order_by(ShiftEvent.occurred_at)
        ).scalars().all()

        open_break = None
        open_lunch = None
        fallback_end = shift.ended_at or now_utc()

        for event in events:
            occurred_at = normalize_utc(event.occurred_at)
            if event.event_type == "break_started":
                open_break = occurred_at
            elif event.event_type == "break_finished" and open_break:
                add_interval_to_blocks(db, blocks, shift, open_break, occurred_at, "break_seconds")
                open_break = None
            elif event.event_type == "lunch_started":
                open_lunch = occurred_at
            elif event.event_type == "lunch_finished" and open_lunch:
                add_interval_to_blocks(db, blocks, shift, open_lunch, occurred_at, "lunch_seconds")
                open_lunch = None

        if open_break:
            add_interval_to_blocks(db, blocks, shift, open_break, fallback_end, "break_seconds")
        if open_lunch:
            add_interval_to_blocks(db, blocks, shift, open_lunch, fallback_end, "lunch_seconds")


def run(company_id: str | None = None):
    with SessionLocal() as db:
        activity_query = select(Activity)
        shift_query = select(Shift)
        if company_id:
            activity_query = activity_query.where(Activity.company_id == company_id)
            shift_query = shift_query.where(Shift.company_id == company_id)

        activities = db.execute(
            activity_query.order_by(
                Activity.company_id,
                Activity.employee_id,
                Activity.shift_id,
                Activity.started_at,
            )
        ).scalars().all()
        shifts = db.execute(
            shift_query.order_by(
                Shift.company_id,
                Shift.employee_id,
                Shift.started_at,
            )
        ).scalars().all()

        if not activities and not shifts:
            scope = f" for company {company_id}" if company_id else ""
            print(f"No activities or shifts to process{scope}.")
            return

        company_ids = {activity.company_id for activity in activities}
        company_ids.update(shift.company_id for shift in shifts)
        if company_id:
            company_ids = {company_id}

        deleted = 0
        for target_company_id in company_ids:
            result = db.execute(
                delete(ProductivityBlock).where(ProductivityBlock.company_id == target_company_id)
            )
            deleted += result.rowcount or 0

        idle_streak_by_shift: dict[tuple[str, str, str], int] = defaultdict(int)
        blocks: dict[tuple[str, str, str, str], dict] = {}
        employee_query = select(Employee)
        if company_id:
            employee_query = employee_query.where(Employee.company_id == company_id)
        employees = {row.id: row for row in db.execute(employee_query).scalars()}

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

            employee = employees.get(activity.employee_id)
            department_id = employee.department_id if employee else None
            block = get_block(
                blocks,
                activity.company_id,
                activity.employee_id,
                activity.shift_id,
                department_id,
                activity.started_at,
                block_minutes,
            )
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

        add_shift_pause_intervals(db, blocks, shifts)

        now = now_utc()
        for block in blocks.values():
            active = block["active_seconds"]
            total = block["total_seconds"]
            productive = block["productive_seconds"]
            neutral = block["neutral_seconds"]
            non_productive = block["non_productive_seconds"]
            uncategorized = block["uncategorized_seconds"]
            idle = block["idle_seconds"]
            break_seconds = block["break_seconds"]
            lunch_seconds = block["lunch_seconds"]
            block["productivity_pct"] = percent(productive, active)
            block["acceptable_pct"] = percent(productive + neutral, active)
            block["non_productive_pct"] = percent(non_productive, active)
            block["neutral_pct"] = percent(neutral, active)
            block["uncategorized_pct"] = percent(uncategorized, active)
            block["idle_pct"] = percent(idle, total)
            block["break_pct"] = percent(break_seconds, total)
            block["lunch_pct"] = percent(lunch_seconds, total)
            block["created_at"] = now
            block["updated_at"] = now
            db.add(ProductivityBlock(**block))

        date_values = [activity.started_at for activity in activities]
        date_values.extend(shift.started_at for shift in shifts if shift.started_at)
        date_values.extend(shift.ended_at for shift in shifts if shift.ended_at)
        min_day = min(value.date().isoformat() for value in date_values)
        max_day = max(value.date().isoformat() for value in date_values)
        db.add(
            ETLRunLog(
                company_id=company_id,
                window_start=min_day,
                window_end=max_day,
                rows_deleted=deleted,
                rows_inserted=len(blocks),
                notes="productivity_blocks rebuilt from activities and shift pauses",
            )
        )
        db.commit()
        scope = f" for company {company_id}" if company_id else ""
        print(f"Inserted {len(blocks)} productivity blocks{scope}. Deleted {deleted}.")


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--company-id", default=None)
    args = parser.parse_args()
    run(company_id=args.company_id)
