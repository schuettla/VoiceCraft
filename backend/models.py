"""Pydantic request/response schemas for the HTTP API."""

from __future__ import annotations

import datetime as dt
from enum import Enum
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, model_validator

import config


class Engine(str, Enum):
    qwen = "qwen"
    kokoro = "kokoro"


class VoiceStatus(str, Enum):
    """Where a profile is in the cloning step (see services/voice_service.py)."""

    not_needed = "not_needed"   # preset-voice engine: nothing to extract
    pending = "pending"         # queued behind whatever the worker is doing
    preparing = "preparing"
    ready = "ready"
    failed = "failed"


class GenerationStatus(str, Enum):
    queued = "queued"
    processing = "processing"
    completed = "completed"
    failed = "failed"


AudioFormat = Literal["wav", "mp3", "ogg", "flac"]


# --------------------------------------------------------------------------
# Profiles
# --------------------------------------------------------------------------


class ProfileCreate(BaseModel):
    """Non-file fields of a profile creation request.

    The reference sample (qwen) arrives as multipart form data, so the route
    assembles this itself rather than binding it as a JSON body.
    """

    name: str = Field(min_length=1, max_length=200)
    engine: Engine
    language: str = Field(default="en", max_length=16)
    preset_voice: str | None = None
    sample_text: str | None = None


class ProfileOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: str
    name: str
    engine: Engine
    language: str
    sample_path: str | None
    sample_text: str | None
    preset_voice: str | None
    created_at: dt.datetime

    # The cloning step.
    voice_status: VoiceStatus
    voice_path: str | None = None
    voice_mode: str | None = None      # "icl" | "x-vector"
    voice_model_id: str | None = None
    voice_error: str | None = None
    voice_prepared_at: dt.datetime | None = None


# --------------------------------------------------------------------------
# Generation
# --------------------------------------------------------------------------


class GenerateRequest(BaseModel):
    profile_id: str
    text: str = Field(min_length=1)
    speed: float = Field(default=1.0, ge=0.5, le=2.0)
    # The engines emit WAV; anything else is an ffmpeg transcode of it, done
    # as part of the job so the history holds the format that was asked for.
    output_format: AudioFormat = "wav"


class GenerationOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: str
    profile_id: str | None
    text: str
    status: GenerationStatus
    audio_path: str | None
    format: str | None = None       # derived from audio_path's extension
    duration_seconds: float | None
    error: str | None
    device: str | None
    warning: str | None
    created_at: dt.datetime
    completed_at: dt.datetime | None


# --------------------------------------------------------------------------
# Editing
# --------------------------------------------------------------------------


class AssetOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: str
    name: str
    kind: str
    path: str
    duration_seconds: float | None
    format: str
    size_bytes: int | None
    created_at: dt.datetime


class TrimRequest(BaseModel):
    """Cut a source clip to [start, end] seconds (FR7)."""

    generation_id: str | None = None
    asset_id: str | None = None
    start: float = Field(default=0.0, ge=0.0)
    end: float | None = Field(default=None, gt=0.0)
    output_format: AudioFormat = "wav"
    name: str | None = None

    @model_validator(mode="after")
    def _check(self) -> "TrimRequest":
        if bool(self.generation_id) == bool(self.asset_id):
            raise ValueError("provide exactly one of generation_id or asset_id")
        if self.end is not None and self.end <= self.start:
            raise ValueError("end must be greater than start")
        return self


class SegmentRef(BaseModel):
    """One item in an assembly: either a generation or a stored asset."""

    generation_id: str | None = None
    asset_id: str | None = None

    @model_validator(mode="after")
    def _check(self) -> "SegmentRef":
        if bool(self.generation_id) == bool(self.asset_id):
            raise ValueError("provide exactly one of generation_id or asset_id")
        return self


