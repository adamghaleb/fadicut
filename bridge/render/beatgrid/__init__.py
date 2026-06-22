"""Batch C — BPM / beat-synced editing (bridge side).

Wraps snippet-selector's `analyze_beats.py` to detect a song's beat grid + downbeats and
fold them into the frozen `SongContext.tempo` contract (seconds). Exposes an HTTP router
and a job runner the integrator wires WITHOUT editing bridge core files.

Integrator wiring (do this in app.py / a registration aggregator — NOT here):

    from render.beatgrid import beatgrid_router, register_beatgrid_runners
    app.include_router(beatgrid_router)        # adds POST /beatgrid/detect[/async]
    register_beatgrid_runners()                # registers the `detect_beats` job runner

Public surface:
  • detect_tempo(audio_path)            -> Tempo                  (contract object)
  • fill_song_context(ctx)              -> SongContext            (mutates ctx.tempo)
  • detect_raw(audio_path)              -> RawBeats               (verbatim analyze_beats)
  • derive_sections_from_downbeats(...) -> list[Section]          (placeholder structure)
  • beatgrid_router                     : FastAPI APIRouter
  • register_beatgrid_runners(...)      : queue runner registration
  • RUNNER_KIND, RUNNER_LANE, BEATS_SOURCE
"""

from .api import router as beatgrid_router
from .detector import (
    BEATS_SOURCE,
    RawBeats,
    derive_sections_from_downbeats,
    detect_raw,
    detect_tempo,
    fill_song_context,
    resolve_beats_python,
)
from .runner import (
    RUNNER_KIND,
    RUNNER_LANE,
    detect_beats_runner,
    register_beatgrid_runners,
)

__all__ = [
    "BEATS_SOURCE",
    "RawBeats",
    "beatgrid_router",
    "derive_sections_from_downbeats",
    "detect_beats_runner",
    "detect_raw",
    "detect_tempo",
    "fill_song_context",
    "register_beatgrid_runners",
    "resolve_beats_python",
    "RUNNER_KIND",
    "RUNNER_LANE",
]
