"""/health — unauthenticated liveness + capability probe.

Reports version, the contract schema versions it was built against, the lane concurrency,
and the registered job kinds so the editor can feature-detect.
"""

from __future__ import annotations

from fastapi import APIRouter

from bridge import __version__ as bridge_version
from bridge.config import get_settings
from jobs import get_queue

router = APIRouter(tags=["health"])


@router.get("/health")
async def health() -> dict:
    s = get_settings()
    q = get_queue()

    contract = {}
    try:
        from fadi_contracts.fadi_edl import SCHEMA_VERSION as EDL_V
        from fadi_contracts.song_context import SCHEMA_VERSION as SONG_V

        contract = {"song_context": SONG_V, "fadi_edl": EDL_V}
    except Exception:  # noqa: BLE001 — contracts optional at import edge
        contract = {"error": "fadi_contracts not importable"}

    return {
        "status": "ok",
        "service": "fadi-bridge",
        "version": bridge_version,
        "contracts": contract,
        "lanes": {
            "gpu": s.gpu_concurrency,
            "cpu": s.cpu_concurrency,
            "io": s.io_concurrency,
        },
        "job_kinds": q.known_kinds(),
        "media_roots": [str(p) for p in s.media_roots],
        "cors_origins": s.cors_origins,
    }
