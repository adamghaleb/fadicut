"""Export-bake orchestration — composite a FadiEDL into one final mp4 natively.

This is the *final render* side of the browser↔native boundary (issue #4). OpenCut
edits in the browser and serializes a `FadiEDL`; this module consumes it, runs the per-
effect native bakes (reusing the existing batch baker functions — it never reimplements
the grade / lyric / ramp engines), and composites everything with ffmpeg into a single
mp4 at the EDL's render width/height/fps.

Tightly-scoped MVP (the realistic FadiFiles case), deliberately NOT a general timeline:
  1. BASE layer: the `main`-role tracks' video/image elements laid in timeline order.
     Each is trimmed to its [trim_start, duration] window, scaled+padded to the render
     canvas, and placed at its `start_sec` (gaps → black).
  2. PER-CLIP GRADE: if a main element carries a `grade` effect, it is baked first via
     `render.fadi_grade.bake_grade` and the graded file is used in place of the source.
  3. OVERLAY layer: `overlay`-role tracks' lyric elements (a `lyric` effect, engine
     meandu) are baked to a transparent ProRes .mov via `render.meandu.bake_lyric_slice`
     and composited on top of the base with ffmpeg `overlay`, enabled only for the
     element's [start, start+duration] window.
  4. AUDIO: if the EDL binds a `song_id`, the SongContext's master audio is muxed in.

Anything outside this (ramps on the timeline, strobe/overlay-asset/morph effects, text
elements without a lyric effect, multi-overlay stacking beyond what ffmpeg chains) is a
documented scope cut — the base + grade + lyric path is what FadiFiles needs to ship.

Job wiring: exposes `render_project_runner(job, progress)` (lane "cpu") and a
`register(queue)` helper, mirroring `render.meandu.register`. The integrator wires it in
the app lifespan WITHOUT editing the shared queue file.

Payload: ``{"edl": <FadiEDL dict>, "out_path"?: str, "smoke_frames"?: int}``
Result:  ``{"ok", "out_path", "width", "height", "fps", "duration_sec",
            "baked": {"grade": n, "lyric": n}, "engine": "orchestrator"}``
"""

from __future__ import annotations

import asyncio
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path
from typing import Any, Awaitable, Callable, Optional

# Frozen contract (mirror of song_context_provider's import path: repo-root/contracts).
_REPO = Path(__file__).resolve().parents[2]
_CONTRACTS = _REPO / "contracts"
if str(_CONTRACTS) not in sys.path:
    sys.path.insert(0, str(_CONTRACTS))

from fadi_contracts.fadi_edl import (  # noqa: E402
    FadiEDL,
    GradeEffect,
    ImageElement,
    LyricEffect,
    VideoElement,
)

from .fadi_grade import bake_grade  # noqa: E402  — reuse, do not reimplement
from .meandu import SUPPORTED_SONG_IDS, bake_lyric_slice  # noqa: E402
from .song_context_provider import load_song_context  # noqa: E402

# ffmpeg-full — the bare /opt/homebrew/bin/ffmpeg lacks filters/codecs we lean on.
FFMPEG = "/opt/homebrew/Cellar/ffmpeg-full/8.1_1/bin/ffmpeg"
FFPROBE = "/opt/homebrew/Cellar/ffmpeg-full/8.1_1/bin/ffprobe"
if not Path(FFMPEG).exists():  # graceful fallback so a CI box without the cellar build still imports
    FFMPEG = shutil.which("ffmpeg") or "ffmpeg"
    FFPROBE = shutil.which("ffprobe") or "ffprobe"

ProgressFn = Callable[[float, str], Awaitable[None]]


# ───────────────────────── small ffmpeg utils ─────────────────────────

def _run(cmd: list[str]) -> str:
    """Run a subprocess, surfacing stderr on failure (so the job error is useful)."""
    proc = subprocess.run(cmd, capture_output=True, text=True)
    if proc.returncode != 0:
        tail = (proc.stderr or proc.stdout or "").strip()[-2000:]
        raise RuntimeError(f"command failed ({proc.returncode}): {cmd[0]} ...\n{tail}")
    return proc.stdout


_IMAGE_EXTS = {".png", ".jpg", ".jpeg", ".webp", ".bmp", ".tif", ".tiff"}


def _is_image(path: Path) -> bool:
    return path.suffix.lower() in _IMAGE_EXTS


# ───────────────────────── media resolution ─────────────────────────

