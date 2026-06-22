"""Native Fadi grade baker — the authoritative side of the `grade` FadiEffect.

The Fadi grade is an HLS **hue + saturation substitution that PRESERVES lightness**
from a B&W base — the Photoshop "Color" blend mode, not a flat alpha fill with a solid
color. Detail under the substituted hue must stay visible (Adam-confirmed). This module
is the native bake; the browser renders a WebGL preview from the same `GradeEffect`
params (see apps/web/.../effects/GradeEffect.tsx).

Modes (mirror contracts.fadi_edl.GradeEffect.mode):
  • hls_substitution — single Fadi color: keep per-pixel L, swap H+S to the Fadi color.
  • rainbow          — full-frame rainbow cycle over the 7-color Fadi palette.
  • hue_shift        — rotate every pixel's hue by `hue_deg` (preserves color diversity).
  • outline          — white fill + a Fadi-color stroke around the keyed silhouette.

Engine name: ``fadi_grade`` (the queue runner kind is ``render_grade``).

Wraps numpy + Pillow; encodes with the ffmpeg-full build (the bare ffmpeg lacks the
filters/codecs we rely on elsewhere). No new color science is invented here — the
substitution math is the proven `color_blend` from the morphloop treat pipeline.
"""

from __future__ import annotations

import asyncio
import colorsys
import shutil
import subprocess
import tempfile
from pathlib import Path
from typing import Any, Awaitable, Callable, Optional

# ffmpeg-full — the bare /opt/homebrew/bin/ffmpeg lacks drawtext/filters we lean on.
FFMPEG = "/opt/homebrew/Cellar/ffmpeg-full/8.1_1/bin/ffmpeg"
FFPROBE = "/opt/homebrew/Cellar/ffmpeg-full/8.1_1/bin/ffprobe"

# The 7 Fadi brand colors (RGB 0-255), canonical order.
FADI_RGB: list[tuple[int, int, int]] = [
    (255, 0, 96), (255, 164, 5), (255, 228, 0), (17, 255, 5),
    (5, 211, 255), (111, 5, 255), (246, 5, 255),
]
FADI_HLS = [colorsys.rgb_to_hls(r / 255, g / 255, b / 255) for (r, g, b) in FADI_RGB]

# Extra chroma punch on substituted Fadi colors (matches the morphloop look).
FADI_SAT = 1.35


# ───────────────────────── small ffmpeg utils ─────────────────────────

def _run(cmd: list[str]) -> subprocess.CompletedProcess:
    return subprocess.run(cmd, check=True, capture_output=True, text=True)


def _probe(path: Path) -> tuple[float, int, int, float]:
    """(fps, width, height, duration_sec)."""
    out = _run([
        FFPROBE, "-v", "error", "-select_streams", "v:0",
        "-show_entries", "stream=r_frame_rate,width,height:format=duration",
        "-of", "default=nw=1", str(path),
    ]).stdout
    fps, w, h, dur = 24.0, 0, 0, 0.0
    for line in out.splitlines():
        k, _, v = line.partition("=")
        if k == "r_frame_rate":
            n, _, d = v.partition("/")
            fps = float(n) / float(d or 1)
        elif k == "width":
            w = int(v)
        elif k == "height":
            h = int(v)
        elif k == "duration":
            dur = float(v or 0.0)
    return fps, w, h, dur


def _is_image(path: Path) -> bool:
    return path.suffix.lower() in {".png", ".jpg", ".jpeg", ".webp", ".bmp", ".tif", ".tiff"}


# ───────────────────────── the grade (proven color science) ─────────────────────────

def _hex_to_idx(fadi_color: Optional[str]) -> int:
    """Snap an arbitrary hex to the nearest Fadi palette index; default = magenta-pink (0)."""
    if not fadi_color:
        return 0
    s = fadi_color.lstrip("#")
    try:
        r, g, b = int(s[0:2], 16), int(s[2:4], 16), int(s[4:6], 16)
    except (ValueError, IndexError):
        return 0
    best, bi = 1e9, 0
    for i, (fr, fg, fb) in enumerate(FADI_RGB):
        d = (r - fr) ** 2 + (g - fg) ** 2 + (b - fb) ** 2
        if d < best:
            best, bi = d, i
    return bi


