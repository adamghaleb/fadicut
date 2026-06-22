"""Smoke-test the contracts: build a real 'me&u' SongContext + a tiny lyric-slice
FadiEDL, round-trip through JSON, and assert the beat/lyric helpers work. Proves the
locked schemas are valid and usable before any agent builds against them."""

from fadi_contracts import FadiEDL, SongContext
from fadi_contracts.fadi_edl import FadiTrack, LyricEffect, RenderSpec, TextElement
from fadi_contracts.song_context import (
    AudioRef, LyricLine, Provenance, Section, Tempo, Word,
)


def build_song() -> SongContext:
    bpm = 140.0  # me&u, per memory
    beat = 60.0 / bpm
    grid = [round(i * beat, 4) for i in range(64)]
    return SongContext(
        song_id="me-and-u",
        title="me&u",
        audio=AudioRef(
            master_path="/Volumes/Seagate Portable Drive/.../wav files/me&u.wav",
            sample_rate=44100, channels=2, duration_sec=180.0,
        ),
        tempo=Tempo(bpm=bpm, bpm_confidence=0.92, beat_grid=grid, downbeats=grid[::4]),
        key="F# minor",
        sections=[Section(index=0, name="intro", start_sec=0, end_sec=8.0),
                  Section(index=1, name="verse", start_sec=8.0, end_sec=24.0)],
        lyrics=[LyricLine(index=0, text="me and u", start_sec=8.0, end_sec=10.0,
                          words=[Word(text="me", start_sec=8.0, end_sec=8.4),
                                 Word(text="and", start_sec=8.4, end_sec=8.8),
                                 Word(text="u", start_sec=8.8, end_sec=10.0)])],
        source=Provenance(beats_source="snippet-selector/analyze_beats.py",
                          lyrics_source="music.ai alignment.json"),
    )


def build_edl(song: SongContext) -> FadiEDL:
    return FadiEDL(
        project_id="meandu-lyric-001",
        name="me&u lyric video",
        song_id=song.song_id,
        render=RenderSpec(width=1080, height=1920, fps=24, proxy=False),
        beat_markers_sec=song.tempo.beat_grid,
        tracks=[FadiTrack(
            id="t-lyric", name="Lyrics", type="text", role="overlay",
            elements=[TextElement(
                id="e-l0", text="me and u", start_sec=8.0, duration_sec=2.0,
                effects=[LyricEffect(line_range=(0, 0), fill_mode="tri_zone", stroke_px=6.0)],
            )],
        )],
    )


def main() -> None:
    song = build_song()
    edl = build_edl(song)

    # round-trip
    song2 = SongContext.model_validate_json(song.model_dump_json())
    edl2 = FadiEDL.model_validate_json(edl.model_dump_json())

    assert song2.tempo.bpm == 140.0
    assert song2.nearest_beat(8.55, downbeats_only=False) is not None
    assert len(song2.words_in_range(8.0, 9.0)) == 3  # "me","and","u" (u starts 8.8)
    assert edl2.tracks[0].elements[0].effects[0].engine == "meandu"
    assert edl2.song_id == "me-and-u"

    print("✓ SongContext + FadiEDL round-trip OK")
    print(f"  song: {song.title} @ {song.tempo.bpm} BPM, {len(song.tempo.beat_grid)} beats")
    print(f"  edl : {edl.name}, {len(edl.tracks)} track(s), render {edl.render.width}x{edl.render.height}")


if __name__ == "__main__":
    main()