class AssembleRequest(BaseModel):
    """intro? + segments + outro?, with crossfade between neighbours (FR8)."""

    intro_asset_id: str | None = None
    outro_asset_id: str | None = None
    segments: list[SegmentRef] = Field(min_length=1)
    crossfade_ms: int = Field(default=0, ge=0, le=config.MAX_CROSSFADE_MS)
    output_format: AudioFormat = "mp3"
    name: str | None = None


class ConvertRequest(BaseModel):
    """Export any clip to another container/codec (FR9)."""

    generation_id: str | None = None
    asset_id: str | None = None
    output_format: AudioFormat
    name: str | None = None

    @model_validator(mode="after")
    def _check(self) -> "ConvertRequest":
        if bool(self.generation_id) == bool(self.asset_id):
            raise ValueError("provide exactly one of generation_id or asset_id")
        return self


# --------------------------------------------------------------------------
# Timeline editor — multitrack projects (the Edit page)
# --------------------------------------------------------------------------


class EffectInstance(BaseModel):
    """One entry in a clip/track/master effects chain.

    `type` must be a key in `effects.REGISTRY`; `params` are validated against
    that effect's param specs when the project is rendered.
    """

    id: str
    type: str
    params: dict[str, float | int | str | bool] = Field(default_factory=dict)
    enabled: bool = True


class SourceRef(BaseModel):
    """Same shape as `SegmentRef` — a generation or a stored asset."""

    generation_id: str | None = None
    asset_id: str | None = None

    @model_validator(mode="after")
    def _check(self) -> "SourceRef":
        if bool(self.generation_id) == bool(self.asset_id):
            raise ValueError("provide exactly one of generation_id or asset_id")
        return self


class TimelineClip(BaseModel):
    id: str
    track_id: str
    source: SourceRef
    start: float = Field(ge=0.0)          # position on the timeline, seconds
    in_point: float = Field(default=0.0, ge=0.0)   # offset into the source
    out_point: float | None = None                 # None = to the end of the source
    gain_db: float = Field(default=0.0, ge=-60.0, le=24.0)
    fade_in: float = Field(default=0.0, ge=0.0)
    fade_out: float = Field(default=0.0, ge=0.0)
    effects: list[EffectInstance] = Field(default_factory=list)
    muted: bool = False

    @model_validator(mode="after")
    def _check(self) -> "TimelineClip":
        if self.out_point is not None and self.out_point <= self.in_point:
            raise ValueError("out_point must be greater than in_point")
        return self


class DuckSettings(BaseModel):
    """Voice-triggered ducking: this track's level dips while a key track plays."""

    enabled: bool = False
    against_track_ids: list[str] = Field(default_factory=list)
    amount_db: float = Field(default=-12.0, le=0.0, ge=-40.0)
    attack_ms: float = Field(default=20.0, ge=1.0, le=2000.0)
    release_ms: float = Field(default=250.0, ge=1.0, le=4000.0)


class TrackKind(str, Enum):
    voice = "voice"
    music = "music"
    sfx = "sfx"
    other = "other"


class Track(BaseModel):
    # Used verbatim inside ffmpeg filter-graph labels, so no graph syntax chars.
    id: str = Field(pattern=r"^[A-Za-z0-9_-]{1,64}$")
    name: str = "Track"
    kind: TrackKind = TrackKind.other
    gain_db: float = Field(default=0.0, ge=-60.0, le=24.0)
    pan: float = Field(default=0.0, ge=-1.0, le=1.0)
    mute: bool = False
    solo: bool = False
    effects: list[EffectInstance] = Field(default_factory=list)
    duck: DuckSettings = Field(default_factory=DuckSettings)


class IntroOutroSlot(BaseModel):
    asset_id: str | None = None
    crossfade_ms: int = Field(default=0, ge=0, le=config.MAX_CROSSFADE_MS)
    gain_db: float = Field(default=0.0, ge=-60.0, le=24.0)


