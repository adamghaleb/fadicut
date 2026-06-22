"""SongContext provider (Batch B spike) — loads "me&u" into the frozen contract.

Reads the song-pipeline catalog (catalog/catalog.json) if present and maps a song
entry into `fadi_contracts.song_context.SongContext` — the beat/lyric/section spine
the whole editor binds to. Falls back to a small in-repo fixture when the catalog
isn't on disk (CI, fresh checkout) so the vertical slice always has a song to load.

Mapping (catalog entry → SongContext), all times already in **seconds**:
    bpm, key, duration_s        → Tempo.bpm, key, AudioRef.duration_sec
    sections[{start,end,label}] → Section[]
    lyrics[{start,end,text,words[{word,start,end}]}] → LyricLine[] + Word[]
    chord_summary[str]          → (labels only; no per-chord timing in catalog → skipped)
    audio_path (dir or file)    → AudioRef.master_path

Beat grid: the catalog stores bpm + beat_count but no explicit grid, so we synthesize
a uniform grid from bpm across the duration (downbeats every `numerator` beats). This
is the same convention snippet-selector uses when only bpm is known; Batch C replaces
it with detected beats.

This module imports the FROZEN contract; it never modifies it.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any, Optional

# Import the frozen contract. The contracts package lives at repo-root/contracts.
import sys

_REPO = Path(__file__).resolve().parents[2]  # bridge/render/ -> repo root
_CONTRACTS = _REPO / "contracts"
if str(_CONTRACTS) not in sys.path:
    sys.path.insert(0, str(_CONTRACTS))

from fadi_contracts.song_context import (  # noqa: E402
    AudioRef,
    LyricLine,
    Provenance,
    Section,
    SongContext,
    Tempo,
    TimeSignature,
    Word,
)

# Default catalog location (song-pipeline). Overridable via env / arg.
DEFAULT_CATALOG = (
    Path.home()
    / "Documents/windsurf projects/song-pipeline/catalog/catalog.json"
)

# me&u identifiers across the catalog + slug conventions.
MEANDU_IDS = {"me-u-1bc03491", "me-and-u", "meandu", "me&u"}
MEANDU_SLUG = "me-and-u"


# ── catalog → contract mapping ────────────────────────────────────────────────

def _synth_beat_grid(
    bpm: float, duration_sec: float, numerator: int = 4
) -> tuple[list[float], list[float]]:
    """Uniform beat grid + downbeats from bpm across duration. Replaced by detected
    beats in Batch C; here it gives the editor a usable spine immediately."""
    if bpm <= 0 or duration_sec <= 0:
        return [], []
    spb = 60.0 / bpm
    n = int(duration_sec / spb) + 1
    grid = [round(i * spb, 4) for i in range(n)]
    downbeats = [grid[i] for i in range(0, len(grid), max(1, numerator))]
    return grid, downbeats


def _map_words(raw_words: list[dict[str, Any]]) -> list[Word]:
    out: list[Word] = []
    for w in raw_words or []:
        text = w.get("word") or w.get("text") or ""
        if not text:
            continue
        out.append(
            Word(
                text=str(text),
                start_sec=float(w.get("start", 0.0)),
                end_sec=float(w.get("end", 0.0)),
            )
        )
    return out


def _map_lyrics(raw_lyrics: list[dict[str, Any]]) -> list[LyricLine]:
    out: list[LyricLine] = []
    for i, ln in enumerate(raw_lyrics or []):
        out.append(
            LyricLine(
                index=i,
                text=str(ln.get("text", "")),
                start_sec=float(ln.get("start", 0.0)),
                end_sec=float(ln.get("end", 0.0)),
                words=_map_words(ln.get("words", [])),
            )
        )
    return out


def _map_sections(raw_sections: list[dict[str, Any]]) -> list[Section]:
    out: list[Section] = []
    for i, s in enumerate(raw_sections or []):
        out.append(
            Section(
                index=i,
                name=str(s.get("label", s.get("name", f"section_{i}"))),
                start_sec=float(s.get("start", 0.0)),
                end_sec=float(s.get("end", 0.0)),
            )
        )
    return out


def _entry_to_song_context(entry: dict[str, Any], *, catalog_path: Path) -> SongContext:
    bpm = float(entry.get("bpm", 0.0) or 0.0)
    duration = float(entry.get("duration_s", entry.get("duration_sec", 0.0)) or 0.0)
    grid, downbeats = _synth_beat_grid(bpm, duration)

    audio_path = entry.get("audio_path") or entry.get("source_path") or ""

    return SongContext(
        song_id=str(entry.get("id", MEANDU_SLUG)),
        title=str(entry.get("title", "me&u")),
        artist="adam fadi",
        audio=AudioRef(
            master_path=str(audio_path),
            duration_sec=duration,
        ),
        tempo=Tempo(
            bpm=bpm,
            time_signature=TimeSignature(numerator=4, denominator=4),
            beat_grid=grid,
            downbeats=downbeats,
        ),
        key=entry.get("key"),
        sections=_map_sections(entry.get("sections", [])),
        lyrics=_map_lyrics(entry.get("lyrics", [])),
        source=Provenance(
            catalog_path=str(catalog_path),
            beats_source="synthesized from bpm (Batch C replaces with detected)",
            lyrics_source="song-pipeline catalog (music.ai alignment)",
        ),
    )


def _find_entry(catalog: dict[str, Any], song_id: str) -> Optional[dict[str, Any]]:
    songs = catalog.get("songs", []) if isinstance(catalog, dict) else catalog
    if not isinstance(songs, list):
        return None
    wanted = {song_id, *(MEANDU_IDS if song_id in MEANDU_IDS or song_id == MEANDU_SLUG else set())}
    for s in songs:
        if not isinstance(s, dict):
            continue
        if s.get("id") in wanted:
            return s
        title = str(s.get("title", "")).lower().replace(" ", "")
        if title in {"me&u", "meandu"} and song_id in MEANDU_IDS | {MEANDU_SLUG}:
            return s
    return None


# ── fixture fallback ─────────────────────────────────────────────────────────

def _meandu_fixture() -> SongContext:
    """Minimal but real me&u context so the slice works without the catalog on disk.
    Times match the catalog's opening lines; just enough for the spike."""
    bpm = 140.0
    duration = 137.232
    grid, downbeats = _synth_beat_grid(bpm, duration)
    return SongContext(
        song_id="me-u-1bc03491",
        title="me&u",
        artist="adam fadi",
        audio=AudioRef(master_path="", duration_sec=duration),
        tempo=Tempo(
            bpm=bpm,
            time_signature=TimeSignature(),
            beat_grid=grid,
            downbeats=downbeats,
        ),
        key="A minor",
        sections=[
            Section(index=0, name="Intro", start_sec=0.0, end_sec=6.86),
            Section(index=1, name="Verse", start_sec=6.86, end_sec=20.56),
            Section(index=2, name="Chorus", start_sec=20.56, end_sec=34.28),
        ],
        lyrics=[
            LyricLine(
                index=0, text="U & i were planned out",
                start_sec=6.83, end_sec=9.96,
                words=[
                    Word(text="U", start_sec=6.83, end_sec=6.97),
                    Word(text="&", start_sec=6.97, end_sec=7.11),
                    Word(text="i", start_sec=7.11, end_sec=7.30),
                    Word(text="were", start_sec=7.30, end_sec=7.60),
                    Word(text="planned", start_sec=7.60, end_sec=8.40),
                    Word(text="out", start_sec=8.40, end_sec=9.96),
                ],
            ),
            LyricLine(
                index=1, text="So why’d u switch the plan up?",
                start_sec=10.03, end_sec=13.17,
                words=[
                    Word(text="So", start_sec=10.03, end_sec=10.10),
                    Word(text="why’d", start_sec=10.21, end_sec=10.38),
                    Word(text="u", start_sec=10.45, end_sec=10.52),
                    Word(text="switch", start_sec=10.60, end_sec=11.10),
                    Word(text="the", start_sec=11.10, end_sec=11.30),
                    Word(text="plan", start_sec=11.30, end_sec=11.90),
                    Word(text="up?", start_sec=11.90, end_sec=13.17),
                ],
            ),
        ],
        source=Provenance(
            catalog_path=None,
            beats_source="synthesized from bpm (fixture)",
            lyrics_source="in-repo fixture",
        ),
    )