def _resolve_media_path(element: Any) -> Path:
    """Resolve an element's source media to an absolute filesystem path.

    OpenCut's `media_id` is a browser-side IndexedDB id, not a path, so the editor's
    native-export adapter stamps the resolved absolute path into ``element.params`` as
    ``src_path`` (or ``abs_path``/``path``). We honour that first, then fall back to a
    ``media_id`` that already looks like an absolute path (e.g. a Library asset).
    """
    params = getattr(element, "params", {}) or {}
    for key in ("src_path", "abs_path", "path"):
        raw = params.get(key)
        if raw:
            p = Path(str(raw)).expanduser()
            if p.exists():
                return p.resolve()
            raise FileNotFoundError(f"element {getattr(element, 'id', '?')}: media not found at {p}")
    media_id = getattr(element, "media_id", None)
    if media_id and (str(media_id).startswith("/") or str(media_id).startswith("~")):
        p = Path(str(media_id)).expanduser()
        if p.exists():
            return p.resolve()
    raise FileNotFoundError(
        f"element {getattr(element, 'id', '?')}: no resolvable media path "
        f"(set params.src_path to an absolute path)"
    )


def _first_grade(element: Any) -> Optional[GradeEffect]:
    for fx in getattr(element, "effects", []) or []:
        if isinstance(fx, GradeEffect):
            return fx
    return None


def _first_lyric(element: Any) -> Optional[LyricEffect]:
    for fx in getattr(element, "effects", []) or []:
        if isinstance(fx, LyricEffect):
            return fx
    return None


# ───────────────────────── base segment prep ─────────────────────────

def _prep_base_segment(
    src: Path,
    out: Path,
    *,
    width: int,
    height: int,
    fps: int,
    trim_start_sec: float,
    duration_sec: float,
) -> None:
    """Trim + scale+pad a main-track element to a render-canvas-sized, fixed-fps clip.

    Images become a `duration_sec` still; videos are trimmed to their window. The result
    is a silent normalized segment that can be concatenated with peers on the base layer.
    """
    out.parent.mkdir(parents=True, exist_ok=True)
    vf = (
        f"scale={width}:{height}:force_original_aspect_ratio=decrease,"
        f"pad={width}:{height}:(ow-iw)/2:(oh-ih)/2:black,setsar=1,fps={fps},format=yuv420p"
    )
    if _is_image(src):
        cmd = [
            FFMPEG, "-y", "-loglevel", "error",
            "-loop", "1", "-t", f"{max(0.04, duration_sec):.3f}", "-i", str(src),
            "-vf", vf, "-an",
            "-c:v", "libx264", "-crf", "16", "-pix_fmt", "yuv420p", str(out),
        ]
    else:
        cmd = [
            FFMPEG, "-y", "-loglevel", "error",
            "-ss", f"{max(0.0, trim_start_sec):.3f}",
            "-t", f"{max(0.04, duration_sec):.3f}",
            "-i", str(src),
            "-vf", vf, "-an",
            "-c:v", "libx264", "-crf", "16", "-pix_fmt", "yuv420p", str(out),
        ]
    _run(cmd)


def _black_segment(out: Path, *, width: int, height: int, fps: int, duration_sec: float) -> None:
    """A black filler for a gap between base elements."""
    out.parent.mkdir(parents=True, exist_ok=True)
    _run([
        FFMPEG, "-y", "-loglevel", "error",
        "-f", "lavfi", "-i", f"color=c=black:s={width}x{height}:r={fps}",
        "-t", f"{max(0.04, duration_sec):.3f}",
        "-c:v", "libx264", "-crf", "20", "-pix_fmt", "yuv420p", str(out),
    ])


def _concat(segments: list[Path], out: Path, work: Path) -> None:
    """Concat normalized base segments (all same w/h/fps/codec) into the base layer."""
    listfile = work / "concat.txt"
    listfile.write_text("".join(f"file '{s.as_posix()}'\n" for s in segments))
    _run([
        FFMPEG, "-y", "-loglevel", "error",
        "-f", "concat", "-safe", "0", "-i", str(listfile),
        "-c", "copy", str(out),
    ])


# ───────────────────────── overlay compositing ─────────────────────────

