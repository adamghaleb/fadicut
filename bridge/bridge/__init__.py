"""Fadi Bridge — local FastAPI service.

Owns files, the M2 GPU, and the native Fadi tools. The OpenCut editor talks to it over
localhost (REST + SSE progress + range-media); it never runs in the browser.

Batch A (this package): the core — config, auth, CORS, the lane'd job queue, SSE progress,
range-media, /health, and a no-op demo job that proves the queue+SSE path. Later batches
(C..G) add asset indexing and the render orchestrator by registering their own job runners
on the shared queue (see jobs.queue.JobQueue.register_runner) without editing this core.
"""

__version__ = "0.1.0"