class LoudnessSettings(BaseModel):
    enabled: bool = False
    target_lufs: float = Field(default=-16.0, ge=-40.0, le=-5.0)
    true_peak: float = Field(default=-1.5, ge=-9.0, le=0.0)


class MasterBus(BaseModel):
    effects: list[EffectInstance] = Field(default_factory=list)
    loudness: LoudnessSettings = Field(default_factory=LoudnessSettings)


class ExportSettings(BaseModel):
    output_format: AudioFormat = "mp3"
    sample_rate: int = Field(default=44100, ge=8000, le=192000)
    channels: int = Field(default=2, ge=1, le=2)


class Marker(BaseModel):
    """A named point on the timeline — navigation only, has no audio effect."""

    id: str
    time: float = Field(ge=0.0)
    label: str = ""
    color: str | None = None


class ProjectData(BaseModel):
    """The whole timeline — the only source of truth for the editor."""

    schema_version: int = 1
    tracks: list[Track] = Field(default_factory=list)
    clips: list[TimelineClip] = Field(default_factory=list)
    intro: IntroOutroSlot = Field(default_factory=IntroOutroSlot)
    outro: IntroOutroSlot = Field(default_factory=IntroOutroSlot)
    master: MasterBus = Field(default_factory=MasterBus)
    export: ExportSettings = Field(default_factory=ExportSettings)
    markers: list[Marker] = Field(default_factory=list)


class ProjectIn(BaseModel):
    name: str = Field(default="Untitled project", min_length=1, max_length=200)
    data: ProjectData = Field(default_factory=ProjectData)


class ProjectOut(BaseModel):
    id: str
    name: str
    data: ProjectData
    duration_seconds: float | None
    created_at: dt.datetime
    updated_at: dt.datetime


class ProjectSummary(BaseModel):
    """Lightweight row for the project picker — no timeline payload."""

    model_config = ConfigDict(from_attributes=True)

    id: str
    name: str
    duration_seconds: float | None
    created_at: dt.datetime
    updated_at: dt.datetime


class EffectParamSpec(BaseModel):
    key: str
    label: str
    kind: Literal["float", "int", "bool", "choice"]
    default: float | int | str | bool
    min: float | None = None
    max: float | None = None
    step: float | None = None
    unit: str | None = None
    choices: list[str] | None = None


class EffectSpecOut(BaseModel):
    type: str
    label: str
    category: str
    preview: Literal["webaudio", "render"]
    params: list[EffectParamSpec]


class RenderJobOut(BaseModel):
    id: str
    state: Literal["queued", "measuring", "rendering", "completed", "failed", "cancelled"]
    progress: float = 0.0  # 0..1, best-effort from ffmpeg -progress
    asset: AssetOut | None = None
    error: str | None = None


class RenderRequest(BaseModel):
    name: str | None = None
    # The editor sends its live document so an export never races the
    # debounced autosave; omitted, the last saved version is rendered.
    data: ProjectData | None = None


class PreviewRequest(BaseModel):
    """Render one clip's effect chain (or the master bus) for auditioning."""

    clip_id: str | None = None
    data: ProjectData


class BounceRequest(BaseModel):
    """Render a clip's effect chain (optionally a sub-range of it) down to a
    new, reusable `clip` asset — the source clip is untouched (FR10)."""

    clip_id: str
    data: ProjectData
    start: float | None = Field(default=None, ge=0.0)
    end: float | None = Field(default=None, gt=0.0)
    name: str | None = None
    output_format: AudioFormat = "wav"

    @model_validator(mode="after")
    def _check(self) -> "BounceRequest":
        if self.start is not None and self.end is not None and self.end <= self.start:
            raise ValueError("end must be greater than start")
        return self


