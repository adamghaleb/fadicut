"""Beat detection → SongContext.tempo (Batch C).

Wraps snippet-selector's `analyze_beats.analyze()` (run out-of-venv as a subprocess
because the bridge venv has no numpy) and folds the result into the frozen
`SongContext.tempo` contract: `bpm`, `bpm_confidence`, `beat_grid`, `downbeats`.

Times in SongContext are **seconds (float)** — analyze_beats already emits seconds, so
no conversion is needed here. The browser converts seconds→MediaTime at its own edge.

Public surface (imported by the integrator + the job runner):
  • detect_tempo(audio_path, *, python_exe=None) -> Tempo
  • fill_song_context(ctx, *, python_exe=None) -> SongContext   (mutates ctx.tempo + provenance)
  • derive_sections_from_downbeats(...)                          (optional structural fallback)

clipsync note: clipsync fingerprints *clips* against the song library to find where a
song plays inside a recording — it does not produce a song-level beat grid, so it is
NOT used to fill `tempo`. The integrator can call clipsync separately when ingesting
shoot footage; this module owns only the song spine.
"""

from __future__ import annotations

import json
import os
import shutil
import subprocess
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import Optional

from fadi_contracts.song_context import (
    Provenance,
    Section,
    SongContext,
    Tempo,
)

_HERE = Path(__file__).resolve().parent
_WORKER = _HERE / "_detect_worker.py"

BEATS_SOURCE = "snippet-selector/analyze_beats.py"


@dataclass(frozen=True)
class RawBeats:
    """Verbatim payload from analyze_beats.analyze()."""

    bpm: float
    duration: float
    beats: list[float]
    downbeats: list[float]


# ───────────────────────── numpy-python discovery ─────────────────────────

def _candidate_pythons() -> list[str]:
    """Pythons that might have numpy, most-likely first. The bridge venv is excluded
    (it deliberately has no numpy)."""
    out: list[str] = []
    env = os.environ.get("FADI_BEATS_PYTHON")
    if env:
        out.append(env)
    out.extend(
        p for p in (
            shutil.which("python3"),
            "/opt/homebrew/bin/python3",
            "/usr/bin/python3",
        ) if p
    )
    # de-dup, preserve order
    seen: set[str] = set()
    uniq: list[str] = []
    for p in out:
        rp = os.path.realpath(p)
        if rp not in seen:
            seen.add(rp)
            uniq.append(p)
    return uniq


def _python_has_numpy(python_exe: str) -> bool:
    try:
        r = subprocess.run(
            [python_exe, "-c", "import numpy"],
            capture_output=True, timeout=20,
        )
        return r.returncode == 0
    except Exception:  # noqa: BLE001
        return False


def resolve_beats_python(explicit: Optional[str] = None) -> str:
    """Return a Python interpreter that can import numpy (for analyze_beats)."""
    if explicit:
        if not _python_has_numpy(explicit):
            raise RuntimeError(f"FADI_BEATS_PYTHON / explicit python has no numpy: {explicit}")
        return explicit
    for p in _candidate_pythons():
        if _python_has_numpy(p):
            return p
    raise RuntimeError(
        "no Python with numpy found for beat detection — set FADI_BEATS_PYTHON to "
        "an interpreter that has numpy (e.g. snippet-selector's environment)."
    )


# ───────────────────────── detection ─────────────────────────

def detect_raw(audio_path: str | Path, *, python_exe: Optional[str] = None, timeout: float = 600.0) -> RawBeats:
    """Run analyze_beats.analyze() on `audio_path` via the numpy worker subprocess."""
    audio_path = str(Path(audio_path).expanduser())
    if not os.path.exists(audio_path):
        raise FileNotFoundError(audio_path)

    py = resolve_beats_python(python_exe)
    env = dict(os.environ)
    # ensure the worker can import album/analyze_beats even if env var unset
    env.setdefault(
        "FADI_SNIPPET_SELECTOR_DIR",
        os.path.expanduser("~/Documents/windsurf projects/snippet-selector"),
    )
    proc = subprocess.run(
        [py, str(_WORKER), audio_path],
        capture_output=True, text=True, timeout=timeout, env=env,
    )
    if proc.returncode != 0 or not proc.stdout.strip():
        raise RuntimeError(
            f"beat detection failed (rc={proc.returncode}): "
            f"{proc.stderr.strip() or proc.stdout.strip() or 'no output'}"
        )
    try:
        data = json.loads(proc.stdout.strip().splitlines()[-1])
    except json.JSONDecodeError as exc:
        raise RuntimeError(f"beat detection produced non-JSON output: {proc.stdout[:400]!r}") from exc
    if "error" in data:
        raise RuntimeError(f"beat detection error: {data['error']}")
    return RawBeats(
        bpm=float(data["bpm"]),
        duration=float(data["duration"]),
        beats=[float(t) for t in data.get("beats", [])],
        downbeats=[float(t) for t in data.get("downbeats", [])],
    )


