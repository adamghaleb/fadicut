"""Native blob-tracking baker — the authoritative side of the `blob_track` FadiEffect.

`BlobTrackEffect.engine == "fadi_blob_track"` (contracts/fadi_edl.py). The FadiFiles
blob-tracking treatment lays a square micrographic "blob" overlay that *follows the
subject* across a clip: numbered square reticles riding tracked feature points, a corner-
bracket bbox cage built from the point spread, a live morphing quad, connecting nets /
motion trails, a telemetry HUD — beat-synced pop-ins on the song's beat grid.

This module WRAPS Adam's existing music-video blob engine (do NOT reimplement the
tracker math or the reticle/cage drawing):

  • the TRACKER  ``~/.claude/skills/fadifiles/v22/batch27/blob_track.py``
        Shi-Tomasi + Lucas-Kanade optical flow → tracks.json (stable per-point ids).
        Needs OpenCV, which lives only in that skill's dedicated ``.venv-tracker`` —
        so we shell out to that interpreter for stage 1.
  • the RENDERER ``~/.claude/skills/fadifiles-music-video/scripts/blob_render.py``
        pure-Python (PIL + numpy) data-driven pass: numbered reticles, bbox cage, live
        quad, telemetry HUD, beat-synced. Its module-level ``render_style`` /
        ``build_index`` / ``beat_frames`` primitives are imported IN-PROCESS (the Bridge
        venv carries PIL + numpy + the engine's ``pipelib``) and driven directly from a
        tracks.json — bypassing its spec/shoot-dir-coupled ``main()``.

We then composite the transparent ProRes 4444 ``blob_<style>.mov`` over the clip with
ffmpeg. The contract knobs map on:

  follow   → which blob style rides the subject:
                "subject" → telemetry (reticles + bbox cage + live quad + HUD)
                "center"  → proximity (reticles + live quad + tight cage)
                "motion"  → trails    (motion-trail tails behind each point)
  shape    → the reticle glyph the renderer draws ("square" reticles are the default
             micrographic look; "circle"/"rounded" are passed through as a hint).
  color    → optional hex that tints the whole pass to one Fadi color (else the engine's
             7-color per-id palette).
  beat_react → beat-synced reticle/cage pops; uses the supplied beat times (EDL
             beat_markers_sec) or a bpm, falling back to no beats (still renders).

Engine name: ``fadi_blob_track`` (the queue runner kind is ``render_blob_track``).
"""

from __future__ import annotations

import asyncio
import importlib.util
import json
import os
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path
from typing import Any, Awaitable, Callable, Optional

# ── native engine locations (WRAP, do not reimplement) ────────────────────────
_TRACKER_DIR = Path(os.path.expanduser("~/.claude/skills/fadifiles/v22/batch27"))
TRACKER_SCRIPT = _TRACKER_DIR / "blob_track.py"
TRACKER_PYTHON = _TRACKER_DIR / ".venv-tracker" / "bin" / "python"  # the only cv2 interp

_RENDER_DIR = Path(
    os.path.expanduser("~/.claude/skills/fadifiles-music-video/scripts")
)
RENDER_SCRIPT = _RENDER_DIR / "blob_render.py"

# ffmpeg-full for the composite (transparent .mov over the clip).
FFMPEG = "/opt/homebrew/Cellar/ffmpeg-full/8.1_1/bin/ffmpeg"
if not Path(FFMPEG).exists():
    FFMPEG = shutil.which("ffmpeg") or "ffmpeg"

ProgressFn = Callable[[float, str], Awaitable[None]]

# contract follow → blob_render style
_FOLLOW_STYLE: dict[str, str] = {
    "subject": "telemetry",
    "center": "proximity",
    "motion": "trails",
}
_DEFAULT_STYLE = "telemetry"


# ───────────────────────── blob_render lazy import ─────────────────────────

_blob_render_mod = None


