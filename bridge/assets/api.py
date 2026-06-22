"""Asset catalog REST API (batch E).

Exposes search / filter / tag / proxy / reindex over the SQLite catalog. All routes
are authenticated with the same bearer token as the rest of the Bridge. The router is
**self-contained** and not yet mounted — the integrator wires it in ``api/__init__.py``
+ ``bridge/app.py`` (and starts ``get_watcher()`` in the lifespan). Documented export:

    from assets.api import assets_router          # APIRouter, prefix="/assets"
    from assets.watcher import get_watcher          # start()/stop() in lifespan

Endpoints (all under ``/assets``):
  GET  /assets                 search + filter (q, kind, kind_hint, tag, has_alpha, …)
  GET  /assets/tags            distinct tags + counts
  GET  /assets/roots           per-root status (online flag + indexed count)
  GET  /assets/item            single asset by ?path=
  POST /assets/reindex         trigger an incremental (or ?force=true full) sweep
  POST /assets/{op}/tags       set | add | remove tags on an asset (op in path)
  POST /assets/proxy           build/ensure a proxy for ?path=, returns its stream URL
  GET  /assets/proxy           stream a proxy file (range) — token via ?token= for <video>

Proxy + media streaming reuse the batch-A range streamer. The proxy file lives under
``bridge/data/proxies`` which the editor reaches via this endpoint (no media-root
config needed for proxies — they're always Bridge-owned).
"""

from __future__ import annotations

from typing import Literal

from fastapi import APIRouter, Body, Depends, HTTPException, Query, Request, status
from fastapi.responses import Response
from pydantic import BaseModel, Field

from assets.catalog import get_catalog
from assets.media import _file_iter  # reuse the range streamer internals
from assets.proxy import ensure_proxy, proxy_dir
from assets.roots import get_roots
from assets.watcher import get_watcher
from bridge.auth import require_token

router = APIRouter(prefix="/assets", tags=["assets"])


# ── models ─────────────────────────────────────────────────────────────────--
class TagBody(BaseModel):
    path: str = Field(..., description="Absolute path of the catalog asset.")
    tags: list[str] = Field(default_factory=list)


class SearchResponse(BaseModel):
    items: list[dict]
    total: int
    limit: int
    offset: int


# ── search / read ────────────────────────────────────────────────────────────
@router.get("", dependencies=[Depends(require_token)], response_model=SearchResponse)
async def search_assets(
    q: str | None = Query(None, description="Substring match on name + path."),
    kind: str | None = Query(None, description="video | image | audio | unknown"),
    kind_hint: str | None = Query(None, description="root kind: loop|overlay|clip|footage|mixed"),
    tag: list[str] | None = Query(None, description="Repeatable; AND semantics."),
    has_alpha: bool | None = Query(None, description="Filter to alpha (ProRes 4444/PNG) assets."),
    root_label: str | None = Query(None),
    include_missing: bool = Query(False, description="Include offline-drive (missing) rows."),
    sort: str = Query("name"),
    order: Literal["asc", "desc"] = Query("asc"),
    limit: int = Query(120, ge=1, le=1000),
    offset: int = Query(0, ge=0),
) -> SearchResponse:
    items, total = get_catalog().search(
        q=q, kind=kind, kind_hint=kind_hint, tags=tag, has_alpha=has_alpha,
        root_label=root_label, include_missing=include_missing,
        sort=sort, order=order, limit=limit, offset=offset,
    )
    return SearchResponse(items=items, total=total, limit=limit, offset=offset)


@router.get("/tags", dependencies=[Depends(require_token)])
async def list_tags() -> dict:
    return {"tags": get_catalog().all_tags()}


@router.get("/roots", dependencies=[Depends(require_token)])
async def list_roots() -> dict:
    """Per-root status so the editor can show which roots are offline (drive unplugged)."""
    cat = get_catalog()
    w = get_watcher()
    return {
        "roots": cat.root_status(),
        "watcher_backend": w.backend,
        "total_indexed": cat.count(),
    }


@router.get("/item", dependencies=[Depends(require_token)])
async def get_item(path: str = Query(...)) -> dict:
    item = get_catalog().get(path)
    if not item:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="not in catalog")
    return item


