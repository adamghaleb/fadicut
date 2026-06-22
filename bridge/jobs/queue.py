"""The lane'd async job queue + SSE progress fan-out.

Design
------
- Three lanes, each its own asyncio.Queue + a fixed pool of worker tasks. The GPU lane
  runs concurrency=1 so RIFE/grade never contend for the M2; CPU/IO run wider.
- A *runner* is `async def fn(job, progress) -> dict`. `progress(frac, msg)` publishes an
  SSE frame. Runners are registered by name; later batches add their engines without
  touching this file (open/closed).
- Every job has an asyncio broadcast: each SSE subscriber gets its own bounded queue.
  On subscribe we replay the latest known state so a late listener still sees terminal
  status. The stream closes when the job reaches a terminal state.
- Cancellation: a cooperative flag + task.cancel() of the in-flight runner.

This module is import-safe with no running loop; workers start lazily on first
`get_queue()` use inside the app lifespan (start()/stop()).
"""

from __future__ import annotations

import asyncio
import contextlib
import time
from typing import Awaitable, Callable, Optional

from .models import Job, JobStatus, Lane, ProgressEvent

# A runner: receives the Job and a progress callback, returns a result dict.
ProgressFn = Callable[[float, str], Awaitable[None]]
Runner = Callable[[Job, ProgressFn], Awaitable[dict]]

_LANES: tuple[Lane, ...] = ("gpu", "cpu", "io")


class _Broadcast:
    """Per-job fan-out of ProgressEvents to N subscriber queues, with last-event replay."""

    def __init__(self) -> None:
        self._subs: set[asyncio.Queue[Optional[ProgressEvent]]] = set()
        self._last: Optional[ProgressEvent] = None
        self._closed = False

    def publish(self, evt: ProgressEvent) -> None:
        self._last = evt
        for q in list(self._subs):
            with contextlib.suppress(asyncio.QueueFull):
                q.put_nowait(evt)
        if evt.status in (JobStatus.SUCCEEDED, JobStatus.FAILED, JobStatus.CANCELLED):
            self.close()

    def close(self) -> None:
        if self._closed:
            return
        self._closed = True
        for q in list(self._subs):
            with contextlib.suppress(asyncio.QueueFull):
                q.put_nowait(None)  # sentinel = stream end

    def subscribe(self) -> asyncio.Queue[Optional[ProgressEvent]]:
        q: asyncio.Queue[Optional[ProgressEvent]] = asyncio.Queue(maxsize=256)
        self._subs.add(q)
        if self._last is not None:
            q.put_nowait(self._last)
        if self._closed:
            q.put_nowait(None)
        return q

    def unsubscribe(self, q: asyncio.Queue) -> None:
        self._subs.discard(q)