def _load_blob_render():
    """Import the engine's blob_render module in-process (PIL/numpy/pipelib live in the
    Bridge venv). Cached. The engine dir goes on sys.path so its ``import pipelib`` works.
    """
    global _blob_render_mod
    if _blob_render_mod is not None:
        return _blob_render_mod
    if not RENDER_SCRIPT.exists():
        raise RuntimeError(f"blob_render engine not found at {RENDER_SCRIPT}")
    if str(_RENDER_DIR) not in sys.path:
        sys.path.insert(0, str(_RENDER_DIR))
    spec = importlib.util.spec_from_file_location("fadi_blob_render", str(RENDER_SCRIPT))
    if spec is None or spec.loader is None:
        raise RuntimeError(f"could not load blob_render from {RENDER_SCRIPT}")
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    _blob_render_mod = mod
    return mod


# ───────────────────────── stage 1: track ─────────────────────────

def _track(src: Path, tracks_json: Path, *, max_features: int, reseed_every: int) -> dict:
    """Run the OpenCV tracker (its dedicated venv) → tracks.json; return the parsed dict."""
    if not TRACKER_SCRIPT.exists():
        raise RuntimeError(f"blob tracker not found at {TRACKER_SCRIPT}")
    if not TRACKER_PYTHON.exists():
        raise RuntimeError(
            f"blob tracker venv (OpenCV) not found at {TRACKER_PYTHON} — create it:\n"
            f"  python3 -m venv {_TRACKER_DIR}/.venv-tracker && "
            f"{_TRACKER_DIR}/.venv-tracker/bin/pip install numpy opencv-python"
        )
    cmd = [
        str(TRACKER_PYTHON), str(TRACKER_SCRIPT), str(src),
        "--out", str(tracks_json),
        "--max", str(int(max_features)),
        "--reseed-every", str(int(reseed_every)),
    ]
    proc = subprocess.run(cmd, capture_output=True, text=True)
    if proc.returncode != 0 or not tracks_json.exists():
        tail = (proc.stderr or proc.stdout or "").strip()[-2000:]
        raise RuntimeError(f"blob tracker failed (exit {proc.returncode}):\n{tail}")
    return json.loads(tracks_json.read_text())


# ───────────────────────── stage 2: render the transparent pass ─────────────────────────

def _tint_palette(mod, color: Optional[str]) -> None:
    """If a single Fadi color is requested, collapse the engine's per-id palette to it so
    the whole pass reads as one color. Restored by the caller after render."""
    if not color:
        return
    c = color.lstrip("#")
    if len(c) != 6:
        return
    rgb = (int(c[0:2], 16), int(c[2:4], 16), int(c[4:6], 16))
    # blob_render colors come from FADI[] via col(i); overwrite the list so every id tints.
    mod.FADI = [rgb]


def _render_pass(
    td: dict,
    out_mov: Path,
    *,
    style: str,
    color: Optional[str],
    beats_sec: Optional[list[float]],
    bpm: Optional[float],
    max_reticles: int,
) -> Path:
    """Drive blob_render's primitives directly from a tracks.json dict → transparent .mov."""
    mod = _load_blob_render()
    saved_fadi = list(mod.FADI)
    try:
        _tint_palette(mod, color)
        tracks = td["tracks"]
        W, H = td["size"]
        fps = float(td["fps"])
        n = int(td["n_frames"])

        byf = mod.build_index(tracks, n)

        # beat frames: explicit beat times win; else synth from bpm; else none (still ok).
        if beats_sec:
            beats = {int(round(b * fps)) for b in beats_sec if b is not None and b >= 0}
        elif bpm:
            beats = mod.beat_frames(bpm, 0.0, fps, n)
        else:
            beats = set()

        out_mov.parent.mkdir(parents=True, exist_ok=True)
        mod.render_style(style, tracks, byf, beats, W, H, fps, n, str(out_mov), max_reticles)
    finally:
        mod.FADI = saved_fadi
    if not out_mov.exists():
        raise RuntimeError(f"blob_render produced no output at {out_mov}")
    return out_mov


# ───────────────────────── stage 3: composite ─────────────────────────

