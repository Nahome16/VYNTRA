"""
Configuracion comun de pruebas.

Las variables de entorno se fijan ANTES de importar `app`, porque app.config lee
el entorno al importarse. Se usa SQLite en un directorio temporal y nunca se
ejecuta el evento de arranque de FastAPI (que en produccion asume PostgreSQL).
"""

import os
from pathlib import Path
import shutil
import sys
import tempfile

import pytest

_TMP_DIR = Path(tempfile.mkdtemp(prefix="vyntra-tests-"))
os.environ["ENVIRONMENT"] = "test"
os.environ["DATABASE_URL"] = f"sqlite:///{(_TMP_DIR / 'test.db').as_posix()}"
os.environ["STORAGE_DIR"] = str(_TMP_DIR / "evidence")
os.environ["DOWNLOADS_DIR"] = str(_TMP_DIR / "downloads")
os.environ.setdefault("LOG_LEVEL", "WARNING")
os.environ.pop("ADMIN_ALLOWED_IPS", None)
os.environ.pop("AGENT_ALLOWED_IPS", None)

BACKEND_ROOT = Path(__file__).resolve().parents[1]
if str(BACKEND_ROOT) not in sys.path:
    sys.path.insert(0, str(BACKEND_ROOT))

from app.database import Base, SessionLocal, engine  # noqa: E402
import app.main  # noqa: E402,F401  (registra todos los modelos y rutas)


@pytest.fixture()
def db():
    Base.metadata.drop_all(bind=engine)
    Base.metadata.create_all(bind=engine)
    os.makedirs(os.environ["STORAGE_DIR"], exist_ok=True)
    session = SessionLocal()
    try:
        yield session
    finally:
        session.close()
        Base.metadata.drop_all(bind=engine)


@pytest.fixture()
def storage_dir():
    path = Path(os.environ["STORAGE_DIR"])
    path.mkdir(parents=True, exist_ok=True)
    yield path
    shutil.rmtree(path, ignore_errors=True)


def pytest_sessionfinish(session, exitstatus):
    engine.dispose()
    shutil.rmtree(_TMP_DIR, ignore_errors=True)
