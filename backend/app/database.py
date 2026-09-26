"""
database.py - SQLAlchemy setup.
"""

from collections.abc import Generator

from sqlalchemy import create_engine
from sqlalchemy.orm import DeclarativeBase, Session, sessionmaker

from app.config import settings


class Base(DeclarativeBase):
    pass


_is_sqlite = settings.database_url.startswith("sqlite")
engine = create_engine(
    settings.database_url,
    pool_pre_ping=True,
    future=True,
    # SQLite solo se usa en desarrollo/pruebas; FastAPI usa varios hilos.
    connect_args={"check_same_thread": False} if _is_sqlite else {},
)
SessionLocal = sessionmaker(bind=engine, autoflush=False, autocommit=False, future=True)


def get_db() -> Generator[Session, None, None]:
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()
