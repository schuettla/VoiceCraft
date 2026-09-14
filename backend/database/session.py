"""SQLite engine + session factory."""

from __future__ import annotations

import logging
from collections.abc import Iterator
from contextlib import contextmanager

from sqlalchemy import create_engine, event
from sqlalchemy.orm import Session, sessionmaker

import config
from database.models import Base

log = logging.getLogger(__name__)

_engine = create_engine(
    f"sqlite:///{config.DB_PATH.as_posix()}",
    future=True,
    connect_args={"check_same_thread": False},
)


@event.listens_for(_engine, "connect")
def _sqlite_pragmas(dbapi_connection, _record):  # pragma: no cover - driver hook
    cursor = dbapi_connection.cursor()
    # WAL keeps reads from blocking while a generation writes its status.
    cursor.execute("PRAGMA journal_mode=WAL")
    cursor.execute("PRAGMA foreign_keys=ON")
    cursor.close()


SessionLocal = sessionmaker(bind=_engine, autoflush=False, expire_on_commit=False)


# Columns added after the first release. SQLite can only append columns, which
# is all we need — a full migration tool would be more machinery than a
# single-user local database is worth.
_ADDED_COLUMNS: dict[str, dict[str, str]] = {
    "profiles": {
        "voice_status": "VARCHAR(16) NOT NULL DEFAULT 'pending'",
        "voice_path": "TEXT",
        "voice_mode": "VARCHAR(16)",
        "voice_model_id": "TEXT",
        "voice_error": "TEXT",
        "voice_prepared_at": "DATETIME",
    },
}


def _add_missing_columns() -> None:
    with _engine.begin() as connection:
        for table, columns in _ADDED_COLUMNS.items():
            existing = {
                row[1]
                for row in connection.exec_driver_sql(
                    f"PRAGMA table_info({table})"
                ).fetchall()
            }
            if not existing:  # table not created yet — create_all handles it
                continue
            for name, ddl in columns.items():
                if name not in existing:
                    log.info("adding column %s.%s", table, name)
                    connection.exec_driver_sql(
                        f"ALTER TABLE {table} ADD COLUMN {name} {ddl}"
                    )


def init_db() -> None:
    config.ensure_dirs()
    Base.metadata.create_all(_engine)
    _add_missing_columns()


def get_session() -> Iterator[Session]:
    """FastAPI dependency."""
    session = SessionLocal()
    try:
        yield session
    finally:
        session.close()


@contextmanager
def session_scope() -> Iterator[Session]:
    """Standalone session for background work (generation worker)."""
    session = SessionLocal()
    try:
        yield session
        session.commit()
    except Exception:
        session.rollback()
        raise
    finally:
        session.close()
