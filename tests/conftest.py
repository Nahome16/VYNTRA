"""Configuracion comun de pytest para el agente VYNTRA.

Cada prueba usa una carpeta LOCALAPPDATA temporal para no tocar los datos reales
del equipo (outbox, jornadas, logs, cache de reglas).
"""

import datetime
import logging
import os
import sys

import pytest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if ROOT not in sys.path:
    sys.path.insert(0, ROOT)


@pytest.fixture(autouse=True)
def isolated_appdata(tmp_path, monkeypatch):
    appdata = tmp_path / "LocalAppData"
    appdata.mkdir()
    monkeypatch.setenv("LOCALAPPDATA", str(appdata))
    monkeypatch.delenv("VYNTRA_DEV_MODE", raising=False)
    yield appdata
    import outbox

    outbox.close()
    import agent_runtime

    logger = logging.getLogger(agent_runtime.LOGGER_NAME)
    for handler in list(logger.handlers):
        logger.removeHandler(handler)
        handler.close()
    agent_runtime._configured_path = None


class FakeClock:
    """Reloj inyectable: monotono, epoch y fecha local controlados por la prueba."""

    def __init__(self, start: datetime.datetime):
        assert start.tzinfo is not None
        self.mono = 10_000.0
        self.wall = start.timestamp()
        self.tz = start.tzinfo

    def monotonic(self) -> float:
        return self.mono

    def time(self) -> float:
        return self.wall

    def now(self) -> datetime.datetime:
        return datetime.datetime.fromtimestamp(self.wall, tz=self.tz)

    def advance(self, seconds: float, mono: bool = True, wall: bool = True):
        if mono:
            self.mono += seconds
        if wall:
            self.wall += seconds


class FakeCfg:
    evidence_backend_enabled = True
    evidence_backend_url = "https://api.example.test"
    evidence_device_token = "token-de-prueba"
    evidence_request_timeout = 5
    idle_umbral_segundos = 60
    station_auth_allow_local_fallback = False


@pytest.fixture
def fake_cfg():
    return FakeCfg()


@pytest.fixture
def make_clock():
    return FakeClock
