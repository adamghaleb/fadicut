"""Blob-asset disk-staging endpoint (issue #11). Authenticated.

    POST /assets/stage   → write an uploaded browser Blob/File (which has no disk path)
                           into the Bridge's content-hash-keyed staging cache, and return
                           the absolute on-disk path. Idempotent: re-staging identical
                           bytes reuses the existing file.

    GET  /assets/stage/{hash}
                         → probe whether a hash is already staged (lets the editor skip
                           the upload when the file is already on disk). 200 with the
                           path, or 404.

The editor calls this for any `MediaAsset` whose source is an in-memory Blob with no disk
path, BEFORE referencing it in a FadiEDL (the native bakers + the render orchestrator all
operate on files on disk). See `apps/web/src/fadi/staging/stage-blob.ts` for the client.

Two body shapes are accepted:
  * multipart/form-data with a `file` part + a `content_hash` form field (+ optional
    `filename` / `content_type`). This is what the browser FormData upload sends.
  * raw bytes (any other content type) with the hash + metadata in the query string
    (`?content_hash=...&filename=...&content_type=...`). Convenience for non-browser
    callers / curl.

WIRING (kept out of shared files per scope discipline — the integrator adds one line in
create_app(), next to the other include_router calls):

    from api.staging import router as staging_router   # exported by api/__init__.py
    app.include_router(staging_router)

No queue runner is needed — staging is a synchronous disk write, not a render job.
"""

from __future__ import annotations

import asyncio
from typing import Optional

from fastapi import (
    APIRouter,
    Depends,
    File,
    Form,
    HTTPException,
    Query,
    Request,
    UploadFile,
    status,
)

from assets.staging import StagedAsset, StagingError, find_staged, stage_bytes
from bridge.auth import require_token

router = APIRouter(prefix="/assets", tags=["staging"])

# Reject absurd uploads outright (the staging cache is for editor blobs, not multi-GB
# masters — those already live on disk and get referenced by path, never staged).
_MAX_BYTES = 512 * 1024 * 1024  # 512 MiB


def _result(staged: StagedAsset) -> dict:
    return {
        "path": str(staged.path),
        "content_hash": staged.content_hash,
        "size": staged.size,
        "reused": staged.reused,
    }


@router.post("/stage", dependencies=[Depends(require_token)])
async def stage_asset(
    request: Request,
    file: Optional[UploadFile] = File(default=None),
    content_hash: Optional[str] = Form(default=None),
    filename: Optional[str] = Form(default=None),
    content_type: Optional[str] = Form(default=None),
    # Raw-body fallbacks (query string) — used when the request is not multipart.
    content_hash_q: Optional[str] = Query(default=None, alias="content_hash"),
    filename_q: Optional[str] = Query(default=None, alias="filename"),
    content_type_q: Optional[str] = Query(default=None, alias="content_type"),
) -> dict:
    """Stage an uploaded blob to disk under its content hash; return the absolute path."""
    is_multipart = file is not None

    if is_multipart:
        data = await file.read()
        chash = content_hash or content_hash_q
        fname = filename or filename_q or file.filename
        ctype = content_type or content_type_q or file.content_type
    else:
        data = await request.body()
        chash = content_hash_q or content_hash
        fname = filename_q
        ctype = content_type_q or request.headers.get("content-type")

    if not data:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST, detail="empty upload body"
        )
    if len(data) > _MAX_BYTES:
        raise HTTPException(
            status_code=status.HTTP_413_REQUEST_ENTITY_TOO_LARGE,
            detail=f"upload exceeds staging limit ({_MAX_BYTES} bytes)",
        )
    if not chash:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="missing content_hash (form field or query param)",
        )

    try:
        # Disk write + sha256 verify are blocking — offload off the event loop.
        staged = await asyncio.to_thread(
            stage_bytes, data, chash, content_type=ctype, filename=fname
        )
    except StagingError as e:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail=str(e)
        )

    return _result(staged)


@router.get("/stage/{content_hash}", dependencies=[Depends(require_token)])
async def probe_staged(content_hash: str) -> dict:
    """Return the staged path for a hash if present, else 404 — no bytes transferred."""
    try:
        existing = await asyncio.to_thread(find_staged, content_hash)
    except StagingError as e:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST, detail=str(e)
        )
    if existing is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail="not staged"
        )
    return {
        "path": str(existing.resolve()),
        "content_hash": content_hash.strip().lower(),
        "size": existing.stat().st_size,
        "reused": True,
    }
