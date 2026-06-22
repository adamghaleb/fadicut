"""Export-bake orchestration — composite a FadiEDL into one final mp4 natively.

This is the *final render* side of the browser↔native boundary (issue #4). OpenCut
edits in the browser and serializes a `FadiEDL`; this module consumes it, runs the per-
effect native bakes (reusing the existing batch baker functions — it never reimplements
the grade / lyric / ramp / strobe / overlay / morph engines), and composites everything
with ffmpeg into a single mp4 at the EDL's render width/height/fps.

Handler dispatch (issue #8)
---------------------------
Effect baking is a per-effect-type HANDLER DISPATCH, mirroring ``jobs.register_runner``:

  • a module-level registry maps ``FadiEffect.type`` → an async handler
    ``handler(clip_ctx, effect, progress) -> None``;
  • ``register_effect_handler(effect_type, handler)`` adds/overrides a handler WITHOUT
    editing this file (issues #9/#10 register their own engines against it);
  • ``register_builtin_effect_handlers()`` installs the built-ins once at startup.

A handler bakes/composites its one effect against the clip's working file
(``clip_ctx.current``) and REASSIGNS ``clip_ctx.current`` to its output, so effects chain
in declared order. The grade + lyric behavior of the original orchestrator is preserved,
ported to the ``grade`` and ``lyric`` handlers respectively.

Tightly-scoped pipeline (the realistic FadiFiles case), deliberately NOT a general
timeline:
  1. BASE layer: the `main`-role tracks' video/image elements laid in timeline order.
     Each is trimmed to its [trim_start, duration] window, scaled+padded to the render
     canvas, and placed at its `start_sec` (gaps → black).
  2. PER-CLIP EFFECTS: each main element's `effects` are dispatched in order against that
     clip — grade (recolor), ramp (speed-ramp), strobe (Fadi strobe), overlay (fadishoot
     flashes), morph (morphloop). The resulting clip replaces the source on the base.
  3. OVERLAY layer: `overlay`-role tracks' lyric elements (a `lyric` effect, engine
     meandu) are baked to a transparent ProRes .mov and composited on top of the base,
     enabled only for the element's [start, start+duration] window.
  4. AUDIO: if the EDL binds a `song_id`, the SongContext's master audio is muxed in.

Job wiring: exposes `render_project_runner(job, progress)` (lane "cpu") and a
`register(queue)` helper, mirroring `render.meandu.register`. The integrator wires it in
the app lifespan WITHOUT editing the shared queue file.

Payload: ``{"edl": <FadiEDL dict>, "out_path"?: str, "smoke_frames"?: int}``
Result:  ``{"ok", "out_path", "width", "height", "fps", "duration_sec",
            "baked": {<effect_type>: n, ...}, "engine": "orchestrator"}``
"""

from __future__ import annotations

import asyncio
import shutil
import subprocess
import sys
import tempfile
from dataclasses import dataclass, field
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
    MorphEffect,
    OverlayEffect,
    RampEffect,
    StrobeEffect,
    VideoElement,
)

from .fadi_grade import bake_grade  # noqa: E402  — reuse, do not reimplement
from .fadi_strobe import strobe_video  # noqa: E402
from .fadishoot_overlays import bake_overlay  # noqa: E402
from .meandu import SUPPORTED_SONG_IDS, bake_lyric_slice  # noqa: E402
from .morphloop import bake_morph  # noqa: E402
from .song_context_provider import load_song_context  # noqa: E402
from .speedramp import bake_ramp  # noqa: E402

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


def _resolve_media_ids(element: Any, ids: list[str]) -> list[Path]:
    """Resolve a list of MorphEffect target media ids to absolute paths.

    Each id may already be an absolute path, or be keyed in the element's
    ``params['media_paths']`` map (browser-side IndexedDB id → resolved path), which the
    native-export adapter stamps for cross-clip references like morph targets.
    """
    params = getattr(element, "params", {}) or {}
    pathmap = params.get("media_paths") or {}
    out: list[Path] = []
    for mid in ids:
        raw = pathmap.get(mid, mid)
        p = Path(str(raw)).expanduser()
        if not p.exists():
            raise FileNotFoundError(
                f"morph target {mid!r}: media not found at {p} "
                f"(set params.media_paths[{mid!r}] to an absolute path)"
            )
        out.append(p.resolve())
    return out


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


