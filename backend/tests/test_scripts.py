"""ETL de productividad (zona horaria) y purga de retencion sobre SQLite."""

from datetime import datetime, timedelta, timezone

from app.models import (
    Activity,
    AppCatalog,
    AuditLog,
    EvidenceFile,
    LoginAttempt,
    ProductivityBlock,
    WindowTitleCatalog,
)
from scripts import purge_retention, run_productivity_etl
from tests.factories import create_company_setup


def _activity(db, company, employee, device, started_at, source="evt"):
    app_row = AppCatalog(company_id=company.id, executable_name=f"excel-{source}.exe")
    title_row = WindowTitleCatalog(company_id=company.id, title_hash=source.ljust(64, "0")[:64], title_text="Presupuesto")
    db.add_all([app_row, title_row])
    db.flush()
    activity = Activity(
        company_id=company.id,
        employee_id=employee.id,
        device_id=device.id,
        app_id=app_row.id,
        window_title_id=title_row.id,
        started_at=started_at,
        ended_at=started_at + timedelta(seconds=60),
        duration_seconds=60,
        classification="productive",
        is_productive=True,
        source_event_id=source,
        source_sample_index=0,
    )
    db.add(activity)
    db.commit()
    return activity


def test_etl_blocks_use_company_timezone(db):
    company, _department, _position, employee, device = create_company_setup(db)
    # 2026-09-26 04:10 UTC == 2026-09-25 22:10 en America/Managua (UTC-6).
    _activity(db, company, employee, device, datetime(2026, 9, 26, 4, 10, tzinfo=timezone.utc))

    run_productivity_etl.run(company_id=company.id)

    db.expire_all()
    block = db.query(ProductivityBlock).one()
    assert block.block_date == "2026-09-25"
    assert block.block_start == "22:00"
    assert block.productive_seconds == 60


def test_etl_block_start_helper():
    tz = run_productivity_etl.company_zoneinfo("America/Managua")
    start = run_productivity_etl.block_start_for(datetime(2026, 1, 1, 15, 47, tzinfo=timezone.utc), 30, tz)
    assert (start.hour, start.minute) == (9, 30)
    assert str(run_productivity_etl.company_zoneinfo("Invalid/Zone")) == "America/Managua"


def test_retention_dry_run_then_apply(db, storage_dir):
    company, _department, _position, employee, device = create_company_setup(db)
    now = datetime(2026, 9, 26, 12, 0, tzinfo=timezone.utc)

    old_file = storage_dir / "old.webp"
    old_file.write_bytes(b"RIFF0000WEBP")
    new_file = storage_dir / "new.webp"
    new_file.write_bytes(b"RIFF0000WEBP")
    for name, captured_at, sha in (
        ("old.webp", now - timedelta(days=120), "a" * 64),
        ("new.webp", now - timedelta(days=10), "b" * 64),
    ):
        db.add(
            EvidenceFile(
                company_id=company.id,
                device_id=device.id,
                employee_id=employee.id,
                employee="x",
                equipment="PC",
                captured_at=captured_at,
                original_filename=name,
                storage_path=name,
                content_type="image/webp",
                file_size=12,
                sha256=sha,
            )
        )
    db.add(LoginAttempt(email_attempted="x@example.test", ip_address="1.1.1.1", created_at=now - timedelta(days=400)))
    db.commit()
    _activity(db, company, employee, device, now - timedelta(days=400), source="old")
    _activity(db, company, employee, device, now - timedelta(days=5), source="new")

    dry = purge_retention.run(apply=False, now=now)
    assert dry["mode"] == "dry-run"
    assert dry["companies"][0]["evidence_rows"] == 1
    assert dry["companies"][0]["activities"] == 1
    assert dry["global"]["login_attempts"] == 1
    db.expire_all()
    assert db.query(EvidenceFile).count() == 2 and old_file.exists()

    applied = purge_retention.run(apply=True, now=now)
    assert applied["companies"][0]["evidence_files_deleted"] == 1
    db.expire_all()
    assert [row.storage_path for row in db.query(EvidenceFile).all()] == ["new.webp"]
    assert not old_file.exists() and new_file.exists()
    assert db.query(Activity).count() == 1
    assert db.query(LoginAttempt).count() == 0
    assert db.query(AuditLog).filter(AuditLog.action == "retention_purge").count() == 2
