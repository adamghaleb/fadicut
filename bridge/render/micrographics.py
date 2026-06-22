"""Native micrographics baker — the authoritative side of the `micrographics` FadiEffect.

`MicrographicsEffect.engine == "fadi_micrographics"` (contracts/fadi_edl.py). The FadiFiles
"micrographics on every image" rule: hairline readouts, registration corner marks, micro
counters, tick strips, log lines and waveforms composited over a clip so it reads as a
data-dense Hermetic artifact rather than a flat frame.

This module WRAPS Adam's existing engine
``~/.claude/skills/fadifiles/v22/batch27/micrographics.py`` (do NOT reimplement the
component renderers / preset library). That engine emits ffmpeg filter fragments for a
single transparent "panel" (``compile_panel`` + ``lavfi_input`` + the JSON presets under
``micro-presets/``). It has no single "render the overlay over a video" entrypoint, so this
wrapper does the assembly: pick N presets by `density`, anchor each panel to a clip corner,
add a transparent lavfi input per panel, chain ``compile_panel`` and overlay every panel
onto the input clip's frames → one composited mp4.

Translation of the contract's `MicrographicsEffect` knobs:
  • density "sparse"/"medium"/"dense" → number of panels scattered (1 / 2 / 4).
  • palette (list of Fadi hex) → drives the per-panel `fadi` tint colour cycle.
  • seed → deterministic preset choice, slot shuffle, tint + colour pick.
  • params → optional escape hatch: {presets:[...], tint, panels:int} override the auto-pick.

Engine name: ``fadi_micrographics`` (the queue runner kind is ``render_micrographics``).
"""

from __future__ import annotations

import asyncio
import importlib.util
import os
import random
import shutil
import subprocess
from pathlib import Path
from typing import Any, Awaitable, Callable, Optional

# ── ffmpeg-full (bare /opt/homebrew/bin/ffmpeg lacks drawtext/freetype) ───────────────
FFMPEG = "/opt/homebrew/Cellar/ffmpeg-full/8.1_1/bin/ffmpeg"
FFPROBE = "/opt/homebrew/Cellar/ffmpeg-full/8.1_1/bin/ffprobe"
if not Path(FFMPEG).exists():
    FFMPEG = shutil.which("ffmpeg") or "ffmpeg"
    FFPROBE = shutil.which("ffprobe") or "ffprobe"

ProgressFn = Callable[[float, str], Awaitable[None]]

# Source engine (the panel compiler + preset library). Loaded by path so this module does
# not depend on the skill dir being importable as a package.
MG_SOURCE = Path(
    os.path.expanduser("~/.claude/skills/fadifiles/v22/batch27/micrographics.py")
)

_IMAGE_EXTS = {".png", ".jpg", ".jpeg", ".webp", ".bmp", ".tif", ".tiff", ".gif"}

# density → how many micrographic panels get scattered onto the clip.
DENSITY_PANELS: dict[str, int] = {"sparse": 1, "medium": 2, "dense": 4}

# Tint modes the source `compile_panel` understands (see tint_fragment): drives whether the
# panel linework stays black, recolours to a single Fadi colour, or cycles rainbow.
_TINT_MODES = ["fadi", "rainbow-3s", "fadi", "black"]

# Fadi palette fallback (RGB) — mirrors the source engine's FADI_COLORS when no palette set.
_FADI_RGB_FALLBACK = [
    (255, 0, 96), (255, 164, 5), (255, 228, 0), (17, 255, 5),
    (5, 211, 255), (111, 5, 255), (246, 5, 255),
]


# ── source-engine loader (cached) ───────────────────────────────────────────
_MG = None


def _load_engine():
    """Import the source micrographics module by file path. Cached after first load."""
    global _MG
    if _MG is not None:
        return _MG
    if not MG_SOURCE.exists():
        raise RuntimeError(f"micrographics engine not found at {MG_SOURCE}")
    spec = importlib.util.spec_from_file_location("fadi_micrographics_src", MG_SOURCE)
    if spec is None or spec.loader is None:
        raise RuntimeError(f"cannot load micrographics engine from {MG_SOURCE}")
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    _MG = mod
    return mod


def _hex_to_rgb(h: str) -> Optional[tuple[int, int, int]]:
    h = (h or "").strip().lstrip("#")
    if len(h) == 3:
        h = "".join(c * 2 for c in h)
    if len(h) != 6:
        return None
    try:
        return (int(h[0:2], 16), int(h[2:4], 16), int(h[4:6], 16))
    except ValueError:
        return None


# ── probe ────────────────────────────────────────────────────────────────────
def _probe_clip(src: Path) -> tuple[int, int, float]:
    """(width, height, duration_sec) of a video clip via ffprobe; safe fallbacks."""
    try:
        out = subprocess.run(
            [
                FFPROBE, "-v", "error", "-select_streams", "v:0",
                "-show_entries", "stream=width,height:format=duration",
                "-of", "default=noprint_wrappers=1", str(src),
            ],
            capture_output=True, text=True,
        ).stdout
    except Exception:
        out = ""
    w = h = 0
    dur = 0.0
    for line in out.splitlines():
        if line.startswith("width="):
            w = int(float(line.split("=", 1)[1] or 0))
        elif line.startswith("height="):
            h = int(float(line.split("=", 1)[1] or 0))
        elif line.startswith("duration="):
            try:
                dur = float(line.split("=", 1)[1])
            except ValueError:
                dur = 0.0
    return (w or 1080, h or 1920, dur if dur > 0 else 4.0)


