"""Pruebas de funciones puras: CSV, fechas, limites de payload, IP y configuracion."""

from datetime import datetime, timedelta, timezone
import json
from zoneinfo import ZoneInfo

from fastapi import HTTPException
import pytest

from app import config as config_module
from app.main import (
    MAX_SAMPLES_PER_EVENT,
    bounded_json_text,
    cap_sample_lists,
    company_zoneinfo,
    csv_safe_cell,
    csv_safe_row,
    evidence_download_filename,
    ip_allowed,
    ip_scope_for_path,
    parse_client_datetime,
)
from app.models import Company, EvidenceFile


@pytest.mark.parametrize(
    "value, expected",
    [
        ("=HYPERLINK(\"http://x\")", "'=HYPERLINK(\"http://x\")"),
        ("+1+1", "'+1+1"),
        ("-2", "'-2"),
        ("@SUM(A1)", "'@SUM(A1)"),
        ("\tcmd", "'\tcmd"),
        ("\rcmd", "'\rcmd"),
        ("normal text", "normal text"),
        ("a=b", "a=b"),
        (None, ""),
        (42, "42"),
    ],
)
def test_csv_safe_cell(value, expected):
    assert csv_safe_cell(value) == expected


def test_csv_safe_row():
    assert csv_safe_row(["ok", "=1", "", "-x"]) == ["ok", "'=1", "", "'-x"]


def test_naive_datetime_uses_company_timezone():
    managua = ZoneInfo("America/Managua")  # UTC-6, sin horario de verano
    parsed = parse_client_datetime("2026-09-26T08:00:00", managua)
    assert parsed == datetime(2026, 9, 26, 14, 0, tzinfo=timezone.utc)


def test_aware_datetimes_are_unchanged():
    managua = ZoneInfo("America/Managua")
    assert parse_client_datetime("2026-09-26T08:00:00Z", managua) == datetime(2026, 9, 26, 8, 0, tzinfo=timezone.utc)
    assert parse_client_datetime("2026-09-26T08:00:00+02:00", managua) == datetime(
        2026, 9, 26, 6, 0, tzinfo=timezone.utc
    )


def test_naive_datetime_without_timezone_defaults_to_utc():
    assert parse_client_datetime("2026-09-26T08:00:00") == datetime(2026, 9, 26, 8, 0, tzinfo=timezone.utc)


@pytest.mark.parametrize("value", ["not-a-date", 12345, None])
def test_invalid_datetime_raises_400(value):
    with pytest.raises(HTTPException) as exc_info:
        parse_client_datetime(value)
    assert exc_info.value.status_code == 400


def test_company_timezone_fallback():
    assert str(company_zoneinfo(Company(name="x", timezone="Europe/Madrid"))) == "Europe/Madrid"
    assert str(company_zoneinfo(Company(name="x", timezone="Mars/Olympus"))) == "America/Managua"
    assert str(company_zoneinfo(None)) == "America/Managua"


def test_cap_sample_lists_keeps_latest_samples():
    payload = {"telemetria": {"muestras_recientes": list(range(MAX_SAMPLES_PER_EVENT + 100))}}
    cap_sample_lists(payload)
    samples = payload["telemetria"]["muestras_recientes"]
    assert len(samples) == MAX_SAMPLES_PER_EVENT
    assert samples[0] == 100 and samples[-1] == MAX_SAMPLES_PER_EVENT + 99


def test_bounded_json_text_small_payload_is_untouched():
    payload = {"estado": "TRABAJANDO", "seg_trabajado": 10}
    assert json.loads(bounded_json_text(payload)) == payload


def test_bounded_json_text_drops_samples_first():
    payload = {
        "estado": "TRABAJANDO",
        "telemetria": {"seg_idle": 5, "muestras_recientes": [{"titulo": "x" * 200}] * 500},
    }
    text_value = bounded_json_text(payload, max_bytes=4096)
    assert len(text_value.encode("utf-8")) <= 4096
    stored = json.loads(text_value)
    assert stored["_truncated"] is True
    assert stored["estado"] == "TRABAJANDO"
    assert stored["telemetria"] == {"seg_idle": 5}


