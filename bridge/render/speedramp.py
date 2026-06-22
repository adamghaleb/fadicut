"""Native speed-ramp baker — the authoritative side of the `ramp` FadiEffect.

This is a thin WRAPPER around Adam's existing engine
``~/.claude/skills/speedramp/scripts/speedramp.py`` (do NOT reimplement the ramp math).
That engine already does the full pro technique on the signature bezier
(0.765, 0, 0.106, 1):

  • ease INTO terminal velocity over a few output frames,
  • cut ONE frame before terminal (the signature trick),
  • sell it with SPEED-PROPORTIONAL MOTION BLUR (RSMB-style smear), and
  • RIFE (M2 GPU, ~/tools/rife) for true sub-frame interpolation on the slow spans.

Modes (mirror contracts.fadi_edl.RampEffect.mode):
  whoosh | up | down | transit   (the engine also has `slowmo`; exposed too).

Engine name: ``speedramp`` (the queue runner kind is ``render_ramp``).

We translate the contract's `RampEffect` params (curve, target_rate, use_rife,
motion_blur) into the engine's CLI flags, run it as a subprocess, and surface its
stderr/stdout on failure. Progress is coarse (subprocess is opaque) — we emit a small
heartbeat while it runs and 1.0 on completion.
"""

from __future__ import annotations

import asyncio
import os
import subprocess
import sys
from pathlib import Path
from typing import Any, Awaitable, Callable, Optional

SPEEDRAMP_SCRIPT = Path(
    os.path.expanduser("~/.claude/skills/speedramp/scripts/speedramp.py")
)
RIFE_BIN = Path(os.path.expanduser("~/tools/rife/rife-ncnn-vulkan"))

# The contract's signature bezier — informational; the engine hard-codes the same curve.
SIG_CURVE = (0.765, 0.0, 0.106, 1.0)


# ───────────────────────── CLI translation ─────────────────────────

def _build_cmd(
    clips: list[Path],
    out: Path,
    *,
    mode: str,
    target_rate: Optional[float],
    use_rife: bool,
    motion_blur: Optional[dict],
    window: Optional[str] = None,
    at: Optional[float] = None,
    span: Optional[float] = None,
    ramp_frames: Optional[int] = None,
    a_ramp: Optional[float] = None,
    b_ramp: Optional[float] = None,
    width: Optional[int] = None,
    fps: Optional[float] = None,
) -> list[str]:
    """Translate a RampEffect (+ IO knobs) into a speedramp.py argv."""
    cmd: list[str] = [sys.executable, str(SPEEDRAMP_SCRIPT)]
    cmd += [str(c) for c in clips]
    cmd += ["--mode", mode, "--out", str(out)]

    # target_rate (peak multiplier) → engine's terminal velocity (percent).
    if target_rate is not None:
        cmd += ["--terminal", str(max(100.0, float(target_rate) * 100.0))]

    if not use_rife:
        cmd += ["--no-rife"]

    # motion_blur.intensity → engine --blur (0=off). The engine derives the
    # per-frame averaged-frame count from speed*blur, capped by --max-blur-frames
    # (we map MotionBlur.samples onto that cap).
    mb = motion_blur or {}
    if mb:
        intensity = mb.get("intensity")
        if intensity is not None:
            cmd += ["--blur", str(float(intensity) * (1.0 / 1.75) * 0.6)]
        samples = mb.get("samples")
        if samples is not None:
            cmd += ["--max-blur-frames", str(int(samples))]

    # window targeting (single-clip modes)
    if window:
        cmd += ["--window", window]
    elif at is not None:
        cmd += ["--at", str(at)]
        if span is not None:
            cmd += ["--span", str(span)]
    elif span is not None:
        cmd += ["--span", str(span)]

    if ramp_frames is not None:
        cmd += ["--ramp-frames", str(int(ramp_frames))]

    # transit windows
    if a_ramp is not None:
        cmd += ["--a-ramp", str(a_ramp)]
    if b_ramp is not None:
        cmd += ["--b-ramp", str(b_ramp)]

    if width:
        cmd += ["--width", str(int(width))]
    if fps:
        cmd += ["--fps", str(float(fps))]

    return cmd


