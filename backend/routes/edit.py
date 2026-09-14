"""/api/edit — trim, assemble, convert, timeline projects, and asset management
(FR7–FR11 plus the multitrack editor)."""

from __future__ import annotations

import subprocess
from pathlib import Path

from fastapi import APIRouter, Depends, File, Form, HTTPException, Query, Response, UploadFile
from sqlalchemy.orm import Session

import effects
from database.session import get_session
from models import (
    AssembleRequest,
    AssetOut,
    BounceRequest,
    ConvertRequest,
    EffectSpecOut,
    LoudnessReport,
    LoudnessRequest,
    PreviewRequest,
    ProjectIn,
    ProjectOut,
    ProjectSummary,
    RenderJobOut,
    RenderRequest,
    SilenceDetectRequest,
    SilenceReport,
    TrimRequest,
)
from services import edit_service
from services.edit_service import EditError
from utils.paths import is_managed

router = APIRouter(prefix="/api/edit", tags=["edit"])


@router.get("/assets", response_model=list[AssetOut])
def list_assets(
    kind: str | None = None, session: Session = Depends(get_session)
) -> list[AssetOut]:
    return edit_service.list_assets(session, kind)


@router.post("/assets", response_model=AssetOut, status_code=201)
async def upload_asset(
    name: str = Form(...),
    kind: str = Form(...),
    file: UploadFile = File(...),
    session: Session = Depends(get_session),
) -> AssetOut:
    try:
        return edit_service.create_asset(
            session, name=name, kind=kind, filename=file.filename or "", payload=await file.read()
        )
    except EditError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@router.delete("/assets/{asset_id}", status_code=204, response_model=None)
def delete_asset(asset_id: str, session: Session = Depends(get_session)) -> None:
    if not edit_service.delete_asset(session, asset_id):
        raise HTTPException(status_code=404, detail="asset not found")


@router.post("/trim", response_model=AssetOut, status_code=201)
def trim(request: TrimRequest, session: Session = Depends(get_session)) -> AssetOut:
    try:
        return edit_service.trim(session, request)
    except EditError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@router.post("/assemble", response_model=AssetOut, status_code=201)
def assemble(
    request: AssembleRequest, session: Session = Depends(get_session)
) -> AssetOut:
    try:
        return edit_service.assemble(session, request)
    except EditError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@router.post("/convert", response_model=AssetOut, status_code=201)
def convert(request: ConvertRequest, session: Session = Depends(get_session)) -> AssetOut:
    try:
        return edit_service.convert(session, request)
    except EditError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@router.post("/reveal", status_code=204, response_model=None)
def reveal(payload: dict) -> None:
    """Open the containing folder in Explorer (PRD §9, step 4)."""
    path = str(payload.get("path", ""))
    if not is_managed(path) or not Path(path).exists():
        raise HTTPException(status_code=400, detail="unknown path")
    # /select, highlights the file itself rather than just opening the folder.
    subprocess.Popen(["explorer", "/select,", str(Path(path).resolve())])


# --------------------------------------------------------------------------
# Timeline projects — the multitrack editor
# --------------------------------------------------------------------------


@router.get("/projects", response_model=list[ProjectSummary])
def list_projects(session: Session = Depends(get_session)) -> list[ProjectSummary]:
    return [ProjectSummary.model_validate(row) for row in edit_service.list_projects(session)]


@router.post("/projects", response_model=ProjectOut, status_code=201)
def create_project(payload: ProjectIn, session: Session = Depends(get_session)) -> ProjectOut:
    return edit_service.create_project(session, payload)


@router.get("/projects/{project_id}", response_model=ProjectOut)
def get_project(project_id: str, session: Session = Depends(get_session)) -> ProjectOut:
    project = edit_service.get_project(session, project_id)
    if project is None:
        raise HTTPException(status_code=404, detail="project not found")
    return project


@router.put("/projects/{project_id}", response_model=ProjectOut)
def update_project(
    project_id: str, payload: ProjectIn, session: Session = Depends(get_session)
) -> ProjectOut:
    """The autosave target — the editor calls this on every debounced change."""
    project = edit_service.update_project(session, project_id, payload)
    if project is None:
        raise HTTPException(status_code=404, detail="project not found")
    return project


