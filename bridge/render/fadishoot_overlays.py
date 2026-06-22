"""Native fadishoot-overlays baker — the authoritative side of the `overlay` FadiEffect.

`OverlayEffect.engine == "fadishoot_overlays"` (contracts/fadi_edl.py). The fadishoot
overlay kit scatters sharp Fadi-color flash graphics (color bars, splits, checker,
glitch, halftone, brand sparkles, the 333 logo — 22 elements) onto the song's beat grid
and composites them over a performance clip.

This module WRAPS Adam's existing engine
``~/.claude/skills/fadishoot-overlays/scripts/overlay_shoot.py`` (do NOT reimplement the
beat detection / Remotion overlay pass). That engine speaks "take a VIDEO, detect beats
from its own audio, render a transparent overlay pass, composite → mp4". We translate the
contract's `OverlayEffect` knobs (category, beat_sync, coverage, asset_id) into its CLI
flags, run it as a subprocess, and return the composited clip.

Because the engine derives beats from the *clip's own audio*, the orchestrator passes it
a clip that still carries audio when available; the export's master-audio mux happens
later, downstream of this bake.

Engine name: ``fadishoot_overlays`` (the queue runner kind is ``render_overlay``).
"""

from __future__ import annotations

import asyncio
import os
import shutil
import subprocess
from pathlib import Path
from typing import Any, Awaitable, Callable, Optional

OVERLAY_SCRIPT = Path(
    os.path.expanduser("~/.claude/skills/fadishoot-overlays/scripts/overlay_shoot.py")
)

ProgressFn = Callable[[float, str], Awaitable[None]]

# category → element-id substring(s) the engine's manifest understands. The engine takes
# --include <ids>; we map the coarse contract `category` onto a starter set of ids. An
# explicit asset_id (when set) always wins.
CATEGORY_INCLUDE: dict[str, str] = {
    "color_bars": "color-bars,bars,vertical-bars",
    "split": "split,half-split,diagonal-split",
    "thirds": "thirds,third-band",
    "bands": "band,bands",
    "checker": "checker,checkerboard",
    "glitch": "glitch,glitch-flash",
    "halftone": "halftone,dots",
    "sparkles": "sparkle,sparkles,brand-sparkles",
    "333_logo": "logo-333,333,logo",
}


def _build_cmd(
    src: Path,
    out: Path,
    *,
    category: Optional[str],
    asset_id: Optional[str],
    beat_sync: bool,
    coverage: str,
    density: float,
    seed: int,
    segment: str,
    keep_pass: bool,
) -> list[str]:
    cmd: list[str] = [
        "python3", str(OVERLAY_SCRIPT), str(src),
        "--out", str(out),
        "--segment", segment,
        "--density", f"{float(density):.3f}",
        "--seed", str(int(seed)),
        # beat_sync True → hit on downbeats (musical), False → dense beat grid.
        "--trigger", "downbeat" if beat_sync else "beat",
    ]
    include = None
    if asset_id:
        include = asset_id
    elif category:
        include = CATEGORY_INCLUDE.get(category, category)
    if include:
        cmd += ["--include", include]
    if keep_pass:
        cmd += ["--keep-pass"]
    return cmd


def bake_overlay(
    src: Path,
    out: Path,
    *,
    category: Optional[str] = None,
    asset_id: Optional[str] = None,
    beat_sync: bool = True,
    coverage: str = "partial",
    density: Optional[float] = None,
    seed: int = 7,
    segment: str = "full",
    keep_pass: bool = False,
) -> Path:
    """Run the native fadishoot-overlays engine over `src`. Returns `out`.

    `coverage` ("full"/"partial") nudges the default flash density when `density` is
    unset (full → denser hits). Raises RuntimeError with engine stderr on failure.
    """
    if not OVERLAY_SCRIPT.exists():
        raise RuntimeError(f"fadishoot-overlays engine not found at {OVERLAY_SCRIPT}")
    src = Path(src).expanduser().resolve()
    out = Path(out).expanduser().resolve()
    out.parent.mkdir(parents=True, exist_ok=True)

    if density is None:
        density = 0.9 if coverage == "full" else 0.6

    cmd = _build_cmd(
        src, out,
        category=category, asset_id=asset_id, beat_sync=beat_sync,
        coverage=coverage, density=density, seed=seed,
        segment=segment, keep_pass=keep_pass,
    )
    proc = subprocess.run(cmd, capture_output=True, text=True)
    if proc.returncode != 0:
        raise RuntimeError(
            f"fadishoot-overlays failed (exit {proc.returncode}):\n"
            f"{proc.stderr or proc.stdout}"
        )
    if not out.exists():
        raise RuntimeError(
            f"fadishoot-overlays finished but no output at {out}\n{proc.stdout}"
        )
    return out


# ───────────────────────── queue runner (engine = fadishoot_overlays) ─────────────────────────

async def overlay_runner(job: Any, progress: ProgressFn) -> dict:
    """Job runner for `render_overlay` (lane "cpu" — Remotion + ffmpeg composite).

    Payload (mirrors OverlayEffect + IO):
      src:       str
      out:       str | None
      category:  str | None     ("color_bars", "checker", "333_logo", ...)
      asset_id:  str | None     (explicit element id; overrides category)
      beat_sync: bool (default True)
      coverage:  "full" | "partial" (default "partial")
      density:   float | None
      seed:      int (default 7)
      segment:   "full" | "auto" | "START-END" (default "full")
      keep_pass: bool (default False)
    """
    p = job.payload or {}
    src = Path(p["src"]).expanduser()
    out = p.get("out")
    if not out:
        out = src.with_name(src.stem + "__overlay.mp4")
    out = Path(out).expanduser()

    await progress(0.05, "overlay: detecting beats + rendering pass")
    loop = asyncio.get_running_loop()
    stop = asyncio.Event()

    async def _heartbeat() -> None:
        frac = 0.05
        while not stop.is_set():
            await asyncio.sleep(2.0)
            frac = min(0.92, frac + 0.04)
            await progress(frac, "overlay: working")

    hb = asyncio.create_task(_heartbeat())
    try:
        result = await loop.run_in_executor(
            None,
            lambda: bake_overlay(
                src, out,
                category=p.get("category"),
                asset_id=p.get("asset_id"),
                beat_sync=bool(p.get("beat_sync", True)),
                coverage=str(p.get("coverage", "partial")),
                density=p.get("density"),
                seed=int(p.get("seed", 7)),
                segment=str(p.get("segment", "full")),
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

    await progress(1.0, "overlay done")
    return {"ok": True, "engine": "fadishoot_overlays", "output": str(result)}


def register(queue, kind: str = "render_overlay") -> None:
    """Register the overlay engine on the shared queue without editing queue.py."""
    queue.register_runner(kind, overlay_runner)


__all__ = [
    "bake_overlay",
    "overlay_runner",
    "register",
    "CATEGORY_INCLUDE",
]