class JobQueue:
    def __init__(self, gpu: int = 1, cpu: int = 4, io: int = 8) -> None:
        self._concurrency: dict[Lane, int] = {"gpu": gpu, "cpu": cpu, "io": io}
        self._queues: dict[Lane, asyncio.Queue[str]] = {}
        self._workers: list[asyncio.Task] = []
        self._jobs: dict[str, Job] = {}
        self._tasks: dict[str, asyncio.Task] = {}        # in-flight runner tasks
        self._cancelled: set[str] = set()
        self._broadcasts: dict[str, _Broadcast] = {}
        self._runners: dict[str, Runner] = {}
        self._started = False

    # ── runner registry ──────────────────────────────────────────────────────
    def register_runner(self, kind: str, runner: Runner) -> None:
        if kind in self._runners:
            raise ValueError(f"runner already registered: {kind}")
        self._runners[kind] = runner

    def known_kinds(self) -> list[str]:
        return sorted(self._runners)

    # ── lifecycle ──────────────────────────────────────────────────────────────
    async def start(self) -> None:
        if self._started:
            return
        for lane in _LANES:
            self._queues[lane] = asyncio.Queue()
            for i in range(self._concurrency[lane]):
                self._workers.append(asyncio.create_task(self._worker(lane, i)))
        self._started = True

    async def stop(self) -> None:
        for t in self._tasks.values():
            t.cancel()
        for w in self._workers:
            w.cancel()
        await asyncio.gather(*self._workers, *self._tasks.values(), return_exceptions=True)
        self._workers.clear()
        self._tasks.clear()
        self._started = False

    # ── submit / query / cancel ────────────────────────────────────────────────
    def submit(self, *, kind: str, lane: Lane, payload: dict, name: str = "") -> Job:
        if kind not in self._runners:
            raise KeyError(f"unknown job kind: {kind!r} (known: {self.known_kinds()})")
        job = Job(kind=kind, lane=lane, payload=payload, name=name)
        self._jobs[job.id] = job
        self._broadcasts[job.id] = _Broadcast()
        self._queues[lane].put_nowait(job.id)
        self._emit(job)  # initial QUEUED frame
        return job

    def get(self, job_id: str) -> Optional[Job]:
        return self._jobs.get(job_id)

    def list(self) -> list[Job]:
        return sorted(self._jobs.values(), key=lambda j: j.created_at, reverse=True)

    def cancel(self, job_id: str) -> bool:
        job = self._jobs.get(job_id)
        if not job or job.status in (JobStatus.SUCCEEDED, JobStatus.FAILED, JobStatus.CANCELLED):
            return False
        self._cancelled.add(job_id)
        t = self._tasks.get(job_id)
        if t:
            t.cancel()  # interrupt a running runner
        else:
            # still queued — mark cancelled now; worker will skip it
            job.status = JobStatus.CANCELLED
            job.finished_at = time.time()
            self._emit(job)
        return True

    # ── SSE subscription ─────────────────────────────────────────────────────
    def subscribe(self, job_id: str) -> Optional[asyncio.Queue]:
        bc = self._broadcasts.get(job_id)
        return bc.subscribe() if bc else None

    def unsubscribe(self, job_id: str, q: asyncio.Queue) -> None:
        bc = self._broadcasts.get(job_id)
        if bc:
            bc.unsubscribe(q)

    # ── internals ──────────────────────────────────────────────────────────────
    def _emit(self, job: Job) -> None:
        bc = self._broadcasts.get(job.id)
        if not bc:
            return
        bc.publish(ProgressEvent(
            job_id=job.id, status=job.status, progress=job.progress,
            message=job.message, result=job.result, error=job.error,
        ))

    async def _worker(self, lane: Lane, idx: int) -> None:
        q = self._queues[lane]
        while True:
            job_id = await q.get()
            try:
                await self._run_one(job_id)
            finally:
                q.task_done()

    async def _run_one(self, job_id: str) -> None:
        job = self._jobs.get(job_id)
        if job is None:
            return
        if job_id in self._cancelled or job.status == JobStatus.CANCELLED:
            if job.status != JobStatus.CANCELLED:
                job.status = JobStatus.CANCELLED
                job.finished_at = time.time()
                self._emit(job)
            return

        runner = self._runners.get(job.kind)
        if runner is None:
            job.status = JobStatus.FAILED
            job.error = f"no runner for kind {job.kind!r}"
            job.finished_at = time.time()
            self._emit(job)
            return

        async def progress(frac: float, msg: str = "") -> None:
            job.progress = max(0.0, min(1.0, float(frac)))
            if msg:
                job.message = msg
            self._emit(job)

        job.status = JobStatus.RUNNING
        job.started_at = time.time()
        self._emit(job)

        task = asyncio.create_task(runner(job, progress))
        self._tasks[job_id] = task
        try:
            result = await task
            job.result = result if isinstance(result, dict) else {"value": result}
            job.progress = 1.0
            job.status = JobStatus.SUCCEEDED
        except asyncio.CancelledError:
            job.status = JobStatus.CANCELLED
            job.error = "cancelled"
        except Exception as exc:  # noqa: BLE001 — surface any runner failure to the client
            job.status = JobStatus.FAILED
            job.error = f"{type(exc).__name__}: {exc}"
        finally:
            job.finished_at = time.time()
            self._tasks.pop(job_id, None)
            self._cancelled.discard(job_id)
            self._emit(job)


# ── module-level singleton wiring ──────────────────────────────────────────────
_QUEUE: Optional[JobQueue] = None


def get_queue() -> JobQueue:
    """Return the process-wide queue, constructing it (not starting workers) on first use.

    Workers are started in the FastAPI lifespan via `await get_queue().start()`.
    """
    global _QUEUE
    if _QUEUE is None:
        from bridge.config import get_settings

        s = get_settings()
        _QUEUE = JobQueue(gpu=s.gpu_concurrency, cpu=s.cpu_concurrency, io=s.io_concurrency)
        _register_builtin_runners(_QUEUE)
    return _QUEUE


def register_runner(kind: str, runner: Runner) -> None:
    """Convenience for later batches: register an engine runner on the shared queue."""
    get_queue().register_runner(kind, runner)


def _register_builtin_runners(q: JobQueue) -> None:
    from .demo import demo_noop_runner

    q.register_runner("demo_noop", demo_noop_runner)