@router.delete("/projects/{project_id}", status_code=204, response_model=None)
def delete_project(project_id: str, session: Session = Depends(get_session)) -> None:
    if not edit_service.delete_project(session, project_id):
        raise HTTPException(status_code=404, detail="project not found")


# --------------------------------------------------------------------------
# Waveforms and analysis
# --------------------------------------------------------------------------


@router.get("/peaks")
def get_peaks(
    generation_id: str | None = None,
    asset_id: str | None = None,
    resolution: int = Query(default=100, ge=1, le=400),
    session: Session = Depends(get_session),
) -> Response:
    """Binary min/max waveform peaks for one source — see `utils.audio.peaks`."""
    try:
        data, duration = edit_service.get_peaks(session, generation_id, asset_id, resolution)
    except EditError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    return Response(
        content=data,
        media_type="application/octet-stream",
        headers={"X-Duration": f"{duration:.6f}", "X-Resolution": str(resolution)},
    )


@router.get("/effects", response_model=list[EffectSpecOut])
def list_effects() -> list[EffectSpecOut]:
    """The effects the inspector can offer — filtered to what this machine's
    ffmpeg build actually supports."""
    return [
        EffectSpecOut(
            type=spec.type,
            label=spec.label,
            category=spec.category,
            preview=spec.preview,
            params=[
                {
                    "key": p.key, "label": p.label, "kind": p.kind, "default": p.default,
                    "min": p.min, "max": p.max, "step": p.step, "unit": p.unit,
                    "choices": p.choices,
                }
                for p in spec.params
            ],
        )
        for spec in effects.available_effects()
    ]


@router.post("/analyze/silence", response_model=SilenceReport)
def analyze_silence(
    request: SilenceDetectRequest, session: Session = Depends(get_session)
) -> SilenceReport:
    try:
        return SilenceReport(regions=edit_service.analyze_silence(session, request))
    except EditError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@router.post("/analyze/loudness", response_model=LoudnessReport)
def analyze_loudness(
    request: LoudnessRequest, session: Session = Depends(get_session)
) -> LoudnessReport:
    try:
        return edit_service.analyze_loudness(session, request)
    except EditError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@router.post("/preview")
def render_preview(request: PreviewRequest, session: Session = Depends(get_session)) -> dict:
    """Render one clip's effect chain to a temp file for auditioning."""
    try:
        path = edit_service.render_preview(session, request)
    except EditError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    return {"path": str(path)}


@router.post("/bounce", response_model=AssetOut, status_code=201)
def bounce(request: BounceRequest, session: Session = Depends(get_session)) -> AssetOut:
    """Freeze a clip's effect chain (optionally a sub-range) into a new,
    reusable `clip` asset — the source clip is never modified (FR10)."""
    try:
        return edit_service.bounce(session, request)
    except EditError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


# --------------------------------------------------------------------------
# Rendering a project to one output file
# --------------------------------------------------------------------------


@router.post("/projects/{project_id}/render", response_model=RenderJobOut, status_code=202)
def start_render(
    project_id: str, request: RenderRequest, session: Session = Depends(get_session)
) -> RenderJobOut:
    if edit_service.get_project(session, project_id) is None:
        raise HTTPException(status_code=404, detail="project not found")
    try:
        job = edit_service.start_render(project_id, request.name, request.data)
    except EditError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    return _job_out(job)


@router.get("/render/{job_id}", response_model=RenderJobOut)
def get_render(job_id: str) -> RenderJobOut:
    job = edit_service.get_render_job(job_id)
    if job is None:
        raise HTTPException(status_code=404, detail="render job not found")
    return _job_out(job)


@router.post("/render/{job_id}/cancel", status_code=204, response_model=None)
def cancel_render(job_id: str) -> None:
    if not edit_service.cancel_render(job_id):
        raise HTTPException(status_code=404, detail="render job not running")


def _job_out(job: edit_service.RenderJob) -> RenderJobOut:
    return RenderJobOut(
        id=job.id,
        state=job.state,
        progress=job.progress,
        asset=AssetOut.model_validate(job.asset) if job.asset else None,
        error=job.error,
    )
