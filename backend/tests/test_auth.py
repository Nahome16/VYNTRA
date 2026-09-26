from datetime import timedelta
from types import SimpleNamespace

from fastapi.testclient import TestClient

from app.auth import (
    PBKDF2_ITERATIONS,
    create_admin_access_token,
    hash_password,
    password_hash_iterations,
    password_needs_rehash,
    verify_password_constant_time,
    verify_password_hash,
)
from app.config import LOCAL_DEV_PASSWORD_HASH
from app.main import (
    LOGIN_LOCKOUT_THRESHOLD,
    app,
    current_lockout,
    record_login_result,
    rehash_password_if_needed,
)
from app.models import AdminSession, Company, LoginLockout, Role, User, now_utc


def test_new_hashes_use_600k_iterations():
    stored = hash_password("Secreta-123")
    assert password_hash_iterations(stored) == PBKDF2_ITERATIONS == 600_000
    assert verify_password_hash("Secreta-123", stored)
    assert not verify_password_hash("otra", stored)
    assert not password_needs_rehash(stored)


def test_old_hashes_still_verify_and_are_rehashed():
    # Hash demo historico (200000 iteraciones) de "Vyntra2026".
    assert verify_password_hash("Vyntra2026", LOCAL_DEV_PASSWORD_HASH)
    assert password_needs_rehash(LOCAL_DEV_PASSWORD_HASH)
    row = SimpleNamespace(password_hash=LOCAL_DEV_PASSWORD_HASH)
    assert rehash_password_if_needed(row, "Vyntra2026") is True
    assert password_hash_iterations(row.password_hash) == PBKDF2_ITERATIONS
    assert verify_password_hash("Vyntra2026", row.password_hash)
    assert rehash_password_if_needed(row, "Vyntra2026") is False


def test_constant_time_verification_without_user():
    assert verify_password_constant_time("x", None) is False
    assert verify_password_constant_time("x", "") is False


def test_malformed_hashes_are_rejected():
    assert not verify_password_hash("x", "md5:1:abc:def")
    assert not verify_password_hash("x", "pbkdf2_sha256:999999999:AAAA:AAAA")
    assert not password_needs_rehash("garbage")


def test_expired_lockout_resets_failure_counter(db):
    email, ip = "user@example.test", "10.0.0.5"
    for _ in range(LOGIN_LOCKOUT_THRESHOLD):
        record_login_result(db, email, ip, False)
        db.flush()
    lockout = current_lockout(db, email, ip)
    assert lockout.failed_count == LOGIN_LOCKOUT_THRESHOLD
    assert lockout.locked_until is not None

    # El bloqueo vence: un nuevo fallo empieza de cero y no vuelve a bloquear.
    lockout.locked_until = now_utc() - timedelta(seconds=1)
    db.flush()
    record_login_result(db, email, ip, False)
    db.flush()
    lockout = current_lockout(db, email, ip)
    assert lockout.failed_count == 1
    assert lockout.locked_until is None


def test_old_failures_do_not_accumulate(db):
    email, ip = "slow@example.test", "10.0.0.6"
    record_login_result(db, email, ip, False)
    db.flush()
    lockout = current_lockout(db, email, ip)
    lockout.failed_count = LOGIN_LOCKOUT_THRESHOLD - 1
    lockout.updated_at = now_utc() - timedelta(hours=2)
    db.flush()
    record_login_result(db, email, ip, False)
    db.flush()
    assert current_lockout(db, email, ip).failed_count == 1


def test_success_clears_lockout(db):
    email, ip = "ok@example.test", "10.0.0.7"
    record_login_result(db, email, ip, False)
    db.flush()
    record_login_result(db, email, ip, True)
    db.flush()
    assert db.query(LoginLockout).count() == 0


def _panel_user(db, password_change_required: bool):
    company = Company(name="Panel Co")
    db.add(company)
    db.flush()
    role = Role(company_id=company.id, name="admin")
    db.add(role)
    db.flush()
    user = User(
        company_id=company.id,
        role_id=role.id,
        email="admin@example.test",
        full_name="Admin",
        password_hash=hash_password("Temporal-123"),
        password_change_required=password_change_required,
    )
    db.add(user)
    db.flush()
    session = AdminSession(
        user_id=user.id,
        company_id=company.id,
        expires_at=now_utc() + timedelta(hours=1),
    )
    db.add(session)
    db.commit()
    return create_admin_access_token(user, "admin", session.id)


def test_password_change_required_blocks_admin_endpoints(db):
    token = _panel_user(db, password_change_required=True)
    client = TestClient(app)  # sin "with": no ejecuta el evento de arranque
    headers = {"Authorization": f"Bearer {token}"}

    blocked = client.get("/api/devices", headers=headers)
    assert blocked.status_code == 428
    assert "contrasena" in blocked.json()["detail"]

    me = client.get("/api/admin/me", headers=headers)
    assert me.status_code == 200
    assert me.json()["user"]["password_change_required"] is True

    notice = client.get("/api/admin/company-notice", headers=headers)
    assert notice.status_code == 200


def test_regular_admin_is_not_blocked(db):
    token = _panel_user(db, password_change_required=False)
    client = TestClient(app)
    response = client.get("/api/devices", headers={"Authorization": f"Bearer {token}"})
    assert response.status_code == 200