# ───────────────────────── public bake API ─────────────────────────

def bake_ramp(
    clips: list[Path] | Path,
    out: Path,
    *,
    mode: str = "whoosh",
    target_rate: Optional[float] = None,
    use_rife: bool = True,
    motion_blur: Optional[dict] = None,
    **window_kwargs: Any,
) -> Path:
    """Run the native speed-ramp engine synchronously. Returns `out`.

    `clips` is one path (whoosh/up/down/slowmo) or two (transit). Extra keyword args
    (window, at, span, ramp_frames, a_ramp, b_ramp, width, fps) target the ramp window.
    Raises RuntimeError with engine stderr on non-zero exit.
    """
    if not SPEEDRAMP_SCRIPT.exists():
        raise RuntimeError(f"speedramp engine not found at {SPEEDRAMP_SCRIPT}")

    paths = [clips] if isinstance(clips, (str, Path)) else list(clips)
    paths = [Path(p).expanduser().resolve() for p in paths]
    out = Path(out).expanduser().resolve()
    out.parent.mkdir(parents=True, exist_ok=True)

    if mode == "transit" and len(paths) < 2:
        raise RuntimeError("transit mode needs two clips")

    cmd = _build_cmd(
        paths, out, mode=mode, target_rate=target_rate, use_rife=use_rife,
        motion_blur=motion_blur, **window_kwargs,
    )
    proc = subprocess.run(cmd, capture_output=True, text=True)
    if proc.returncode != 0:
        raise RuntimeError(
            f"speedramp failed (exit {proc.returncode}):\n{proc.stderr or proc.stdout}"
        )
    if not out.exists():
        raise RuntimeError(f"speedramp finished but no output at {out}\n{proc.stdout}")
    return out


# ───────────────────────── queue runner (engine = speedramp) ─────────────────────────

ProgressFn = Callable[[float, str], Awaitable[None]]


async def ramp_runner(job: Any, progress: ProgressFn) -> dict:
    """Job runner for `render_ramp`. Register on the GPU lane (RIFE serializes on M2).

    Payload (mirrors RampEffect + IO):
      src / clips:  str | list[str]  — one clip, or two for transit
      out:          str
      mode:         str   — whoosh | up | down | transit | slowmo
      target_rate:  float|None        (RampEffect.target_rate, peak multiplier)
      use_rife:     bool  (default True)
      motion_blur:  dict  {shutter_deg, samples, intensity}
      window/at/span/ramp_frames/a_ramp/b_ramp/width/fps — ramp window targeting
    """
    p = job.payload
    clips = p.get("clips")
    if clips is None:
        clips = p["src"]
    out = p.get("out")
    if not out:
        first = Path(clips[0] if isinstance(clips, list) else clips).expanduser()
        out = first.with_name(first.stem + "__ramp.mp4")

    mode = p.get("mode", "whoosh")
    window_kwargs = {
        k: p[k] for k in
        ("window", "at", "span", "ramp_frames", "a_ramp", "b_ramp", "width", "fps")
        if k in p and p[k] is not None
    }

    await progress(0.05, f"ramp: {mode} (RIFE {'on' if p.get('use_rife', True) else 'off'})")
    loop = asyncio.get_running_loop()

    # Heartbeat: nudge progress while the opaque subprocess runs.
    stop = asyncio.Event()

    async def _heartbeat() -> None:
        frac = 0.05
        while not stop.is_set():
            await asyncio.sleep(2.0)
            frac = min(0.92, frac + 0.04)
            await progress(frac, f"ramp: {mode} working")

    hb = asyncio.create_task(_heartbeat())
    try:
        result = await loop.run_in_executor(
            None,
            lambda: bake_ramp(
                clips, out, mode=mode,
                target_rate=p.get("target_rate"),
                use_rife=bool(p.get("use_rife", True)),
                motion_blur=p.get("motion_blur"),
                **window_kwargs,
            ),
        )
    finally:
        stop.set()
        hb.cancel()
        try:
            await hb
        except asyncio.CancelledError:
            pass

    await progress(1.0, "ramp done")
    return {"ok": True, "engine": "speedramp", "mode": mode, "output": str(result)}
