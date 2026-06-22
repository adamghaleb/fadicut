"""Blob-asset disk staging (issue #11).

The OpenCut editor can hold a media asset purely in the browser — a `Blob`/`File`
with no disk path (e.g. a freshly recorded take, a generated clip, or an asset
imported from memory). The native Fadi bakers and the render orchestrator all work
on **files on disk**, so before such an asset can be referenced in a FadiEDL it has
to be materialised somewhere the Bridge is allowed to read.

This module owns that disk cache. It is keyed by a caller-supplied content hash so
that re-uploading identical bytes is a cheap no-op (the file is reused, not rewritten),
and so the editor can stage the same asset across sessions without duplicating it.

Layout (under the Bridge data dir, which is inside the default home media root, so the
range-media server + orchestrator can read what lands here):

    bridge/data/blob-staging/<hash><ext>

Security / integrity:
  * The hash is treated as an opaque key but MUST be a plausible hex digest (we reject
    anything with path separators or non-hex chars — it becomes a filename).
  * The bytes are written to a temp file in the SAME directory, then atomically renamed
    into place, so a concurrent reader never sees a half-written file.
  * We verify the SHA-256 of the received bytes matches the supplied hash when the hash
    is a 64-char SHA-256 digest (the editor helper sends exactly this). A mismatch is a
    hard error — it means the upload was corrupted or the key was wrong, and silently
    keying on a bad hash would poison the cache.

Nothing here touches the network or the shared app/config modules; the FastAPI route in
``api/staging.py`` is the only caller.
"""

from __future__ import annotations

import hashlib
import logging
import os
import re
import tempfile
from dataclasses import dataclass
from pathlib import Path
from typing import Optional

log = logging.getLogger("fadi.bridge.assets.staging")

# Same derivation the proxy cache uses: bridge/data/<subdir>. Inside the default home
# media root, so a staged file is reachable by the range-media server + orchestrator.
_STAGING_DIR = Path(__file__).resolve().parent.parent / "data" / "blob-staging"

# A hash key must be plain hex (no separators, no traversal). Bounded length keeps the
# filename sane and rejects accidental path injection.
_HEX_RE = re.compile(r"\A[0-9a-fA-F]{8,128}\Z")

# Map common content types → file extension so the staged file is self-describing and
# ffmpeg/PIL can sniff it by suffix. Best-effort; unknown types stage extension-less.
_EXT_BY_CONTENT_TYPE = {
    "video/mp4": ".mp4",
    "video/quicktime": ".mov",
    "video/webm": ".webm",
    "video/x-matroska": ".mkv",
    "image/png": ".png",
    "image/jpeg": ".jpg",
    "image/webp": ".webp",
    "image/gif": ".gif",
    "audio/mpeg": ".mp3",
    "audio/mp4": ".m4a",
    "audio/wav": ".wav",
    "audio/x-wav": ".wav",
    "audio/aac": ".aac",
    "audio/ogg": ".ogg",
}

# Allowable filename extensions when supplied directly (sanitised). Keeps the cache to
# media-ish suffixes; anything else falls back to content-type / extension-less.
_SAFE_EXT_RE = re.compile(r"\A\.[A-Za-z0-9]{1,8}\Z")


class StagingError(Exception):
    """Raised for a bad hash key or an integrity mismatch (caller maps to 4xx)."""


@dataclass(frozen=True)
class StagedAsset:
    path: Path            # absolute path of the staged file on disk
    content_hash: str     # the (normalised, lower-cased) key it was stored under
    size: int             # bytes on disk
    reused: bool          # True when the keyed file already existed (no rewrite)


def staging_dir() -> Path:
    """Absolute path of the staging cache dir (created on first use)."""
    _STAGING_DIR.mkdir(parents=True, exist_ok=True)
    return _STAGING_DIR


def _normalise_hash(content_hash: str) -> str:
    h = (content_hash or "").strip().lower()
    if not _HEX_RE.match(h):
        raise StagingError(
            "content_hash must be a hex digest (8–128 hex chars, no path separators)"
        )
    return h


def _pick_extension(content_type: Optional[str], filename: Optional[str]) -> str:
    """Derive a file extension from an explicit filename suffix, else content type."""
    if filename:
        suffix = Path(filename).suffix
        if suffix and _SAFE_EXT_RE.match(suffix):
            return suffix.lower()
    if content_type:
        ct = content_type.split(";", 1)[0].strip().lower()
        if ct in _EXT_BY_CONTENT_TYPE:
            return _EXT_BY_CONTENT_TYPE[ct]
    return ""


def staged_path_for(content_hash: str, ext: str = "") -> Path:
    """The deterministic on-disk path a given hash+ext stages to (no I/O)."""
    h = _normalise_hash(content_hash)
    return staging_dir() / f"{h}{ext}"


def find_staged(content_hash: str) -> Optional[Path]:
    """Return an already-staged file for this hash (any extension), or None.

    Lets the editor probe whether an upload is needed without sending bytes.
    """
    h = _normalise_hash(content_hash)
    d = staging_dir()
    # Exact extension-less first, then any `<hash>.*`.
    bare = d / h
    if bare.is_file():
        return bare
    for p in d.glob(f"{h}.*"):
        if p.is_file():
            return p
    return None


def stage_bytes(
    data: bytes,
    content_hash: str,
    *,
    content_type: Optional[str] = None,
    filename: Optional[str] = None,
    verify: bool = True,
) -> StagedAsset:
    """Write `data` into the staging cache under `content_hash`, return its disk path.

    Idempotent: if the keyed file already exists with the same size it is reused (the
    common case for a re-stage). When `verify` is True and the hash is a SHA-256 digest
    (64 hex chars), the bytes are checked against it before being committed.
    """
    h = _normalise_hash(content_hash)

    if verify and len(h) == 64:
        actual = hashlib.sha256(data).hexdigest()
        if actual != h:
            raise StagingError(
                f"integrity check failed: sha256(bytes)={actual} != content_hash={h}"
            )

    ext = _pick_extension(content_type, filename)
    target = staged_path_for(h, ext)

    # Reuse an existing identical staging (same key+ext, same byte count).
    if target.is_file() and target.stat().st_size == len(data):
        return StagedAsset(path=target.resolve(), content_hash=h, size=len(data), reused=True)

    # If a file exists under this hash with a DIFFERENT extension, reuse it rather than
    # writing a duplicate (the bytes are identical — the key is the content).
    existing = find_staged(h)
    if existing is not None and existing.stat().st_size == len(data):
        return StagedAsset(path=existing.resolve(), content_hash=h, size=len(data), reused=True)

    d = staging_dir()
    # Atomic write: temp in the same dir → fsync → rename. Never expose a partial file.
    fd, tmp_name = tempfile.mkstemp(prefix=f".{h}.", suffix=ext or ".part", dir=str(d))
    tmp = Path(tmp_name)
    try:
        with os.fdopen(fd, "wb") as f:
            f.write(data)
            f.flush()
            os.fsync(f.fileno())
        os.replace(tmp, target)  # atomic on the same filesystem
    except Exception:
        try:
            tmp.unlink(missing_ok=True)
        except OSError:
            pass
        raise

    log.info("staged blob %s (%d bytes) → %s", h[:12], len(data), target.name)
    return StagedAsset(path=target.resolve(), content_hash=h, size=len(data), reused=False)
