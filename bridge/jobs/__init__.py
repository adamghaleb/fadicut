"""Job queue: lanes with concurrency caps + per-job SSE progress.

Public surface (used by api/ and by later batches that register runners):
  • Lane              — "gpu" | "cpu" | "io"
  • JobStatus         — lifecycle enum
  • Job               — a queued/running unit of work
  • ProgressEvent     — what flows over the SSE stream
  • JobQueue          — the singleton-ish manager (get_queue())
  • register_runner   — later batches plug in their engines here

GPU lane concurrency is 1 (RIFE/grade serialize on the M2); CPU/IO are wider.
"""

from .models import Job, JobStatus, Lane, ProgressEvent
from .queue import JobQueue, get_queue, register_runner

__all__ = [
    "Job",
    "JobStatus",
    "Lane",
    "ProgressEvent",
    "JobQueue",
    "get_queue",
    "register_runner",
]
