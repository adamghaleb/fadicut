"""ffprobe wrapper + content classification for the asset catalog.

``probe(path)`` returns a normalized ``ProbeResult`` (kind, codec, duration, w/h,
has_alpha, fps). It shells out to the ffmpeg-full ffprobe (the bare Homebrew ffmpeg
lacks features we rely on elsewhere; we pin the full build's ffprobe for consistency).

Everything is defensive: a probe failure never raises — it returns a best-effort
result with ``kind`` inferred from the extension so indexing never stalls on one
weird file. Alpha detection (matters for the ProRes 4444 / .mov loop+overlay packs)
uses the pixel format reported by the video stream.
"""

from __future__ import annotations

import json
import shutil
import subprocess
from dataclasses import asdict, dataclass
from functools import lru_cache
from pathlib import Path

# Pinned ffmpeg-full ffprobe (per FADICUT.md); fall back to PATH if it moves.
_FFPROBE_PINNED = "/opt/homebrew/Cellar/ffmpeg-full/8.1_1/bin/ffprobe"

_IMAGE_EXTS = {".png", ".jpg", ".jpeg", ".webp", ".gif", ".bmp", ".tiff", ".heic", ".avif"}
_VIDEO_EXTS = {".mov", ".mp4", ".m4v", ".webm", ".mkv", ".avi", ".prores", ".mxf"}
_AUDIO_EXTS = {".wav", ".mp3", ".aiff", ".aif", ".flac", ".m4a", ".aac", ".ogg"}

# Pixel formats that carry an alpha channel (covers the ProRes 4444 / PNG-alpha packs).
_ALPHA_PIX_FMTS = {
    "yuva444p", "yuva444p10le", "yuva444p12le", "yuva420p", "yuva422p",
    "rgba", "bgra", "argb", "abgr", "rgba64le", "rgba64be", "ya8", "ya16le",
}


@dataclass(frozen=True)
class ProbeResult:
    kind: str                 # "video" | "image" | "audio" | "unknown"
    codec: str | None         # primary stream codec name
    duration: float | None    # seconds (None for stills)
    width: int | None
    height: int | None
    fps: float | None
    has_alpha: bool

    def public(self) -> dict:
        return asdict(self)


@lru_cache(maxsize=1)
def _ffprobe_bin() -> str | None:
    if Path(_FFPROBE_PINNED).exists():
        return _FFPROBE_PINNED
    return shutil.which("ffprobe")


def kind_from_ext(path: Path) -> str:
    ext = path.suffix.lower()
    if ext in _IMAGE_EXTS:
        return "image"
    if ext in _VIDEO_EXTS:
        return "video"
    if ext in _AUDIO_EXTS:
        return "audio"
    return "unknown"


def is_media_file(path: Path) -> bool:
    return kind_from_ext(path) != "unknown"


def _parse_fps(rate: str | None) -> float | None:
    if not rate or rate in ("0/0", "N/A"):
        return None
    try:
        if "/" in rate:
            num, den = rate.split("/", 1)
            den_f = float(den)
            return float(num) / den_f if den_f else None
        return float(rate)
    except (ValueError, ZeroDivisionError):
        return None


def _ext_only(path: Path) -> ProbeResult:
    """Best-effort result when ffprobe is unavailable or fails."""
    return ProbeResult(
        kind=kind_from_ext(path), codec=None, duration=None,
        width=None, height=None, fps=None, has_alpha=False,
    )


def probe(path: Path, timeout: float = 20.0) -> ProbeResult:
    """Probe one media file. Never raises — falls back to extension inference."""
    bin_ = _ffprobe_bin()
    if not bin_:
        return _ext_only(path)

    cmd = [
        bin_, "-v", "quiet", "-print_format", "json",
        "-show_format", "-show_streams", str(path),
    ]
    try:
        proc = subprocess.run(cmd, capture_output=True, timeout=timeout)
        if proc.returncode != 0:
            return _ext_only(path)
        data = json.loads(proc.stdout or b"{}")
    except (subprocess.TimeoutExpired, json.JSONDecodeError, OSError):
        return _ext_only(path)

    streams = data.get("streams", []) or []
    fmt = data.get("format", {}) or {}

    video = next((s for s in streams if s.get("codec_type") == "video"), None)
    audio = next((s for s in streams if s.get("codec_type") == "audio"), None)

    duration = None
    raw_dur = fmt.get("duration")
    if raw_dur not in (None, "N/A"):
        try:
            duration = float(raw_dur)
        except (TypeError, ValueError):
            duration = None

    ext_kind = kind_from_ext(path)

    if video is not None:
        pix = (video.get("pix_fmt") or "").lower()
        # A still image probes as a single-frame video stream — keep it an "image".
        nb_frames = video.get("nb_frames")
        kind = "image" if ext_kind == "image" else "video"
        # Animated GIFs / webp probe as video with many frames — treat as video.
        if ext_kind == "image" and nb_frames and nb_frames not in ("1", "0", "N/A"):
            try:
                if int(nb_frames) > 1:
                    kind = "video"
            except ValueError:
                pass
        return ProbeResult(
            kind=kind,
            codec=video.get("codec_name"),
            duration=duration if kind == "video" else None,
            width=video.get("width"),
            height=video.get("height"),
            fps=_parse_fps(video.get("avg_frame_rate") or video.get("r_frame_rate")),
            has_alpha=pix in _ALPHA_PIX_FMTS,
        )

    if audio is not None:
        return ProbeResult(
            kind="audio", codec=audio.get("codec_name"), duration=duration,
            width=None, height=None, fps=None, has_alpha=False,
        )

    return _ext_only(path)
