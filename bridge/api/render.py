"""Export-bake orchestration endpoint (issue #4). Authenticated.

    POST /render   → enqueue a `render_project` job that composites a FadiEDL into one
                     final mp4 (base video/image + per-clip grade + lyric overlay + song
                     audio), baking the native Fadi effects. Returns the created Job; the
                     client follows /jobs/{id}/events (SSE) for progress, and reads the
                     output mp4 path from the terminal frame's result.

The job runs on the **cpu** lane (PIL/HarfBuzz lyric compositing + ffmpeg concat/overlay,
not the GPU lane). The orchestrator itself fans out to the GPU-lane bakers only where the
existing runners already do (grade frame-walks are invoked synchronously inside the bake).

WIRING (kept out of shared files per scope discipline — the integrator adds two lines):
    from api.render import router as render_router   # exported by api/__init__.py
    app.include_router(render_router)                 # in create_app()
and registers the runner in the lifespan:
    from render import orchestrator
    orchestrator.register(get_queue())
"""

from __future__ import annotations

from typing import Any, Optional

from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel, Field

from bridge.auth import require_token
from jobs import get_queue

router = APIRouter(prefix="/render", tags=["render"])


class RenderRequest(BaseModel):
    """A render request: the FadiEDL to composite + optional output controls."""

    edl: dict[str, Any] = Field(..., description="A FadiEDL object (the frozen contract shape).")
    out_path: Optional[str] = Field(None, description="Absolute output mp4 path; Bridge picks a temp path if omitted.")
    smoke_frames: Optional[int] = Field(None, description="Lyric engine: render only the first N frames (fast preview bakes).")
    name: str = Field("", description="Human-readable job name for the queue UI.")


@router.post("", dependencies=[Depends(require_token)], status_code=status.HTTP_201_CREATED)
async def submit_render(req: RenderRequest) -> dict:
    """Enqueue a `render_project` orchestration job on the cpu lane."""
    q = get_queue()
    payload: dict[str, Any] = {"edl": req.edl}
    if req.out_path:
        payload["out_path"] = req.out_path
    if req.smoke_frames is not None:
        payload["smoke_frames"] = req.smoke_frames
    name = req.name or f"render:{req.edl.get('name', req.edl.get('project_id', 'project'))}"
    try:
        job = q.submit(kind="render_project", lane="cpu", payload=payload, name=name)
    except KeyError as e:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(e))
    return job.public()
