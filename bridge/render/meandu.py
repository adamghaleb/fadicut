"""meandu — the `lyric` effect's native authoritative baker (Batch B spike).

Contract role
-------------
`LyricEffect.engine == "meandu"` (contracts/fadi_edl.py). When the Bridge sees a
lyric effect on a text/graphic element, it bakes the *real* lyric render natively
by shelling out to the meandu lyric engine — never ffmpeg.wasm in the browser.

What this adapter does (and deliberately does NOT)
--------------------------------------------------
We WRAP the existing engine, we do not reimplement it. The engine
(`lyric-video-engine/engine/meandu_lyric_v16.py`) is a thin, argv-driven shim that
delegates to `lyric_engine.tracks.meandu.main(out_path)`. Its only public surface is
"render the full me&u song to an mp4 path." So this adapter:

  1. Resolves the engine + its single documented entrypoint.
  2. Renders the full song once to a temp mp4 (opaque PAPER #fcfaf7 background —
     the engine flattens RGBA→RGB before muxing, so there is no transparent path
     inside it).
  3. Slices the EDL lyric element's [start_sec, end_sec] window and color-keys the
     PAPER background to alpha, encoding a **transparent ProRes 4444 .mov** — the
     deliverable the FadiEDL → native bake boundary expects for a lyric overlay.

The slice + key step is the "edge conversion": the engine speaks full-song-mp4, the
contract speaks per-element transparent overlay; we translate between them with
ffmpeg here so neither side leaks into the other.

Job wiring
----------
Exposes `meandu_lyric_runner(job, progress)` and a `register(queue)` helper so the
integrator can `queue.register_runner("render_lyric", meandu_lyric_runner)` (or call
`bridge.render.meandu.register(get_queue())`) WITHOUT editing the shared queue file.
Lane: "cpu" (PIL/HarfBuzz compositing — not the GPU lane).

Payload (a JSON-shaped slice of a FadiEDL element carrying a LyricEffect):
    {
      "song_id": "me-u-1bc03491",            # currently only me&u is wired
      "start_sec": 20.56,                      # element.start_sec on the timeline
      "duration_sec": 13.72,                   # element.duration_sec
      "fill_mode": "tri_zone",                 # LyricEffect.fill_mode (passthrough hint)
      "out_path": "/abs/out.mov",              # optional; temp if omitted
      "engine_root": "/abs/lyric-video-engine" # optional override
    }

Result dict: {"ok", "out_path", "width", "height", "fps", "start_sec",
              "duration_sec", "engine", "transparent": true}
"""

from __future__ import annotations

import asyncio
import os
import shutil
import subprocess
import tempfile
from pathlib import Path
from typing import Any, Optional

# ── engine resolution ───────────────────────────────────────────────────────────
# Default install location of the meandu lyric engine. Overridable per-job
# ("engine_root") or by env (FADI_MEANDU_ENGINE_ROOT) so this is not hard-pinned.
DEFAULT_ENGINE_ROOT = Path.home() / "Documents/windsurf projects/lyric-video-engine"
ENGINE_ENTRYPOINT = "engine/meandu_lyric_v16.py"  # the documented argv shim

# The engine flattens onto this paper color before muxing (lyric_engine/core/palette.py
# PAPER = (252, 250, 247) == #fcfaf7). We key exactly this to alpha.
PAPER_HEX = "0xfcfaf7"

# Prefer the drawtext-capable ffmpeg on this Mac; fall back to PATH.
FFMPEG = next(
    (p for p in ("/opt/homebrew/Cellar/ffmpeg-full/8.1_1/bin/ffmpeg",) if Path(p).exists()),
    shutil.which("ffmpeg") or "ffmpeg",
)

# Songs this spike can render. me&u is the vertical-slice target; the engine itself
# is currently single-track (its entrypoint hard-codes the me&u source).
SUPPORTED_SONG_IDS = {"me-u-1bc03491", "me-and-u", "meandu", "me&u"}