def _composite(src: Path, overlay_mov: Path, out: Path) -> Path:
    """Overlay the transparent blob pass on the clip (overlay sized to the source)."""
    out.parent.mkdir(parents=True, exist_ok=True)
    fc = (
        "[1:v]scale=iw:ih[ov];"
        "[0:v][ov]overlay=0:0:format=auto[outv]"
    )
    cmd = [
        FFMPEG, "-y", "-loglevel", "error",
        "-i", str(src),
        "-i", str(overlay_mov),
        "-filter_complex", fc,
        "-map", "[outv]",
    ]
    # preserve source audio if present (export mux happens downstream regardless).
    cmd += ["-map", "0:a?", "-c:a", "copy"]
    cmd += ["-c:v", "libx264", "-crf", "16", "-pix_fmt", "yuv420p", str(out)]
    proc = subprocess.run(cmd, capture_output=True, text=True)
    if proc.returncode != 0 or not out.exists():
        tail = (proc.stderr or proc.stdout or "").strip()[-2000:]
        raise RuntimeError(f"blob composite failed (exit {proc.returncode}):\n{tail}")
    return out


# ───────────────────────── public baker ─────────────────────────

def bake_blob_track(
    src: Path | str,
    out: Path | str,
    *,
    shape: str = "square",
    color: Optional[str] = None,
    follow: str = "subject",
    beat_react: bool = True,
    beats_sec: Optional[list[float]] = None,
    bpm: Optional[float] = None,
    max_features: int = 140,
    reseed_every: int = 24,
    max_reticles: int = 26,
    keep_pass: bool = False,
    work_dir: Optional[Path | str] = None,
) -> Path:
    """Bake a subject-tracking square micrographic blob overlay onto `src` → `out`.

    Stages: track (OpenCV venv) → render transparent ProRes pass (blob_render primitives,
    in-process) → composite over the clip (ffmpeg). Returns `out`.

    `follow` picks the blob style (subject→telemetry, center→proximity, motion→trails);
    `color` tints the whole pass to one Fadi hex (else the engine's 7-color per-id palette);
    `beat_react` enables beat-synced pops from `beats_sec` (preferred) or `bpm`.
    `shape` is recorded as a layout hint (the engine's reticles are squares).
    """
    src = Path(src).expanduser().resolve()
    out = Path(out).expanduser().resolve()
    if not src.exists():
        raise FileNotFoundError(f"blob_track: source not found at {src}")

    style = _FOLLOW_STYLE.get(follow, _DEFAULT_STYLE)
    own_work = work_dir is None
    work = Path(work_dir).expanduser() if work_dir else Path(
        tempfile.mkdtemp(prefix="fadi_blob_")
    )
    work.mkdir(parents=True, exist_ok=True)
    try:
        tracks_json = work / "tracks.json"
        td = _track(src, tracks_json, max_features=max_features, reseed_every=reseed_every)

        overlay_mov = work / f"blob_{style}.mov"
        _render_pass(
            td, overlay_mov,
            style=style,
            color=color,
            beats_sec=beats_sec if beat_react else None,
            bpm=bpm if beat_react else None,
            max_reticles=max_reticles,
        )

        _composite(src, overlay_mov, out)
    finally:
        if own_work and not keep_pass:
            shutil.rmtree(work, ignore_errors=True)
    return out


# ═════════════════════════ effect-handler (orchestrator dispatch) ═════════════════════════

def _effect_beats_sec(ctx: Any, beat_react: bool) -> Optional[list[float]]:
    """Resolve beat times for the clip from the EDL's beat grid (used by the handler).

    Times are EDL/timeline-relative; the tracker indexes frames from the clip's start, so
    we shift the grid into clip-local time and keep only the beats inside the clip window.
    """
    if not beat_react:
        return None
    edl = getattr(ctx, "edl", None)
    el = getattr(ctx, "element", None)
    markers = list(getattr(edl, "beat_markers_sec", []) or []) if edl else []
    if not markers:
        return None
    start = float(getattr(el, "start_sec", 0.0) or 0.0)
    dur = float(getattr(el, "duration_sec", 0.0) or 0.0)
    end = start + dur if dur > 0 else None
    local = [m - start for m in markers if m >= start and (end is None or m <= end)]
    return local or None


def _is_image_path(p: Path) -> bool:
    return p.suffix.lower() in {
        ".png", ".jpg", ".jpeg", ".webp", ".bmp", ".tif", ".tiff",
    }