def _overlay_lyric(
    base: Path,
    overlay_mov: Path,
    out: Path,
    *,
    width: int,
    height: int,
    start_sec: float,
    duration_sec: float,
) -> None:
    """Composite a transparent lyric .mov over the base, enabled only for its window.

    The overlay is scaled to the render canvas and gated with ffmpeg's `enable=between(...)`
    so it only appears for [start, start+duration]. PTS is shifted so the overlay's t=0
    lands at the element's timeline start.
    """
    out.parent.mkdir(parents=True, exist_ok=True)
    end = start_sec + max(0.04, duration_sec)
    fc = (
        f"[1:v]scale={width}:{height}:force_original_aspect_ratio=decrease,"
        f"pad={width}:{height}:(ow-iw)/2:(oh-ih)/2:color=black@0,setpts=PTS-STARTPTS+{start_sec:.3f}/TB[ov];"
        f"[0:v][ov]overlay=0:0:enable='between(t,{start_sec:.3f},{end:.3f})':format=auto[outv]"
    )
    _run([
        FFMPEG, "-y", "-loglevel", "error",
        "-i", str(base),
        "-i", str(overlay_mov),
        "-filter_complex", fc,
        "-map", "[outv]",
        "-c:v", "libx264", "-crf", "16", "-pix_fmt", "yuv420p", str(out),
    ])


def _mux_audio(video: Path, audio_src: Path, out: Path) -> None:
    """Mux an external audio master onto the composited video (truncate to video length)."""
    out.parent.mkdir(parents=True, exist_ok=True)
    _run([
        FFMPEG, "-y", "-loglevel", "error",
        "-i", str(video), "-i", str(audio_src),
        "-map", "0:v:0", "-map", "1:a:0",
        "-c:v", "copy", "-c:a", "aac", "-b:a", "192k", "-shortest",
        str(out),
    ])


# ───────────────────────── the orchestration core ─────────────────────────

def render_edl(
    edl: FadiEDL,
    *,
    out_path: Optional[str | Path] = None,
    smoke_frames: Optional[int] = None,
    on_progress: Optional[Callable[[float, str], None]] = None,
) -> dict[str, Any]:
    """Composite a FadiEDL into one mp4. Synchronous core (the async runner wraps it).

    `on_progress(frac, msg)` is a plain callable. Returns the result dict described in
    the module docstring.
    """
    def emit(frac: float, msg: str) -> None:
        if on_progress:
            on_progress(frac, msg)

    w, h, fps = edl.render.width, edl.render.height, edl.render.fps

    work = Path(tempfile.mkdtemp(prefix="fadi_orchestrate_"))
    baked = {"grade": 0, "lyric": 0}

    if out_path is None:
        out_path = work / "fadicut_final.mp4"
    out_final = Path(out_path).expanduser()
    out_final.parent.mkdir(parents=True, exist_ok=True)

    # ── 1. gather + order the base (main-role) elements ──────────────────────
    main_elements: list[Any] = []
    for track in edl.tracks:
        if track.hidden:
            continue
        if track.role != "main":
            continue
        for el in track.elements:
            if isinstance(el, (VideoElement, ImageElement)):
                main_elements.append(el)
    main_elements.sort(key=lambda e: e.start_sec)

    if not main_elements:
        raise ValueError("orchestrator MVP needs at least one main-track video/image element")

    emit(0.05, f"preparing {len(main_elements)} base segment(s)")

    # ── 2. per-element grade bake (if present) + base segment prep ───────────
    segments: list[Path] = []
    cursor = 0.0
    seg_idx = 0
    for i, el in enumerate(main_elements):
        # fill a gap before this element with black
        if el.start_sec - cursor > 0.05:
            gap = work / f"gap_{seg_idx:03d}.mp4"
            _black_segment(gap, width=w, height=h, fps=fps, duration_sec=el.start_sec - cursor)
            segments.append(gap)
            seg_idx += 1

        src = _resolve_media_path(el)

        grade = _first_grade(el)
        if grade is not None:
            emit(0.05 + 0.35 * (i / len(main_elements)), f"grade bake {i + 1}/{len(main_elements)}")
            graded = work / f"graded_{i:03d}{src.suffix.lower() if _is_image(src) else '.mp4'}"
            bake_grade(
                src, graded,
                mode=grade.mode, fadi_color=grade.fadi_color, params=grade.params or {},
                fps=float(fps), width=w,
            )
            src = graded
            baked["grade"] += 1

        seg = work / f"seg_{seg_idx:03d}.mp4"
        _prep_base_segment(
            src, seg,
            width=w, height=h, fps=fps,
            trim_start_sec=getattr(el, "trim_start_sec", 0.0),
            duration_sec=el.duration_sec,
        )
        segments.append(seg)
        seg_idx += 1
        cursor = el.start_sec + el.duration_sec

    emit(0.45, "concatenating base layer")
    base = work / "base.mp4"
    if len(segments) == 1:
        shutil.copy2(segments[0], base)
    else:
        _concat(segments, base, work)

    # ── 3. overlay lyric tracks ──────────────────────────────────────────────
    lyric_jobs: list[tuple[Any, LyricEffect]] = []
    for track in edl.tracks:
        if track.hidden or track.role != "overlay":
            continue
        for el in track.elements:
            lyr = _first_lyric(el)
            if lyr is not None:
                lyric_jobs.append((el, lyr))

    composited = base
    for j, (el, lyr) in enumerate(lyric_jobs):
        song_id = edl.song_id or "me-u-1bc03491"
        if song_id not in SUPPORTED_SONG_IDS:
            # scope cut: only me&u lyric bakes are wired in the meandu spike.
            continue
        emit(0.55 + 0.3 * (j / max(1, len(lyric_jobs))), f"lyric bake {j + 1}/{len(lyric_jobs)}")
        ov_mov = work / f"lyric_{j:03d}.mov"
        bake_lyric_slice(
            song_id=song_id,
            start_sec=getattr(el, "trim_start_sec", 0.0) + 0.0,  # slice from lyric timeline 0 by default
            duration_sec=el.duration_sec,
            out_path=ov_mov,
            smoke_frames=smoke_frames,
        )
        baked["lyric"] += 1
        nxt = work / f"composite_{j:03d}.mp4"
        _overlay_lyric(
            composited, ov_mov, nxt,
            width=w, height=h,
            start_sec=el.start_sec, duration_sec=el.duration_sec,
        )
        composited = nxt

    # ── 4. mux song audio if bound ───────────────────────────────────────────
    emit(0.9, "muxing audio + finalizing")
    audio_path: Optional[Path] = None
    if edl.song_id:
        try:
            ctx = load_song_context(edl.song_id)
            master = ctx.audio.master_path
            if master:
                cand = Path(master).expanduser()
                if cand.is_file():
                    audio_path = cand
                elif cand.is_dir():
                    # catalog may store a directory; pick the first audio file in it.
                    for ext in ("*.wav", "*.mp3", "*.m4a", "*.aac", "*.flac"):
                        hits = sorted(cand.glob(ext))
                        if hits:
                            audio_path = hits[0]
                            break
        except (KeyError, OSError):
            audio_path = None

    if audio_path is not None:
        _mux_audio(composited, audio_path, out_final)
    else:
        shutil.copy2(composited, out_final)

    # probe final duration for the result
    dur = 0.0
    try:
        dur = float(_run([
            FFPROBE, "-v", "error", "-show_entries", "format=duration",
            "-of", "default=nw=1:nk=1", str(out_final),
        ]).strip() or 0.0)
    except (RuntimeError, ValueError):
        pass

    emit(1.0, "done")
    return {
        "ok": True,
        "out_path": str(out_final),
        "width": w,
        "height": h,
        "fps": fps,
        "duration_sec": dur,
        "baked": baked,
        "audio_muxed": audio_path is not None,
        "engine": "orchestrator",
    }