# ── panel anchoring (scaled to the clip canvas) ──────────────────────────────
_SLOT_ORDER = ["tl", "tr", "bl", "br"]


def _anchor(slot: str, W: int, H: int, panel_W: int, panel_H: int) -> tuple[int, int]:
    """Corner anchor for a panel, with a gutter proportional to canvas size."""
    gx = max(16, round(W * 0.037))   # ~40px on a 1080 canvas
    gy = max(24, round(H * 0.031))   # ~60px on a 1920 canvas
    if slot == "tl":
        return (gx, gy)
    if slot == "tr":
        return (W - panel_W - gx, gy)
    if slot == "bl":
        return (gx, H - panel_H - gy)
    if slot == "br":
        return (W - panel_W - gx, H - panel_H - gy)
    return (gx, gy)


def _pick_presets(mg, density: str, seed: int, override: Optional[list[str]], n_override: Optional[int]) -> list[str]:
    """Choose which presets to scatter. `override` (params.presets) wins if valid."""
    available = mg.list_presets()
    if not available:
        return []
    rng = random.Random(seed)
    if override:
        chosen = [p for p in override if p in available]
        if chosen:
            return chosen
    count = n_override if n_override else DENSITY_PANELS.get(density, 2)
    count = max(1, min(count, len(available), 4))
    pool = list(available)
    rng.shuffle(pool)
    return pool[:count]


# ── core bake ────────────────────────────────────────────────────────────────
def bake_micrographics(
    src: Path,
    out: Path,
    *,
    density: str = "medium",
    palette: Optional[list[str]] = None,
    seed: Optional[int] = None,
    params: Optional[dict] = None,
) -> Path:
    """Composite native micrographic panels over `src`. Returns `out`.

    Reads the input clip, scatters `density`-many transparent micrographic HUD panels (from
    the source engine's preset library) anchored to the clip corners, tinted from `palette`,
    and renders one composited mp4. `params` may carry {presets:[...], tint, panels:int} to
    override the auto-pick. Raises RuntimeError with ffmpeg stderr on failure.
    """
    mg = _load_engine()
    src = Path(src).expanduser().resolve()
    out = Path(out).expanduser().resolve()
    out.parent.mkdir(parents=True, exist_ok=True)
    params = params or {}

    seed = int(seed) if seed is not None else 7
    rng = random.Random(seed)

    W, H, dur = _probe_clip(src)
    dur = max(0.5, dur)

    presets = _pick_presets(
        mg, density, seed,
        override=params.get("presets"),
        n_override=params.get("panels"),
    )
    if not presets:
        raise RuntimeError("micrographics: no presets available to composite")

    # Resolve palette → list of (r,g,b) for the per-panel `fadi` tint.
    rgb_palette = [c for c in (_hex_to_rgb(h) for h in (palette or [])) if c]
    if not rgb_palette:
        rgb_palette = list(_FADI_RGB_FALLBACK)

    tint_override = params.get("tint")  # "fadi" | "rainbow-3s" | "black" | "white" | None
    slots = list(_SLOT_ORDER)
    rng.shuffle(slots)

    inputs: list[str] = []          # extra ffmpeg -f lavfi inputs (one per panel)
    chains: list[str] = []          # filter_complex statements
    cur = "0:v"                     # running video label (input 0 is the clip)

    for k, preset_name in enumerate(presets):
        try:
            spec = mg.load_preset(preset_name)
        except Exception:
            continue
        size = spec.get("size") or [320, 36]
        panel_W, panel_H = int(size[0]), int(size[1])
        # Clamp oversized panels to the canvas.
        panel_W = min(panel_W, max(64, W - 16))
        panel_H = min(panel_H, max(32, H - 16))

        slot = slots[k % 4]
        ax, ay = _anchor(slot, W, H, panel_W, panel_H)

        tint = tint_override or rng.choice(_TINT_MODES)
        fadi = rng.choice(rgb_palette)
        # Half the panels appear "already on" (no fade) so the HUD feels pre-existing.
        appear_t = 0.0 if rng.random() < 0.5 else round(0.15 + k * 0.30, 2)

        # The Kth panel is ffmpeg input (K+1) — input 0 is the clip. compile_panel emits
        # [in_label]...[out_label], so pass the raw input stream label directly.
        in_label = f"{k + 1}:v"
        out_label = f"mg{k}"
        inputs.append(mg.lavfi_input(panel_W, panel_H, dur))
        chains.append(
            mg.compile_panel(
                spec, in_label, out_label,
                panel_W=panel_W, panel_H=panel_H, dur=dur,
                tint=tint, fadi_rgb=fadi, appear_t=appear_t,
            )
        )
        nxt = f"v{k}"
        chains.append(f"[{cur}][{out_label}]overlay={ax}:{ay}:eval=frame[{nxt}]")
        cur = nxt

    if len(chains) < 2:
        raise RuntimeError("micrographics: every chosen preset failed to load")

    chains.append(f"[{cur}]format=yuv420p[outv]")
    full_fc = ";".join(chains)

    cmd: list[str] = [FFMPEG, "-y", "-loglevel", "error", "-i", str(src)]
    for inp in inputs:
        # inp is a string like '-f lavfi -t 4.00 -i "color=..."'; split safely.
        cmd += _split_lavfi(inp)
    cmd += [
        "-filter_complex", full_fc,
        "-map", "[outv]",
        # keep the clip's audio if present (overlay master mux happens downstream).
        "-map", "0:a?",
        "-c:v", "libx264", "-crf", "16", "-pix_fmt", "yuv420p",
        "-c:a", "copy",
        str(out),
    ]

    proc = subprocess.run(cmd, capture_output=True, text=True)
    if proc.returncode != 0:
        raise RuntimeError(
            f"micrographics ffmpeg failed (exit {proc.returncode}):\n{proc.stderr or proc.stdout}"
        )
    if not out.exists():
        raise RuntimeError(f"micrographics finished but no output at {out}\n{proc.stdout}")
    return out


