"""Job + progress data models."""

from __future__ import annotations

import time
import uuid
from enum import Enum
from typing import Any, Literal, Optional

from pydantic import BaseModel, Field

Lane = Literal["gpu", "cpu", "io"]


class JobStatus(str, Enum):
    QUEUED = "queued"
    RUNNING = "running"
    SUCCEEDED = "succeeded"
    FAILED = "failed"
    CANCELLED = "cancelled"


def _new_id() -> str:
    return f"job_{uuid.uuid4().hex[:16]}"


class JobSpec(BaseModel):
    """What a client POSTs to enqueue work."""

    kind: str = Field(..., description="Registered runner name, e.g. 'demo_noop'.")
    lane: Lane = "cpu"
    payload: dict[str, Any] = Field(default_factory=dict)
    name: str = ""


class Job(BaseModel):
    id: str = Field(default_factory=_new_id)
    kind: str
    lane: Lane = "cpu"
    name: str = ""
    payload: dict[str, Any] = Field(default_factory=dict)

    status: JobStatus = JobStatus.QUEUED
    progress: float = Field(0.0, ge=0.0, le=1.0)
    message: str = ""
    result: Optional[dict[str, Any]] = None
    error: Optional[str] = None

    created_at: float = Field(default_factory=time.time)
    started_at: Optional[float] = None
    finished_at: Optional[float] = None

    def public(self) -> dict[str, Any]:
        return self.model_dump(mode="json")


class ProgressEvent(BaseModel):
    """A single SSE frame for a job."""

    job_id: str
    status: JobStatus
    progress: float = 0.0
    message: str = ""
    result: Optional[dict[str, Any]] = None
    error: Optional[str] = None
    ts: float = Field(default_factory=time.time)