def _renormalize(src: Path, out: Path, *, width: int, height: int, fps: int) -> None:
    """Re-scale+pad a clip a handler produced back to the render canvas / fps, so it stays
    concat-compatible with its peers after a baker may have changed dims (overlay/morph)."""
    out.parent.mkdir(parents=True, exist_ok=True)
    vf = (
        f"scale={width}:{height}:force_original_aspect_ratio=decrease,"
        f"pad={width}:{height}:(ow-iw)/2:(oh-ih)/2:black,setsar=1,fps={fps},format=yuv420p"
    )
    _run([
        FFMPEG, "-y", "-loglevel", "error", "-i", str(src),
        "-vf", vf, "-an",
        "-c:v", "libx264", "-crf", "16", "-pix_fmt", "yuv420p", str(out),
    ])


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
    """Composite a transparent lyric .mov over the base, enabled only for its window."""
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


# ═════════════════════════ effect-handler dispatch ═════════════════════════

@dataclass
class ClipContext:
    """The per-clip working state a handler mutates.

    A handler reads ``current`` (the clip as baked so far), produces a new file, and
    REASSIGNS ``current`` to it. It may bump ``baked[effect.type]``. ``work`` is a unique
    temp dir; ``seq`` distinguishes parallel handler outputs within one clip.
    """

    element: Any
    current: Path
    width: int
    height: int
    fps: int
    work: Path
    edl: FadiEDL
    song_id: Optional[str]
    smoke_frames: Optional[int] = None
    seq: int = 0
    baked: dict[str, int] = field(default_factory=dict)

    def stage(self, label: str, suffix: str = ".mp4") -> Path:
        """A fresh unique output path for a handler's bake/composite step."""
        self.seq += 1
        return self.work / f"{label}_{self.seq:03d}{suffix}"

    def bumped(self, effect_type: str) -> None:
        self.baked[effect_type] = self.baked.get(effect_type, 0) + 1


# A handler bakes/composites one effect against clip_ctx.current and reassigns it.
EffectHandler = Callable[[ClipContext, Any, ProgressFn], Awaitable[None]]

_EFFECT_HANDLERS: dict[str, EffectHandler] = {}


def register_effect_handler(effect_type: str, handler: EffectHandler) -> None:
    """Register (or override) the handler for a FadiEffect.type — mirrors
    ``jobs.JobQueue.register_runner``. Later issues call this to add engines without
    editing this file. Overriding an existing type is allowed (last writer wins)."""
    _EFFECT_HANDLERS[effect_type] = handler


def get_effect_handler(effect_type: str) -> Optional[EffectHandler]:
    return _EFFECT_HANDLERS.get(effect_type)


def known_effect_types() -> list[str]:
    return sorted(_EFFECT_HANDLERS)


async def _dispatch_effect(ctx: ClipContext, effect: Any, progress: ProgressFn) -> bool:
    """Run the registered handler for `effect` against `ctx`. Returns True if handled.

    Unhandled effect types are a documented no-op (skipped) so an EDL carrying an effect
    no engine has registered yet still exports (just without that effect)."""
    handler = _EFFECT_HANDLERS.get(getattr(effect, "type", None))
    if handler is None:
        return False
    await handler(ctx, effect, progress)
    return True


# ───────────────────────── built-in handlers (sync core + async wrapper) ─────────────────────────

async def _to_thread(fn, *a, **k):
    return await asyncio.to_thread(fn, *a, **k)


async def _grade_handler(ctx: ClipContext, fx: GradeEffect, progress: ProgressFn) -> None:
    """Port of the original per-clip grade bake → handler. Recolors the clip in place."""
    await progress(0.0, "grade bake")
    out = ctx.stage("grade", ctx.current.suffix.lower() if _is_image(ctx.current) else ".mp4")
    await _to_thread(
        bake_grade, ctx.current, out,
        mode=fx.mode, fadi_color=fx.fadi_color, params=fx.params or {},
        fps=float(ctx.fps), width=ctx.width,
    )
    ctx.current = out
    ctx.bumped("grade")


async def _ramp_handler(ctx: ClipContext, fx: RampEffect, progress: ProgressFn) -> None:
    """Speed-ramp the clip via the speedramp engine, then renormalize to the canvas."""
    await progress(0.0, f"ramp ({fx.mode})")
    if _is_image(ctx.current):
        return  # ramp is meaningless on a still — documented no-op
    ramped = ctx.stage("ramp")
    await _to_thread(
        bake_ramp, ctx.current, ramped,
        mode=fx.mode,
        target_rate=fx.target_rate,
        use_rife=fx.use_rife,
        motion_blur=fx.motion_blur.model_dump() if fx.motion_blur else None,
    )
    norm = ctx.stage("ramp_norm")
    await _to_thread(_renormalize, ramped, norm, width=ctx.width, height=ctx.height, fps=ctx.fps)
    ctx.current = norm
    ctx.bumped("ramp")


