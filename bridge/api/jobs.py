"""Job submit / query / cancel + SSE progress stream. All authenticated."""

from __future__ import annotations

import asyncio
import json

from fastapi import APIRouter, Depends, HTTPException, Request, status
from sse_starlette.sse import EventSourceResponse

from bridge.auth import require_token
from jobs import get_queue
from jobs.models import Job, JobSpec

router = APIRouter(prefix="/jobs", tags=["jobs"])


@router.post("", dependencies=[Depends(require_token)], status_code=status.HTTP_201_CREATED)
async def submit_job(spec: JobSpec) -> dict:
    q = get_queue()
    try:
        job = q.submit(kind=spec.kind, lane=spec.lane, payload=spec.payload, name=spec.name)
    except KeyError as e:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(e))
    return job.public()


@router.get("", dependencies=[Depends(require_token)])
async def list_jobs() -> list[dict]:
    return [j.public() for j in get_queue().list()]


@router.get("/{job_id}", dependencies=[Depends(require_token)])
async def get_job(job_id: str) -> dict:
    job = get_queue().get(job_id)
    if not job:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="no such job")
    return job.public()


@router.post("/{job_id}/cancel", dependencies=[Depends(require_token)])
async def cancel_job(job_id: str) -> dict:
    ok = get_queue().cancel(job_id)
    if not ok:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT,
                            detail="job not cancellable (missing or already terminal)")
    return {"cancelled": job_id}


@router.get("/{job_id}/events", dependencies=[Depends(require_token)])
async def job_events(job_id: str, request: Request) -> EventSourceResponse:
    """SSE stream of ProgressEvents for one job. Closes when the job is terminal.

    EventSource can't set Authorization, so the token may be passed as ?token=... —
    handled by the require_token dependency.
    """
    q = get_queue()
    if not q.get(job_id):
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="no such job")

    sub = q.subscribe(job_id)
    if sub is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="no such job")

    async def gen():
        try:
            while True:
                if await request.is_disconnected():
                    break
                try:
                    evt = await asyncio.wait_for(sub.get(), timeout=15.0)
                except asyncio.TimeoutError:
                    # keep-alive comment frame
                    yield {"event": "ping", "data": "{}"}
                    continue
                if evt is None:  # stream-end sentinel
                    break
                yield {"event": "progress", "data": json.dumps(evt.model_dump(mode="json"))}
        finally:
            q.unsubscribe(job_id, sub)

    return EventSourceResponse(gen())