def _color_blend(rgb01, idx: int):
    """Photoshop 'Color' blend: keep per-pixel L, take H+S from FADI[idx]. (morphloop math)"""
    import numpy as np

    mx = rgb01.max(-1)
    mn = rgb01.min(-1)
    L = (mx + mn) / 2.0
    fh, _, fs = FADI_HLS[idx]
    c = np.clip((1 - np.abs(2 * L - 1)) * fs * FADI_SAT, 0, 1)
    x = c * (1 - abs((fh * 6) % 2 - 1))
    m = L - c / 2
    z = np.zeros_like(L)
    s = int(fh * 6) % 6
    r, g, b = {
        0: (c, x, z), 1: (x, c, z), 2: (z, c, x),
        3: (z, x, c), 4: (x, z, c), 5: (c, z, x),
    }[s]
    return np.clip(np.stack([r + m, g + m, b + m], -1), 0, 1)


def _grade_frame(arr, mode: str, idx: int, cyc: int, params: dict):
    """Apply the Fadi grade to a single HxWx3 uint8 frame. Returns uint8."""
    import numpy as np
    from PIL import Image, ImageFilter

    rgb01 = arr.astype(np.float32) / 255.0

    if mode == "hue_shift":
        hue_deg = float(params.get("hue_deg", 60.0))
        hsv = np.array(Image.fromarray(arr, "RGB").convert("HSV")).astype(np.float32)
        hsv[..., 0] = (hsv[..., 0] + hue_deg / 360.0 * 255.0) % 255.0
        return np.array(Image.fromarray(hsv.astype(np.uint8), "HSV").convert("RGB"))

    if mode == "rainbow":
        # Full-frame substitution cycling the palette per `every_n_frames`.
        out = _color_blend(rgb01, idx % 7)
        return np.clip(out * 255, 0, 255).astype(np.uint8)

    # hls_substitution / outline both key on luminance/sat so they only recolor
    # the bright, saturated subject — leaving the plate alone.
    sat_thresh = float(params.get("sat_threshold", 0.18))
    val_thresh = float(params.get("val_threshold", 0.22))
    soft = float(params.get("mask_soft", 0.08))

    hsv = np.array(Image.fromarray(arr, "RGB").convert("HSV")).astype(np.float32) / 255.0
    S, V = hsv[..., 1], hsv[..., 2]
    mask = ((S >= sat_thresh) & (V >= val_thresh)).astype(np.float32)
    if soft > 0:
        m_img = Image.fromarray((mask * 255).astype(np.uint8)).filter(
            ImageFilter.GaussianBlur(max(0.5, soft * 12))
        )
        mask = np.asarray(m_img, dtype=np.float32) / 255.0
    m3 = mask[..., None]

    col = _color_blend(rgb01, idx % 7)

    if mode == "outline":
        # white fill on the subject, Fadi-color stroke around it.
        white = np.ones_like(rgb01)
        filled = np.where(m3 > 0.5, white, rgb01)
        edge = Image.fromarray((mask * 255).astype(np.uint8)).filter(ImageFilter.MaxFilter(5))
        edge_arr = np.asarray(edge, dtype=np.float32) / 255.0
        stroke = np.clip(edge_arr - mask, 0, 1)[..., None]
        out = filled * (1 - stroke) + col * stroke
        return np.clip(out * 255, 0, 255).astype(np.uint8)

    out = rgb01 * (1 - m3) + col * m3
    return np.clip(out * 255, 0, 255).astype(np.uint8)


# ───────────────────────── public bake API ─────────────────────────