async def _strobe_handler(ctx: ClipContext, fx: StrobeEffect, progress: ProgressFn) -> None:
    """Apply the Fadi strobe re-color over the clip frame-by-frame."""
    await progress(0.0, "strobe bake")
    if _is_image(ctx.current):
        return  # base prep already turned stills into clips; strobe needs frames
    strobed = ctx.stage("strobe")
    await _to_thread(
        strobe_video, ctx.current, strobed,
        palette=list(fx.palette) if fx.palette else None,
        every_n_frames=fx.every_n_frames,
        luminance_preserve=fx.luminance_preserve,
        fps=float(ctx.fps),
    )
    ctx.current = strobed
    ctx.bumped("strobe")


async def _overlay_handler(ctx: ClipContext, fx: OverlayEffect, progress: ProgressFn) -> None:
    """Composite fadishoot beat-synced flash overlays over the clip, then renormalize."""
    await progress(0.0, "overlay bake")
    if _is_image(ctx.current):
        return  # overlays detect beats from clip audio — needs a video
    over = ctx.stage("overlay")
    await _to_thread(
        bake_overlay, ctx.current, over,
        category=fx.category,
        asset_id=fx.asset_id,
        beat_sync=fx.beat_sync,
        coverage=fx.coverage,
    )
    norm = ctx.stage("overlay_norm")
    await _to_thread(_renormalize, over, norm, width=ctx.width, height=ctx.height, fps=ctx.fps)
    ctx.current = norm
    ctx.bumped("overlay")


async def _morph_handler(ctx: ClipContext, fx: MorphEffect, progress: ProgressFn) -> None:
    """Replace the clip with a morphloop built from the effect's target images.

    The morphloop engine is image-driven (4/8 images + the bound song), so this handler
    only fires when the EDL binds a `song_id` and the effect names 4 or 8 targets. It
    reuses already-rendered raw clips offline (skip_generate) by default in the export
    path; pass ``params.skip_generate=False`` to (re)generate via Seedance."""
    await progress(0.0, "morph bake")
    if not ctx.song_id or len(fx.target_media_ids) not in (4, 8):
        return  # documented no-op: morph needs a song + 4/8 image targets
    images = _resolve_media_ids(ctx.element, list(fx.target_media_ids))
    out = ctx.stage("morph")
    params = getattr(ctx.element, "params", {}) or {}
    await _to_thread(
        bake_morph,
        song=ctx.song_id,
        images=images,
        out=out,
        skip_generate=bool(params.get("morph_skip_generate", True)),
    )
    norm = ctx.stage("morph_norm")
    await _to_thread(_renormalize, out, norm, width=ctx.width, height=ctx.height, fps=ctx.fps)
    ctx.current = norm
    ctx.bumped("morph")


async def _lyric_overlay_handler(ctx: ClipContext, fx: LyricEffect, progress: ProgressFn) -> None:
    """Composite a transparent meandu lyric .mov over the clip, gated to its window.

    Used for `overlay`-role lyric elements (ported from the original lyric path). Bakes
    the lyric slice, then overlays it onto ``ctx.current`` for [start, start+duration].
    Only me&u is wired in the meandu spike (other songs → documented no-op)."""
    song_id = ctx.song_id or "me-u-1bc03491"
    if song_id not in SUPPORTED_SONG_IDS:
        return  # scope cut: only me&u lyric bakes are wired in the meandu spike
    await progress(0.0, "lyric bake")
    el = ctx.element
    ov_mov = ctx.stage("lyric", ".mov")
    await _to_thread(
        bake_lyric_slice,
        song_id=song_id,
        start_sec=getattr(el, "trim_start_sec", 0.0) + 0.0,
        duration_sec=el.duration_sec,
        out_path=ov_mov,
        smoke_frames=ctx.smoke_frames,
    )
    composited = ctx.stage("lyric_composite")
    await _to_thread(
        _overlay_lyric,
        ctx.current, ov_mov, composited,
        width=ctx.width, height=ctx.height,
        start_sec=el.start_sec, duration_sec=el.duration_sec,
    )
    ctx.current = composited
    ctx.bumped("lyric")


