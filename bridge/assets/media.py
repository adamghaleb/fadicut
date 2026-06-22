"""Range-media: stream a file off disk to the browser <video>/<audio> with HTTP Range.

Security: the requested path must resolve (realpath) inside one of the configured
media_roots (config.Settings.media_roots). This blocks path-traversal / symlink escapes
off the drive. Supports a single byte range (the common browser case): `Range: bytes=a-b`.
Returns 206 Partial Content with Content-Range, or 200 for the full file, and 416 for an
unsatisfiable range. HEAD is supported so the browser can probe length + range support.
"""

from __future__ import annotations

import mimetypes
import os
import re
from pathlib import Path
from typing import Iterator, Optional

from fastapi import HTTPException, Request, status
from fastapi.responses import Response, StreamingResponse

from bridge.config import get_settings

_CHUNK = 1024 * 1024  # 1 MiB
_RANGE_RE = re.compile(r"bytes=(\d*)-(\d*)", re.IGNORECASE)


def _resolve_in_roots(raw_path: str) -> Path:
    roots = get_settings().media_roots
    try:
        target = Path(raw_path).expanduser().resolve(strict=True)
    except (OSError, RuntimeError):
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="file not found")
    if not target.is_file():
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="not a file")
    for root in roots:
        try:
            target.relative_to(root)
            return target
        except ValueError:
            continue
    raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="path outside allowed media roots")


def _parse_range(header: str, size: int) -> Optional[tuple[int, int]]:
    """Return inclusive (start, end), or None for no/invalid range. Raises 416 if unsatisfiable."""
    m = _RANGE_RE.fullmatch(header.strip())
    if not m:
        return None
    start_s, end_s = m.group(1), m.group(2)
    if start_s == "" and end_s == "":
        return None
    if start_s == "":  # suffix range: last N bytes
        n = int(end_s)
        if n == 0:
            raise HTTPException(status_code=status.HTTP_416_REQUESTED_RANGE_NOT_SATISFIABLE,
                                detail="bad range", headers={"Content-Range": f"bytes */{size}"})
        start = max(0, size - n)
        end = size - 1
    else:
        start = int(start_s)
        end = int(end_s) if end_s else size - 1
        end = min(end, size - 1)
    if start > end or start >= size:
        raise HTTPException(status_code=status.HTTP_416_REQUESTED_RANGE_NOT_SATISFIABLE,
                            detail="range not satisfiable", headers={"Content-Range": f"bytes */{size}"})
    return start, end


def _file_iter(path: Path, start: int, length: int) -> Iterator[bytes]:
    remaining = length
    with open(path, "rb") as f:
        f.seek(start)
        while remaining > 0:
            chunk = f.read(min(_CHUNK, remaining))
            if not chunk:
                break
            remaining -= len(chunk)
            yield chunk


def open_range_response(request: Request, raw_path: str) -> Response:
    path = _resolve_in_roots(raw_path)
    size = path.stat().st_size
    media_type = mimetypes.guess_type(str(path))[0] or "application/octet-stream"

    base_headers = {
        "Accept-Ranges": "bytes",
        "Content-Type": media_type,
        "Cache-Control": "no-cache",
    }

    if request.method == "HEAD":
        return Response(status_code=status.HTTP_200_OK,
                        headers={**base_headers, "Content-Length": str(size)})

    range_header = request.headers.get("range")
    if not range_header:
        return StreamingResponse(
            _file_iter(path, 0, size),
            status_code=status.HTTP_200_OK,
            media_type=media_type,
            headers={**base_headers, "Content-Length": str(size)},
        )

    parsed = _parse_range(range_header, size)
    if parsed is None:
        return StreamingResponse(
            _file_iter(path, 0, size),
            status_code=status.HTTP_200_OK,
            media_type=media_type,
            headers={**base_headers, "Content-Length": str(size)},
        )

    start, end = parsed
    length = end - start + 1
    headers = {
        **base_headers,
        "Content-Range": f"bytes {start}-{end}/{size}",
        "Content-Length": str(length),
    }
    return StreamingResponse(
        _file_iter(path, start, length),
        status_code=status.HTTP_206_PARTIAL_CONTENT,
        media_type=media_type,
        headers=headers,
    )