def _resolve_engine_root(payload: dict[str, Any]) -> Path:
    raw = (
        payload.get("engine_root")
        or os.environ.get("FADI_MEANDU_ENGINE_ROOT")
        or str(DEFAULT_ENGINE_ROOT)
    )
    root = Path(raw).expanduser()
    if not (root / ENGINE_ENTRYPOINT).exists():
        raise FileNotFoundError(
            f"meandu engine entrypoint not found: {root / ENGINE_ENTRYPOINT}"
        )
    return root


def _run(cmd: list[str], *, cwd: Optional[Path] = None) -> None:
    """Run a subprocess, surfacing stderr on failure (so the job error is useful)."""
    proc = subprocess.run(
        cmd,
        cwd=str(cwd) if cwd else None,
        capture_output=True,
        text=True,
    )
    if proc.returncode != 0:
        tail = (proc.stderr or proc.stdout or "").strip()[-1500:]
        raise RuntimeError(f"command failed ({proc.returncode}): {cmd[0]} ...\n{tail}")


# Persistent cache for rendered me&u mp4s. The engine's *startup* (library preload) is a
# fixed multi-minute cost independent of frame count, so a cold render can't fit a short
# poll window. We render once per (song, smoke_frames) and reuse the mp4 for every later
# slice — turning subsequent lyric bakes into a sub-second ffmpeg trim+key.
_CACHE_DIR = Path(tempfile.gettempdir()) / "fadi_meandu_cache"


def _cache_path(song_id: str, smoke_frames: Optional[int]) -> Path:
    tag = f"smoke{int(smoke_frames)}" if smoke_frames else "full"
    safe = "".join(c if c.isalnum() else "-" for c in song_id)
    return _CACHE_DIR / f"{safe}__{tag}.mp4"


def _render_full_song(engine_root: Path, mp4_out: Path, *, smoke_frames: Optional[int]) -> None:
    """Drive the engine's argv entrypoint to render the full song to mp4_out.

    smoke_frames (V8_SMOKE) renders only the first N frames — used for fast spike
    runs / CI so we don't wait on a multi-minute full render.
    """
    env = dict(os.environ)
    # Ensure the drawtext ffmpeg is first on PATH for the engine's own mux call.
    ff_dir = str(Path(FFMPEG).parent)
    env["PATH"] = f"{ff_dir}:{env.get('PATH', '')}"
    if smoke_frames:
        env["V8_SMOKE"] = str(int(smoke_frames))
    cmd = ["python3", ENGINE_ENTRYPOINT, str(mp4_out)]
    proc = subprocess.run(
        cmd, cwd=str(engine_root), env=env, capture_output=True, text=True
    )
    if proc.returncode != 0:
        tail = (proc.stderr or proc.stdout or "").strip()[-2000:]
        raise RuntimeError(f"meandu engine render failed ({proc.returncode}):\n{tail}")


def _render_full_song_cached(
    engine_root: Path, mp4_out: Path, *, song_id: str, smoke_frames: Optional[int]
) -> None:
    """Render via cache: reuse a previously-rendered mp4 for (song_id, smoke_frames) if it
    exists; otherwise render once and stash it. Copies the cached mp4 to ``mp4_out``."""
    cache = _cache_path(song_id, smoke_frames)
    if cache.exists() and cache.stat().st_size > 0:
        shutil.copy2(cache, mp4_out)
        return
    _render_full_song(engine_root, mp4_out, smoke_frames=smoke_frames)
    try:
        cache.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(mp4_out, cache)
    except OSError:
        pass  # caching is best-effort


def _slice_and_key_to_transparent_mov(
    src_mp4: Path,
    out_mov: Path,
    *,
    start_sec: float,
    duration_sec: float,
) -> None:
    """Trim [start_sec, start_sec+duration_sec] and color-key PAPER → alpha,
    encoding transparent ProRes 4444 .mov."""
    out_mov.parent.mkdir(parents=True, exist_ok=True)
    # colorkey similarity/blend tuned to lift the flat paper background while
    # preserving anti-aliased letter edges.
    vf = f"colorkey={PAPER_HEX}:0.18:0.04,format=yuva444p10le"
    cmd = [
        FFMPEG, "-y", "-loglevel", "error",
        "-ss", f"{max(0.0, float(start_sec)):.3f}",
        "-t", f"{max(0.01, float(duration_sec)):.3f}",
        "-i", str(src_mp4),
        "-an",
        "-vf", vf,
        "-c:v", "prores_ks", "-profile:v", "4444", "-pix_fmt", "yuva444p10le",
        str(out_mov),
    ]
    _run(cmd)