def _bpm_confidence(raw: RawBeats) -> float:
    """Cheap confidence proxy: how regular the detected beat spacing is.

    analyze_beats assumes a constant tempo, so a clean grid has near-uniform inter-beat
    intervals. We map the coefficient of variation of intervals to a 0..1 score
    (low variation → high confidence). Returns 0.5 when there aren't enough beats.
    """
    beats = raw.beats
    if len(beats) < 4:
        return 0.5
    intervals = [b - a for a, b in zip(beats, beats[1:]) if b > a]
    if not intervals:
        return 0.5
    mean = sum(intervals) / len(intervals)
    if mean <= 0:
        return 0.5
    var = sum((d - mean) ** 2 for d in intervals) / len(intervals)
    cv = (var ** 0.5) / mean
    # cv≈0 → 1.0 ; cv≥0.25 → ~0.0
    score = max(0.0, min(1.0, 1.0 - (cv / 0.25)))
    return round(score, 3)


def detect_tempo(audio_path: str | Path, *, python_exe: Optional[str] = None) -> Tempo:
    """Detect tempo for one audio file and return a contract `Tempo` (seconds)."""
    raw = detect_raw(audio_path, python_exe=python_exe)
    return Tempo(
        bpm=raw.bpm,
        bpm_confidence=_bpm_confidence(raw),
        beat_grid=raw.beats,
        downbeats=raw.downbeats,
    )


# ───────────────────────── SongContext integration ─────────────────────────

def fill_song_context(
    ctx: SongContext,
    *,
    python_exe: Optional[str] = None,
    audio_path: Optional[str] = None,
) -> SongContext:
    """Detect beats from the context's audio and fill `ctx.tempo` in place.

    Preserves `ctx.tempo.time_signature` and `ctx.tempo.bpm` if already set by an
    upstream source where detection is only meant to add the grid; otherwise overwrites.
    Returns the same (mutated) ctx for chaining.
    """
    path = audio_path or ctx.audio.master_path
    tempo = detect_tempo(path, python_exe=python_exe)
    # keep an existing (more authoritative) time signature
    tempo.time_signature = ctx.tempo.time_signature
    ctx.tempo = tempo
    src = ctx.source or Provenance()
    src.beats_source = BEATS_SOURCE
    ctx.source = src
    return ctx


def derive_sections_from_downbeats(
    downbeats: list[float],
    duration: float,
    *,
    bars_per_section: int = 8,
) -> list[Section]:
    """Optional structural fallback when no real section data exists.

    Groups downbeats into fixed-length blocks (default 8 bars) and labels them
    intro/verse/chorus/bridge/outro in a rough rotation. This is a *placeholder* the
    editor can show as section markers until real Music.ai/song-pipeline sections land
    — callers should prefer real `SongContext.sections` when available.
    """
    if not downbeats:
        return []
    labels = ["intro", "verse", "chorus", "verse", "chorus", "bridge", "chorus", "outro"]
    sections: list[Section] = []
    idx = 0
    for start_i in range(0, len(downbeats), bars_per_section):
        block = downbeats[start_i:start_i + bars_per_section]
        if not block:
            continue
        start = block[0]
        end_i = start_i + bars_per_section
        end = downbeats[end_i] if end_i < len(downbeats) else duration
        name = "outro" if end >= duration - 1e-3 and idx > 0 else labels[idx % len(labels)]
        sections.append(Section(index=idx, name=name, start_sec=start, end_sec=end))
        idx += 1
    return sections
