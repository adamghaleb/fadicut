"""Native Fadi-strobe baker — the authoritative side of the `strobe` FadiEffect.

`StrobeEffect.engine == "fadi_strobe"` (contracts/fadi_edl.py). The Fadi strobe takes a
layer (here: a baked clip / image) and cycles it through the 7 Fadi colors, swapping
every N frames and flickering on/off — turning a still into a flickering video, or
re-coloring a video frame-by-frame in the signature on/off strobe.

This module WRAPS Adam's existing engine
``~/.claude/skills/fadisplit/scripts/strobe.py`` (do NOT reimplement the strobe math).
That engine speaks "take a PNG layer / FadiSplit stack and emit a strobe .mp4/.mov".

Two surfaces the orchestrator needs:

  • ``bake_strobe(src, out, ...)`` — produce a standalone strobe clip from a single image
    (the engine's native mode). Used when the source element is a still.
  • ``strobe_video(src, out, ...)`` — apply the strobe *re-color* over an existing video,
    frame-by-frame, in-process (numpy + Pillow), reusing the engine's `grade`/`fill`
    color functions so the look matches the CLI exactly. This is the path the export
    orchestrator uses to strobe a main-track video clip in place.

Engine name: ``fadi_strobe`` (the queue runner kind is ``render_strobe``).
"""

from __future__ import annotations

import asyncio
import importlib.util
import os
import shutil
import subprocess
import tempfile
from pathlib import Path
from typing import Any, Awaitable, Callable, Optional

# Adam's strobe engine (CLI + reusable color functions).
STROBE_SCRIPT = Path(
    os.path.expanduser("~/.claude/skills/fadisplit/scripts/strobe.py")
)
FADI_PALETTE_SCRIPT = Path(
    os.path.expanduser("~/.claude/skills/fadisplit/scripts/fadi_palette.py")
)

# ffmpeg-full — the bare /opt/homebrew/bin/ffmpeg lacks filters/codecs we lean on.
FFMPEG = "/opt/homebrew/Cellar/ffmpeg-full/8.1_1/bin/ffmpeg"
FFPROBE = "/opt/homebrew/Cellar/ffmpeg-full/8.1_1/bin/ffprobe"
if not Path(FFMPEG).exists():
    FFMPEG = shutil.which("ffmpeg") or "ffmpeg"
    FFPROBE = shutil.which("ffprobe") or "ffprobe"

ProgressFn = Callable[[float, str], Awaitable[None]]

# Canonical 7 Fadi colors (RGB) — used when StrobeEffect.palette is empty.
FADI_RGB: list[tuple[int, int, int]] = [
    (255, 0, 96), (255, 164, 5), (255, 228, 0), (17, 255, 5),
    (5, 211, 255), (111, 5, 255), (246, 5, 255),
]


# ───────────────────────── engine module load (reuse color fns) ─────────────────────────

_engine_mod = None


def _load_engine():
    """Import the strobe engine as a module so we can reuse its `grade`/`fill` fns.

    The engine has a ``sys.path.insert`` for ``fadi_palette`` at import time, so we add
    its directory to sys.path before loading.
    """
    global _engine_mod
    if _engine_mod is not None:
        return _engine_mod
    if not STROBE_SCRIPT.exists():
        raise RuntimeError(f"strobe engine not found at {STROBE_SCRIPT}")
    import sys
    d = str(STROBE_SCRIPT.parent)
    if d not in sys.path:
        sys.path.insert(0, d)
    spec = importlib.util.spec_from_file_location("_fadi_strobe_engine", STROBE_SCRIPT)
    mod = importlib.util.module_from_spec(spec)
    assert spec and spec.loader
    spec.loader.exec_module(mod)  # type: ignore[union-attr]
    _engine_mod = mod
    return mod


def _palette(palette: Optional[list[str]]) -> list[tuple[int, int, int]]:
    """Resolve a hex palette → RGB tuples; fall back to the canonical Fadi 7."""
    if not palette:
        return list(FADI_RGB)
    out: list[tuple[int, int, int]] = []
    for hx in palette:
        s = str(hx).lstrip("#")
        try:
            out.append((int(s[0:2], 16), int(s[2:4], 16), int(s[4:6], 16)))
        except (ValueError, IndexError):
            continue
    return out or list(FADI_RGB)


