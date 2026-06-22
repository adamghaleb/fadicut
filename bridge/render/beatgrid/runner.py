"""Job runner + registration for beat detection (Batch C).

Registers a `detect_beats` runner on the shared lane'd queue WITHOUT editing the queue
core (open/closed). The integrator calls `register_beatgrid_runners()` once at startup
(e.g. from the app lifespan or a batch-aggregating registration step) — this module does
not import or mutate any shared registry file itself.

Runner contract (see jobs/queue.py):  async def fn(job, progress) -> dict

Payload (job.payload):
  audio_path: str            — absolute path to the audio to analyze (required unless
                               song_context.audio.master_path is provided)
  song_context: dict | None  — a serialized SongContext to fill (optional)
  python_exe: str | None     — override the numpy interpreter (optional)
  derive_sections: bool      — also return placeholder sections from downbeats (default False)
  bars_per_section: int      — section block size when derive_sections (default 8)

Result dict:
  { tempo: {...}, song_context?: {...}, sections?: [...] }   (all contract JSON)

Lane: detection decodes audio + runs FFT in a subprocess → CPU lane (it does not touch
the M2 GPU, so it must not occupy the single-slot gpu lane).
"""

from __future__ import annotations

import asyncio
from typing import Optional

from fadi_contracts.song_context import SongContext

from .detector import (
    BEATS_SOURCE,
    derive_sections_from_downbeats,
    detect_raw,
)

RUNNER_KIND = "detect_beats"
RUNNER_LANE = "cpu"


async def detect_beats_runner(job, progress) -> dict:
    payload = job.payload or {}
    ctx_data = payload.get("song_context")
    audio_path: Optional[str] = payload.get("audio_path")
    python_exe: Optional[str] = payload.get("python_exe")
    derive_sections = bool(payload.get("derive_sections", False))
    bars_per_section = int(payload.get("bars_per_section", 8))

    ctx: Optional[SongContext] = None
    if ctx_data:
        ctx = SongContext.model_validate(ctx_data)
        if not audio_path:
            audio_path = ctx.audio.master_path

    if not audio_path:
        raise ValueError("detect_beats: need audio_path or song_context.audio.master_path")

    await progress(0.05, "decoding audio + detecting beats")

    # detect_raw shells out to the numpy worker; run it off the event loop.
    raw = await asyncio.to_thread(detect_raw, audio_path, python_exe=python_exe)

    await progress(0.85, f"{raw.bpm:.1f} bpm, {len(raw.downbeats)} downbeats")

    # Build tempo via detect_tempo's confidence logic by reusing detector helpers.
    from .detector import _bpm_confidence  # local import: internal helper
    from fadi_contracts.song_context import Tempo

    tempo = Tempo(
        bpm=raw.bpm,
        bpm_confidence=_bpm_confidence(raw),
        beat_grid=raw.beats,
        downbeats=raw.downbeats,
    )

    result: dict = {"tempo": tempo.model_dump(mode="json")}

    sections = None
    if derive_sections:
        sections = derive_sections_from_downbeats(
            raw.downbeats, raw.duration, bars_per_section=bars_per_section
        )
        result["sections"] = [s.model_dump(mode="json") for s in sections]

    if ctx is not None:
        tempo.time_signature = ctx.tempo.time_signature
        ctx.tempo = tempo
        if ctx.source:
            ctx.source.beats_source = BEATS_SOURCE
        if sections is not None and not ctx.sections:
            ctx.sections = sections
        result["song_context"] = ctx.model_dump(mode="json")

    await progress(1.0, "done")
    return result


def register_beatgrid_runners(register_runner=None) -> None:
    """Register this batch's runners on the shared queue.

    Pass a `register_runner(kind, fn)` callable (the one from `jobs`), or omit it to use
    the default `jobs.register_runner`. Idempotent-safe: swallows the "already registered"
    error so repeated wiring from multiple batches doesn't crash startup.
    """
    if register_runner is None:
        from jobs import register_runner as _rr
        register_runner = _rr
    try:
        register_runner(RUNNER_KIND, detect_beats_runner)
    except ValueError:
        # already registered (e.g. double-wired) — fine.
        pass
