"""FastAPI application factory."""

from __future__ import annotations

import logging
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse

import catalog
import config
from backends import all_backends, unload_all
from database.session import init_db
from models import EngineStatus, HealthOut
from routes import edit, generate, profiles, settings
from routes import models as models_route
from services import generation_service, model_service, voice_service
from utils import audio
from utils.paths import is_managed

VERSION = "0.1.0"

log = logging.getLogger(__name__)

_MEDIA_TYPES = {
    ".wav": "audio/wav",
    ".mp3": "audio/mpeg",
    ".ogg": "audio/ogg",
    ".flac": "audio/flac",
    ".m4a": "audio/mp4",
}


def _active_model(engine: str) -> dict:
    """Which checkpoint an engine is pointed at, for the health badge."""
    try:
        repo_id = catalog.active_repo_id(engine)
    except KeyError:
        return {}
    return {
        "model": repo_id,
        "model_downloaded": model_service.is_downloaded(repo_id),
    }


@asynccontextmanager
async def lifespan(_app: FastAPI):
    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s %(levelname)-7s %(name)s: %(message)s",
    )
    init_db()
    generation_service.reset_stale_jobs()
    voice_service.reset_stale()
    # Voices whose print never finished — or was never extracted, because the
    # profile predates this step — are re-queued rather than failing later.
    voice_service.resume_pending()
    log.info("VoiceCraft backend ready — data dir: %s", config.DATA_DIR)
    yield
    generation_service.shutdown()
    model_service.shutdown()
    unload_all()


def create_app() -> FastAPI:
    app = FastAPI(title="VoiceCraft", version=VERSION, lifespan=lifespan)

    # The Tauri webview and the Vite dev server are the only callers. Nothing
    # here is exposed beyond localhost (PRD §8, privacy).
    app.add_middleware(
        CORSMiddleware,
        allow_origins=[
            "http://localhost:5173",
            "http://127.0.0.1:5173",
            "tauri://localhost",
            "http://tauri.localhost",
        ],
        allow_credentials=False,
        allow_methods=["*"],
        allow_headers=["*"],
    )

    app.include_router(profiles.router)
    app.include_router(generate.router)
    app.include_router(edit.router)
    app.include_router(models_route.router)
    app.include_router(settings.router)

    @app.get("/api/health", response_model=HealthOut)
    def health() -> HealthOut:
        """Backend + engine readiness, so the UI can say what's happening (FR13)."""
        engines = [
            EngineStatus(
                name=name,
                available=backend.available(),
                loaded=backend.is_loaded(),
                device=backend.device(),
                detail=(
                    None
                    if backend.available()
                    else "Python dependencies for this engine are not installed."
                ),
                **_active_model(name),
            )
            for name, backend in all_backends().items()
        ]
        has_ffmpeg = audio.ffmpeg_available()
        return HealthOut(
            status="ok" if has_ffmpeg and any(e.available for e in engines) else "degraded",
            version=VERSION,
            data_dir=str(config.DATA_DIR),
            ffmpeg=has_ffmpeg,
            engines=engines,
        )

    @app.get("/api/files")
    def get_file(path: str = Query(...)) -> FileResponse:
        """Stream a managed audio file for in-app playback.

        Only paths inside the app's own data directories are served — the
        client supplies the path, so it is untrusted input.
        """
        if not is_managed(path):
            raise HTTPException(status_code=403, detail="path is outside the data dir")
        resolved = Path(path)
        if not resolved.is_file():
            raise HTTPException(status_code=404, detail="file not found")
        return FileResponse(
            resolved,
            media_type=_MEDIA_TYPES.get(resolved.suffix.lower(), "application/octet-stream"),
            filename=resolved.name,
        )

    return app


app = create_app()