# ───────────────────────── ffmpeg utils ─────────────────────────

def _run(cmd: list[str]) -> str:
    proc = subprocess.run(cmd, capture_output=True, text=True)
    if proc.returncode != 0:
        tail = (proc.stderr or proc.stdout or "").strip()[-2000:]
        raise RuntimeError(f"command failed ({proc.returncode}): {cmd[0]} ...\n{tail}")
    return proc.stdout


def _probe_fps(path: Path) -> float:
    out = _run([
        FFPROBE, "-v", "error", "-select_streams", "v:0",
        "-show_entries", "stream=r_frame_rate",
        "-of", "default=nw=1:nk=1", str(path),
    ]).strip()
    n, _, d = out.partition("/")
    try:
        return float(n) / float(d or 1)
    except (ValueError, ZeroDivisionError):
        return 24.0


_IMAGE_EXTS = {".png", ".jpg", ".jpeg", ".webp", ".bmp", ".tif", ".tiff"}


def _is_image(path: Path) -> bool:
    return path.suffix.lower() in _IMAGE_EXTS


# ───────────────────────── public bake API ─────────────────────────

def bake_strobe(
    src: Path,
    out: Path,
    *,
    palette: Optional[list[str]] = None,
    every_n_frames: int = 3,
    luminance_preserve: bool = True,
    fps: int = 24,
    duration_sec: float = 3.0,
    flicker: bool = True,
    off_frames: int = 1,
    bg: str = "transparent",
    prores: bool = False,
) -> Path:
    """Run the native strobe engine on a single image layer (CLI). Returns `out`.

    Used when the source element is a still and we want the engine's native
    image→strobe-video behaviour. ``luminance_preserve=True`` → engine ``--mode grade``
    (H+S substitution keeping detail); False → ``--mode fill`` (flat silhouette).
    """
    if not STROBE_SCRIPT.exists():
        raise RuntimeError(f"strobe engine not found at {STROBE_SCRIPT}")
    src = Path(src).expanduser().resolve()
    out = Path(out).expanduser().resolve()
    out.parent.mkdir(parents=True, exist_ok=True)

    import sys
    cmd = [
        sys.executable, str(STROBE_SCRIPT), str(src),
        "--target", str(src.name) if src.suffix.lower() == ".png" else str(src),
        "--bg", bg,
        "--fps", str(int(fps)),
        "--duration", f"{float(duration_sec):.3f}",
        "--every", str(max(1, int(every_n_frames))),
        "--off", str(max(0, int(off_frames))),
        "--mode", "grade" if luminance_preserve else "fill",
        "-o", str(out),
    ]
    cmd += ["--flicker"] if flicker else ["--no-flicker"]
    if prores:
        cmd += ["--prores"]
    proc = subprocess.run(cmd, capture_output=True, text=True)
    if proc.returncode != 0:
        raise RuntimeError(
            f"strobe failed (exit {proc.returncode}):\n{proc.stderr or proc.stdout}"
        )
    if not out.exists():
        raise RuntimeError(f"strobe finished but no output at {out}\n{proc.stdout}")
    return out