def _split_lavfi(inp: str) -> list[str]:
    """Split a `lavfi_input` cli fragment into argv, honouring the quoted color=... value."""
    import shlex
    return shlex.split(inp)


# ── effect-handler (dispatched by the orchestrator) ──────────────────────────
async def micrographics_handler(ctx: Any, fx: Any, progress: ProgressFn) -> None:
    """Effect handler for the `micrographics` FadiEffect (orchestrator dispatch).

    Reads ctx.current, composites the micrographic HUD panels, reassigns ctx.current, and
    bumps the bake counter. Stills early-return (the source panels are time-based lavfi
    overlays meant for video); main clips are pre-normalized to mp4 upstream so this is a
    documented no-op only for raw image inputs.
    """
    current = Path(ctx.current)
    if current.suffix.lower() in _IMAGE_EXTS:
        await progress(1.0, "micrographics: skipped (still image)")
        return

    await progress(0.05, "micrographics: composing HUD panels")
    out = ctx.stage("micrographics")
    await asyncio.to_thread(
        bake_micrographics,
        current, out,
        density=getattr(fx, "density", "medium"),
        palette=list(getattr(fx, "palette", []) or []),
        seed=getattr(fx, "seed", None),
        params=dict(getattr(fx, "params", {}) or {}),
    )
    ctx.current = out
    ctx.bumped("micrographics")
    await progress(1.0, "micrographics done")


def register_handler() -> None:
    """Register the micrographics effect handler on the orchestrator dispatch registry.

    Mirrors the issue-#8 dispatch API: imported lazily so this module stays import-safe even
    if the orchestrator is loaded later. Idempotent (last writer wins)."""
    from .orchestrator import register_effect_handler

    register_effect_handler("micrographics", micrographics_handler)


# ── queue runner (standalone bake, kind = render_micrographics) ──────────────
async def micrographics_runner(job: Any, progress: ProgressFn) -> dict:
    """Job runner for `render_micrographics` (lane "cpu" — ffmpeg overlay composite).

    Payload (mirrors MicrographicsEffect + IO):
      src:      str
      out:      str | None
      density:  "sparse" | "medium" | "dense" (default "medium")
      palette:  list[str] (Fadi hex; default engine palette)
      seed:     int | None
      params:   dict | None   ({presets:[...], tint, panels:int})
    """
    p = job.payload or {}
    src = Path(p["src"]).expanduser()
    out = p.get("out")
    if not out:
        out = src.with_name(src.stem + "__micrographics.mp4")
    out = Path(out).expanduser()

    await progress(0.05, "micrographics: composing HUD panels")
    result = await asyncio.to_thread(
        bake_micrographics,
        src, out,
        density=str(p.get("density", "medium")),
        palette=list(p.get("palette", []) or []),
        seed=p.get("seed"),
        params=dict(p.get("params", {}) or {}),
    )
    await progress(1.0, "micrographics done")
    return {"ok": True, "engine": "fadi_micrographics", "output": str(result)}


def register(queue, kind: str = "render_micrographics") -> None:
    """Register the micrographics engine on the shared queue without editing queue.py."""
    queue.register_runner(kind, micrographics_runner)


__all__ = [
    "bake_micrographics",
    "micrographics_handler",
    "micrographics_runner",
    "register_handler",
    "register",
    "DENSITY_PANELS",
]


# Auto-register the effect handler on import so bare `render_edl` picks it up (mirrors the
# orchestrator's built-in auto-register). Guarded so import never hard-fails.
try:  # pragma: no cover - best-effort wiring
    register_handler()
except Exception:
    pass
