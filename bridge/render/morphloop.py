"""Native morphloop baker — the authoritative side of the `morph` FadiEffect.

`MorphEffect.engine == "morphloop"` (contracts/fadi_edl.py). The morphloop turns 4 (or 8)
images + a song into a beat-synced weirdcore morph-loop: AI image-to-video morphs
A→B→C→D→A cut on the song's downbeats, a Fadi-color hue-cycle treatment, word-by-word
hook lyrics, 16mm grain.

This module WRAPS Adam's existing engine ``~/.claude/skills/fadi-morphloop/scripts``
(do NOT reimplement the morph/treat math). The one-shot driver is ``make.py``:

    make.py "<song>" img1 .. imgN [--variant bw_lyrics] [--grain N]
            [--bars N] [--section Chorus] [--skip-generate]

which chains song_data → generate (Seedance) → build (beat-sync) → treat (final). The
``--skip-generate`` flag reuses already-rendered raw clips in the work dir — the only
path that does NOT hit the network — so an export of a clip whose morph clips already
exist is reproducible offline.

The engine writes its finals to
``~/Pictures/adam fadi/songs/fadifiles/ai lore/higgsfield/<slug>-loop/final/``. We locate
the produced final mp4 (the requested `--variant`, then the `_raw` / `_natural` base
passes) and return it.

Engine name: ``morphloop`` (the queue runner kind is ``render_morph``).
"""

from __future__ import annotations

import asyncio
import os
import re
import subprocess
from pathlib import Path
from typing import Any, Awaitable, Callable, Optional

MORPH_DIR = Path(os.path.expanduser("~/.claude/skills/fadi-morphloop/scripts"))
MAKE_SCRIPT = MORPH_DIR / "make.py"

# Where the engine writes its work dirs (mirrors song_data.py).
HIGGSFIELD_ROOT = Path(
    os.path.expanduser(
        "~/Pictures/adam fadi/songs/fadifiles/ai lore/higgsfield"
    )
)

ProgressFn = Callable[[float, str], Awaitable[None]]


def _slug(s: str) -> str:
    return re.sub(r"[^a-z0-9]+", "", s.lower())


def _workdir_for(song: str) -> Path:
    return HIGGSFIELD_ROOT / f"{_slug(song)}-loop"


def _find_final(workdir: Path, variant: str) -> Optional[Path]:
    """Locate the engine's produced final mp4. Prefer the requested variant, then the
    base passes the build step always writes (`<name>_raw.mp4`, `<name>_natural.mp4`)."""
    fin = workdir / "final"
    if not fin.is_dir():
        return None
    name = workdir.name
    candidates = [
        fin / f"{name}_{variant}.mp4",
        fin / f"{name}_raw.mp4",
        fin / f"{name}_natural.mp4",
    ]
    for c in candidates:
        if c.exists():
            return c
    # last resort: newest mp4 in final/
    mp4s = sorted(fin.glob("*.mp4"), key=lambda p: p.stat().st_mtime, reverse=True)
    return mp4s[0] if mp4s else None


def bake_morph(
    *,
    song: str,
    images: list[str | Path],
    out: Optional[str | Path] = None,
    variant: str = "bw_lyrics",
    grain: int = 3,
    bars: int = 8,
    section: str = "Chorus",
    skip_generate: bool = False,
) -> Path:
    """Run the native morphloop engine (make.py). Returns the final mp4 path.

    `images` is 4 or 8 resolved image paths (MorphEffect.target_media_ids resolved to
    absolute paths by the caller). `skip_generate=True` reuses already-rendered raw
    clips in the work dir (offline). If `out` is given, the engine's final is copied
    there; otherwise the engine's own final path is returned.
    """
    if not MAKE_SCRIPT.exists():
        raise RuntimeError(f"morphloop engine not found at {MAKE_SCRIPT}")
    paths = [str(Path(p).expanduser().resolve()) for p in images]
    if len(paths) not in (4, 8):
        raise RuntimeError(f"morphloop needs 4 or 8 images, got {len(paths)}")

    import sys
    cmd: list[str] = [
        sys.executable, str(MAKE_SCRIPT), song, *paths,
        "--variant", variant,
        "--grain", str(int(grain)),
        "--bars", str(int(bars)),
        "--section", section,
    ]
    if skip_generate:
        cmd += ["--skip-generate"]

    proc = subprocess.run(cmd, capture_output=True, text=True)
    if proc.returncode != 0:
        tail = (proc.stderr or proc.stdout or "").strip()[-2500:]
        raise RuntimeError(f"morphloop failed (exit {proc.returncode}):\n{tail}")

    workdir = _workdir_for(song)
    final = _find_final(workdir, variant)
    if final is None:
        raise RuntimeError(
            f"morphloop finished but no final mp4 found in {workdir / 'final'}\n"
            f"{proc.stdout[-1000:]}"
        )
    if out:
        out = Path(out).expanduser().resolve()
        out.parent.mkdir(parents=True, exist_ok=True)
        import shutil
        shutil.copy2(final, out)
        return out
    return final


# ───────────────────────── queue runner (engine = morphloop) ─────────────────────────

async def morph_runner(job: Any, progress: ProgressFn) -> dict:
    """Job runner for `render_morph` (lane "cpu" — beat-sync + treat compositing).

    Payload (mirrors MorphEffect + IO):
      song:          str          (song name the engine resolves a data dir for)
      images:        list[str]    (4 or 8 image paths; = MorphEffect.target_media_ids)
      out:           str | None
      variant:       str  (default "bw_lyrics")
      grain:         int  (default 3)
      bars:          int  (default 8)
      section:       str  (default "Chorus")
      skip_generate: bool (default False — True reuses existing raw clips, offline)
    """
    p = job.payload or {}
    song = p.get("song")
    images = p.get("images") or []
    if not song:
        raise ValueError("payload.song is required for morphloop")
    if len(images) not in (4, 8):
        raise ValueError("payload.images must be 4 or 8 image paths")

    await progress(0.05, f"morph: {song} ({len(images)} images)")
    loop = asyncio.get_running_loop()
    stop = asyncio.Event()

    async def _heartbeat() -> None:
        frac = 0.05
        while not stop.is_set():
            await asyncio.sleep(3.0)
            frac = min(0.92, frac + 0.03)
            await progress(frac, "morph: building loop")

    hb = asyncio.create_task(_heartbeat())
    try:
        result = await loop.run_in_executor(
            None,
            lambda: bake_morph(
                song=song,
                images=images,
                out=p.get("out"),
                variant=str(p.get("variant", "bw_lyrics")),
                grain=int(p.get("grain", 3)),
                bars=int(p.get("bars", 8)),
                section=str(p.get("section", "Chorus")),
                skip_generate=bool(p.get("skip_generate", False)),
            ),
        )
    finally:
        stop.set()
        hb.cancel()
        try:
            await hb
        except asyncio.CancelledError:
            pass

    await progress(1.0, "morph done")
    return {"ok": True, "engine": "morphloop", "song": song, "output": str(result)}


def register(queue, kind: str = "render_morph") -> None:
    """Register the morphloop engine on the shared queue without editing queue.py."""
    queue.register_runner(kind, morph_runner)


__all__ = [
    "bake_morph",
    "morph_runner",
    "register",
]
