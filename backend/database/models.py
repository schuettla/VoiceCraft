"""SQLAlchemy ORM models: profiles, generations, edit_assets (PRD §6)."""

from __future__ import annotations

import datetime as dt
import uuid
from pathlib import Path

from sqlalchemy import Boolean, DateTime, Float, ForeignKey, Integer, String, Text
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column, relationship


def _uuid() -> str:
    return uuid.uuid4().hex


def _now() -> dt.datetime:
    return dt.datetime.now(dt.timezone.utc)


class Base(DeclarativeBase):
    pass


class Profile(Base):
    """A voice profile.

    For the `qwen` engine, `sample_path` points at an uploaded reference clip.
    For `kokoro`, cloning is not possible — `preset_voice` holds a built-in
    voice id instead (PRD §5, "Known constraint"). Exactly one of the two is
    set; the service layer enforces that.
    """

    __tablename__ = "profiles"

    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=_uuid)
    name: Mapped[str] = mapped_column(String(200), nullable=False)
    engine: Mapped[str] = mapped_column(String(32), nullable=False)
    language: Mapped[str] = mapped_column(String(16), nullable=False, default="en")
    sample_path: Mapped[str | None] = mapped_column(Text, nullable=True)
    sample_text: Mapped[str | None] = mapped_column(Text, nullable=True)
    preset_voice: Mapped[str | None] = mapped_column(String(64), nullable=True)
    created_at: Mapped[dt.datetime] = mapped_column(DateTime, default=_now)

    # The cloning step: `voice_path` holds the extracted voice print (speaker
    # embedding + reference codes). Preset-voice profiles have nothing to
    # extract, so they sit at "not_needed" forever.
    voice_status: Mapped[str] = mapped_column(
        String(16), nullable=False, default="pending"
    )  # pending | preparing | ready | failed | not_needed
    voice_path: Mapped[str | None] = mapped_column(Text, nullable=True)
    voice_mode: Mapped[str | None] = mapped_column(String(16), nullable=True)
    voice_model_id: Mapped[str | None] = mapped_column(Text, nullable=True)
    voice_error: Mapped[str | None] = mapped_column(Text, nullable=True)
    voice_prepared_at: Mapped[dt.datetime | None] = mapped_column(
        DateTime, nullable=True
    )

    generations: Mapped[list["Generation"]] = relationship(
        back_populates="profile", cascade="save-update"
    )


class Generation(Base):
    """One TTS run. Status is persisted so history survives restarts (FR5)."""

    __tablename__ = "generations"

    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=_uuid)
    profile_id: Mapped[str | None] = mapped_column(
        ForeignKey("profiles.id", ondelete="SET NULL"), nullable=True
    )
    # speech | music | sfx. `text` is the script (speech), the style prompt
    # (music) or the description (sfx).
    kind: Mapped[str] = mapped_column(String(8), nullable=False, default="speech")
    # qwen | kokoro | kitten | acestep | moss_sfx | … Rows from before this
    # column existed are null and resolve through their profile.
    engine: Mapped[str | None] = mapped_column(String(32), nullable=True)
    # Per-generation options as JSON: Kitten preset/seed, music lyrics/steps/…
    params: Mapped[str | None] = mapped_column(Text, nullable=True)
    text: Mapped[str] = mapped_column(Text, nullable=False)
    status: Mapped[str] = mapped_column(String(16), nullable=False, default="queued")
    audio_path: Mapped[str | None] = mapped_column(Text, nullable=True)
    duration_seconds: Mapped[float | None] = mapped_column(Float, nullable=True)
    error: Mapped[str | None] = mapped_column(Text, nullable=True)
    device: Mapped[str | None] = mapped_column(String(16), nullable=True)
    warning: Mapped[str | None] = mapped_column(Text, nullable=True)
    created_at: Mapped[dt.datetime] = mapped_column(DateTime, default=_now)
    completed_at: Mapped[dt.datetime | None] = mapped_column(DateTime, nullable=True)
    # Starred in the Library — the user's own "keep this one" marker.
    favorite: Mapped[bool] = mapped_column(
        Boolean, nullable=False, default=False, server_default="0"
    )

    profile: Mapped["Profile | None"] = relationship(back_populates="generations")

    @property
    def format(self) -> str | None:
        """Container the audio was written in — derived, so no column to migrate."""
        if not self.audio_path:
            return None
        return Path(self.audio_path).suffix.lstrip(".").lower() or None


class EditAsset(Base):
    """A reusable intro/outro/clip asset, or the output of an edit operation (FR11)."""

    __tablename__ = "edit_assets"

    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=_uuid)
    name: Mapped[str] = mapped_column(String(200), nullable=False)
    kind: Mapped[str] = mapped_column(String(16), nullable=False)  # intro|outro|clip|output
    path: Mapped[str] = mapped_column(Text, nullable=False)
    duration_seconds: Mapped[float | None] = mapped_column(Float, nullable=True)
    format: Mapped[str] = mapped_column(String(8), nullable=False, default="wav")
    size_bytes: Mapped[int | None] = mapped_column(Integer, nullable=True)
    created_at: Mapped[dt.datetime] = mapped_column(DateTime, default=_now)


class EditProject(Base):
    """A saved multitrack timeline (tracks, clips, intro/outro, master bus).

    `data` is the whole timeline as JSON — see `models.ProjectData`. Storing it
    as one blob rather than normalized tables means the editor's schema can
    grow (new clip/track/effect fields) without a migration; `schema_version`
    inside the JSON is there for the day that stops being true.
    """

    __tablename__ = "edit_projects"

    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=_uuid)
    name: Mapped[str] = mapped_column(String(200), nullable=False, default="Untitled project")
    data: Mapped[str] = mapped_column(Text, nullable=False, default="{}")
    duration_seconds: Mapped[float | None] = mapped_column(Float, nullable=True)
    created_at: Mapped[dt.datetime] = mapped_column(DateTime, default=_now)
    updated_at: Mapped[dt.datetime] = mapped_column(DateTime, default=_now, onupdate=_now)