def bake_lyric_slice(
    *,
    song_id: str,
    start_sec: float,
    duration_sec: float,
    out_path: Optional[str | Path] = None,
    engine_root: Optional[str | Path] = None,
    smoke_frames: Optional[int] = None,
    on_progress=None,
) -> dict[str, Any]:
    """Synchronous core: render → slice+key → transparent lyric .mov.

    `on_progress(frac, msg)` is an optional plain callable (the async job runner
    wraps it). Returns the result dict described in the module docstring.
    """
    if song_id not in SUPPORTED_SONG_IDS:
        raise ValueError(
            f"meandu spike only renders me&u; got song_id={song_id!r}. "
            f"Supported: {sorted(SUPPORTED_SONG_IDS)}"
        )

    payload_root = {"engine_root": str(engine_root)} if engine_root else {}
    root = _resolve_engine_root(payload_root)

    def emit(frac: float, msg: str) -> None:
        if on_progress:
            on_progress(frac, msg)

    tmpdir = Path(tempfile.mkdtemp(prefix="meandu_bake_"))
    src_mp4 = tmpdir / "meandu_full.mp4"

    if out_path is None:
        out_path = tmpdir / "meandu_lyric_slice.mov"
    out_mov = Path(out_path).expanduser()

    emit(0.05, "rendering meandu lyric engine ...")
    _render_full_song_cached(root, src_mp4, song_id=song_id, smoke_frames=smoke_frames)

    emit(0.85, "slicing + keying to transparent .mov ...")
    _slice_and_key_to_transparent_mov(
        src_mp4, out_mov, start_sec=start_sec, duration_sec=duration_sec
    )

    emit(1.0, "done")
    return {
        "ok": True,
        "out_path": str(out_mov),
        "width": 1920,
        "height": 1080,
        "fps": 30,
        "start_sec": float(start_sec),
        "duration_sec": float(duration_sec),
        "engine": "meandu",
        "transparent": True,
    }


# ── job-queue runner (async wrapper) ─────────────────────────────────────────────

async def meandu_lyric_runner(job, progress) -> dict[str, Any]:
    """Async runner conforming to the Bridge queue's Runner signature.

    Offloads the blocking render to a thread so the event loop (and SSE fan-out)
    stays responsive; bridges thread-side progress back via run_coroutine_threadsafe.
    """
    p = job.payload or {}
    song_id = p.get("song_id", "me-u-1bc03491")
    start_sec = float(p.get("start_sec", 0.0))
    duration_sec = float(p.get("duration_sec", 0.0))
    if duration_sec <= 0:
        raise ValueError("payload.duration_sec must be > 0")
    out_path = p.get("out_path")
    engine_root = p.get("engine_root")
    smoke_frames = p.get("smoke_frames")

    loop = asyncio.get_running_loop()

    def threaded_progress(frac: float, msg: str) -> None:
        # progress() is a coroutine on the queue; schedule it on the loop.
        asyncio.run_coroutine_threadsafe(progress(frac, msg), loop)

    return await asyncio.to_thread(
        bake_lyric_slice,
        song_id=song_id,
        start_sec=start_sec,
        duration_sec=duration_sec,
        out_path=out_path,
        engine_root=engine_root,
        smoke_frames=smoke_frames,
        on_progress=threaded_progress,
    )


def register(queue, kind: str = "render_lyric") -> None:
    """Register this engine on the shared queue without editing queue.py.

    Usage in the integrator (e.g. app lifespan):
        from jobs import get_queue
        from bridge.render import meandu
        meandu.register(get_queue())
    """
    queue.register_runner(kind, meandu_lyric_runner)


__all__ = [
    "bake_lyric_slice",
    "meandu_lyric_runner",
    "register",
    "SUPPORTED_SONG_IDS",
]
