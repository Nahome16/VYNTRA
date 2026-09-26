"""
Purga por retencion (RNF-13): evidencia visual 90 dias, telemetria 12 meses.

Por defecto es un simulacro (dry-run): solo cuenta lo que se borraria.
Con --apply elimina:

- evidence_files con captured_at anterior al corte de evidencia, junto con sus
  archivos en STORAGE_DIR (via app.storage).
- activities y shift_events anteriores al corte de telemetria (las jornadas
  `shifts` y los bloques agregados se conservan).
- login_attempts, evidence_upload_attempts y agent_event_receipts anteriores al
  corte de telemetria global.

Configuracion (de mayor a menor prioridad):
- argumentos --evidence-days / --telemetry-days
- company_settings: retention_evidence_days / retention_telemetry_days
- variables de entorno RETENTION_EVIDENCE_DAYS (90) / RETENTION_TELEMETRY_DAYS (365)

Cada ejecucion con --apply deja una entrada `retention_purge` en audit_logs.

Uso:
    python scripts/purge_retention.py                 # simulacro
    python scripts/purge_retention.py --apply         # borra
    python scripts/purge_retention.py --company-id X  # una sola empresa
"""

from __future__ import annotations

import argparse
from datetime import datetime, timedelta, timezone
import json
import logging
from pathlib import Path
import sys

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from sqlalchemy import delete, func, select  # noqa: E402

from app.config import settings  # noqa: E402
from app.database import SessionLocal  # noqa: E402
from app.models import (  # noqa: E402
    Activity,
    AgentEventReceipt,
    AuditLog,
    Company,
    CompanySetting,
    EvidenceFile,
    EvidenceUploadAttempt,
    LoginAttempt,
    Shift,
    ShiftEvent,
)
from app.storage import delete_stored_file  # noqa: E402

logger = logging.getLogger("vyntra.retention")

MIN_RETENTION_DAYS = 1
EVIDENCE_BATCH_SIZE = 500


def positive_days(value, fallback: int) -> int:
    try:
        days = int(value)
    except (TypeError, ValueError):
        return fallback
    return days if days >= MIN_RETENTION_DAYS else fallback


def company_retention_days(db, company_id: str, key: str, fallback: int) -> int:
    row = db.execute(
        select(CompanySetting).where(
            CompanySetting.company_id == company_id,
            CompanySetting.key == key,
        )
    ).scalars().first()
    return positive_days(row.value if row else None, fallback)


def count(db, statement) -> int:
    return int(db.execute(statement).scalar_one() or 0)


def purge_company(
    db,
    company: Company,
    now: datetime,
    apply: bool,
    evidence_days_override: int | None = None,
    telemetry_days_override: int | None = None,
) -> dict:
    evidence_days = evidence_days_override or company_retention_days(
        db, company.id, "retention_evidence_days", positive_days(settings.retention_evidence_days, 90)
    )
    telemetry_days = telemetry_days_override or company_retention_days(
        db, company.id, "retention_telemetry_days", positive_days(settings.retention_telemetry_days, 365)
    )
    evidence_cutoff = now - timedelta(days=evidence_days)
    telemetry_cutoff = now - timedelta(days=telemetry_days)

    shift_ids = select(Shift.id).where(Shift.company_id == company.id)
    activity_filter = (Activity.company_id == company.id, Activity.started_at < telemetry_cutoff)
    shift_event_filter = (ShiftEvent.shift_id.in_(shift_ids), ShiftEvent.occurred_at < telemetry_cutoff)
    evidence_filter = (EvidenceFile.company_id == company.id, EvidenceFile.captured_at < evidence_cutoff)

    result = {
        "company_id": company.id,
        "evidence_days": evidence_days,
        "telemetry_days": telemetry_days,
        "evidence_cutoff": evidence_cutoff.isoformat(),
        "telemetry_cutoff": telemetry_cutoff.isoformat(),
        "evidence_rows": count(db, select(func.count()).select_from(EvidenceFile).where(*evidence_filter)),
        "activities": count(db, select(func.count()).select_from(Activity).where(*activity_filter)),
        "shift_events": count(db, select(func.count()).select_from(ShiftEvent).where(*shift_event_filter)),
        "evidence_files_deleted": 0,
        "evidence_files_missing": 0,
        "evidence_file_errors": 0,
    }
    if not apply:
        return result

    # Evidencia: primero el archivo y luego la fila, en lotes.
    while True:
        batch = db.execute(
            select(EvidenceFile).where(*evidence_filter).order_by(EvidenceFile.captured_at).limit(EVIDENCE_BATCH_SIZE)
        ).scalars().all()
        if not batch:
            break
        for evidence in batch:
            try:
                if delete_stored_file(evidence.storage_path):
                    result["evidence_files_deleted"] += 1
                else:
                    result["evidence_files_missing"] += 1
            except (OSError, ValueError):
                result["evidence_file_errors"] += 1
                logger.exception("Could not delete evidence file %s (%s)", evidence.id, evidence.storage_path)
            db.delete(evidence)
        db.commit()

    db.execute(delete(Activity).where(*activity_filter).execution_options(synchronize_session=False))
    db.execute(delete(ShiftEvent).where(*shift_event_filter).execution_options(synchronize_session=False))
    db.add(
        AuditLog(
            company_id=company.id,
            action="retention_purge",
            entity_type="retention",
            entity_id=company.id,
            payload_json=json.dumps(result, ensure_ascii=False),
        )
    )
    db.commit()
    return result