async def blob_track_handler(ctx: Any, fx: Any, progress: ProgressFn) -> None:
    """Orchestrator effect handler for `blob_track`.

    Reads ``ctx.current``, bakes the tracking blob overlay onto it, and REASSIGNS
    ``ctx.current`` to the result (contract from orchestrator.ClipContext). Tracking needs
    real motion across frames, so a still (image) clip is a documented no-op.
    """
    cur = Path(ctx.current)
    if _is_image_path(cur):
        return  # tracking is meaningless on a still — documented no-op

    await progress(0.0, "blob track")
    beats = _effect_beats_sec(ctx, getattr(fx, "beat_react", True))
    params = getattr(fx, "params", {}) or {}
    out = ctx.stage("blob")

    await asyncio.to_thread(
        bake_blob_track,
        cur, out,
        shape=getattr(fx, "shape", "square"),
        color=getattr(fx, "color", None),
        follow=getattr(fx, "follow", "subject"),
        beat_react=bool(getattr(fx, "beat_react", True)),
        beats_sec=beats,
        bpm=params.get("bpm"),
        max_features=int(params.get("max_features", 140)),
        reseed_every=int(params.get("reseed_every", 24)),
        max_reticles=int(params.get("max_reticles", 26)),
        work_dir=ctx.work / f"blob_{ctx.seq:03d}",
    )
    ctx.current = out
    ctx.bumped("blob_track")


def register_blob_track_handler() -> None:
    """Register the `blob_track` effect handler on the orchestrator dispatch registry.

    Mirrors how the built-ins are installed, but WITHOUT editing orchestrator.py — issue
    #8 exposes ``register_effect_handler`` for exactly this. Idempotent (last writer wins).
    """
    from render.orchestrator import register_effect_handler

    register_effect_handler("blob_track", blob_track_handler)


# ───────────────────────── queue runner (engine = fadi_blob_track) ─────────────────────────

async def blob_track_runner(job: Any, progress: ProgressFn) -> dict:
    """Job runner for `render_blob_track` (lane "cpu" — tracker + PIL pass + composite).

    Payload (mirrors BlobTrackEffect + IO):
      src:          str
      out:          str | None
      shape:        "square" | "rounded" | "circle"   (default "square")
      color:        str | None                          (hex; tints the whole pass)
      follow:       "subject" | "center" | "motion"     (default "subject")
      beat_react:   bool (default True)
      beats_sec:    list[float] | None   (beat times, clip-local; preferred)
      bpm:          float | None         (synth beats when beats_sec absent)
      max_features: int (default 140)
      reseed_every: int (default 24)
      max_reticles: int (default 26)
      keep_pass:    bool (default False) (keep the work dir / transparent .mov)
    """
    p = job.payload or {}
    src = Path(p["src"]).expanduser()
    out = p.get("out")
    if not out:
        out = src.with_name(src.stem + "__blob.mp4")
    out = Path(out).expanduser()

    await progress(0.05, "blob: tracking features")
    loop = asyncio.get_running_loop()
    stop = asyncio.Event()

    async def _heartbeat() -> None:
        frac = 0.05
        while not stop.is_set():
            await asyncio.sleep(2.0)
            frac = min(0.92, frac + 0.04)
            await progress(frac, "blob: tracking + compositing")

    hb = asyncio.create_task(_heartbeat())
    try:
        result = await loop.run_in_executor(
            None,
            lambda: bake_blob_track(
                src, out,
                shape=str(p.get("shape", "square")),
                color=p.get("color"),
                follow=str(p.get("follow", "subject")),
                beat_react=bool(p.get("beat_react", True)),
                beats_sec=p.get("beats_sec"),
                bpm=p.get("bpm"),
                max_features=int(p.get("max_features", 140)),
                reseed_every=int(p.get("reseed_every", 24)),
                max_reticles=int(p.get("max_reticles", 26)),
                keep_pass=bool(p.get("keep_pass", False)),
            ),
        )
    finally:
        stop.set()
        hb.cancel()
        try:
            await hb
        except asyncio.CancelledError:
            pass

    await progress(1.0, "blob done")
    return {"ok": True, "engine": "fadi_blob_track", "output": str(result)}


def register(queue, kind: str = "render_blob_track") -> None:
    """Register the blob-track engine on the shared queue without editing queue.py.

    Also installs the orchestrator effect handler so an EDL export dispatches `blob_track`.
    """
    register_blob_track_handler()
    queue.register_runner(kind, blob_track_runner)


__all__ = [
    "bake_blob_track",
    "blob_track_handler",
    "register_blob_track_handler",
    "blob_track_runner",
    "register",
]