# ── public API ─────────────────────────────────────────────────────────────

def load_song_context(
    song_id: str = "me-u-1bc03491",
    *,
    catalog_path: Optional[str | Path] = None,
) -> SongContext:
    """Load a SongContext for `song_id`. Reads the song-pipeline catalog if present,
    else returns the in-repo me&u fixture. Currently me&u is the only wired song."""
    path = Path(catalog_path).expanduser() if catalog_path else DEFAULT_CATALOG
    if path.exists():
        try:
            catalog = json.loads(path.read_text())
            entry = _find_entry(catalog, song_id)
            if entry is not None:
                return _entry_to_song_context(entry, catalog_path=path)
        except (json.JSONDecodeError, OSError):
            pass  # fall through to fixture
    if song_id in MEANDU_IDS | {MEANDU_SLUG}:
        return _meandu_fixture()
    raise KeyError(f"no SongContext available for song_id={song_id!r} (catalog missing)")


def list_songs(catalog_path: Optional[str | Path] = None) -> list[dict[str, Any]]:
    """List available songs as lightweight {id, title, bpm} dicts for the picker UI."""
    path = Path(catalog_path).expanduser() if catalog_path else DEFAULT_CATALOG
    if not path.exists():
        return [{"id": "me-u-1bc03491", "title": "me&u", "bpm": 140.0}]
    try:
        catalog = json.loads(path.read_text())
    except (json.JSONDecodeError, OSError):
        return [{"id": "me-u-1bc03491", "title": "me&u", "bpm": 140.0}]
    songs = catalog.get("songs", []) if isinstance(catalog, dict) else catalog
    out: list[dict[str, Any]] = []
    for s in songs if isinstance(songs, list) else []:
        if isinstance(s, dict) and s.get("id"):
            out.append(
                {
                    "id": s["id"],
                    "title": s.get("title", s["id"]),
                    "bpm": float(s.get("bpm", 0.0) or 0.0),
                }
            )
    return out or [{"id": "me-u-1bc03491", "title": "me&u", "bpm": 140.0}]


__all__ = ["load_song_context", "list_songs", "DEFAULT_CATALOG", "MEANDU_IDS"]
