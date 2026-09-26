import os
import time

import pytest
import requests

import agent_event_uploader
import local_auth
import outbox
import screenshots
from agent_updater import resolve_same_origin_url, update_allowed_for_state


# ---- actualizador -----------------------------------------------------------
def test_relative_download_url_resolves_to_backend_origin():
    url = resolve_same_origin_url("https://api.vyntralab.com", "/api/agent/update/download/VYNTRAAgent-windows.zip")
    assert url == "https://api.vyntralab.com/api/agent/update/download/VYNTRAAgent-windows.zip"


def test_same_origin_absolute_url_is_accepted():
    url = "https://api.vyntralab.com:443/api/agent/update/download/x.zip"
    assert resolve_same_origin_url("https://api.vyntralab.com", url) == url


@pytest.mark.parametrize(
    "download_url",
    [
        "https://evil.example.com/VYNTRAAgent.zip",
        "http://api.vyntralab.com/api/agent/update/download/x.zip",
        "https://api.vyntralab.com.evil.net/x.zip",
        "//evil.example.com/x.zip",
        "https://api.vyntralab.com:8443/x.zip",
    ],
)
def test_cross_origin_download_url_is_rejected(download_url):
    with pytest.raises(RuntimeError):
        resolve_same_origin_url("https://api.vyntralab.com", download_url)


@pytest.mark.parametrize(
    "estado,horas_extra,allowed",
    [
        ("FUERA", "SIN_HORAS_EXTRA", True),
        ("TERMINADO", "FINALIZADA", True),
        ("TRABAJANDO", "SIN_HORAS_EXTRA", False),
        ("BREAK", "", False),
        ("LUNCH", "", False),
        ("TERMINADO", "ACTIVA", False),
        ("DESCONOCIDO", "", False),
    ],
)
def test_updates_only_outside_shift(estado, horas_extra, allowed):
    assert update_allowed_for_state(estado, horas_extra) is allowed


# ---- envio de eventos -------------------------------------------------------
class _Response:
    def __init__(self, status, payload=None, text=""):
        self.status_code = status
        self._payload = payload
        self.text = text or ""

    def json(self):
        if self._payload is None:
            raise ValueError("sin json")
        return self._payload


def test_rejected_events_are_not_retried(fake_cfg, monkeypatch):
    ok = outbox.append_event("activity_snapshot", {})
    bad = outbox.append_event("shift_started", {})

    def fake_post(url, headers, json, timeout):
        return _Response(
            200,
            {"ok": True, "accepted": [{"id": ok["id"]}], "rejected": [{"id": bad["id"], "error": "invalido"}]},
        )

    monkeypatch.setattr(agent_event_uploader.requests, "post", fake_post)
    uploader = agent_event_uploader.AgentEventUploader(fake_cfg)
    assert uploader.process_pending() == 1
    assert outbox.count_pending() == 0
    assert outbox.count_by_status() == {"uploaded": 1, "rejected": 1}


def test_network_error_keeps_events_pending(fake_cfg, monkeypatch):
    outbox.append_event("activity_snapshot", {})

    def offline(*_args, **_kwargs):
        raise requests.ConnectionError("sin red")

    monkeypatch.setattr(agent_event_uploader.requests, "post", offline)
    uploader = agent_event_uploader.AgentEventUploader(fake_cfg)
    with pytest.raises(agent_event_uploader.TransientSyncError):
        uploader.process_pending()
    assert outbox.count_pending() == 1


def test_bad_batch_is_split_and_only_bad_event_rejected(fake_cfg, monkeypatch):
    good = outbox.append_event("a", {})
    bad = outbox.append_event("b", {})

    def fake_post(url, headers, json, timeout):
        events = json["events"]
        if len(events) > 1 or events[0]["id"] == bad["id"]:
            return _Response(422, text="payload invalido")
        return _Response(200, {"ok": True, "accepted": [{"id": events[0]["id"]}], "rejected": []})

    monkeypatch.setattr(agent_event_uploader.requests, "post", fake_post)
    uploader = agent_event_uploader.AgentEventUploader(fake_cfg)
    uploader.process_pending()
    assert outbox.count_by_status() == {"uploaded": 1, "rejected": 1}
    assert good["id"] != bad["id"]


# ---- autenticacion local ----------------------------------------------------
def test_test_users_disabled_outside_dev_mode(fake_cfg):
    fake_cfg.evidence_backend_enabled = False
    assert local_auth.verificar_credenciales("test@vyntra.com", "cualquiera") is False
    result = local_auth.autenticar_credenciales("test@vyntra.com", "x", fake_cfg)
    assert result["ok"] is False
    assert result["reason"] == "backend_not_configured"


# ---- retencion de capturas ------------------------------------------------
def test_purge_old_captures(tmp_path):
    day = tmp_path / "PC" / "2026" / "09" / "01"
    day.mkdir(parents=True)
    old = day / "cap_old.webp"
    old.write_bytes(b"x")
    recent_dir = tmp_path / "PC" / "2026" / "09" / "25"
    recent_dir.mkdir(parents=True)
    recent = recent_dir / "cap_new.webp"
    recent.write_bytes(b"x")
    other = day / "notas.txt"
    other.write_text("no se borra")
    ten_days_ago = time.time() - 10 * 86400
    os.utime(old, (ten_days_ago, ten_days_ago))
    assert screenshots.purge_old_captures(str(tmp_path), days=7) == 1
    assert not old.exists()
    assert recent.exists()
    assert other.exists()
