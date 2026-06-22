"""Fadi Bridge FastAPI application factory + lifespan.

Wires: CORS (locked to OpenCut origin) → routers (health, jobs, media) → the lane'd
job queue (started/stopped in the lifespan). Binds localhost only when launched via
`python -m bridge` / the run script.
"""

from __future__ import annotations

import logging
from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from api import (
    health_router,
    jobs_router,
    media_router,
    projects_router,
    render_router,
    staging_router,
)
from assets import assets_router, get_watcher
from bridge import __version__
from bridge.config import get_settings
from jobs import get_queue
from render import (
    blob_track,
    meandu,
    micrographics,
    orchestrator,
    register_batch_d_runners,
    register_effect_runners,
)
from render.beatgrid import beatgrid_router, register_beatgrid_runners

log = logging.getLogger("fadi.bridge")


def _register_runners(q) -> None:
    """Plug every batch's engine runners onto the shared queue. Idempotent — a
    double registration (e.g. on reload) is logged and skipped, never fatal."""
    registrations = [
        ("lyric (meandu)", lambda: meandu.register(q)),
        ("beat detection", register_beatgrid_runners),
        ("grade + speed-ramp", register_batch_d_runners),
        ("export orchestrator", lambda: orchestrator.register(q)),
        ("all effect runners", lambda: register_effect_runners()),
        ("micrographics", micrographics.register_handler),
        ("blob-track", lambda: blob_track.register(q)),
    ]
    for name, fn in registrations:
        try:
            fn()
            log.info("registered runners: %s", name)
        except ValueError as e:
            log.info("runners already registered (%s): %s", name, e)


@asynccontextmanager
async def lifespan(app: FastAPI):
    s = get_settings()
    q = get_queue()
    await q.start()
    _register_runners(q)
    watcher = get_watcher()
    try:
        watcher.start()
        log.info("asset watcher started")
    except Exception as e:  # watcher is best-effort (drive may be offline)
        log.warning("asset watcher not started: %s", e)
    log.info(
        "Fadi Bridge %s up on http://%s:%d — token=%s — lanes gpu=%d cpu=%d io=%d",
        __version__, s.host, s.port, s.token, s.gpu_concurrency, s.cpu_concurrency, s.io_concurrency,
    )
    log.info("CORS origins: %s", s.cors_origins)
    log.info("Media roots: %s", [str(p) for p in s.media_roots])
    try:
        yield
    finally:
        try:
            watcher.stop()
        except Exception:
            pass
        await q.stop()
        log.info("Fadi Bridge stopped.")


def create_app() -> FastAPI:
    s = get_settings()
    app = FastAPI(
        title="Fadi Bridge",
        version=__version__,
        description=(
            "Local FastAPI service for Fadicut. Owns files, the M2 GPU, and the native "
            "Fadi tools. REST + SSE progress + range-media. Localhost only, bearer-token "
            "auth, CORS locked to the OpenCut dev origin."
        ),
        lifespan=lifespan,
    )

    app.add_middleware(
        CORSMiddleware,
        allow_origins=s.cors_origins,
        allow_credentials=True,
        allow_methods=["GET", "POST", "HEAD", "OPTIONS"],
        allow_headers=["Authorization", "Content-Type", "X-Fadi-Token", "Range"],
        expose_headers=["Content-Range", "Accept-Ranges", "Content-Length"],
    )

    app.include_router(health_router)
    app.include_router(jobs_router)
    app.include_router(media_router)
    app.include_router(projects_router)  # batch G — drive-backed projects
    app.include_router(assets_router)    # batch E — asset library
    app.include_router(beatgrid_router)  # batch C — beat detection
    app.include_router(render_router)    # issue #4 — export-bake orchestration
    app.include_router(staging_router)   # issue #11 — blob-asset disk staging
    return app


# Importable ASGI app for `uvicorn bridge.app:app`
app = create_app()