def test_bounded_json_text_falls_back_to_scalars():
    payload = {"estado": "BREAK", "blob": {"nested": "y" * 10000}, "long": "z" * 5000}
    stored = json.loads(bounded_json_text(payload, max_bytes=1024))
    assert stored == {"estado": "BREAK", "_truncated": True}


def test_ip_scopes_are_deny_by_default_for_admin():
    assert ip_scope_for_path("/api/agent/events") == "agent"
    assert ip_scope_for_path("/api/station/login") == "agent"
    assert ip_scope_for_path("/api/station-web/password-reset/request") == "agent"
    assert ip_scope_for_path("/api/evidence/upload") == "agent"
    assert ip_scope_for_path("/api/evidence/abc/content") == "admin"
    assert ip_scope_for_path("/api/reports/operations.pdf") == "admin"
    assert ip_scope_for_path("/api/downloads/agent") == "admin"
    assert ip_scope_for_path("/api/anything-new") == "admin"
    assert ip_scope_for_path("/health") is None
    assert ip_scope_for_path("/api/health/ready") is None


def test_ip_allowed_uses_scope_lists(monkeypatch):
    patched = config_module.Settings()
    object.__setattr__(patched, "admin_allowed_ips", ("10.0.0.1",))
    object.__setattr__(patched, "agent_allowed_ips", ())
    monkeypatch.setattr("app.main.settings", patched)
    assert ip_allowed("/api/reports/operations.pdf", "10.0.0.1")
    assert not ip_allowed("/api/reports/operations.pdf", "10.0.0.2")
    assert not ip_allowed("/api/evidence/x/content", "10.0.0.2")
    # Alcance de agente sin lista: sin restriccion aunque la lista admin exista.
    assert ip_allowed("/api/evidence/upload", "10.0.0.2")
    assert ip_allowed("/health", "10.0.0.2")


def test_evidence_download_filename_is_safe():
    evidence = EvidenceFile(
        id="1234abcd-0000-0000-0000-000000000000",
        original_filename='evil"; filename="x.exe',
        storage_path="c/d/2026/09/26/1234abcd.webp",
    )
    assert evidence_download_filename(evidence) == "evidence-1234abcd-0000-0000-0000-000000000000.webp"
    evidence.storage_path = "c/d/file.exe"
    assert evidence_download_filename(evidence) == "evidence-1234abcd-0000-0000-0000-000000000000"


@pytest.mark.parametrize(
    "value, expected",
    [("development", True), ("DEV", True), (" local ", True), ("test", True), ("production", False), ("", False), ("staging", False)],
)
def test_is_development_environment(value, expected):
    assert config_module.is_development_environment(value) is expected


def _settings(**overrides):
    base = config_module.Settings()
    for key, value in overrides.items():
        object.__setattr__(base, key, value)
    return base


def test_runtime_settings_fail_closed_outside_development():
    assert config_module.runtime_settings_errors(_settings(environment="development", jwt_secret="")) == []
    errors = config_module.runtime_settings_errors(_settings(environment="", jwt_secret="short"))
    assert any("JWT_SECRET" in error for error in errors)
    errors = config_module.runtime_settings_errors(
        _settings(environment="production", jwt_secret="replace_with_a_long_random_jwt_secret_value")
    )
    assert any("placeholder" in error for error in errors)
    errors = config_module.runtime_settings_errors(
        _settings(
            environment="production",
            jwt_secret="k" * 48,
            bootstrap_admin_password_hash=config_module.LOCAL_DEV_PASSWORD_HASH,
        )
    )
    assert any("BOOTSTRAP_ADMIN_PASSWORD_HASH" in error for error in errors)
    good = _settings(
        environment="production",
        jwt_secret="Zx8" * 16,
        bootstrap_admin_password_hash="",
        bootstrap_employee_password_hash="",
        bootstrap_system_admin_password_hash="",
    )
    assert config_module.runtime_settings_errors(good) == []
    with pytest.raises(RuntimeError):
        config_module.validate_runtime_settings(_settings(environment="production", jwt_secret=""))


def test_shift_window_constants_are_conservative():
    from app.main import SHIFT_START_MAX_FUTURE, SHIFT_START_MAX_PAST

    assert SHIFT_START_MAX_FUTURE == timedelta(minutes=5)
    assert SHIFT_START_MAX_PAST == timedelta(hours=24)