def bake_grade(
    src: Path,
    out: Path,
    *,
    mode: str = "hls_substitution",
    fadi_color: Optional[str] = None,
    params: Optional[dict] = None,
    fps: Optional[float] = None,
    width: Optional[int] = None,
    on_frame: Optional[Callable[[int, int], None]] = None,
) -> Path:
    """Authoritative Fadi-grade bake of a video (or single image) → `out`.

    `on_frame(done, total)` is called per processed frame for progress reporting.
    Returns `out`.
    """
    import numpy as np
    from PIL import Image

    src = Path(src).expanduser().resolve()
    out = Path(out).expanduser().resolve()
    out.parent.mkdir(parents=True, exist_ok=True)
    params = params or {}
    idx0 = _hex_to_idx(fadi_color)
    every = max(1, int(params.get("every_n_frames", 3)))

    if _is_image(src):
        arr = np.asarray(Image.open(src).convert("RGB"))
        graded = _grade_frame(arr, mode, idx0, 0, params)
        Image.fromarray(graded).save(out)
        if on_frame:
            on_frame(1, 1)
        return out

    work = Path(tempfile.mkdtemp(prefix="fadi_grade_"))
    try:
        s_fps, s_w, s_h, dur = _probe(src)
        o_fps = fps or s_fps
        raw = work / "raw"
        raw.mkdir()
        vf = f"fps={o_fps}"
        if width:
            vf += f",scale={width}:-2:flags=lanczos"
        _run([FFMPEG, "-y", "-i", str(src), "-vf", vf, "-fps_mode", "cfr",
              str(raw / "%06d.png")])

        frames = sorted(raw.glob("*.png"))
        total = len(frames)
        gdir = work / "graded"
        gdir.mkdir()
        for i, fp in enumerate(frames):
            arr = np.asarray(Image.open(fp).convert("RGB"))
            cyc = i // every
            graded = _grade_frame(arr, mode, (idx0 + cyc) % 7, cyc, params)
            Image.fromarray(graded).save(gdir / fp.name)
            if on_frame:
                on_frame(i + 1, total)

        # Re-mux: encode graded frames, copy original audio if present.
        cmd = [FFMPEG, "-y", "-framerate", f"{o_fps}", "-i", str(gdir / "%06d.png")]
        has_audio = bool(_run([
            FFPROBE, "-v", "error", "-select_streams", "a:0",
            "-show_entries", "stream=index", "-of", "csv=p=0", str(src),
        ]).stdout.strip())
        if has_audio:
            cmd += ["-i", str(src), "-map", "0:v:0", "-map", "1:a:0", "-c:a", "aac", "-shortest"]
        cmd += ["-c:v", "libx264", "-crf", "16", "-pix_fmt", "yuv420p", str(out)]
        _run(cmd)
        return out
    finally:
        shutil.rmtree(work, ignore_errors=True)


# ───────────────────────── queue runner (engine = fadi_grade) ─────────────────────────

ProgressFn = Callable[[float, str], Awaitable[None]]


async def grade_runner(job: Any, progress: ProgressFn) -> dict:
    """Job runner for `render_grade`. Register on the GPU lane (serialized on the M2).

    Payload (mirrors GradeEffect + IO):
      src:        str        — input video/image path
      out:        str        — output path
      mode:       str        — hls_substitution | rainbow | hue_shift | outline
      fadi_color: str | None — hex of the Fadi color to substitute
      params:     dict       — every_n_frames, sat_threshold, val_threshold, hue_deg, …
      fps:        float|None
      width:      int|None
    """
    p = job.payload
    src = Path(p["src"]).expanduser()
    out = Path(p.get("out") or src.with_name(src.stem + "__graded.mp4"))
    mode = p.get("mode", "hls_substitution")
    fadi_color = p.get("fadi_color")
    params = p.get("params") or {}
    fps = p.get("fps")
    width = p.get("width")

    await progress(0.02, f"grade: {mode}")
    loop = asyncio.get_running_loop()

    # Bridge per-frame progress from the worker thread back to the event loop.
    last = {"frac": 0.0}

    def _bump(done: int, total: int) -> None:
        frac = 0.05 + 0.9 * (done / max(1, total))
        if frac - last["frac"] >= 0.01 or done == total:
            last["frac"] = frac
            asyncio.run_coroutine_threadsafe(
                progress(frac, f"grade {done}/{total}"), loop
            )

    result = await loop.run_in_executor(
        None,
        lambda: bake_grade(
            src, out, mode=mode, fadi_color=fadi_color, params=params,
            fps=fps, width=width, on_frame=_bump,
        ),
    )
    await progress(1.0, "grade done")
    return {"ok": True, "engine": "fadi_grade", "mode": mode, "output": str(result)}
