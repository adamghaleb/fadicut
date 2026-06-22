"""
SongContext — the beat/lyric/section "spine" the whole Fadi↔OpenCut system binds to.

This is the canonical, language-neutral representation of everything we know about a
song: tempo + beat grid, sections, key/chords, and word-aligned lyrics. It is produced
by the song-pipeline (catalog.json) + beat detection (snippet-selector / clipsync) +
word alignment (Music.ai). Every time in this model is **seconds (float)** so it is
front-end agnostic — OpenCut converts to its own MediaTime at the edge.

Source of truth: this Pydantic model. JSON Schema + TS types are generated from it
(see codegen.py). Bump SCHEMA_VERSION on any breaking change.
"""

from __future__ import annotations

from typing import Optional

from pydantic import BaseModel, Field

SCHEMA_VERSION = "1.0.0"


class TimeSignature(BaseModel):
    numerator: int = 4
    denominator: int = 4


class AudioRef(BaseModel):
    """Where the song's audio lives. master_path is the full-quality file used for
    final render; proxy_path is an optional low-bitrate file for browser scrubbing."""

    master_path: str = Field(..., description="Absolute path to master WAV/audio on disk (drive).")
    proxy_path: Optional[str] = Field(None, description="Low-bitrate proxy served to the browser.")
    sample_rate: int = 44100
    channels: int = 2
    duration_sec: float


class Tempo(BaseModel):
    bpm: float
    bpm_confidence: Optional[float] = Field(None, ge=0, le=1)
    time_signature: TimeSignature = TimeSignature()
    # Absolute times (sec) of every detected beat and every downbeat (bar start).
    beat_grid: list[float] = Field(default_factory=list)
    downbeats: list[float] = Field(default_factory=list)


class Section(BaseModel):
    """A structural section: intro / verse / chorus / bridge / outro …"""

    index: int
    name: str
    start_sec: float
    end_sec: float


class Chord(BaseModel):
    symbol: str = Field(..., description='e.g. "Cmaj7", "F#m"')
    start_sec: float
    end_sec: float


class Word(BaseModel):
    text: str
    start_sec: float
    end_sec: float
    confidence: Optional[float] = Field(None, ge=0, le=1)


class LyricLine(BaseModel):
    index: int
    text: str
    start_sec: float
    end_sec: float
    words: list[Word] = Field(default_factory=list, description="Word-level alignment for karaoke timing.")


class Provenance(BaseModel):
    """Where this context came from, so renders are reproducible/auditable."""

    catalog_path: Optional[str] = None
    beats_source: Optional[str] = Field(None, description='e.g. "snippet-selector/analyze_beats.py"')
    lyrics_source: Optional[str] = Field(None, description='e.g. "music.ai alignment.json"')


class SongContext(BaseModel):
    schema_version: str = SCHEMA_VERSION
    song_id: str = Field(..., description="Stable slug, e.g. 'me-and-u'.")
    title: str
    artist: Optional[str] = "adam fadi"

    audio: AudioRef
    tempo: Tempo
    key: Optional[str] = None

    sections: list[Section] = Field(default_factory=list)
    chords: list[Chord] = Field(default_factory=list)
    lyrics: list[LyricLine] = Field(default_factory=list)

    source: Provenance = Field(default_factory=Provenance)

    # ----- convenience helpers (not serialized) -----
    def nearest_beat(self, t: float, downbeats_only: bool = False) -> Optional[float]:
        grid = self.tempo.downbeats if downbeats_only else self.tempo.beat_grid
        if not grid:
            return None
        return min(grid, key=lambda b: abs(b - t))

    def words_in_range(self, start_sec: float, end_sec: float) -> list[Word]:
        out: list[Word] = []
        for line in self.lyrics:
            out.extend(w for w in line.words if w.start_sec < end_sec and w.end_sec > start_sec)
        return out