# ───────────────────────── job-queue runner (async wrapper) ─────────────────────────

async def render_project_runner(job: Any, progress: ProgressFn) -> dict[str, Any]:
    """Async runner conforming to the Bridge queue's Runner signature (lane "cpu").

    Offloads the blocking composite to a thread so the event loop / SSE fan-out stays
    responsive; bridges thread-side progress back via run_coroutine_threadsafe.
    """
    p = job.payload or {}
    raw_edl = p.get("edl")
    if not raw_edl:
        raise ValueError("payload.edl is required (a FadiEDL object)")

    # Validate/coerce against the frozen contract. The browser adapter ships a partial
    # but structurally-compatible EDL; pydantic fills defaults + discriminates unions.
    edl = FadiEDL.model_validate(raw_edl)

    out_path = p.get("out_path")
    smoke_frames = p.get("smoke_frames")

    loop = asyncio.get_running_loop()

    def threaded_progress(frac: float, msg: str) -> None:
        asyncio.run_coroutine_threadsafe(progress(frac, msg), loop)

    return await asyncio.to_thread(
        render_edl,
        edl,
        out_path=out_path,
        smoke_frames=smoke_frames,
        on_progress=threaded_progress,
    )


def register(queue, kind: str = "render_project") -> None:
    """Register the orchestrator on the shared queue without editing queue.py.

    Usage in the integrator (app lifespan):
        from jobs import get_queue
        from render import orchestrator
        orchestrator.register(get_queue())
    """
    queue.register_runner(kind, render_project_runner)


__all__ = [
    "render_edl",
    "render_project_runner",
    "register",
]
