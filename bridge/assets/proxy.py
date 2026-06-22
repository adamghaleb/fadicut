"""Proxy / thumbnail generation, keyed by content hash.

The editor previews stream from the Bridge over range-media, but a 4K ProRes 4444
loop is far too heavy to scrub in a browser <video>. So we bake a lightweight proxy
per asset and key it by the catalog's ``content_hash`` — identical content reuses one
proxy, and an edited file (new hash) gets a fresh one without clobbering the old.

Outputs (under ``bridge/data/proxies/<hash>.<ext>``):
  * video → an H.264 MP4 max-720p proxy (alpha is flattened — preview only; the
    authoritative render always uses the native source, never the proxy)
  * image → a max-512px WEBP thumbnail
  * audio → a PNG waveform peak strip (mono, gray)

Everything shells out to the pinned ffmpeg-full binary. Generation is idempotent and
safe to call repeatedly; ``ensure_proxy`` no-ops when the keyed file already exists.
This module never raises on a single failed asset — it returns ``None``.
"""

from __future__ import annotations

import logging
import shutil
import subprocess
from functools import lru_cache
from pathlib import Path

log = logging.getLogger("fadi.bridge.assets.proxy")

_FFMPEG_PINNED = "/opt/homebrew/Cellar/ffmpeg-full/8.1_1/bin/ffmpeg"
_PROXY_DIR = Path(__file__).resolve().parent.parent / "data" / "proxies"

_VIDEO_MAX_H = 720
_IMAGE_MAX = 512
_WAVE_SIZE = "640x96"


@lru_cache(maxsize=1)
def _ffmpeg_bin() -> str | None:
    if Path(_FFMPEG_PINNED).exists():
        return _FFMPEG_PINNED
    return shutil.which("ffmpeg")


def _proxy_path_for(content_hash: str, kind: str) -> Path:
    _PROXY_DIR.mkdir(parents=True, exist_ok=True)
    ext = {"video": "mp4", "image": "webp", "audio": "png"}.get(kind, "bin")
    return _PROXY_DIR / f"{content_hash}.{ext}"


def _run(cmd: list[str], timeout: float) -> bool:
    try:
        proc = subprocess.run(cmd, capture_output=True, timeout=timeout)
        return proc.returncode == 0
    except (subprocess.TimeoutExpired, OSError):
        return False


def _build_video(ff: str, src: Path, out: Path) -> bool:
    # Scale to <=720p, even dims, fast H.264, drop audio, short faststart proxy.
    vf = f"scale=-2:'min({_VIDEO_MAX_H},ih)':flags=bilinear"
    return _run(
        [ff, "-y", "-i", str(src), "-an", "-vf", vf,
         "-c:v", "libx264", "-preset", "veryfast", "-crf", "26",
         "-pix_fmt", "yuv420p", "-movflags", "+faststart", str(out)],
        timeout=300.0,
    )


def _build_image(ff: str, src: Path, out: Path) -> bool:
    vf = f"scale='min({_IMAGE_MAX},iw)':-1:force_original_aspect_ratio=decrease"
    return _run([ff, "-y", "-i", str(src), "-vf", vf, "-frames:v", "1", str(out)], timeout=60.0)


def _build_waveform(ff: str, src: Path, out: Path) -> bool:
    fc = f"aformat=channel_layouts=mono,showwavespic=s={_WAVE_SIZE}:colors=0x888888"
    return _run([ff, "-y", "-i", str(src), "-filter_complex", fc, "-frames:v", "1", str(out)],
                timeout=120.0)


def ensure_proxy(src_path: str, content_hash: str, kind: str) -> str | None:
    """Build (or reuse) the proxy for one asset. Returns its path, or None on failure.

    Idempotent: if the keyed proxy file already exists it's returned untouched.
    """
    ff = _ffmpeg_bin()
    if not ff:
        log.warning("ffmpeg unavailable — cannot build proxy for %s", src_path)
        return None

    src = Path(src_path)
    if not src.is_file():
        return None  # offline drive / vanished file

    out = _proxy_path_for(content_hash, kind)
    if out.exists() and out.stat().st_size > 0:
        return str(out)

    if kind == "video":
        ok = _build_video(ff, src, out)
    elif kind == "image":
        ok = _build_image(ff, src, out)
    elif kind == "audio":
        ok = _build_waveform(ff, src, out)
    else:
        return None

    if not ok:
        # Clean up a partial file so a retry is clean.
        try:
            if out.exists():
                out.unlink()
        except OSError:
            pass
        log.warning("proxy build failed for %s (%s)", src_path, kind)
        return None
    return str(out)


def proxy_dir() -> Path:
    _PROXY_DIR.mkdir(parents=True, exist_ok=True)
    return _PROXY_DIR