def purge_global(db, now: datetime, apply: bool, telemetry_days_override: int | None = None) -> dict:
    telemetry_days = telemetry_days_override or positive_days(settings.retention_telemetry_days, 365)
    cutoff = now - timedelta(days=telemetry_days)
    filters = {
        "login_attempts": (LoginAttempt, LoginAttempt.created_at < cutoff),
        "evidence_upload_attempts": (EvidenceUploadAttempt, EvidenceUploadAttempt.created_at < cutoff),
        "agent_event_receipts": (AgentEventReceipt, AgentEventReceipt.received_at < cutoff),
    }
    result = {"telemetry_days": telemetry_days, "telemetry_cutoff": cutoff.isoformat()}
    for name, (model, condition) in filters.items():
        result[name] = count(db, select(func.count()).select_from(model).where(condition))
    if not apply:
        return result
    for model, condition in filters.values():
        db.execute(delete(model).where(condition).execution_options(synchronize_session=False))
    db.add(
        AuditLog(
            company_id=None,
            action="retention_purge",
            entity_type="retention",
            entity_id="global",
            payload_json=json.dumps(result, ensure_ascii=False),
        )
    )
    db.commit()
    return result


def run(
    apply: bool = False,
    company_id: str | None = None,
    evidence_days: int | None = None,
    telemetry_days: int | None = None,
    now: datetime | None = None,
) -> dict:
    now = now or datetime.now(timezone.utc)
    evidence_days = positive_days(evidence_days, 0) or None
    telemetry_days = positive_days(telemetry_days, 0) or None
    summary = {"mode": "apply" if apply else "dry-run", "companies": [], "global": None}
    with SessionLocal() as db:
        query = select(Company).order_by(Company.name)
        if company_id:
            query = query.where(Company.id == company_id)
        for company in db.execute(query).scalars().all():
            result = purge_company(db, company, now, apply, evidence_days, telemetry_days)
            summary["companies"].append(result)
            logger.info("retention %s company=%s %s", summary["mode"], company.id, json.dumps(result))
        if not company_id:
            summary["global"] = purge_global(db, now, apply, telemetry_days)
            logger.info("retention %s global %s", summary["mode"], json.dumps(summary["global"]))
    return summary


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Purga por retencion (RNF-13). Dry-run por defecto.")
    parser.add_argument("--apply", action="store_true", help="Borra de verdad (sin esto solo cuenta).")
    parser.add_argument("--company-id", default=None)
    parser.add_argument("--evidence-days", type=int, default=None)
    parser.add_argument("--telemetry-days", type=int, default=None)
    args = parser.parse_args(argv)
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s %(message)s")
    summary = run(
        apply=args.apply,
        company_id=args.company_id,
        evidence_days=args.evidence_days,
        telemetry_days=args.telemetry_days,
    )
    print(json.dumps(summary, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
