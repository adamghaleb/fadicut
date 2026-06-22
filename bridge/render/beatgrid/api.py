"""HTTP router for beat detection (Batch C).

A self-contained FastAPI `APIRouter` the integrator mounts with
`app.include_router(beatgrid_router)` — this module does NOT edit app.py or any shared
router aggregator.

Two ways to run detection:
  • POST /beatgrid/detect        — synchronous; returns tempo (+ optional sections /
                                   filled song_context) in the response. Good for a
                                   single song the editor needs right now.
  • POST /beatgrid/detect/async  — enqueues the `detect_beats` job and returns the job
                                   handle; progress streams over the existing
                                   GET /jobs/{id}/events SSE endpoint. Good for batch /
                                   long files.

Auth mirrors the rest of the bridge: bearer-token via the shared `require_token`
dependency. Synchronous detection runs the numpy worker off the event loop.
"""

from __future__ import annotations

import asyncio
from typing import Any, Optional

from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel, Field

from bridge.auth import require_token
from fadi_contracts.song_context import SongContext, Tempo

from .detector import (
    BEATS_SOURCE,
    _bpm_confidence,
    derive_sections_from_downbeats,
    detect_raw,
)

router = APIRouter(prefix="/beatgrid", tags=["beatgrid"])


class DetectRequest(BaseModel):
    audio_path: Optional[str] = Field(
        None, description="Absolute path to audio. Required unless song_context.audio.master_path is set."
    )
    song_context: Optional[dict[str, Any]] = Field(
        None, description="Serialized SongContext to fill (tempo + optional sections)."
    )
    python_exe: Optional[str] = Field(None, description="Override the numpy interpreter for analyze_beats.")
    derive_sections: bool = Field(False, description="Also return placeholder sections derived from downbeats.")
    bars_per_section: int = Field(8, ge=1, le=64)


class DetectResponse(BaseModel):
    tempo: dict[str, Any]
    sections: Optional[list[dict[str, Any]]] = None
    song_context: Optional[dict[str, Any]] = None


def _resolve_audio(req: DetectRequest, ctx: Optional[SongContext]) -> str:
    if req.audio_path:
        return req.audio_path
    if ctx is not None:
        return ctx.audio.master_path
    raise HTTPException(
        status_code=status.HTTP_400_BAD_REQUEST,
        detail="need audio_path or song_context.audio.master_path",
    )


@router.post("/detect", dependencies=[Depends(require_token)])
async def detect(req: DetectRequest) -> DetectResponse:
    ctx: Optional[SongContext] = None
    if req.song_context:
        try:
            ctx = SongContext.model_validate(req.song_context)
        except Exception as exc:  # noqa: BLE001
            raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
                                detail=f"invalid song_context: {exc}")

    audio_path = _resolve_audio(req, ctx)

    try:
        raw = await asyncio.to_thread(detect_raw, audio_path, python_exe=req.python_exe)
    except FileNotFoundError:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=f"audio not found: {audio_path}")
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=status.HTTP_500_INTERNAL_SERVER_ERROR, detail=str(exc))

    tempo = Tempo(
        bpm=raw.bpm,
        bpm_confidence=_bpm_confidence(raw),
        beat_grid=raw.beats,
        downbeats=raw.downbeats,
    )

    sections = None
    if req.derive_sections:
        sections = derive_sections_from_downbeats(
            raw.downbeats, raw.duration, bars_per_section=req.bars_per_section
        )

    out_ctx = None
    if ctx is not None:
        tempo.time_signature = ctx.tempo.time_signature
        ctx.tempo = tempo
        if ctx.source:
            ctx.source.beats_source = BEATS_SOURCE
        if sections and not ctx.sections:
            ctx.sections = sections
        out_ctx = ctx.model_dump(mode="json")

    return DetectResponse(
        tempo=tempo.model_dump(mode="json"),
        sections=[s.model_dump(mode="json") for s in sections] if sections else None,
        song_context=out_ctx,
    )


@router.post("/detect/async", dependencies=[Depends(require_token)], status_code=status.HTTP_201_CREATED)
async def detect_async(req: DetectRequest) -> dict:
    """Enqueue detection as a job; stream progress over GET /jobs/{id}/events."""
    from jobs import get_queue

    from .runner import RUNNER_KIND, RUNNER_LANE, register_beatgrid_runners

    q = get_queue()
    register_beatgrid_runners(q.register_runner)  # ensure the runner exists (idempotent)
    job = q.submit(
        kind=RUNNER_KIND,
        lane=RUNNER_LANE,
        payload=req.model_dump(),
        name="detect_beats",
    )
    return job.public()