# ── mutate ────────────────────────────────────────────────────────────────--
@router.post("/reindex", dependencies=[Depends(require_token)])
async def reindex(force: bool = Query(False, description="Re-probe + re-hash every file.")) -> dict:
    stats = get_catalog().index_roots(force=force)
    return {"ok": True, "stats": stats.public()}


@router.post("/{op}/tags", dependencies=[Depends(require_token)])
async def mutate_tags(op: Literal["set", "add", "remove"], body: TagBody = Body(...)) -> dict:
    cat = get_catalog()
    if op == "set":
        item = cat.set_tags(body.path, body.tags)
    elif op == "add":
        item = cat.add_tags(body.path, body.tags)
    else:
        item = cat.remove_tags(body.path, body.tags)
    if item is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="not in catalog")
    return item


# ── proxies ──────────────────────────────────────────────────────────────--
@router.post("/proxy", dependencies=[Depends(require_token)])
async def build_proxy(path: str = Query(...)) -> dict:
    cat = get_catalog()
    item = cat.get(path)
    if not item:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="not in catalog")
    proxy = ensure_proxy(item["path"], item["content_hash"], item["kind"])
    if not proxy:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="proxy build failed (file offline or ffmpeg unavailable)",
        )
    cat.set_proxy(path, proxy)
    return {"ok": True, "content_hash": item["content_hash"], "kind": item["kind"]}


@router.get("/proxy", dependencies=[Depends(require_token)])
@router.head("/proxy", dependencies=[Depends(require_token)])
async def stream_proxy(
    request: Request,
    hash: str = Query(..., description="content_hash of the asset."),
    kind: str = Query(..., description="video | image | audio"),
):
    """Stream a Bridge-owned proxy file with HTTP Range. Token via ?token= for <video>.

    Proxies live in the Bridge data dir (not a configured media root), so this serves
    them directly rather than through the media-root path guard.
    """
    ext = {"video": "mp4", "image": "webp", "audio": "png"}.get(kind)
    if not ext:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="bad kind")
    # Guard the hash to a filename to keep this inside the proxy dir (no traversal).
    safe = "".join(c for c in hash if c.isalnum())
    target = proxy_dir() / f"{safe}.{ext}"
    if not target.is_file():
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="proxy not built")

    size = target.stat().st_size
    media_type = {"video": "video/mp4", "image": "image/webp", "audio": "image/png"}[kind]
    base = {"Accept-Ranges": "bytes", "Content-Type": media_type, "Cache-Control": "max-age=3600"}

    if request.method == "HEAD":
        return Response(status_code=200, headers={**base, "Content-Length": str(size)})

    range_header = request.headers.get("range")
    if not range_header:
        from fastapi.responses import StreamingResponse
        return StreamingResponse(
            _file_iter(target, 0, size), status_code=200, media_type=media_type,
            headers={**base, "Content-Length": str(size)},
        )

    # Single-range parse (mirror media.py semantics for the common browser case).
    import re
    m = re.fullmatch(r"bytes=(\d*)-(\d*)", range_header.strip(), re.IGNORECASE)
    if not m or (m.group(1) == "" and m.group(2) == ""):
        from fastapi.responses import StreamingResponse
        return StreamingResponse(
            _file_iter(target, 0, size), status_code=200, media_type=media_type,
            headers={**base, "Content-Length": str(size)},
        )
    start_s, end_s = m.group(1), m.group(2)
    if start_s == "":
        start = max(0, size - int(end_s))
        end = size - 1
    else:
        start = int(start_s)
        end = int(end_s) if end_s else size - 1
        end = min(end, size - 1)
    if start > end or start >= size:
        raise HTTPException(
            status_code=status.HTTP_416_REQUESTED_RANGE_NOT_SATISFIABLE,
            detail="range not satisfiable", headers={"Content-Range": f"bytes */{size}"},
        )
    length = end - start + 1
    from fastapi.responses import StreamingResponse
    return StreamingResponse(
        _file_iter(target, start, length), status_code=206, media_type=media_type,
        headers={**base, "Content-Range": f"bytes {start}-{end}/{size}", "Content-Length": str(length)},
    )


# Documented export for the integrator.
assets_router = router
