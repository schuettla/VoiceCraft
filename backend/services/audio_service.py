"""Music and sound-effect jobs (docs/audio-roadmap.md §5.2–5.3, Phase 4).

Speech jobs start from a profile; these start from a prompt. They share the one
worker queue in `generation_service`, so a music job never runs next to a speech
job and the unload-before-job rule keeps VRAM to one model.

The checks in `enqueue` run in the order the user can fix them: is that an
engine at all → is it installed → are its weights downloaded → can this
hardware run it → is the clip short enough for this hardware. Every refusal says
what to do, because the alternative is a job that fails minutes later.
"""

from __future__ import annotations

import json
import logging
from typing import Any

from sqlalchemy.orm import Session

import catalog
import config
from backends import AudioSpec, Support, audio_backends
from database.models import Generation
from models import AudioGenerateRequest, GenerationStatus
from services import generation_service, model_service
from services.generation_service import EngineNotReady, GenerationError
from utils.paths import slugify, unique_path

log = logging.getLogger(__name__)

# Kinds in the order the UI lists them.
KIND_ORDER = ("music", "sfx")
# How many words of the prompt name the file: "door-slam-1a2b3c4d.wav".
SLUG_WORDS = 4


def _support(backend) -> Support:
    try:
        return backend.support()
    except Exception as exc:  # noqa: BLE001 - a broken GPU probe must not break the page
        log.warning("could not inspect hardware for %s", getattr(backend, "name", "?"), exc_info=True)
        return Support(False, reason=f"Could not check this machine ({type(exc).__name__}).")


def _active_spec(engine: str) -> catalog.ModelSpec | None:
    try:
        return catalog.active_model(engine)
    except KeyError:
        return None


def _downloaded(engine: str) -> bool:
    try:
        return model_service.active_downloaded(engine)
    except KeyError:
        return False


def engine_info(name: str, backend) -> dict[str, Any]:
    """Everything the Generate view and the Models page need to know about one engine."""
    support = _support(backend)
    spec = _active_spec(name)
    installed = backend.available()
    downloaded = _downloaded(name)
    try:
        default_steps, default_guidance = backend.defaults()
    except Exception:  # noqa: BLE001 - a test double or an older engine may not have them
        default_steps = default_guidance = None
    return {
        "name": name,
        "kind": backend.kind,
        "label": getattr(backend, "label", name),
        "default": catalog.default_engine(backend.kind) == name,
        "installed": installed,
        "supported": support.ok,
        "unsupported_reason": None if support.ok else support.reason,
        "warning": support.warning if support.ok else None,
        "max_duration_seconds": support.max_duration_seconds if support.ok else None,
        "default_steps": default_steps,
        "default_guidance": default_guidance,
        "loaded": backend.is_loaded(),
        "device": backend.device(),
        "model_id": spec.id if spec else None,
        "model_title": spec.title if spec else None,
        "model_downloaded": downloaded,
        "download_estimate_bytes": spec.download_estimate_bytes if spec else None,
        "license_tier": spec.license_tier if spec else "open",
        "license_name": (spec.license_name or None) if spec else None,
        "license_url": (spec.license_url or None) if spec else None,
        "gated": spec.gated if spec else False,
        "lyrics": bool(getattr(backend, "supports_lyrics", backend.kind == "music")),
        "ready": installed and downloaded and support.ok,
    }


def overview() -> list[dict[str, Any]]:
    """Every music / SFX engine, music first, each kind's default leading."""
    engines = audio_backends()

    def order(item: tuple[str, Any]) -> tuple[int, int, int]:
        name, backend = item
        kind = KIND_ORDER.index(backend.kind) if backend.kind in KIND_ORDER else len(KIND_ORDER)
        return (kind, 0 if catalog.default_engine(backend.kind) == name else 1, 0)

    return [engine_info(name, backend) for name, backend in sorted(engines.items(), key=order)]


def _resolve_engine(request: AudioGenerateRequest):
    name = request.engine or catalog.default_engine(request.kind)
    if not name:
        raise GenerationError(f"there is no {request.kind} engine")
    everything = audio_backends()
    backend = everything.get(name)
    if backend is None:
        known = ", ".join(sorted(audio_backends(request.kind))) or "none"
        raise GenerationError(f"unknown engine {name!r}; {request.kind} engines: {known}")
    if backend.kind != request.kind:
        raise GenerationError(
            f"{getattr(backend, 'label', name)} makes {backend.kind}, not {request.kind}"
        )
    # An engine that can't sing must say so now, not return an instrumental the
    # user asked a lyric for.
    if request.lyrics and not getattr(backend, "supports_lyrics", True):
        raise GenerationError(
            f"{getattr(backend, 'label', name)} can't sing lyrics. Pick another engine "
            "for vocals, or ask for an instrumental."
        )
    return name, backend


def _check_ready(name: str, backend, request: AudioGenerateRequest) -> None:
    label = getattr(backend, "label", name)
    if not backend.available():
        raise EngineNotReady(f"{label} is not installed. Install it from the Models page.")
    if not _downloaded(name):
        spec = _active_spec(name)
        what = spec.title if spec else "its model"
        raise EngineNotReady(f"{what} is not downloaded yet. Get it from the Models page.")
    support = _support(backend)
    if not support.ok:
        raise EngineNotReady(support.reason or f"{label} can't run on this machine.")
    limit = support.max_duration_seconds
    if limit is not None and request.duration_seconds > limit:
        raise GenerationError(
            f"{label} can make clips of at most {limit:.0f} seconds on this machine "
            f"(you asked for {request.duration_seconds:g}). Ask for a shorter one."
        )


def _slug(prompt: str, kind: str) -> str:
    return slugify(" ".join(prompt.split()[:SLUG_WORDS]).lower(), kind)


def enqueue(session: Session, request: AudioGenerateRequest) -> list[Generation]:
    """Queue `request.takes` jobs (one for music) and return their `queued` rows."""
    name, backend = _resolve_engine(request)
    _check_ready(name, backend, request)

    rows: list[tuple[Generation, AudioSpec]] = []
    for take in range(request.takes):
        # A fixed seed with several takes would give the same clip N times, so
        # each take offsets it; the seed actually used is what the row records.
        seed = None if request.seed is None else (request.seed + take) % (2**31)
        params: dict[str, Any] = {"duration_seconds": request.duration_seconds}
        for key, value in (
            ("lyrics", request.lyrics),
            ("seed", seed),
            ("steps", request.steps),
            ("guidance", request.guidance),
        ):
            if value is not None:
                params[key] = value
        if request.takes > 1:
            params["take"], params["takes"] = take + 1, request.takes

        generation = Generation(
            profile_id=None,
            kind=request.kind,
            engine=name,
            params=json.dumps(params),
            text=request.prompt,
            status=GenerationStatus.queued.value,
        )
        session.add(generation)
        session.commit()
        session.refresh(generation)
        spec = AudioSpec(
            prompt=request.prompt,
            duration_seconds=request.duration_seconds,
            lyrics=request.lyrics,
            seed=seed,
            steps=request.steps,
            guidance=request.guidance,
        )
        rows.append((generation, spec))

    stem = _slug(request.prompt, request.kind)
    for generation, spec in rows:
        out_path = unique_path(
            config.GENERATIONS_DIR, f"{stem}-{generation.id[:8]}", f".{request.output_format}"
        )
        generation_service.submit(
            generation_service.run_audio_job, generation.id, name, spec, out_path
        )
    return [generation for generation, _ in rows]