def strobe_video(
    src: Path,
    out: Path,
    *,
    palette: Optional[list[str]] = None,
    every_n_frames: int = 3,
    luminance_preserve: bool = True,
    flicker: bool = True,
    off_frames: int = 1,
    fps: Optional[float] = None,
    on_frame: Optional[Callable[[int, int], None]] = None,
) -> Path:
    """Apply the Fadi strobe re-color over an EXISTING video, frame-by-frame.

    Reuses the engine's `grade`/`fill` color functions so the substitution math matches
    the CLI exactly, but walks the source clip's own frames (so a main-track video keeps
    its motion while strobing through the Fadi palette). Returns `out`.
    """
    import numpy as np  # noqa: F401  (engine fns expect numpy present)
    from PIL import Image

    eng = _load_engine()
    tint = eng.grade if luminance_preserve else eng.fill
    pal = _palette(palette)

    src = Path(src).expanduser().resolve()
    out = Path(out).expanduser().resolve()
    out.parent.mkdir(parents=True, exist_ok=True)

    o_fps = float(fps or _probe_fps(src))
    work = Path(tempfile.mkdtemp(prefix="fadi_strobe_"))
    try:
        frames = work / "in"
        frames.mkdir()
        _run([
            FFMPEG, "-y", "-loglevel", "error", "-i", str(src),
            "-vf", f"fps={o_fps}", str(frames / "f%06d.png"),
        ])
        paths = sorted(frames.glob("f*.png"))
        total = len(paths)
        if total == 0:
            raise RuntimeError("strobe_video: source produced no frames")

        outdir = work / "out"
        outdir.mkdir()
        every = max(1, int(every_n_frames))
        off = max(0, int(off_frames))
        for i, fp in enumerate(paths):
            block = i // every
            color = pal[block % len(pal)]
            pos = i % every
            visible = not (flicker and pos >= (every - off))
            base = Image.open(fp).convert("RGBA")
            if visible:
                canvas = tint(base, color)
            else:
                # off-frame: black flash (the engine drops the layer to a clear/black bg).
                canvas = Image.new("RGBA", base.size, (0, 0, 0, 255))
            canvas.convert("RGB").save(outdir / fp.name)
            if on_frame:
                on_frame(i + 1, total)

        _run([
            FFMPEG, "-y", "-loglevel", "error",
            "-framerate", f"{o_fps}", "-i", str(outdir / "f%06d.png"),
            "-c:v", "libx264", "-crf", "16", "-pix_fmt", "yuv420p", str(out),
        ])
        return out
    finally:
        shutil.rmtree(work, ignore_errors=True)


# ───────────────────────── queue runner (engine = fadi_strobe) ─────────────────────────

async def strobe_runner(job: Any, progress: ProgressFn) -> dict:
    """Job runner for `render_strobe` (lane "cpu" — PIL frame walk, no GPU).

    Payload (mirrors StrobeEffect + IO):
      src:                str
      out:                str | None
      palette:            list[str]    (hex; default = Fadi 7)
      every_n_frames:     int  (default 3)
      luminance_preserve: bool (default True)
      flicker:            bool (default True)
      off_frames:         int  (default 1)
      fps / duration_sec: numbers (still → strobe-video duration)
      mode:               "video" (re-color a clip) | "image" (still → engine CLI)
    """
    p = job.payload or {}
    src = Path(p["src"]).expanduser()
    out = p.get("out")
    if not out:
        out = src.with_name(src.stem + "__strobe.mp4")
    out = Path(out).expanduser()

    mode = p.get("mode") or ("image" if _is_image(src) else "video")
    loop = asyncio.get_running_loop()

    def threaded_frame(done: int, total: int) -> None:
        frac = 0.05 + 0.9 * (done / max(1, total))
        asyncio.run_coroutine_threadsafe(progress(frac, f"strobe {done}/{total}"), loop)

    await progress(0.05, f"strobe: {mode}")
    if mode == "image":
        result = await asyncio.to_thread(
            bake_strobe, src, out,
            palette=p.get("palette"),
            every_n_frames=int(p.get("every_n_frames", 3)),
            luminance_preserve=bool(p.get("luminance_preserve", True)),
            fps=int(p.get("fps", 24)),
            duration_sec=float(p.get("duration_sec", 3.0)),
            flicker=bool(p.get("flicker", True)),
            off_frames=int(p.get("off_frames", 1)),
            bg=str(p.get("bg", "transparent")),
            prores=bool(p.get("prores", False)),
        )
    else:
        result = await asyncio.to_thread(
            strobe_video, src, out,
            palette=p.get("palette"),
            every_n_frames=int(p.get("every_n_frames", 3)),
            luminance_preserve=bool(p.get("luminance_preserve", True)),
            flicker=bool(p.get("flicker", True)),
            off_frames=int(p.get("off_frames", 1)),
            fps=p.get("fps"),
            on_frame=threaded_frame,
        )

    await progress(1.0, "strobe done")
    return {"ok": True, "engine": "fadi_strobe", "mode": mode, "output": str(result)}


def register(queue, kind: str = "render_strobe") -> None:
    """Register the strobe engine on the shared queue without editing queue.py."""
    queue.register_runner(kind, strobe_runner)


__all__ = [
    "bake_strobe",
    "strobe_video",
    "strobe_runner",
    "register",
    "FADI_RGB",
]