class SilenceDetectRequest(BaseModel):
    generation_id: str | None = None
    asset_id: str | None = None
    noise_db: float = Field(default=-30.0, le=0.0, ge=-90.0)
    min_duration: float = Field(default=0.5, ge=0.05, le=30.0)

    @model_validator(mode="after")
    def _check(self) -> "SilenceDetectRequest":
        if bool(self.generation_id) == bool(self.asset_id):
            raise ValueError("provide exactly one of generation_id or asset_id")
        return self


class SilenceRegion(BaseModel):
    start: float
    end: float


class SilenceReport(BaseModel):
    regions: list[SilenceRegion]


class LoudnessRequest(BaseModel):
    generation_id: str | None = None
    asset_id: str | None = None

    @model_validator(mode="after")
    def _check(self) -> "LoudnessRequest":
        if bool(self.generation_id) == bool(self.asset_id):
            raise ValueError("provide exactly one of generation_id or asset_id")
        return self


class LoudnessReport(BaseModel):
    integrated_lufs: float | None
    true_peak_db: float | None
    loudness_range: float | None
    threshold_db: float | None = None


# --------------------------------------------------------------------------
# Models
# --------------------------------------------------------------------------


class DownloadJobOut(BaseModel):
    """Progress of an in-flight download, polled by the Models page."""

    state: Literal["queued", "downloading", "completed", "failed", "cancelled"]
    downloaded_bytes: int
    total_bytes: int
    error: str | None = None


class ModelOut(BaseModel):
    """One catalog entry plus its state on this machine (FR14)."""

    id: str
    repo_id: str
    title: str
    category: str
    engine: Engine
    summary: str
    notes: list[str]
    languages: list[str]
    clones_voices: bool
    needs_gpu: bool
    downloaded: bool
    size_bytes: int | None          # measured on disk; null until downloaded
    download_estimate_bytes: int    # published size, for the progress bar
    active: bool                    # the checkpoint its engine loads
    engine_available: bool          # engine's Python deps are installed
    path: str | None
    job: DownloadJobOut | None = None


class ModelCategoryOut(BaseModel):
    id: str
    label: str


class ModelsOut(BaseModel):
    models_dir: str
    models_dir_exists: bool
    free_bytes: int | None
    used_bytes: int
    categories: list[ModelCategoryOut]
    models: list[ModelOut]


class StorageRequest(BaseModel):
    """Where model weights are kept. Empty path resets to the HF default."""

    path: str = ""


# --------------------------------------------------------------------------
# Health
# --------------------------------------------------------------------------


class EngineStatus(BaseModel):
    name: str
    available: bool
    loaded: bool
    device: str | None = None
    detail: str | None = None
    model: str | None = None          # repo id this engine will load
    model_downloaded: bool = False    # …and whether its weights are on disk


class HealthOut(BaseModel):
    """Surfaced in the UI so the user isn't staring at a blind spinner (FR13)."""

    status: Literal["ok", "degraded"]
    version: str
    data_dir: str
    ffmpeg: bool
    engines: list[EngineStatus]


# --------------------------------------------------------------------------
# Settings
# --------------------------------------------------------------------------


class Preferences(BaseModel):
    """Defaults new work starts from. Persisted in settings.json."""

    default_engine: Engine = Engine.qwen
    default_language: str = Field(default="en", max_length=16)
    default_output_format: AudioFormat = "mp3"
    default_crossfade_ms: int = Field(default=0, ge=0, le=config.MAX_CROSSFADE_MS)


class DirectoryInfo(BaseModel):
    key: str
    label: str
    path: str
    files: int
    bytes: int


class ToolInfo(BaseModel):
    available: bool
    ffmpeg_path: str
    ffprobe_path: str


class SettingsOut(BaseModel):
    data_dir: str
    db_path: str
    db_bytes: int
    settings_path: str
    host: str
    port: int
    directories: list[DirectoryInfo]
    free_bytes: int | None = None
    ffmpeg: ToolInfo
    gpu: dict
    engines_loaded: list[str]
    preferences: Preferences


class CleanupResult(BaseModel):
    files_removed: int
    bytes_freed: int
