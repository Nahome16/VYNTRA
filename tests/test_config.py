import sys

import pytest

import config
from config import Config


def _write(path, text, bom=False):
    path.write_text(text, encoding="utf-8-sig" if bom else "utf-8")


BASE_INI = """[Server]
Url = https://api.example.test

[EvidenceBackend]
Enabled = true
Url = https://api.example.test
DeviceToken = token-plano-123
"""


def test_reads_config_with_bom(tmp_path, monkeypatch):
    monkeypatch.setattr(config, "_win32crypt", lambda: None)
    path = tmp_path / "config.ini"
    _write(path, BASE_INI, bom=True)
    cfg = Config(str(path))
    assert cfg.server_url == "https://api.example.test"
    assert cfg.evidence_backend_enabled is True


def test_fallback_without_dpapi_keeps_plaintext_and_warns(tmp_path, monkeypatch, caplog):
    monkeypatch.setattr(config, "_win32crypt", lambda: None)
    path = tmp_path / "config.ini"
    _write(path, BASE_INI)
    original = path.read_text(encoding="utf-8")
    with caplog.at_level("WARNING", logger="vyntra.config"):
        cfg = Config(str(path))
    assert cfg.evidence_device_token == "token-plano-123"
    assert path.read_text(encoding="utf-8") == original  # no se reescribe
    assert any("DPAPI no disponible" in record.getMessage() for record in caplog.records)

    cfg.save_device_token("token-nuevo")
    text = path.read_bytes()
    assert not text.startswith(b"\xef\xbb\xbf"), "se escribe sin BOM"
    assert b"DeviceToken = token-nuevo" in text
    assert Config(str(path)).evidence_device_token == "token-nuevo"


def test_protected_token_unreadable_without_dpapi_is_ignored(tmp_path, monkeypatch):
    monkeypatch.setattr(config, "_win32crypt", lambda: None)
    path = tmp_path / "config.ini"
    _write(path, "[EvidenceBackend]\nEnabled = true\nDeviceTokenProtected = QUJD\n")
    assert Config(str(path)).evidence_device_token == ""


def test_save_language_is_atomic_and_keeps_key_case(tmp_path, monkeypatch):
    monkeypatch.setattr(config, "_win32crypt", lambda: None)
    path = tmp_path / "config.ini"
    _write(path, "[Interface]\nLanguage = es\n[Agent]\nVersion = 1.2.3\n", bom=True)
    cfg = Config(str(path))
    cfg.save_language("en")
    raw = path.read_bytes()
    assert not raw.startswith(b"\xef\xbb\xbf")
    text = raw.decode("utf-8")
    assert "Language = en" in text
    assert "Version = 1.2.3" in text
    assert not list(tmp_path.glob("*.tmp"))


class _FakeCrypt:
    """Sustituto reversible de win32crypt para probar la migracion en cualquier SO."""

    @staticmethod
    def CryptProtectData(data, description, entropy, reserved, prompt, flags):
        return b"PROT:" + data[::-1]

    @staticmethod
    def CryptUnprotectData(blob, entropy, reserved, prompt, flags):
        assert blob.startswith(b"PROT:")
        return "desc", blob[5:][::-1]


def test_plaintext_token_migrates_to_protected(tmp_path, monkeypatch):
    monkeypatch.setattr(config, "_win32crypt", lambda: _FakeCrypt)
    path = tmp_path / "config.ini"
    _write(path, BASE_INI)
    cfg = Config(str(path))
    assert cfg.evidence_device_token == "token-plano-123"
    text = path.read_text(encoding="utf-8")
    assert "DeviceTokenProtected = " in text
    assert "token-plano-123" not in text
    assert "DeviceToken =" not in text
    assert Config(str(path)).evidence_device_token == "token-plano-123"


@pytest.mark.skipif(not sys.platform.startswith("win") or not config.dpapi_available(), reason="requiere DPAPI")
def test_real_dpapi_roundtrip(tmp_path):
    path = tmp_path / "config.ini"
    _write(path, BASE_INI)
    cfg = Config(str(path))
    assert cfg.evidence_device_token == "token-plano-123"
    assert "token-plano-123" not in path.read_text(encoding="utf-8")
    assert Config(str(path)).evidence_device_token == "token-plano-123"
