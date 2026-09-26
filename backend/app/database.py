"""
database.py - SQLAlchemy setup.
"""

from collections.abc import Generator

from sqlalchemy import create_engine, event
from sqlalchemy.orm import DeclarativeBase, Session, sessionmaker

from app.config import settings


class Base(DeclarativeBase):
    pass


_is_sqlite = settings.database_url.startswith("sqlite")
engine = create_engine(
    settings.database_url,
    pool_pre_ping=True,
    future=True,
    connect_args={"check_same_thread": False} if _is_sqlite else {},
)

if _is_sqlite:
    # SQLite (solo desarrollo/pruebas): receta de SQLAlchemy para que pysqlite
    # respete BEGIN/SAVEPOINT y los savepoints por evento funcionen igual que en PostgreSQL.
    @event.listens_for(engine, "connect")
    def _sqlite_on_connect(dbapi_connection, _connection_record):
        dbapi_connection.isolation_level = None

    @event.listens_for(engine, "begin")
    def _sqlite_on_begin(conn):
        conn.exec_driver_sql("BEGIN")
SessionLocal = sessionmaker(bind=engine, autoflush=False, autocommit=False, future=True)


def get_db() -> Generator[Session, None, None]:
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()