def register_builtin_effect_handlers() -> None:
    """Install the built-in effect handlers (grade, ramp, strobe, overlay, morph, lyric).

    Idempotent — re-registering overwrites with the same handlers. The integrator calls
    this once at startup; issues #9/#10 may call ``register_effect_handler`` afterward to
    add (or override) handlers (micrographics, blob_track, etc.) without editing this file.
    """
    register_effect_handler("grade", _grade_handler)
    register_effect_handler("ramp", _ramp_handler)
    register_effect_handler("strobe", _strobe_handler)
    register_effect_handler("overlay", _overlay_handler)
    register_effect_handler("morph", _morph_handler)
    register_effect_handler("lyric", _lyric_overlay_handler)


# Install built-ins on import so a bare `render_edl` call (tests / CLI) works without the
# integrator's startup hook. The integrator may still call it again (idempotent).
register_builtin_effect_handlers()


# ───────────────────────── the orchestration core ─────────────────────────

async def render_edl_async(
    edl: FadiEDL,
    *,
    out_path: Optional[str | Path] = None,
    smoke_frames: Optional[int] = None,
    on_progress: Optional[ProgressFn] = None,
) -> dict[str, Any]:
    """Composite a FadiEDL into one mp4. Async core (runs effect handlers concurrently
    with the event loop). `on_progress(frac, msg)` is an async callable.
    """
    async def emit(frac: float, msg: str) -> None:
        if on_progress:
            await on_progress(frac, msg)

    w, h, fps = edl.render.width, edl.render.height, edl.render.fps

    work = Path(tempfile.mkdtemp(prefix="fadi_orchestrate_"))
    baked: dict[str, int] = {}
    song_id = edl.song_id

    if out_path is None:
        out_path = work / "fadicut_final.mp4"
    out_final = Path(out_path).expanduser()
    out_final.parent.mkdir(parents=True, exist_ok=True)

    # ── 1. gather + order the base (main-role) elements ──────────────────────
    main_elements: list[Any] = []
    for track in edl.tracks:
        if track.hidden or track.role != "main":
            continue
        for el in track.elements:
            if isinstance(el, (VideoElement, ImageElement)):
                main_elements.append(el)
    main_elements.sort(key=lambda e: e.start_sec)

    if not main_elements:
        raise ValueError("orchestrator MVP needs at least one main-track video/image element")

    await emit(0.05, f"preparing {len(main_elements)} base segment(s)")

    # ── 2. base segment prep + per-clip effect dispatch ──────────────────────
    segments: list[Path] = []
    cursor = 0.0
    seg_idx = 0
    n = len(main_elements)
    for i, el in enumerate(main_elements):
        # fill a gap before this element with black
        if el.start_sec - cursor > 0.05:
            gap = work / f"gap_{seg_idx:03d}.mp4"
            _black_segment(gap, width=w, height=h, fps=fps, duration_sec=el.start_sec - cursor)
            segments.append(gap)
            seg_idx += 1

        src = _resolve_media_path(el)

        seg = work / f"seg_{seg_idx:03d}.mp4"
        _prep_base_segment(
            src, seg,
            width=w, height=h, fps=fps,
            trim_start_sec=getattr(el, "trim_start_sec", 0.0),
            duration_sec=el.duration_sec,
        )

        # dispatch this element's effects (in declared order) against the prepped clip.
        ctx = ClipContext(
            element=el, current=seg, width=w, height=h, fps=fps,
            work=work / f"clip_{i:03d}", edl=edl, song_id=song_id,
            smoke_frames=smoke_frames,
        )
        ctx.work.mkdir(parents=True, exist_ok=True)
        effects = getattr(el, "effects", []) or []
        for j, fx in enumerate(effects):
            base_frac = 0.05 + 0.55 * ((i + j / max(1, len(effects))) / n)

            async def clip_progress(frac: float, msg: str, _bf=base_frac) -> None:
                await emit(min(0.6, _bf), f"clip {i + 1}/{n}: {msg}")

            await _dispatch_effect(ctx, fx, clip_progress)

        for k, v in ctx.baked.items():
            baked[k] = baked.get(k, 0) + v
        segments.append(ctx.current)
        seg_idx += 1
        cursor = el.start_sec + el.duration_sec

    await emit(0.62, "concatenating base layer")
    base = work / "base.mp4"
    if len(segments) == 1:
        shutil.copy2(segments[0], base)
    else:
        _concat(segments, base, work)

    # ── 3. overlay-role lyric tracks ─────────────────────────────────────────
    lyric_jobs: list[tuple[Any, LyricEffect]] = []
    for track in edl.tracks:
        if track.hidden or track.role != "overlay":
            continue
        for el in track.elements:
            for fx in getattr(el, "effects", []) or []:
                if isinstance(fx, LyricEffect):
                    lyric_jobs.append((el, fx))
                    break

    composited = base
    for j, (el, lyr) in enumerate(lyric_jobs):
        await emit(0.7 + 0.18 * (j / max(1, len(lyric_jobs))), f"lyric overlay {j + 1}/{len(lyric_jobs)}")
        ctx = ClipContext(
            element=el, current=composited, width=w, height=h, fps=fps,
            work=work / f"lyric_{j:03d}", edl=edl, song_id=song_id,
            smoke_frames=smoke_frames,
        )
        ctx.work.mkdir(parents=True, exist_ok=True)

        async def lyric_progress(frac: float, msg: str) -> None:
            await emit(0.7, msg)

        await _lyric_overlay_handler(ctx, lyr, lyric_progress)
        composited = ctx.current
        for k, v in ctx.baked.items():
            baked[k] = baked.get(k, 0) + v

    # ── 4. mux song audio if bound ───────────────────────────────────────────
    await emit(0.9, "muxing audio + finalizing")
    audio_path = _resolve_song_audio(song_id)
    if audio_path is not None:
        _mux_audio(composited, audio_path, out_final)
    else:
        shutil.copy2(composited, out_final)

    dur = _probe_duration(out_final)
    await emit(1.0, "done")
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


