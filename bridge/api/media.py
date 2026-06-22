"""Range-media endpoint. Authenticated; streams a disk file with HTTP Range support.

The browser <video>/<audio> can't set an Authorization header on the media request,
so the token is accepted via ?token=... (the require_token dependency handles it).
The file path is given as ?path=<absolute path> and must resolve inside an allowed
media root (enforced in assets.media).
"""

from __future__ import annotations

from fastapi import APIRouter, Depends, Query, Request

from assets.media import open_range_response
from bridge.auth import require_token

router = APIRouter(prefix="/media", tags=["media"])


@router.get("", dependencies=[Depends(require_token)])
@router.head("", dependencies=[Depends(require_token)])
async def range_media(
    request: Request,
    path: str = Query(..., description="Absolute path of the media file to stream."),
):
    return open_range_response(request, path)