def _resolve_song_audio(song_id: Optional[str]) -> Optional[Path]:
    if not song_id:
        return None
    try:
        ctx = load_song_context(song_id)
        master = ctx.audio.master_path
    except (KeyError, OSError):
        return None
    if not master:
        return None
    cand = Path(master).expanduser()
    if cand.is_file():
        return cand
    if cand.is_dir():
        for ext in ("*.wav", "*.mp3", "*.m4a", "*.aac", "*.flac"):
            hits = sorted(cand.glob(ext))
            if hits:
                return hits[0]
    return None


def _probe_duration(path: Path) -> float:
    try:
        return float(_run([
            FFPROBE, "-v", "error", "-show_entries", "format=duration",
            "-of", "default=nw=1:nk=1", str(path),
        ]).strip() or 0.0)
    except (RuntimeError, ValueError):
        return 0.0


def render_edl(
    edl: FadiEDL,
    *,
    out_path: Optional[str | Path] = None,
    smoke_frames: Optional[int] = None,
    on_progress: Optional[Callable[[float, str], None]] = None,
) -> dict[str, Any]:
    """Synchronous convenience wrapper around `render_edl_async` for tests / CLI.

    `on_progress(frac, msg)` is a plain (sync) callable; it's adapted to the async core.
    Must NOT be called from inside a running event loop (use `render_edl_async` there).
    """
    async def _async_progress(frac: float, msg: str) -> None:
        if on_progress:
            on_progress(frac, msg)

    return asyncio.run(
        render_edl_async(
            edl,
            out_path=out_path,
            smoke_frames=smoke_frames,
            on_progress=_async_progress if on_progress else None,
        )
    )


# ───────────────────────── job-queue runner (async wrapper) ─────────────────────────

async def render_project_runner(job: Any, progress: ProgressFn) -> dict[str, Any]:
    """Async runner conforming to the Bridge queue's Runner signature (lane "cpu").

    Validates the payload EDL against the frozen contract, then runs the async composite
    core directly (effect handlers offload their own blocking bakes via to_thread, so the
    event loop / SSE fan-out stays responsive).
    """
    p = job.payload or {}
    raw_edl = p.get("edl")
    if not raw_edl:
        raise ValueError("payload.edl is required (a FadiEDL object)")

    edl = FadiEDL.model_validate(raw_edl)
    out_path = p.get("out_path")
    smoke_frames = p.get("smoke_frames")

    return await render_edl_async(
        edl,
        out_path=out_path,
        smoke_frames=smoke_frames,
        on_progress=progress,
    )


def register(queue, kind: str = "render_project") -> None:
    """Register the orchestrator on the shared queue without editing queue.py.

    Also installs the built-in effect handlers so an export job can dispatch every
    supported effect. Usage in the integrator (app lifespan):
        from jobs import get_queue
        from render import orchestrator
        orchestrator.register(get_queue())
    """
    register_builtin_effect_handlers()
    queue.register_runner(kind, render_project_runner)


__all__ = [
    "ClipContext",
    "EffectHandler",
    "register_effect_handler",
    "get_effect_handler",
    "known_effect_types",
    "register_builtin_effect_handlers",
    "render_edl",
    "render_edl_async",
    "render_project_runner",
    "register",
]
